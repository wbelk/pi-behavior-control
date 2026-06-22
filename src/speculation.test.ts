import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Mock @earendil-works/pi-ai before the speculation module loads. Bun's
// mock.module hoists in test files so this takes effect for the import
// below.
const completeMock = mock(
	async (_model: unknown, _ctx: unknown, _opts: unknown) =>
		({
			content: [{ type: "text", text: '{"ok":true}' }],
		}) as { content: { type: string; text?: string }[] },
);
const getModelMock: ReturnType<typeof mock<
	(_provider: unknown, _id: unknown) => { provider: string; id: string } | undefined
>> = mock((_provider: unknown, _id: unknown) => ({
	provider: "anthropic",
	id: "claude-haiku-4-5",
}));
mock.module("@earendil-works/pi-ai", () => ({
	complete: completeMock,
	getModel: getModelMock,
}));

// Imports after the mock are wired through to the mocked module.
import {
	buildEvidenceBlock,
	buildRecentInspectionsBlock,
	extractLastAssistantText,
	parseVerdict,
	runSpeculationCheck,
} from "./speculation.ts";
import { createSessionState } from "./session-state.ts";

// =============================================================================
// Pure functions — no mocking required
// =============================================================================

describe("extractLastAssistantText", () => {
	test("returns empty string for empty messages", () => {
		expect(
			extractLastAssistantText(
				[] as unknown as AgentEndEvent["messages"],
			),
		).toBe("");
	});

	test("returns empty string when no assistant message has text content", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hi" }] },
			{ role: "assistant", content: [{ type: "tool_use", id: "x" }] },
		] as unknown as AgentEndEvent["messages"];
		expect(extractLastAssistantText(messages)).toBe("");
	});

	test("returns text of the last assistant message", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "q1" }] },
			{ role: "assistant", content: [{ type: "text", text: "a1" }] },
			{ role: "user", content: [{ type: "text", text: "q2" }] },
			{ role: "assistant", content: [{ type: "text", text: "a2" }] },
		] as unknown as AgentEndEvent["messages"];
		expect(extractLastAssistantText(messages)).toBe("a2");
	});

	test("joins multiple text blocks with newlines", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "first" },
					{ type: "text", text: "second" },
				],
			},
		] as unknown as AgentEndEvent["messages"];
		expect(extractLastAssistantText(messages)).toBe("first\nsecond");
	});

	test("ignores non-text content blocks within the assistant message", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "tool_use", id: "x" },
					{ type: "text", text: "only-text" },
					{ type: "image", source: "..." },
				],
			},
		] as unknown as AgentEndEvent["messages"];
		expect(extractLastAssistantText(messages)).toBe("only-text");
	});
});

describe("parseVerdict", () => {
	test("parses raw {ok: true}", () => {
		expect(parseVerdict('{"ok":true}')).toEqual({ ok: true });
	});

	test("parses raw {ok: false, reason}", () => {
		expect(parseVerdict('{"ok":false,"reason":"hedge words used"}')).toEqual({
			ok: false,
			reason: "hedge words used",
		});
	});

	test("extracts JSON from markdown code fences", () => {
		const text = '```json\n{"ok":false,"reason":"x"}\n```';
		expect(parseVerdict(text)).toEqual({ ok: false, reason: "x" });
	});

	test("extracts JSON from surrounding prose", () => {
		const text = 'Here is my verdict: {"ok":true} — let me know if you need more.';
		expect(parseVerdict(text)).toEqual({ ok: true });
	});

	test("returns null when ok is not a boolean", () => {
		expect(parseVerdict('{"ok":"yes"}')).toBeNull();
	});

	test("returns null when reason is not a string", () => {
		expect(parseVerdict('{"ok":false,"reason":42}')).toBeNull();
	});

	test("returns null for non-JSON garbage", () => {
		expect(parseVerdict("just some prose")).toBeNull();
	});

	test("returns null for empty string", () => {
		expect(parseVerdict("")).toBeNull();
	});
});

