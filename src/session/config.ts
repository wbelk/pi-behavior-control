// Environment-variable accessors. Read fresh on every call — no caching.
// Spec: section 9 of tasks/plan-pi-behavior-control.md.

/**
 * Session-gate env var. Recognized values (strict, case-sensitive):
 *   "on"  → force enable for the session
 *   "off" → force disable for the session
 *
 * Any other value (or unset) returns undefined and the caller falls through
 * to the next resolution step (UI prompt or headless default).
 */
export type SessionGateValue = "on" | "off" | undefined;

export function readSessionGate(): SessionGateValue {
  const raw = process.env.PI_BEHAVIOR_CONTROL;
  if (raw === "on" || raw === "off") return raw;
  return undefined;
}

