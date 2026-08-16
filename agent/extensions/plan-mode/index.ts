/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command or Shift+Tab to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Extracts numbered plan steps from "Plan:" sections
 * - Hands accepted plans to the rpiv-todo tool for execution tracking
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import { extractPlanStepSources, isSafeCommand } from "./utils.ts";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", "todo"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", "todo"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS, "todo"]);

interface PlanCardItem {
	step: number;
	markdown: string;
}

interface PlanCardData {
	items: PlanCardItem[];
}

interface PlanModeState {
	enabled: boolean;
	toolsBeforePlanMode?: string[];
	cardItems?: PlanCardItem[];
}

interface PendingPlan {
	cardItems: PlanCardItem[];
}

type CustomTypedMessage = AgentMessage & { customType?: string };

function customTypeOf(m: AgentMessage): string | undefined {
	return (m as CustomTypedMessage).customType;
}

// Type guard for assistant messages
function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

// Extract text content from an assistant message
function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function extractPendingPlan(sourceText: string): PendingPlan | undefined {
	const sources = extractPlanStepSources(sourceText);
	if (sources.length === 0) return undefined;

	return {
		cardItems: sources.map((markdown, index) => ({
			step: index + 1,
			markdown,
		})),
	};
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let planCardItems: PlanCardItem[] = [];
	let pendingPlan: PendingPlan | undefined;
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	pi.registerEntryRenderer<PlanCardData>("plan-todo-list", (entry, _options, theme): Component => {
		const items = entry.data?.items ?? [];
		const planAccent = (text: string) => theme.fg("thinkingHigh", text);
		const title = " PLAN ";
		const markdownItems = items.map(
			(item) => new Markdown(`${item.step}. ${item.markdown}`, 0, 0, getMarkdownTheme()),
		);

		return {
			invalidate() {
				for (const item of markdownItems) item.invalidate();
			},
			render(width: number): string[] {
				const cardWidth = Math.min(width, 100);
				if (cardWidth < 5) {
					return [truncateToWidth(planAccent("PLAN"), cardWidth, "")];
				}

				const topBorder =
					cardWidth >= visibleWidth(title) + 3
						? `╭─${title}${"─".repeat(cardWidth - visibleWidth(title) - 3)}╮`
						: `╭${"─".repeat(cardWidth - 2)}╮`;
				const bottomBorder = `╰${"─".repeat(cardWidth - 2)}╯`;
				const contentWidth = cardWidth - 4;
				const lines: string[] = [planAccent(topBorder)];

				const addContentLine = (content: string): void => {
					const fitted = truncateToWidth(content, contentWidth, "");
					const padding = " ".repeat(Math.max(0, contentWidth - visibleWidth(fitted)));
					lines.push(
						planAccent("│") +
							theme.bg("customMessageBg", ` ${fitted}${padding} `) +
							planAccent("│"),
					);
				};

				addContentLine("");
				for (const [itemIndex, item] of markdownItems.entries()) {
					if (itemIndex > 0) addContentLine("");
					for (const line of item.render(contentWidth)) addContentLine(line);
				}
				addContentLine("");
				lines.push(planAccent(bottomBorder));
				return lines;
			},
		};
	});

	function updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus(
			"plan-mode",
			planModeEnabled ? ctx.ui.theme.fg("accent", "⏸ plan") : undefined,
		);
	}

	function uniqueToolNames(toolNames: string[]): string[] {
		return [...new Set(toolNames)];
	}

	function getPlanModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...activeToolNames.filter((name) => !PLAN_MODE_DISABLED_TOOLS.has(name)),
			...PLAN_MODE_TOOLS,
		]);
	}

	function getNormalModeTools(activeToolNames: string[]): string[] {
		return uniqueToolNames([
			...NORMAL_MODE_TOOLS,
			...activeToolNames.filter((name) => !PLAN_MANAGED_TOOLS.has(name)),
		]);
	}

	function enablePlanModeTools(): void {
		if (toolsBeforePlanMode === undefined) {
			toolsBeforePlanMode = pi.getActiveTools();
		}
		pi.setActiveTools(getPlanModeTools(toolsBeforePlanMode));
	}

	function restoreNormalModeTools(): void {
		pi.setActiveTools(toolsBeforePlanMode ?? getNormalModeTools(pi.getActiveTools()));
		toolsBeforePlanMode = undefined;
	}

	function appendPlanCard(cards: PlanCardItem[]): void {
		pi.appendEntry<PlanCardData>("plan-todo-list", { items: cards });
	}

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			toolsBeforePlanMode,
			cardItems: planCardItems,
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;
		planCardItems = [];
		pendingPlan = undefined;

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify("Plan mode enabled. Write and todo tools disabled.");
		} else {
			restoreNormalModeTools();
			ctx.ui.notify("Plan mode disabled. Full access restored.");
		}
		updateStatus(ctx);
		persistState();
	}

	pi.registerCommand("plan", {
		description: "Toggle plan mode (read-only exploration)",
		handler: async (_args, ctx) => togglePlanMode(ctx),
	});

	pi.registerShortcut("shift+tab", {
		description: "Toggle between plan and regular mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command;
		if (typeof command !== "string" || !isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${String(command)}`,
			};
		}
	});

	// Deduplicate plan mode context while active; strip it entirely when inactive
	pi.on("context", async (event) => {
		if (planModeEnabled) {
			// Keep only the most recent plan-mode context injection to save tokens.
			let lastContextIndex = -1;
			for (let i = event.messages.length - 1; i >= 0; i--) {
				if (customTypeOf(event.messages[i]) === "plan-mode-context") {
					lastContextIndex = i;
					break;
				}
			}
			const messages = event.messages.filter(
				(m, index) => customTypeOf(m) !== "plan-mode-context" || index === lastContextIndex,
			);
			return messages.length === event.messages.length ? undefined : { messages };
		}

		return {
			messages: event.messages.filter((m) => {
				if (customTypeOf(m) === "plan-mode-context") return false;
				if (m.role !== "user") return true;

				const content = m.content;
				if (typeof content === "string") {
					return !content.includes("[PLAN MODE ACTIVE]");
				}
				if (Array.isArray(content)) {
					return !content.some(
						(c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"),
					);
				}
				return true;
			}),
		};
	});

	// Inject plan context before the agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			const currentPlan =
				planCardItems.length > 0
					? `\n\nCurrent plan available for refinement:\n${planCardItems
							.map((item) => `${item.step}. ${item.markdown}`)
							.join("\n")}`
					: "";
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit and write tools are disabled
- Other currently active tools remain available
- Bash is restricted to an allowlist of read-only commands

Ask clarifying questions using the questionnaire tool.
Use brave-search skill via bash for web research.

Create a detailed numbered plan under a "Plan:" header:

Plan:
1. First step description
2. Second step description
...

Do NOT attempt to make changes - just describe what you would do.${currentPlan}`,
					display: false,
				},
			};
		}
	});

	// Capture completed plans before rendering so the unboxed assistant text can
	// be replaced by the bordered card without losing the full plan content.
	pi.on("message_end", async (event, ctx) => {
		// Without a UI there is no card to replace the text, so leave the plan visible.
		if (!ctx.hasUI || !planModeEnabled || !isAssistantMessage(event.message)) return;

		const extracted = extractPendingPlan(getTextContent(event.message));
		if (!extracted) return;

		pendingPlan = extracted;
		return {
			message: {
				...event.message,
				content: event.message.content.map((block) =>
					block.type === "text" ? { ...block, text: "" } : block,
				),
			},
		};
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		if (!planModeEnabled || !ctx.hasUI) return;

		// Use the plan captured before display replacement, with a fallback for
		// modes where message replacement is unavailable. Do not reuse a stale plan
		// when a response does not contain a new one.
		let nextPlan: PendingPlan | undefined;
		if (pendingPlan) {
			nextPlan = pendingPlan;
			pendingPlan = undefined;
		} else {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) nextPlan = extractPendingPlan(getTextContent(lastAssistant));
		}

		if (!nextPlan) return;
		planCardItems = nextPlan.cardItems;
		persistState();

		appendPlanCard(nextPlan.cardItems);

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
			"Save plan to PLAN.md",
		]);

		if (choice?.startsWith("Execute")) {
			const firstPlanItem = nextPlan.cardItems[0];
			if (!firstPlanItem) return;

			planModeEnabled = false;
			restoreNormalModeTools();
			planCardItems = [];
			updateStatus(ctx);
			persistState();

			const planList = nextPlan.cardItems.map((item) => `${item.step}. ${item.markdown}`).join("\n");
			const execMessage = `Execute the plan below using the todo tool for progress tracking.

Plan:
${planList}

Before implementation, call todo with action "create" once for each numbered plan step, preserving the same order and meaning. Then work on exactly one task at a time: mark it in_progress before starting and completed immediately after it is fully verified. Do not use [DONE:n] markers. Start with step 1: ${firstPlanItem.markdown}`;
			pi.sendMessage(
				{ customType: "plan-mode-execute", content: execMessage, display: false },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		} else if (choice === "Refine the plan") {
			// Return to the main composer instead of the text-only dialog so the
			// refinement can include images pasted from the clipboard.
			ctx.ui.setEditorText("Refine the plan using this feedback:\n\n");
			ctx.ui.notify("Refinement ready. Add text or paste images, then submit.", "info");
		} else if (choice === "Save plan to PLAN.md") {
			const planPath = join(ctx.cwd, "PLAN.md");
			const content = `# Plan\n\n${nextPlan.cardItems.map((item) => `${item.step}. ${item.markdown}`).join("\n")}\n`;
			try {
				writeFileSync(planPath, content, "utf8");
				ctx.ui.notify(`Plan saved to ${planPath}`, "info");
			} catch (error) {
				ctx.ui.notify(`Failed to save plan: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		}
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		type SessionEntryLike = { type: string; customType?: string };
		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: SessionEntryLike) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
			planCardItems = planModeEntry.data.cardItems ?? planCardItems;
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
