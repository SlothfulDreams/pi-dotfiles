import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Adds /clear as a convenient alias for starting with an empty context. */
export default function clearExtension(pi: ExtensionAPI): void {
	pi.registerCommand("clear", {
		description: "Clear the context and start a new session",
		handler: async (_args, ctx) => {
			await ctx.waitForIdle();

			const result = await ctx.newSession({
				withSession: async (replacementCtx) => {
					replacementCtx.ui.notify("Context cleared.", "info");
				},
			});

			if (result.cancelled) {
				ctx.ui.notify("Clear cancelled.", "info");
			}
		},
	});
}