describe("buildEvidenceBlock", () => {
	test("returns the sentinel when there are no recent calls", () => {
		expect(buildEvidenceBlock([])).toBe("(no recent tool calls)");
	});

	test("wraps numbered call descriptors in a <TOOL_CALLS> block", () => {
		const out = buildEvidenceBlock(["read src/foo.ts", "grep parseConfig"]);
		expect(out).toContain("<TOOL_CALLS>");
		expect(out).toContain("[1] read src/foo.ts");
		expect(out).toContain("[2] grep parseConfig");
		expect(out).toContain("</TOOL_CALLS>");
		// Tool output is never part of the descriptor set.
		expect(out).not.toContain("<TOOL_RESULTS>");
	});

	test("numbers descriptors in the order given", () => {
		const out = buildEvidenceBlock(["read a.ts", "bash bun test"]);
		expect(out.indexOf("[1] read a.ts")).toBeLessThan(
			out.indexOf("[2] bash bun test"),
		);
	});

	test("keeps the most recent when over the cap, renumbering from 1", () => {
		const calls = Array.from({ length: 60 }, (_v, i) => `read f${i}.ts`);
		const out = buildEvidenceBlock(calls);
		const numbered = out.split("\n").filter((line) => line.startsWith("["));
		// Capped at MAX_RECENT_CALLS (50); the oldest 10 are dropped.
		expect(numbered).toHaveLength(50);
		expect(out).toContain("[1] read f10.ts");
		expect(out).toContain("[50] read f59.ts");
		expect(out).not.toContain("read f9.ts");
	});
});

describe("buildRecentInspectionsBlock", () => {
	test("returns the empty sentinel when no paths are given", () => {
		expect(buildRecentInspectionsBlock([], "/work")).toBe(
			"(no recent inspections)",
		);
	});

	test("renders in-cwd paths relative and wraps them in <RECENT_INSPECTIONS>", () => {
		const out = buildRecentInspectionsBlock(
			["/work/src/a.ts", "/work/b.ts"],
			"/work",
		);
		expect(out).toContain("<RECENT_INSPECTIONS>");
		expect(out).toContain("</RECENT_INSPECTIONS>");
		expect(out).toContain("- src/a.ts");
		expect(out).toContain("- b.ts");
	});

	test("keeps out-of-cwd paths absolute", () => {
		const out = buildRecentInspectionsBlock(["/elsewhere/c.ts"], "/work");
		// `path.relative` would yield a `..`-prefixed path; we keep absolute.
		expect(out).toContain("- /elsewhere/c.ts");
		expect(out).not.toContain("..");
	});

	test("caps the list at MAX_RECENT_INSPECTIONS, keeping the most recent (tail)", () => {
		const paths = Array.from({ length: 60 }, (_unused, i) => `/work/f${i}.ts`);
		const out = buildRecentInspectionsBlock(paths, "/work");
		const lines = out.split("\n").filter((l: string) => l.startsWith("- "));
		expect(lines).toHaveLength(50);
		// Tail kept: last path present, an early one dropped.
		expect(out).toContain("- f59.ts");
		expect(out).not.toContain("- f0.ts");
	});
});

// =============================================================================
// runSpeculationCheck — with mocked @earendil-works/pi-ai
// =============================================================================

interface FakeUI {
	notifyCalls: { message: string; type: string | undefined }[];
}

interface FakeRegistry {
	authResult: { ok: boolean; apiKey?: string; headers?: Record<string, string> };
	findModel?: { provider: string; id: string };
	availableModels?: { provider: string; id: string }[];
	allModels?: { provider: string; id: string }[];
}

interface FakePi {
	sendMessageCalls: {
		message: unknown;
		options: unknown;
	}[];
}

function makeCtx(opts: {
	hasUI: boolean;
	ui: FakeUI;
	registry: FakeRegistry;
	signal?: AbortSignal;
	cwd?: string;
}) {
	return {
		hasUI: opts.hasUI,
		signal: opts.signal,
		cwd: opts.cwd ?? "/work",
		ui: {
			notify: (message: string, type?: string) => {
				opts.ui.notifyCalls.push({ message, type });
			},
		},
		model: { provider: "anthropic", id: "claude-haiku-4-5" },
		modelRegistry: {
			getApiKeyAndHeaders: () => Promise.resolve(opts.registry.authResult),
			find: (provider: string, id: string) => {
				const model = opts.registry.findModel;
				if (model?.provider === provider && model.id === id) return model;
				return undefined;
			},
			getAvailable: () => opts.registry.availableModels ?? [],
			getAll: () => opts.registry.allModels ?? [],
		},
	};
}

function makePi(fake: FakePi) {
	return {
		sendMessage: (message: unknown, options: unknown) => {
			fake.sendMessageCalls.push({ message, options });
		},
	};
}

function makeEvent(assistantText: string): AgentEndEvent {
	const messages = [
		{ role: "assistant", content: [{ type: "text", text: assistantText }] },
	] as unknown as AgentEndEvent["messages"];
	return { type: "agent_end", messages };
}

