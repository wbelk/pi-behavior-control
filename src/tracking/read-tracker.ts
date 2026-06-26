import * as fs from "node:fs";

import { type TurnEntry, TurnWindowedKeyLog } from "./turn-window.ts";

// File-read tracker. Backs the read-before-edit gate (records reads, blocks
// edits to unread or changed files) and contributes its recent paths to the
// verifier's <RECENT_INSPECTIONS> evidence. The sliding-turn-window lifecycle
// (prune/clear/recentKeys + the window constant) is inherited from
// TurnWindowedKeyLog so it stays in lockstep with the other trackers.

export interface ReadEntry extends TurnEntry {
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

export class ReadTracker extends TurnWindowedKeyLog<ReadEntry> {
	/**
	 * Record a file read. Canonicalizes the path via `realpathSync` so
	 * case-different paths on case-insensitive filesystems (macOS APFS by
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
	 * Check whether an edit/write is allowed.
	 *
	 *   - returns null when allowed
	 *   - returns { block: true, reason } when blocked
	 *
	 * Three cases:
	 *   1. Path does not resolve (likely a new file being created): allow.
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
	 * Refresh the entry for a path that was just written. Without this, every
	 * consecutive edit to the same file in one turn would be blocked by the
	 * mtime check — the agent's own write would invalidate the entry it just
	 * recorded. Re-stamps the entry on the current turn.
	 */
	refresh(rawPath: string): void {
		this.record(rawPath);
	}

	/**
	 * Canonical paths still inside the sliding window. Unioned with
	 * InspectionTracker.recentPaths() at agent_end to feed <RECENT_INSPECTIONS>.
	 */
	recentPaths(): readonly string[] {
		return this.recentKeys();
	}

	/** Read-only snapshot of canonical paths in the log. Used by tests. */
	paths(): readonly string[] {
		return this.recentKeys();
	}

	/** Read-only snapshot of an entry, or undefined. Used by tests. */
	entry(canonicalPath: string): Readonly<ReadEntry> | undefined {
		return this.log.get(canonicalPath);
	}
}
