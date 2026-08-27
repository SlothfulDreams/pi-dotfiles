/**
 * Plan Mode Extension
 *
 * Read-only exploration mode for safe code analysis.
 * When enabled, built-in write tools are disabled.
 *
 * Features:
 * - /plan command or Shift+Tab to toggle
 * - Bash restricted to allowlisted read-only commands
 * - Plans are delivered via the propose_plan tool (structured steps, no text parsing)
 * - Approval dialog runs inside the tool call; approval restores tools and
 *   execution continues in the same run with rpiv-todo progress tracking
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { TextContent } from "@earendil-works/pi-ai";
import {
	getMarkdownTheme,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	Markdown,
	Text,
	truncateToWidth,
	visibleWidth,
	type Component,
} from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { isSafeCommand } from "./utils.ts";

// Tools
const PLAN_MODE_TOOLS = [
	"read",
	"bash",
	"grep",
	"find",
	"ask_user_question",
	"web_search",
	"propose_plan",
];
const NORMAL_MODE_TOOLS = [
	"read",
	"bash",
	"grep",
	"find",
	"edit",
	"write",
	"todo",
	"ask_user_question",
	"web_search",
];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write", "todo"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

const CHOICE_EXECUTE = "Execute the plan (track progress)";
const CHOICE_STAY = "Stay in plan mode";
const CHOICE_SAVE = "Save plan to PLAN.md";

// Legacy card entries from the pre-tool version of this extension
interface LegacyPlanCardData {
	items?: { step: number; markdown: string }[];
}

interface PlanModeState {
	enabled: boolean;
	toolsBeforePlanMode?: string[];
}

interface ProposePlanDetails {
	steps: string[];
	choice: "execute" | "stay" | "save" | null;
}

type CustomTypedMessage = AgentMessage & { customType?: string };

function customTypeOf(m: AgentMessage): string | undefined {
	return (m as CustomTypedMessage).customType;
}

type ThemeLike = {
	fg(color: string, text: string): string;
	bg(color: string, text: string): string;
};

// Bordered PLAN card used for propose_plan calls and legacy session entries
function createPlanCard(steps: string[], theme: ThemeLike): Component {
	const planAccent = (text: string) => theme.fg("thinkingHigh", text);
	const title = " PLAN ";
	const markdownItems = steps.map(
		(step, index) => new Markdown(`${index + 1}. ${step}`, 0, 0, getMarkdownTheme()),
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
}

export default function planModeExtension(pi: ExtensionAPI): void {
	let planModeEnabled = false;
	let toolsBeforePlanMode: string[] | undefined;

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only exploration)",
		type: "boolean",
		default: false,
	});

	// Render plan cards persisted by the pre-tool version of this extension
	pi.registerEntryRenderer<LegacyPlanCardData>("plan-todo-list", (entry, _options, theme) =>
		createPlanCard((entry.data?.items ?? []).map((item) => item.markdown), theme),
	);

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

	function persistState(): void {
		pi.appendEntry("plan-mode", {
			enabled: planModeEnabled,
			toolsBeforePlanMode,
		} satisfies PlanModeState);
	}

	function exitPlanMode(ctx: ExtensionContext): void {
		planModeEnabled = false;
		restoreNormalModeTools();
		updateStatus(ctx);
		persistState();
	}

	function togglePlanMode(ctx: ExtensionContext): void {
		planModeEnabled = !planModeEnabled;

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

	// Plans are delivered through this tool instead of being parsed out of text.
	pi.registerTool({
		name: "propose_plan",
		label: "Propose Plan",
		description:
			"Present your finished implementation plan to the user for approval. " +
			"Provide the ordered list of steps as markdown strings (each may span multiple lines). " +
			"The result tells you whether the user approved the plan (execute it immediately), " +
			"wants to keep planning, or saved it for later.",
		promptSnippet: "Present a finished implementation plan for user approval (plan mode)",
		promptGuidelines: [
			"In plan mode, deliver finished plans by calling propose_plan with the full ordered step list. Never print a plan as plain text.",
		],
		parameters: Type.Object({
			steps: Type.Array(
				Type.String({ description: "One plan step as markdown; may span multiple lines" }),
				{ minItems: 1, description: "Ordered implementation steps" },
			),
		}),
		executionMode: "sequential",

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			if (!planModeEnabled) {
				throw new Error("propose_plan is only available in plan mode. Use /plan to enable it.");
			}

			const steps = params.steps.map((step) => step.trim()).filter((step) => step.length > 0);
			if (steps.length === 0) {
				throw new Error("Plan must contain at least one non-empty step.");
			}

			// End the turn without approval; the user stays in plan mode.
			const stayResult = (text: string, choice: ProposePlanDetails["choice"] = null) => ({
				content: [{ type: "text" as const, text }],
				details: { steps, choice } satisfies ProposePlanDetails,
				terminate: true,
			});

			if (!ctx.hasUI) {
				return stayResult("Plan recorded. No UI is available for approval; staying in plan mode.");
			}

			const choice = await ctx.ui.select("Plan proposed - what next?", [
				CHOICE_EXECUTE,
				CHOICE_STAY,
				CHOICE_SAVE,
			]);

			if (signal?.aborted) {
				return stayResult("Cancelled.");
			}

			if (choice === CHOICE_EXECUTE) {
				exitPlanMode(ctx);
				return {
					content: [
						{
							type: "text",
							text: `The user approved the plan. Plan mode is now OFF and full tool access is restored.

Execute the plan now. First call todo with action "create" once for each plan step, preserving the same order and meaning. Then work on exactly one task at a time: mark it in_progress before starting and completed immediately after it is fully verified. Start with step 1.`,
						},
					],
					details: { steps, choice: "execute" } satisfies ProposePlanDetails,
				};
			}

			if (choice === CHOICE_SAVE) {
				const planPath = join(ctx.cwd, "PLAN.md");
				const content = `# Plan\n\n${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}\n`;
				try {
					writeFileSync(planPath, content, "utf8");
					ctx.ui.notify(`Plan saved to ${planPath}`, "info");
					return stayResult(
						`Plan saved to ${planPath}. Still in plan mode; wait for further instructions.`,
						"save",
					);
				} catch (error) {
					throw new Error(
						`Failed to save plan: ${error instanceof Error ? error.message : String(error)}`,
					);
				}
			}

			// "Stay in plan mode" or dialog dismissed
			return stayResult(
				"The user did not approve the plan yet and wants to keep planning. Stay in plan mode and wait for their feedback.",
				choice === CHOICE_STAY ? "stay" : null,
			);
		},

		renderCall(args, theme) {
			const steps = Array.isArray(args?.steps)
				? args.steps.filter((step): step is string => typeof step === "string")
				: [];
			if (steps.length === 0) {
				return new Text(theme.fg("toolTitle", theme.bold("propose_plan")), 0, 0);
			}
			return createPlanCard(steps, theme);
		},

		renderResult(result, _options, theme) {
			const details = result.details as ProposePlanDetails | undefined;
			switch (details?.choice) {
				case "execute":
					return new Text(theme.fg("success", "✓ Approved - executing"), 0, 0);
				case "save":
					return new Text(theme.fg("success", "✓ Saved to PLAN.md"), 0, 0);
				case "stay":
					return new Text(theme.fg("warning", "⏸ Still planning"), 0, 0);
				default: {
					const text = result.content[0];
					return new Text(
						theme.fg("muted", text?.type === "text" ? text.text : "No decision"),
						0,
						0,
					);
				}
			}
		},
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

	// Strip plan mode context once inactive. While active, injections are left
	// append-only: each copy is small, and removing older copies mid-transcript
	// would invalidate the prompt cache prefix on every planning turn.
	pi.on("context", async (event) => {
		if (planModeEnabled) return;

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

	// Inject plan mode instructions before the agent starts
	pi.on("before_agent_start", async () => {
		if (!planModeEnabled) return;

		return {
			message: {
				customType: "plan-mode-context",
				content: `[PLAN MODE ACTIVE]
You are in plan mode - a read-only exploration mode for safe code analysis.

Restrictions:
- Built-in edit, write, and todo tools are disabled
- Bash is restricted to an allowlist of read-only commands
- Do NOT attempt to make changes

Explore the codebase and design an implementation plan. Ask clarifying questions using the ask_user_question tool. Use the web_search tool for web research.

When your plan is ready, call the propose_plan tool with the ordered list of steps. Never write the plan as plain text - always deliver it via propose_plan.`,
				display: false,
			},
		};
	});

	// Restore state on session start/resume
	pi.on("session_start", async (_event, ctx) => {
		type SessionEntryLike = { type: string; customType?: string };
		const entries = ctx.sessionManager.getEntries();

		// Restore persisted state
		const planModeEntry = entries
			.filter((e: SessionEntryLike) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (planModeEntry?.data) {
			planModeEnabled = planModeEntry.data.enabled ?? planModeEnabled;
			toolsBeforePlanMode = planModeEntry.data.toolsBeforePlanMode ?? toolsBeforePlanMode;
		}

		// The flag wins over persisted state so `pi --plan` always starts planning
		if (pi.getFlag("plan") === true) {
			planModeEnabled = true;
		}

		if (planModeEnabled) {
			enablePlanModeTools();
		} else {
			// pi auto-activates newly registered tools, so without this propose_plan
			// would be live (and in the system prompt) outside plan mode.
			pi.setActiveTools(pi.getActiveTools().filter((name) => name !== "propose_plan"));
		}
		updateStatus(ctx);
	});
}
