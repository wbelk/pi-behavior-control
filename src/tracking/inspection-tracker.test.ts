import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  cleanToken,
  InspectionTracker,
  isPlausiblePath,
  tokenize,
} from "./inspection-tracker.ts";

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-bc-inspection-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function writeFile(name: string, body = ""): string {
  const p = path.join(tmp, name);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, body, "utf-8");
  return p;
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("tokenize", () => {
  test("splits on whitespace and bracket-family punctuation", () => {
    const out = tokenize("foo bar [baz] (qux),quux;corge'grault\"garply");
    expect(out).toEqual([
      "foo",
      "bar",
      "baz",
      "qux",
      "quux",
      "corge",
      "grault",
      "garply",
    ]);
  });

  test("does NOT split on colons (path:line citations stay glued)", () => {
    expect(tokenize("src/foo.ts:42 src/bar.ts:7:3")).toEqual([
      "src/foo.ts:42",
      "src/bar.ts:7:3",
    ]);
  });

  test("splits on backticks so markdown code-spans like `path:line` separate", () => {
    // This is the canonical citation format prompted to the agent — see
    // the SYSTEM_PROMPT example in ../speculation-check/speculation.ts.
    // Without backtick splitting, the wrapped path stays glued and never resolves.
    expect(tokenize("see `services/sources.js:47` for context")).toEqual([
      "see",
      "services/sources.js:47",
      "for",
      "context",
    ]);
  });

  test("preserves quoted runs as single tokens (path with whitespace)", () => {
    // The quoted-run pass exists so paths containing spaces survive
    // extraction when the agent or tool wraps them in matched quotes.
    // Source order matters — the quoted token must appear in the same
    // position it occupies in the input, not before/after the residue.
    expect(tokenize('see "my file.ts" too')).toEqual([
      "see",
      "my file.ts",
      "too",
    ]);
    expect(tokenize("opens `path with space.ts` cleanly")).toEqual([
      "opens",
      "path with space.ts",
      "cleanly",
    ]);
    expect(tokenize("'a b c.ts'")).toEqual(["a b c.ts"]);
  });

  test("trims whitespace inside a quoted run", () => {
    expect(tokenize('"   src/foo.ts   "')).toEqual(["src/foo.ts"]);
  });

  test("an unmatched quote degrades to separator behavior", () => {
    // `don't` has no matching closing quote so the apostrophe must act
    // as a separator (preserving the pre-fix behavior for unmatched
    // quotes that occur naturally in prose).
    expect(tokenize("don't open src/foo.ts")).toEqual([
      "don",
      "t",
      "open",
      "src/foo.ts",
    ]);
  });

  test("does not match a quote that crosses a newline", () => {
    // Cross-line `"` pairs would falsely grab whole paragraphs. Newline
    // terminates the same-line scan, so the opening quote ends up
    // treated as an unmatched separator.
    expect(tokenize('open "src/foo.ts\nnext line')).toEqual([
      "open",
      "src/foo.ts",
      "next",
      "line",
    ]);
  });

  test("collapses consecutive separators", () => {
    expect(tokenize("a   b\n\nc\t\td")).toEqual(["a", "b", "c", "d"]);
  });

  test("returns empty array for empty input", () => {
    expect(tokenize("")).toEqual([]);
  });
});

describe("cleanToken", () => {
  test("strips trailing sentence punctuation", () => {
    expect(cleanToken("src/foo.ts.")).toBe("src/foo.ts");
    expect(cleanToken("src/foo.ts,")).toBe("src/foo.ts");
    expect(cleanToken("src/foo.ts;")).toBe("src/foo.ts");
    expect(cleanToken("src/foo.ts!")).toBe("src/foo.ts");
  });

  test("strips leading bracket-family openers", () => {
    expect(cleanToken("(src/foo.ts")).toBe("src/foo.ts");
    expect(cleanToken("{src/foo.ts")).toBe("src/foo.ts");
    expect(cleanToken("<src/foo.ts")).toBe("src/foo.ts");
  });

  test("strips a #TAG suffix from `[path#TAG]` headers", () => {
    expect(cleanToken("src/foo.ts#1A2B")).toBe("src/foo.ts");
    expect(cleanToken("src/foo.ts#A")).toBe("src/foo.ts");
    expect(cleanToken("src/foo.ts#deadbeef")).toBe("src/foo.ts");
  });

  test("strips a :LINE suffix from file:line citations", () => {
    expect(cleanToken("src/foo.ts:42")).toBe("src/foo.ts");
  });

  test("strips :LINE:COL suffixes iteratively", () => {
    expect(cleanToken("src/foo.ts:42:8")).toBe("src/foo.ts");
  });

  test("strips combinations: brackets + tag + trailing colon", () => {
    // `[src/foo.ts#1A2B]:` — leading `[` stripped, trailing `]:` stripped,
    // then `#1A2B` peeled. Order matters; this asserts the regex chain
    // resolves to the bare path.
    expect(cleanToken("[src/foo.ts#1A2B]:")).toBe("src/foo.ts");
  });

  test("leaves a clean path untouched", () => {
    expect(cleanToken("src/foo.ts")).toBe("src/foo.ts");
    expect(cleanToken("/abs/path/file.md")).toBe("/abs/path/file.md");
  });

  test("strips defensive trailing/leading backticks (one-sided code spans)", () => {
    expect(cleanToken("`src/foo.ts")).toBe("src/foo.ts");
    expect(cleanToken("src/foo.ts`")).toBe("src/foo.ts");
  });
});

