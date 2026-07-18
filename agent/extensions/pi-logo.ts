import { homedir } from "node:os";
import { relative } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

type Rgb = [number, number, number];

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const PALETTE: Rgb[] = [
  [22, 83, 189],
  [48, 129, 247],
  [93, 171, 255],
  [151, 205, 255],
  [93, 171, 255],
  [48, 129, 247],
];
const TITLE_LINES = [
  "  ██████╗  ██╗ ",
  "  ██╔══██╗ ██║ ",
  "  ██████╔╝ ██║ ",
  "  ██╔═══╝  ██║ ",
  "  ██║      ██║ ",
  "  ╚═╝      ╚═╝ ",
];
const DROP_INTERVAL_MS = 45;
const DROP_HEIGHT = 8;
const PIECE_STAGGER = 3;
const LOGO_WIDTH = Math.max(...TITLE_LINES.map((line) => [...line].length));
const LOGO_CELLS = TITLE_LINES.flatMap((line, row) =>
  [...line]
    .map((character, column) => ({ character, column, row }))
    .filter(({ character }) => character !== " "),
);

function cellKey(row: number, column: number) {
  return `${row}:${column}`;
}

function createPieces() {
  const remaining = new Map(
    LOGO_CELLS.map((cell) => [cellKey(cell.row, cell.column), cell]),
  );
  const seeds = [...LOGO_CELLS].sort(
    (a, b) => b.row - a.row || a.column - b.column,
  );
  const pieces: (typeof LOGO_CELLS)[] = [];

  for (const seed of seeds) {
    if (!remaining.has(cellKey(seed.row, seed.column))) continue;

    const piece: typeof LOGO_CELLS = [];
    const queue = [seed];
    while (queue.length > 0 && piece.length < 4) {
      const cell = queue.shift()!;
      const key = cellKey(cell.row, cell.column);
      if (!remaining.delete(key)) continue;
      piece.push(cell);

      const neighbors = [
        { row: cell.row, column: cell.column + 1 },
        { row: cell.row - 1, column: cell.column },
        { row: cell.row, column: cell.column - 1 },
        { row: cell.row + 1, column: cell.column },
      ];
      for (const neighborPosition of neighbors) {
        const neighbor = remaining.get(
          cellKey(neighborPosition.row, neighborPosition.column),
        );
        if (neighbor) queue.push(neighbor);
      }
    }
    pieces.push(piece);
  }

  return pieces;
}

const PIECES = createPieces();
const ANIMATION_STEPS =
  DROP_HEIGHT + Math.max(0, PIECES.length - 1) * PIECE_STAGGER;

function mix(a: number, b: number, amount: number) {
  return Math.round(a + (b - a) * amount);
}

function sampleGradient(position: number) {
  const wrapped = ((position % 1) + 1) % 1;
  const scaled = wrapped * PALETTE.length;
  const index = Math.floor(scaled);
  const nextIndex = (index + 1) % PALETTE.length;
  const amount = scaled - index;
  const start = PALETTE[index]!;
  const end = PALETTE[nextIndex]!;

  return [
    mix(start[0], end[0], amount),
    mix(start[1], end[1], amount),
    mix(start[2], end[2], amount),
  ] satisfies Rgb;
}

function foreground([red, green, blue]: Rgb, text: string) {
  return `\x1b[38;2;${red};${green};${blue}m${text}${RESET}`;
}

function gradientText(text: string, phase: number) {
  const characters = [...text];
  const span = Math.max(characters.length - 1, 1);

  return characters
    .map((character, index) =>
      character === " "
        ? character
        : foreground(sampleGradient(index / span + phase), character),
    )
    .join("");
}

function renderFallingLogo(progress: number) {
  const frame = Array.from({ length: TITLE_LINES.length }, () =>
    Array.from({ length: LOGO_WIDTH }, () => " "),
  );

  PIECES.forEach((piece, pieceIndex) => {
    const age = progress - pieceIndex * PIECE_STAGGER;
    if (age < 0) return;

    const offset = Math.max(0, DROP_HEIGHT - age);
    const pieceColor = sampleGradient(pieceIndex / Math.max(PIECES.length, 1));

    for (const cell of piece) {
      const row = cell.row - offset;
      if (row < 0 || row >= frame.length) continue;

      frame[row]![cell.column] =
        offset === 0
          ? foreground(
              sampleGradient(
                cell.column / Math.max(LOGO_WIDTH - 1, 1) + cell.row * 0.045,
              ),
              cell.character,
            )
          : foreground(pieceColor, "█");
    }
  });

  return frame.map((line) => line.join(""));
}

function formatDirectory(cwd: string) {
  const home = homedir();
  if (cwd === home) return "~";
  if (cwd.startsWith(`${home}/`)) return `~/${relative(home, cwd)}`;
  return cwd;
}

function center(text: string, width: number) {
  const padding = Math.max(0, Math.floor((width - visibleWidth(text)) / 2));
  return truncateToWidth(`${" ".repeat(padding)}${text}`, width);
}

export default function piLogo(pi: ExtensionAPI) {
  let animationTimer: ReturnType<typeof setInterval> | undefined;

  function stopAnimation() {
    if (animationTimer) clearInterval(animationTimer);
    animationTimer = undefined;
  }

  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;

    stopAnimation();
    const title = formatDirectory(ctx.cwd);
    let progress = 0;

    ctx.ui.setHeader((tui) => {
      animationTimer = setInterval(() => {
        progress += 1;
        tui.requestRender();

        if (progress >= ANIMATION_STEPS) stopAnimation();
      }, DROP_INTERVAL_MS);

      return {
        render(width: number) {
          const art = renderFallingLogo(progress).map((line) =>
            center(line, width),
          );
          const subtitle =
            progress >= ANIMATION_STEPS
              ? center(`${BOLD}${gradientText(title, 0.18)}${RESET}`, width)
              : "";
          return ["", ...art, subtitle, ""];
        },
        invalidate() {},
      };
    });
    ctx.ui.setTitle(`pi · ${title}`);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    stopAnimation();
    if (ctx.mode === "tui") ctx.ui.setHeader(undefined);
  });
}
