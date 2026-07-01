import { describe, expect, test } from "bun:test";
import {
  REVIEW_TOOL_NAME,
  REVIEWER_SYSTEM_PROMPT,
  REVIEWER_TOOLS,
  buildReviewProtocol,
} from "./review-protocol.ts";

describe("buildReviewProtocol", () => {
  test("omp adapter drives the native task tool with an irc loop", () => {
    const text = buildReviewProtocol({
      runtime: "omp",
      toolName: REVIEW_TOOL_NAME,
      rulesPath: "/repo/coding-rules.md",
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
      rulesPath: "/repo/coding-rules.md",
    });
    expect(text).toContain(`\`${REVIEW_TOOL_NAME}\` tool`);
    expect(text).not.toContain("`task` tool");
  });

  test("includes the resolved coding-rules path when present", () => {
    const text = buildReviewProtocol({
      runtime: "pi",
      toolName: REVIEW_TOOL_NAME,
      rulesPath: "/repo/coding-rules.md",
    });
    expect(text).toContain("coding rules file: /repo/coding-rules.md");
  });

  test("falls back to empty-string rules guidance when absent", () => {
    const text = buildReviewProtocol({
      runtime: "pi",
      toolName: REVIEW_TOOL_NAME,
      rulesPath: null,
    });
    expect(text).toContain("none found");
    expect(text).toContain("skip rule-compliance checks");
  });

  test("forbids declaring a pass before the reviewer's final pass returns", () => {
    const text = buildReviewProtocol({
      runtime: "omp",
      toolName: REVIEW_TOOL_NAME,
      rulesPath: null,
    });
    expect(text).toContain(
      "Do NOT declare the result a pass until the reviewer's final pass has returned with zero blocking findings",
    );
  });

  test("includes a change-intent hint when provided", () => {
    const text = buildReviewProtocol({
      runtime: "pi",
      toolName: REVIEW_TOOL_NAME,
      rulesPath: null,
      intentHint: "tighten the auth refactor",
    });
    expect(text).toContain("tighten the auth refactor");
    expect(text).toContain("change-intent hint");
  });

  test("omits the hint line when no hint is given", () => {
    const text = buildReviewProtocol({
      runtime: "pi",
      toolName: REVIEW_TOOL_NAME,
      rulesPath: null,
    });
    expect(text).not.toContain("change-intent hint");
  });
});

describe("reviewer persona", () => {
  test("is read-only with the corrected git allowlist", () => {
    expect(REVIEWER_SYSTEM_PROMPT).toContain("git status --short");
    expect(REVIEWER_SYSTEM_PROMPT).toContain("git diff --cached");
    expect(REVIEWER_SYSTEM_PROMPT).toContain("Do NOT edit files");
  });

  test("grants read-only discovery tools, not edit/write", () => {
    expect(REVIEWER_TOOLS).toContain("bash");
    expect(REVIEWER_TOOLS).not.toContain("edit");
    expect(REVIEWER_TOOLS).not.toContain("write");
  });
});
