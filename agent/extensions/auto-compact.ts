import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const COMPACTION_THRESHOLD_PERCENT = 70;

export default function (pi: ExtensionAPI) {
	let compactionPending = false;

	const compactIfNeeded = (ctx: ExtensionContext) => {
		if (compactionPending || !ctx.isIdle()) return;

		const usage = ctx.getContextUsage();
		if (usage?.percent === null || usage?.percent === undefined) return;
		if (usage.percent < COMPACTION_THRESHOLD_PERCENT) return;

		compactionPending = true;
		ctx.ui.notify(
			`Context is ${usage.percent.toFixed(1)}% full; compacting at the ${COMPACTION_THRESHOLD_PERCENT}% threshold`,
			"info",
		);
		ctx.compact({
			onComplete: () => {
				compactionPending = false;
			},
			onError: (error) => {
				compactionPending = false;
				ctx.ui.notify(`Automatic compaction failed: ${error.message}`, "error");
			},
		});
	};

	// Runs after retries, tool calls, and queued continuations have fully settled.
	pi.on("agent_settled", (_event, ctx) => {
		compactIfNeeded(ctx);
	});

	// Also enforce the threshold when restoring a session or switching models.
	pi.on("session_start", (_event, ctx) => {
		compactIfNeeded(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		compactIfNeeded(ctx);
	});
}
