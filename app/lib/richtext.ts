// Rich-text layout (TODO §6 "rich text runs"): mixed fonts / sizes / colours
// inside one block, with word wrap, left/centre/right alignment and full
// justification. Pure — measurement is injected, so the same engine runs
// against a canvas context in the app and a deterministic stub in tests.
//
// Model: the block's flat text plus TextRuns covering it exactly (each run =
// N characters sharing one character style). Block-level properties — align,
// leading (lineHeight), tracking — stay on the block. Lines are laid out
// greedily word-by-word; every line's baseline comes from its TALLEST run
// (shared baseline, like any word processor), and each line advances by
// lineHeight × its own max font size — which reproduces the legacy uniform
// layout exactly when every run has the same size.

import type { TextAlign, TextAxes, TextOpenType, TextRun, TextRunStyle } from "./tools";

/** Injected measurement for one style: text width + font ascent/descent. */
export interface RunMetrics {
  width: number;
  ascent: number;
  descent: number;
}
export type MeasureFn = (text: string, style: TextRunStyle) => RunMetrics;

// ---- OpenType features & variable axes (TODO §6) ---------------------------
// Canvas 2D quirks these helpers encode (verified in Chromium):
// - font-feature-settings applies to canvas text ONLY via CSS on the canvas
//   ELEMENT, and only while the canvas is CONNECTED to the document (a
//   display:none host suffices). fontFeatureCSS builds that CSS string.
// - font-variation-settings never reaches canvas text; but the font SHORTHAND
//   maps font-weight (any 1–1000) and font-stretch (keywords only) onto a
//   variable font's wght/wdth axes — and that works detached. cssFontString
//   builds the shorthand with the axes folded in.

/** The default-on features: emitting them only happens when turned OFF. */
const DEFAULT_ON: ReadonlySet<keyof TextOpenType> = new Set(["liga", "calt"]);

/** All feature flags in UI order, with human labels. */
export const OPENTYPE_FLAGS: { key: keyof TextOpenType; label: string }[] = [
  { key: "liga", label: "Ligatures" },
  { key: "dlig", label: "Discretionary ligatures" },
  { key: "calt", label: "Contextual alternates" },
  { key: "smcp", label: "Small caps" },
  { key: "onum", label: "Oldstyle figures" },
  { key: "tnum", label: "Tabular figures" },
  { key: "frac", label: "Fractions" },
  { key: "zero", label: "Slashed zero" },
  { key: "salt", label: "Stylistic alternates" },
  { key: "ss01", label: "Stylistic set 1" },
];

/** Effective on/off of one flag ("absent = the font's default"). */
export const featureOn = (f: TextOpenType | undefined, key: keyof TextOpenType): boolean =>
  f?.[key] ?? DEFAULT_ON.has(key);

/** font-feature-settings CSS for the non-default flags — null when everything
 *  is at its default (callers then skip the attached-canvas dance entirely). */
export function fontFeatureCSS(f?: TextOpenType): string | null {
  if (!f) return null;
  const parts: string[] = [];
  for (const { key } of OPENTYPE_FLAGS) {
    const v = f[key];
    if (v === undefined || v === DEFAULT_ON.has(key)) continue;
    if (key === "liga" && !v) parts.push('"liga" 0', '"clig" 0');
    else parts.push(`"${key}" ${v ? 1 : 0}`);
  }
  return parts.length ? parts.join(", ") : null;
}

/** The nine CSS font-stretch stops the font shorthand accepts. */
const STRETCH_STOPS: { pct: number; kw: string }[] = [
  { pct: 50, kw: "ultra-condensed" },
  { pct: 62.5, kw: "extra-condensed" },
  { pct: 75, kw: "condensed" },
  { pct: 87.5, kw: "semi-condensed" },
  { pct: 100, kw: "normal" },
  { pct: 112.5, kw: "semi-expanded" },
  { pct: 125, kw: "expanded" },
  { pct: 150, kw: "extra-expanded" },
  { pct: 200, kw: "ultra-expanded" },
];

