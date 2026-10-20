# Manual test plan

Run in order — each section builds on the previous. Skip to specific categories if you've already verified setup.

## Setup / session gate

| # | Action | Expected |
|---|---|---|
| 1 | Fresh `omp` launch (no env vars set) | Gate prompt: "Run pi-behavior-control this session?" with Yes/No, Yes is default. |
| 2 | Press Enter (accept Yes) | Verifier selector appears immediately after. |
| 3 | Press Enter at verifier (accept Haiku) | Session starts normally. `/behavior-control:status` shows `enabled: true`, `verifier: anthropic/claude-haiku-4-5`. (Haiku is listed/pre-selected only when Anthropic auth is configured; otherwise it isn't offered — pick any available model or "Use current session model".) |
| 4 | `/new` (start new session in same omp) | Gate prompt appears AGAIN. Verifier selector appears again with Haiku pre-selected (when Anthropic auth is configured). |
| 5 | Quit omp; relaunch with `PI_BEHAVIOR_CONTROL=off omp` | No gate prompt, no verifier prompt. `/behavior-control:status` shows `enabled: false`. |
| 6 | Quit; relaunch with `PI_BEHAVIOR_CONTROL=on omp` | No gate prompt. Verifier selector still appears. `enabled: true`. |
| 7 | In the current omp session, run `/behavior-control:set-verifier` and pick Sonnet. Quit; relaunch. | Gate prompt. Verifier selector with **Sonnet** pre-selected — assuming Sonnet still has configured auth; an unavailable persisted pick is no longer listed or pre-selected. |

## Rules-source notification

| # | Action | Expected |
|---|---|---|
| 9 | Launch OMP with `PI_CODING_AGENT_DIR` pointing at an empty temporary agent directory, from a project with no rules source | After accepting the gate, the missing-rules dialog lists project/global directories and compatibility files. |
| 10 | Create `<agentDir>/coding-rules/coding-rules.md`; relaunch | No missing-rules dialog. `/behavior-control:status` shows `rules: master directory (<agentDir>/coding-rules)`. |
| 11 | Remove the global directory and create `<agentDir>/coding-rules.md`; relaunch | The compatibility file is accepted. Status shows `rules: master file (<agentDir>/coding-rules.md)`. |
| 12 | Add `./coding-rules.md` while the global directory exists; relaunch | The project compatibility file wins over the global directory. |
| 13 | Add `./coding-rules/coding-rules.md` and `./coding-rules/coding-rules.typescript.md` while keeping `./coding-rules.md`; relaunch | The project directory wins. Status shows `rules: cwd directory (./coding-rules)`. |

## Read-before-edit gate (hooks 2/3/5)

| # | Action | Expected |
|---|---|---|
| 14 | Tell agent: "edit `/tmp/test.txt` to say 'hello'" (file does not exist) | Agent uses `write` tool. Allowed (new files are exempt). |
| 15 | Tell agent: "edit `/tmp/test.txt`, change 'hello' to 'world' — DO NOT read it first" | If agent tries to edit without reading, the tool call is blocked. Block reason: "Read the file before editing it. (read log keeps the last few turns)". Agent should re-read then succeed. |
| 16 | Same turn as #15: "now edit it again to say 'three'" | Allowed without re-read (hook 6 refreshes the entry after each successful write). |
| 17 | On each of the next four turns, avoid reading `/tmp/test.txt`; on the fourth, ask the agent to edit it | Blocked because the successful read covered its original turn plus the next three turns and has now aged out. |
| 18 | Two-terminal mtime test: 1) ask agent to read `/tmp/test.txt`; 2) in another terminal: `echo "external" > /tmp/test.txt`; 3) ask agent (same turn) to edit `/tmp/test.txt` | Read succeeds; edit blocked: "File has been modified since you read it. Re-read before editing." |
| 19 | (macOS only) `echo "x" > /tmp/Foo.txt`; tell agent to read `/tmp/Foo.txt` then edit `/tmp/foo.txt` | Edit allowed — canonical paths collapse via `realpathSync`. |

## Post-edit review reminder (hook 6)

