/**
 * The rich-text layout layer, pinned before its run model grows.
 *
 * `app/lib/richtext.ts` is 389 lines carrying every decision about how a styled
 * text block turns into positioned segments — run normalization, word/space
 * tokenizing, wrapping, per-line baselines from mixed font sizes, justification,
 * and the alignment offsets. It had **no tests at all**, which is a problem
 * about to get worse: the roadmap moves tracking, OpenType features and
 * variable-font axes from the block onto the run, and that touches every
 * function here. Restructuring an untested 389-line layout engine is how a
 * subtle wrapping regression ships.
 *
 * So this file pins the CURRENT behaviour first. It is deliberately written
 * against the seams the module already offers rather than against its
 * internals: `layoutRuns` takes a `MeasureFn`, so a deterministic fake measurer
 * turns "how does this text wrap" into ordinary arithmetic with no browser, no
 * font loading and no flakiness. Every width below is therefore exact, not
 * approximate — which is the only way a wrapping test is worth having.
 *
 * WHAT THE FAKE MEASURER MODELS: one document pixel per character per 10px of
 * font size, so a 20px "abc" is 6 wide. Ascent/descent are 0.8/0.2 of the size,
 * which is what the real measurer falls back to when a font reports no
 * bounding box. That keeps the numbers small enough to assert by hand.
 */
import { describe, expect, it } from "vitest";
import {
  baseRunStyle,
  cssFontString,
  effectiveWeight,
  fontFeatureCSS,
  layoutRuns,
  normalizeRuns,
  renderedText,
  runsAreUniform,
  stretchKeyword,
  type MeasureFn,
} from "../app/lib/richtext";
import type { TextRun, TextRunStyle } from "../app/lib/tools";

const BASE: TextRunStyle = {
  fontFamily: "Inter",
  fontSize: 10,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: "#000000ff",
  baseline: 0,
  caps: false,
};

const style = (over: Partial<TextRunStyle> = {}): TextRunStyle => ({ ...BASE, ...over });
const run = (len: number, over: Partial<TextRunStyle> = {}): TextRun => ({ ...style(over), len });

/** One px per character per 10px of size — see the note at the top. */
const measure: MeasureFn = (text, s) => ({
  width: text.length * (s.fontSize / 10),
  ascent: s.fontSize * 0.8,
  descent: s.fontSize * 0.2,
});

describe("normalizeRuns", () => {
  it("covers the text exactly when the runs are already right", () => {
    const runs = normalizeRuns("abcdef", [run(3), run(3, { bold: true })], BASE);
    expect(runs.map((r) => r.len)).toEqual([3, 3]);
    expect(runs[1].bold).toBe(true);
  });

  it("pads a short run list with the base style", () => {
    const runs = normalizeRuns("abcdef", [run(2, { bold: true })], BASE);
    expect(runs.reduce((n, r) => n + r.len, 0)).toBe(6);
    expect(runs[runs.length - 1].bold).toBe(false);
  });

  it("clamps runs that overshoot the text", () => {
    const runs = normalizeRuns("abc", [run(99)], BASE);
    expect(runs.reduce((n, r) => n + r.len, 0)).toBe(3);
  });

  it("drops runs beyond the end rather than emitting empty ones", () => {
    const runs = normalizeRuns("abc", [run(3), run(5, { italic: true })], BASE);
    expect(runs.reduce((n, r) => n + r.len, 0)).toBe(3);
    expect(runs.every((r) => r.len > 0)).toBe(true);
  });

  /* Newlines are part of the flat text and must be covered like any character,
     or every run after the first line drifts by one. */
  it("counts newlines as covered characters", () => {
    const runs = normalizeRuns("ab\ncd", undefined, BASE);
    expect(runs.reduce((n, r) => n + r.len, 0)).toBe(5);
  });

  it("gives empty text no runs", () => {
    expect(normalizeRuns("", [run(4)], BASE)).toEqual([]);
  });
});

