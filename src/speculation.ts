import type {
	AgentEndEvent,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
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
//
// Verifier prompt is split into a static system prompt (rubric + JSON
// instruction) and a per-turn user message (assistant response + a compact
// summary of this turn's tool calls). The split lets providers cache the
// system prefix and keeps the rubric reusable across calls. The summary is
// calls-only (tool name + bounded arguments) — it is context about what the
// agent inspected, not the full tool output, to keep the check cheap.

const TIMEOUT_MS = 15_000;
// Cap on how many recent-inspection paths are listed in <RECENT_INSPECTIONS>.
// Paths are cheap (one line each), but bound the list so a session that has
// touched hundreds of files can't balloon the verifier prompt. Most recent
// first.
const MAX_RECENT_INSPECTIONS = 50;
// Cap on how many recent tool-call descriptors are listed in <TOOL_CALLS>.
// Entries are short, deduped "name target" lines, so this mainly backstops a
// burst of distinct calls. Most recent kept.
const MAX_RECENT_CALLS = 50;

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

type RuntimeModelEntry = { provider?: unknown; id?: unknown };

interface RuntimeModelRegistry {
	find?: (provider: string, id: string) => unknown;
	getAvailable?: () => readonly RuntimeModelEntry[];
	getAll?: () => readonly RuntimeModelEntry[];
}

/**
 * Resolve the verifier against the live runtime registry first, then fall back
 * to the bundled pi-ai catalog. OMP can discover Cursor models at runtime that
 * are selectable via ctx.modelRegistry but absent from bundled pi-ai.
 */
function lookupVerifierModel(ctx: ExtensionContext, provider: string, id: string): unknown {
	const registry = ctx.modelRegistry as RuntimeModelRegistry | undefined;

	const directMatch = lookupRegistryFind(registry, provider, id);
	if (directMatch) return directMatch;

	const availableMatch = lookupRegistryList(registry, "getAvailable", provider, id);
	if (availableMatch) return availableMatch;

	const allMatch = lookupRegistryList(registry, "getAll", provider, id);
	if (allMatch) return allMatch;

	return lookupModel(provider, id);
}

function lookupRegistryFind(
	registry: RuntimeModelRegistry | undefined,
	provider: string,
	id: string,
): unknown {
	if (!registry || typeof registry.find !== "function") return undefined;
	try {
		return registry.find.call(registry, provider, id);
	} catch {
		return undefined;
	}
}

function lookupRegistryList(
	registry: RuntimeModelRegistry | undefined,
	method: "getAvailable" | "getAll",
	provider: string,
	id: string,
): unknown {
	if (!registry) return undefined;
	const getModels = registry[method];
	if (typeof getModels !== "function") return undefined;

	try {
		return findRegistryModel(getModels.call(registry), provider, id);
	} catch {
		return undefined;
	}
}

function findRegistryModel(
	models: readonly RuntimeModelEntry[],
	provider: string,
	id: string,
): unknown {
	for (const model of models) {
		if (model.provider === provider && model.id === id) return model;
	}
	return undefined;
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

const SYSTEM_PROMPT = `You are a fact-check verifier. Judge whether the assistant's response is grounded, using two context blocks describing what the assistant actually inspected:
- <TOOL_CALLS>: tools the assistant ran within the last few turns, one per line as \`name target\` (e.g. \`read src/foo.ts\`, \`grep parseConfig\`, \`bash bun test\`). Deduplicated and low-fidelity — the target is a single salient argument (path/pattern/command), never full arguments or tool output.
- <RECENT_INSPECTIONS>: files the assistant inspected (read or surfaced via search/find/grep/lsp/ast-grep) within the last few turns (paths only).

Both blocks cover the same recent-turn window — they are two views of the same activity: <TOOL_CALLS> is what the assistant did, <RECENT_INSPECTIONS> is which files surfaced. A claim is grounded if its file, path, or command appears in EITHER block; do NOT flag a claim merely because it is absent from one of them.

Return strict JSON in this exact shape, with no preamble, fences, or trailing prose:

{"ok": true}
or
{"ok": false, "reason": "<brief reason>"}

A response is GROUNDED (pass) if any of these is true:
- It cites file:line references (e.g., \`services/sources.js:47\`)
- Its factual claims concern a file, path, or command that appears in <TOOL_CALLS> or <RECENT_INSPECTIONS>
- It is empty, short, or an acknowledgment

A response is SPECULATION (flag) if:
- It describes specific code behavior without a file:line citation, and the file appears in neither <TOOL_CALLS> nor <RECENT_INSPECTIONS>
- It uses hedge words (may/might/could/probably/likely/should work) to assert how code behaves
- It asserts facts about a file or path that appears in neither <TOOL_CALLS> nor <RECENT_INSPECTIONS>

You cannot see tool output, so do not flag a claim merely because you cannot personally verify its content — only flag claims that are unsupported by any citation and by any file in <TOOL_CALLS> or <RECENT_INSPECTIONS>. Default when uncertain: return {"ok": true}. Flag only when speculation is clearly present.`;

const USER_TEMPLATE = `<ASSISTANT_RESPONSE>
<ASSISTANT_TEXT_SLOT>
</ASSISTANT_RESPONSE>

<EVIDENCE_SLOT>`;

const VerdictSchema = Type.Object({
	ok: Type.Boolean(),
	reason: Type.Optional(Type.String()),
});
type Verdict = Static<typeof VerdictSchema>;

/** Internal options — used by tests to shorten the timeout / inject paths. */
export interface RunSpeculationCheckOptions {
	timeoutMs?: number;
	/**
	 * Recently-inspected file paths surfaced to the verifier as
	 * <RECENT_INSPECTIONS>. In production this is the union of
	 * ReadTracker.recentPaths() and InspectionTracker.recentPaths(),
	 * deduplicated at the agent_end hook. When omitted, the block renders
	 * its empty sentinel and the check falls back to <TOOL_CALLS>-only
	 * grounding. Pre-unioned (rather than two tracker handles) so this
	 * module stays decoupled from the tracker classes.
	 */
	recentPaths?: readonly string[];
	/**
	 * Recent tool-call descriptors surfaced to the verifier as <TOOL_CALLS>.
	 * In production this is ToolCallTracker.recentCalls() passed from the
	 * agent_end hook. When omitted, the block renders its empty sentinel.
	 */
	recentCalls?: readonly string[];
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
	const model = lookupVerifierModel(ctx, verifier.provider, verifier.id) as
		| Parameters<typeof complete>[0]
		| undefined;
	if (!model) {
		// Speculation check can never run until the verifier is wired up.
		// Fire every time so the user knows to switch model or disable.
		ctx.ui.notify(
			`pi-behavior-control: verifier model "${verifier.provider}/${verifier.id}" not registered`,
			"error",
		);
		return;
	}

	const auth = await getAuthForModel(ctx.modelRegistry, model);
	if (!auth) {
		// Speculation check can never run until auth is configured. Fire
		// every time so the user knows to add the key or switch verifier.
		ctx.ui.notify(
			`pi-behavior-control: no API key configured for ${verifier.provider}`,
			"error",
		);
		return;
	}

	const toolCalls = buildEvidenceBlock(options.recentCalls ?? []);
	const recentInspections = buildRecentInspectionsBlock(
		options.recentPaths ?? [],
		ctx.cwd,
	);
	const userText = buildUserPrompt(assistantText, toolCalls, recentInspections);
	const signal = buildSignal(ctx.signal, options.timeoutMs ?? TIMEOUT_MS);

	// Wrap ONLY the model call in a try/catch. The only silent path is
	// `ctx.signal` aborting mid-check — that means a new turn started or
	// the user cancelled, which is a normal lifecycle event, not a
	// verifier problem. Every other failure (our 15s timeout, network
	// error, API error, auth rejection) surfaces as an error notify so
	// the user can switch verifier or disable the plugin.
	let response: { content: { type: string; text?: string }[] };
	try {
		response = await complete(
			model,
			{
				systemPrompt: SYSTEM_PROMPT,
				messages: [
					{
						role: "user",
						content: [{ type: "text", text: userText }],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: auth.apiKey, headers: auth.headers, signal },
		);
	} catch (err) {
		if (ctx.signal?.aborted) return;
		const message = err instanceof Error ? err.message : String(err);
		ctx.ui.notify(
			`pi-behavior-control: speculation check failed (${message})`,
			"error",
		);
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
	if (!verdict) {
		ctx.ui.notify(
			`pi-behavior-control: verifier returned unparseable response; pick a model that supports strict JSON output`,
			"error",
		);
		return;
	}
	if (verdict.ok) return;

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
 * Render the <TOOL_CALLS> evidence block from the recent tool-call descriptors
 * (\`name target\`, e.g. \`read src/foo.ts\`) produced by ToolCallTracker. They
 * are already deduped and trimmed by the tracker, so this only numbers, caps,
 * and wraps them; the most recent are kept when over MAX_RECENT_CALLS. Returns
 * \`"(no recent tool calls)"\` when empty so the verifier can tell an empty
 * window from a clipped one. Exported for tests.
 */
export function buildEvidenceBlock(calls: readonly string[]): string {
	if (calls.length === 0) return "(no recent tool calls)";

	const capped =
		calls.length > MAX_RECENT_CALLS
			? calls.slice(calls.length - MAX_RECENT_CALLS)
			: calls;
	const lines = capped.map((call, i) => `[${i + 1}] ${call}`);

	return ["<TOOL_CALLS>", ...lines, "</TOOL_CALLS>"].join("\n");
}

/**
 * Build the <RECENT_INSPECTIONS> block: canonical paths the agent inspected
 * within the sliding turn window, made relative to `cwd` when inside it (to
 * match how the agent cites paths) and otherwise left absolute. Listed most
 * recent last (insertion order from the trackers) and capped at
 * MAX_RECENT_INSPECTIONS. Returns `"(no recent inspections)"` when the list
 * is empty so the verifier can tell an empty window from a clipped one.
 *
 * Exported for tests.
 */
export function buildRecentInspectionsBlock(
	paths: readonly string[],
	cwd: string,
): string {
	if (paths.length === 0) return "(no recent inspections)";

	// Keep the most recent entries when over the cap. The trackers yield
	// paths in insertion order, so the tail is the most recently inspected.
	const capped =
		paths.length > MAX_RECENT_INSPECTIONS
			? paths.slice(paths.length - MAX_RECENT_INSPECTIONS)
			: paths;

	const lines = capped.map((p) => {
		const rel = path.relative(cwd, p);
		// Inside cwd: use the relative form. `path.relative` returns a
		// `..`-prefixed path for siblings/ancestors — keep those absolute
		// so the verifier sees an unambiguous location.
		const display = rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : p;
		return `- ${display}`;
	});

	return ["<RECENT_INSPECTIONS>", ...lines, "</RECENT_INSPECTIONS>"].join("\n");
}

/**
 * Combine the static USER_TEMPLATE with the per-turn assistant text and the
 * two evidence blocks (tool calls + recent inspections). Uses replacement-function
 * form of `String.replace` so any `$&`, `$$`, `$1`, etc. inside the
 * substituted text is NOT interpreted as a `String.prototype.replace`
 * pattern.
 */
function buildUserPrompt(
	assistantText: string,
	toolCalls: string,
	recentInspections: string,
): string {
	const evidence = `${toolCalls}

${recentInspections}`;
	return USER_TEMPLATE
		.replace("<ASSISTANT_TEXT_SLOT>", () => assistantText)
		.replace("<EVIDENCE_SLOT>", () => evidence);
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
 * null when nothing parses cleanly — caller surfaces an error notify.
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
