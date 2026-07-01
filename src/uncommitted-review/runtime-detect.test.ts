import { describe, expect, test } from "bun:test";
import { REVIEW_TOOL_NAME } from "./review-protocol.ts";
import { detectReviewRuntime } from "./runtime-detect.ts";

describe("detectReviewRuntime", () => {
  test("native task -> omp", () => {
    expect(detectReviewRuntime(["read", "task", "edit"])).toBe("omp");
  });

  test("plugin tool without task -> pi", () => {
    expect(detectReviewRuntime(["read", REVIEW_TOOL_NAME])).toBe("pi");
  });

  test("task wins when both are present", () => {
    expect(detectReviewRuntime([REVIEW_TOOL_NAME, "task"])).toBe("omp");
  });

  test("neither present -> none", () => {
    expect(detectReviewRuntime(["read", "edit", "write"])).toBe("none");
  });

  test("empty tool list -> none", () => {
    expect(detectReviewRuntime([])).toBe("none");
  });

  test("honors a custom review tool name", () => {
    expect(detectReviewRuntime(["custom_review"], "custom_review")).toBe("pi");
  });
});
