import * as fs from "node:fs";
import * as path from "node:path";

import { type TurnEntry, TurnWindowedKeyLog } from "./turn-window.ts";

// Inspection-evidence tracker fed by tool_result text. Shares the sliding
// turn-window lifecycle (prune/clear/recentKeys) with ReadTracker via
// TurnWindowedKeyLog. Different purpose: this one feeds the verifier's
// <RECENT_INSPECTIONS> block, NOT the read-before-edit gate.
//
// Why two trackers instead of one with two flags? The edit gate must only
// unlock on explicit `read` calls — a `search` hit doesn't show enough of a
// file to safely edit it. Keeping the loggers separate makes that invariant
// load-bearing in the type system: nothing in InspectionTracker can be wired
// into edit-gate checks because it doesn't expose `check()` or `refresh()`.
//
// How it's fed: tool_result events for inspection tools (`search`, `grep`,
// `find`, `ast_grep`, `lsp`, `ffgrep`, `fffind`, `fff-multi-grep`, plus
// fff override-mode aliases) hand their content blocks to
// `recordFromToolContent`, which extracts text and pipes it through the
// tolerant path extractor. False positives (a stray real path in
// explanatory text gets logged) are tolerable for the verifier's "did the
// agent see this file?" check; false negatives lead to over-flagging.

// Per-session memoization cap for the token→canonical-path map. Bounded so
// a long session that surfaces thousands of unique tokens can't grow the
// cache without limit. Map preserves first-insertion order, and a memo hit
// returns without re-inserting, so `.keys().next()` on overflow evicts the
// first-INSERTED key — FIFO, not LRU. FIFO is fine for this workload (hot
// paths get re-inserted naturally because the same tokens recur in similar
// tool outputs). 1000 entries chosen as a generous default; each entry is
// a short string pair, so memory pressure is negligible.
const MAX_MEMO_ENTRIES = 1000;

/**
 * Minimal shape of a tool result content block. We deliberately don't
 * import the runtime's full ContentBlock union here — the pi-coding-agent
 * shim differs between OMP and upstream pi, and this tracker only cares
 * about text-typed blocks with a string `.text` field. Other block kinds
 * (image, etc.) are silently skipped.
 */
export interface ToolContentBlock {
	type: string;
	text?: unknown;
}

export class InspectionTracker extends TurnWindowedKeyLog<TurnEntry> {
	// Token-resolution memo keyed by `${cwd}|${token}`. Value is the canonical
	// absolute path on a file hit, or `null` on a miss (so we don't re-stat
	// known-bad tokens). `Map.get` returns `undefined` for absent keys, which
	// distinguishes "not memoized" from "memoized as miss" cleanly.
	private readonly memo = new Map<string, string | null>();

	/**
	 * Extract plausible file paths from a tool result's rendered text and
	 * record any that resolve to real files in `cwd`. Tolerant by design:
	 *   - `[path/to/file#TAG]` headers (read/search/ast_grep)
	 *   - bare path lines (fff `ffgrep`/`fffind`, built-in `find`)
	 *   - `path:line` and `path:line:col` citations
	 *   - `` `path:line` `` markdown code-span citations
	 *   - `"path with space.ts"` quoted runs (paths with whitespace)
	 *   - lsp text responses
	 */
	recordFromText(text: string, cwd: string): void {
		for (const token of tokenize(text)) {
			const cleaned = cleanToken(token);
			if (!isPlausiblePath(cleaned)) continue;
			const canonical = this.resolveAndStat(cleaned, cwd);
			if (canonical === null) continue;
			this.log.set(canonical, { turn: this.currentTurn });
		}
	}

	/**
	 * Convenience wrapper for the `tool_result` hook in `src/index.ts`.
	 * Iterates the runtime's content blocks, picks out text-typed ones with
	 * a string payload, and pipes each through `recordFromText`. Non-text
	 * blocks (image, etc.) and malformed text blocks are silently skipped.
	 *
	 * Extracted as a method (rather than inlined in index.ts) so the
	 * content-shape handling is unit-testable without standing up the full
	 * pi extension harness.
	 */
	recordFromToolContent(
		content: ReadonlyArray<ToolContentBlock>,
		cwd: string,
	): void {
		for (const block of content) {
			if (block.type !== "text") continue;
			if (typeof block.text !== "string") continue;
			this.recordFromText(block.text, cwd);
		}
	}

	/**
	 * Resolve a token to a canonical absolute path if (and only if) it points
	 * at a regular file. Memoized per (cwd, token) — same cleaned token in the
	 * same cwd never re-hits the filesystem. Memo is bounded; oldest entries
	 * are evicted on overflow.
	 */
	private resolveAndStat(token: string, cwd: string): string | null {
		const cacheKey = `${cwd}|${token}`;
		const cached = this.memo.get(cacheKey);
		if (cached !== undefined) return cached;

		const candidate = path.isAbsolute(token) ? token : path.resolve(cwd, token);
		let canonical: string | null = null;
		try {
			if (fs.statSync(candidate).isFile()) {
				canonical = fs.realpathSync(candidate);
			}
		} catch {
			// not present — record the miss in the memo so we don't re-stat
		}

		this.memo.set(cacheKey, canonical);
		if (this.memo.size > MAX_MEMO_ENTRIES) {
			const oldest = this.memo.keys().next().value;
			if (oldest !== undefined) this.memo.delete(oldest);
		}
		return canonical;
	}

