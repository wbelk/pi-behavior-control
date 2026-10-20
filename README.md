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
2) A `coding-rules/` directory or compatibility `coding-rules.md` file *read below for specs*

## Slash commands

- `/behavior-control:status` — show plugin status
- `/behavior-control:review` — inject an agent-guided protocol for a read-only reviewer to audit your uncommitted changes and converse with the session agent. The protocol asks for up to 6 audit rounds; the plugin does not technically enforce the loop. See "Adversarial subagent review" below.
- `/behavior-control:set-verifier` — set speculation verifier model (cheaper is probably better here)
- `/behavior-control:enable` — turn on
- `/behavior-control:disable` — turn off

## Response-rules reminder

You may like to inject response rules inline at every agent turn to remind the agent about response/communication style. You should keep these as brief as possible. For example, you may like to tell the agent to be concise and clear, as opposed to being overly verbose. [See an example here](example/response-rules-reminder.md).

Resolution order:

1) `./response-rules-reminder.md` in the current working directory (project-local; always wins).
2) `<agentDir>/response-rules-reminder.md` (global fallback, where `<agentDir>` is `~/.omp/agent` or `~/.pi/agent`).
3) None — nothing is injected; the system prompt is left untouched.

## Coding Rules

Coding rules are used in two places:

1) Successful edit/write results include the applicable rules in the post-edit review reminder.
2) `/behavior-control:review` tells the reviewer to apply the rules for every language represented in the changed files.

Directory layout:

```text
coding-rules/
  coding-rules.md
  coding-rules.typescript.md
  coding-rules.javascript.md
  coding-rules.css.md
```

`coding-rules.md` contains shared rules. For a file edit, the plugin appends the matching `coding-rules.<language>.md` after the shared rules. For example, `.ts`, `.tsx`, `.mts`, and `.cts` use `coding-rules.typescript.md`; `.js`, `.jsx`, `.mjs`, and `.cjs` use `coding-rules.javascript.md`. Common aliases also cover Markdown, YAML, shell, Python, Ruby, Rust, C#, C++, and Kotlin. CSS, SCSS, Less, HTML, EJS, JSON, Go, Java, PHP, and Swift use their lower-case language names directly. Unknown extensions receive shared rules only.

Source precedence:

1) `./coding-rules/` in the current working directory.
2) `./coding-rules.md` compatibility file.
3) `<agentDir>/coding-rules/` global directory.
4) `<agentDir>/coding-rules.md` global compatibility file.
5) None — the reminder still fires, but without a rules section.

The first available source wins; project and global sources are never merged. A compatibility file is shared-only.

Coding rules are for moment-of-edit and explicit review reminders, not the system prompt — pi/OMP already auto-load `AGENTS.md`/`CLAUDE.md`.

## Adversarial subagent review

`/behavior-control:review` starts an agent-guided adversarial review of your **uncommitted** changes before you commit. The plugin injects the protocol, but the session agent—not a plugin state machine—follows the findings and re-audit instructions.

- **OMP** — uses the native `task` tool with `agent: "reviewer"` and asks the session agent to use an `irc` re-audit loop.
- **pi** — uses the bundled `uncommitted_review` tool, which pre-collects fixed Git status/diff evidence and spawns a child with read/search tools but no shell.
- **neither available** — the command notifies that review is unavailable and stops; it never fabricates a same-session "reviewer".

### Audit round logic

The session agent drives the loop; the plugin injects these instructions but does not technically enforce them:

1. Check every original requirement and report only issues introduced or worsened by the uncommitted changes.
2. Require a concrete execution path or affected caller, failing input or state, impact, and minimal fix for every finding.
3. Use stable IDs: `B1`, `B2`, ... for blocking findings and `N1`, `N2`, ... for non-blocking findings.
4. Treat correctness, security/privacy, data-loss, required-contract, build/test, and missing-required-behavior failures as blocking. Treat demonstrated maintainability, performance, or readability concerns without current failure as non-blocking. Style preference alone is not a finding.
5. Resolve every finding from one response as a batch, then request one re-audit. Each re-audit preserves prior IDs and classifies them as resolved, rejected with sufficient evidence, or still open.
6. Accept verification evidence only when it includes the exact command, exit status, and observed output or counts.
7. Run relevant verification after the latest file change, then request a final re-audit of that exact verified worktree.
8. Any later file change invalidates the reviewer pass and affected verification. Repeat verification and final re-audit until one unchanged worktree has both successful verification and `Blocking findings: 0`.
9. Stop after **6 total audit rounds**. If blocking findings remain, escalate to the user instead of declaring a pass.

