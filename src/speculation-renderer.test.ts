import { describe, expect, test } from "bun:test";
import {
	formatSpeculationLines,
	INDENT,
	registerSpeculationRenderer,
	renderColoredLines,
	SPECULATION_FLAG_TYPE,
	type RendererTheme,
} from "./speculation-renderer.ts";

const PREFIX = "\u26a0 pi-behavior-control \u00b7 speculation";

describe("formatSpeculationLines", () => {
	test("the attribution tag is alone on the first line", () => {
		const lines = formatSpeculationLines("missing citation", 80, false);
		expect(lines[0]).toBe(PREFIX);
	});

	test("a short reason is indented on the second line", () => {
		const lines = formatSpeculationLines("missing citation", 80, false);
		expect(lines).toEqual([PREFIX, `${INDENT}missing citation`]);
	});

	test("every reason line is hang-indented under the tag", () => {
		const reason = Array.from({ length: 12 }, (_, i) => `token${i}`).join(" ");
		const lines = formatSpeculationLines(reason, 30, true);
		expect(lines[0]).toBe(PREFIX);
		for (let i = 1; i < lines.length; i++) {
			expect(lines[i]?.startsWith(INDENT)).toBe(true);
		}
	});

	test("no reason line exceeds the wrap budget (tag line never overflows)", () => {
		const reason = Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ");
		const width = 40;
		const lines = formatSpeculationLines(reason, width, true);
		// The tag line is fixed; reason lines must fit width (indent + content).
		for (let i = 1; i < lines.length; i++) {
			expect((lines[i] ?? "").length).toBeLessThanOrEqual(width);
		}
	});

	test("empty reason renders the tag plus a placeholder, never a bare tag", () => {
		expect(formatSpeculationLines("", 80, false)).toEqual([
			PREFIX,
			`${INDENT}(no reason given)`,
		]);
		expect(formatSpeculationLines("   \n  ", 80, false)).toEqual([
			PREFIX,
			`${INDENT}(no reason given)`,
		]);
	});

	test("collapsed long reason is clamped to 3 body lines + a marker", () => {
		const reason = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
		const collapsed = formatSpeculationLines(reason, 40, false);
		// tag + 3 body lines + marker line = 5
		expect(collapsed.length).toBe(5);
		expect(collapsed[collapsed.length - 1]).toContain("expand tool output");
	});

	test("expanded long reason is not clamped and has no marker", () => {
		const reason = Array.from({ length: 60 }, (_, i) => `word${i}`).join(" ");
		const expanded = formatSpeculationLines(reason, 40, true);
		expect(expanded.length).toBeGreaterThan(5);
		for (const line of expanded) {
			expect(line).not.toContain("expand tool output");
		}
	});

	test("a word longer than the width is emitted un-split (no characters dropped)", () => {
		const longWord = "x".repeat(200);
		const lines = formatSpeculationLines(longWord, 40, true);
		expect(lines.join("")).toContain(longWord);
	});

	test("tiny / zero width still makes forward progress", () => {
		const reason = "alpha beta gamma delta epsilon zeta eta theta";
		const lines = formatSpeculationLines(reason, 0, true);
		expect(lines.length).toBeGreaterThan(1);
		expect(lines[0]).toBe(PREFIX);
	});
});

describe("renderColoredLines", () => {
	const marking: RendererTheme = {
		fg: (color, text) => `<${color}>${text}</${color}>`,
		bold: (text) => `<b>${text}</b>`,
	};

	test("the tag line is warning-colored and bold", () => {
		const [first] = renderColoredLines("because reasons", 80, false, marking);
		expect(first).toBe(`<warning><b>${PREFIX}</b></warning>`);
	});

	test("reason lines are colored with the muted custom-message color", () => {
		const colored = renderColoredLines("because reasons", 80, false, marking);
		for (let i = 1; i < colored.length; i++) {
			expect(colored[i]).toContain("<customMessageText>");
		}
	});

	test("plain text is preserved when stripping the marking theme tags", () => {
		const colored = renderColoredLines("missing citation", 80, false, marking);
		const stripped = colored.join("\n").replace(/<\/?[a-zA-Z]+>/g, "");
		expect(stripped).toBe(`${PREFIX}\n${INDENT}missing citation`);
	});
});

describe("registerSpeculationRenderer", () => {
	test("registers a renderer under the speculation-flag customType", () => {
		const registered = new Map<string, unknown>();
		const fakePi = {
			registerMessageRenderer: (customType: string, renderer: unknown) => {
				registered.set(customType, renderer);
			},
		};
		registerSpeculationRenderer(fakePi as never);
		expect(registered.has(SPECULATION_FLAG_TYPE)).toBe(true);
		expect(typeof registered.get(SPECULATION_FLAG_TYPE)).toBe("function");
	});

	test("the registered renderer returns a component that renders the reason", () => {
		const registered = new Map<string, Function>();
		const fakePi = {
			registerMessageRenderer: (customType: string, renderer: Function) => {
				registered.set(customType, renderer);
			},
		};
		registerSpeculationRenderer(fakePi as never);
		const renderer = registered.get(SPECULATION_FLAG_TYPE);
		expect(renderer).toBeDefined();

		const theme: RendererTheme = { fg: (_c, t) => t, bold: (t) => t };
		const component = renderer?.(
			{
				role: "custom",
				customType: SPECULATION_FLAG_TYPE,
				content: "flagged thing",
				display: true,
				timestamp: 0,
			},
			{ expanded: false },
			theme,
		) as { render: (w: number) => string[] };
		expect(component).toBeDefined();
		const out = component.render(80);
		expect(out[0]).toBe(PREFIX);
		expect(out.join("\n")).toContain("flagged thing");
	});

	test("renderer reads reason from a text-content array", () => {
		const registered = new Map<string, Function>();
		const fakePi = {
			registerMessageRenderer: (customType: string, renderer: Function) => {
				registered.set(customType, renderer);
			},
		};
		registerSpeculationRenderer(fakePi as never);
		const renderer = registered.get(SPECULATION_FLAG_TYPE);
		const theme: RendererTheme = { fg: (_c, t) => t, bold: (t) => t };
		const component = renderer?.(
			{
				role: "custom",
				customType: SPECULATION_FLAG_TYPE,
				content: [{ type: "text", text: "array reason" }],
				display: true,
				timestamp: 0,
			},
			{ expanded: true },
			theme,
		) as { render: (w: number) => string[] };
		expect(component.render(80).join("\n")).toContain("array reason");
	});
});
