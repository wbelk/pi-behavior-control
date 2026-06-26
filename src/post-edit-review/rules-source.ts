import * as path from "node:path";
import { __clearCachedFileCache, loadCachedFile } from "../shared/cached-file.ts";
import { agentDir } from "../session/user-config.ts";

// Resolves the coding-rules text used by hook 6's post-edit review prompt.
// Spec: section 8a step (b) and section 7 hook 6.
//
// Resolution order:
//   1. <cwd>/coding-rules.md (project-local; always wins if present)
//   2. <agentDir>/coding-rules.md (global master; runtime-detected agent dir)
//   3. null (neither exists)
//
// Both candidate paths are re-checked on every call so a mid-session
// addition is picked up on the next edit. File contents are cached by
// (path, mtime, size) in the shared cached-file loader.

export type RulesSource = "cwd" | "master";

export interface ResolvedRules {
	text: string;
	source: RulesSource;
	/** Absolute path the text was loaded from. */
	path: string;
}

const RULES_FILENAME = "coding-rules.md";

export function loadRules(cwd: string): ResolvedRules | null {
	const cwdResult = loadCachedFile(path.join(cwd, RULES_FILENAME));
	if (cwdResult) return { ...cwdResult, source: "cwd" };

	const masterResult = loadCachedFile(path.join(agentDir(), RULES_FILENAME));
	if (masterResult) return { ...masterResult, source: "master" };

	return null;
}

/**
 * Test-only: drop all cache entries. Re-exported (rather than re-imported by
 * tests) so existing imports `from "./rules-source.ts"` keep working.
 */
export function __clearCacheForTests(): void {
	__clearCachedFileCache();
}
