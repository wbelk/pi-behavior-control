import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { loadConfig, saveConfig, type VerifierChoice } from "../session/user-config.ts";
import {
	type ChooseVerifierResult,
	chooseVerifier,
	resolveVerifier,
} from "./verifier-source.ts";

// Stub state captured between tests so we can assert on which options the
// selector was offered and what the user "picked".
interface StubUI {
	hasUI: boolean;
	selectResult: string | undefined;
	selectCalls: { title: string; options: string[] }[];
	availableModels?: { provider: string; id: string }[];
}

// Minimal ExtensionContext shape — only the fields chooseVerifier reads.
// `as unknown as ExtensionContext` at the call site is the documented
// stub boundary.
function makeCtx(stub: StubUI) {
	return {
		hasUI: stub.hasUI,
		ui: {
			select: (title: string, options: string[]) => {
				stub.selectCalls.push({ title, options });
				return Promise.resolve(stub.selectResult);
			},
		},
		modelRegistry: {
			getAvailable: () => stub.availableModels ?? [],
		},
	};
}

function callChoose(stub: StubUI): Promise<ChooseVerifierResult> {
	// `as unknown as ExtensionContext` — test-stub boundary.
	return chooseVerifier(makeCtx(stub) as unknown as ExtensionContext);
}

let tmp: string;
let prevEnvAgent: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-behavior-control-vs-"));
	prevEnvAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmp;
});

