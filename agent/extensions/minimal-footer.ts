import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { relative } from "node:path";
import { promisify } from "node:util";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  getCapabilities,
  hyperlink,
  Text,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);
const BAR_WIDTH = 10;
const FILLED = "━";
const EMPTY = "─";

function formatDirectory(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
}

type PullRequest = {
  number: number;
  url: string;
};

type GitDivergence = {
  branch: string;
  ahead: number;
  behind: number;
};

async function findGitDivergence(
  cwd: string,
  branch: string,
): Promise<GitDivergence | undefined> {
  try {
    // Read the locally available upstream tracking ref only. This does not run
    // git fetch, so new remote commits appear after that ref is updated.
    const { stdout } = await execFileAsync(
      "git",
      ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
      { cwd, timeout: 5_000 },
    );
    const match = stdout.match(/^(\d+)\s+(\d+)/);
    if (!match) return undefined;
    return { branch, ahead: Number(match[1]), behind: Number(match[2]) };
  } catch {
    return undefined;
  }
}

async function findOpenPullRequest(cwd: string): Promise<PullRequest | undefined> {
  try {
    const { stdout } = await execFileAsync(
      "gh",
      ["pr", "view", "--json", "number,url,state"],
      { cwd, timeout: 5_000 },
    );
    const pullRequest = JSON.parse(stdout) as PullRequest & { state?: string };
    if (
      pullRequest.state !== "OPEN" ||
      !Number.isInteger(pullRequest.number) ||
      !pullRequest.url.startsWith("https://")
    ) {
      return undefined;
    }
    return { number: pullRequest.number, url: pullRequest.url };
  } catch {
    // Not a GitHub repository, gh is unavailable, or this branch has no PR.
    return undefined;
  }
}

