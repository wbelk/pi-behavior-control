# pi-behavior-control

`pi-behavior-control` is a plugin for pi and oh-my-pi that keeps the agent honest:

1. Agent must read a file before editing or writing it — and the read only counts if it happened within the last few turns (a sliding window), not just the current turn.
2. If a file changed on disk between the read and the edit, the agent is forced to re-read.
3. Every successful edit is followed by a "review the change you just made" instruction the agent has to address.
4. After every agent response, a verifier model scans the message for unverified claims (no file:line citations, hedge words, etc.); flagged responses get a follow-up prompt asking the agent to fix the speculation.
5. If a `response-rules-reminder.md` exists, its contents are appended to the system prompt before every agent turn, so your standing response rules ride along on every turn.

## Install

```sh
# upstream pi
pi install npm:pi-behavior-control

# OMP
omp install npm:pi-behavior-control
```

Or, for local development:

```sh
# pi
pi install /absolute/path/to/pi-behavior-control

# OMP
omp plugin link /absolute/path/to/pi-behavior-control
```

## Slash commands

- `/behavior-control:enable` — turn the plugin on for the rest of this session. No-op + notify if already on.
- `/behavior-control:disable` — turn it off for the rest of this session. No-op + notify if already off.
- `/behavior-control:set-verifier` — re-prompt for the speculation verifier.
- `/behavior-control:status` — print enabled state, active verifier, which rules file is loaded, agent dir, and env overrides.

None of these persist across sessions (except `set-verifier`, which overwrites the persisted config).

## Coding-rules resolution (for the post-edit review reminder)

The post-edit review reminder cites the project's coding rules inline when present. Resolution order:

1. `./coding-rules.md` in the current working directory (project-local; always wins).
2. `<agentDir>/coding-rules.md` (global fallback, where `<agentDir>` is `~/.omp/agent` or `~/.pi/agent`).
3. None — the reminder still fires, but without a rules section.

If both files are absent at session start, you get an actionable dialog (not just a notification): create an empty `coding-rules.md` at the project root, create one under `<agentDir>`, or continue without rules for this session. Choosing a create option writes the empty file for you to fill in.

`coding-rules.md` is for the moment-of-edit reminder, not the system prompt — pi/OMP already auto-load `AGENTS.md`/`CLAUDE.md` for that.

## Response-rules reminder (injected every turn)

You may like to inject response rules inline at every agent turn to remind the agent and keep the agent on track with your expectations. You should keep these as brief as possible. For example, you may like to tell the agent to be concise and clear, as opposed to being overly verbose. [See an example here](example/response-rules-reminder.md).

Resolution order (same as coding-rules):

1. `./response-rules-reminder.md` in the current working directory (project-local; always wins).
2. `<agentDir>/response-rules-reminder.md` (global fallback, where `<agentDir>` is `~/.omp/agent` or `~/.pi/agent`).
3. None — nothing is injected; the system prompt is left untouched.

Like coding-rules, if neither file exists at session start you get an actionable dialog offering to create an empty `response-rules-reminder.md` at the project root or under `<agentDir>`, or to skip it this session. The trigger is filesystem existence, so once the file exists (even empty) the dialog will not re-fire next session.

## Read-before-edit gate

pi-behavior-control intercepts every `read`, `edit`, and `write` tool call:

- `read` → records the path (canonicalized via `realpathSync` so case-different paths on macOS APFS / Windows NTFS collapse correctly) plus file mtime + size.
- `edit` or `write` against a path not in the read log (never read, or last read outside the sliding window) that also exists on disk → blocked with `"Read the file before editing it. (read log keeps the last few turns)"`.
- `edit` or `write` against a path whose mtime or size has changed since the read → blocked with `"File has been modified since you read it. Re-read before editing."`.
- `write` against a non-existent path → allowed (new-file creation).

The read log is **not** wiped every turn. `before_agent_start` calls `prune()`, which advances a turn counter and evicts only entries older than the sliding window (default 4 turns — `DEFAULT_WINDOW_TURNS` in `src/read-tracker.ts`). A read on turn N keeps authorizing edits through turn N+3, provided the file's mtime and size are unchanged since the read — that mtime/size revalidation (previous bullet) is what makes the wider window safe. The log is fully cleared only on `session_shutdown`.

## Post-edit review reminder

After every successful `edit` or `write`, the tool result is augmented with a review brief:

1. **Review brief** — asks the agent to re-read the file as a senior engineer/architect and check style, elegance, efficiency, design/architecture consistency, caller/upstream/downstream tracing, soft-failure conditional logic, conditional args that should be required, DRY, and test intent (tests must match design intent and cover edge cases, not just exercise the code as written). Broken logic should break the app and the tests.
2. **Approval gate** — auto-fix findings directly unless intent is unclear; if the prior response claimed completion, confirm tests ran with 0 failing this turn; if any approved scope was skipped or altered, list each deviation.

The exact wording lives in `src/review-prompt.ts` (`REVIEW_BRIEF_TEXT`).

The brief is injected into the edit/write tool result, so it is wrapped in an attribution frame (`── pi-behavior-control: post-edit review ──` … `── end pi-behavior-control review ──`) to make clear it is the plugin speaking, not the edit tool's own output.

## Speculation check

When the agent finishes its full response (`agent_end`), the chosen verifier model judges the last assistant message against a grounding rubric. The verifier never sees raw tool output — instead it gets two evidence blocks, both covering the same recent-turn sliding window:

