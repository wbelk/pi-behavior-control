import * as fs from "node:fs";
import * as path from "node:path";
import { agentDir } from "./user-config.ts";

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
// (path, mtime, size); cache hit returns text without re-reading.

export type RulesSource = "cwd" | "master";

export interface ResolvedRules {
	text: string;
	source: RulesSource;
	/** Absolute path the text was loaded from. */
	path: string;
}

interface CacheEntry {
	modifiedAt: number;
	size: number;
	text: string;
}

// Module-level cache. Shared across all hook 6 fires within one extension
// instance. Keyed by absolute path; same cache covers both cwd and master
// candidate paths.
const cache = new Map<string, CacheEntry>();

const RULES_FILENAME = "coding-rules.md";

export function loadRules(cwd: string): ResolvedRules | null {
	const cwdPath = path.join(cwd, RULES_FILENAME);
	const cwdResult = tryLoad(cwdPath, "cwd");
	if (cwdResult) return cwdResult;

	const masterPath = path.join(agentDir(), RULES_FILENAME);
	const masterResult = tryLoad(masterPath, "master");
	if (masterResult) return masterResult;

	return null;
}

function tryLoad(absPath: string, source: RulesSource): ResolvedRules | null {
	let stat: fs.Stats;
	try {
		stat = fs.statSync(absPath);
	} catch {
		// File doesn't exist — drop any stale cache entry to bound memory.
		cache.delete(absPath);
		return null;
	}
	if (!stat.isFile()) {
		cache.delete(absPath);
		return null;
	}

	const cached = cache.get(absPath);
	if (cached && cached.modifiedAt === stat.mtimeMs && cached.size === stat.size) {
		return { text: cached.text, source, path: absPath };
	}

	let text: string;
	try {
		text = fs.readFileSync(absPath, "utf-8");
	} catch {
		cache.delete(absPath);
		return null;
	}
	cache.set(absPath, { modifiedAt: stat.mtimeMs, size: stat.size, text });
	return { text, source, path: absPath };
}

/**
 * Test-only: drop all cache entries. Double-underscore marks the API as
 * not for production callers (cache is otherwise managed transparently
 * via stat-based invalidation).
 */
export function __clearCacheForTests(): void {
	cache.clear();
}
