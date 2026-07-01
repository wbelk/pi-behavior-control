import { REVIEW_TOOL_NAME } from "./review-protocol.ts";

export type ReviewRuntime = "omp" | "pi" | "none";

// Decide which reviewer mechanism the current agent should drive, from the
// session's active tools.
//
//   - OMP exposes the native `task` tool -> preferred (richer loop via `irc`
//     and `job`, no child process, bundled `reviewer` agent).
//   - Upstream pi has no `task`; the plugin registers REVIEW_TOOL_NAME there
//     (and on OMP too, but `task` wins).
//   - Neither present -> review is unavailable (the process's "stop and report
//     unavailable" branch).
//
// `task` takes precedence so OMP always uses its native mechanism even though
// the plugin's tool is also registered.
export function detectReviewRuntime(
  activeTools: readonly string[],
  reviewToolName: string = REVIEW_TOOL_NAME,
): ReviewRuntime {
  if (activeTools.includes("task")) return "omp";
  if (activeTools.includes(reviewToolName)) return "pi";
  return "none";
}
