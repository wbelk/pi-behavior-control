import { describe, expect, test } from "bun:test";
import {
  REVIEW_TOOL_NAME,
  REVIEWER_TOOLS,
  buildReviewProtocol,
} from "./review-protocol.ts";

describe("buildReviewProtocol", () => {
  test("omp adapter starts a fresh task reviewer per round without polling", () => {
    const text = buildReviewProtocol({
      runtime: "omp",
      toolName: REVIEW_TOOL_NAME,
      rulesSource: { kind: "directory", path: "/repo/coding-rules" },
    });
    expect(text).toContain("`task` tool");
    expect(text).toContain('agent: "reviewer"');
    expect(text).toContain("delivers the reviewer result automatically");
    expect(text).toContain("do not poll");
    expect(text).toContain("use `wait`");
    expect(text).toContain("call `task` again with a fresh reviewer");
    expect(text).toContain("original review inputs");
    expect(text).toContain("previous stable-ID finding");
    expect(text).toContain("current verification evidence");
    expect(text).not.toMatch(/\b(?:async|job|irc)\b/);
    expect(text).not.toContain(`\`${REVIEW_TOOL_NAME}\` tool`);
  });

  test("pi adapter drives the bundled review tool by name", () => {
    const text = buildReviewProtocol({
      runtime: "pi",
      toolName: REVIEW_TOOL_NAME,
      rulesSource: { kind: "directory", path: "/repo/coding-rules" },
    });
    expect(text).toContain(`\`${REVIEW_TOOL_NAME}\` tool`);
    expect(text).not.toContain("`task` tool");
  });

  test("reports only files changed to resolve reviewer findings", () => {
    const text = buildReviewProtocol({
      runtime: "omp",
      toolName: REVIEW_TOOL_NAME,
      rulesSource: null,
    });
    expect(text).toContain("### Changes made during review");
    expect(text).toContain("| Filename | Finding | Change |");
    expect(text).toContain("only files modified while resolving reviewer findings");
    expect(text).toContain("Exclude files changed only by the original implementation");
    expect(text).toContain("If the review caused no file changes, write `None`");
    expect(text).toContain("`git status --short`");
    expect(text).toContain("`git diff --no-ext-diff --binary --no-textconv`");
    expect(text).toContain(
      "`git diff --cached --no-ext-diff --binary --no-textconv`",
    );
    expect(text).toContain("content hashes for every untracked file");
    expect(text).toContain("compare them byte-for-byte");
    expect(text).toContain("Use this evidence only to confirm the worktree is unchanged");
    expect(text).not.toContain("### Files changed");
    expect(text).not.toContain("git diff --numstat");
    expect(text).not.toContain("| Filename | Diff | Reason |");
  });

  test("tells the reviewer how to apply directory rules", () => {
    const text = buildReviewProtocol({
      runtime: "pi",
      toolName: REVIEW_TOOL_NAME,
      rulesSource: { kind: "directory", path: "/repo/coding-rules" },
    });
    expect(text).toContain("coding rules directory: /repo/coding-rules");
    expect(text).toContain("coding-rules.<language>.md");
    expect(text).toContain("matching the changed files");
  });

  test("tells the reviewer to read a compatibility file as shared rules", () => {
    const text = buildReviewProtocol({
      runtime: "pi",
      toolName: REVIEW_TOOL_NAME,
      rulesSource: { kind: "file", path: "/repo/coding-rules.md" },
    });
    expect(text).toContain(
      "coding rules compatibility file: /repo/coding-rules.md",
    );
    expect(text).toContain("read this shared file");
  });

  test("skips rule-compliance checks when no source exists", () => {
    const text = buildReviewProtocol({
      runtime: "pi",
      toolName: REVIEW_TOOL_NAME,
      rulesSource: null,
    });
    expect(text).toContain("none found");
    expect(text).toContain("skip rule-compliance checks");
  });

  test("includes a change-intent hint when provided", () => {
    const text = buildReviewProtocol({
      runtime: "pi",
      toolName: REVIEW_TOOL_NAME,
      rulesSource: null,
      intentHint: "tighten the auth refactor",
    });
    expect(text).toContain("tighten the auth refactor");
    expect(text).toContain("change-intent hint");
  });

  test("omits the hint line when no hint is given", () => {
    const text = buildReviewProtocol({
      runtime: "pi",
      toolName: REVIEW_TOOL_NAME,
      rulesSource: null,
    });
    expect(text).not.toContain("change-intent hint");
  });
});

describe("reviewer persona", () => {
  test("grants read/search tools without shell or write access", () => {
    expect(REVIEWER_TOOLS).toEqual(["read", "grep", "find", "ls"]);
    expect(REVIEWER_TOOLS).not.toContain("bash");
    expect(REVIEWER_TOOLS).not.toContain("edit");
    expect(REVIEWER_TOOLS).not.toContain("write");
  });
});
