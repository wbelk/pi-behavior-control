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

// Read-only tool set handed to the child reviewer `pi` process. `bash` is
// included for read-only git discovery only; the persona forbids writes.
export const REVIEWER_TOOLS: readonly string[] = [
  "read",
  "grep",
  "find",
  "ls",
  "bash",
];

// Reviewer-agent persona appended to the child `pi` system prompt (pi adapter).
// Mirrors the agent-reviewer process "Reviewer Prompt Shape": adversarial,
// read-only, evidence-first, with the corrected git allowlist (`git status
// --short` and `git diff --cached`, which the upstream sample reviewer omits).
export const REVIEWER_SYSTEM_PROMPT = `You are an adversarial code-review principal engineer reviewing uncommitted changes only. Be skeptical, evidence-first, rules-driven, and focused on root-cause fixes instead of style preference.

Instructions:
1. Read the coding rules file if a path is provided; an empty path means the project has no rules -- skip rule-compliance checks and audit correctness, caller impact, and verification only.
2. Independently discover staged, unstaged, and untracked changes; do not trust a supplied changed-file list.
3. Allowed read-only commands: \`git status --short\`, \`git diff\`, \`git diff --cached\`, and file reads/searches. Do NOT edit files or run builds, formatters, or project-wide tests.
4. Treat untracked files as full-file additions.
5. Read enough surrounding code and callsites to verify impact.
6. Audit for correctness, rule compliance, caller impact, and missing verification.
7. Return actionable findings only. For each finding include file/hunk, the violated rule or invariant, impact, and a proposed fix.`;

export interface ProtocolOptions {
  /** Which adapter the current agent should drive. */
  runtime: "omp" | "pi";
  /** Registered name of the plugin review-subagent tool (pi adapter). */
  toolName: string;
  /** Absolute path to the resolved coding-rules file, or null if none. */
  rulesPath: string | null;
  /** Optional free-form change-intent hint from the command arguments. */
  intentHint?: string;
}

/**
 * Build the protocol text injected into the current agent's turn. The agent --
 * not the plugin -- drives the reviewer subagent and the re-audit loop, because
 * the extension API has no subagent-spawn method.
 */
export function buildReviewProtocol(opts: ProtocolOptions): string {
  const rulesLine = opts.rulesPath
    ? `coding rules file: ${opts.rulesPath}`
    : "coding rules file: none found -- pass an empty string and skip rule-compliance checks";

  const hint = opts.intentHint
    ? `\n   - user-provided change-intent hint: ${opts.intentHint}`
    : "";

  const spawnStep =
    opts.runtime === "omp"
      ? `3. Spawn an independent reviewer with the \`task\` tool: \`agent: "reviewer"\`, a shared \`context\` carrying the inputs above, and one scoped assignment to audit the uncommitted diff. \`task\` runs in the background when async is enabled -- await its delivered result (or poll \`job\`) before acting on it, and use \`irc\` to follow up with the same reviewer for re-audits. Never treat a not-yet-returned reviewer as a pass.`
      : `3. Spawn an independent reviewer by calling the \`${opts.toolName}\` tool with \`task\` set to the inputs above plus "Audit the current uncommitted diff and return actionable findings only." Each re-audit is a fresh \`${opts.toolName}\` call.`;

  return [
    "Run the uncommitted-change review process on the current working tree. Do NOT declare the result a pass until the reviewer's final pass has returned with zero blocking findings.",
    "",
    "Inputs to assemble for the reviewer:",
    "   - original ask;",
    "   - change intent (what changed and why);",
    "   - intended behavior (what should now be true, and what must remain unchanged);",
    `   - ${rulesLine};${hint}`,
    "   - any verification already run.",
    "",
    "Steps:",
    "1. Write the concise change-intent brief from the inputs above.",
    "2. Confirm there are uncommitted changes to review (staged, unstaged, or untracked).",
    spawnStep,
    "4. For each finding: apply the fix, reject it with code/test/request evidence, or ask one clarifying question. Re-audit after each response. Continue until there are no blocking findings or 6 audit rounds are reached; if blocking findings remain at the limit, stop and escalate to the user.",
    "5. Run the relevant verification yourself (tests/build as appropriate).",
    "6. Publish the final report: status (pass | blocked), files changed, reviewer rounds, findings applied, findings rejected with evidence, non-blocking/nit deferred, verification run, final reviewer result, and remaining risk. Cite the reviewer's final pass and your actual verification.",
  ].join("\n");
}
