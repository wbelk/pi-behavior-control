import * as fs from "node:fs";
import * as path from "node:path";
import {
  type ExtensionAPI,
  isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { readSessionGate } from "./session/config.ts";
import { InspectionTracker } from "./tracking/inspection-tracker.ts";
import { ReadTracker } from "./tracking/read-tracker.ts";
import { ToolCallTracker } from "./tracking/tool-call-tracker.ts";
import { buildReviewInstruction } from "./post-edit-review/review-prompt.ts";
import { loadRules } from "./post-edit-review/rules-source.ts";
import { buildReminderAppend } from "./response-rules/reminder-prompt.ts";
import {
  loadResponseReminder,
  reminderCandidatePaths,
  responseReminderFileExists,
} from "./response-rules/reminder-source.ts";
import { registerSpeculationRenderer } from "./speculation-check/speculation-renderer.ts";
import {
  createSessionState,
  resetSessionState,
} from "./session/session-state.ts";
import { runSpeculationCheck } from "./speculation-check/speculation.ts";
import { agentDir } from "./session/user-config.ts";
import { chooseVerifier, resolveVerifier } from "./speculation-check/verifier-source.ts";
import { registerPiReviewSubagent } from "./uncommitted-review/pi-review-subagent.ts";
import { registerReviewCommand } from "./uncommitted-review/review-command.ts";

// Tool names whose `tool_result` events feed `inspectionTracker`. Covers
// pi's built-in `search`/`grep`/`multi_grep`/`find`/`ast_grep`/`lsp` plus
// fff's three tools (`ffgrep`, `fffind`, `fff-multi-grep`). When fff is
// installed in override mode the tool name is the same as pi's built-in
// (`grep`/`find`/`multi_grep`), so the built-in entry covers both. The
// path extractor is tolerant of either renderer's output format so
// matching on the name is enough — no per-tool parser.
const INSPECTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "search",
  "grep",
  "multi_grep",
  "find",
  "ast_grep",
  "lsp",
  "ffgrep",
  "fffind",
  "fff-multi-grep",
]);

// pi-behavior-control entrypoint. Wires the five active hooks and five
// slash commands described in the plan.