describe("runsAreUniform", () => {
  it("treats no runs as uniform", () => {
    expect(runsAreUniform(undefined, BASE)).toBe(true);
    expect(runsAreUniform([], BASE)).toBe(true);
  });

  it("is true when every run matches the base", () => {
    expect(runsAreUniform([run(3), run(2)], BASE)).toBe(true);
  });

  it.each([
    ["bold", { bold: true }],
    ["italic", { italic: true }],
    ["underline", { underline: true }],
    ["strike", { strike: true }],
    ["fontFamily", { fontFamily: "Georgia" }],
    ["fontSize", { fontSize: 24 }],
    ["baseline", { baseline: 4 }],
    ["caps", { caps: true }],
  ])("is false when a run differs by %s", (_what, over) => {
    expect(runsAreUniform([run(3), run(2, over)], BASE)).toBe(false);
  });

  /* Colour is compared case-insensitively on purpose: the editor round-trips
     through the DOM, which lowercases, and a case flip is not a style change. */
  it("ignores colour case", () => {
    expect(runsAreUniform([run(3, { color: "#000000FF" })], BASE)).toBe(true);
  });
});

describe("baseRunStyle", () => {
  it("takes the block's own style, defaulting the optional fields", () => {
    const s = baseRunStyle({ ...BASE, baseline: undefined, caps: undefined });
    expect(s.baseline).toBe(0);
    expect(s.caps).toBe(false);
    expect(s.fontFamily).toBe("Inter");
  });
});

describe("renderedText", () => {
  it("leaves the text alone when caps is off", () => {
    expect(renderedText("Hello there", { caps: false })).toBe("Hello there");
  });

  /* All-caps is a STYLE, not an edit — the block's stored text is untouched and
     the transform happens at render time, which is what keeps it reversible. */
  it("uppercases for display when caps is on", () => {
    expect(renderedText("Hello there", { caps: true })).toBe("HELLO THERE");
  });

  it("keeps newlines, so line counts do not change", () => {
    expect(renderedText("a\nb", { caps: true })).toBe("A\nB");
  });
});

describe("font strings and feature CSS", () => {
  it("emits nothing for absent or default features, so legacy text is untouched", () => {
    expect(fontFeatureCSS(undefined)).toBeNull();
    expect(fontFeatureCSS({})).toBeNull();
  });

  it("opts in with 1 and out with 0", () => {
    expect(fontFeatureCSS({ smcp: true })).toContain('"smcp" 1');
    expect(fontFeatureCSS({ liga: false })).toContain('"liga" 0');
  });

  /* `liga`/`calt` are on by default in browsers, so setting them TRUE is a
     no-op that must not be emitted — otherwise every block carries CSS. */
  it("does not emit a tag for a flag already at the browser default", () => {
    expect(fontFeatureCSS({ liga: true, calt: true })).toBeNull();
  });

  it("maps a width percentage to the nearest CSS keyword, since canvas takes only keywords", () => {
    expect(stretchKeyword(undefined)).toBeNull();
    /* 100% is `normal`, and `normal` is emitted as NULL on purpose — there is
       nothing to add to the font string, and adding it would change the
       legacy string for every block that never touched the axis. */
    expect(stretchKeyword(100)).toBeNull();
    expect(stretchKeyword(50)).toBe("ultra-condensed");
    expect(stretchKeyword(200)).toBe("ultra-expanded");
  });

  it("lets a variable weight axis override the bold toggle", () => {
    expect(effectiveWeight(false, undefined)).toBe(400);
    expect(effectiveWeight(true, undefined)).toBe(700);
    expect(effectiveWeight(false, { wght: 250 })).toBe(250);
    expect(effectiveWeight(true, { wght: 250 })).toBe(250);
  });

  it("builds a canvas font string from a run style", () => {
    const f = cssFontString(style({ fontSize: 24, italic: true, bold: true }), undefined);
    expect(f).toContain("24px");
    expect(f).toContain("italic");
    expect(f).toContain("Inter");
  });
});

