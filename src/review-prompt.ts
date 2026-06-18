// Post-edit review reminder text. The brief and "Fail-Loud Contract" /
// "Approval gate" sections are a verbatim port of `review-file.sh` from
// the upstream Claude `behavior-hooks` skill.
// Spec: section 7 hook 6 of tasks/plan-pi-behavior-control.md.

const REVIEW_BRIEF = `Review this file as a senior engineer and architect before submission. Review for style, elegance, and efficiency. Is every line of code consistent with the intended design and architecture? Trace every caller, upstream, and downstream execution path in this file -- does this code match the intent? Does the code have any conditional logic that supports soft-failing instead of fixing the root cause of any potential issues? Are any arguments conditional that should be required? Broken logic should break the app and the tests. Always try to achieve DRY -- do not repeat yourself. Set reused references to vars, always try to create reusable and shareable modules/methods/functions. Write tests that match code intent, included all edge cases and functional scenarios — tests should not just test the code as written. Fix any issues, soft-failure scenarios, future-proofing without explicit user direction, and errors with the code before submitting.

Fail-Loud Contract violations to flag:
- \`if (requiredArg)\` guards around required work — delete; code must break.
- \`function () {}\` or \`() => {}\` empty callbacks that silence errors.
- Optional args that are actually required — promote to positional required.
- \`if (cb) { cb() }\` protections on required callbacks.
- Helper signature changes without every caller grepped and listed.

Approval gate:
- Auto-fix findings directly. Do not ask for approval per finding unless the fix requires clarification (unclear intent, multiple valid approaches, or scope ambiguity).
- If a finding needs clarification: present the finding with options and ask question(s). Do not fix until answered.
- If your prior response claimed completion: confirm \`node scripts/run-tests.js\` ran with 0 failing this turn. If not, retract the claim.
- If any part of the approved scope was skipped or altered: list each deviation.`;

// Attribution frame wrapped around the brief when it is appended to an
// edit/write tool result. The brief is injected into the tool result's
// `content`, so without a frame it renders as if it were the edit tool's own
// output -- no label, indistinguishable from the diff/result. The
// header/footer make it unambiguous that pi-behavior-control authored this
// text, for a human skimming the transcript and for the agent reading the
// tool result.
const REVIEW_HEADER =
	"\u2500\u2500 pi-behavior-control: post-edit review \u2500\u2500";
const REVIEW_FOOTER = "\u2500\u2500 end pi-behavior-control review \u2500\u2500";

/**
 * Build the post-edit review reminder appended to a successful edit/write
 * tool result. The brief (plus optional rules) is wrapped in an attribution
 * frame (`REVIEW_HEADER` / `REVIEW_FOOTER`) so it is not mistaken for the
 * edit tool's own output when rendered inside the tool result.
 *
 * If `rules` is a non-empty string, the coding-rules text is appended after
 * the review brief (mirrors the original script's behavior of inlining the
 * full rules file). If `rules` is null/undefined/empty, the rules block is
 * omitted entirely — the brief itself stands alone.
 */
export function buildReviewInstruction(rules?: string | null): string {
	const body =
		rules && rules.length > 0
			? `${REVIEW_BRIEF}\n\nCoding rules reference:\n${rules}`
			: REVIEW_BRIEF;
	return `${REVIEW_HEADER}\n${body}\n${REVIEW_FOOTER}`;
}

/** Exposed for tests that want to assert on the brief without invoking. */
export const REVIEW_BRIEF_TEXT = REVIEW_BRIEF;

/** Exposed for tests: the attribution frame wrapped around the brief. */
export const REVIEW_HEADER_TEXT = REVIEW_HEADER;
export const REVIEW_FOOTER_TEXT = REVIEW_FOOTER;
