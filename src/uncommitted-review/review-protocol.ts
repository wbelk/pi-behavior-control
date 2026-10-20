// Uncommitted-change review protocol shared by both runtime adapters.
//
// Operationalizes the agent-reviewer "Uncommitted Change Review Process":
// one `/behavior-control:review` command, two adapters. On OMP the current
// agent drives the native `task` tool with `agent: "reviewer"`; on upstream
// pi it calls the plugin's bundled review-subagent tool (a child `pi`). This
// module owns the text both adapters share: the reviewer persona used by the
// pi tool's appended system prompt, and the protocol injected into the
// current agent's turn via `sendUserMessage`.

// Tool name the plugin registers for the upstream-pi reviewer path. Shared by
// the tool registration, runtime detection, and the injected protocol so all
// three agree on the exact name.
export const REVIEW_TOOL_NAME = "uncommitted_review";

// Read/search-only tool set handed to the child reviewer `pi` process. Git
// state and diffs are collected by the parent before the child starts.
export const REVIEWER_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
];

// Reviewer-agent persona appended to the child `pi` system prompt (pi adapter).
// The parent captures fixed Git status/diff evidence before startup, so the
// child does not need shell access.
export const REVIEWER_SYSTEM_PROMPT = `You are an adversarial code-review principal engineer reviewing uncommitted changes only. Be skeptical, evidence-first, rules-driven, and focused on root-cause fixes instead of style preference.

Instructions:
1. Read the pre-collected Git status, unstaged diff, and staged diff files named in the assignment. Use the status output to identify untracked files, then read those files directly.
2. Read the provided coding-rules source. For a compatibility file, read that shared file. For a directory, read coding-rules.md once when present, then read each coding-rules.<language>.md matching a changed file's language. If no source is provided, skip rule-compliance checks and audit correctness, caller impact, and verification only.
3. Use only read, grep, find, and ls. Do NOT edit files or run builds, formatters, project-wide tests, or shell commands.
4. Treat untracked files as full-file additions.
5. Read enough surrounding code and callsites to verify impact.
6. Check every requirement from the original ask against the implementation and verification evidence. Report missing required behavior and unrelated extra scope.
7. Report only issues introduced or worsened by the uncommitted changes. Do not report unrelated pre-existing issues.
8. A \`blocking\` finding must demonstrate a concrete path to incorrect behavior, a security or privacy exposure, data loss, a broken required contract/build/test, or omitted required behavior. A \`non-blocking\` finding is a concrete maintainability, performance, or readability issue without a demonstrated current failure. Style preference alone is not a finding.
9. Give every finding a stable ID: \`B1\`, \`B2\`, ... for blocking findings and \`N1\`, \`N2\`, ... for non-blocking findings. Include the changed file/hunk, reachable execution path or affected caller, concrete failing input or state, violated rule or invariant, impact, and minimal proposed fix. If no concrete path or failing condition can be demonstrated, omit the finding.
10. Treat verification as evidence only when the assignment includes the exact command, exit status, and observed output or counts. Otherwise treat the behavior as unverified.
11. On re-audit, preserve every prior finding ID and list it once as \`resolved\`, \`rejected with sufficient evidence\`, or \`still open\`. Report only these dispositions plus new or remaining findings; do not repeat resolved finding details.
12. End every response with exactly \`Blocking findings: N\`, where N is the number of still-open blocking findings. When there are no prior IDs and no findings, respond only with \`Blocking findings: 0\`.`;

export interface ReviewRulesSource {
  kind: "directory" | "file";
  path: string;
}

export interface ProtocolOptions {
  /** Which adapter the current agent should drive. */
  runtime: "omp" | "pi";
  /** Registered name of the plugin review-subagent tool (pi adapter). */
  toolName: string;
  /** Selected coding-rules directory or compatibility file, or null if none. */
  rulesSource: ReviewRulesSource | null;
  /** Optional free-form change-intent hint from the command arguments. */
  intentHint?: string;
}

/**
 * Build the protocol text injected into the current agent's turn. The agent --
 * not the plugin -- drives the reviewer subagent and the re-audit loop, because
 * the extension API has no subagent-spawn method.
 */
