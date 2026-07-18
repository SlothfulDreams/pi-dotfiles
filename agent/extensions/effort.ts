/**
 * Adds an explicit /effort command so thinking level changes do not need a
 * dedicated keyboard shortcut.
 */

import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const EFFORT_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

function isThinkingLevel(value: string): value is ThinkingLevel {
	return (EFFORT_LEVELS as readonly string[]).includes(value);
}

export default function effortExtension(pi: ExtensionAPI): void {
	pi.registerCommand("effort", {
		description: "Show or set reasoning effort",
		getArgumentCompletions: (prefix) => {
			const normalizedPrefix = prefix.trim().toLowerCase();
			const matches = EFFORT_LEVELS.filter((level) => level.startsWith(normalizedPrefix));
			return matches.length > 0 ? matches.map((level) => ({ value: level, label: level })) : null;
		},
		handler: async (args, ctx) => {
			const requestedLevel = args.trim().toLowerCase();
			const validLevels = EFFORT_LEVELS.join(" | ");

			if (!requestedLevel) {
				ctx.ui.notify(`Current effort: ${pi.getThinkingLevel()}\nUsage: /effort ${validLevels}`, "info");
				return;
			}

			if (!isThinkingLevel(requestedLevel)) {
				ctx.ui.notify(`Unknown effort: ${requestedLevel}\nValid levels: ${validLevels}`, "error");
				return;
			}

			const previousLevel = pi.getThinkingLevel();
			pi.setThinkingLevel(requestedLevel);
			const effectiveLevel = pi.getThinkingLevel();

			if (effectiveLevel !== requestedLevel) {
				ctx.ui.notify(
					`Effort ${requestedLevel} is unavailable for this model; using ${effectiveLevel}.`,
					"warning",
				);
			} else if (effectiveLevel === previousLevel) {
				ctx.ui.notify(`Effort is already ${effectiveLevel}.`, "info");
			} else {
				ctx.ui.notify(`Effort set to ${effectiveLevel}.`, "info");
			}
		},
	});
}
