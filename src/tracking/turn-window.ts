// Shared sliding-turn-window storage for the three evidence trackers
// (ReadTracker, InspectionTracker, ToolCallTracker). Each maps a string key
// (a canonical file path, or a low-fidelity "tool target" descriptor) to an
// entry stamped with the turn it was recorded on, and ages entries out once
// they fall outside the window.
//
// This is the single source of the window constant and the prune arithmetic so
// the three trackers cannot drift apart: a citation grounded by a read, by a
// search hit, or by a recent tool call all share the same lifetime.

/**
 * Default sliding window: an entry recorded on turn T stays "recent" for this
 * many turns (the turn it happened on plus the next DEFAULT_WINDOW_TURNS - 1).
 * Chosen so evidence from a short back-and-forth (recorded on one turn, cited a
 * few turns later) stays creditable without growing the logs unboundedly across
 * a long session.
 */
export const DEFAULT_WINDOW_TURNS = 4;

/** Minimal entry shape: every tracked value carries the turn it was recorded on. */
export interface TurnEntry {
	turn: number;
}

/**
 * Map of string key -> entry, aged out by a sliding turn window. Entries are
 * stamped with `currentTurn` at record time (by subclasses, via the protected
 * `log`/`currentTurn` members) and evicted by `prune()` once they fall outside
 * `windowTurns`. `clear()` drops everything on session shutdown.
 *
 * Subclasses own how keys and entries are produced (canonical paths + stat
 * metadata for ReadTracker, surfaced paths for InspectionTracker, deduped
 * call descriptors for ToolCallTracker) and expose domain-named accessors that
 * delegate to `recentKeys()`.
 */
export abstract class TurnWindowedKeyLog<E extends TurnEntry> {
	protected readonly log = new Map<string, E>();
	/**
	 * Monotonic turn counter, incremented once per turn by `prune()` (wired to
	 * `before_agent_start`). Entries are stamped with its value at record time
	 * so `prune()` can evict entries older than the window.
	 */
	protected currentTurn = 0;

	constructor(protected readonly windowTurns: number = DEFAULT_WINDOW_TURNS) {}

	/**
	 * Advance the turn counter and evict entries whose recorded turn has fallen
	 * outside the sliding window. An entry on turn T survives while
	 * `currentTurn - T < windowTurns`; with the default window of 4, an entry on
	 * turn 0 stays through turns 1, 2, 3 and is evicted when the counter reaches 4.
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

	/** Drop everything. Wired to `session_shutdown` so no state leaks across sessions. */
	clear(): void {
		this.log.clear();
	}

	/** Keys still inside the window, in insertion order (oldest first). */
	recentKeys(): readonly string[] {
		return Array.from(this.log.keys());
	}
}
