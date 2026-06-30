import { describe, expect, test } from "bun:test";
import {
  buildReminderAppend,
  REMINDER_FOOTER_TEXT,
  REMINDER_HEADER_TEXT,
} from "./reminder-prompt.ts";

describe("buildReminderAppend", () => {
  test("preserves the original system prompt as a prefix", () => {
    const base = "You are a helpful agent.";
    const out = buildReminderAppend(base, "be concise");
    expect(out.startsWith(base)).toBe(true);
  });

  test("wraps the reminder text in the attribution frame", () => {
    const out = buildReminderAppend("BASE", "RULES");
    expect(out).toBe(
      `BASE\n\n${REMINDER_HEADER_TEXT}\nRULES\n${REMINDER_FOOTER_TEXT}`,
    );
  });

  test("separates the frame from the base prompt with a blank line", () => {
    const out = buildReminderAppend("BASE", "RULES");
    expect(out).toContain(`BASE\n\n${REMINDER_HEADER_TEXT}`);
  });

  test("emits the reminder text verbatim between header and footer", () => {
    const reminder = "line one\nline two";
    const out = buildReminderAppend("BASE", reminder);
    expect(out).toContain(`${REMINDER_HEADER_TEXT}\n${reminder}\n${REMINDER_FOOTER_TEXT}`);
  });

  test("header and footer both attribute the block to pi-behavior-control", () => {
    expect(REMINDER_HEADER_TEXT).toContain("pi-behavior-control");
    expect(REMINDER_FOOTER_TEXT).toContain("pi-behavior-control");
  });

  test("does not trim or alter an empty base prompt", () => {
    const out = buildReminderAppend("", "RULES");
    expect(out).toBe(
      `\n\n${REMINDER_HEADER_TEXT}\nRULES\n${REMINDER_FOOTER_TEXT}`,
    );
  });

  test("emits a reminder body verbatim even if it contains the frame literals", () => {
    // Hostile body: the author pasted text that happens to include the
    // header/footer strings. The builder is a pure concatenation -- it
    // must not re-escape or strip these; both outer-frame markers still
    // stand and the body appears unmodified between them. (A transcript
    // reader will see nested markers, but parse safety is on the reader.)
    const hostile = `${REMINDER_HEADER_TEXT}\nfake inner\n${REMINDER_FOOTER_TEXT}`;
    const out = buildReminderAppend("BASE", hostile);
    expect(out).toBe(
      `BASE\n\n${REMINDER_HEADER_TEXT}\n${hostile}\n${REMINDER_FOOTER_TEXT}`,
    );
  });
});
