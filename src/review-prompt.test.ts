import { describe, expect, test } from "bun:test";
import { REVIEW_BRIEF_TEXT, buildReviewInstruction } from "./review-prompt.ts";

describe("buildReviewInstruction", () => {
	test("returns the brief verbatim when rules is undefined", () => {
		expect(buildReviewInstruction(undefined)).toBe(REVIEW_BRIEF_TEXT);
	});

	test("returns the brief verbatim when rules is null", () => {
		expect(buildReviewInstruction(null)).toBe(REVIEW_BRIEF_TEXT);
	});

	test("returns the brief verbatim when rules is empty string", () => {
		expect(buildReviewInstruction("")).toBe(REVIEW_BRIEF_TEXT);
	});

	test("appends 'Coding rules reference:' and the rules text when rules is present", () => {
		const result = buildReviewInstruction("Be concise.");
		expect(result.startsWith(REVIEW_BRIEF_TEXT)).toBe(true);
		expect(result.endsWith("\n\nCoding rules reference:\nBe concise.")).toBe(true);
	});

	test("brief contains the Fail-Loud Contract section", () => {
		expect(REVIEW_BRIEF_TEXT).toContain("Fail-Loud Contract violations");
	});

	test("brief contains the Approval gate section", () => {
		expect(REVIEW_BRIEF_TEXT).toContain("Approval gate");
	});
});
