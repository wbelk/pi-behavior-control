import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  agentDir,
  configPath,
  expandHome,
  loadConfig,
  resolveAgentDir,
  saveConfig,
  type UserConfig,
} from "./user-config.ts";

// Use a unique tmp dir per test run so concurrent tests don't collide
// and stale state from a previous run can't bleed in.
let tmp: string;
let prevEnv: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-behavior-control-test-"));
  prevEnv = process.env.PI_CODING_AGENT_DIR;
});

afterEach(() => {
  if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = prevEnv;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveAgentDir (pure resolver)", () => {
  const home = "/fake/home";

  test("env value (absolute) wins over filesystem detection", () => {
    expect(
      resolveAgentDir({
        envValue: "/custom/agent",
        homeDir: home,
        exists: () => true,
      }),
    ).toBe("/custom/agent");
  });

  test("env value with ~ expands against the injected homeDir, not the real one", () => {
    expect(
      resolveAgentDir({
        envValue: "~/custom",
        homeDir: home,
        exists: () => false,
      }),
    ).toBe(path.join(home, "custom"));
  });

  test("both .omp and .pi exist → returns .omp (OMP wins)", () => {
    const omp = path.join(home, ".omp", "agent");
    const pi = path.join(home, ".pi", "agent");
    const exists = (p: string) => p === omp || p === pi;
    expect(resolveAgentDir({ envValue: undefined, homeDir: home, exists })).toBe(omp);
  });

  test("only .omp exists → returns .omp", () => {
    const omp = path.join(home, ".omp", "agent");
    expect(
      resolveAgentDir({
        envValue: undefined,
        homeDir: home,
        exists: (p) => p === omp,
      }),
    ).toBe(omp);
  });

  test("only .pi exists → returns .pi", () => {
    const pi = path.join(home, ".pi", "agent");
    expect(
      resolveAgentDir({
        envValue: undefined,
        homeDir: home,
        exists: (p) => p === pi,
      }),
    ).toBe(pi);
  });

  test("neither exists → returns .pi default", () => {
    expect(
      resolveAgentDir({
        envValue: undefined,
        homeDir: home,
        exists: () => false,
      }),
    ).toBe(path.join(home, ".pi", "agent"));
  });

  test("empty env value falls through to filesystem detection", () => {
    const omp = path.join(home, ".omp", "agent");
    expect(
      resolveAgentDir({
        envValue: "",
        homeDir: home,
        exists: (p) => p === omp,
      }),
    ).toBe(omp);
  });
});

describe("agentDir (production wrapper)", () => {
  test("env var override wins over filesystem detection", () => {
    process.env.PI_CODING_AGENT_DIR = tmp;
    expect(agentDir()).toBe(path.resolve(tmp));
  });

  test("env var with leading ~ is expanded against os.homedir()", () => {
    process.env.PI_CODING_AGENT_DIR = "~/some-pi-path-that-does-not-exist";
    expect(agentDir()).toBe(
      path.resolve(path.join(os.homedir(), "some-pi-path-that-does-not-exist")),
    );
  });

  test("with no env, returns one of the documented default paths", () => {
    delete process.env.PI_CODING_AGENT_DIR;
    // The user's actual machine may have ~/.omp/agent OR ~/.pi/agent OR
    // neither. The production wrapper's behavior is exercised by the
    // pure resolver tests above; here we just verify it returns a path
    // from the documented set.
    const home = os.homedir();
    expect([
      path.join(home, ".omp", "agent"),
      path.join(home, ".pi", "agent"),
    ]).toContain(agentDir());
  });
});

describe("expandHome", () => {
  test("bare ~ expands to home", () => {
    expect(expandHome("~")).toBe(os.homedir());
  });

  test("~/sub expands to home/sub", () => {
    expect(expandHome("~/projects")).toBe(path.join(os.homedir(), "projects"));
  });

  test("absolute paths pass through unchanged", () => {
    expect(expandHome("/etc/hosts")).toBe("/etc/hosts");
  });

  test("paths starting with text leave ~ alone", () => {
    expect(expandHome("foo~bar")).toBe("foo~bar");
  });
});

describe("configPath", () => {
  test("places config under <agentDir>/behavior-control/config.json", () => {
    process.env.PI_CODING_AGENT_DIR = tmp;
    expect(configPath()).toBe(
      path.join(path.resolve(tmp), "behavior-control", "config.json"),
    );
  });
});

describe("loadConfig", () => {
  beforeEach(() => {
    process.env.PI_CODING_AGENT_DIR = tmp;
  });

  test("returns null when file does not exist", () => {
    expect(loadConfig()).toBeNull();
  });

  test("returns parsed verifier for explicit-model shape", () => {
    const cfg: UserConfig = {
      verifier: { provider: "anthropic", id: "claude-haiku-4-5" },
    };
    saveConfig(cfg);
    expect(loadConfig()).toEqual(cfg);
  });

  test("returns parsed verifier for session-model shape", () => {
    saveConfig({ verifier: "session-model" });
    expect(loadConfig()).toEqual({ verifier: "session-model" });
  });

  test("returns empty config when verifier value is malformed", () => {
    // Hand-edit a malformed value.
    const p = configPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ verifier: 42 }), "utf-8");
    // We treat malformed-but-readable as "no preference" so the user is
    // re-prompted, not silently held to a broken value.
    expect(loadConfig()).toEqual({});
  });

  test("returns null when JSON is corrupt", () => {
    const p = configPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, "{not valid json", "utf-8");
    expect(loadConfig()).toBeNull();
  });

  test("returns null when JSON parses to non-object", () => {
    const p = configPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify("just a string"), "utf-8");
    expect(loadConfig()).toBeNull();
  });
});

describe("saveConfig", () => {
  beforeEach(() => {
    process.env.PI_CODING_AGENT_DIR = tmp;
  });

  test("creates the behavior-control subdirectory if missing", () => {
    const subdir = path.join(path.resolve(tmp), "behavior-control");
    expect(fs.existsSync(subdir)).toBe(false);
    saveConfig({ verifier: { provider: "anthropic", id: "claude-haiku-4-5" } });
    expect(fs.existsSync(subdir)).toBe(true);
  });

  test("writes file atomically via .tmp + rename — no stray .tmp files", () => {
    saveConfig({ verifier: "session-model" });
    const dir = path.dirname(configPath());
    const entries = fs.readdirSync(dir);
    // Only config.json should remain; any .tmp.<pid> file was renamed.
    expect(entries).toEqual(["config.json"]);
  });

  test("overwrites an existing config", () => {
    saveConfig({ verifier: { provider: "anthropic", id: "claude-haiku-4-5" } });
    saveConfig({ verifier: { provider: "anthropic", id: "claude-sonnet-4-5" } });
    expect(loadConfig()).toEqual({
      verifier: { provider: "anthropic", id: "claude-sonnet-4-5" },
    });
  });
});
