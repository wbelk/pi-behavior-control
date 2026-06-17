import * as fs from "node:fs";

// File-read tracker with a sliding turn window. Backs hooks 2, 3, 5, and 6
// of the plan. Spec: section 7 hooks 2/3/5/6 of tasks/plan-pi-behavior-control.md.

export interface ReadEntry {
	/** Wall-clock time (ms since epoch) when the read tool fired. */
	readAt: number;
	/** File mtime (ms since epoch) captured immediately after the read. */
	modifiedAt: number;
	/** File size (bytes) captured immediately after the read. */
	size: number;
	/** Turn index (see `ReadTracker.currentTurn`) the read happened on. */
	turn: number;
}

/** Reason a write/edit was blocked. Returned by `check()`. */
export interface BlockReason {
	block: true;
	reason: string;
}

// Default sliding window: a read counts as "recent" for this many turns
// (the turn it happened on plus the next DEFAULT_WINDOW_TURNS - 1). Chosen
// so a read on turn N stays creditable through a short back-and-forth
// (read on one turn, discussed/cited a few turns later) without growing
// the log unboundedly across a long session.
const DEFAULT_WINDOW_TURNS = 4;

/**
 * Map of canonical-path → ReadEntry. Lives in the extension closure for the
 * life of the session. Entries are stamped with the turn they were read on
 * and aged out by `prune()` once they fall outside the sliding window
 * (`windowTurns`); `clear()` drops everything on session shutdown.
 */
export class ReadTracker {
	private readonly log = new Map<string, ReadEntry>();
	/**
	 * Monotonic turn counter, incremented once per turn by `prune()` (wired
	 * to `before_agent_start`). Entries are stamped with its value at read
	 * time so `prune()` can evict reads older than the window.
	 */
	private currentTurn = 0;

	constructor(private readonly windowTurns: number = DEFAULT_WINDOW_TURNS) {}

	/**
	 * Hook 2: record a file read. Canonicalizes the path via `realpathSync`
	 * so case-different paths on case-insensitive filesystems (macOS APFS by
	 * default, Windows NTFS) collapse to the same key.
	 *
	 * Silently no-ops if `realpathSync` throws — pi's read tool would have
	 * failed too, so we have nothing to track.
	 */
	record(rawPath: string): void {
		let canonical: string;
		let stat: fs.Stats;
		try {
			canonical = fs.realpathSync(rawPath);
			stat = fs.statSync(canonical);
		} catch {
			return;
		}
		this.log.set(canonical, {
			readAt: Date.now(),
			modifiedAt: stat.mtimeMs,
			size: stat.size,
			turn: this.currentTurn,
		});
	}

	/**
	 * Hook 3: check whether an edit/write is allowed.
	 *
	 *   - returns null when allowed
	 *   - returns { block: true, reason } when blocked
	 *
	 * Three cases:
	 *   1. Path does not resolve (likely a new file being created): allow.
	 *      Mirrors the Claude script's `[ ! -f "$FILE_PATH" ]` behavior.
	 *   2. Path is not in the read log (not read within the current window,
	 *      or never read) but exists: block with "Read the file before
	 *      editing it." The agent must call the read tool first.
	 *   3. Path was recorded but file changed on disk (mtime or size
	 *      differs): block with "File has been modified since you read it."
	 *      Catches modifications by external tools (formatters, bash
	 *      scripts, the user's editor) since the read. This mtime/size
	 *      revalidation is what keeps the wider window safe: a stale read
	 *      never authorizes an edit to a file that changed underneath it.
	 */
	check(rawPath: string): BlockReason | null {
		let canonical: string;
		try {
			canonical = fs.realpathSync(rawPath);
		} catch {
			return null;
		}
		const entry = this.log.get(canonical);
		if (!entry) {
			return {
				block: true,
				reason: "Read the file before editing it. (read log keeps the last few turns)",
			};
		}
		let stat: fs.Stats;
		try {
			stat = fs.statSync(canonical);
		} catch {
			return null;
		}
		if (stat.mtimeMs !== entry.modifiedAt || stat.size !== entry.size) {
			return {
				block: true,
				reason: "File has been modified since you read it. Re-read before editing.",
			};
		}
		return null;
	}

	/**
	 * Hook 6: refresh the entry for a path that was just written. Without
	 * this, every consecutive edit to the same file in one turn would be
	 * blocked by the mtime check — the agent's own write would invalidate
	 * the entry it just recorded. Re-stamps the entry on the current turn.
	 *
	 * Same canonicalization and silent-skip semantics as `record()`.
	 */
	refresh(rawPath: string): void {
		this.record(rawPath);
	}

	/**
	 * Hook 5 (per-turn): advance the turn counter and evict entries whose
	 * read turn has fallen outside the sliding window. Wired to
	 * `before_agent_start`, so it runs once at the start of every turn.
	 *
	 * An entry read on turn T survives while `currentTurn - T < windowTurns`.
	 * With the default window of 4: read on turn 0 stays through turns 1, 2,
	 * 3 and is evicted when the counter reaches 4.
	 */
	prune(): void {
		this.currentTurn += 1;
		const cutoff = this.currentTurn - this.windowTurns;
		if (cutoff < 0) return;
		for (const [key, entry] of this.log) {
			if (entry.turn <= cutoff) {
				this.log.delete(key);
			}
		}
	}

	/**
	 * Hook 5 (shutdown): drop everything. Wired to `session_shutdown` so no
	 * read state leaks across sessions on quit/reload.
	 */
	clear(): void {
		this.log.clear();
	}

	/**
	 * Canonical paths still inside the sliding window. Fed to the
	 * speculation verifier as <RECENT_READS> so a citation to a file read in
	 * the last few turns counts as grounded even when it was not re-read on
	 * the current turn.
	 */
	recentPaths(): readonly string[] {
		return Array.from(this.log.keys());
	}

	/** Read-only snapshot of canonical paths in the log. Used by tests. */
	paths(): readonly string[] {
		return Array.from(this.log.keys());
	}

	/** Read-only snapshot of an entry, or undefined. Used by tests. */
	entry(canonicalPath: string): Readonly<ReadEntry> | undefined {
		return this.log.get(canonicalPath);
	}
}