| # | Action | Expected |
|---|---|---|
| 20 | Put distinct markers in `./coding-rules/coding-rules.md` and `./coding-rules/coding-rules.typescript.md`. Tell the agent to read and edit a `.ts` file. | Successful edit. The appended post-edit review contains the shared marker first and the TypeScript marker second. |
| 21 | Remove both rules directories, create only `./coding-rules.md`, and repeat the `.ts` edit. Then remove that file and repeat once more. | The first review contains the compatibility-file marker only. With no source, the review brief still fires without a coding-rules section. |
| 22 | Tell the agent to use the bash tool to run a failing command such as `cat /no-such-file` | No review brief is appended because the tool result is an error. |

## Speculation check (hook 7)

| # | Action | Expected |
|---|---|---|
| 23 | Ask agent a vague question that should prompt hedging: "is JavaScript slow?" Agent likely responds with hedged/speculative text | After the response ends, a follow-up appears: "Response flagged as speculative; review and amend." The agent processes it before you get your turn back. |
| 24 | Ask agent something with citations: "read `/tmp/test.txt` and tell me what's on line 1" | After response, no follow-up. Verdict was `{ok: true}`. |
| 25 | In `~/.omp/agent/behavior-control/config.json`, set `verifier` to `{"provider":"anthropic","id":"some-fake-model"}`. Restart. Ask any question | After response, error toast: "verifier model 'anthropic/some-fake-model' not registered." Repeated for each subsequent response (fires every time). |
| 26 | Set `verifier` in the config to a provider you have no API key for (e.g. `{"provider":"openai","id":"gpt-4"}`). Restart. Ask any question | Error toast: "no API key configured for openai." Repeated every response. |
| 27 | Run `omp -p "say hello"` (one-shot mode) | Plugin defaults to enabled, but speculation check is skipped (hasUI is false). Output completes normally, no speculation overhead. |

## Slash commands

| # | Action | Expected |
|---|---|---|
| 28 | `/behavior-control:status` | Multi-line info toast: enabled, verifier, rules source, agent dir, env override state. |
| 29 | `/behavior-control:disable` | Info toast: "disabled for this session." Subsequent edits without reading SUCCEED (hooks silent). |
| 30 | Ensure `/tmp/test.txt` has not been read within the last four turns, run `/behavior-control:enable`, then ask the agent to edit it without reading | Blocked. Re-enabling does not clear or extend the four-turn read window; the agent must read the file first. |
| 31 | `/behavior-control:set-verifier` | Selector appears, pre-selected with current. Press Enter at same option → toast: "verifier unchanged." Pick a different option → toast: "verifier set to <choice>." |
| 32 | `/behavior-control:enable` when already enabled | Info toast: "already enabled" (no-op). |
| 33 | `/behavior-control:disable` when already disabled | Info toast: "already disabled" (no-op). |

## Persistence

| # | Action | Expected |
|---|---|---|
| 34 | Pick Sonnet via `/behavior-control:set-verifier`; quit; relaunch; gate yes | Verifier selector pre-selects Sonnet. `~/.omp/agent/behavior-control/config.json` contains `"verifier": {"provider":"anthropic","id":"claude-sonnet-4-5"}`. |
| 35 | Pick Disable (gate=no); quit; relaunch | Gate prompt fires fresh (gate decision is NOT persisted). |
| 36 | Hand-edit config `verifier` to an unavailable model (e.g. `{"provider":"deprecated","id":"old-model"}`); relaunch; gate yes; press Esc to cancel the verifier selector | Selector does not list the unavailable pick. Cancelling falls back to **Use current session model**: `/behavior-control:status` shows `verifier: session-model` and config.json now contains `"verifier": "session-model"`. |

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

36 tests covering every code path in the plan:

- **Setup/gate (1–8):** session-start flow, env overrides, persistence behavior.
- **Rules (9–13):** directory/file precedence, project/global precedence, compatibility fallback, and status.
- **Read-before-edit (14–19):** new-file allow, gate blocks, mtime check, four-turn freshness, canonicalization.
- **Review reminder (20–22):** shared plus language rules, compatibility rules, no rules, and error short-circuit.
- **Speculation (23–27):** flag-on-hedge, pass-on-citation, model/auth error surfacing, headless skip.
- **Slash commands (28–33):** all four commands, no-op cases, set-verifier same-as-previous.
- **Persistence (34–36):** verifier persists, gate does not, and unavailable choices repair to the session model.

Tests 14–22 are the highest-value (exercise the actual coding gates); 23–27 cover speculation; the rest cover config/UX edges.
