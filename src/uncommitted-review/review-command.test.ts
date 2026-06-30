import { describe, expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  activeToolsSafe,
  checkPreconditions,
  registerReviewCommand,
} from "./review-command.ts";

// Minimal fake pi exposing only the methods under test.
const fakePi = (over: Partial<ExtensionAPI>): ExtensionAPI =>
  over as unknown as ExtensionAPI;

describe("checkPreconditions", () => {
  test("not-a-repo when git status exits non-zero", async () => {
    const pi = fakePi({
      exec: async () => ({ code: 128, stdout: "", stderr: "fatal", killed: false }),
    });
    expect(await checkPreconditions(pi, "/repo")).toBe("not-a-repo");
  });

  test("clean when git status output is empty", async () => {
    const pi = fakePi({
      exec: async () => ({ code: 0, stdout: "  \n", stderr: "", killed: false }),
    });
    expect(await checkPreconditions(pi, "/repo")).toBe("clean");
  });

  test("ok when git reports uncommitted changes", async () => {
    const pi = fakePi({
      exec: async () => ({
        code: 0,
        stdout: " M src/x.ts\n",
        stderr: "",
        killed: false,
      }),
    });
    expect(await checkPreconditions(pi, "/repo")).toBe("ok");
  });

  test("degrades to ok when git status is killed (timeout) despite non-zero code", async () => {
    const pi = fakePi({
      exec: async () => ({ code: 143, stdout: "", stderr: "", killed: true }),
    });
    expect(await checkPreconditions(pi, "/repo")).toBe("ok");
  });

  test("degrades to ok when exec throws (e.g. unavailable on runtime)", async () => {
    const pi = fakePi({
      exec: async () => {
        throw new Error("no exec on this runtime");
      },
    });
    expect(await checkPreconditions(pi, "/repo")).toBe("ok");
  });
});

describe("activeToolsSafe", () => {
  test("returns the active tools when available", () => {
    const pi = fakePi({ getActiveTools: () => ["task", "read"] });
    expect(activeToolsSafe(pi)).toEqual(["task", "read"]);
  });

  test("degrades to an empty list when getActiveTools throws", () => {
    const pi = fakePi({
      getActiveTools: () => {
        throw new Error("no getActiveTools on this runtime");
      },
    });
    expect(activeToolsSafe(pi)).toEqual([]);
  });
});

describe("registerReviewCommand handler", () => {
  type Notification = { text: string; level: string };

  // Register the command on a fake pi, capture the handler it registers, and
  // drive it with a fake ctx so the full orchestration (preconditions ->
  // runtime gating -> protocol payload) is exercised, not just the helpers.
  const harness = (gitStdout: string, gitCode: number, tools: string[]) => {
    const notifications: Notification[] = [];
    const messages: string[] = [];
    let handler: ((args: string, ctx: unknown) => Promise<void>) | null = null;
    const pi = {
      exec: async () => ({
        code: gitCode,
        stdout: gitStdout,
        stderr: "",
        killed: false,
      }),
      getActiveTools: () => tools,
      registerCommand: (
        _name: string,
        def: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => {
        handler = def.handler;
      },
      sendUserMessage: (text: string) => {
        messages.push(text);
      },
    } as unknown as ExtensionAPI;
    registerReviewCommand(pi);
    if (!handler) throw new Error("registerReviewCommand registered no handler");
    const ctx = {
      cwd: "/repo",
      ui: {
        notify: (text: string, level: string) =>
          notifications.push({ text, level }),
      },
    };
    return { run: (args = "") => handler!(args, ctx), notifications, messages };
  };

  test("not-a-repo: notifies info and sends no review message", async () => {
    const h = harness("", 128, ["task"]);
    await h.run();
    expect(h.messages).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]?.level).toBe("info");
    expect(h.notifications[0]?.text).toMatch(/not a git repository/);
  });

  test("clean tree: notifies info and sends no review message", async () => {
    const h = harness("   \n", 0, ["task"]);
    await h.run();
    expect(h.messages).toEqual([]);
    expect(h.notifications[0]?.text).toMatch(/no uncommitted changes/);
  });

  test("no reviewer mechanism: notifies error and sends no review message", async () => {
    const h = harness(" M src/x.ts\n", 0, []);
    await h.run();
    expect(h.messages).toEqual([]);
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0]?.level).toBe("error");
    expect(h.notifications[0]?.text).toMatch(/no reviewer mechanism/);
  });

  test("OMP runtime: sends the task-tool reviewer protocol and does not notify", async () => {
    const h = harness(" M src/x.ts\n", 0, ["task", "read"]);
    await h.run();
    expect(h.notifications).toEqual([]);
    expect(h.messages).toHaveLength(1);
    const prompt = h.messages[0] ?? "";
    expect(prompt).toMatch(/Run the uncommitted-change review process/);
    expect(prompt).toContain('agent: "reviewer"');
    expect(prompt).toContain("`task` tool");
  });

  test("upstream-pi runtime: sends the bundled-tool reviewer protocol and does not notify", async () => {
    const h = harness(" M src/x.ts\n", 0, ["uncommitted_review"]);
    await h.run();
    expect(h.notifications).toEqual([]);
    expect(h.messages).toHaveLength(1);
    expect(h.messages[0]).toContain("uncommitted_review");
  });

  test("forwards the trimmed command argument as the change-intent hint", async () => {
    const h = harness(" M src/x.ts\n", 0, ["task"]);
    await h.run("  focus on the spawn logic  ");
    expect(h.messages[0]).toContain("change-intent hint: focus on the spawn logic");
  });
});
