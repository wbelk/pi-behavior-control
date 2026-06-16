import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as PiAi from "@earendil-works/pi-ai";
import { complete } from "@earendil-works/pi-ai";
import { type Static, Type } from "typebox";
import { Check } from "typebox/value";
import type { SessionState } from "./session-state.ts";
import type { VerifierChoice, VerifierModel } from "./user-config.ts";
import { resolveVerifier } from "./verifier-source.ts";

// Hook 7: speculation check. Runs the chosen verifier model against the
// last assistant message; on a flagged verdict, queues a follow-up prompt.
// Spec: section 7 hook 7 of tasks/plan-pi-behavior-control.md.

const TIMEOUT_MS = 15_000;

// Verbatim port of the Stop-hook prompt from the upstream Claude skill.
// `$ARGUMENTS` was the assistant response; we substitute it via the
// `<ASSISTANT_TEXT>` placeholder below.
/**
 * Cross-runtime model lookup. Upstream pi-ai (`@earendil-works/pi-ai`)
 * exports `getModel`; OMP's pi-ai (`@oh-my-pi/pi-ai`, served via the
 * legacy pi-ai shim) renamed it to `getBundledModel`. Same signature,
 * different name.
 *
 * Probe the namespace on every call (not once at module-load) so a) the
 * plugin works under both runtimes without a build-time conditional and
 * b) `bun:test`'s `mock.module` swaps don't get bypassed by an early
 * binding. Returns `undefined` when neither name resolves — caller
 * surfaces "verifier model not registered".
 */
function lookupModel(provider: string, id: string): unknown {
	const ns = PiAi as unknown as Record<
		string,
		((p: string, i: string) => unknown) | undefined
	>;
	const fn = ns.getModel ?? ns.getBundledModel;
	return fn ? fn(provider, id) : undefined;
}

/**
 * Cross-runtime auth lookup. Upstream pi exposes
 * `getApiKeyAndHeaders(model) → Promise<{ok, apiKey?, headers?}>`; OMP
 * exposes `getApiKey(model) → Promise<string | undefined>`. Different
 * names AND different return shapes — normalize to a common
 * `{ apiKey, headers? }` or null when no auth is available.
 */
async function getAuthForModel(
	modelRegistry: unknown,
	model: unknown,
): Promise<{ apiKey: string; headers?: Record<string, string> } | null> {
	const reg = modelRegistry as {
		getApiKeyAndHeaders?: (m: unknown) => Promise<
			{ ok: boolean; apiKey?: string; headers?: Record<string, string> } | undefined
		>;
		getApiKey?: (m: unknown) => Promise<string | undefined>;
	};

	if (typeof reg.getApiKeyAndHeaders === "function") {
		const result = await reg.getApiKeyAndHeaders(model);
		if (!result?.ok || !result.apiKey) return null;
		return { apiKey: result.apiKey, headers: result.headers };
	}

	if (typeof reg.getApiKey === "function") {
		const apiKey = await reg.getApiKey(model);
		if (!apiKey) return null;
		return { apiKey };
	}

	return null;
}

const RUBRIC_PROMPT_TEMPLATE = `Evaluate: <ASSISTANT_TEXT>

A claim is VERIFIED (pass) if any of these is true:
- The response cites file:line references (e.g., \`services/sources.js:47\`)
- The response quotes tool output visible in prior turns or the hook input
- The response is an empty, short, or acknowledgment message

A claim is SPECULATION (flag) if:
- It describes code behavior without a file:line citation
- It uses hedge words (may/might/could/probably/likely/should work) to describe code
- It asserts facts that were not grounded in a tool call or citation

Default when uncertain: return {"ok": true}. Flag when speculation is present, and review source material before amending your response to remove speculation.
Return {"ok": true} or {"ok": false, "reason": "<brief reason>"}.`;

const VerdictSchema = Type.Object({
	ok: Type.Boolean(),
	reason: Type.Optional(Type.String()),
});
type Verdict = Static<typeof VerdictSchema>;

/** Internal options — used by tests to shorten the timeout. */
export interface RunSpeculationCheckOptions {
	timeoutMs?: number;
}

export async function runSpeculationCheck(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: AgentEndEvent,
	state: SessionState,
	options: RunSpeculationCheckOptions = {},
): Promise<void> {
	try {
		await runSpeculationCheckInner(pi, ctx, event, state, options);
	} catch (err) {
		// Unexpected throw — anything that escaped the narrowly-scoped
		// inner try around `complete()` is a real bug (typo, undefined
		// access, broken import after refactor, etc.). Surface it every
		// time: if the speculation check is silently broken, the user
		// needs persistent feedback so they can switch verifier or
		// disable the plugin. Better to be loud than to die quietly.
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(
			`pi-behavior-control: speculation check crashed (${message}). Please report this.`,
			"error",
		);
	}
}

