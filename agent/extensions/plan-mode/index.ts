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
 * - [DONE:n] markers to complete steps during execution
 * - Progress tracking widget during execution
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import { getMarkdownTheme, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import {
	extractPlanStepSources,
	extractTodoItems,
	isSafeCommand,
	markCompletedSteps,
	type TodoItem,
} from "./utils.ts";

// Tools
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", "questionnaire"];
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write"];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

interface PlanCardItem {
	step: number;
	markdown: string;
	completed?: boolean;
}

interface PlanCardData {
	items: PlanCardItem[];
	completed?: boolean;
}

interface PlanModeState {
	enabled: boolean;
	todos?: TodoItem[];
	executing?: boolean;
	toolsBeforePlanMode?: string[];
	cardItems?: PlanCardItem[];
}

interface PendingPlan {
	items: TodoItem[];
	cardItems: PlanCardItem[];
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
	const items = extractTodoItems(sourceText);
	if (items.length === 0) return undefined;

	return {
		items,
		cardItems: extractPlanStepSources(sourceText).map((markdown, index) => ({
			step: index + 1,
			markdown,
		})),
	};
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let executionMode = false;
	let todoItems: TodoItem[] = [];
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
		const cardComplete = entry.data?.completed === true;
		const planAccent = (text: string) => theme.fg(cardComplete ? "success" : "thinkingHigh", text);
		const title = cardComplete ? " PLAN COMPLETE " : " PLAN ";
		const markdownItems = items.map((item) => {
			const body = item.completed ? `~~${item.markdown}~~` : item.markdown;
			return new Markdown(`${item.step}. ${body}`, 0, 0, getMarkdownTheme());
		});

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
		// Footer status
		if (executionMode && todoItems.length > 0) {
			const completed = todoItems.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${completed}/${todoItems.length}`));
		} else if (planModeEnabled) {
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", "⏸ plan"));
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
		}

		// Compact widget: completed summary, current step, next steps, remainder
		if (executionMode && todoItems.length > 0) {
			const lines: string[] = [];
			const completed = todoItems.filter((t) => t.completed).length;
			if (completed > 0) {
				lines.push(ctx.ui.theme.fg("success", `☑ ${completed} done`));
			}
			const [current, ...upcoming] = todoItems.filter((t) => !t.completed);
			if (current) {
				lines.push(ctx.ui.theme.fg("accent", `▶ ${current.step}. `) + current.text);
			}
			for (const item of upcoming.slice(0, 2)) {
				lines.push(ctx.ui.theme.fg("muted", `☐ ${item.step}. ${item.text}`));
			}
			if (upcoming.length > 2) {
				lines.push(ctx.ui.theme.fg("dim", `… ${upcoming.length - 2} more`));
			}
			ctx.ui.setWidget("plan-todos", lines);
		} else {
			ctx.ui.setWidget("plan-todos", undefined);
		}
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

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			todos: todoItems,
			executing: executionMode,
			toolsBeforePlanMode,
			cardItems: planCardItems,
		});
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		const wasExecuting = executionMode;
		planModeEnabled = !planModeEnabled;
		executionMode = false;
		todoItems = [];
		planCardItems = [];
		pendingPlan = undefined;

		if (planModeEnabled) {
			enablePlanModeTools();
			ctx.ui.notify(
				wasExecuting
					? "Plan execution cancelled. Plan mode enabled."
					: "Plan mode enabled. Built-in write tools disabled.",
			);
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

	pi.registerCommand("todos", {
		description: "Show current plan progress card",
		handler: async (_args, ctx) => {
			if (todoItems.length === 0) {
				ctx.ui.notify("No todos. Create a plan first with /plan", "info");
				return;
			}
			pi.appendEntry<PlanCardData>("plan-todo-list", {
				items: todoItems.map((item, index) => ({
					step: item.step,
					markdown: planCardItems[index]?.markdown ?? item.text,
					completed: item.completed,
				})),
				completed: todoItems.every((item) => item.completed),
			});
		},
	});

	pi.registerShortcut("shift+tab", {
		description: "Toggle between plan and regular mode",
		handler: async (ctx) => togglePlanMode(ctx),
	});

	// Block destructive bash commands in plan mode
	pi.on("tool_call", async (event) => {
		if (!planModeEnabled || event.toolName !== "bash") return;

		const command = event.input.command as string;
		if (!isSafeCommand(command)) {
			return {
				block: true,
				reason: `Plan mode: command blocked (not allowlisted). Use /plan to disable plan mode first.\nCommand: ${command}`,
			};
		}
	});

	// Deduplicate plan mode context while active; strip it entirely when inactive
	pi.on("context", async (event) => {
		if (planModeEnabled) {
			// Keep only the most recent plan-mode context injection to save tokens.
			let lastContextIndex = -1;
			for (let i = event.messages.length - 1; i >= 0; i--) {
				if ((event.messages[i] as AgentMessage & { customType?: string }).customType === "plan-mode-context") {
					lastContextIndex = i;
					break;
				}
			}
			const messages = event.messages.filter(
				(m, index) =>
					(m as AgentMessage & { customType?: string }).customType !== "plan-mode-context" ||
					index === lastContextIndex,
			);
			return messages.length === event.messages.length ? undefined : { messages };
		}

		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;

				const content = msg.content;
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

	// Inject plan/execution context before agent starts
	pi.on("before_agent_start", async () => {
		if (planModeEnabled) {
			const currentPlan =
				todoItems.length > 0
					? `\n\nCurrent plan available for refinement:\n${todoItems
							.map((item) => `${item.step}. ${item.text}`)
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

		if (executionMode && todoItems.length > 0) {
			const remaining = todoItems.filter((t) => !t.completed);
			const todoList = remaining.map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN - Full tool access enabled]

Remaining steps:
${todoList}

Work on exactly one step at a time, in order.
The moment a step is finished, output its [DONE:n] tag in that same turn's text before moving to the next step.
Do NOT batch [DONE:n] tags into the final message - report each one as it happens.`,
					display: false,
				},
			};
		}
	});

	// Capture completed plans before rendering so the unboxed assistant text can
	// be replaced by the bordered card without losing the full plan content.
	pi.on("message_end", async (event, ctx) => {
		// Without a UI there is no card to replace the text, so leave the plan visible.
		if (!ctx.hasUI || !planModeEnabled || executionMode || !isAssistantMessage(event.message)) return;

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

	// Track progress after each turn
	pi.on("turn_end", async (event, ctx) => {
		if (!executionMode || todoItems.length === 0) return;
		if (!isAssistantMessage(event.message)) return;

		const text = getTextContent(event.message);
		if (markCompletedSteps(text, todoItems) > 0) {
			updateStatus(ctx);
			persistState();
		}
	});

	// Handle plan completion and plan mode UI
	pi.on("agent_end", async (event, ctx) => {
		// Check if execution is complete
		if (executionMode && todoItems.length > 0) {
			if (todoItems.every((t) => t.completed)) {
				// Render a green completion card matching the plan card style.
				pi.appendEntry<PlanCardData>("plan-todo-list", {
					items: todoItems.map((item, index) => ({
						step: item.step,
						markdown: planCardItems[index]?.markdown ?? item.text,
						completed: true,
					})),
					completed: true,
				});
				executionMode = false;
				todoItems = [];
				planCardItems = [];
				updateStatus(ctx);
				persistState(); // Save cleared state so resume doesn't restore old execution mode
			}
			return;
		}

		if (!planModeEnabled || !ctx.hasUI) return;

		// Use the plan captured before display replacement, with a fallback for
		// modes where message replacement is unavailable. Do not reuse stale todos
		// when a response does not contain a new plan.
		let nextPlan: PendingPlan | undefined;
		if (pendingPlan) {
			nextPlan = pendingPlan;
			pendingPlan = undefined;
		} else {
			const lastAssistant = [...event.messages].reverse().find(isAssistantMessage);
			if (lastAssistant) nextPlan = extractPendingPlan(getTextContent(lastAssistant));
		}

		if (!nextPlan) return;
		todoItems = nextPlan.items;
		planCardItems = nextPlan.cardItems;
		persistState();

		pi.appendEntry<PlanCardData>("plan-todo-list", {
			items: nextPlan.cardItems,
		});

		const choice = await ctx.ui.select("Plan mode - what next?", [
			"Execute the plan (track progress)",
			"Stay in plan mode",
			"Refine the plan",
			"Save plan to PLAN.md",
		]);

		if (choice?.startsWith("Execute")) {
			const firstTodoItem = todoItems[0];
			if (!firstTodoItem) return;

			planModeEnabled = false;
			executionMode = true;
			restoreNormalModeTools();
			updateStatus(ctx);
			persistState();

			const remainingList = todoItems.map((t) => `${t.step}. ${t.text}`).join("\n");
			const execMessage = `Execute the plan.

Remaining steps:
${remainingList}

Start with: ${firstTodoItem.text}
Work on exactly one step at a time, in order.
The moment a step is finished, output its [DONE:n] tag in that same turn's text before moving to the next step.
Do NOT batch [DONE:n] tags into the final message - report each one as it happens.`;
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

		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			todoItems = planModeEntry.data.todos ?? todoItems;
			executionMode = planModeEntry.data.executing ?? executionMode;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
			planCardItems = planModeEntry.data.cardItems ?? planCardItems;
		}

		// On resume: re-scan messages to rebuild completion state
		// Only scan messages AFTER the last "plan-mode-execute" to avoid picking up [DONE:n] from previous plans
		const isResume = planModeEntry !== undefined;
		if (isResume && executionMode && todoItems.length > 0) {
			// Find the index of the last plan-mode-execute entry (marks when current execution started)
			let executeIndex = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				const entry = entries[i] as { type: string; customType?: string };
				if (entry.customType === "plan-mode-execute") {
					executeIndex = i;
					break;
				}
			}

			// Only scan messages after the execute marker
			const messages: AssistantMessage[] = [];
			for (let i = executeIndex + 1; i < entries.length; i++) {
				const entry = entries[i];
				if (entry.type === "message" && "message" in entry && isAssistantMessage(entry.message as AgentMessage)) {
					messages.push(entry.message as AssistantMessage);
				}
			}
			const allText = messages.map(getTextContent).join("\n");
			markCompletedSteps(allText, todoItems);
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		}
		updateStatus(ctx);
	});
}
