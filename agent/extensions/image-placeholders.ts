import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";

const IMAGE_MARKER_REGEX = /\[Image #(\d+)\]/g;
const ANY_IMAGE_MARKER_REGEX = /\[Image #\d+\]/;

interface ClipboardImage {
	bytes: Uint8Array;
	mimeType: string;
}

interface ClipboardImageModule {
	readClipboardImage(): Promise<ClipboardImage | null>;
}

function isClipboardImageModule(value: unknown): value is ClipboardImageModule {
	return (
		typeof value === "object" &&
		value !== null &&
		"readClipboardImage" in value &&
		typeof value.readClipboardImage === "function"
	);
}

let clipboardImageModule: Promise<ClipboardImageModule> | undefined;

async function getClipboardImageModule() {
	clipboardImageModule ??= (async () => {
		// Pi does not export its cross-platform clipboard-image helper, so load the
		// copy bundled with the currently running Pi version.
		const modulePath = join(getPackageDir(), "dist", "utils", "clipboard-image.js");
		const module: unknown = await import(pathToFileURL(modulePath).href);
		if (!isClipboardImageModule(module)) {
			throw new Error("Pi clipboard image support is unavailable");
		}
		return module;
	})();
	return clipboardImageModule;
}

export default function imagePlaceholdersExtension(pi: ExtensionAPI) {
	const pendingImages = new Map<number, ImageContent>();
	let nextImageNumber = 1;
	let pasteQueue = Promise.resolve();

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.onTerminalInput((data) => {
			const isImagePaste =
				matchesKey(data, "ctrl+v") || (process.platform === "win32" && matchesKey(data, "alt+v"));
			if (!isImagePaste) return;

			pasteQueue = pasteQueue
				.then(async () => {
					const currentText = ctx.ui.getEditorText();
					if (!ANY_IMAGE_MARKER_REGEX.test(currentText)) {
						pendingImages.clear();
						nextImageNumber = 1;
					}

					const clipboard = await getClipboardImageModule();
					const image = await clipboard.readClipboardImage();
					if (!image) return;

					const imageNumber = nextImageNumber++;
					pendingImages.set(imageNumber, {
						type: "image",
						data: Buffer.from(image.bytes).toString("base64"),
						mimeType: image.mimeType,
					});

					const marker = `[Image #${imageNumber}]`;
					ctx.ui.pasteToEditor(marker);
					if (!ctx.ui.getEditorText().includes(marker)) {
						// Modal editors may ignore bracketed paste outside insert mode.
						// Fall back to appending the marker so the image is never lost.
						const latestText = ctx.ui.getEditorText();
						const separator = latestText.length > 0 && !/\s$/.test(latestText) ? " " : "";
						ctx.ui.setEditorText(`${latestText}${separator}${marker}`);
					}
				})
				.catch((error: unknown) => {
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not paste image: ${message}`, "error");
				});

			return { consume: true };
		});
	});

	pi.on("input", async (event) => {
		if (event.source !== "interactive" || pendingImages.size === 0) return;

		IMAGE_MARKER_REGEX.lastIndex = 0;
		const attachedNumbers = new Set<number>();
		const images: ImageContent[] = [];
		for (const match of event.text.matchAll(IMAGE_MARKER_REGEX)) {
			const imageNumber = Number(match[1]);
			if (attachedNumbers.has(imageNumber)) continue;

			const image = pendingImages.get(imageNumber);
			if (!image) continue;
			attachedNumbers.add(imageNumber);
			images.push(image);
		}

		if (images.length === 0) return;

		pendingImages.clear();
		nextImageNumber = 1;
		return {
			action: "transform",
			text: event.text,
			images: [...images, ...(event.images ?? [])],
		};
	});

	pi.on("session_shutdown", async () => {
		pendingImages.clear();
		nextImageNumber = 1;
	});
}
