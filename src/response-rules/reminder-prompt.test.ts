import { describe, expect, test } from "bun:test";
import {
  buildReminderAppend,
  REMINDER_FOOTER_TEXT,
  REMINDER_HEADER_TEXT,
} from "./reminder-prompt.ts";

describe("buildReminderAppend", () => {
  test("wraps the reminder text in the attribution frame", () => {
    const out = buildReminderAppend("BASE", "RULES");
    expect(out).toBe(
      `BASE\n\n${REMINDER_HEADER_TEXT}\nRULES\n${REMINDER_FOOTER_TEXT}`,
    );
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