/** Nearest font-stretch keyword for a width percent; null = normal (omit). */
export function stretchKeyword(pct?: number): string | null {
  if (pct === undefined) return null;
  let best = STRETCH_STOPS[0];
  for (const s of STRETCH_STOPS) if (Math.abs(s.pct - pct) < Math.abs(best.pct - pct)) best = s;
  return best.kw === "normal" ? null : best.kw;
}

/** Effective numeric weight: the wght axis wins over the bold toggle. */
export const effectiveWeight = (bold: boolean, axes?: TextAxes): number =>
  axes?.wght !== undefined ? Math.round(Math.max(1, Math.min(1000, axes.wght))) : bold ? 700 : 400;

/** The canvas/CSS font shorthand with variable axes folded in. Reproduces the
 *  legacy `italic 700 32px Family` string exactly when no axes are set. */
export function cssFontString(
  style: { italic: boolean; bold: boolean; fontSize: number; fontFamily: string },
  axes?: TextAxes,
): string {
  const stretch = stretchKeyword(axes?.wdth);
  return `${style.italic ? "italic " : ""}${effectiveWeight(style.bold, axes)} ${
    stretch ? `${stretch} ` : ""
  }${style.fontSize}px ${style.fontFamily}`;
}

/** One positioned piece of a line (single style, no line breaks inside). */
export interface RichSeg {
  text: string;
  style: TextRunStyle;
  /** x offset from the block anchor (spec.x), doc px. */
  x: number;
  width: number;
  /** True for pure-space segments (the stretchable gaps under justify). */
  space: boolean;
}

export interface RichLine {
  segs: RichSeg[];
  /** Baseline y offset from the block top (spec.y), doc px. */
  baseline: number;
  ascent: number;
  descent: number;
  /** Natural (pre-justify) width of the line's content. */
  width: number;
}

export interface RichLayout {
  lines: RichLine[];
  /** Tight bounds relative to the anchor: minX can be negative for centred /
   *  right-aligned point text. */
  minX: number;
  maxX: number;
  height: number;
}

/** Clamp/pad runs so they cover `text` exactly (defensive — stored runs should
 *  already; a base style fills any gap). */
export function normalizeRuns(text: string, runs: TextRun[] | undefined, base: TextRunStyle): TextRun[] {
  const out: TextRun[] = [];
  let covered = 0;
  for (const r of runs ?? []) {
    if (covered >= text.length) break;
    const len = Math.max(0, Math.min(r.len, text.length - covered));
    if (len > 0) {
      out.push({ ...r, len });
      covered += len;
    }
  }
  if (covered < text.length) out.push({ ...base, len: text.length - covered });
  return out;
}

/** The style covering character index `i` (runs normalized beforehand). */
function styleAt(runs: TextRun[], i: number): TextRunStyle {
  let p = 0;
  for (const r of runs) {
    p += r.len;
    if (i < p) return r;
  }
  return runs[runs.length - 1];
}

/**
 * The text a style actually renders — all-caps applied, everything else as-is.
 *
 * Applied to a SLICE, never to the whole block: `toUpperCase` can change length
 * ("ß" → "SS", "ﬁ" → "FI"), so transforming the block up front would slide every
 * run offset out of step with the text they index into. Slicing first and
 * transforming after keeps run boundaries anchored to the original characters,
 * and a longer capital simply measures wider — which is correct.
 */
export const renderedText = (text: string, style: { caps?: boolean }): string =>
  style.caps ? text.toUpperCase() : text;

/** Split [start, end) of the text into per-run pieces, each transformed by its
 *  own style (so measurement and painting always see the same characters). */
