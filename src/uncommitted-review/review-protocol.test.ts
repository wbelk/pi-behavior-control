import { describe, expect, test } from "bun:test";
import {
  REVIEW_TOOL_NAME,
  REVIEWER_TOOLS,
  buildReviewProtocol,
} from "./review-protocol.ts";

describe("buildReviewProtocol", () => {
  test("omp adapter drives the native task tool with an irc loop", () => {
    const text = buildReviewProtocol({
      runtime: "omp",
      toolName: REVIEW_TOOL_NAME,
      rulesSource: { kind: "directory", path: "/repo/coding-rules" },
    });
    expect(text).toContain("`task` tool");
    expect(text).toContain('agent: "reviewer"');
    expect(text).toContain("`irc`");
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