// Isolate the persisted-config tmp dir from other tests' state.
let tmp: string;
let prevEnvAgent: string | undefined;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-behavior-control-spec-"));
	prevEnvAgent = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = tmp;
	completeMock.mockClear();
	getModelMock.mockClear();
	completeMock.mockImplementation(
		async () =>
			({
				content: [{ type: "text", text: '{"ok":true}' }],
			}) as { content: { type: string; text?: string }[] },
	);
	getModelMock.mockImplementation(() => ({
		provider: "anthropic",
		id: "claude-haiku-4-5",
	}));
});

afterEach(() => {
	if (prevEnvAgent === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = prevEnvAgent;
	fs.rmSync(tmp, { recursive: true, force: true });
});

describe("runSpeculationCheck", () => {
	test("does nothing when session is disabled", async () => {
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState(); // enabled === false by default

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext,
			makeEvent("some response"),
			state,
		);

		expect(completeMock).not.toHaveBeenCalled();
		expect(pi.sendMessageCalls).toHaveLength(0);
	});

	test("does nothing in one-shot modes (hasUI === false)", async () => {
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: false, ui, registry }) as unknown as ExtensionContext,
			makeEvent("some response"),
			state,
		);

		expect(completeMock).not.toHaveBeenCalled();
		expect(pi.sendMessageCalls).toHaveLength(0);
	});

	test("does nothing when last assistant message is empty", async () => {
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext,
			makeEvent(""),
			state,
		);

		expect(completeMock).not.toHaveBeenCalled();
		expect(pi.sendMessageCalls).toHaveLength(0);
	});

	test("passes static SYSTEM prompt + user message with response and evidence sections", async () => {
		let capturedCtx: { systemPrompt?: string; messages: { content: { type: string; text?: string }[] }[] } | undefined;
		completeMock.mockImplementation(async (_model, ctx) => {
			capturedCtx = ctx as typeof capturedCtx;
			return {
				content: [{ type: "text", text: '{"ok":true}' }],
			} as { content: { type: string; text?: string }[] };
		});
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "text", text: "opening src/foo.ts" },
					{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "src/foo.ts" } },
				],
			},
			{
				role: "toolResult",
				toolCallId: "call-1",
				toolName: "read",
				isError: false,
				content: [{ type: "text", text: "export const FOO = 42;" }],
			},
			{ role: "assistant", content: [{ type: "text", text: "final answer" }] },
		] as unknown as AgentEndEvent["messages"];

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext,
			{ type: "agent_end", messages },
			state,
			{ recentCalls: ["read src/foo.ts"] },
		);

		expect(capturedCtx).toBeDefined();
		// Rubric is in systemPrompt, not the user message.
		expect(capturedCtx?.systemPrompt).toBeDefined();
		expect(capturedCtx?.systemPrompt).toContain("fact-check verifier");
		expect(capturedCtx?.systemPrompt).toContain("<TOOL_CALLS>");
		expect(capturedCtx?.systemPrompt).not.toContain("<TOOL_RESULTS>");
		expect(capturedCtx?.systemPrompt).toContain('{"ok": true}');

		// User message contains the assistant response and the evidence block.
		const userText = capturedCtx?.messages[0]?.content[0]?.text ?? "";
		expect(userText).toContain("<ASSISTANT_RESPONSE>");
		expect(userText).toContain("final answer");
		expect(userText).toContain("</ASSISTANT_RESPONSE>");
		expect(userText).toContain("<TOOL_CALLS>");
		expect(userText).toContain("[1] read");
		expect(userText).toContain("[1] read src/foo.ts");
		// Tool output is not sent — calls-only summary.
		expect(userText).not.toContain("<TOOL_RESULTS>");
		expect(userText).not.toContain("export const FOO = 42;");
		// Recent-inspections section is present; empty form when no paths wired.
		expect(capturedCtx?.systemPrompt).toContain("<RECENT_INSPECTIONS>");
		expect(userText).toContain("(no recent inspections)");
	});

	test("surfaces recentPaths as a <RECENT_INSPECTIONS> block in the user message", async () => {
		let capturedCtx:
			| { systemPrompt?: string; messages: { content: { type: string; text?: string }[] }[] }
			| undefined;
		completeMock.mockImplementation(async (_model, ctx) => {
			capturedCtx = ctx as typeof capturedCtx;
			return {
				content: [{ type: "text", text: '{"ok":true}' }],
			} as { content: { type: string; text?: string }[] };
		});
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		// Caller pre-unions read + inspection paths. The in-cwd path should
		// render relative; the out-of-cwd one stays absolute.
		const recentPaths = ["/work/src/api.ts", "/other/lib.ts"];

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: true, ui, registry, cwd: "/work" }) as unknown as ExtensionContext,
			makeEvent("the api.ts handler validates the token"),
			state,
			{ recentPaths },
		);

		const userText = capturedCtx?.messages[0]?.content[0]?.text ?? "";
		expect(userText).toContain("<RECENT_INSPECTIONS>");
		expect(userText).toContain("</RECENT_INSPECTIONS>");
		// In-cwd path is relative; out-of-cwd path stays absolute.
		expect(userText).toContain("- src/api.ts");
		expect(userText).toContain("- /other/lib.ts");
		expect(userText).not.toContain("(no recent inspections)");
	});

	test("surfaces recentCalls as a <TOOL_CALLS> block in the user message", async () => {
		let capturedCtx:
			| { systemPrompt?: string; messages: { content: { type: string; text?: string }[] }[] }
			| undefined;
		completeMock.mockImplementation(async (_model, ctx) => {
			capturedCtx = ctx as typeof capturedCtx;
			return {
				content: [{ type: "text", text: '{"ok":true}' }],
			} as { content: { type: string; text?: string }[] };
		});
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext,
			makeEvent("the parseConfig helper validates input"),
			state,
			{ recentCalls: ["read src/config.ts", "grep parseConfig"] },
		);

		const userText = capturedCtx?.messages[0]?.content[0]?.text ?? "";
		expect(userText).toContain("<TOOL_CALLS>");
		expect(userText).toContain("[1] read src/config.ts");
		expect(userText).toContain("[2] grep parseConfig");
		expect(userText).not.toContain("(no recent tool calls)");
	});

	test("verdict {ok: true} → no sendMessage", async () => {
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext,
			makeEvent("This file exists at services/foo.js:42 and does X."),
			state,
		);

		expect(completeMock).toHaveBeenCalledTimes(1);
		expect(pi.sendMessageCalls).toHaveLength(0);
	});

	test("assistant text containing $-substitution metacharacters is passed verbatim", async () => {
		// Regression: `String.replace(pattern, replacement)` interprets $&,
		// $$, $1 etc. in the replacement string even when pattern is a
		// literal. If the agent writes "$&" in its response and we use the
		// raw replace, the prompt sent to the verifier ends up containing
		// "<ASSISTANT_TEXT>" again (the matched substring).
		let capturedPrompt: string | undefined;
		completeMock.mockImplementation(async (_model, ctx) => {
			const messages = (ctx as { messages: { content: { type: string; text?: string }[] }[] }).messages;
			const firstBlock = messages[0]?.content[0];
			capturedPrompt = firstBlock?.text;
			return {
				content: [{ type: "text", text: '{"ok":true}' }],
			} as { content: { type: string; text?: string }[] };
		});
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		const trickyText = "Use regex $& and $1 and $$ characters in $`prose$'";
		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext,
			makeEvent(trickyText),
			state,
		);

		expect(capturedPrompt).toBeDefined();
		expect(capturedPrompt).toContain(trickyText);
		// Specifically: the literal "<ASSISTANT_TEXT>" must NOT appear in
		// the prompt — that would mean $& expanded to the matched template
		// placeholder.
		expect(capturedPrompt).not.toContain("<ASSISTANT_TEXT>");
	});

	test("verdict {ok: false, reason} → sendMessage with reason and followUp delivery", async () => {
		completeMock.mockImplementation(
			async () =>
				({
					content: [
						{ type: "text", text: '{"ok":false,"reason":"hedge words"}' },
					],
				}) as { content: { type: string; text?: string }[] },
		);
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext,
			makeEvent("It probably works that way."),
			state,
		);

		expect(pi.sendMessageCalls).toHaveLength(1);
		const call = pi.sendMessageCalls[0];
		expect((call?.message as { content: string }).content).toBe("hedge words");
		expect((call?.options as { deliverAs?: string }).deliverAs).toBe("followUp");
	});

	test("complete() throws → fires error notify every time", async () => {
		// Model call failures (network, API error, auth rejection) are
		// surfaced loudly — the user needs to know the verifier is
		// broken so they can switch model or disable the plugin.
		completeMock.mockImplementation(async () => {
			throw new Error("boom");
		});
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;
		const ctx = makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext;

		for (let i = 0; i < 3; i++) {
			await runSpeculationCheck(
				makePi(pi) as unknown as ExtensionAPI,
				ctx,
				makeEvent(`response ${i}`),
				state,
			);
		}

		expect(pi.sendMessageCalls).toHaveLength(0);
		expect(ui.notifyCalls).toHaveLength(3);
		for (const call of ui.notifyCalls) {
			expect(call.message).toContain("speculation check failed");
			expect(call.message).toContain("boom");
			expect(call.type).toBe("error");
		}
	});

	test("unexpected error outside the inner try → surfaces via outer-catch notify every time", async () => {
		// Simulate a programming bug / unexpected throw in the outer code
		// (here: getApiKeyAndHeaders throws). The outer surface fires
		// every time the error happens — no dedupe. Rationale: if the
		// speculation check is silently broken, the user needs persistent
		// feedback so they can switch verifier or disable the plugin.
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		const baseCtx = makeCtx({ hasUI: true, ui, registry });
		const buggyCtx = {
			...baseCtx,
			modelRegistry: {
				getApiKeyAndHeaders: () => {
					throw new TypeError("simulated programming bug");
				},
			},
		};

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			buggyCtx as unknown as ExtensionContext,
			makeEvent("some response"),
			state,
		);
		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			buggyCtx as unknown as ExtensionContext,
			makeEvent("another response"),
			state,
		);
		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			buggyCtx as unknown as ExtensionContext,
			makeEvent("a third response"),
			state,
		);

		expect(pi.sendMessageCalls).toHaveLength(0);
		expect(ui.notifyCalls).toHaveLength(3);
		for (const call of ui.notifyCalls) {
			expect(call.message).toContain("speculation check crashed");
			expect(call.message).toContain("simulated programming bug");
			expect(call.type).toBe("error");
		}
	});

	test("configured timeout fires → error notify (our 15s timeout, not user cancel)", async () => {
		// Simulate a model that hangs forever. The internal timeout
		// signal aborts the await. ctx.signal is undefined here, so the
		// catch arm cannot mistake this for a user-cancellation and
		// must surface an error notify.
		completeMock.mockImplementation((_model, _ctx, opts) => {
			const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
			return new Promise((_, reject) => {
				if (!signal) return;
				signal.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
			});
		});
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext,
			makeEvent("some response"),
			state,
			{ timeoutMs: 50 },
		);

		expect(pi.sendMessageCalls).toHaveLength(0);
		expect(ui.notifyCalls).toHaveLength(1);
		const call = ui.notifyCalls[0];
		expect(call?.message).toContain("speculation check failed");
		expect(call?.type).toBe("error");
	});

	test("ctx.signal aborts mid-check → silent (normal lifecycle event)", async () => {
		// When ctx.signal aborts (user cancels turn / new turn starts),
		// the speculation check stays silent — that's a normal pi
		// lifecycle event, not a verifier problem.
		const abortCtrl = new AbortController();
		completeMock.mockImplementation((_model, _ctx, opts) => {
			const signal = (opts as { signal?: AbortSignal } | undefined)?.signal;
			return new Promise((_, reject) => {
				if (!signal) return;
				signal.addEventListener(
					"abort",
					() => reject(new DOMException("aborted", "AbortError")),
					{ once: true },
				);
				// Abort the user's ctx.signal — this propagates into the
				// combined signal handed to complete().
				queueMicrotask(() => abortCtrl.abort());
			});
		});
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		const baseCtx = makeCtx({ hasUI: true, ui, registry });
		const ctxWithSignal = { ...baseCtx, signal: abortCtrl.signal };

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			ctxWithSignal as unknown as ExtensionContext,
			makeEvent("some response"),
			state,
		);

		expect(pi.sendMessageCalls).toHaveLength(0);
		expect(ui.notifyCalls).toHaveLength(0);
	});

	test("session-model picked but ctx.model unavailable → fires error notify every time", async () => {
		const tmpAgent = fs.mkdtempSync(path.join(os.tmpdir(), "pi-spec-sm-"));
		const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
		process.env.PI_CODING_AGENT_DIR = tmpAgent;
		try {
			fs.mkdirSync(path.join(tmpAgent, "behavior-control"), { recursive: true });
			fs.writeFileSync(
				path.join(tmpAgent, "behavior-control", "config.json"),
				JSON.stringify({ verifier: "session-model" }),
				"utf-8",
			);

			const ui: FakeUI = { notifyCalls: [] };
			const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
			const pi: FakePi = { sendMessageCalls: [] };
			const state = createSessionState();
			state.enabled = true;

			const baseCtx = makeCtx({ hasUI: true, ui, registry });
			const ctxWithoutModel = { ...baseCtx, model: undefined };

			for (let i = 0; i < 3; i++) {
				await runSpeculationCheck(
					makePi(pi) as unknown as ExtensionAPI,
					ctxWithoutModel as unknown as ExtensionContext,
					makeEvent(`response ${i}`),
					state,
				);
			}

			expect(completeMock).not.toHaveBeenCalled();
			expect(pi.sendMessageCalls).toHaveLength(0);
			expect(ui.notifyCalls).toHaveLength(3);
			for (const call of ui.notifyCalls) {
				expect(call.message).toContain("use current session model");
				expect(call.type).toBe("error");
			}
		} finally {
			if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
			fs.rmSync(tmpAgent, { recursive: true, force: true });
		}
	});

	test("uses runtime registry model when bundled lookup misses", async () => {
		getModelMock.mockImplementation(() => undefined);
		const registryModel = { provider: "cursor", id: "gpt-5.4-mini-high" };
		let capturedModel: unknown;
		completeMock.mockImplementation(async (model) => {
			capturedModel = model;
			return {
				content: [{ type: "text", text: '{"ok":true}' }],
			} as { content: { type: string; text?: string }[] };
		});
		fs.mkdirSync(path.join(tmp, "behavior-control"), { recursive: true });
		fs.writeFileSync(
			path.join(tmp, "behavior-control", "config.json"),
			JSON.stringify({ verifier: registryModel }),
			"utf-8",
		);
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = {
			authResult: { ok: true, apiKey: "k" },
			findModel: registryModel,
		};
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;
		const ctx = makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext;

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			ctx,
			makeEvent("grounded response"),
			state,
		);

		expect(capturedModel).toBe(registryModel);
		expect(completeMock).toHaveBeenCalledTimes(1);
		expect(ui.notifyCalls).toHaveLength(0);
	});

	test("getModel returns undefined → fires error notify every time", async () => {
		getModelMock.mockImplementation(() => undefined);
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;
		const ctx = makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext;

		for (let i = 0; i < 3; i++) {
			await runSpeculationCheck(
				makePi(pi) as unknown as ExtensionAPI,
				ctx,
				makeEvent(`response ${i}`),
				state,
			);
		}

		expect(completeMock).not.toHaveBeenCalled();
		expect(pi.sendMessageCalls).toHaveLength(0);
		expect(ui.notifyCalls).toHaveLength(3);
		for (const call of ui.notifyCalls) {
			expect(call.message).toContain("verifier model");
			expect(call.type).toBe("error");
		}
	});

	test("missing API key → fires error notify every time", async () => {
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: false } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;
		const ctx = makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext;

		for (let i = 0; i < 3; i++) {
			await runSpeculationCheck(
				makePi(pi) as unknown as ExtensionAPI,
				ctx,
				makeEvent(`response ${i}`),
				state,
			);
		}

		expect(completeMock).not.toHaveBeenCalled();
		expect(pi.sendMessageCalls).toHaveLength(0);
		expect(ui.notifyCalls).toHaveLength(3);
		for (const call of ui.notifyCalls) {
			expect(call.message).toContain("API key");
			expect(call.type).toBe("error");
		}
	});

	test("malformed verifier output → fires error notify", async () => {
		// Unparseable JSON means the chosen model isn't suited for the
		// strict-JSON verdict format. Surface so the user can switch.
		completeMock.mockImplementation(
			async () =>
				({
					content: [{ type: "text", text: "completely unparseable garbage" }],
				}) as { content: { type: string; text?: string }[] },
		);
		const ui: FakeUI = { notifyCalls: [] };
		const registry: FakeRegistry = { authResult: { ok: true, apiKey: "k" } };
		const pi: FakePi = { sendMessageCalls: [] };
		const state = createSessionState();
		state.enabled = true;

		await runSpeculationCheck(
			makePi(pi) as unknown as ExtensionAPI,
			makeCtx({ hasUI: true, ui, registry }) as unknown as ExtensionContext,
			makeEvent("some response"),
			state,
		);

		expect(pi.sendMessageCalls).toHaveLength(0);
		expect(ui.notifyCalls).toHaveLength(1);
		const call = ui.notifyCalls[0];
		expect(call?.message).toContain("unparseable");
		expect(call?.type).toBe("error");
	});
});
