import { EventEmitter } from "node:events";
import { describe, expect, test } from "bun:test";
import {
  buildPiArgs,
  getPiInvocation,
  parseReviewerStdout,
  registerPiReviewSubagent,
  runReviewer,
  type ReviewerChildProcess,
} from "./pi-review-subagent.ts";

describe("buildPiArgs", () => {
  test("always runs json print mode without a session", () => {
    const args = buildPiArgs({ task: "audit the diff" });
    expect(args.slice(0, 4)).toEqual([
      "--mode",
      "json",
      "-p",
      "--no-session",
    ]);
    expect(args[args.length - 1]).toBe("Task: audit the diff");
    expect(args).toContain("--no-extensions");
  });

  test("includes model and tools when provided", () => {
    const args = buildPiArgs({
      task: "t",
      model: "anthropic/claude-x",
      tools: ["read", "bash"],
    });
    expect(args[args.indexOf("--model") + 1]).toBe("anthropic/claude-x");
    expect(args[args.indexOf("--tools") + 1]).toBe("read,bash");
  });

  test("appends the system-prompt file path when provided", () => {
    const args = buildPiArgs({
      task: "t",
      appendSystemPromptPath: "/tmp/p.md",
    });
    expect(args[args.indexOf("--append-system-prompt") + 1]).toBe("/tmp/p.md");
  });

  test("omits optional flags when not provided", () => {
    const args = buildPiArgs({ task: "t" });
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--tools");
    expect(args).not.toContain("--append-system-prompt");
  });

  test("omits --tools for an empty tool list", () => {
    const args = buildPiArgs({ task: "t", tools: [] });
    expect(args).not.toContain("--tools");
  });
});

describe("parseReviewerStdout", () => {
  const assistantLine = (
    text: string,
    extra: Record<string, unknown> = {},
  ): string =>
    JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text }],
        ...extra,
      },
    });

  test("returns the last assistant text as the final output", () => {
    const stdout = [
      assistantLine("first pass"),
      JSON.stringify({ type: "tool_result_end", message: { role: "tool" } }),
      assistantLine("final findings"),
    ].join("\n");
    const result = parseReviewerStdout(stdout);
    expect(result.finalText).toBe("final findings");
    expect(result.turns).toBe(2);
  });

  test("ignores malformed and non-message lines", () => {
    const stdout = [
      "not json",
      "",
      JSON.stringify({ type: "message_start" }),
      assistantLine("ok"),
    ].join("\n");
    const result = parseReviewerStdout(stdout);
    expect(result.finalText).toBe("ok");
    expect(result.turns).toBe(1);
  });

  test("captures stopReason and errorMessage from the assistant message", () => {
    const stdout = assistantLine("boom", {
      stopReason: "error",
      errorMessage: "model exploded",
    });
    const result = parseReviewerStdout(stdout);
    expect(result.stopReason).toBe("error");
    expect(result.errorMessage).toBe("model exploded");
  });

  test("concatenates all text parts of the final assistant message", () => {
    const stdout = JSON.stringify({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "primary" },
          { type: "text", text: "secondary" },
        ],
      },
    });
    expect(parseReviewerStdout(stdout).finalText).toBe("primary\nsecondary");
  });

  test("empty stdout yields empty output and zero turns", () => {
    const result = parseReviewerStdout("");
    expect(result.finalText).toBe("");
    expect(result.turns).toBe(0);
  });
});

