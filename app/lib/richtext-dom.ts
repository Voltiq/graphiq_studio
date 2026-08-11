// DOM ↔ runs glue for the rich-text editor (the contentEditable overlay in
// CanvasArea). The DOM is the source of truth while a session is open: we seed
// it from {text, runs} once, let the browser edit it (native caret/selection/
// undo), apply styles to selections via execCommand / span wrapping, and
// serialize back to flat text + runs on commit.
//
// Decorations (underline/strike) never go on the editor's BASE style: CSS
// text-decoration paints THROUGH descendants and can't be cancelled by a
// child, so an "un-underlined" run under a decorated base would be
// unrepresentable. Runs carry their own decoration spans instead.

import { parseColor, toHex8 } from "./color";
import { runsAreUniform } from "./richtext";
import type { TextRun, TextRunStyle } from "./tools";

const sameStyle = (a: TextRunStyle, b: TextRunStyle): boolean =>
  a.fontFamily === b.fontFamily &&
  a.fontSize === b.fontSize &&
  a.bold === b.bold &&
  a.italic === b.italic &&
  a.underline === b.underline &&
  a.strike === b.strike &&
  (a.baseline ?? 0) === (b.baseline ?? 0) &&
  !!a.caps === !!b.caps &&
  a.color.toLowerCase() === b.color.toLowerCase();

/** First family of a computed font-family list, quotes stripped. */
const firstFamily = (s: string): string => (s.split(",")[0] ?? s).trim().replace(/^["']|["']$/g, "");

/** Seed the editor element from a block's text + runs (replaces content). */
export function seedTextEditor(
  el: HTMLElement,
  text: string,
  runs: TextRun[] | undefined,
  base: TextRunStyle,
): void {
  el.textContent = "";
  const list = runs?.length ? runs : text.length ? [{ ...base, len: text.length }] : [];
  let pos = 0;
  for (const r of list) {
    const chunk = text.slice(pos, pos + r.len);
    pos += r.len;
    const parts = chunk.split("\n");
    parts.forEach((part, i) => {
      if (i > 0) el.appendChild(document.createElement("br"));
      if (!part) return;
      // Base-styled text inherits from the editor; only overrides get a span
      // (decorations always do — the base never carries them, see above).
      if (sameStyle(r, base) && !r.underline && !r.strike) {
        el.appendChild(document.createTextNode(part));
        return;
      }
      const span = document.createElement("span");
      if (r.fontFamily !== base.fontFamily) span.style.fontFamily = r.fontFamily;
      if (r.fontSize !== base.fontSize) span.style.fontSize = `${r.fontSize}px`;
      if (r.bold !== base.bold) span.style.fontWeight = r.bold ? "700" : "400";
      if (r.italic !== base.italic) span.style.fontStyle = r.italic ? "italic" : "normal";
      const deco = [r.underline ? "underline" : "", r.strike ? "line-through" : ""]
        .filter(Boolean)
        .join(" ");
      if (deco) span.style.textDecorationLine = deco;
      // Baseline shift rides on vertical-align, which takes a length and is what
      // the browser already uses to lift a superscript; positive raises in both
      // our model and CSS, so the value goes through unnegated.
      if ((r.baseline ?? 0) !== (base.baseline ?? 0)) span.style.verticalAlign = `${r.baseline ?? 0}px`;
      // text-transform INHERITS, so an explicit "none" is needed to cancel an
      // all-caps base on a run that opts out.
      if (!!r.caps !== !!base.caps) span.style.textTransform = r.caps ? "uppercase" : "none";
      if (r.color.toLowerCase() !== base.color.toLowerCase()) span.style.color = r.color;
      span.textContent = part;
      el.appendChild(span);
    });
  }
}

/**
 * Serialize the editor DOM back to flat text + runs. Runs come from each text
 * node's computed style (so nested spans, execCommand output and pasted-then-
 * styled content all resolve correctly); decorations accumulate down the tree.
 * Uniform blocks return `runs: undefined` — the legacy single-style path.
 */
export function serializeTextEditor(
  el: HTMLElement,
  base: TextRunStyle,
): { text: string; runs?: TextRun[] } {
  let text = "";
  const runs: TextRun[] = [];
  const push = (t: string, st: TextRunStyle) => {
    if (!t) return;
    text += t;
    const last = runs[runs.length - 1];
    if (last && sameStyle(last, st)) last.len += t.length;
    else runs.push({ ...st, len: t.length });
  };
  // `shift` accumulates DOWN the tree the way `deco` does: vertical-align is not
  // an inherited property, so a nested span would report "baseline" and silently
  // drop an outer span's shift — but nested inline boxes do stack visually, so
  // summing as we descend is what matches what the user sees. text-transform is
  // inherited, so that one is simply read off the text node's parent.
  const walk = (node: Node, inh: { u: boolean; s: boolean; shift: number }) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const parent = node.parentElement;
      let st: TextRunStyle = { ...base, underline: inh.u, strike: inh.s, baseline: inh.shift };
      if (parent) {
        const cs = getComputedStyle(parent);
        st = {
          fontFamily: firstFamily(cs.fontFamily) || base.fontFamily,
          fontSize: parseFloat(cs.fontSize) || base.fontSize,
          bold: (parseInt(cs.fontWeight, 10) || 400) >= 600,
          italic: cs.fontStyle.includes("italic") || cs.fontStyle.includes("oblique"),
          underline: inh.u,
          strike: inh.s,
          baseline: inh.shift,
          caps: cs.textTransform === "uppercase",
          color: toHex8(parseColor(cs.color)),
        };
      }
      push((node.textContent ?? "").split(String.fromCharCode(160)).join(" "), st);
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === "BR") {
      push("\n", { ...base, underline: false, strike: false, baseline: 0, caps: false });
      return;
    }
    const cs = getComputedStyle(node);
    if (cs.display === "none") return;
    const line = cs.textDecorationLine;
    // Only a LENGTH counts — the keywords ("baseline", "super", "middle") aren't
    // a px shift, and parseFloat would happily turn them into NaN.
    const own = parseFloat(cs.verticalAlign);
    const childInh = {
      u: inh.u || line.includes("underline") || node.tagName === "U",
      s: inh.s || line.includes("line-through") || node.tagName === "S" || node.tagName === "STRIKE",
      shift: inh.shift + (Number.isFinite(own) ? own : 0),
    };
    const isBlock = cs.display === "block" || cs.display === "list-item";
    if (isBlock && text && !text.endsWith("\n"))
      push("\n", { ...base, underline: false, strike: false, baseline: 0, caps: false });
    for (const child of Array.from(node.childNodes)) walk(child, childInh);
  };
  // The walk starts at the BASE shift, not at zero. seedTextEditor only emits a
  // vertical-align span when a run DIFFERS from the base, and the base's own
  // shift is carried by the editor element's placement rather than by any span
  // — so starting from zero would read every unstyled run back as shift 0,
  // making a uniformly-shifted block look non-uniform, forcing it onto the rich
  // path, and painting it with no shift at all. Decorations don't need this
  // because the base never carries them, and caps doesn't because text-transform
  // inherits from the editor root.
  for (const child of Array.from(el.childNodes))
    walk(child, { u: false, s: false, shift: base.baseline ?? 0 });
  // ContentEditable keeps a placeholder <br> at the very end — drop the one
  // trailing newline it serializes to (an empty final line renders as nothing).
  if (text.endsWith("\n")) {
    text = text.slice(0, -1);
    const last = runs[runs.length - 1];
    if (last) {
      last.len -= 1;
      if (last.len <= 0) runs.pop();
    }
  }
  if (runsAreUniform(runs, base)) return { text };
  return { text, runs };
}