export default function minimalFooter(pi: ExtensionAPI) {
  let fastMode = true;
  let agentStartedAt: number | undefined;
  let workTimer: ReturnType<typeof setInterval> | undefined;
  let refreshRepositoryStatus: (() => void) | undefined;

  function formatDuration(ms: number): string {
    if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
    return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
  }

  // Live counter format: whole seconds, like Claude Code's working timer.
  function formatElapsed(ms: number): string {
    const totalSeconds = Math.floor(ms / 1_000);
    if (totalSeconds < 60) return `${totalSeconds}s`;
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
  }

  const isOpenAIModel = (provider: string | undefined) =>
    provider === "openai" || provider === "openai-codex";

  const updateFastStatus = (ctx: any) => {
    if (!ctx.hasUI) return;
    ctx.ui.setStatus(
      "minimal-footer-fast-mode",
      fastMode ? ctx.ui.theme.fg("warning", "⚡ fast") : undefined,
    );
  };

  pi.registerCommand("fast", {
    description: "Toggle OpenAI priority service tier",
    handler: async (_args, ctx) => {
      if (!isOpenAIModel(ctx.model?.provider)) {
        ctx.ui.notify("Fast mode is only available for OpenAI models", "warning");
        return;
      }
      fastMode = !fastMode;
      updateFastStatus(ctx);
      ctx.ui.notify(`Fast mode ${fastMode ? "enabled (priority)" : "disabled"}`, "info");
    },
  });

  pi.registerShortcut("ctrl+shift+f", {
    description: "Toggle OpenAI priority service tier",
    handler: async (ctx) => {
      if (!isOpenAIModel(ctx.model?.provider)) return;
      fastMode = !fastMode;
      updateFastStatus(ctx);
    },
  });

  pi.on("before_provider_request", (event, ctx) => {
    if (!fastMode || !isOpenAIModel(ctx.model?.provider)) return;
    if (event.payload && typeof event.payload === "object") {
      (event.payload as { service_tier?: string }).service_tier = "priority";
    }
  });

  pi.on("model_select", (_event, ctx) => updateFastStatus(ctx));

  pi.registerEntryRenderer("work-duration", (entry, _options, theme) => {
    const data = entry.data as { durationMs?: number };
    const duration = data.durationMs ?? 0;
    return new Text(theme.fg("text", `Worked for ${formatDuration(duration)}`), 0, 0);
  });

  pi.on("agent_start", (_event, ctx) => {
    if (!ctx.hasUI) return;

    // Only set the start time on the first agent_start of a settled-to-settled
    // cycle. Retries, compaction runs, and queued follow-ups fire agent_start
    // again, but the elapsed time should accumulate continuously.
    if (agentStartedAt === undefined) agentStartedAt = Date.now();
    if (workTimer) clearInterval(workTimer);
    const updateWorkingTime = () => {
      if (agentStartedAt === undefined) return;
      ctx.ui.setWorkingMessage(`Working... ${formatElapsed(Date.now() - agentStartedAt)}`);
    };
    updateWorkingTime();
    // Tick faster than 1s so the whole-second display never visibly stalls
    // when the interval is re-created mid-second on retries/follow-ups.
    workTimer = setInterval(updateWorkingTime, 250);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (agentStartedAt === undefined) return;

    const durationMs = Date.now() - agentStartedAt;
    if (workTimer) clearInterval(workTimer);
    workTimer = undefined;
    agentStartedAt = undefined;
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
    pi.appendEntry("work-duration", { durationMs });
    refreshRepositoryStatus?.();
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    updateFastStatus(ctx);
    ctx.ui.setFooter((tui, theme, footerData) => {
      let pullRequest: PullRequest | undefined;
      let divergence: GitDivergence | undefined;
      let refreshId = 0;
      let disposed = false;

      const refreshRepository = async () => {
        const currentRefreshId = ++refreshId;
        const branch = footerData.getGitBranch();
        pullRequest = undefined;
        divergence = undefined;
        tui.requestRender();
        const [pullRequestResult, divergenceResult] = await Promise.all([
          findOpenPullRequest(ctx.cwd),
          branch ? findGitDivergence(ctx.cwd, branch) : undefined,
        ]);
        if (disposed || currentRefreshId !== refreshId) return;
        pullRequest = pullRequestResult;
        divergence = divergenceResult;
        tui.requestRender();
      };

      const requestRepositoryRefresh = () => {
        void refreshRepository();
      };
      refreshRepositoryStatus = requestRepositoryRefresh;
      const unsubscribe = footerData.onBranchChange(requestRepositoryRefresh);
      requestRepositoryRefresh();

      const separator = theme.fg("borderMuted", " · ");
      const compactSeparator = theme.fg("borderMuted", "·");

      return {
        dispose() {
          disposed = true;
          refreshId++;
          if (refreshRepositoryStatus === requestRepositoryRefresh) {
            refreshRepositoryStatus = undefined;
          }
          unsubscribe();
        },
        invalidate() {},
        render(width: number): string[] {
          let cost = 0;
          for (const entry of ctx.sessionManager.getEntries()) {
            if (entry.type === "message" && entry.message.role === "assistant") {
              cost += (entry.message as AssistantMessage).usage.cost.total;
            }
          }

          const usage = ctx.getContextUsage();
          const percent = usage?.percent ?? 0;
          const clamped = Math.max(0, Math.min(100, percent));
          const filled = Math.round((clamped / 100) * BAR_WIDTH);
          const gaugeColor = clamped >= 90 ? "error" : clamped >= 70 ? "warning" : "accent";
          const gauge =
            theme.fg("dim", "ctx ") +
            theme.fg(gaugeColor, FILLED.repeat(filled)) +
            theme.fg("dim", EMPTY.repeat(BAR_WIDTH - filled)) +
            theme.fg(gaugeColor, ` ${Math.round(clamped)}%`);

          const model = ctx.model?.id ?? "no-model";
          const thinkingLevel = pi.getThinkingLevel();
          const modelText =
            theme.bold(theme.fg("text", model)) +
            (ctx.model?.reasoning
              ? compactSeparator + theme.fg("accent", thinkingLevel)
              : "") +
            (fastMode && isOpenAIModel(ctx.model?.provider)
              ? compactSeparator + theme.fg("warning", "fast")
              : "");
          const costText =
            theme.fg("dim", "cost ") + theme.fg("muted", `$${cost.toFixed(3)}`);

          const branch = footerData.getGitBranch();
          // Divergence results are tagged with their branch; a result from a
          // previous branch is ignored until the pending refresh replaces it.
          const divergenceStatus =
            divergence && divergence.branch === branch
              ? (divergence.ahead > 0
                  ? theme.fg("success", ` ⇡${divergence.ahead}`)
                  : "") +
                (divergence.behind > 0
                  ? theme.fg("warning", ` ⇣${divergence.behind}`)
                  : "")
              : "";
          const branchStatus = branch
            ? theme.fg("muted", ` ${branch}`) + divergenceStatus
            : "";
          const planStatus = footerData.getExtensionStatuses().get("plan-mode");
          const pullRequestNumber = pullRequest
            ? theme.underline(theme.fg("warning", `#${pullRequest.number}`))
            : "";
          const pullRequestLink =
            pullRequest && getCapabilities().hyperlinks
              ? hyperlink(pullRequestNumber, pullRequest.url)
              : pullRequestNumber;
          const pullRequestStatus = pullRequest
            ? theme.fg("muted", "PR ") + pullRequestLink
            : "";
          const location =
            theme.fg("accent", "◆ ") +
            theme.bold(theme.fg("text", formatDirectory(ctx.cwd))) +
            (branchStatus ? separator + branchStatus : "") +
            (pullRequestStatus ? separator + pullRequestStatus : "");

          const minimumPlanWidth = planStatus ? visibleWidth(planStatus) : 0;
          const maxTopRightWidth = Math.max(
            0,
            width - minimumPlanWidth - (planStatus ? 2 : 0),
          );
          const topRight = truncateToWidth(modelText, maxTopRightWidth, "");
          const roomForLocation = width - visibleWidth(topRight) - 2;
          let topLeft = "";
          if (roomForLocation > 0) {
            if (!planStatus) {
              topLeft = truncateToWidth(location, roomForLocation, theme.fg("dim", "…"));
            } else {
              const planSuffix = separator + planStatus;
              if (roomForLocation < visibleWidth(planSuffix)) {
                topLeft = truncateToWidth(planStatus, roomForLocation, "");
              } else {
                const roomForBase = roomForLocation - visibleWidth(planSuffix);
                topLeft =
                  truncateToWidth(location, roomForBase, theme.fg("dim", "…")) +
                  planSuffix;
              }
            }
          }
          const topPadding = " ".repeat(
            Math.max(0, width - visibleWidth(topLeft) - visibleWidth(topRight)),
          );

          const details = `${gauge}${separator}${costText}`;
          const compactDetails =
            `${theme.fg(gaugeColor, `ctx ${Math.round(clamped)}%`)}` +
            `${separator}${costText}`;
          const bottom =
            visibleWidth(details) <= width
              ? details
              : truncateToWidth(compactDetails, width, "");

          return [
            truncateToWidth(topLeft + topPadding + topRight, width, ""),
            bottom,
          ];
        },
      };
    });
  });

  pi.on("session_shutdown", (_event, ctx) => {
    if (workTimer) clearInterval(workTimer);
    workTimer = undefined;
    agentStartedAt = undefined;
    refreshRepositoryStatus = undefined;
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
