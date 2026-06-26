import { describe, expect, test } from "bun:test";
import { ToolCallTracker, toolCallKey } from "./tool-call-tracker.ts";

describe("toolCallKey", () => {
	test("uses path for read/edit-style inputs", () => {
		expect(toolCallKey("read", { path: "src/foo.ts" })).toBe("read src/foo.ts");
		expect(toolCallKey("edit", { path: "src/foo.ts", edits: [] })).toBe(
			"edit src/foo.ts",
		);
	});

	test("prefers pattern over path for search-style inputs", () => {
		expect(toolCallKey("grep", { pattern: "parseConfig", path: "src" })).toBe(
			"grep parseConfig",
		);
		expect(toolCallKey("find", { pattern: "*.ts" })).toBe("find *.ts");
	});

	test("uses command for bash and synthetic bash!", () => {
		expect(toolCallKey("bash", { command: "bun test", timeout: 5 })).toBe(
			"bash bun test",
		);
		expect(toolCallKey("bash!", { command: "git status" })).toBe(
			"bash! git status",
		);
	});

	test("falls back to the bare name when no salient field is present", () => {
		expect(toolCallKey("mytool", { foo: 1, bar: true })).toBe("mytool");
		expect(toolCallKey("noargs", {})).toBe("noargs");
		expect(toolCallKey("nullish", null)).toBe("nullish");
	});

	test("ignores non-string salient values", () => {
		// offset is a number / not a salient key; path is the string we want.
		expect(toolCallKey("read", { path: "a.ts", offset: 40 })).toBe("read a.ts");
		// a non-string path is skipped, falling through to the bare name.
		expect(toolCallKey("weird", { path: 42 })).toBe("weird");
	});

	test("trims an over-long target with an ellipsis", () => {
		const longCommand = "x".repeat(200);
		const key = toolCallKey("bash", { command: longCommand });
		expect(key.startsWith("bash ")).toBe(true);
		expect(key.endsWith("…")).toBe(true);
		expect(key.length).toBeLessThan(longCommand.length);
	});
});

describe("ToolCallTracker", () => {
	test("records calls as ordered descriptors", () => {
		const tracker = new ToolCallTracker();
		tracker.record("read", { path: "a.ts" });
		tracker.record("grep", { pattern: "x" });
		expect([...tracker.recentCalls()]).toEqual(["read a.ts", "grep x"]);
	});

	test("dedups calls that trim to the same key", () => {
		const tracker = new ToolCallTracker();
		tracker.record("read", { path: "a.ts", offset: 1 });
		tracker.record("read", { path: "a.ts", offset: 99 });
		expect([...tracker.recentCalls()]).toEqual(["read a.ts"]);
	});

	test("keeps distinct calls separate", () => {
		const tracker = new ToolCallTracker();
		tracker.record("read", { path: "a.ts" });
		tracker.record("read", { path: "b.ts" });
		expect(tracker.recentCalls()).toHaveLength(2);
	});

	test("evicts entries once they age out of the window", () => {
		const tracker = new ToolCallTracker(2);
		tracker.record("read", { path: "a.ts" }); // turn 0
		tracker.prune(); // turn 1 — still inside window
		expect(tracker.recentCalls()).toHaveLength(1);
		tracker.prune(); // turn 2, cutoff 0 — evicted
		expect(tracker.recentCalls()).toHaveLength(0);
	});

	test("a re-record refreshes a call's turn so it stays in the window", () => {
		const tracker = new ToolCallTracker(2);
		tracker.record("read", { path: "a.ts" }); // turn 0
		tracker.prune(); // turn 1
		tracker.record("read", { path: "a.ts" }); // refreshed to turn 1
		tracker.prune(); // turn 2, cutoff 0 — turn-1 entry survives
		expect([...tracker.recentCalls()]).toEqual(["read a.ts"]);
		tracker.prune(); // turn 3, cutoff 1 — evicted
		expect(tracker.recentCalls()).toHaveLength(0);
	});

	test("clear drops everything", () => {
		const tracker = new ToolCallTracker();
		tracker.record("read", { path: "a.ts" });
		tracker.clear();
		expect(tracker.recentCalls()).toHaveLength(0);
	});
});