/** Character-level patch keys the selection path can consume. */
export interface TextStylePatch {
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strike?: boolean;
  color?: string;
  fontFamily?: string;
  fontSize?: number;
  /** Baseline shift, px (positive raises). */
  baseline?: number;
  /** All caps. */
  caps?: boolean;
}

/**
 * Apply a character-style patch to the editor's current selection. Returns
 * true when it was applied to a (non-collapsed) selection — the caller then
 * leaves the block's base style alone. Bold/italic/underline/strike behave as
 * toggles over the selection (native execCommand semantics).
 */
export function applyPatchToSelection(el: HTMLElement, patch: TextStylePatch): boolean {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return false;
  const range = sel.getRangeAt(0);
  if (!el.contains(range.commonAncestorContainer)) return false;
  const exec = (cmd: string, val?: string) => {
    try {
      document.execCommand("styleWithCSS", false, "true");
      document.execCommand(cmd, false, val);
    } catch {
      /* execCommand is deprecated but universally supported; ignore failures */
    }
  };
  let applied = false;
  if (patch.bold !== undefined) {
    exec("bold");
    applied = true;
  }
  if (patch.italic !== undefined) {
    exec("italic");
    applied = true;
  }
  if (patch.underline !== undefined) {
    exec("underline");
    applied = true;
  }
  if (patch.strike !== undefined) {
    exec("strikeThrough");
    applied = true;
  }
  if (patch.color !== undefined) {
    exec("foreColor", patch.color);
    applied = true;
  }
  if (patch.fontFamily !== undefined) {
    exec("fontName", patch.fontFamily);
    applied = true;
  }
  // Properties execCommand has no command for get their own span. Collected into
  // ONE wrap so a combined patch can't nest three spans (and so the re-selection
  // below happens once, leaving the user's selection intact either way).
  const css: Partial<CSSStyleDeclaration> = {};
  if (patch.fontSize !== undefined) css.fontSize = `${patch.fontSize}px`;
  if (patch.baseline !== undefined) css.verticalAlign = `${patch.baseline}px`;
  if (patch.caps !== undefined) css.textTransform = patch.caps ? "uppercase" : "none";
  if (Object.keys(css).length) {
    // execCommand only knows the legacy 1–7 font sizes, and nothing at all about
    // vertical-align or text-transform — wrap the range ourselves.
    const span = document.createElement("span");
    Object.assign(span.style, css);
    try {
      range.surroundContents(span);
    } catch {
      // Partial-node selections: extract → wrap → reinsert.
      const frag = range.extractContents();
      span.appendChild(frag);
      range.insertNode(span);
    }
    const r = document.createRange();
    r.selectNodeContents(span);
    sel.removeAllRanges();
    sel.addRange(r);
    applied = true;
  }
  el.focus();
  return applied;
}
