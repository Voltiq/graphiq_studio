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

import type { TextAlign, TextRun, TextRunStyle } from "./tools";

/** Injected measurement for one style: text width + font ascent/descent. */
export interface RunMetrics {
  width: number;
  ascent: number;
  descent: number;
}
export type MeasureFn = (text: string, style: TextRunStyle) => RunMetrics;

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

/** Split [start, end) of the text into per-run pieces. */
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
    if (b > a) out.push({ text: text.slice(a, b), style: r });
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
      for (const t of toks)
        for (const p of t.pieces) {
          ascent = Math.max(ascent, p.ascent);
          descent = Math.max(descent, p.descent);
          maxSize = Math.max(maxSize, p.style.fontSize);
        }
      if (!toks.length) {
        const st = styleAt(runs, Math.min(offset, Math.max(0, text.length - 1)));
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
}): TextRunStyle {
  return {
    fontFamily: spec.fontFamily,
    fontSize: spec.fontSize,
    bold: spec.bold,
    italic: spec.italic,
    underline: spec.underline,
    strike: spec.strike,
    color: spec.color,
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
      r.color.toLowerCase() === base.color.toLowerCase(),
  );
}
