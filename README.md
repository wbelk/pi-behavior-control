# pi-behavior-control

`pi-behavior-control` is a plugin for pi and oh-my-pi that keeps the agent honest:

1. Agent must read all files in the current turn before edit/write.
2. If a file changed on disk between the read and the edit, the agent is forced to re-read.
3. Every successful edit is followed by a "review the change you just made" instruction the agent has to address.
4. After every agent response, a verifier model scans the message for unverified claims (no file:line citations, hedge words, etc.); flagged responses get a follow-up prompt asking the agent to fix the speculation.

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
2. `<agentDir>/coding-rules.md` (global fallback, where `<agentDir>` is `~/.pi/agent` or `~/.omp/agent`).
3. None — the reminder still fires, but without a rules section.

If both files are absent at session start, you'll get a one-time notification telling you to create one if you want rule citations.

`coding-rules.md` is for the moment-of-edit reminder, not the system prompt — pi/OMP already auto-load `AGENTS.md`/`CLAUDE.md` for that.

## Read-before-edit gate

pi-behavior-control intercepts every `read`, `edit`, and `write` tool call:

- `read` → records the path (canonicalized via `realpathSync` so case-different paths on macOS APFS / Windows NTFS collapse correctly) plus file mtime + size.
- `edit` or `write` against a path not recorded this turn AND that exists on disk → blocked with `"Read the file before editing it."`.
- `edit` or `write` against a path whose mtime or size has changed since the read → blocked with `"File has been modified since you read it. Re-read before editing."`.
- `write` against a non-existent path → allowed (new-file creation).

The log clears at the start of every turn (`before_agent_start`). Reads from earlier turns don't count — this is the literal implementation of the per-turn freshness rule.

## Post-edit review reminder

After every successful `edit` or `write`, the tool result is augmented with a verbatim review brief in three sections:

1. **Review brief** — asks the agent to re-read the file as a senior engineer/architect and check style, elegance, efficiency, design/architecture consistency, caller/upstream/downstream tracing, soft-failure conditional logic, conditional args that should be required, DRY, and test intent (tests must match design intent and cover edge cases, not just exercise the code as written). Broken logic should break the app and the tests.
2. **Fail-Loud Contract violations to flag** — five specific patterns: `if (requiredArg)` guards around required work, empty `() => {}` callbacks that silence errors, optional args that are actually required, `if (cb) { cb() }` protections on required callbacks, helper signature changes without grepping every caller.
3. **Approval gate** — auto-fix findings directly unless intent is unclear; if the prior response claimed completion, confirm tests ran with 0 failing this turn; if any approved scope was skipped or altered, list each deviation.

The exact wording lives in `src/review-prompt.ts` (`REVIEW_BRIEF_TEXT`) — a verbatim port of `review-file.sh` from the upstream Claude `behavior-hooks` skill.

## Speculation check

When the agent finishes its full response (`agent_end`), the chosen verifier model evaluates the last assistant text against this rubric (verbatim from the upstream Claude `behavior-hooks` skill):

> A claim is **VERIFIED** (pass) if any of:
> - The response cites file:line references.
> - The response quotes tool output visible in prior turns.
> - The response is an empty, short, or acknowledgment message.
>
> A claim is **SPECULATION** (flag) if:
> - It describes code behavior without a file:line citation.
> - It uses hedge words (may / might / could / probably / likely / should work) to describe code.
> - It asserts facts that were not grounded in a tool call or citation.

The grader returns `{"ok": true}` or `{"ok": false, "reason": "..."}`. On a flag, pi-behavior-control queues a follow-up message ("address this speculation") that the agent runs before the user gets their turn back.

**Failure handling.** Anything that prevents the speculation check from running is surfaced as an `error`-level notification, every time it happens, so you can switch verifier or disable the plugin:

- Verifier model not registered
- No API key configured for the verifier provider
- "Use current session model" picked but no model is currently active
- Model call failed (15s timeout, network error, API error, auth rejection)
- Model returned unparseable JSON for the verdict
- Unexpected throw (programming bug) — accompanied by "Please report this."

The only silent path is when `ctx.signal` aborts mid-check — that means a new turn started or you cancelled, not that the verifier is broken. 15-second timeout per check.

## Environment variables

```
PI_BEHAVIOR_CONTROL=on|off                                    # session gate; unset = prompt
```

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

## License

MIT