### Final report format

Immediately before reporting, the session agent collects fresh `git status --short`, unstaged `git diff --numstat`, and staged `git diff --cached --numstat` output. It merges and deduplicates staged, unstaged, and untracked paths instead of reusing the reviewer’s earlier Git snapshot.

Every changed file appears exactly once:

| Filename | Diff | Reason |
|---|---|---|
| `src/example.ts` | `+12 / -4` — Added validation and changed error handling | Prevent invalid state |

Filenames are repository-relative. **Diff** combines final added/removed line statistics with a concise change summary (`binary` when line counts are unavailable). Untracked files count as full-file additions. **Reason** ties the file to the approved ask or a reviewer finding.

Actual verification is reported separately:

| Command | Result | Evidence |
|---|---|---|
| `bun test` | `exit 0` | 42 tests passed, 0 failed |

Each row contains an exact command run against the final unchanged worktree, its exit status, and observed output or counts. Unrun verification is reported as `Not run` with the reason, never implied successful. Empty report sections use `None`, and findings are not repeated across sections. Both tables remain agent-guided output rather than plugin-enforced rendering.

## Read-before-edit/write gate

pi-behavior-control intercepts every `read`, `edit`, and `write` tool call:

- successful `read` result → records the path (canonicalized via `realpathSync` so case-different paths on macOS APFS / Windows NTFS collapse correctly) plus file mtime + size; a failed read does not authorize an edit.
- `edit` or `write` against a path not in the read log (never read, or last read outside the sliding window) that also exists on disk → blocked with `"Read the file before editing it. (read log keeps the last few turns)"`.
- `edit` or `write` against a path whose mtime or size has changed since the read → blocked with `"File has been modified since you read it. Re-read before editing."`.
- `write` against a non-existent path → allowed (new-file creation).

The read log covers four turns: the turn containing the successful read plus the next three turns. Every edit still revalidates file mtime and size.

## Post-edit review reminder

After every successful `edit` or `write`, the tool result is augmented with a review brief:

1) **Review brief** — asks the agent to re-read the file as a senior engineer/architect and check style, elegance, efficiency, design/architecture consistency, caller/upstream/downstream tracing, soft-failure conditional logic, conditional args that should be required, DRY, and test intent (tests must match design intent and cover edge cases, not just exercise the code as written). Broken logic should break the app and the tests.
2) **Approval gate** — auto-fix findings directly unless intent is unclear; if the prior response claimed completion, confirm tests ran with 0 failing this turn; if any approved scope was skipped or altered, list each deviation.

The exact wording lives in `src/post-edit-review/review-prompt.ts` (`REVIEW_BRIEF_TEXT`).

The brief is injected into the edit/write tool result, so it is wrapped in an attribution frame (`── pi-behavior-control: post-edit review ──` … `── end pi-behavior-control review ──`) to make clear it is the plugin speaking, not the edit tool's own output.

## Speculation check

When the agent finishes a full response (`agent_end`), the plugin sends the assistant response and limited recent activity evidence to the selected verifier model. It does not send tool-result contents. The bounded evidence is:

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

`PI_CODING_AGENT_DIR` wins over filesystem detection and determines where the persisted config (`<agentDir>/behavior-control/config.json`), global `coding-rules/` directory or compatibility file, and `response-rules-reminder.md` fallback are resolved.

## Compatibility

Runtime-agnostic: the same source runs under upstream pi (`@earendil-works/pi-coding-agent`) and oh-my-pi (`@oh-my-pi/pi-coding-agent`). Both runtimes are declared as optional peer dependencies, so installing under either one pulls only what it needs.

- No build step or bundler — pi loads the `.ts` entrypoint directly via jiti (upstream) or Bun's native TypeScript runtime (OMP).
- The agent directory is auto-detected: `PI_CODING_AGENT_DIR` wins when set; otherwise `~/.omp/agent` if it exists, then `~/.pi/agent` — so OMP wins when both exist, and `~/.pi/agent` is the default for a fresh upstream install.

## License

MIT