describe("isPlausiblePath", () => {
  test("rejects tokens without a slash or dot (words, not paths)", () => {
    expect(isPlausiblePath("hello")).toBe(false);
    expect(isPlausiblePath("toString")).toBe(false);
  });

  test("rejects all-digit tokens (line numbers, counts)", () => {
    expect(isPlausiblePath("42")).toBe(false);
    expect(isPlausiblePath("123456")).toBe(false);
  });

  test("rejects tokens shorter than 3 chars (a, b, .)", () => {
    expect(isPlausiblePath("a")).toBe(false);
    expect(isPlausiblePath(".")).toBe(false);
    expect(isPlausiblePath("/")).toBe(false);
  });

  test("rejects tokens longer than 512 chars", () => {
    expect(isPlausiblePath("a/".repeat(300))).toBe(false);
  });

  test("accepts plausible filenames and paths", () => {
    expect(isPlausiblePath("src/foo.ts")).toBe(true);
    expect(isPlausiblePath("foo.ts")).toBe(true);
    expect(isPlausiblePath("/abs/path/file.md")).toBe(true);
    expect(isPlausiblePath("../up/here.ts")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// recordFromText — integration with the filesystem
// ---------------------------------------------------------------------------

describe("recordFromText", () => {
  test("records files referenced by `[path#TAG]` header format", () => {
    const tracker = new InspectionTracker();
    writeFile("src/foo.ts", "x");
    writeFile("src/bar.ts", "y");
    // The harness emits these as `[path#TAG]` headers above match lines.
    tracker.recordFromText("[src/foo.ts#1A2B]\n[src/bar.ts#3C4D]", tmp);
    const expectedFoo = fs.realpathSync(path.join(tmp, "src/foo.ts"));
    const expectedBar = fs.realpathSync(path.join(tmp, "src/bar.ts"));
    expect(new Set(tracker.paths())).toEqual(
      new Set([expectedFoo, expectedBar]),
    );
  });

  test("records files referenced by bare path lines (fff / find output)", () => {
    const tracker = new InspectionTracker();
    writeFile("src/foo.ts");
    writeFile("src/bar.ts");
    // fff `ffgrep` and built-in `find` print the path on its own line,
    // optionally followed by indented match rows we don't care about.
    const ffgrepOutput = [
      "src/foo.ts  [staged in git]",
      " 42: const x = 1;",
      "src/bar.ts",
      " 7: const y = 2;",
    ].join("\n");
    tracker.recordFromText(ffgrepOutput, tmp);
    const expected = new Set([
      fs.realpathSync(path.join(tmp, "src/foo.ts")),
      fs.realpathSync(path.join(tmp, "src/bar.ts")),
    ]);
    expect(new Set(tracker.paths())).toEqual(expected);
  });

  test("records files cited as `path:line` and `path:line:col`", () => {
    const tracker = new InspectionTracker();
    writeFile("services/sources.js");
    tracker.recordFromText(
      "see services/sources.js:47 and services/sources.js:50:8",
      tmp,
    );
    expect(tracker.paths()).toEqual([
      fs.realpathSync(path.join(tmp, "services/sources.js")),
    ]);
  });

  test("records files cited inside markdown code spans like `path:line`", () => {
    // The agent is prompted to cite in this exact format (see the example
    // in src/speculation-check/speculation.ts SYSTEM_PROMPT). Pre-fix this case missed
    // every backtick-wrapped citation because the entire `path:line`
    // stayed glued to surrounding backticks and failed to resolve.
    const tracker = new InspectionTracker();
    writeFile("services/sources.js");
    tracker.recordFromText(
      "The lookup is `services/sources.js:47` and is grounded.",
      tmp,
    );
    expect(tracker.paths()).toEqual([
      fs.realpathSync(path.join(tmp, "services/sources.js")),
    ]);
  });

  test("does not record tokens that look like paths but do not exist", () => {
    const tracker = new InspectionTracker();
    tracker.recordFromText("see src/nonexistent.ts and lib/missing.js", tmp);
    expect(tracker.paths()).toEqual([]);
  });

  test("does not record directories — only regular files", () => {
    const tracker = new InspectionTracker();
    fs.mkdirSync(path.join(tmp, "src/nested"), { recursive: true });
    tracker.recordFromText("src/nested", tmp);
    expect(tracker.paths()).toEqual([]);
  });

  test("accepts absolute paths and canonicalizes them", () => {
    const tracker = new InspectionTracker();
    const file = writeFile("a.txt", "x");
    tracker.recordFromText(file, tmp);
    expect(tracker.paths()).toEqual([fs.realpathSync(file)]);
  });

  test("collapses symlinks to the canonical path key", () => {
    const tracker = new InspectionTracker();
    const real = writeFile("real.txt", "x");
    const link = path.join(tmp, "link.txt");
    fs.symlinkSync(real, link);
    tracker.recordFromText("link.txt real.txt", tmp);
    expect(tracker.paths()).toEqual([fs.realpathSync(real)]);
  });

  test("memoizes resolutions across calls (same token → no re-stat)", () => {
    const tracker = new InspectionTracker();
    const file = writeFile("a.txt", "x");
    const canonical = fs.realpathSync(file);
    tracker.recordFromText("a.txt", tmp);
    // Delete the file; a re-resolution would now fail at statSync. The
    // memo hit on the second call short-circuits before the stat, so
    // the entry still gets recorded under the canonical key captured
    // when the file existed.
    fs.rmSync(file);
    tracker.recordFromText("a.txt", tmp);
    expect(tracker.paths()).toContain(canonical);
  });

  test("ignores junk tokens that pass the cheap filter but stat fails", () => {
    const tracker = new InspectionTracker();
    // Tokens with a slash or dot survive the pre-filter; only the stat
    // rejects them. This is the load-bearing test for "tolerant extractor
    // does not record garbage".
    tracker.recordFromText(
      "definitely.not/a/real/file or ./does-not-exist",
      tmp,
    );
    expect(tracker.paths()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lifecycle: prune (sliding window) + clear (shutdown)
// ---------------------------------------------------------------------------

describe("prune", () => {
  test("evicts entries older than the configured window", () => {
    const tracker = new InspectionTracker(2); // window of 2 turns
    const file = writeFile("a.txt");
    tracker.recordFromText("a.txt", tmp); // turn 0
    tracker.prune(); // currentTurn → 1, cutoff -1, no evict
    expect(tracker.paths().length).toBe(1);
    tracker.prune(); // currentTurn → 2, cutoff 0, entry on turn 0 evicted
    expect(tracker.paths()).toEqual([]);
    // Re-record to verify the tracker stays usable after eviction.
    tracker.recordFromText("a.txt", tmp);
    expect(tracker.paths()).toEqual([fs.realpathSync(file)]);
  });

  test("keeps entries inside the sliding window", () => {
    const tracker = new InspectionTracker(4);
    writeFile("a.txt");
    tracker.recordFromText("a.txt", tmp); // turn 0
    tracker.prune(); // turn 1
    tracker.prune(); // turn 2
    tracker.prune(); // turn 3 — still inside window (3 - 0 < 4)
    expect(tracker.paths().length).toBe(1);
  });
});

describe("clear", () => {
  test("drops every entry", () => {
    const tracker = new InspectionTracker();
    writeFile("a.txt");
    writeFile("b.txt");
    tracker.recordFromText("a.txt b.txt", tmp);
    expect(tracker.paths().length).toBe(2);
    tracker.clear();
    expect(tracker.paths()).toEqual([]);
  });

  test("clears the resolution memo (canceled entries can be re-recorded)", () => {
    const tracker = new InspectionTracker();
    const file = writeFile("a.txt");
    tracker.recordFromText("a.txt", tmp);
    tracker.clear();
    // After clear, the file still exists; a fresh recordFromText should
    // re-stat and re-record it.
    tracker.recordFromText("a.txt", tmp);
    expect(tracker.paths()).toEqual([fs.realpathSync(file)]);
  });
});

// ---------------------------------------------------------------------------
// recordFromToolContent — the tool_result hook's path into the tracker
// ---------------------------------------------------------------------------

describe("recordFromToolContent", () => {
  test("records paths from text-typed content blocks", () => {
    const tracker = new InspectionTracker();
    writeFile("src/foo.ts");
    writeFile("src/bar.ts");
    tracker.recordFromToolContent(
      [
        { type: "text", text: "[src/foo.ts#1A2B]" },
        { type: "text", text: "and src/bar.ts:7" },
      ],
      tmp,
    );
    expect(new Set(tracker.paths())).toEqual(
      new Set([
        fs.realpathSync(path.join(tmp, "src/foo.ts")),
        fs.realpathSync(path.join(tmp, "src/bar.ts")),
      ]),
    );
  });

  test("silently skips non-text blocks (image, audio, malformed)", () => {
    const tracker = new InspectionTracker();
    writeFile("src/foo.ts");
    tracker.recordFromToolContent(
      [
        { type: "text", text: "[src/foo.ts#1A2B]" },
        { type: "image", text: "ignored — wrong type" },
        { type: "text" }, // missing text field
        { type: "text", text: 123 }, // non-string text
        { type: "audio", text: "also ignored" },
      ],
      tmp,
    );
    expect(tracker.paths()).toEqual([
      fs.realpathSync(path.join(tmp, "src/foo.ts")),
    ]);
  });

  test("no-ops on empty content", () => {
    const tracker = new InspectionTracker();
    tracker.recordFromToolContent([], tmp);
    expect(tracker.paths()).toEqual([]);
  });
});
