# pi-behavior-control

A pi extension that adds five enforcement hooks to every coding session:

1. **Read-before-edit gate** — the agent must read a file in the current turn before it can edit or write it.
2. **External-modification gate** — if a file changed on disk between the read and the edit, the agent is forced to re-read.
3. **Per-turn freshness** — the file-read log is cleared at every turn, so stale reads from earlier in the conversation don't count.
4. **Post-edit review reminder** — every successful edit is followed by a "review the change you just made" instruction the agent has to address.
5. **Speculation check** — after every assistant response, a verifier model scans the message for unverified claims (no file:line citations, hedge words, etc.); flagged responses get a follow-up prompt asking the agent to fix the speculation.

The plugin defaults to **opt-in per session**: every pi launch asks once whether you want it on for this session. Pick yes when writing code, no when chatting or researching.

## Runtime support

Runs unchanged under both upstream pi (`@earendil-works/pi-coding-agent`) and OMP (`@oh-my-pi/pi-coding-agent`). The `ExtensionAPI` shapes match between the two and the plugin auto-detects whichever agent dir is in use (`~/.pi/agent` or `~/.omp/agent`).

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
pi -e   /absolute/path/to/pi-behavior-control/src/index.ts   # one-shot test

# OMP
omp plugin link /absolute/path/to/pi-behavior-control
```

## How it works

### Session enablement gate

On every `session_start` (initial launch and after `/new`, `/resume`, `/fork`, `/reload`), pi prompts:

> Run pi-behavior-control this session? **[Y/n]**

- **Yes** → all five hooks fire for the session.
- **No** → the plugin is silent for the session.

The choice is per-session; it's asked fresh every time. Set `PI_BEHAVIOR_CONTROL=on` or `PI_BEHAVIOR_CONTROL=off` (exact strings, case-sensitive) in the environment to bypass the prompt.

In one-shot scripted modes (`pi -p "..."`, `--mode json`), the gate defaults to **on** with no prompt. The speculation check is auto-skipped in these modes — the agent has already returned to the caller, so there's nowhere to queue a follow-up.

### Verifier selection

When the gate accepts, pi asks which model should verify assistant responses for speculation. The list is built from **whatever models you have configured in pi/OMP** (via `ctx.modelRegistry.getAvailable()`), labelled `provider/id`. Examples for a typical config:

- `anthropic/claude-haiku-4-5`
- `anthropic/claude-sonnet-4-5`
- `openai/gpt-4o`
- `cursor/auto`
- (any custom provider you've registered)
- `Use current session model` — always offered as the last option; resolves to `ctx.model` at each `agent_end`.

Two opinionated additions:
- `anthropic/claude-haiku-4-5` is always included even if your registry doesn't have it, so the documented default is always pickable.
- Your previously-persisted choice is always included even if the registry no longer reports it (e.g. provider deauthed) — so you can see what you had, not be silently switched.

The previous choice is pre-selected (floated to position 0); **pressing Enter accepts**. The selection is persisted to `<agentDir>/behavior-control/config.json`. To change the verifier, run `/behavior-control:set-verifier` mid-session or edit the config file.

### Coding-rules resolution (for the post-edit review reminder)

The post-edit review reminder cites the project's coding rules inline when present. Resolution order:

1. `./coding-rules.md` in the current working directory (project-local; always wins).
2. `<agentDir>/coding-rules.md` (global fallback, where `<agentDir>` is `~/.pi/agent` or `~/.omp/agent`).
3. None — the reminder still fires, but without a rules section.

If both files are absent at session start, you'll get a one-time notification telling you to create one if you want rule citations.

> **Note on the system prompt:** pi and OMP both auto-load `AGENTS.md` / `CLAUDE.md` from the agent dir and cwd into the system prompt at startup. That's the right place for "the agent should always know these rules." `coding-rules.md` is for the *moment-of-edit reminder* — separate from the system-prompt rules, though many people use the same content for both.

### Read-before-edit gate

After the gate accepts, pi-behavior-control intercepts every `read`, `edit`, and `write` tool call:

- `read` → records the path (canonicalized via `realpathSync` so case-different paths on macOS APFS / Windows NTFS collapse correctly) plus file mtime + size.
- `edit` or `write` against a path not recorded this turn AND that exists on disk → blocked with `"Read the file before editing it."`.
- `edit` or `write` against a path whose mtime or size has changed since the read → blocked with `"File has been modified since you read it. Re-read before editing."`.
- `write` against a non-existent path → allowed (new-file creation).

The log clears at the start of every turn (`before_agent_start`). Reads from earlier turns don't count — this is the literal implementation of the per-turn freshness rule.

### Post-edit review reminder

After every successful `edit` or `write`, the tool result is augmented with a verbatim review brief asking the agent to:

- Trace caller / upstream / downstream paths.
- Check for soft-failure logic, optional-but-actually-required args, missing tests.
- Hit the Fail-Loud Contract checks (no `if (requiredArg)` guards, no silenced callbacks, etc.).
- Confirm the agent didn't skip approved scope or claim completion without running tests.

If a resolved `coding-rules.md` is available, its full text is appended as a "Coding rules reference" section.

### Speculation check

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

Expected failures — timeouts, aborts, network errors, missing API key, missing model — are **fail-open silently** so verifier infrastructure problems never block your session. Unexpected errors (programming bugs that escape the expected-error handling) are **surfaced** as `error`-level notifications **every time they occur** — if the speculation check is silently broken, you need persistent feedback so you can switch verifier or disable the plugin. 15-second timeout per check.

## Slash commands

- `/behavior-control:enable` — turn the plugin on for the rest of this session. No-op + notify if already on.
- `/behavior-control:disable` — turn it off for the rest of this session. No-op + notify if already off.
- `/behavior-control:set-verifier` — re-prompt for the speculation verifier.
- `/behavior-control:status` — print enabled state, active verifier, which rules file is loaded, agent dir, and env overrides.

None of these persist across sessions (except `set-verifier`, which overwrites the persisted config).

**Gotcha on `/behavior-control:enable` mid-session:** if you disable the plugin, do some reads, then re-enable it, the read tracker is empty (it didn't fire while disabled). The first edit after re-enabling will be blocked with "Read the file before editing." even for files the agent read while the plugin was off — re-read once after enabling and you're back to normal.

## Environment variables

```
PI_BEHAVIOR_CONTROL=on|off                                    # session gate; unset = prompt
```

There are intentionally **no per-hook disable knobs**. The plugin is all-or-nothing per session — either all five hooks fire, or none do. Use `PI_BEHAVIOR_CONTROL=off` for fully-quiet runs.

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
