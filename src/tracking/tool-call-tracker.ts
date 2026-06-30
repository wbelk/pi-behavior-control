import { type TurnEntry, TurnWindowedKeyLog } from "./turn-window.ts";

// Tool-call evidence tracker. Records each tool the assistant runs as a
// low-fidelity, deduplicated descriptor — `name` plus one salient argument
// (path / pattern / command) — within the same sliding turn window as the
// other trackers. Feeds the verifier's <TOOL_CALLS> block.
//
// Low fidelity is deliberate: the verifier is a cheap model answering a
// subjective "is this grounded?" question, so it needs to see WHAT the agent
// touched, not full arguments or tool output. Trimming also turns the log into
// a set keyed by `name target`, so repeated identical calls dedup for free and
// large edit/write bodies never reach the prompt.

// Salient-argument probe order. The first present string field becomes the
// call's target, so search-style tools surface what they searched for
// (pattern/glob/query) and path tools surface the file; `command` covers bash.
// Ordered by priority, so it stays an array rather than a lookup table.
const SALIENT_KEYS = ["pattern", "glob", "query", "command", "path", "file"] as const;

// Cap on the rendered target. A path or pattern fits comfortably; a long bash
// command is trimmed so one entry can't dominate the verifier prompt.
const MAX_TARGET_CHARS = 80;

/**
 * Build the deduplication key for a tool call: `name` plus its first present
 * salient argument (trimmed), e.g. `read src/foo.ts`, `grep parseConfig`,
 * `bash bun test`. Falls back to the bare name when no salient argument is
 * present (so a no-arg or custom tool still records its name). Exported for
 * tests.
 */
export function toolCallKey(name: string, input: unknown): string {
  if (input === null || typeof input !== "object") return name;
  const record = input as Record<string, unknown>;
  for (const key of SALIENT_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || value.length === 0) continue;
    const target =
      value.length > MAX_TARGET_CHARS
        ? `${value.slice(0, MAX_TARGET_CHARS)}…`
        : value;
    return `${name} ${target}`;
  }
  return name;
}

export class ToolCallTracker extends TurnWindowedKeyLog<TurnEntry> {
  /**
   * Record a tool call by its low-fidelity dedup key. Re-recording an
   * identical key refreshes its turn, so a repeatedly-run call stays inside
   * the window instead of aging out on its first appearance.
   */
  record(name: string, input: unknown): void {
    this.log.set(toolCallKey(name, input), { turn: this.currentTurn });
  }

  /** Deduplicated call descriptors still inside the window, oldest first. */
  recentCalls(): readonly string[] {
    return this.recentKeys();
  }
}
