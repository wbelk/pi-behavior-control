import { describe, expect, test } from "bun:test";
import {
  buildReviewInstruction,
  REVIEW_BRIEF_TEXT,
  REVIEW_FOOTER_TEXT,
  REVIEW_HEADER_TEXT,
} from "./review-prompt.ts";

describe("buildReviewInstruction", () => {
  test("wraps the bare brief in the attribution frame when rules is absent", () => {
    expect(buildReviewInstruction(undefined)).toBe(
      `${REVIEW_HEADER_TEXT}\n${REVIEW_BRIEF_TEXT}\n${REVIEW_FOOTER_TEXT}`,
    );
  });

  test("treats null and empty-string rules the same as undefined", () => {
    const expected = buildReviewInstruction(undefined);
    expect(buildReviewInstruction(null)).toBe(expected);
    expect(buildReviewInstruction("")).toBe(expected);
  });

  test("includes the brief and the rules section inside the frame when rules is present", () => {
    const result = buildReviewInstruction("Be concise.");
    expect(result.startsWith(`${REVIEW_HEADER_TEXT}\n`)).toBe(true);
    expect(result.endsWith(`\n${REVIEW_FOOTER_TEXT}`)).toBe(true);
    expect(result).toContain(REVIEW_BRIEF_TEXT);
    expect(result).toContain("\n\nCoding rules reference:\nBe concise.\n");
  });
});
