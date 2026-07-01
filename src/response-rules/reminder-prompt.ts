// System-prompt append for the response-rules reminder injected at the start
// of every agent turn (before_agent_start). The reminder text is wrapped in an
// attribution frame -- matching the post-edit review frame in ../post-edit-review/review-prompt.ts
// -- so that if the system prompt is ever surfaced (e.g. /export, prompt
// inspectors) it is unambiguous that pi-behavior-control authored this block
// rather than the user's own base prompt.

const REMINDER_HEADER =
  "\u2500\u2500 pi-behavior-control: response rules \u2500\u2500";
const REMINDER_FOOTER =
  "\u2500\u2500 end pi-behavior-control response rules \u2500\u2500";

/**
 * Append the framed reminder block to an existing system prompt.
 *
 * before_agent_start exposes the fully assembled system prompt and accepts a
 * full replacement; the documented append pattern is
 * `{ systemPrompt: event.systemPrompt + extra }`. This builds that `extra`
 * tail (with leading blank lines for separation) appended to `systemPrompt`.
 *
 * Pure: no IO, no trimming of the caller's prompt. `reminderText` is emitted
 * verbatim between the header and footer.
 */
export function buildReminderAppend(
  systemPrompt: string,
  reminderText: string,
): string {
  return `${systemPrompt}\n\n${REMINDER_HEADER}\n${reminderText}\n${REMINDER_FOOTER}`;
}

/** Exposed for tests: the attribution frame wrapped around the reminder. */
export const REMINDER_HEADER_TEXT = REMINDER_HEADER;
export const REMINDER_FOOTER_TEXT = REMINDER_FOOTER;
