import * as fs from "node:fs";

// Per-turn file-read tracker. Backs hooks 2, 3, 5, and 6 of the plan.
// Spec: section 7 hooks 2/3/5/6 of tasks/plan-pi-behavior-control.md.

export interface ReadEntry {
	/** Wall-clock time (ms since epoch) when the read tool fired. */
	readAt: number;
	/** File mtime (ms since epoch) captured immediately after the read. */
	modifiedAt: number;
	/** File size (bytes) captured immediately after the read. */
	size: number;
}

/** Reason a write/edit was blocked. Returned by `check()`. */
export interface BlockReason {
	block: true;
	reason: string;
}

/**
 * Map of canonical-path → ReadEntry. Lives in the extension closure for the
 * duration of a turn; cleared at every `before_agent_start` and at
 * `session_shutdown`.
 */
export class ReadTracker {
	private readonly log = new Map<string, ReadEntry>();

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
	 *   2. Path was not recorded this turn but exists: block with
	 *      "Read the file before editing it." The agent must call the read
	 *      tool first.
	 *   3. Path was recorded but file changed on disk (mtime or size
	 *      differs): block with "File has been modified since you read it."
	 *      Catches mid-turn modifications by external tools (formatters,
	 *      bash scripts, the user's editor).
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
				reason: "Read the file before editing it. (read log clears every turn)",
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
	 * the entry it just recorded.
	 *
	 * Same canonicalization and silent-skip semantics as `record()`.
	 */
	refresh(rawPath: string): void {
		this.record(rawPath);
	}

	/**
	 * Hook 5: clear at the start of every turn (`before_agent_start`) and
	 * on `session_shutdown`. Enforces the per-turn freshness rule literally:
	 * reads from earlier turns do not count.
	 */
	clear(): void {
		this.log.clear();
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