describe("getPiInvocation", () => {
  const args = ["--mode", "json", "-p"];

  test("reuses the current script under the same runtime when it exists", () => {
    expect(
      getPiInvocation(args, {
        execPath: "/usr/bin/node",
        scriptPath: "/opt/pi/cli.js",
        fileExists: () => true,
      }),
    ).toEqual({ command: "/usr/bin/node", args: ["/opt/pi/cli.js", ...args] });
  });

  test("skips a Bun virtual script, then falls back to PATH on a generic runtime", () => {
    expect(
      getPiInvocation(args, {
        execPath: "/usr/local/bin/bun",
        scriptPath: "/$bunfs/root/omp",
        fileExists: () => true,
      }),
    ).toEqual({ command: "pi", args });
  });

  test("falls back to `pi` on PATH for a generic runtime with no usable script", () => {
    expect(
      getPiInvocation(args, {
        execPath: "/usr/bin/node",
        scriptPath: undefined,
        fileExists: () => false,
      }),
    ).toEqual({ command: "pi", args });
  });

  test("runs a compiled non-generic runtime binary directly", () => {
    expect(
      getPiInvocation(args, {
        execPath: "/opt/homebrew/bin/pi",
        scriptPath: undefined,
        fileExists: () => false,
      }),
    ).toEqual({ command: "/opt/homebrew/bin/pi", args });
  });
});

describe("registerPiReviewSubagent execute guard", () => {
  test("refuses on a runtime with the native task tool instead of spawning", async () => {
    let captured:
      | { execute: (...args: unknown[]) => Promise<unknown> }
      | undefined;
    const fakePi = {
      registerTool: (def: { execute: (...args: unknown[]) => Promise<unknown> }) => {
        captured = def;
      },
      getActiveTools: () => ["task", "read", "bash"],
    } as unknown as Parameters<typeof registerPiReviewSubagent>[0];

    registerPiReviewSubagent(fakePi);
    expect(captured).toBeDefined();
    await expect(
      captured?.execute("id", { task: "audit" }, undefined, undefined, {
        cwd: "/tmp",
      }),
    ).rejects.toThrow(/task/);
  });
});

// Fake child process for runReviewer: records the signals it receives and only
// terminates on the signals declared "lethal", so a SIGTERM-ignoring child can
// be modeled to exercise the SIGKILL escalation.
class FakeChild {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  kills: NodeJS.Signals[] = [];
  private onClose?: (code: number | null) => void;
  private onError?: (err: Error) => void;
  private lethal: Set<string>;

  constructor(lethal: string[]) {
    this.lethal = new Set(lethal);
  }

  on(event: string, listener: (...args: unknown[]) => void): this {
    if (event === "close") {
      this.onClose = listener as (code: number | null) => void;
    }
    if (event === "error") {
      this.onError = listener as (err: Error) => void;
    }
    return this;
  }

  emitError(err: Error): void {
    this.onError?.(err);
  }

  kill(signal: NodeJS.Signals = "SIGTERM"): boolean {
    this.kills.push(signal);
    if (this.lethal.has(signal)) this.terminate(signal);
    return true;
  }

  pushStdout(text: string): void {
    this.stdout.emit("data", Buffer.from(text));
  }

  pushStderr(text: string): void {
    this.stderr.emit("data", Buffer.from(text));
  }

  terminate(signal: NodeJS.Signals | null, code = 0): void {
    if (this.exitCode !== null || this.signalCode !== null) return;
    if (signal) this.signalCode = signal;
    else this.exitCode = code;
    this.onClose?.(signal ? null : code);
  }
}

const spawnReturning =
  (child: FakeChild, drive?: (c: FakeChild) => void) => () => {
    if (drive) setTimeout(() => drive(child), 0);
    return child as unknown as ReviewerChildProcess;
  };

const assistantEndLine = (
  text: string,
  extra: Record<string, unknown> = {},
): string =>
  JSON.stringify({
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text }], ...extra },
  });

