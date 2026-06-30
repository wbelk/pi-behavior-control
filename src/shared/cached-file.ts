import * as fs from "node:fs";

// Stat-cached file loader shared by post-edit-review/rules-source.ts and response-rules/reminder-source.ts.
//
// Both resolvers want the same thing: look up an absolute path, return its
// text, and avoid re-reading on every call when nothing has changed. The
// fingerprint is (mtimeMs, size); a mismatch (or a stat failure / non-file)
// invalidates the entry.
//
// Cache keys are absolute paths, so a single module-level Map is safe to
// share across resolvers — there is no collision risk between
// `coding-rules.md` and `response-rules-reminder.md` lookups.

interface CacheEntry {
  modifiedAt: number;
  size: number;
  text: string;
}

const cache = new Map<string, CacheEntry>();

export interface LoadedFile {
  text: string;
  /** Absolute path the text was loaded from. */
  path: string;
}

export interface LoadOptions {
  /**
   * When true, a file whose contents trim to the empty string resolves to
   * `null` instead of `{ text: "", path }`. Used by the reminder loader so
   * an empty file does not cause an empty attribution frame to be injected
   * into the system prompt.
   *
   * The cache entry is still written either way, so a stable empty file is
   * not re-read every call — only re-checked via stat.
   */
  nullIfEmpty?: boolean;
}

/**
 * Load `absPath` through the stat-cache. Returns `null` if the path is
 * missing, is not a regular file, fails to read, or (with `nullIfEmpty`)
 * trims to empty.
 */
export function loadCachedFile(
  absPath: string,
  opts?: LoadOptions,
): LoadedFile | null {
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
  if (
    cached &&
    cached.modifiedAt === stat.mtimeMs &&
    cached.size === stat.size
  ) {
    if (opts?.nullIfEmpty && cached.text.trim().length === 0) return null;
    return { text: cached.text, path: absPath };
  }

  let text: string;
  try {
    text = fs.readFileSync(absPath, "utf-8");
  } catch {
    cache.delete(absPath);
    return null;
  }
  cache.set(absPath, { modifiedAt: stat.mtimeMs, size: stat.size, text });

  if (opts?.nullIfEmpty && text.trim().length === 0) return null;
  return { text, path: absPath };
}

/**
 * Test-only: drop all cache entries. Double-underscore marks the API as
 * not for production callers (cache is otherwise managed transparently
 * via stat-based invalidation).
 */
export function __clearCachedFileCache(): void {
  cache.clear();
}
