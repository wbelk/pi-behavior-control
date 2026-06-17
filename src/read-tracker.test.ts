import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ReadTracker } from "./read-tracker.ts";

let tmp: string;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-behavior-control-rt-"));
});

afterEach(() => {
	fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(name: string, body = ""): string {
	const p = path.join(tmp, name);
	fs.writeFileSync(p, body, "utf-8");
	return p;
}

describe("record", () => {
	test("stores an entry keyed by canonical path with stat metadata", () => {
		const tracker = new ReadTracker();
		const file = writeFile("a.txt", "hello");
		tracker.record(file);
		const canonical = fs.realpathSync(file);
		const entry = tracker.entry(canonical);
		expect(entry).toBeDefined();
		expect(entry?.size).toBe(5);
		expect(typeof entry?.modifiedAt).toBe("number");
		expect(typeof entry?.readAt).toBe("number");
	});

	test("silently no-ops on a missing file (realpath throws)", () => {
		const tracker = new ReadTracker();
		tracker.record(path.join(tmp, "does-not-exist.txt"));
		expect(tracker.paths()).toEqual([]);
	});

	test("symlinked paths collapse to the same canonical key", () => {
		const tracker = new ReadTracker();
		const real = writeFile("real.txt", "x");
		const link = path.join(tmp, "link.txt");
		fs.symlinkSync(real, link);
		tracker.record(link);
		tracker.record(real);
		const canonical = fs.realpathSync(real);
		expect(tracker.paths()).toEqual([canonical]);
	});
});

describe("check", () => {
	test("returns null when the path was recorded and the file is unchanged", () => {
		const tracker = new ReadTracker();
		const file = writeFile("a.txt", "x");
		tracker.record(file);
		expect(tracker.check(file)).toBeNull();
	});

	test("blocks with 'Read the file before editing' when path was not recorded but exists", () => {
		const tracker = new ReadTracker();
		const file = writeFile("a.txt", "x");
		const result = tracker.check(file);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/Read the file before editing/);
	});

	test("returns null for a path that does not exist on disk (allows new-file writes)", () => {
		const tracker = new ReadTracker();
		const nonexistent = path.join(tmp, "new-file.txt");
		expect(tracker.check(nonexistent)).toBeNull();
	});

	test("blocks with 'modified since you read it' when size differs after read", () => {
		const tracker = new ReadTracker();
		const file = writeFile("a.txt", "hello");
		tracker.record(file);
		fs.writeFileSync(file, "hello world", "utf-8"); // size changes 5 → 11
		const result = tracker.check(file);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/modified since you read it/);
	});

	test("blocks when mtime advances even if size is preserved", () => {
		const tracker = new ReadTracker();
		const file = writeFile("a.txt", "hello");
		tracker.record(file);
		// Bump mtime explicitly; keep contents the same length.
		const future = new Date(Date.now() + 60_000);
		fs.utimesSync(file, future, future);
		const result = tracker.check(file);
		expect(result?.block).toBe(true);
	});
});

describe("refresh", () => {
	test("updates the entry to current stat (allows consecutive edits)", () => {
		const tracker = new ReadTracker();
		const file = writeFile("a.txt", "hello");
		tracker.record(file);
		const canonical = fs.realpathSync(file);
		const before = tracker.entry(canonical);

		// Simulate an edit: file grows, mtime advances.
		fs.writeFileSync(file, "hello world", "utf-8");
		tracker.refresh(file);

		const after = tracker.entry(canonical);
		expect(after?.size).toBe(11);
		expect(after?.modifiedAt).toBeGreaterThanOrEqual(before?.modifiedAt ?? 0);
		expect(tracker.check(file)).toBeNull();
	});
});

describe("clear", () => {
	test("empties the log", () => {
		const tracker = new ReadTracker();
		const a = writeFile("a.txt", "x");
		const b = writeFile("b.txt", "y");
		tracker.record(a);
		tracker.record(b);
		expect(tracker.paths()).toHaveLength(2);
		tracker.clear();
		expect(tracker.paths()).toHaveLength(0);
	});
});

describe("prune (sliding turn window)", () => {
	test("keeps a read within the window, evicts it once it ages out", () => {
		// Window of 2: a read on turn 0 survives the first prune (turn → 1)
		// and is evicted on the second (turn → 2, cutoff 0).
		const tracker = new ReadTracker(2);
		const file = writeFile("a.txt", "x");
		tracker.record(file);
		expect(tracker.paths()).toHaveLength(1);

		tracker.prune(); // turn 1
		expect(tracker.paths()).toHaveLength(1);

		tracker.prune(); // turn 2 → evict
		expect(tracker.paths()).toHaveLength(0);
	});

	test("default window keeps a read across several turns", () => {
		const tracker = new ReadTracker(); // default window 4
		const file = writeFile("a.txt", "x");
		tracker.record(file);

		// Read on turn 0 survives prunes 1, 2, 3; evicted on the 4th.
		tracker.prune();
		tracker.prune();
		tracker.prune();
		expect(tracker.paths()).toHaveLength(1);

		tracker.prune();
		expect(tracker.paths()).toHaveLength(0);
	});

	test("a fresh read after pruning resets that path's window", () => {
		const tracker = new ReadTracker(2);
		const file = writeFile("a.txt", "x");
		tracker.record(file); // turn 0

		tracker.prune(); // turn 1
		tracker.record(file); // re-read, now stamped turn 1
		tracker.prune(); // turn 2, cutoff 0 → turn-1 entry survives
		expect(tracker.paths()).toHaveLength(1);

		tracker.prune(); // turn 3, cutoff 1 → turn-1 entry evicted
		expect(tracker.paths()).toHaveLength(0);
	});

	test("prune before any read is a no-op (no underflow eviction)", () => {
		const tracker = new ReadTracker(4);
		tracker.prune();
		tracker.prune();
		const file = writeFile("a.txt", "x");
		tracker.record(file);
		expect(tracker.paths()).toHaveLength(1);
	});

	test("check() still blocks edits to a file changed since an in-window read", () => {
		// The wider window must not weaken read-before-write: a surviving
		// entry is still revalidated by mtime/size on every check.
		const tracker = new ReadTracker(4);
		const file = writeFile("a.txt", "hello");
		tracker.record(file);
		tracker.prune(); // still in window
		fs.writeFileSync(file, "hello world", "utf-8"); // size changes
		const result = tracker.check(file);
		expect(result?.block).toBe(true);
		expect(result?.reason).toMatch(/modified since you read it/);
	});
});

describe("recentPaths", () => {
	test("returns canonical paths still inside the window", () => {
		const tracker = new ReadTracker(2);
		const a = writeFile("a.txt", "x");
		const b = writeFile("b.txt", "y");
		tracker.record(a);
		tracker.record(b);
		const canonicalA = fs.realpathSync(a);
		const canonicalB = fs.realpathSync(b);
		expect([...tracker.recentPaths()].sort()).toEqual(
			[canonicalA, canonicalB].sort(),
		);
	});

	test("drops paths that have aged out of the window", () => {
		const tracker = new ReadTracker(2);
		const a = writeFile("a.txt", "x");
		tracker.record(a);
		tracker.prune();
		tracker.prune(); // evicts turn-0 read
		expect(tracker.recentPaths()).toHaveLength(0);
	});
});

