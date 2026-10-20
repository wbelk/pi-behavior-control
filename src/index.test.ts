import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import pluginFactory from "./index.ts";

type EventHandler = (event: unknown, ctx: unknown) => unknown;

function createExtensionHarness() {
  const handlers = new Map<string, EventHandler[]>();
  const pi = {
    on: (eventName: string, handler: EventHandler) => {
      const eventHandlers = handlers.get(eventName) ?? [];
      eventHandlers.push(handler);
      handlers.set(eventName, eventHandlers);
    },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    registerTool: () => {},
  } as unknown as ExtensionAPI;

  pluginFactory(pi);

  return {
    async fire(eventName: string, event: unknown, ctx: unknown) {
      const results = [];
      for (const handler of handlers.get(eventName) ?? []) {
        results.push(await handler(event, ctx));
      }
      return results;
    },
  };
}

describe("extension read-before-edit integration", () => {
  let tmp: string;
  let previousGate: string | undefined;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bc-index-"));
    previousGate = process.env.PI_BEHAVIOR_CONTROL;
    delete process.env.PI_BEHAVIOR_CONTROL;
  });

  afterEach(() => {
    if (previousGate === undefined) delete process.env.PI_BEHAVIOR_CONTROL;
    else process.env.PI_BEHAVIOR_CONTROL = previousGate;
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  test("a failed read does not authorize a later edit", async () => {
    const target = path.join(tmp, "target.ts");
    fs.writeFileSync(target, "export const value = 1;\n", "utf-8");
    const harness = createExtensionHarness();
    const ctx = { cwd: tmp, hasUI: false };

    await harness.fire("session_start", { type: "session_start" }, ctx);
    await harness.fire(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "target.ts" },
      },
      ctx,
    );
    await harness.fire(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "target.ts" },
        content: [{ type: "text", text: "read failed" }],
        details: undefined,
        isError: true,
      },
      ctx,
    );
    const editResults = await harness.fire(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "edit-1",
        toolName: "edit",
        input: { path: "target.ts", edits: [] },
      },
      ctx,
    );

    expect(editResults).toContainEqual({
      block: true,
      reason: "Read the file before editing it. (read log keeps the last few turns)",
    });
  });

  test("a file changed during a successful read remains unauthorized", async () => {
    const target = path.join(tmp, "target.ts");
    fs.writeFileSync(target, "export const value = 1;\n", "utf-8");
    const harness = createExtensionHarness();
    const ctx = { cwd: tmp, hasUI: false };

    await harness.fire("session_start", { type: "session_start" }, ctx);
    await harness.fire(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "target.ts" },
      },
      ctx,
    );
    fs.writeFileSync(target, "export const value = 200;\n", "utf-8");
    await harness.fire(
      "tool_result",
      {
        type: "tool_result",
        toolCallId: "read-1",
        toolName: "read",
        input: { path: "target.ts" },
        content: [{ type: "text", text: "export const value = 1;" }],
        details: undefined,
        isError: false,
      },
      ctx,
    );
    const editResults = await harness.fire(
      "tool_call",
      {
        type: "tool_call",
        toolCallId: "edit-1",
        toolName: "edit",
        input: { path: "target.ts", edits: [] },
      },
      ctx,
    );

    expect(editResults).toContainEqual(
      expect.objectContaining({ block: true }),
    );
  });
});