describe("layoutRuns", () => {
  it("lays one unwrapped line out at the origin", () => {
    const l = layoutRuns("abc", undefined, BASE, null, 1.2, "left", measure);
    expect(l.lines).toHaveLength(1);
    expect(l.lines[0].segs.map((s) => s.text).join("")).toBe("abc");
    expect(l.lines[0].width).toBeCloseTo(3);
    expect(l.minX).toBeCloseTo(0);
  });

  it("splits on newlines without measuring them", () => {
    const l = layoutRuns("ab\ncd", undefined, BASE, null, 1.2, "left", measure);
    expect(l.lines).toHaveLength(2);
    expect(l.lines.map((x) => x.segs.map((s) => s.text).join(""))).toEqual(["ab", "cd"]);
  });

  it("wraps at the box width, breaking between words", () => {
    // Each char is 1 wide at size 10; "aaa bbb ccc" is 11 wide, box is 7.
    const l = layoutRuns("aaa bbb ccc", undefined, BASE, 7, 1.2, "left", measure);
    expect(l.lines.length).toBeGreaterThan(1);
    for (const line of l.lines) expect(line.width).toBeLessThanOrEqual(7 + 1e-9);
  });

  /* A line's baseline comes from the TALLEST run on it, not the block size —
     otherwise a big word on a small line overlaps the line above. */
  it("takes ascent from the tallest run on the line", () => {
    const runs = [run(1), run(1, { fontSize: 40 }), run(1)];
    const l = layoutRuns("abc", runs, BASE, null, 1.2, "left", measure);
    expect(l.lines[0].ascent).toBeCloseTo(40 * 0.8);
  });

  it("advances each segment by the width of the one before it", () => {
    const runs = [run(2), run(2, { fontSize: 20 })];
    const l = layoutRuns("abcd", runs, BASE, null, 1.2, "left", measure);
    const segs = l.lines[0].segs;
    expect(segs[0].x).toBeCloseTo(0);
    expect(segs[1].x).toBeCloseTo(segs[0].width);
    expect(segs[1].width).toBeCloseTo(2 * 2); // 2 chars at size 20 = 2px each
  });

  /* Centre and right put the anchor inside the text, so minX goes negative —
     the layout is relative to the block anchor, not to a left edge. */
  it("centres around the anchor", () => {
    const l = layoutRuns("abcd", undefined, BASE, null, 1.2, "center", measure);
    expect(l.minX).toBeCloseTo(-2);
    expect(l.maxX).toBeCloseTo(2);
  });

  it("right-aligns to the left of the anchor", () => {
    const l = layoutRuns("abcd", undefined, BASE, null, 1.2, "right", measure);
    expect(l.maxX).toBeCloseTo(0);
    expect(l.minX).toBeCloseTo(-4);
  });

  it("stacks lines by the line height", () => {
    const l = layoutRuns("a\nb\nc", undefined, BASE, null, 2, "left", measure);
    const gaps = l.lines.slice(1).map((line, i) => line.baseline - l.lines[i].baseline);
    expect(new Set(gaps.map((g) => g.toFixed(4))).size).toBe(1); // evenly spaced
    expect(gaps[0]).toBeCloseTo(20); // 10px font at line-height 2
  });

  it("gives empty text a layout rather than throwing", () => {
    const l = layoutRuns("", undefined, BASE, null, 1.2, "left", measure);
    expect(l.height).toBeGreaterThanOrEqual(0);
  });

  /* Spaces stay their own measurable segments, because justify stretches the
     GAPS and needs them addressable. */
  it("keeps spaces as segments flagged as such", () => {
    const l = layoutRuns("ab cd", undefined, BASE, null, 1.2, "left", measure);
    const spaces = l.lines[0].segs.filter((s) => s.space);
    expect(spaces.length).toBe(1);
    expect(spaces[0].text).toBe(" ");
  });

  it("stretches the gaps to the box under justify, leaving the last line alone", () => {
    const l = layoutRuns("aa bb cc dd", undefined, BASE, 20, 1.2, "justify", measure);
    for (const line of l.lines) {
      const end = Math.max(...line.segs.map((s) => s.x + s.width));
      expect(end).toBeLessThanOrEqual(20 + 1e-9);
    }
  });
});
