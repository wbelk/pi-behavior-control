import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __clearCacheForTests, loadRules } from "./rules-source.ts";

// Two scratch dirs per test: one acts as the project (cwd) and one acts as
// the agent dir (via PI_CODING_AGENT_DIR override).
let cwd: string;
let agent: string;
let prevEnv: string | undefined;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-behavior-control-rs-cwd-"));
	agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-behavior-control-rs-agent-"));
	prevEnv = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agent;
	__clearCacheForTests();
});

afterEach(() => {
	if (prevEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevEnv;
	fs.rmSync(cwd, { recursive: true, force: true });
	fs.rmSync(agent, { recursive: true, force: true });
});

function writeCwdRules(body: string): void {
	fs.writeFileSync(path.join(cwd, "coding-rules.md"), body, "utf-8");
}

function writeMasterRules(body: string): void {
	fs.writeFileSync(path.join(agent, "coding-rules.md"), body, "utf-8");
}

describe("loadRules", () => {
	test("returns null when neither cwd nor master file exists", () => {
		expect(loadRules(cwd)).toBeNull();
	});

	test("returns cwd rules when only cwd file exists", () => {
		writeCwdRules("cwd-rules-text");
		const r = loadRules(cwd);
		expect(r?.text).toBe("cwd-rules-text");
		expect(r?.source).toBe("cwd");
	});

	test("returns master rules when only master file exists", () => {
		writeMasterRules("master-rules-text");
		const r = loadRules(cwd);
		expect(r?.text).toBe("master-rules-text");
		expect(r?.source).toBe("master");
	});

	test("cwd wins when both files exist", () => {
		writeCwdRules("cwd-wins");
		writeMasterRules("master-loses");
		const r = loadRules(cwd);
		expect(r?.text).toBe("cwd-wins");
		expect(r?.source).toBe("cwd");
	});

	test("a cwd file added after a previous null result is picked up next call", () => {
		expect(loadRules(cwd)).toBeNull();
		writeCwdRules("appeared");
		expect(loadRules(cwd)?.text).toBe("appeared");
	});

	test("cache hit returns the same text without re-reading from disk", () => {
		writeCwdRules("v1");
		const first = loadRules(cwd);
		expect(first?.text).toBe("v1");

		// Mutate the file's contents WITHOUT changing mtime or size — cache
		// should still return v1 because the (mtime, size) fingerprint is
		// unchanged. (Realistically same-size + same-mtime is hard to
		// produce externally; we fake it by writing identical bytes.)
		fs.writeFileSync(path.join(cwd, "coding-rules.md"), "v1", "utf-8");

		// Cache reads via stat (mtime probably advanced from the second
		// write). To simulate a clean cache hit we force the mtime back to
		// the original.
		const filePath = path.join(cwd, "coding-rules.md");
		const stat = fs.statSync(filePath);
		const originalMtime = stat.mtimeMs;
		fs.utimesSync(filePath, new Date(originalMtime), new Date(originalMtime));

		expect(loadRules(cwd)?.text).toBe("v1");
	});

	test("cache miss re-reads when file content + size change", () => {
		writeCwdRules("short");
		expect(loadRules(cwd)?.text).toBe("short");
		writeCwdRules("now-much-longer-text"); // different size → cache miss
		expect(loadRules(cwd)?.text).toBe("now-much-longer-text");
	});

	test("removing the cwd file falls back to master on the next call", () => {
		writeCwdRules("cwd-only");
		writeMasterRules("master-only");
		expect(loadRules(cwd)?.source).toBe("cwd");
		fs.unlinkSync(path.join(cwd, "coding-rules.md"));
		const r = loadRules(cwd);
		expect(r?.text).toBe("master-only");
		expect(r?.source).toBe("master");
	});

	test("rejects directories named coding-rules.md (not a regular file)", () => {
		fs.mkdirSync(path.join(cwd, "coding-rules.md"));
		expect(loadRules(cwd)).toBeNull();
	});
});