afterEach(() => {
	if (prevEnvAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevEnvAgent;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("resolveVerifier", () => {

	test("returns persisted verifier when env unset", () => {
		const persisted: VerifierChoice = { provider: "anthropic", id: "claude-sonnet-4-5" };
		saveConfig({ verifier: persisted });
		expect(resolveVerifier()).toEqual(persisted);
	});

	test("returns 'session-model' when persisted as that string", () => {
		saveConfig({ verifier: "session-model" });
		expect(resolveVerifier()).toBe("session-model");
	});

	test("returns Haiku 4.5 default when env unset and no persisted config", () => {
		expect(resolveVerifier()).toEqual({
			provider: "anthropic",
			id: "claude-haiku-4-5",
		});
	});
});

describe("chooseVerifier", () => {

	test("headless with no persisted config: returns default and persists it", async () => {
		const stub: StubUI = { hasUI: false, selectResult: undefined, selectCalls: [] };
		const result = await callChoose(stub);
		expect(result.choice).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
		expect(result.persisted).toBe(true);
		expect(stub.selectCalls).toHaveLength(0);
		expect(loadConfig()).toEqual({
			verifier: { provider: "anthropic", id: "claude-haiku-4-5" },
		});
	});

	test("headless with persisted: returns persisted, no overwrite", async () => {
		const persisted: VerifierChoice = { provider: "anthropic", id: "claude-sonnet-4-5" };
		saveConfig({ verifier: persisted });
		const stub: StubUI = { hasUI: false, selectResult: undefined, selectCalls: [] };
		const result = await callChoose(stub);
		expect(result.choice).toEqual(persisted);
		expect(result.persisted).toBe(false);
	});

	test("interactive new choice: selector lists Haiku first; persists user choice", async () => {
		const stub: StubUI = {
			hasUI: true,
			selectResult: "anthropic/claude-sonnet-4-5",
			selectCalls: [],
			availableModels: [
				{ provider: "anthropic", id: "claude-haiku-4-5" },
				{ provider: "anthropic", id: "claude-sonnet-4-5" },
			],
		};
		const result = await callChoose(stub);
		expect(result.choice).toEqual({ provider: "anthropic", id: "claude-sonnet-4-5" });
		expect(result.persisted).toBe(true);
		expect(stub.selectCalls).toHaveLength(1);
		// Haiku (the default verifier) is the previous implicit choice on
		// first run, so when it's available it floats to position 0.
		expect(stub.selectCalls[0]?.options[0]).toBe("anthropic/claude-haiku-4-5");
		expect(loadConfig()).toEqual({
			verifier: { provider: "anthropic", id: "claude-sonnet-4-5" },
		});
	});

	test("interactive same-as-previous: no persistence (no rewrite)", async () => {
		saveConfig({ verifier: { provider: "anthropic", id: "claude-haiku-4-5" } });
		const stub: StubUI = {
			hasUI: true,
			selectResult: "anthropic/claude-haiku-4-5",
			selectCalls: [],
			availableModels: [{ provider: "anthropic", id: "claude-haiku-4-5" }],
		};
		const result = await callChoose(stub);
		expect(result.choice).toEqual({ provider: "anthropic", id: "claude-haiku-4-5" });
		expect(result.persisted).toBe(false);
	});

	test("interactive with persisted Sonnet: selector lists Sonnet first", async () => {
		saveConfig({ verifier: { provider: "anthropic", id: "claude-sonnet-4-5" } });
		const stub: StubUI = {
			hasUI: true,
			selectResult: undefined,
			selectCalls: [],
			availableModels: [
				{ provider: "anthropic", id: "claude-haiku-4-5" },
				{ provider: "anthropic", id: "claude-sonnet-4-5" },
			],
		};
		await callChoose(stub);
		expect(stub.selectCalls[0]?.options[0]).toBe("anthropic/claude-sonnet-4-5");
	});

	test("registry models appear in the selector", async () => {
		const stub: StubUI = {
			hasUI: true,
			selectResult: undefined,
			selectCalls: [],
			availableModels: [
				{ provider: "openai", id: "gpt-4" },
				{ provider: "anthropic", id: "claude-haiku-4-5" },
				{ provider: "anthropic", id: "claude-sonnet-4-5" },
			],
		};
		await callChoose(stub);
		const options = stub.selectCalls[0]?.options ?? [];
		expect(options).toContain("openai/gpt-4");
		expect(options).toContain("anthropic/claude-haiku-4-5");
		expect(options).toContain("anthropic/claude-sonnet-4-5");
		expect(options[options.length - 1]).toBe("Use current session model");
	});

	test("previously-persisted model that's no longer available is hidden", async () => {
		saveConfig({ verifier: { provider: "deprecated", id: "old-model" } });
		const stub: StubUI = {
			hasUI: true,
			selectResult: undefined,
			selectCalls: [],
			availableModels: [{ provider: "anthropic", id: "claude-haiku-4-5" }],
		};
		await callChoose(stub);
		const options = stub.selectCalls[0]?.options ?? [];
		// Unavailable persisted choice is no longer surfaced; only the
		// available model and the session-model sentinel appear.
		expect(options).not.toContain("deprecated/old-model");
		expect(options).toEqual([
			"anthropic/claude-haiku-4-5",
			"Use current session model",
		]);
	});

	test("default Haiku is hidden when anthropic auth is unavailable", async () => {
		// No persisted config → previous defaults to Haiku, but Haiku is
		// absent from the available list, so it must not be surfaced.
		const stub: StubUI = {
			hasUI: true,
			selectResult: undefined,
			selectCalls: [],
			availableModels: [{ provider: "openai", id: "gpt-4" }],
		};
		await callChoose(stub);
		const options = stub.selectCalls[0]?.options ?? [];
		expect(options).not.toContain("anthropic/claude-haiku-4-5");
		expect(options).toEqual(["openai/gpt-4", "Use current session model"]);
	});

	test("empty registry: only the session-model option is offered", async () => {
		const stub: StubUI = {
			hasUI: true,
			selectResult: undefined,
			selectCalls: [],
			availableModels: [],
		};
		await callChoose(stub);
		expect(stub.selectCalls[0]?.options).toEqual(["Use current session model"]);
	});

	test("interactive cancelled (undefined): keeps previous, persisted=false", async () => {
		const original: VerifierChoice = { provider: "anthropic", id: "claude-sonnet-4-5" };
		saveConfig({ verifier: original });
		const stub: StubUI = {
			hasUI: true,
			selectResult: undefined,
			selectCalls: [],
			availableModels: [{ provider: "anthropic", id: "claude-sonnet-4-5" }],
		};
		const result = await callChoose(stub);
		expect(result.choice).toEqual(original);
		expect(result.persisted).toBe(false);
		expect(loadConfig()).toEqual({ verifier: original });
	});

	test("interactive cancelled with unavailable previous: falls back to session-model", async () => {
		// Persisted pick lost auth (absent from availableModels). Cancelling
		// must not strand the user on a verifier that only errors — it falls
		// back to the always-valid session model and persists that.
		saveConfig({ verifier: { provider: "deprecated", id: "old-model" } });
		const stub: StubUI = {
			hasUI: true,
			selectResult: undefined,
			selectCalls: [],
			availableModels: [{ provider: "anthropic", id: "claude-haiku-4-5" }],
		};
		const result = await callChoose(stub);
		expect(result.choice).toBe("session-model");
		expect(result.persisted).toBe(true);
		expect(loadConfig()).toEqual({ verifier: "session-model" });
	});

	test("interactive 'use session model' choice persists as the string sentinel", async () => {
		const stub: StubUI = {
			hasUI: true,
			selectResult: "Use current session model",
			selectCalls: [],
		};
		const result = await callChoose(stub);
		expect(result.choice).toBe("session-model");
		expect(result.persisted).toBe(true);
		expect(loadConfig()).toEqual({ verifier: "session-model" });
	});
});
