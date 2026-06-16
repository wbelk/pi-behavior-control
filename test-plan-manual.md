# Manual test plan

Run in order — each section builds on the previous. Skip to specific categories if you've already verified setup.

## Setup / session gate

| # | Action | Expected |
|---|---|---|
| 1 | Fresh `omp` launch (no env vars set) | Gate prompt: "Run pi-behavior-control this session?" with Yes/No, Yes is default. |
| 2 | Press Enter (accept Yes) | Verifier selector appears immediately after. |
| 3 | Press Enter at verifier (accept Haiku) | Session starts normally. `/behavior-control:status` shows `enabled: true`, `verifier: anthropic/claude-haiku-4-5`. |
| 4 | `/new` (start new session in same omp) | Gate prompt appears AGAIN. Verifier selector appears again with Haiku pre-selected. |
| 5 | Quit omp; relaunch with `PI_BEHAVIOR_CONTROL=off omp` | No gate prompt, no verifier prompt. `/behavior-control:status` shows `enabled: false`. |
| 6 | Quit; relaunch with `PI_BEHAVIOR_CONTROL=on omp` | No gate prompt. Verifier selector still appears. `enabled: true`. |
| 7 | In the current omp session, run `/behavior-control:set-verifier` and pick Sonnet. Quit; relaunch. | Gate prompt. Verifier selector with **Sonnet** pre-selected (because that was your last persisted choice). |

## Rules-source notification

| # | Action | Expected |
|---|---|---|
| 9 | Launch omp from a cwd with no `coding-rules.md` and no `~/.omp/agent/coding-rules.md` | After accepting gate, info toast: "no coding-rules.md found in cwd or ~/.omp/agent/ — post-edit reviews will skip rule citations." |
| 10 | `echo "test rules" > ~/.omp/agent/coding-rules.md`; quit; relaunch in same cwd | No "no coding-rules.md" toast (master found). |
| 11 | `echo "cwd rules" > ./coding-rules.md`; relaunch | No toast. Cwd file is being used (not master). |
| 12 | `/behavior-control:status` after #11 | `rules: cwd (./coding-rules.md)` |
| 13 | Remove cwd file, keep master; relaunch | `/behavior-control:status` shows `rules: master (~/.omp/agent/coding-rules.md)` |

## Read-before-edit gate (hooks 2/3/5)

| # | Action | Expected |
|---|---|---|
| 14 | Tell agent: "edit `/tmp/test.txt` to say 'hello'" (file does not exist) | Agent uses `write` tool. Allowed (new files are exempt). |
| 15 | Tell agent: "edit `/tmp/test.txt`, change 'hello' to 'world' — DO NOT read it first" | If agent tries to edit without reading, the tool call is blocked. Block reason: "Read the file before editing it. (read log clears every turn)". Agent should re-read then succeed. |
| 16 | Same turn as #15: "now edit it again to say 'three'" | Allowed without re-read (hook 6 refreshes the entry after each successful write). |
| 17 | New turn: "edit `/tmp/test.txt`" (without re-reading) | Blocked. "Read log clears every turn" — even though you read it 10 seconds ago. |
| 18 | Two-terminal mtime test: 1) ask agent to read `/tmp/test.txt`; 2) in another terminal: `echo "external" > /tmp/test.txt`; 3) ask agent (same turn) to edit `/tmp/test.txt` | Read succeeds; edit blocked: "File has been modified since you read it. Re-read before editing." |
| 19 | (macOS only) `echo "x" > /tmp/Foo.txt`; tell agent to read `/tmp/Foo.txt` then edit `/tmp/foo.txt` | Edit allowed — canonical paths collapse via `realpathSync`. |

## Post-edit review reminder (hook 6)

| # | Action | Expected |
|---|---|---|
| 20 | Make sure cwd has a `coding-rules.md` (any content). Tell agent: "read `/tmp/test.txt` then edit it to add a line" | Successful edit. **Agent's next response** should reference the review brief contents — typically the agent will mention reviewing for "Fail-Loud Contract violations", "approval gate", or similar phrases from the brief. If your cwd rules say something distinctive, the agent should acknowledge that text. |
| 21 | Remove all rules files; quit; relaunch; repeat the edit | Agent still gets a review brief (text appended) but without the rules section. Distinguishable from #20 only by content. |
| 22 | Tell agent to use the bash tool to do something that fails (e.g., `bash: cat /no-such-file`) | NO review brief appended (tool errored — hook 6 short-circuits on `isError`). |