async function runSpeculationCheckInner(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	event: AgentEndEvent,
	state: SessionState,
	options: RunSpeculationCheckOptions,
): Promise<void> {
	if (!state.enabled) return;
	// One-shot modes (print, json) have no UI for the follow-up and the agent
	// has already returned to the caller. RPC and TUI both keep the session
	// alive between turns and have hasUI === true.
	if (!ctx.hasUI) return;

	const assistantText = extractLastAssistantText(event.messages);
	if (assistantText.length === 0) return;

	const choice = resolveVerifier();
	const verifier = materializeChoice(choice, ctx);
	if (!verifier) {
		if (choice === "session-model") {
			// Fatal for this session: user picked "use session model" but no
			// model is currently active. Fire every time so they can switch.
			ctx.ui.notify(
				`pi-behavior-control: "use current session model" picked but no model is currently active; speculation check cannot run`,
				"error",
			);
		}
		return;
	}
	// Look up the model. Upstream pi-ai (@earendil-works/pi-ai) exports
	// `getModel`; OMP's pi-ai (@oh-my-pi/pi-ai, served via the legacy
	// pi-ai shim) renamed it to `getBundledModel`. Same shape, different
	// name. Probe the namespace at runtime so the plugin works under
	// both runtimes without a build-time conditional.
	const model = lookupModel(verifier.provider, verifier.id) as
		| Parameters<typeof complete>[0]
		| undefined;
	if (!model) {
		// Speculation check can never run until the verifier is wired up.
		// Fire every time so the user knows to switch model or disable.
		ctx.ui.notify(
				`pi-behavior-control: verifier model "${verifier.provider}/${verifier.id}" not registered`,
			"warning",
		);
		return;
	}

	const auth = await getAuthForModel(ctx.modelRegistry, model);
	if (!auth) {
		// Speculation check can never run until auth is configured. Fire
		// every time so the user knows to add the key or switch verifier.
		ctx.ui.notify(
				`pi-behavior-control: no API key configured for ${verifier.provider}`,
			"warning",
		);
		return;
	}

	// Use a replacement function so `$&`, `$$`, `$1` etc. in the agent's
	// response are NOT interpreted as String.prototype.replace patterns.
	const prompt = RUBRIC_PROMPT_TEMPLATE.replace("<ASSISTANT_TEXT>", () => assistantText);
	const signal = buildSignal(ctx.signal, options.timeoutMs ?? TIMEOUT_MS);

	// Wrap ONLY the model call in a try/catch. Timeouts, aborts, network
	// errors, model errors, and bad auth are all expected failure modes
	// that fail-open silently here. Anything that throws *outside* this
	// narrow try is a bug and surfaces via the outer catch in
	// `runSpeculationCheck` (above).
	let response: { content: { type: string; text?: string }[] };
	try {
		response = await complete(
			model,
			{
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: prompt }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);
	} catch {
		return;
	}

	const responseText = response.content
		.filter((c): c is { type: "text"; text: string } =>
			c.type === "text" && typeof (c as { text?: unknown }).text === "string",
		)
		.map((c) => c.text)
		.join("\n")
		.trim();

	const verdict = parseVerdict(responseText);
	if (!verdict || verdict.ok) return;

	pi.sendMessage(
		{
			customType: "behavior-control/speculation-flag",
			display: true,
			content:
				verdict.reason ??
				"Response flagged as speculative; review and amend.",
		},
		{ deliverAs: "followUp", triggerTurn: true },
	);
}

/**
 * Walk `messages` from the end and return the concatenated text content of
 * the last assistant message. Empty string when no assistant message has
 * text content (e.g. tool-only responses).
 */
export function extractLastAssistantText(
	messages: readonly AgentEndEvent["messages"][number][],
): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const m = messages[i];
		if (!m || m.role !== "assistant") continue;
		const content = (m as { content?: unknown }).content;
		if (!Array.isArray(content)) continue;
		const texts: string[] = [];
		for (const c of content) {
			if (
				c &&
				typeof c === "object" &&
				(c as { type?: unknown }).type === "text" &&
				typeof (c as { text?: unknown }).text === "string"
			) {
				texts.push((c as { text: string }).text);
			}
		}
		if (texts.length > 0) return texts.join("\n");
	}
	return "";
}

/**
 * Turn a VerifierChoice into a concrete VerifierModel. For "session-model"
 * choices, reads `ctx.model` at call time; returns null when unavailable.
 */
function materializeChoice(
	choice: VerifierChoice,
	ctx: ExtensionContext,
): VerifierModel | null {
	if (choice !== "session-model") return choice;
	// Let TypeScript infer the model type from ctx.model — upstream types
	// it loosely, but we only read .provider and .id which are stable.
	const m = ctx.model;
	if (!m) return null;
	return { provider: m.provider, id: m.id };
}

/**
 * Combine the configured timeout (`timeoutMs`) with the caller's `ctx.signal`
 * (when present) into a single AbortSignal we hand to `complete()`. Aborts
 * on whichever fires first.
 */
function buildSignal(ctxSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	if (!ctxSignal) return timeout;
	return AbortSignal.any([ctxSignal, timeout]);
}

/**
 * Parse the verifier's response as a Verdict. The model usually returns
 * raw JSON but sometimes wraps it in markdown fences or surrounding prose.
 * Tries the whole text first, then the largest `{ ... }` slice. Returns
 * null when nothing parses cleanly — caller treats that as fail-open.
 */
export function parseVerdict(text: string): Verdict | null {
	const direct = tryParseVerdict(text);
	if (direct) return direct;

	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start >= 0 && end > start) {
		return tryParseVerdict(text.slice(start, end + 1));
	}
	return null;
}

function tryParseVerdict(text: string): Verdict | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return null;
	}
	if (!Check(VerdictSchema, parsed)) return null;
	return parsed;
}
