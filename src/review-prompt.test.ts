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

	test("omits the rules section entirely when rules is absent", () => {
		const result = buildReviewInstruction(undefined);
		expect(result).not.toContain("Coding rules reference:");
	});

	test("output starts with the header and ends with the footer", () => {
		const result = buildReviewInstruction(undefined);
		expect(result.startsWith(`${REVIEW_HEADER_TEXT}\n`)).toBe(true);
		expect(result.endsWith(`\n${REVIEW_FOOTER_TEXT}`)).toBe(true);
	});

	test("header attributes the text to pi-behavior-control", () => {
		expect(REVIEW_HEADER_TEXT).toContain("pi-behavior-control");
		expect(REVIEW_HEADER_TEXT).toContain("review");
	});

	test("includes the brief and the rules section inside the frame when rules is present", () => {
		const result = buildReviewInstruction("Be concise.");
		expect(result.startsWith(`${REVIEW_HEADER_TEXT}\n`)).toBe(true);
		expect(result.endsWith(`\n${REVIEW_FOOTER_TEXT}`)).toBe(true);
		expect(result).toContain(REVIEW_BRIEF_TEXT);
		expect(result).toContain("\n\nCoding rules reference:\nBe concise.\n");
	});

	test("brief contains the Approval gate section", () => {
		expect(REVIEW_BRIEF_TEXT).toContain("Approval gate");
	});
});
