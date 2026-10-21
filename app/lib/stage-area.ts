/**
 * The part of the stage the picture is actually seen through.
 *
 * On a phone, things sit ON the stage: the readout chip across its top
 * (`--fit-top`), the tool's options card on its foot (`--m-options-h`,
 * published live by OptionsBar, plus the 16px it floats above the dock) and
 * the edge-swipe strips down its sides (`--edge-strip`). All three are unset —
 * zero — on the other shells.
 *
 * Fitting the picture and pivoting a zoom both mean "the middle of what you
 * can see", so both read it from here. They used to disagree: the fit centred
 * the picture between the chip and the card, while 100% / zoom in / zoom out
 * pivoted on the middle of the whole stage — a point BELOW the fitted picture
 * on a phone — so View ▸ 100% threw the picture off the top of the screen
 * (at 390×844: the artwork's foot at y=146, the rest above the screen).
 */

export interface StageInsets {
  top: number;
  bottom: number;
  side: number;
}

/** The insets the phone's chrome lays over the stage (all 0 elsewhere). */
export function readStageInsets(): StageInsets {
  const root = getComputedStyle(document.documentElement);
  const px = (name: string) => parseFloat(root.getPropertyValue(name)) || 0;
  const card = px("--m-options-h");
  return { top: px("--fit-top"), bottom: card ? card + 16 : 0, side: px("--edge-strip") };
}

/** The visible part of a `width`×`height` stage under `inset`: its usable size
 *  and its centre, in the stage's own coordinates. */
export function visibleStage(
  width: number,
  height: number,
  inset: StageInsets,
): { usableW: number; usableH: number; cx: number; cy: number } {
  const usableW = Math.max(1, width - inset.side * 2);
  const usableH = Math.max(1, height - inset.top - inset.bottom);
  return { usableW, usableH, cx: width / 2, cy: inset.top + usableH / 2 };
}

/**
 * The line the stage is covered from, from below: the keyboard's top
 * (`--kb-inset`) — and on a phone the dock and the tool's options card, which
 * ride ABOVE the keyboard (both sit at `--kb-inset`). Something below this line
 * cannot be seen. A text caret was kept clear of the keyboard alone, so with
 * one up on a phone it came to rest 12px above the keyboard: behind the card.
 */
export function coveredFrom(): number {
  const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0;
  let line = window.innerHeight - kb;
  for (const sel of ['[data-tour="options"][data-mobile-options]', '[data-tour="mobilebar"]']) {
    const r = document.querySelector(sel)?.getBoundingClientRect();
    if (r && r.height > 0 && r.top > 0) line = Math.min(line, r.top);
  }
  return line;
}