export default function pluginFactory(pi: ExtensionAPI): void {
  const state = createSessionState();
  const tracker = new ReadTracker();
  const inspectionTracker = new InspectionTracker();
  const toolCallTracker = new ToolCallTracker();
  // Register the compact renderer for speculation-flag custom messages so
  // the hook-7 verdicts print as a single attributed line instead of the
  // default full-width [customType] box. Registration is load-safe (no
  // runtime actions) and inert under runtimes that ignore the renderer.
  registerSpeculationRenderer(pi);
  registerPiReviewSubagent(pi);

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
        await promptForMissingRules(ctx);
      }

      // Actionable dialog if no response-rules-reminder.md exists at
      // either candidate path. Mirrors promptForMissingRules. Trigger
      // keys on filesystem existence (not loader content): once the
      // user has created the file via this dialog, an empty body must
      // not cause the dialog to re-fire next session.
      if (!responseReminderFileExists(ctx.cwd)) {
        await promptForMissingReminder(ctx);
      }

      showActiveBanner(ctx);
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
    const reminder = loadResponseReminder(ctx.cwd);
    const reminderLabel = reminder
      ? `${reminder.source} (${reminder.path})`
      : "none (system prompt unchanged)";
    ctx.ui.notify(
      `⚔️  pi-behavior-control active — verifier: ${verifierLabel}; rules: ${rulesLabel}; reminder: ${reminderLabel}. Type /behavior-control:status for details.`,
      "info",
    );
  };

  /**
   * Actionable prompt fired when neither `./coding-rules.md` (cwd) nor
   * `<agentDir>/coding-rules.md` (master) exists. Offers three paths:
   *   1. Create empty file at cwd
   *   2. Create empty file at agent dir (global)
   *   3. Continue without rules this session
   */
  const promptForMissingRules = async (
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
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

    const choice = await ctx.ui.select(title, [createCwd, createMaster, skip]);

    if (choice === undefined || choice === skip) return;

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

  /**
   * Actionable prompt fired when neither `./response-rules-reminder.md`
   * (cwd) nor `<agentDir>/response-rules-reminder.md` (master) exists on
   * disk. Mirrors `promptForMissingRules` — same 3-option select:
   *   1. Create empty file at cwd
   *   2. Create empty file at agent dir (global)
   *   3. Continue without reminder this session
   *
   * Trigger is filesystem existence (see runInteractiveSetup) so an empty
   * file the user just created via this dialog does not re-fire the prompt
   * next session.
   */
  const promptForMissingReminder = async (
    ctx: Parameters<Parameters<ExtensionAPI["on"]>[1]>[1],
  ): Promise<void> => {
    const { cwdPath, masterPath } = reminderCandidatePaths(ctx.cwd);

    const title = [
      "\u001b[1;33m⚠ pi-behavior-control: no response-rules-reminder.md found\u001b[0m",
      "",
      "Would you like to inject an agent reminder for response rules at every turn?",
      "",
      `Response rules are read from (cwd first, then global fallback):`,
      `  • project-local: ${cwdPath}`,
      `  • global fallback: ${masterPath}`,
      "",
      "What would you like to do?",
    ].join("\n");

    const createCwd = `Create empty project file: ${cwdPath}`;
    const createMaster = `Create empty global file: ${masterPath}`;
    const skip = "Continue without reminder for this session";

    const choice = await ctx.ui.select(title, [createCwd, createMaster, skip]);

    if (choice === undefined || choice === skip) return;

    const target = choice === createCwd ? cwdPath : masterPath;
    try {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, "", "utf-8");
      ctx.ui.notify(
        `pi-behavior-control: created ${target}. Edit it to add your response rules.`,
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
  // before_agent_start — per-turn read-log prune + response-rules reminder (hook 5)
  // Advances the turn counter and ages out reads older than the sliding
  // window, instead of wiping the whole log every turn. Recent reads stay
  // available so cross-turn citations remain grounded; the edit gate's
  // mtime/size revalidation still blocks edits to any file changed since
  // it was read.
  // =========================================================================
  pi.on("before_agent_start", (event, ctx) => {
    if (!state.enabled) return;
    tracker.prune();
    inspectionTracker.prune();
    toolCallTracker.prune();

    // Inject the response-rules reminder into the system prompt for this
    // turn. Absent / empty file -> loadResponseReminder returns null and we
    // leave the prompt untouched (the feature is fully opt-in).
    const reminder = loadResponseReminder(ctx.cwd);
    if (!reminder) return;
    // Guard against runtime shims that omit `systemPrompt` — concatenating
    // `undefined` would inject the literal string into the prompt header.
    const basePrompt = event.systemPrompt ?? "";
    return {
      systemPrompt: buildReminderAppend(basePrompt, reminder.text),
    };
  });

  // =========================================================================
  // session_shutdown — final read-log clear (hook 5)
  // Runs unconditionally so any lingering state is dropped on quit/reload.
  // =========================================================================
  pi.on("session_shutdown", () => {
    // Reset the in-memory session state too (not just the trackers) so any
    // one-shot notifications fire fresh on the next session_start.
    resetSessionState(state);
    tracker.clear();
    inspectionTracker.clear();
    toolCallTracker.clear();
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

    // Record every successful tool result as low-fidelity, deduped evidence
    // for the verifier's <TOOL_CALLS> block (same window as inspections).
    toolCallTracker.record(event.toolName, event.input);

    // Inspection-evidence branch: search/find/grep/lsp/ast_grep and fff's
    // equivalents surface files the agent inspected. Feed their rendered
    // text content to the inspection tracker so the verifier's
    // <RECENT_INSPECTIONS> block sees them. Does NOT unlock the edit gate
    // — ReadTracker stays the single source of truth for "may I edit?".
    if (INSPECTION_TOOL_NAMES.has(event.toolName)) {
      inspectionTracker.recordFromToolContent(event.content, ctx.cwd);
      return;
    }

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
  // user_bash — `!`/`!!` bash executions feed the tool-call tracker
  // User-initiated bash never reaches tool_call/tool_result, so record it
  // here as a synthetic `bash!` entry. `!!` is excluded from LLM context, so
  // it is excluded from the evidence too.
  // =========================================================================
  pi.on("user_bash", (event) => {
    if (!state.enabled) return;
    if (event.excludeFromContext) return;
    toolCallTracker.record("bash!", { command: event.command });
  });

  // =========================================================================
  // agent_end — speculation check (hook 7)
  // =========================================================================
  pi.on("agent_end", async (event, ctx) => {
    // Pre-union read + inspection paths so speculation.ts stays decoupled
    // from the tracker classes. Dedup via Set; canonical paths from both
    // trackers compare cleanly because both canonicalize via realpathSync.
    const recentPaths = Array.from(
      new Set([
        ...tracker.recentPaths(),
        ...inspectionTracker.recentPaths(),
      ]),
    );
    await runSpeculationCheck(pi, ctx, event, state, {
      recentPaths,
      recentCalls: toolCallTracker.recentCalls(),
    });
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
      const reminder = loadResponseReminder(ctx.cwd);
      let reminderLabel: string;
      if (reminder) {
        reminderLabel = `${reminder.source} (${reminder.path})`;
      } else if (responseReminderFileExists(ctx.cwd)) {
        const { cwdPath, masterPath } = reminderCandidatePaths(ctx.cwd);
        reminderLabel = `empty (looked at ${cwdPath} and ${masterPath})`;
      } else {
        const { cwdPath, masterPath } = reminderCandidatePaths(ctx.cwd);
        reminderLabel = `none (looked at ${cwdPath} and ${masterPath})`;
      }
      const envGate = readSessionGate() ?? "unset";

      const lines = [
        `enabled: ${state.enabled}`,
        `verifier: ${verifierLabel}`,
        `rules: ${rulesLabel}`,
        `reminder: ${reminderLabel}`,
        `agent dir: ${agentDir()}`,
        `env PI_BEHAVIOR_CONTROL: ${envGate}`,
      ];
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  registerReviewCommand(pi);
}