	/**
	 * Drop everything on session shutdown so no inspection state leaks across
	 * sessions. Also clears the resolution memo since absolute paths captured
	 * from one project's cwd are useless to the next.
	 */
	clear(): void {
		super.clear();
		this.memo.clear();
	}

	/**
	 * Canonical paths still inside the sliding window. Unioned with
	 * ReadTracker's recentPaths() by the agent_end hook to feed the
	 * verifier's <RECENT_INSPECTIONS> block.
	 */
	recentPaths(): readonly string[] {
		return this.recentKeys();
	}

	/** Test-only snapshot. */
	paths(): readonly string[] {
		return this.recentKeys();
	}
}

// ---- Pure helpers exported for tests --------------------------------------

/**
 * Split text into candidate tokens. Single-pass walker so quoted runs and
 * bare-residue tokens emit in source order:
 *
 *   - At a quote character (`"`, `'`, or `` ` ``), look ahead on the same
 *     line for the matching close. If found, the trimmed inner content is
 *     one token; cursor jumps past the closing quote. If no match on the
 *     same line, the quote behaves as a separator.
 *   - At any other separator (whitespace, brackets, parens, braces, commas,
 *     semicolons, quotes), skip.
 *   - Otherwise accumulate non-separator characters into a token.
 *
 * Colons are NOT separators: `path:line` and `path:line:col` citations
 * stay glued together here and get stripped of their suffix in
 * `cleanToken`.
 *
 * The matched-quote case handles the dominant pattern for paths with
 * whitespace — agents (and tools that need to disambiguate) wrap them in
 * `"…"`, `` `…` ``, or `'…'`. Bare unquoted paths with embedded whitespace
 * cannot be recovered from tokenization alone and are a known limitation
 * — recovering them would require line-level structural parsing per tool
 * format, which couples us back to per-renderer parsers.
 */
export function tokenize(text: string): string[] {
	const tokens: string[] = [];
	const QUOTE = /["'`]/;
	const SEPARATOR = /[\s[\](),;'"`]/;

	// `text.charAt(i)` is used instead of `text[i]` so the access type is
	// `string` (returns "" out of bounds) rather than `string | undefined`.
	// All bounds are still enforced by the surrounding `i < text.length`
	// checks; the empty string just falls through every regex test.
	let i = 0;
	while (i < text.length) {
		const ch = text.charAt(i);

		if (QUOTE.test(ch)) {
			let j = i + 1;
			while (j < text.length && text.charAt(j) !== ch && text.charAt(j) !== "\n") {
				j++;
			}
			if (j < text.length && text.charAt(j) === ch) {
				const inner = text.slice(i + 1, j).trim();
				if (inner.length > 0) tokens.push(inner);
				i = j + 1;
				continue;
			}
			// Unmatched: fall through to separator handling.
			i++;
			continue;
		}

		if (SEPARATOR.test(ch)) {
			i++;
			continue;
		}

		// Accumulate a non-separator run.
		let j = i;
		while (j < text.length && !SEPARATOR.test(text.charAt(j))) j++;
		tokens.push(text.slice(i, j));
		i = j;
	}

	return tokens;
}

/**
 * Strip leading/trailing punctuation and known suffixes that wrap path
 * substrings in tool output:
 *   - trailing `` .,;:!?'")]}>` `` — sentence/list/quote/code-span terminators
 *   - leading `` <([{'"` `` — sentence/list/quote/code-span openers
 *   - trailing `#[0-9A-Fa-f]{1,8}` — the snapshot tag suffix on our
 *     `[path#TAG]` headers
 *   - trailing `:N` and `:N:M` — file:line and file:line:col citations,
 *     stripped iteratively so both suffixes peel
 *
 * Backticks appear here as well as in `tokenize` because tool output
 * occasionally produces tokens with one-sided backticks (e.g. a backtick
 * at start-of-line that doesn't get split when there's no separator on the
 * other side); stripping defensively is cheap.
 */
export function cleanToken(token: string): string {
	let cleaned = token.replace(/[.,;:!?'")\]}>`]+$/, "");
	cleaned = cleaned.replace(/^[<([{'"`]+/, "");
	cleaned = cleaned.replace(/#[0-9A-Fa-f]{1,8}$/, "");
	while (true) {
		const next = cleaned.replace(/:\d+$/, "");
		if (next === cleaned) break;
		cleaned = next;
	}
	return cleaned;
}

/**
 * Cheap pre-filter to skip obvious non-paths before the statSync syscall.
 * Anything that passes still gets a stat check — this is just a speed-up,
 * not a correctness gate. A "plausible path" must contain at least one `/`
 * or `.` (a filename without either is almost certainly a word, not a path),
 * be reasonably bounded in length, and not be all digits.
 */
export function isPlausiblePath(token: string): boolean {
	if (token.length < 3 || token.length > 512) return false;
	if (!/[/.]/.test(token)) return false;
	if (/^\d+$/.test(token)) return false;
	return true;
}
