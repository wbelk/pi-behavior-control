import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Custom renderer for the speculation-flag message (hook 7's output).
//
// Without a registered renderer, OMP/pi fall back to the default custom-message
// frame: a full-width background box labeled with the raw customType slug
// (`behavior-control/speculation-flag`) wrapping the verdict reason as markdown.
// That box is tall, visually heavy, and -- because its expand state is tied to
// the global tool-output toggle -- reflows on every expand/collapse, burying the
// agent's actual prose between turns.
//
// This renderer replaces that with a single compact, attributed line:
//
//   <warn> pi-behavior-control - speculation
//     <reason, wrapped and indented>
//
// Collapsed (the default), the reason is clamped to a few wrapped lines;
// expanded (when the user toggles tool output open), the full reason is shown.

// Must match the customType passed to `pi.sendMessage` in speculation.ts.
export const SPECULATION_FLAG_TYPE = "behavior-control/speculation-flag";

// Visible prefix on the first line. Kept as glyph + words so it still reads as a
// pi-behavior-control speculation note even if the warning glyph renders poorly
// in a given terminal/theme.
const PREFIX = "\u26a0 pi-behavior-control \u00b7 speculation";

// When collapsed, clamp the reason to at most this many wrapped lines so a long
// verdict can't reclaim the vertical space this renderer exists to save.
const COLLAPSED_MAX_BODY_LINES = 3;

// Floor on the wrap width. `render(width)` receives the live viewport width, but
// guard against pathologically small / zero widths so wrapping always makes
// forward progress (one word per line at worst).
const MIN_WRAP_WIDTH = 20;

// Hanging indent applied to every reason line under the stand-alone tag
// line. Exported so tests assert against the same value the renderer emits.
export const INDENT = "  ";

/**
 * Minimal slice of the pi `Theme` this renderer needs. Declared structurally
 * rather than imported (the concrete `Theme` is re-exported by the package, but
 * the renderer only ever calls `fg`/`bold`) so a no-op fallback can satisfy it
 * in tests and so the module never hard-depends on the theme surface.
 */
export interface RendererTheme {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Identity theme: no ANSI coloring. Used by tests and as a defensive fallback. */
const PLAIN_THEME: RendererTheme = {
  fg: (_color, text) => text,
  bold: (text) => text,
};

/**
 * Wrap `text` to `width` columns on whitespace boundaries. A single token longer
 * than `width` is emitted on its own line (un-split) rather than hard-cut --
 * terminal wrapping handles the overflow and we never drop characters. Existing
 * newlines in `text` are treated as hard breaks.
 */
function wrap(text: string, width: number): string[] {
  const limit = Math.max(width, MIN_WRAP_WIDTH);
  const lines: string[] = [];

  for (const paragraph of text.split("\n")) {
    const words = paragraph.split(/\s+/).filter((w) => w.length > 0);
    if (words.length === 0) {
      lines.push("");
      continue;
    }
    let current = "";
    for (const word of words) {
      if (current.length === 0) {
        current = word;
      } else if (current.length + 1 + word.length <= limit) {
        current = `${current} ${word}`;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current.length > 0) lines.push(current);
  }

  return lines;
}

/**
 * Produce the plain (uncolored) lines for a speculation flag, wrapped to
 * `width`. Pure and theme-free so the wrapping/clamping behavior is unit
 * testable. The first line carries the `PREFIX` and as much of the reason as
 * fits; continuation lines hang-indent under the reason.
 *
 * When `expanded` is false, the body is clamped to `COLLAPSED_MAX_BODY_LINES`
 * with a trailing marker if truncated.
 */
export function formatSpeculationLines(
  reason: string,
  width: number,
  expanded: boolean,
): string[] {
  const trimmed = reason.trim();

  // The attribution tag stands alone on the first line; the reason wraps
  // beneath it with a small hanging indent. Keeping the tag on its own line
  // means the reason always wraps against a single, consistent budget and the
  // first line can never overflow the way a "tag + first chunk" line would.
  if (trimmed.length === 0) {
    return [PREFIX, `${INDENT}(no reason given)`];
  }

  const bodyWidth = Math.max(width - INDENT.length, MIN_WRAP_WIDTH);
  let body = wrap(trimmed, bodyWidth);

  let truncated = false;
  if (!expanded && body.length > COLLAPSED_MAX_BODY_LINES) {
    body = body.slice(0, COLLAPSED_MAX_BODY_LINES);
    truncated = true;
  }

  const lines: string[] = [PREFIX];
  for (const line of body) {
    lines.push(`${INDENT}${line}`);
  }
  if (truncated) {
    lines.push(`${INDENT}\u2026 (expand tool output to see the full reason)`);
  }

  return lines;
}

/**
 * Extract the reason string from a custom message's `content`. `sendMessage`
 * sends a plain string for the speculation flag, but the type allows a content
 * array -- handle both so a future change to richer content doesn't silently
 * render nothing.
 */
function reasonFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (c): c is { type: "text"; text: string } =>
          !!c &&
          typeof c === "object" &&
          (c as { type?: unknown }).type === "text" &&
          typeof (c as { text?: unknown }).text === "string",
      )
      .map((c) => c.text)
      .join("\n");
  }
  return "";
}

/**
 * Build the colored lines for the flag. The prefix is warning-colored and bold;
 * the reason is rendered in the muted custom-message text color so the flag
 * reads as a secondary annotation, not a primary message.
 */
export function renderColoredLines(
  reason: string,
  width: number,
  expanded: boolean,
  theme: RendererTheme,
): string[] {
  const plain = formatSpeculationLines(reason, width, expanded);
  return plain.map((line, i) =>
    i === 0
      ? theme.fg("warning", theme.bold(line))
      : theme.fg("customMessageText", line),
  );
}

/**
 * Register the compact renderer for speculation-flag custom messages.
 *
 * `MessageRenderer` and the pi-tui `Component` it returns are not exported by
 * name from the package, so the parameter/return types are derived from
 * `ExtensionAPI["registerMessageRenderer"]` (the same pattern the rest of the
 * plugin uses to reach un-exported handler/ctx types). The returned component is
 * a hand-rolled `{ render(width) }` object -- the full `Component` interface only
 * requires `render`, so this needs no pi-tui import and behaves identically
 * under upstream pi and OMP.
 */
export function registerSpeculationRenderer(pi: ExtensionAPI): void {
  type Register = ExtensionAPI["registerMessageRenderer"];
  type Renderer = Parameters<Register>[1];
  type Message = Parameters<Renderer>[0];
  type Options = Parameters<Renderer>[1];
  type ThemeArg = Parameters<Renderer>[2];
  type RenderedComponent = ReturnType<Renderer>;

  const renderer = (
    message: Message,
    options: Options,
    theme: ThemeArg,
  ): RenderedComponent => {
    const reason = reasonFromContent(
      (message as { content?: unknown }).content,
    );
    const themeImpl: RendererTheme =
      theme && typeof (theme as RendererTheme).fg === "function"
        ? (theme as unknown as RendererTheme)
        : PLAIN_THEME;

    const component = {
      render(width: number): string[] {
        return renderColoredLines(
          reason,
          width,
          options.expanded,
          themeImpl,
        );
      },
    };
    return component as unknown as RenderedComponent;
  };

  pi.registerMessageRenderer(SPECULATION_FLAG_TYPE, renderer as Renderer);
}
