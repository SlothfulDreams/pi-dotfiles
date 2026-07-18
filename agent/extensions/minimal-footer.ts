import { homedir } from "node:os";
import { relative } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const BAR_WIDTH = 10;
const FILLED = "━";
const EMPTY = "─";

function formatDirectory(cwd: string): string {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
}

export default function minimalFooter(pi: ExtensionAPI) {
  let fastMode = true;
  let agentStartedAt: number | undefined;
  let workTimer: ReturnType<typeof setInterval> | undefined;

  function formatDuration(ms: number): string {
    if (ms < 1_000) return `${Math.max(1, Math.round(ms))}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    const minutes = Math.floor(ms / 60_000);
    const seconds = Math.floor((ms % 60_000) / 1_000);
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

    if (workTimer) clearInterval(workTimer);
    agentStartedAt = Date.now();
    const updateWorkingTime = () => {
      if (agentStartedAt === undefined) return;
      ctx.ui.setWorkingMessage(`Working... ${formatDuration(Date.now() - agentStartedAt)}`);
    };
    updateWorkingTime();
    workTimer = setInterval(updateWorkingTime, 100);
  });

  pi.on("agent_settled", (_event, ctx) => {
    if (agentStartedAt === undefined) return;

    const durationMs = Date.now() - agentStartedAt;
    if (workTimer) clearInterval(workTimer);
    workTimer = undefined;
    agentStartedAt = undefined;
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
    pi.appendEntry("work-duration", { durationMs });
  });

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    updateFastStatus(ctx);
    ctx.ui.setFooter((tui, theme, footerData) => {
      const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
      const separator = theme.fg("borderMuted", " · ");
      const compactSeparator = theme.fg("borderMuted", "·");

      return {
        dispose: unsubscribe,
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
          const planStatus = footerData.getExtensionStatuses().get("plan-mode");
          const modelText =
            theme.bold(theme.fg("text", model)) +
            (ctx.model?.reasoning
              ? compactSeparator + theme.fg("accent", thinkingLevel)
              : "") +
            (fastMode && isOpenAIModel(ctx.model?.provider)
              ? compactSeparator + theme.fg("warning", "fast")
              : "") +
            (planStatus ? compactSeparator + planStatus : "");
          const costText =
            theme.fg("dim", "cost ") + theme.fg("muted", `$${cost.toFixed(3)}`);

          const branch = footerData.getGitBranch();
          const location =
            theme.fg("accent", "◆ ") +
            theme.bold(theme.fg("text", formatDirectory(ctx.cwd))) +
            (branch
              ? separator + theme.fg("muted", ` ${branch}`)
              : "");

          const topRight = truncateToWidth(modelText, width, "");
          const roomForLocation = width - visibleWidth(topRight) - 2;
          const topLeft =
            roomForLocation > 0
              ? truncateToWidth(location, roomForLocation, theme.fg("dim", "…"))
              : "";
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
    if (ctx.hasUI) ctx.ui.setWorkingMessage();
    if (ctx.mode === "tui") ctx.ui.setFooter(undefined);
  });
}