- `<TOOL_CALLS>` — tools the agent ran recently, one deduped line each as `name target` (e.g. `read src/foo.ts`, `grep parseConfig`, `bash bun test`). Low-fidelity by design: the target is a single salient argument (path/pattern/command), never full arguments or tool output. Fed by `src/tool-call-tracker.ts`, capped at the 50 most-recent.
- `<RECENT_INSPECTIONS>` — canonical paths the agent read or surfaced via `search`/`grep`/`find`/`ast_grep`/`lsp` (and fff's equivalents) recently (paths only, most-recent first, capped at 50). It unions the read-before-edit log with the inspection-evidence tracker (`src/inspection-tracker.ts`), so a file is grounding whether the agent `read` it or turned it up in a search.

All three trackers (reads, inspections, tool calls) share one sliding-turn-window base (`src/turn-window.ts`, default 4 turns), so evidence grounded by a read, a search hit, or a recent tool call all have the same lifetime. A file, path, or command in either block is grounding — a claim isn't flagged merely for being absent from one.

A response **passes** if it cites `file:line` references, its factual claims concern a file/path/command present in either evidence block, or it is empty/short/an acknowledgment. A response is **flagged** if it describes specific code behavior with no `file:line` citation and the file is in neither block, uses hedge words (may / might / could / probably / likely / should work) to assert how code behaves, or asserts facts about a file in neither block. When uncertain the verifier defaults to a pass. The exact wording lives in `src/speculation.ts` (`SYSTEM_PROMPT`).

The grader returns `{"ok": true}` or `{"ok": false, "reason": "..."}`. On a flag, pi-behavior-control queues a follow-up carrying the verifier's reason, delivered as a follow-up turn (`deliverAs: "followUp"`, `triggerTurn: true`) so the agent must address it before the user gets their turn back.

The flag is shown via a registered message renderer (`src/speculation-renderer.ts`) as a compact, attributed annotation — a `⚠ pi-behavior-control · speculation` tag line with the reason wrapped beneath it — instead of the default full-width `[customType]` box. Collapsed (the default) the reason is clamped to a few lines; it expands with the rest of the tool output (the "expand tools" keybinding, `ctrl+o` by default in OMP).

**Failure handling.** Anything that prevents the speculation check from running is surfaced as an `error`-level notification, every time it happens, so you can switch verifier or disable the plugin:

- Verifier model not registered
- No API key configured for the verifier provider
- "Use current session model" picked but no model is currently active
- Model call failed (15s timeout, network error, API error, auth rejection)
- Model returned unparseable JSON for the verdict
- Unexpected throw (programming bug) — accompanied by "Please report this."

The only silent path is when `ctx.signal` aborts mid-check — that means a new turn started or you cancelled, not that the verifier is broken. 15-second timeout per check.

## Session lifecycle & headless

The session-entry flow (gate prompt → verifier selector → coding-rules / response-rules dialogs → active banner) runs on a fresh session **and** on in-session transitions. Upstream pi rolls `/new`, `/resume`, and `/fork` into `session_start`; OMP fires `session_start` on launch and a separate `session_switch` for those transitions, so the plugin registers both (`src/index.ts`).

The verifier selector lists only models with configured auth, plus *Use current session model* (always valid). If the pre-selected pick — your persisted choice, or the default Haiku on first run — isn't available, it isn't shown; cancelling the selector in that state falls back to *Use current session model* and persists it, so a session never runs on a verifier that can only error. The runtime check itself stays fail-loud (see above): a persisted-but-unavailable verifier that you never re-pick still surfaces the per-turn error notifications.

In a headless / no-UI run (`!ctx.hasUI`, e.g. `print` / `json` one-shot modes) there is nobody to answer prompts: unless `PI_BEHAVIOR_CONTROL=off`, the plugin enables itself silently with defaults and skips every dialog. The speculation check also no-ops without a UI, since there is no follow-up turn to deliver into.

## Environment variables

```
PI_BEHAVIOR_CONTROL=on|off          # session gate; unset = prompt
PI_CODING_AGENT_DIR=/path/to/agent  # override agent-dir detection (leading ~ expanded); else ~/.omp/agent or ~/.pi/agent
```

`PI_CODING_AGENT_DIR` wins over filesystem detection and determines where the persisted config (`<agentDir>/behavior-control/config.json`) and the global `coding-rules.md` / `response-rules-reminder.md` fallbacks are resolved.

## Development

```sh
npm install --no-save \
  @earendil-works/pi-coding-agent \
  @earendil-works/pi-ai \
  typebox \
  @types/node \
  @types/bun \
  typescript

npx tsc --noEmit -p tsconfig.json   # type check
bun test                             # unit tests
```

Source files live under `src/`. No build step — pi loads `.ts` directly via jiti (upstream) or Bun's native TypeScript runtime (OMP).

Those are the **upstream** peers (enough for the typecheck and tests above); OMP provides its own `@oh-my-pi/pi-coding-agent` / `@oh-my-pi/pi-ai` equivalents. All four runtime peers are declared optional in `package.json`, so installing under either runtime pulls only what it needs.

## Compatibility

Runtime-agnostic: the same source runs under upstream pi (`@earendil-works/pi-coding-agent`) and oh-my-pi (`@oh-my-pi/pi-coding-agent`). Both runtimes are declared as optional peer dependencies, so installing under either one pulls only what it needs.

- No build step or bundler — pi loads the `.ts` entrypoint directly via jiti (upstream) or Bun's native TypeScript runtime (OMP).
- The agent directory is auto-detected: `PI_CODING_AGENT_DIR` wins when set; otherwise `~/.omp/agent` if it exists, then `~/.pi/agent` — so OMP wins when both exist, and `~/.pi/agent` is the default for a fresh upstream install.

## License

MIT
