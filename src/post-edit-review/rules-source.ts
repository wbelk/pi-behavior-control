import * as fs from "node:fs";
import * as path from "node:path";
import { __clearCachedFileCache, loadCachedFile } from "../shared/cached-file.ts";
import { agentDir } from "../session/user-config.ts";

// Resolves the coding-rules source used by post-edit reviews and the
// uncommitted-change reviewer. A project source always wins over a global
// source, and a directory always wins over its same-scope compatibility file.

export type RulesScope = "cwd" | "master";
export type RulesSourceKind = "directory" | "file";

export interface ResolvedRulesSource {
  source: RulesScope;
  kind: RulesSourceKind;
  /** Absolute path to the selected directory or compatibility file. */
  path: string;
}

export interface ResolvedRules extends ResolvedRulesSource {
  text: string;
  /** Files whose contents contributed to text, in application order. */
  paths: string[];
  /** Normalized language selected from targetPath, when it has an extension. */
  language: string | null;
}

const RULES_DIRECTORY = "coding-rules";
const SHARED_RULES_FILENAME = "coding-rules.md";

const LANGUAGE_ALIASES: Readonly<Record<string, string>> = {
  bash: "shell",
  cc: "cplusplus",
  cjs: "javascript",
  cpp: "cplusplus",
  cs: "csharp",
  cts: "typescript",
  cxx: "cplusplus",
  js: "javascript",
  jsx: "javascript",
  kt: "kotlin",
  kts: "kotlin",
  md: "markdown",
  mdx: "markdown",
  mjs: "javascript",
  mts: "typescript",
  py: "python",
  rb: "ruby",
  rs: "rust",
  sh: "shell",
  ts: "typescript",
  tsx: "typescript",
  yaml: "yaml",
  yml: "yaml",
  zsh: "shell",
};

const DIRECT_LANGUAGES: Readonly<Record<string, true>> = {
  css: true,
  ejs: true,
  go: true,
  html: true,
  java: true,
  json: true,
  less: true,
  php: true,
  scss: true,
  swift: true,
};

function isPathKind(candidate: string, kind: RulesSourceKind): boolean {
  try {
    const stat = fs.statSync(candidate);
    return kind === "directory" ? stat.isDirectory() : stat.isFile();
  } catch {
    return false;
  }
}

/**
 * Resolve one rules source using the approved compatibility precedence:
 * project directory -> project file -> global directory -> global file.
 */
export function resolveRulesSource(cwd: string): ResolvedRulesSource | null {
  const master = agentDir();
  const candidates: ResolvedRulesSource[] = [
    {
      source: "cwd",
      kind: "directory",
      path: path.join(cwd, RULES_DIRECTORY),
    },
    {
      source: "cwd",
      kind: "file",
      path: path.join(cwd, SHARED_RULES_FILENAME),
    },
    {
      source: "master",
      kind: "directory",
      path: path.join(master, RULES_DIRECTORY),
    },
    {
      source: "master",
      kind: "file",
      path: path.join(master, SHARED_RULES_FILENAME),
    },
  ];

  for (let i = 0; i < candidates.length; i += 1) {
    const candidate = candidates[i];
    if (candidate && isPathKind(candidate.path, candidate.kind)) return candidate;
  }
  return null;
}

export function languageForPath(targetPath: string): string | null {
  const extension = path.extname(targetPath).slice(1).toLowerCase();
  if (extension.length === 0) return null;
  const alias = LANGUAGE_ALIASES[extension];
  if (alias) return alias;
  return DIRECT_LANGUAGES[extension] ? extension : null;
}

/**
 * Load shared rules plus rules for targetPath's language from the selected
 * directory. A top-level compatibility file remains shared-only.
 */
export function loadRules(
  cwd: string,
  targetPath?: string,
): ResolvedRules | null {
  const resolved = resolveRulesSource(cwd);
  if (!resolved) return null;

  const language = targetPath ? languageForPath(targetPath) : null;
  if (resolved.kind === "file") {
    const loaded = loadCachedFile(resolved.path);
    if (!loaded) return null;
    return {
      ...resolved,
      text: loaded.text,
      paths: [loaded.path],
      language,
    };
  }

  const loadedRules = [];
  const shared = loadCachedFile(path.join(resolved.path, SHARED_RULES_FILENAME));
  if (shared) loadedRules.push(shared);
  if (language) {
    const languageRules = loadCachedFile(
      path.join(resolved.path, `coding-rules.${language}.md`),
    );
    if (languageRules) loadedRules.push(languageRules);
  }

  return {
    ...resolved,
    text: loadedRules
      .map((loaded) => loaded.text)
      .filter((text) => text.length > 0)
      .join("\n\n"),
    paths: loadedRules.map((loaded) => loaded.path),
    language,
  };
}

/** Test-only: drop all cached rule and reminder files. */
export function __clearCacheForTests(): void {
  __clearCachedFileCache();
}
