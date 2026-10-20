import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  __clearCacheForTests,
  languageForPath,
  loadRules,
  resolveRulesSource,
} from "./rules-source.ts";

let cwd: string;
let agent: string;
let previousAgentDir: string | undefined;

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-behavior-control-rs-cwd-"));
  agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-behavior-control-rs-agent-"));
  previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agent;
  __clearCacheForTests();
});

afterEach(() => {
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  fs.rmSync(cwd, { recursive: true, force: true });
  fs.rmSync(agent, { recursive: true, force: true });
});

function writeRulesFile(root: string, relativePath: string, body: string): string {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, body, "utf-8");
  return filePath;
}

describe("resolveRulesSource", () => {
  test("returns null when no rules source exists", () => {
    expect(resolveRulesSource(cwd)).toBeNull();
  });

  test("uses project directory, project file, global directory, global file precedence", () => {
    const globalFile = writeRulesFile(agent, "coding-rules.md", "global-file");
    const globalDirectory = path.join(agent, "coding-rules");
    writeRulesFile(globalDirectory, "coding-rules.md", "global-directory");
    const projectFile = writeRulesFile(cwd, "coding-rules.md", "project-file");
    const projectDirectory = path.join(cwd, "coding-rules");
    writeRulesFile(projectDirectory, "coding-rules.md", "project-directory");

    expect(resolveRulesSource(cwd)).toEqual({
      source: "cwd",
      kind: "directory",
      path: projectDirectory,
    });

    fs.rmSync(projectDirectory, { recursive: true });
    expect(resolveRulesSource(cwd)?.path).toBe(projectFile);

    fs.rmSync(projectFile);
    expect(resolveRulesSource(cwd)?.path).toBe(globalDirectory);

    fs.rmSync(globalDirectory, { recursive: true });
    expect(resolveRulesSource(cwd)?.path).toBe(globalFile);
  });

  test("an empty project directory intentionally replaces lower-precedence sources", () => {
    writeRulesFile(agent, "coding-rules/coding-rules.md", "global");
    const projectDirectory = path.join(cwd, "coding-rules");
    fs.mkdirSync(projectDirectory);

    expect(resolveRulesSource(cwd)?.path).toBe(projectDirectory);
    expect(loadRules(cwd, "src/index.ts")?.text).toBe("");
  });

  test("ignores paths with the wrong filesystem kind", () => {
    fs.mkdirSync(path.join(cwd, "coding-rules.md"));
    fs.writeFileSync(path.join(agent, "coding-rules"), "not-a-directory");

    expect(resolveRulesSource(cwd)).toBeNull();
  });
});

describe("languageForPath", () => {
  test.each([
    ["src/index.ts", "typescript"],
    ["src/view.TSX", "typescript"],
    ["src/worker.mjs", "javascript"],
    ["docs/guide.mdx", "markdown"],
    ["scripts/release.zsh", "shell"],
    ["src/theme.css", "css"],
    ["src/main.unknown", null],
    ["Dockerfile", null],
  ])("maps %s to %s", (targetPath, expected) => {
    expect(languageForPath(targetPath)).toBe(expected);
  });
});

describe("loadRules", () => {
  test("loads shared rules before matching language rules", () => {
    const directory = path.join(cwd, "coding-rules");
    const sharedPath = writeRulesFile(
      directory,
      "coding-rules.md",
      "shared-rules",
    );
    const languagePath = writeRulesFile(
      directory,
      "coding-rules.typescript.md",
      "typescript-rules",
    );

    const resolved = loadRules(cwd, "src/index.ts");
    expect(resolved?.text).toBe("shared-rules\n\ntypescript-rules");
    expect(resolved?.paths).toEqual([sharedPath, languagePath]);
    expect(resolved?.language).toBe("typescript");
  });

  test("ignores a language file for an unknown extension", () => {
    writeRulesFile(cwd, "coding-rules/coding-rules.md", "shared-rules");
    writeRulesFile(
      cwd,
      "coding-rules/coding-rules.unknown.md",
      "must-not-apply",
    );

    const resolved = loadRules(cwd, "src/main.unknown");
    expect(resolved?.text).toBe("shared-rules");
    expect(resolved?.language).toBeNull();
  });

  test("loads a language file when the directory has no shared file", () => {
    writeRulesFile(
      cwd,
      "coding-rules/coding-rules.typescript.md",
      "typescript-only",
    );

    expect(loadRules(cwd, "src/index.ts")?.text).toBe("typescript-only");
  });

  test("top-level compatibility files remain shared-only", () => {
    const compatibilityPath = writeRulesFile(
      cwd,
      "coding-rules.md",
      "compatibility-rules",
    );
    writeRulesFile(agent, "coding-rules/coding-rules.typescript.md", "ignored");

    expect(loadRules(cwd, "src/index.ts")).toEqual({
      source: "cwd",
      kind: "file",
      path: compatibilityPath,
      text: "compatibility-rules",
      paths: [compatibilityPath],
      language: "typescript",
    });
  });

  test("re-reads a changed language file during the session", () => {
    const languagePath = writeRulesFile(
      cwd,
      "coding-rules/coding-rules.typescript.md",
      "v1",
    );
    expect(loadRules(cwd, "src/index.ts")?.text).toBe("v1");

    fs.writeFileSync(languagePath, "version-two", "utf-8");
    expect(loadRules(cwd, "src/index.ts")?.text).toBe("version-two");
  });

  test("picks up a source created after an earlier miss", () => {
    expect(loadRules(cwd, "src/index.ts")).toBeNull();
    writeRulesFile(cwd, "coding-rules/coding-rules.md", "appeared");
    expect(loadRules(cwd, "src/index.ts")?.text).toBe("appeared");
  });
});
