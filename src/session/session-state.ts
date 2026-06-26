// Per-session mutable state. One instance per loaded extension; persists
// for the life of the extension instance.
// Spec: section 8a (enabled), hook 5 (reset).

export interface SessionState {
	/** Set by the session enablement gate. All active hooks no-op when false. */
	enabled: boolean;
}

export function createSessionState(): SessionState {
	return {
		enabled: false,
	};
}

/**
 * Reset to initial state. Called on `session_shutdown` and on
 * `session_start` (every reason — startup, new, resume, fork, reload).
 */
export function resetSessionState(state: SessionState): void {
	state.enabled = false;
}
