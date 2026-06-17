import * as fs from "node:fs";
import * as path from "node:path";
import {
	type ExtensionAPI,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { readSessionGate } from "./config.ts";
import { ReadTracker } from "./read-tracker.ts";
import { buildReviewInstruction } from "./review-prompt.ts";
import { loadRules } from "./rules-source.ts";
import {
	createSessionState,
	resetSessionState,
} from "./session-state.ts";
import { runSpeculationCheck } from "./speculation.ts";
import { agentDir } from "./user-config.ts";
import { chooseVerifier, resolveVerifier } from "./verifier-source.ts";

// pi-behavior-control entrypoint. Wires the five active hooks and four
// slash commands described in the plan.

export default function pluginFactory(pi: ExtensionAPI): void {
	const state = createSessionState();
	const tracker = new ReadTracker();

	// =========================================================================
	// Session entry (initial start OR transition via /new, /resume, /fork)
	// Spec: section 8a + first-run rules notify.
	//
	// Upstream pi fires `session_start` for every reason; OMP fires
	// `session_start` only on initial launch and `session_switch` for
	// transitions. We register both so the gate prompt + verifier prompt
	// fire on every fresh session in either runtime.
	//
	// IMPORTANT: OMP hardcodes a 30-second timeout on extension handlers
	// (`EXTENSION_HANDLER_TIMEOUT_MS` in runner.ts). If we awaited the
	// gate confirm or verifier selector inside the handler, a user who
	// took longer than 30s to answer would silently lose the verifier
	// selector and the rules-missing notify (handler cancelled before
	// they fire). To avoid that, the handler runs the prompts as a
	// non-awaited background task and returns immediately. State defaults
	// to `enabled = true` while the user is deciding, then flips to false
	// if they pick "no" — so any hooks that fire during the prompt
	// window default to the safer (enabled) behavior.
	// =========================================================================
	const handleSessionEnter = (
		_event: unknown,
		ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
	): void => {
		resetSessionState(state);

		const envValue = readSessionGate();
		if (envValue === "on") {
			state.enabled = true;
			void runInteractiveSetup(ctx, state, /*skipGate*/ true);
			return;
		}
		if (envValue === "off") {
			state.enabled = false;
			return;
		}
		if (!ctx.hasUI) {
			state.enabled = true;
			return;
		}

		// Interactive: optimistically enable while we wait for the user's
		// gate answer. Background task runs the prompts and notify.
		state.enabled = true;
		void runInteractiveSetup(ctx, state, /*skipGate*/ false);
	};

	const runInteractiveSetup = async (
		ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
		st: typeof state,
		skipGate: boolean,
	): Promise<void> => {
		try {
			if (!skipGate) {
				const accepted = await ctx.ui.confirm(
					"\u001b[1;33m⚔️  pi-behavior-control: run this session?\u001b[0m",
					"\n\u001b[97mEnforces read-before-edit (per-turn), post-edit review reminder, and speculation check. Recommended for code work; skip for chat / research / planning sessions.\u001b[0m",
				);
				st.enabled = accepted;
				if (!accepted) return;
			}

			await chooseVerifier(ctx);

			if (!loadRules(ctx.cwd)) {
				await promptForMissingRules(ctx, st);
			}

			// Final banner — only when still enabled after all prompts.
			// User picking "Disable pi-behavior-control" in the rules dialog
			// flips st.enabled to false; in that case the disable notify
			// already fired and we skip the active banner.
			if (st.enabled) {
				showActiveBanner(ctx);
			}
		} catch {
			// Dialog cancelled, signal aborted, etc. Whatever state was
			// reached stays put — no need to recover.
		}
	};

	const showActiveBanner = (
		ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
	): void => {
		const verifier = resolveVerifier();
		const verifierLabel =
			verifier === "session-model"
				? "session-model"
				: `${verifier.provider}/${verifier.id}`;
		const rules = loadRules(ctx.cwd);
		const rulesLabel = rules
			? `${rules.source} (${rules.path})`
			: "none (skipping citations in reviews)";
		ctx.ui.notify(
			`⚔️  pi-behavior-control active — verifier: ${verifierLabel}; rules: ${rulesLabel}. Type /behavior-control:status for details.`,
			"info",
		);
	};

	/**
	 * Actionable prompt fired when neither `./coding-rules.md` (cwd) nor
	 * `<agentDir>/coding-rules.md` (master) exists. Offers four paths:
	 *   1. Create empty file at cwd
	 *   2. Create empty file at agent dir (global)
	 *   3. Continue without rules this session
	 *   4. Disable pi-behavior-control for this session
	 */
	const promptForMissingRules = async (
		ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
		st: typeof state,
	): Promise<void> => {
		const cwdPath = path.join(ctx.cwd, "coding-rules.md");
		const masterPath = path.join(agentDir(), "coding-rules.md");

		// ANSI bold + yellow on the first line for warning emphasis. If
		// pi/OMP strips ANSI in dialog text, the ⚠ glyph still conveys
		// the warning semantics. File paths stay in their natural case.
		const title = [
			"\u001b[1;33m⚠ pi-behavior-control: no coding-rules.md found\u001b[0m",
			"",
			"Coding rules are read from (cwd first, then global fallback):",
			`  • ${cwdPath} (project-local; this directory only)`,
			`  • ${masterPath} (global; applies to all projects)`,
			"",
			"Without one, post-edit review reminders will skip rule citations.",
			"What would you like to do?",
		].join("\n");

		const createCwd = `Create empty ${cwdPath} (project-local)`;
		const createMaster = `Create empty ${masterPath} (global)`;
		const skip = "Continue without rules this session";
		const disable = "Disable pi-behavior-control";

		const choice = await ctx.ui.select(title, [
			createCwd,
			createMaster,
			skip,
			disable,
		]);

		if (choice === undefined || choice === skip) return;

		if (choice === disable) {
			st.enabled = false;
			ctx.ui.notify(
				"pi-behavior-control: disabled for this session",
				"info",
			);
			return;
		}

		const target = choice === createCwd ? cwdPath : masterPath;
		try {
			fs.mkdirSync(path.dirname(target), { recursive: true });
			fs.writeFileSync(target, "", "utf-8");
			ctx.ui.notify(
				`pi-behavior-control: created ${target}. Edit it to add your rules.`,
				"info",
			);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			ctx.ui.notify(
				`pi-behavior-control: failed to create ${target}: ${message}`,
				"error",
			);
		}
	};

	pi.on("session_start", handleSessionEnter);
	// `session_switch` is OMP-only (upstream pi rolls /new/resume/fork into
	// session_start). Cast through unknown to register without TS error;
	// the registration is silently inert under upstream pi.
	(
		pi.on as unknown as (
			event: string,
			handler: typeof handleSessionEnter,
		) => void
	)("session_switch", handleSessionEnter);

	// =========================================================================
	// before_agent_start — per-turn read-log prune (hook 5)
	// Advances the turn counter and ages out reads older than the sliding
	// window, instead of wiping the whole log every turn. Recent reads stay
	// available so cross-turn citations remain grounded; the edit gate's
	// mtime/size revalidation still blocks edits to any file changed since
	// it was read.
	// =========================================================================
	pi.on("before_agent_start", () => {
		if (!state.enabled) return;
		tracker.prune();
	});

	// =========================================================================
	// session_shutdown — final read-log clear (hook 5)
	// Runs unconditionally so any lingering state is dropped on quit/reload.
	// =========================================================================
	pi.on("session_shutdown", () => {
		// Reset the in-memory session state too (not just the read tracker)
		// so any one-shot notifications fire fresh on the next session_start.
		resetSessionState(state);
		tracker.clear();
	});

	// =========================================================================
	// tool_call — read tracker (hook 2) + edit gate (hook 3)
	// =========================================================================
	pi.on("tool_call", (event, ctx) => {
		if (!state.enabled) return;

		// Some pi shims dispatch `read`/`edit`/`write` events whose `input`
		// is not the expected `{ path }` shape (e.g. harness tools that
		// happen to share the type name). Guard the path field so the
		// hook silently no-ops instead of throwing into the agent loop.
		if (isToolCallEventType("read", event)) {
			const rawPath = (event.input as { path?: unknown }).path;
			if (typeof rawPath !== "string" || rawPath.length === 0) return;
			tracker.record(path.resolve(ctx.cwd, rawPath));
			return;
		}

		if (
			isToolCallEventType("edit", event) ||
			isToolCallEventType("write", event)
		) {
			const rawPath = (event.input as { path?: unknown }).path;
			if (typeof rawPath !== "string" || rawPath.length === 0) return;
			const blocked = tracker.check(path.resolve(ctx.cwd, rawPath));
			if (blocked) return blocked;
		}
	});

	// =========================================================================
	// tool_result — post-edit review reminder (hook 6) + tracker refresh
	// =========================================================================
	pi.on("tool_result", (event, ctx) => {
		if (!state.enabled) return;
		if (event.isError) return;
		// Direct toolName check instead of isEditToolResult/isWriteToolResult
		// guards — the guards aren't exported by OMP's pi-coding-agent shim
		// (upstream-only). Both runtimes discriminate ToolResultEvent by
		// the `toolName` string field.
		if (event.toolName !== "edit" && event.toolName !== "write") return;

		const rawPath = event.input.path;
		if (typeof rawPath === "string" && rawPath.length > 0) {
			tracker.refresh(path.resolve(ctx.cwd, rawPath));
		}

		const resolved = loadRules(ctx.cwd);
		const review = buildReviewInstruction(resolved?.text);

		return {
			content: [
				...event.content,
				{ type: "text" as const, text: review },
			],
		};
	});

	// =========================================================================
	// agent_end — speculation check (hook 7)
	// =========================================================================
	pi.on("agent_end", async (event, ctx) => {
		await runSpeculationCheck(pi, ctx, event, state, { tracker });
	});

	// =========================================================================
	// Slash commands (4)
	// =========================================================================
	pi.registerCommand("behavior-control:enable", {
		description: "Enable behavior-control for the rest of this session.",
		handler: async (_args, ctx) => {
			if (state.enabled) {
				ctx.ui.notify("pi-behavior-control: already enabled", "info");
				return;
			}
			state.enabled = true;
			ctx.ui.notify("pi-behavior-control: enabled for this session", "info");
		},
	});

	pi.registerCommand("behavior-control:disable", {
		description: "Disable behavior-control for the rest of this session.",
		handler: async (_args, ctx) => {
			if (!state.enabled) {
				ctx.ui.notify("pi-behavior-control: already disabled", "info");
				return;
			}
			state.enabled = false;
			ctx.ui.notify("pi-behavior-control: disabled for this session", "info");
		},
	});

	pi.registerCommand("behavior-control:set-verifier", {
		description: "Re-prompt for the speculation verifier model.",
		handler: async (_args, ctx) => {
			const result = await chooseVerifier(ctx);
			if (!result.persisted) {
				ctx.ui.notify("pi-behavior-control: verifier unchanged", "info");
				return;
			}
			const label =
				result.choice === "session-model"
					? "session-model"
					: `${result.choice.provider}/${result.choice.id}`;
			ctx.ui.notify(`pi-behavior-control: verifier set to ${label}`, "info");
		},
	});

	pi.registerCommand("behavior-control:status", {
		description: "Show behavior-control session status.",
		handler: async (_args, ctx) => {
			const verifier = resolveVerifier();
			const verifierLabel =
				verifier === "session-model"
					? "session-model"
					: `${verifier.provider}/${verifier.id}`;
			const rules = loadRules(ctx.cwd);
			const rulesLabel = rules ? `${rules.source} (${rules.path})` : "none";
			const envGate = readSessionGate() ?? "unset";

			const lines = [
				`enabled: ${state.enabled}`,
				`verifier: ${verifierLabel}`,
				`rules: ${rulesLabel}`,
				`agent dir: ${agentDir()}`,
				`env PI_BEHAVIOR_CONTROL: ${envGate}`,
			];
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
