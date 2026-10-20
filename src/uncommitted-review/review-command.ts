import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { resolveRulesSource } from "../post-edit-review/rules-source.ts";
import { REVIEW_TOOL_NAME, buildReviewProtocol } from "./review-protocol.ts";
import { detectReviewRuntime } from "./runtime-detect.ts";

export type Precondition = "ok" | "not-a-repo" | "clean" | "git-error";

// Git status is required to decide whether review can start. Timeouts and
// execution failures are distinct from a clean tree and stop the command.
export async function checkPreconditions(
  pi: ExtensionAPI,
  cwd: string,
): Promise<Precondition> {
  try {
    const result = await pi.exec("git", ["status", "--short"], {
      cwd,
      timeout: 5000,
    });
    if (result.killed) return "git-error";
    if (result.code !== 0) return "not-a-repo";
    if (result.stdout.trim().length === 0) return "clean";
    return "ok";
  } catch {
    return "git-error";
  }
}

// `getActiveTools` is the one ExtensionAPI call here without the try/catch
// backstop that checkPreconditions has. Degrade to an empty list (-> runtime
// "none" -> the "unavailable" notice) rather than throwing out of the command
// if a runtime does not expose it.
export function activeToolsSafe(pi: ExtensionAPI): readonly string[] {
  try {
    return pi.getActiveTools();
  } catch {
    return [];
  }
}

// Register `/behavior-control:review`. Runs regardless of the enable/disable
// gate (an explicit user invocation, like `status`/`set-verifier`). Detects the
// runtime's reviewer mechanism and injects the matching review protocol for the
// current agent to drive; the plugin cannot spawn the reviewer itself.
export function registerReviewCommand(pi: ExtensionAPI): void {
  pi.registerCommand("behavior-control:review", {
    description:
      "Run the uncommitted-change review process (spawns a read-only reviewer subagent).",
    handler: async (args, ctx) => {
      const precondition = await checkPreconditions(pi, ctx.cwd);
      if (precondition === "git-error") {
        ctx.ui.notify(
          "pi-behavior-control: could not inspect Git status — review not started.",
          "error",
        );
        return;
      }
      if (precondition === "not-a-repo") {
        ctx.ui.notify(
          "pi-behavior-control: not a git repository — nothing to review.",
          "info",
        );
        return;
      }
      if (precondition === "clean") {
        ctx.ui.notify(
          "pi-behavior-control: no uncommitted changes — nothing to review.",
          "info",
        );
        return;
      }

      const runtime = detectReviewRuntime(activeToolsSafe(pi));
      if (runtime === "none") {
        ctx.ui.notify(
          `pi-behavior-control: no reviewer mechanism available — need OMP's \`task\` tool or the bundled \`${REVIEW_TOOL_NAME}\` tool. Review unavailable.`,
          "error",
        );
        return;
      }

      const rulesSource = resolveRulesSource(ctx.cwd);
      const intentHint = args.trim().length > 0 ? args.trim() : undefined;
      const prompt = buildReviewProtocol({
        runtime,
        toolName: REVIEW_TOOL_NAME,
        rulesSource: rulesSource
          ? { kind: rulesSource.kind, path: rulesSource.path }
          : null,
        intentHint,
      });
      pi.sendUserMessage(prompt);
    },
  });
}
