import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadRules } from "../post-edit-review/rules-source.ts";
import { REVIEW_TOOL_NAME, buildReviewProtocol } from "./review-protocol.ts";
import { detectReviewRuntime } from "./runtime-detect.ts";

export type Precondition = "ok" | "not-a-repo" | "clean";

// Best-effort precondition check (the process's "Preconditions" section). The
// try/catch degrades to "ok" when `pi.exec` is unavailable on the runtime or
// git fails to spawn, so the injected protocol's own precondition step is the
// backstop rather than crashing the command.
export async function checkPreconditions(
  pi: ExtensionAPI,
  cwd: string,
): Promise<Precondition> {
  try {
    const result = await pi.exec("git", ["status", "--short"], {
      cwd,
      timeout: 5000,
    });
    // A timeout/abort returns killed:true with a non-zero code. That is not a
    // "not a repo" signal -- degrade to "ok" so the injected protocol's own
    // precondition step runs instead of a false "nothing to review".
    if (result.killed) return "ok";
    if (result.code !== 0) return "not-a-repo";
    if (result.stdout.trim().length === 0) return "clean";
    return "ok";
  } catch {
    return "ok";
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
      if (precondition === "not-a-repo") {
        ctx.ui.notify(
          "pi-behavior-control: not a git repository (or git unavailable) — nothing to review.",
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

      const rules = loadRules(ctx.cwd);
      const intentHint = args.trim().length > 0 ? args.trim() : undefined;
      const prompt = buildReviewProtocol({
        runtime,
        toolName: REVIEW_TOOL_NAME,
        rulesPath: rules?.path ?? null,
        intentHint,
      });
      pi.sendUserMessage(prompt);
    },
  });
}