function piecesOf(
  text: string,
  runs: TextRun[],
  start: number,
  end: number,
): { text: string; style: TextRunStyle }[] {
  const out: { text: string; style: TextRunStyle }[] = [];
  let runStart = 0;
  for (const r of runs) {
    const runEnd = runStart + r.len;
    const a = Math.max(start, runStart);
    const b = Math.min(end, runEnd);
    if (b > a) out.push({ text: renderedText(text.slice(a, b), r), style: r });
    runStart = runEnd;
    if (runStart >= end) break;
  }
  return out;
}

interface Token {
  pieces: { text: string; style: TextRunStyle; width: number; ascent: number; descent: number }[];
  width: number;
  space: boolean;
}

/**
 * Lay out a rich block. `boxW` null = point text (no wrapping; the anchor sits
 * at the left/centre/right of each line per `align`; justify falls back to
 * left). Tracking is expected to be part of `measure` (the canvas measurer
 * sets letterSpacing before measuring, exactly like the renderer draws).
 */
export function layoutRuns(
  text: string,
  runsIn: TextRun[] | undefined,
  base: TextRunStyle,
  boxW: number | null,
  lineHeight: number,
  align: TextAlign,
  measure: MeasureFn,
): RichLayout {
  const runs = normalizeRuns(text, runsIn, base);
  const paragraphs = text.split("\n");
  interface WorkLine extends RichLine {
    maxSize: number;
  }
  const lines: WorkLine[] = [];
  let offset = 0; // char offset of the current paragraph within `text`

  for (const para of paragraphs) {
    // Tokenize into words and space gaps (spaces stay measurable segments).
    const tokens: Token[] = [];
    const re = /( +)|([^ ]+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(para))) {
      const start = offset + m.index;
      const end = start + m[0].length;
      const pieces = piecesOf(text, runs, start, end).map((p) => {
        const met = measure(p.text, p.style);
        return { ...p, width: met.width, ascent: met.ascent, descent: met.descent };
      });
      tokens.push({
        pieces,
        width: pieces.reduce((s, p) => s + p.width, 0),
        space: !!m[1],
      });
    }

    // Greedy wrap into lines of tokens.
    const lineTokens: Token[][] = [];
    let cur: Token[] = [];
    let curW = 0;
    for (const tok of tokens) {
      if (
        boxW != null &&
        !tok.space &&
        cur.length > 0 &&
        curW + tok.width > boxW
      ) {
        // Break before this word; trailing spaces don't count against the line.
        while (cur.length && cur[cur.length - 1].space) cur.pop();
        lineTokens.push(cur);
        cur = [];
        curW = 0;
      }
      if (tok.space && cur.length === 0 && lineTokens.length > 0) continue; // eat the wrap gap
      cur.push(tok);
      curW += tok.width;
    }
    lineTokens.push(cur);

    // Position each line.
    for (let li = 0; li < lineTokens.length; li++) {
      const toks = [...lineTokens[li]];
      while (toks.length && toks[toks.length - 1].space) toks.pop(); // trailing spaces never render
      const isLast = li === lineTokens.length - 1;
      const naturalW = toks.reduce((s, t) => s + t.width, 0);
      // Line metrics from the pieces (empty line: fall back to the paragraph's
      // style at its first character so blank lines keep their height).
      let ascent = 0;
      let descent = 0;
      let maxSize = 0;
      // Deliberately measured UNSHIFTED. Folding the baseline shift into
      // ascent/descent looks right until you work it through: the sum is what
      // centres the glyphs in the line box, and raising ascent by s while
      // lowering descent by s leaves the sum untouched — so the box moves down
      // by exactly the amount the glyphs move up, and a uniform shift becomes a
      // no-op. The shift is applied where it belongs, at paint time.
      for (const t of toks)
        for (const p of t.pieces) {
          ascent = Math.max(ascent, p.ascent);
          descent = Math.max(descent, p.descent);
          maxSize = Math.max(maxSize, p.style.fontSize);
        }
      if (!toks.length) {
        /* An EMPTY paragraph still needs a height, and with no runs there is no
           run to take it from. `styleAt` walks the run list and falls off the
           end as `runs[runs.length - 1]` — which for an empty list is
           `undefined`, in spite of a return type that promises otherwise, so
           the measurer is handed nothing and throws.

           NOT REACHABLE FROM THE UI TODAY, and the honest version of that was
           measured rather than assumed: with this guard removed, selecting
           justify and opening an empty text session raises nothing, because no
           caller reaches layout with empty text. It is a landmine rather than a
           bug — and it sits exactly where the run model is about to grow, which
           is the wrong place to leave a function whose type lies. The block's
           own style is the right answer here and the only one that exists. */
        const st = runs.length
          ? styleAt(runs, Math.min(offset, Math.max(0, text.length - 1)))
          : base;
        const met = measure("Mg", st);
        ascent = met.ascent;
        descent = met.descent;
        maxSize = st.fontSize;
      }

      // Justify: stretch the space gaps of every wrapped (non-final) line.
      let gapBonus = 0;
      const spaceCount = toks.filter((t) => t.space).length;
      if (align === "justify" && boxW != null && !isLast && spaceCount > 0 && naturalW < boxW)
        gapBonus = (boxW - naturalW) / spaceCount;

      // Alignment offset (justify behaves as left; the gaps do the work).
      const avail = boxW;
      let x =
        align === "center"
          ? ((avail ?? 0) - naturalW) / 2
          : align === "right"
            ? (avail ?? 0) - naturalW
            : 0;
      if (avail == null && align === "center") x = -naturalW / 2;
      if (avail == null && align === "right") x = -naturalW;

      const segs: RichSeg[] = [];
      for (const t of toks) {
        for (const p of t.pieces) {
          segs.push({ text: p.text, style: p.style, x, width: p.width, space: t.space });
          x += p.width;
        }
        if (t.space) x += gapBonus;
      }
      lines.push({ segs, baseline: 0, ascent, descent, width: naturalW, maxSize });
    }
    offset += para.length + 1; // + the newline
  }

  // Baselines: each line owns a lineHeight × (its max font size) box, glyphs
  // centred inside it — the legacy formula, applied per line.
  let top = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  for (const line of lines) {
    const leading = lineHeight * line.maxSize;
    line.baseline = top + (leading - (line.ascent + line.descent)) / 2 + line.ascent;
    top += leading;
    for (const s of line.segs) {
      minX = Math.min(minX, s.x);
      maxX = Math.max(maxX, s.x + s.width);
    }
  }
  if (!Number.isFinite(minX)) {
    minX = 0;
    maxX = 0;
  }
  return { lines: lines.map(({ maxSize: _unused, ...rest }) => rest), minX, maxX, height: top };
}

/** The base character style of a block's flat fields. */
export function baseRunStyle(spec: {
  fontFamily: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  color: string;
  baseline?: number;
  caps?: boolean;
}): TextRunStyle {
  return {
    fontFamily: spec.fontFamily,
    fontSize: spec.fontSize,
    bold: spec.bold,
    italic: spec.italic,
    underline: spec.underline,
    strike: spec.strike,
    color: spec.color,
    baseline: spec.baseline ?? 0,
    caps: !!spec.caps,
  };
}

/** Are these runs all identical to the base style (i.e. a uniform block)? */
export function runsAreUniform(runs: TextRun[] | undefined, base: TextRunStyle): boolean {
  if (!runs?.length) return true;
  return runs.every(
    (r) =>
      r.fontFamily === base.fontFamily &&
      r.fontSize === base.fontSize &&
      r.bold === base.bold &&
      r.italic === base.italic &&
      r.underline === base.underline &&
      r.strike === base.strike &&
      (r.baseline ?? 0) === (base.baseline ?? 0) &&
      !!r.caps === !!base.caps &&
      r.color.toLowerCase() === base.color.toLowerCase(),
  );
}