describe("runReviewer", () => {
  test("returns the reviewer's final findings on success", async () => {
    const child = new FakeChild(["SIGTERM"]);
    const result = await runReviewer("audit", "/repo", undefined, {
      spawnChild: spawnReturning(child, (c) => {
        c.pushStdout(assistantEndLine("here are the findings"));
        c.terminate(null, 0);
      }),
    });
    expect(result.content[0]?.text).toBe("here are the findings");
    expect(result.details.turns).toBe(1);
    expect(child.kills).toEqual([]);
  });

  test("throws Reviewer failed on a non-zero exit", async () => {
    const child = new FakeChild(["SIGTERM"]);
    await expect(
      runReviewer("audit", "/repo", undefined, {
        spawnChild: spawnReturning(child, (c) => {
          c.pushStderr("git blew up");
          c.terminate(null, 2);
        }),
      }),
    ).rejects.toThrow(/Reviewer failed: git blew up/);
  });

  test("surfaces the spawn error message when the child fails to spawn", async () => {
    const child = new FakeChild(["SIGTERM"]);
    await expect(
      runReviewer("audit", "/repo", undefined, {
        spawnChild: spawnReturning(child, (c) => {
          c.emitError(new Error("spawn pi ENOENT"));
        }),
      }),
    ).rejects.toThrow(/Reviewer failed: spawn pi ENOENT/);
  });

  test("streams a final NDJSON line that arrives without a trailing newline", async () => {
    const child = new FakeChild(["SIGTERM"]);
    const updates: string[] = [];
    await runReviewer("audit", "/repo", undefined, {
      spawnChild: spawnReturning(child, (c) => {
        // No trailing newline: the streamed progress must still flush on close.
        c.pushStdout(assistantEndLine("trailing findings"));
        c.terminate(null, 0);
      }),
      onUpdate: (partial) => {
        const text = partial.content[0]?.text;
        if (text) updates.push(text);
      },
    });
    expect(updates).toContain("trailing findings");
  });

  test("throws when the reviewer message stopReason is error", async () => {
    const child = new FakeChild(["SIGTERM"]);
    await expect(
      runReviewer("audit", "/repo", undefined, {
        spawnChild: spawnReturning(child, (c) => {
          c.pushStdout(
            assistantEndLine("boom", {
              stopReason: "error",
              errorMessage: "model exploded",
            }),
          );
          c.terminate(null, 0);
        }),
      }),
    ).rejects.toThrow(/Reviewer failed: model exploded/);
  });

  test("kills a child that goes silent past the idle window", async () => {
    const child = new FakeChild(["SIGTERM"]);
    await expect(
      runReviewer("audit", "/repo", undefined, {
        spawnChild: spawnReturning(child),
        idleTimeoutMs: 15,
      }),
    ).rejects.toThrow(/stalled \(no output for 15ms\)/);
    expect(child.kills).toContain("SIGTERM");
  });

  test("throws when the abort signal is already aborted", async () => {
    const child = new FakeChild(["SIGTERM"]);
    const ac = new AbortController();
    ac.abort();
    await expect(
      runReviewer("audit", "/repo", ac.signal, {
        spawnChild: spawnReturning(child),
        idleTimeoutMs: 1000,
      }),
    ).rejects.toThrow(/Reviewer failed/);
    expect(child.kills).toContain("SIGTERM");
  });

  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const child = new FakeChild(["SIGKILL"]);
    await expect(
      runReviewer("audit", "/repo", undefined, {
        spawnChild: spawnReturning(child),
        idleTimeoutMs: 10,
        killGraceMs: 10,
      }),
    ).rejects.toThrow(/stalled/);
    expect(child.kills).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("clears idle and absolute timers on success so no late kill fires", async () => {
    const child = new FakeChild(["SIGTERM"]);
    await runReviewer("audit", "/repo", undefined, {
      spawnChild: spawnReturning(child, (c) => {
        c.pushStdout(assistantEndLine("done"));
        c.terminate(null, 0);
      }),
      idleTimeoutMs: 10,
      absoluteTimeoutMs: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(child.kills).toEqual([]);
  });

  test("fails loud when an external signal kills the child, even with partial output", async () => {
    const child = new FakeChild(["SIGTERM"]);
    await expect(
      runReviewer("audit", "/repo", undefined, {
        spawnChild: spawnReturning(child, (c) => {
          c.pushStdout(assistantEndLine("partial findings before the kill"));
          // External SIGKILL we did not send (no timeout, no abort): the child
          // exits with a null code that must not be laundered into success.
          c.terminate("SIGKILL", 0);
        }),
      }),
    ).rejects.toThrow(
      /terminated by signal SIGKILL — last output: partial findings before the kill/,
    );
    expect(child.kills).toEqual([]);
  });

  test("keeps a steadily-emitting child alive past the idle window", async () => {
    const child = new FakeChild(["SIGTERM"]);
    const result = await runReviewer("audit", "/repo", undefined, {
      spawnChild: spawnReturning(child, (c) => {
        // Emit at 40ms intervals under a 100ms idle window: each chunk re-arms
        // the watchdog, so the child survives a 120ms run (> the idle window)
        // unkilled -- proving liveness is activity, not elapsed time.
        c.pushStdout("progress noise\n");
        setTimeout(() => c.pushStdout("more progress\n"), 40);
        setTimeout(() => c.pushStdout("still going\n"), 80);
        setTimeout(() => {
          c.pushStdout(assistantEndLine("final findings") + "\n");
          c.terminate(null, 0);
        }, 120);
      }),
      idleTimeoutMs: 100,
      absoluteTimeoutMs: 20000,
    });
    expect(result.content[0]?.text).toBe("final findings");
    expect(child.kills).toEqual([]);
  });

  test("kills and fails loud when the absolute backstop elapses", async () => {
    const child = new FakeChild(["SIGTERM"]);
    await expect(
      runReviewer("audit", "/repo", undefined, {
        // One early chunk arms the (long) idle timer, then the child goes
        // quiet; the absolute backstop -- never re-armed -- is what stops it.
        spawnChild: spawnReturning(child, (c) => {
          c.pushStdout("starting review\n");
        }),
        idleTimeoutMs: 1000,
        absoluteTimeoutMs: 20,
        killGraceMs: 10,
      }),
    ).rejects.toThrow(/exceeded the 20ms hard cap/);
    expect(child.kills).toContain("SIGTERM");
  });

  test("streams progress to onUpdate as each assistant turn completes", async () => {
    const child = new FakeChild(["SIGTERM"]);
    const updates: Array<{ turns: number; text: string }> = [];
    const result = await runReviewer("audit", "/repo", undefined, {
      spawnChild: spawnReturning(child, (c) => {
        c.pushStdout(assistantEndLine("first pass") + "\n");
        c.pushStdout(assistantEndLine("final findings") + "\n");
        c.terminate(null, 0);
      }),
      onUpdate: (partial) => {
        updates.push({
          turns: partial.details.turns,
          text: partial.content[0]?.text ?? "",
        });
      },
    });
    expect(updates).toEqual([
      { turns: 1, text: "first pass" },
      { turns: 2, text: "final findings" },
    ]);
    expect(result.content[0]?.text).toBe("final findings");
    expect(result.details.turns).toBe(2);
  });

  test("onUpdate falls back to a turn-count label for a textless turn", async () => {
    const child = new FakeChild(["SIGTERM"]);
    const updates: string[] = [];
    await runReviewer("audit", "/repo", undefined, {
      spawnChild: spawnReturning(child, (c) => {
        // A tool-only assistant turn ends with no text content.
        c.pushStdout(
          JSON.stringify({
            type: "message_end",
            message: { role: "assistant", content: [] },
          }) + "\n",
        );
        c.pushStdout(assistantEndLine("done") + "\n");
        c.terminate(null, 0);
      }),
      onUpdate: (partial) => updates.push(partial.content[0]?.text ?? ""),
    });
    expect(updates[0]).toBe("reviewing… (1 turn)");
    expect(updates[1]).toBe("done");
  });
});