## Speculation check (hook 7)

| # | Action | Expected |
|---|---|---|
| 23 | Ask agent a vague question that should prompt hedging: "is JavaScript slow?" Agent likely responds with hedged/speculative text | After the response ends, a follow-up appears: "Response flagged as speculative; review and amend." The agent processes it before you get your turn back. |
| 24 | Ask agent something with citations: "read `/tmp/test.txt` and tell me what's on line 1" | After response, no follow-up. Verdict was `{ok: true}`. |
| 25 | In `~/.omp/agent/behavior-control/config.json`, set `verifier` to `{"provider":"anthropic","id":"some-fake-model"}`. Restart. Ask any question | After response, warning toast: "verifier model 'anthropic/some-fake-model' not registered." Repeated for each subsequent response (fires every time). |
| 26 | Set `verifier` in the config to a provider you have no API key for (e.g. `{"provider":"openai","id":"gpt-4"}`). Restart. Ask any question | Warning toast: "no API key configured for openai." Repeated every response. |
| 27 | Run `omp -p "say hello"` (one-shot mode) | Plugin defaults to enabled, but speculation check is skipped (hasUI is false). Output completes normally, no speculation overhead. |

## Slash commands

| # | Action | Expected |
|---|---|---|
| 28 | `/behavior-control:status` | Multi-line info toast: enabled, verifier, rules source, agent dir, env override state. |
| 29 | `/behavior-control:disable` | Info toast: "disabled for this session." Subsequent edits without reading SUCCEED (hooks silent). |
| 30 | `/behavior-control:enable` then ask agent to edit a file (without first re-reading it this turn) | Blocked again — re-enable wipes nothing automatically, and the read log is empty (cleared every turn). Agent must read first. |
| 31 | `/behavior-control:set-verifier` | Selector appears, pre-selected with current. Press Enter at same option → toast: "verifier unchanged." Pick a different option → toast: "verifier set to <choice>." |
| 32 | `/behavior-control:enable` when already enabled | Info toast: "already enabled" (no-op). |
| 33 | `/behavior-control:disable` when already disabled | Info toast: "already disabled" (no-op). |

## Persistence

| # | Action | Expected |
|---|---|---|
| 34 | Pick Sonnet via `/behavior-control:set-verifier`; quit; relaunch; gate yes | Verifier selector pre-selects Sonnet. `~/.omp/agent/behavior-control/config.json` contains `"verifier": {"provider":"anthropic","id":"claude-sonnet-4-5"}`. |
| 35 | Pick Disable (gate=no); quit; relaunch | Gate prompt fires fresh (gate decision is NOT persisted). |

## What if something looks wrong

- **Hook should fire but doesn't:** check `/behavior-control:status` first. If `enabled: false`, you disabled it.
- **Toast doesn't appear:** OMP's toast position is configurable; might be off-screen. Check `~/.omp/logs/omp.<date>.log` for `behavior-control` strings.
- **Plugin not loaded at all:** `omp plugin doctor` should show `✔ plugin:pi-behavior-control`. If not, re-run the package.json fix:

  ```sh
  omp plugin link "/Users/williambelk/Dropbox/Laptop Backup/Code/ai/pi/pi-behavior-control"
  ```

  Then add to `~/.omp/plugins/package.json` dependencies:

  ```json
  "pi-behavior-control": "file:./node_modules/pi-behavior-control"
  ```

  Then `omp plugin doctor` should show clean.

## Coverage summary

35 tests covering every code path in the plan:

- **Setup/gate (1–8):** session-start flow, env overrides, persistence behavior.
- **Rules (9–13):** cwd-first resolution, master fallback, missing-rules notify.
- **Read-before-edit (14–19):** new-file allow, gate blocks, mtime check, per-turn freshness, canonicalization.
- **Review reminder (20–22):** with rules, without rules, error short-circuit.
- **Speculation (23–27):** flag-on-hedge, pass-on-citation, model/auth error surfacing, headless skip.
- **Slash commands (28–33):** all four commands, no-op cases, set-verifier same-as-previous.
- **Persistence (34–35):** verifier persists, gate doesn't.

Tests 14–22 are the highest-value (exercise the actual coding gates); 23–27 cover speculation; the rest cover config/UX edges.