export function buildReviewProtocol(opts: ProtocolOptions): string {
  let rulesLine =
    "coding rules source: none found -- pass an empty string and skip rule-compliance checks";
  if (opts.rulesSource?.kind === "directory") {
    rulesLine = `coding rules directory: ${opts.rulesSource.path} -- read coding-rules.md once when present, then every coding-rules.<language>.md matching the changed files`;
  } else if (opts.rulesSource) {
    rulesLine = `coding rules compatibility file: ${opts.rulesSource.path} -- read this shared file`;
  }

  const hint = opts.intentHint
    ? `\n   - user-provided change-intent hint: ${opts.intentHint}`
    : "";

  const spawnStep =
    opts.runtime === "omp"
      ? `3. Spawn an independent reviewer with the \`task\` tool: \`agent: "reviewer"\`, a shared \`context\` carrying the inputs and reviewer-output contract above, and one scoped assignment to audit the uncommitted diff. \`task\` runs in the background when async is enabled -- await its delivered result (or poll \`job\`) before acting on it, and use \`irc\` to follow up with the same reviewer for re-audits. Never treat a not-yet-returned reviewer as a pass.`
      : `3. Spawn an independent reviewer by calling the \`${opts.toolName}\` tool with \`task\` set to the inputs and reviewer-output contract above plus "Audit the current uncommitted diff and return actionable findings only." Each re-audit is a fresh \`${opts.toolName}\` call, so include the previous stable-ID findings and every disposition with its evidence in the next \`task\`.`;

  return [
    "Run the uncommitted-change review process on the current working tree. Do NOT declare the result a pass until the reviewer's final pass has returned with zero blocking findings.",
    "",
    "Inputs to assemble for the reviewer:",
    "   - original ask;",
    "   - change intent (what changed and why);",
    "   - intended behavior (what should now be true, and what must remain unchanged);",
    `   - ${rulesLine};${hint}`,
    "   - verification evidence: each exact command, exit status, and observed output or counts;",
    "   - reviewer-output contract: stable finding IDs (`B1`, `N1`), `blocking` or `non-blocking` labels, and exactly `Blocking findings: N` as the final line.",
    "",
    "Steps:",
    "1. Write the concise change-intent brief and a checklist containing every requirement from the original ask.",
    "2. Confirm there are uncommitted changes to review (staged, unstaged, or untracked).",
    spawnStep,
    "4. Resolve all findings from the reviewer response as one batch: apply each fix, reject it with code/test/request evidence, or ask one clarifying question. Send one consolidated response listing each stable finding ID, its disposition, and its evidence, then request one re-audit. Require the reviewer to classify every prior ID as `resolved`, `rejected with sufficient evidence`, or `still open`. Continue until the reviewer reports `Blocking findings: 0` or 6 total audit rounds are reached; if blocking findings remain at the limit, stop and escalate to the user.",
    "5. After the latest file change, run the relevant verification yourself (tests/build as appropriate). Fix failures and rerun affected verification until it passes or the review is blocked.",
    "6. Request a final re-audit of the exact verified worktree. Any file change after successful verification or after the reviewer response invalidates that evidence: rerun affected verification, then request another final re-audit. Do not report pass until one unchanged worktree has both successful verification and a final `Blocking findings: 0` response.",
    "7. Immediately before reporting, collect fresh `git status --short`, unstaged `git diff --numstat`, and staged `git diff --cached --numstat`. Merge and deduplicate their paths. For a path present in both diffs, derive final combined statistics instead of adding overlapping counts. Count each untracked file as a full-file addition; use `binary` when line counts are unavailable. Do not reuse Git evidence captured before the final re-audit.",
    "8. Publish the final report: status (pass | blocked), the required Files changed and Verification tables below, reviewer rounds, findings applied, findings rejected with evidence, non-blocking/nit deferred, final reviewer result, and remaining risk. Use `None` for empty sections and do not repeat the same finding in multiple sections. Cite the final reviewer response and actual verification output.",
    "",
    "### Files changed",
    "",
    "| Filename | Diff | Reason |",
    "|---|---|---|",
    "| `path/from/repository/root` | `+<added> / -<removed>` — <concise diff summary> | <why this file changed> |",
    "",
    "Include every staged, unstaged, and untracked changed file exactly once. Use repository-relative filenames and the fresh Git facts from step 7. In Diff, combine line statistics with a concise human-readable summary; use `binary` when line counts are unavailable. In Reason, tie the change to the approved ask or a reviewer finding.",
    "",
    "### Verification",
    "",
    "| Command | Result | Evidence |",
    "|---|---|---|",
    "| `<exact command>` | `exit <code>` | <observed output or counts> |",
    "",
    "Include only commands actually run against the final unchanged worktree. Record the exact command, exit status, and observed output or counts. If verification could not run, write `Not run` with the reason and do not imply success.",
  ].join("\n");
}
