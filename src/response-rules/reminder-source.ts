import * as fs from "node:fs";
import * as path from "node:path";
import { __clearCachedFileCache, loadCachedFile } from "../shared/cached-file.ts";
import { agentDir } from "../session/user-config.ts";

// Resolves the response-rules-reminder text injected into the system prompt
// at the start of every agent turn (hook 5 / before_agent_start).
// Resolution order mirrors ../post-edit-review/rules-source.ts:
//   1. <cwd>/response-rules-reminder.md (project-local; always wins if present)
//   2. <agentDir>/response-rules-reminder.md (global master; runtime-detected)
//   3. null (neither exists, or the resolved file is empty/whitespace-only)
//
// Both candidate paths are re-checked on every call so a mid-session addition
// is picked up on the next turn. File contents are cached by (path, mtime,
// size) in the shared cached-file loader. An empty or whitespace-only file
// resolves to null so there is nothing to inject into the system prompt.

export type ReminderSource = "cwd" | "master";

export interface ResolvedReminder {
  text: string;
  source: ReminderSource;
  /** Absolute path the text was loaded from. */
  path: string;
}

const REMINDER_FILENAME = "response-rules-reminder.md";

/**
 * Candidate paths checked (in order) by `loadResponseReminder`. Exposed so
 * callers that need to display "I looked here" — e.g. the missing-file
 * dialog in `index.ts` — share one source of truth with the loader.
 */
export function reminderCandidatePaths(cwd: string): {
  cwdPath: string;
  masterPath: string;
} {
  return {
    cwdPath: path.join(cwd, REMINDER_FILENAME),
    masterPath: path.join(agentDir(), REMINDER_FILENAME),
  };
}

export function loadResponseReminder(cwd: string): ResolvedReminder | null {
  const { cwdPath, masterPath } = reminderCandidatePaths(cwd);

  const cwdResult = loadCachedFile(cwdPath, { nullIfEmpty: true });
  if (cwdResult) return { ...cwdResult, source: "cwd" };

  const masterResult = loadCachedFile(masterPath, { nullIfEmpty: true });
  if (masterResult) return { ...masterResult, source: "master" };

  return null;
}

/**
 * Filesystem-existence check used by the missing-file dialog trigger. Returns
 * true if a regular file exists at either candidate path, regardless of
 * content. Intentionally distinct from `loadResponseReminder` — the loader
 * returns null for empty/whitespace files (so `before_agent_start` does not
 * inject an empty attribution frame), but the actionable dialog should NOT
 * keep re-firing every session just because the file the user created via
 * the dialog is still empty. "File exists, even empty" is the user's signal
 * that they have acknowledged the feature.
 */
export function responseReminderFileExists(cwd: string): boolean {
  const { cwdPath, masterPath } = reminderCandidatePaths(cwd);
  for (const candidate of [cwdPath, masterPath]) {
    try {
      if (fs.statSync(candidate).isFile()) return true;
    } catch {
      // not present at this path; fall through and try the next.
    }
  }
  return false;
}

/**
 * Test-only: drop all cache entries. Re-exported (rather than re-imported by
 * tests) so existing imports `from "./reminder-source.ts"` keep working.
 */
export function __clearCacheForTests(): void {
  __clearCachedFileCache();
}
