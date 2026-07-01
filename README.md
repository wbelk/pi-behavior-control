# pi-behavior-control

`pi-behavior-control` is a plugin for `pi`/`oh-my-pi` that enforces agent behavior at every turn — to create a reliable "daily driver" setup for working on existing codebases — improving quality and predictability.

Agents are far too verbose by default. Context expansion destroys quality and memory recall. We cannot rely on a front-loaded AGENTS/CLAUDE.md. We must keep the agent on track with micro-context added at each turn.

### 1) Response reminder before every turn
  - `response-rules-reminder.md` is appended to the system prompt. (*see `example/response-rules-reminder.md`)
### 2) After response, audit for speculation
  - a verifier model scans each response message for unverified claims (no file:line citations, hedge words, etc.)
  - flagged responses get a follow-up prompt asking the agent to fix the speculation
### 3) Agent must read files before edit/write
  - read log with sliding window of last few turns
### 4) After file edit/write, review prompt
  - agent is prompted to review changes according to coding rules
### 5) slash command for adversarial subagent review

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

After install, add:

1) `response-rules-reminder.md` *read below for specs*
2) `coding-rules.md` *read below for specs*

## Slash commands

- `/behavior-control:status` — show plugin status
- `/behavior-control:review` — spawn a read-only reviewer to audit your uncommitted changes and converse with the session agent. Up to 6 conversation rounds with the session agent, with up to 4 clarifying questions allowed per round.
- `/behavior-control:set-verifier` — set speculation verifier model (cheaper is probably better here)
- `/behavior-control:enable` — turn on
- `/behavior-control:disable` — turn off

## Response-rules reminder

You may like to inject response rules inline at every agent turn to remind the agent about response/communication style. You should keep these as brief as possible. For example, you may like to tell the agent to be concise and clear, as opposed to being overly verbose. [See an example here](example/response-rules-reminder.md).

Resolution order (same as coding-rules):

1) `./response-rules-reminder.md` in the current working directory (project-local; always wins).
2) `<agentDir>/response-rules-reminder.md` (global fallback, where `<agentDir>` is `~/.omp/agent` or `~/.pi/agent`).
3) None — nothing is injected; the system prompt is left untouched.

## Coding Rules

1) Coding rules can be injected after each turn as part of the post-edit/write review reminder
2) Coding rules can be provided for the adversarial subagent reviewer slash command `/behavior-control:review`

Resolution order:

1) `./coding-rules.md` in the current working directory (project-local; always wins).
2) `<agentDir>/coding-rules.md` (global fallback, where `<agentDir>` is `~/.omp/agent` or `~/.pi/agent`).
3) None — the reminder still fires, but without a rules section.

`coding-rules.md` is for the moment-of-edit reminder, not the system prompt — pi/OMP already auto-load `AGENTS.md`/`CLAUDE.md`.

## Adversarial subagent review

`/behavior-control:review` runs an adversarial, read-only review of your **uncommitted** changes before you commit, then loops on the findings.

- **OMP** — uses the native `task` tool with `agent: "reviewer"` and an `irc` re-audit loop.
- **pi** — uses the bundled `uncommitted_review` tool, which spawns an isolated child running a read-only reviewer persona.
- **neither available** — the command notifies that review is unavailable and stops; it never fabricates a same-session "reviewer".

## Read-before-edit/write gate

pi-behavior-control intercepts every `read`, `edit`, and `write` tool call:

- `read` → records the path (canonicalized via `realpathSync` so case-different paths on macOS APFS / Windows NTFS collapse correctly) plus file mtime + size.
- `edit` or `write` against a path not in the read log (never read, or last read outside the sliding window) that also exists on disk → blocked with `"Read the file before editing it. (read log keeps the last few turns)"`.
- `edit` or `write` against a path whose mtime or size has changed since the read → blocked with `"File has been modified since you read it. Re-read before editing."`.
- `write` against a non-existent path → allowed (new-file creation).

The read log is a window that covers 4 turns.

## Post-edit review reminder

After every successful `edit` or `write`, the tool result is augmented with a review brief:

1) **Review brief** — asks the agent to re-read the file as a senior engineer/architect and check style, elegance, efficiency, design/architecture consistency, caller/upstream/downstream tracing, soft-failure conditional logic, conditional args that should be required, DRY, and test intent (tests must match design intent and cover edge cases, not just exercise the code as written). Broken logic should break the app and the tests.
2) **Approval gate** — auto-fix findings directly unless intent is unclear; if the prior response claimed completion, confirm tests ran with 0 failing this turn; if any approved scope was skipped or altered, list each deviation.

The exact wording lives in `src/post-edit-review/review-prompt.ts` (`REVIEW_BRIEF_TEXT`).

The brief is injected into the edit/write tool result, so it is wrapped in an attribution frame (`── pi-behavior-control: post-edit review ──` … `── end pi-behavior-control review ──`) to make clear it is the plugin speaking, not the edit tool's own output.

## Speculation check

When the agent finishes a full response (`agent_end`), the chosen verifier model judges the response for speculation. The verifier also sees:

1) `<TOOL_CALLS>` — tools the agent ran recently, one deduped line each as `name target` (e.g. `read src/foo.ts`, `grep parseConfig`, `bash bun test`). Low-fidelity by design: the target is a single salient argument (path/pattern/command), never full arguments or tool output. Fed by `src/tracking/tool-call-tracker.ts`, capped at the 50 most-recent.
2) `<RECENT_INSPECTIONS>` — canonical paths the agent read or surfaced via `search`/`grep`/`find`/`ast_grep`/`lsp` (and fff's equivalents) recently (paths only, most-recent first, capped at 50). It unions the read-before-edit log with the inspection-evidence tracker (`src/tracking/inspection-tracker.ts`), so a file is grounding whether the agent `read` it or turned it up in a search.

All three trackers (reads, inspections, tool calls) share one sliding-turn-window base (`src/tracking/turn-window.ts`, default 4 turns), so evidence grounded by a read, a search hit, or a recent tool call all have the same lifetime.

A response **passes** if it cites `file:line` references, its factual claims concern a file/path/command present in either evidence block, or it is empty/short/an acknowledgment. A response is **flagged** if it describes specific code behavior with no `file:line` citation and the file is in neither block, uses hedge words (may / might / could / probably / likely / should work) to assert how code behaves, or asserts facts about a file in neither block. When uncertain the verifier defaults to a pass. The exact wording lives in `src/speculation-check/speculation.ts` (`SYSTEM_PROMPT`).

A flag is shown via a registered message renderer (`src/speculation-check/speculation-renderer.ts`) as a compact, attributed annotation — a `⚠ pi-behavior-control · speculation` tag line with the reason wrapped beneath it — instead of the default full-width `[customType]` box. Collapsed (the default) the reason is clamped to a few lines; it expands with the rest of the tool output (the "expand tools" keybinding, `ctrl+o` by default in OMP).

## Session lifecycle

Logs are unique to each session.

## Headless

In a headless / no-UI run (`!ctx.hasUI`, e.g. `print` / `json` one-shot modes) there is nobody to answer prompts: unless `PI_BEHAVIOR_CONTROL=off`, the plugin enables itself silently with defaults and skips every dialog. The speculation check also no-ops without a UI, since there is no follow-up turn to deliver into.

## Environment variables

```
PI_BEHAVIOR_CONTROL=on|off          # session gate; unset = prompt
PI_CODING_AGENT_DIR=/path/to/agent  # override agent-dir detection (leading ~ expanded); else ~/.omp/agent or ~/.pi/agent
```

`PI_CODING_AGENT_DIR` wins over filesystem detection and determines where the persisted config (`<agentDir>/behavior-control/config.json`) and the global `coding-rules.md` / `response-rules-reminder.md` fallbacks are resolved.

## Compatibility

Runtime-agnostic: the same source runs under upstream pi (`@earendil-works/pi-coding-agent`) and oh-my-pi (`@oh-my-pi/pi-coding-agent`). Both runtimes are declared as optional peer dependencies, so installing under either one pulls only what it needs.

- No build step or bundler — pi loads the `.ts` entrypoint directly via jiti (upstream) or Bun's native TypeScript runtime (OMP).
- The agent directory is auto-detected: `PI_CODING_AGENT_DIR` wins when set; otherwise `~/.omp/agent` if it exists, then `~/.pi/agent` — so OMP wins when both exist, and `~/.pi/agent` is the default for a fresh upstream install.

## License

MIT
