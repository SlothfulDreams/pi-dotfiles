import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { ImageContent } from "@earendil-works/pi-ai";
import { getPackageDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, isKeyRepeat, matchesKey } from "@earendil-works/pi-tui";

const IMAGE_MARKER_REGEX = /\[Image #(\d+)\]/g;
const ANY_IMAGE_MARKER_REGEX = /\[Image #\d+\]/;

interface ClipboardImage {
	bytes: Uint8Array;
	mimeType: string;
}

interface ClipboardImageModule {
	readClipboardImage(): Promise<ClipboardImage | null>;
}

interface NativeClipboard {
	hasImage(): boolean;
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

// Pi's bundled native clipboard binding exposes a synchronous hasImage() check
// (~3ms) that lets us decide instantly whether Ctrl+V is an image paste,
// without waiting for the full image read. Null on platforms where the native
// binding is unavailable (e.g. Wayland).
let nativeClipboard: NativeClipboard | null | undefined;

async function loadNativeClipboard() {
	try {
		const modulePath = join(getPackageDir(), "dist", "utils", "clipboard-native.js");
		const module = (await import(pathToFileURL(modulePath).href)) as {
			clipboard?: { hasImage?: unknown } | null;
		};
		const clipboard = module.clipboard;
		nativeClipboard =
			clipboard && typeof clipboard.hasImage === "function" ? (clipboard as NativeClipboard) : null;
	} catch {
		nativeClipboard = null;
	}
}

export default function imagePlaceholdersExtension(pi: ExtensionAPI) {
	const pendingImages = new Map<number, Promise<ImageContent | null>>();
	let nextImageNumber = 1;

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		// Warm up the dynamic imports so the first paste doesn't pay for them.
		void getClipboardImageModule().catch(() => {});
		void loadNativeClipboard();

		// Editor changes made from a raw terminal-input listener (or a later
		// async continuation) happen outside Pi's input->render loop, so nothing
		// schedules a repaint and the marker stays invisible until the next
		// keypress. setStatus with an unset key is a no-op that unconditionally
		// calls ui.requestRender().
		const requestRender = () => ctx.ui.setStatus("image-placeholders-render", undefined);

		ctx.ui.onTerminalInput((data) => {
			const isImagePaste =
				matchesKey(data, "ctrl+v") || (process.platform === "win32" && matchesKey(data, "alt+v"));
			if (!isImagePaste) return;

			// Kitty keyboard protocol (flag 2) reports press, repeat, and release as
			// separate events and matchesKey matches all of them — only paste on press,
			// but still consume the others so nothing else handles them.
			if (isKeyRelease(data) || isKeyRepeat(data)) return { consume: true };

			// No image on the clipboard: let Pi's built-in Ctrl+V paste text instead.
			if (nativeClipboard && !nativeClipboard.hasImage()) return;

			if (!ANY_IMAGE_MARKER_REGEX.test(ctx.ui.getEditorText())) {
				pendingImages.clear();
				nextImageNumber = 1;
			}

			const imageNumber = nextImageNumber++;
			const marker = `[Image #${imageNumber}]`;

			// Insert the marker immediately; the image bytes are read in the
			// background and only need to be ready when the message is submitted.
			ctx.ui.pasteToEditor(marker);
			if (!ctx.ui.getEditorText().includes(marker)) {
				// Modal editors may ignore bracketed paste outside insert mode.
				// Fall back to appending the marker so the image is never lost.
				const latestText = ctx.ui.getEditorText();
				const separator = latestText.length > 0 && !/\s$/.test(latestText) ? " " : "";
				ctx.ui.setEditorText(`${latestText}${separator}${marker}`);
			}
			requestRender();

			const read = (async (): Promise<ImageContent | null> => {
				const clipboard = await getClipboardImageModule();
				const image = await clipboard.readClipboardImage();
				if (!image) return null;
				return {
					type: "image",
					data: Buffer.from(image.bytes).toString("base64"),
					mimeType: image.mimeType,
				};
			})();
			pendingImages.set(imageNumber, read);

			read
				.then((image) => {
					if (image) return;
					// Nothing pasteable after all — take the marker back out.
					pendingImages.delete(imageNumber);
					ctx.ui.setEditorText(ctx.ui.getEditorText().replace(marker, ""));
					ctx.ui.notify("No image found on the clipboard", "warning");
					requestRender();
				})
				.catch((error: unknown) => {
					pendingImages.delete(imageNumber);
					ctx.ui.setEditorText(ctx.ui.getEditorText().replace(marker, ""));
					const message = error instanceof Error ? error.message : String(error);
					ctx.ui.notify(`Could not paste image: ${message}`, "error");
					requestRender();
				});

			return { consume: true };
		});
	});

	pi.on("input", async (event) => {
		if (event.source !== "interactive" || pendingImages.size === 0) return;

		IMAGE_MARKER_REGEX.lastIndex = 0;
		const attachedNumbers = new Set<number>();
		const reads: Promise<ImageContent | null>[] = [];
		for (const match of event.text.matchAll(IMAGE_MARKER_REGEX)) {
			const imageNumber = Number(match[1]);
			if (attachedNumbers.has(imageNumber)) continue;

			const read = pendingImages.get(imageNumber);
			if (!read) continue;
			attachedNumbers.add(imageNumber);
			reads.push(read);
		}

		if (reads.length === 0) return;

		const images = (await Promise.all(reads)).filter(
			(image): image is ImageContent => image !== null,
		);

		pendingImages.clear();
		nextImageNumber = 1;
		if (images.length === 0) return;
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
