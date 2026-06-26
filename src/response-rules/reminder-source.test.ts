import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	__clearCacheForTests,
	loadResponseReminder,
	responseReminderFileExists,
} from "./reminder-source.ts";

// Two scratch dirs per test: one acts as the project (cwd) and one acts as
// the agent dir (via PI_CODING_AGENT_DIR override).
let cwd: string;
let agent: string;
let prevEnv: string | undefined;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bc-reminder-cwd-"));
	agent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bc-reminder-agent-"));
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

const FILENAME = "response-rules-reminder.md";

function writeCwd(body: string): void {
	fs.writeFileSync(path.join(cwd, FILENAME), body, "utf-8");
}

function writeMaster(body: string): void {
	fs.writeFileSync(path.join(agent, FILENAME), body, "utf-8");
}

describe("loadResponseReminder", () => {
	test("returns null when neither cwd nor master file exists", () => {
		expect(loadResponseReminder(cwd)).toBeNull();
	});

	test("returns cwd reminder when only cwd file exists", () => {
		writeCwd("be concise");
		const r = loadResponseReminder(cwd);
		expect(r?.source).toBe("cwd");
		expect(r?.text).toBe("be concise");
		expect(r?.path).toBe(path.join(cwd, FILENAME));
	});

	test("returns master reminder when only master file exists", () => {
		writeMaster("global rules");
		const r = loadResponseReminder(cwd);
		expect(r?.source).toBe("master");
		expect(r?.text).toBe("global rules");
		expect(r?.path).toBe(path.join(agent, FILENAME));
	});

	test("cwd wins when both files exist", () => {
		writeCwd("project rules");
		writeMaster("global rules");
		const r = loadResponseReminder(cwd);
		expect(r?.source).toBe("cwd");
		expect(r?.text).toBe("project rules");
	});

	test("an empty cwd file resolves to null (nothing to inject)", () => {
		writeCwd("");
		expect(loadResponseReminder(cwd)).toBeNull();
	});

	test("a whitespace-only file resolves to null", () => {
		writeCwd("   \n\t  \n");
		expect(loadResponseReminder(cwd)).toBeNull();
	});

	test("an empty cwd file does not shadow a non-empty master file", () => {
		// cwd is empty -> null; resolution must continue to master.
		writeCwd("   ");
		writeMaster("global rules");
		const r = loadResponseReminder(cwd);
		expect(r?.source).toBe("master");
		expect(r?.text).toBe("global rules");
	});

	test("a file added after a previous null result is picked up next call", () => {
		expect(loadResponseReminder(cwd)).toBeNull();
		writeCwd("now present");
		expect(loadResponseReminder(cwd)?.text).toBe("now present");
	});

	test("cache hit returns the same text without re-reading from disk", () => {
		const file = path.join(cwd, FILENAME);
		fs.writeFileSync(file, "v1", "utf-8");
		expect(loadResponseReminder(cwd)?.text).toBe("v1");

		// Rewrite identical bytes so size is unchanged, then force mtime back to
		// the original so the (mtime, size) fingerprint matches the cached one.
		// A clean cache hit must return the cached text without re-reading.
		fs.writeFileSync(file, "v1", "utf-8");
		const mtime = fs.statSync(file).mtimeMs;
		fs.utimesSync(file, new Date(mtime), new Date(mtime));
		expect(loadResponseReminder(cwd)?.text).toBe("v1");
	});

	test("cache miss re-reads when file content + size change", () => {
		writeCwd("short");
		expect(loadResponseReminder(cwd)?.text).toBe("short");
		writeCwd("a much longer body than before");
		expect(loadResponseReminder(cwd)?.text).toBe("a much longer body than before");
	});

	test("removing the cwd file falls back to master on the next call", () => {
		writeCwd("project rules");
		writeMaster("global rules");
		expect(loadResponseReminder(cwd)?.source).toBe("cwd");
		fs.rmSync(path.join(cwd, FILENAME));
		const r = loadResponseReminder(cwd);
		expect(r?.source).toBe("master");
		expect(r?.text).toBe("global rules");
	});

	test("rejects a directory named response-rules-reminder.md", () => {
		fs.mkdirSync(path.join(cwd, FILENAME));
		expect(loadResponseReminder(cwd)).toBeNull();
	});
});

describe("responseReminderFileExists", () => {
	test("returns false when neither candidate path exists", () => {
		expect(responseReminderFileExists(cwd)).toBe(false);
	});

	test("returns true when only the cwd file exists, even if empty", () => {
		writeCwd("");
		// Loader returns null (nullIfEmpty), but existence check is purely
		// filesystem-based -- this is the key contract that keeps the
		// missing-file dialog from re-firing after the user creates an
		// empty file via "Create empty file at cwd".
		expect(loadResponseReminder(cwd)).toBeNull();
		expect(responseReminderFileExists(cwd)).toBe(true);
	});

	test("returns true when only the master file exists, even if empty", () => {
		writeMaster("");
		expect(loadResponseReminder(cwd)).toBeNull();
		expect(responseReminderFileExists(cwd)).toBe(true);
	});

	test("returns true when a populated file exists at either path", () => {
		writeCwd("be concise");
		expect(responseReminderFileExists(cwd)).toBe(true);
	});

	test("returns false when the cwd path is a directory, not a regular file", () => {
		// Mirrors loadResponseReminder's rejection of non-file inodes --
		// existence on its own is not enough; it must be a regular file
		// the loader could read.
		fs.mkdirSync(path.join(cwd, FILENAME));
		expect(responseReminderFileExists(cwd)).toBe(false);
	});
});
