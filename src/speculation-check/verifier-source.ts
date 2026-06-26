import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	loadConfig,
	saveConfig,
	type UserConfig,
	type VerifierChoice,
	type VerifierModel,
} from "../session/user-config.ts";

// Verifier (speculation-check) model resolution + per-session selector UI.
// Spec: section 8b and section 7 hook 7.
//
// Available models are pulled live from `ctx.modelRegistry.getAvailable()`
// (present in both upstream pi and OMP) so the selector shows whatever the
// user has configured — Anthropic, OpenAI, custom providers, anything.
// "Use current session model" is always offered as a special option.

const DEFAULT_VERIFIER: VerifierModel = {
	provider: "anthropic",
	id: "claude-haiku-4-5",
};

const SESSION_MODEL_LABEL = "Use current session model";

/**
 * Resolve the verifier choice without prompting. Used at every `agent_end`
 * by hook 7 to decide which model to call.
 *
 * Order: persisted config → default Haiku.
 */
export function resolveVerifier(): VerifierChoice {
	const config = loadConfig();
	if (config?.verifier) return config.verifier;
	return DEFAULT_VERIFIER;
}

/**
 * Result of an interactive verifier prompt. `persisted` is true only when
 * the user made an explicit selection AND it changed from the previous
 * persisted value.
 */
export interface ChooseVerifierResult {
	choice: VerifierChoice;
	persisted: boolean;
}

/**
 * Per-startup selector. Called from session_start / session_switch when
 * the gate has been accepted, and from `/behavior-control:set-verifier`.
 *
 *   1. !hasUI (print/json) → return persisted or default silently.
 *   2. hasUI → enumerate `ctx.modelRegistry.getAvailable()`, build the
 *      option list, pre-select previous choice, show selector.
 *      - cancel → `persisted = false`, returns previous.
 *      - same choice as previous → `persisted = false` (no rewrite).
 *      - new choice → write to config, `persisted = true`.
 */
export async function chooseVerifier(ctx: ExtensionContext): Promise<ChooseVerifierResult> {
	const config = loadConfig();
	const previous: VerifierChoice = config?.verifier ?? DEFAULT_VERIFIER;

	if (!ctx.hasUI) {
		if (!config?.verifier) {
			saveConfigSafely({ ...(config ?? {}), verifier: DEFAULT_VERIFIER });
			return { choice: DEFAULT_VERIFIER, persisted: true };
		}
		return { choice: previous, persisted: false };
	}

	const ordered = orderOptions(buildOptions(ctx), previous);
	const labels = ordered.map((o) => o.label);

	const title = [
		"\u001b[1;33mpi-behavior-control: select speculation verifier\u001b[0m",
		"",
		"\u001b[97mAfter each agent response, audit the response for potential speculation. This can usually be handled well with a cheaper model like Anthropic Haiku or GPT-5-Codex Mini.\u001b[0m",
	].join("\n");

	const chosen = await ctx.ui.select(title, labels);
	if (chosen === undefined) {
		// Cancelled. A previous pick that's no longer available would only
		// produce per-turn "no API key" errors, so repair to the always-
		// valid session model and persist it (the runtime reads the
		// persisted value). An available previous pick is left untouched.
		if (
			previous !== "session-model" &&
			!ordered.some((o) => choicesEqual(o.value, previous))
		) {
			saveConfigSafely({ ...(config ?? {}), verifier: "session-model" });
			return { choice: "session-model", persisted: true };
		}
		return { choice: previous, persisted: false };
	}

	const match = ordered.find((o) => o.label === chosen);
	if (!match) return { choice: previous, persisted: false };

	if (choicesEqual(match.value, previous)) {
		return { choice: previous, persisted: false };
	}

	saveConfigSafely({ ...(config ?? {}), verifier: match.value });
	return { choice: match.value, persisted: true };
}

interface VerifierOption {
	label: string;
	value: VerifierChoice;
}

/**
 * Build the selector options from the live model registry.
 *
 *   - One entry per available model (auth configured): label is
 *     "<provider>/<id>". The default Haiku and any previously-persisted
 *     choice are included here too, but only when they are actually
 *     available — an unavailable model is never surfaced.
 *   - "Use current session model" always appears (resolved per-call from
 *     `ctx.model`) and is always a valid pick.
 *   - If nothing is available (empty or throwing registry), the only
 *     option is "Use current session model".
 */
function buildOptions(ctx: ExtensionContext): VerifierOption[] {
	const seen = new Set<string>();
	const options: VerifierOption[] = [];

	const add = (model: VerifierModel) => {
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) return;
		seen.add(key);
		options.push({ label: key, value: model });
	};

	const registry = ctx.modelRegistry as unknown as
		| { getAvailable?: () => ReadonlyArray<{ provider?: unknown; id?: unknown }> }
		| undefined;
	if (registry && typeof registry.getAvailable === "function") {
		try {
			const available = registry.getAvailable();
			for (const m of available) {
				if (typeof m?.provider === "string" && typeof m?.id === "string") {
					add({ provider: m.provider, id: m.id });
				}
			}
		} catch {
			// Registry shape surprise — leave the model list empty; the
			// session-model sentinel below is still offered.
		}
	}

	options.sort((a, b) => a.label.localeCompare(b.label));

	options.push({ label: SESSION_MODEL_LABEL, value: "session-model" });

	return options;
}

/** Move the previously-chosen option to the front so Enter accepts it. */
function orderOptions(
	options: VerifierOption[],
	previous: VerifierChoice,
): VerifierOption[] {
	const matchIndex = options.findIndex((o) => choicesEqual(o.value, previous));
	if (matchIndex <= 0) return options;
	const head = options[matchIndex];
	if (!head) return options;
	const tail = options.filter((_, i) => i !== matchIndex);
	return [head, ...tail];
}

function choicesEqual(a: VerifierChoice, b: VerifierChoice): boolean {
	if (a === "session-model" || b === "session-model") {
		return a === b;
	}
	return a.provider === b.provider && a.id === b.id;
}

function saveConfigSafely(config: UserConfig): void {
	try {
		saveConfig(config);
	} catch {
		// Persistence failed (disk full, permissions). The user's choice
		// still applies for this session via the returned value; they'll
		// be re-prompted next session.
	}
}
