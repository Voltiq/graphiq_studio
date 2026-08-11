// Align & distribute for the Move tool (TODO §2) — pure delta math.
//
// Everything here takes boxes and returns per-box (dx, dy). It never touches
// pixels, which is what makes the awkward parts (what an align is measured
// AGAINST, and what "evenly spaced" means when the boxes are different sizes)
// assertable in Node instead of eyeballed on a canvas.

export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Delta {
  id: string;
  dx: number;
  dy: number;
}

export type AlignMode = "left" | "hcenter" | "right" | "top" | "vcenter" | "bottom";
export type DistributeMode = "hspace" | "vspace" | "hcenter" | "vcenter";

/** The union of every box (null for an empty list). */
export function unionBox(boxes: Box[]): { x: number; y: number; w: number; h: number } | null {
  if (!boxes.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const b of boxes) {
    x0 = Math.min(x0, b.x);
    y0 = Math.min(y0, b.y);
    x1 = Math.max(x1, b.x + b.w);
    y1 = Math.max(y1, b.y + b.h);
  }
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/**
 * Deltas that align every box to `target`.
 *
 * `target` is the frame to align against — the union of the boxes themselves
 * when aligning layers to each other, or the canvas / the selection when
 * aligning to those. Keeping it a parameter is what lets one function serve all
 * three cases, and it's why aligning a SINGLE layer is meaningful: against its
 * own union it is a no-op, against the canvas it centres.
 */
export function alignDeltas(
  boxes: Box[],
  mode: AlignMode,
  target: { x: number; y: number; w: number; h: number },
): Delta[] {
  return boxes.map((b) => {
    let dx = 0;
    let dy = 0;
    switch (mode) {
      case "left":
        dx = target.x - b.x;
        break;
      case "hcenter":
        dx = target.x + target.w / 2 - (b.x + b.w / 2);
        break;
      case "right":
        dx = target.x + target.w - (b.x + b.w);
        break;
      case "top":
        dy = target.y - b.y;
        break;
      case "vcenter":
        dy = target.y + target.h / 2 - (b.y + b.h / 2);
        break;
      case "bottom":
        dy = target.y + target.h - (b.y + b.h);
        break;
    }
    return { id: b.id, dx: Math.round(dx), dy: Math.round(dy) };
  });
}

/**
 * Deltas that space boxes evenly. The two outermost boxes never move — they
 * define the span, exactly as in Photoshop and every vector editor.
 *
 * Two different meanings, both of which people call "distribute":
 *
 *   hspace/vspace — equal GAPS between neighbours. This is almost always what
 *     you want with mixed-size objects, and it is NOT the same as equal centre
 *     spacing: three boxes of width 10, 100, 10 spread over 300px sit at very
 *     different places under the two rules.
 *   hcenter/vcenter — equal CENTRE spacing, which keeps a rhythm when the
 *     objects are meant to read as a row of equals regardless of their bounds.
 *
 * Fewer than three boxes returns all-zero: with two, they are both endpoints
 * and there is nothing between them to space.
 */
export function distributeDeltas(boxes: Box[], mode: DistributeMode): Delta[] {
  const horizontal = mode === "hspace" || mode === "hcenter";
  const zero = boxes.map((b) => ({ id: b.id, dx: 0, dy: 0 }));
  if (boxes.length < 3) return zero;

  // Sort a COPY by position; the returned deltas stay in the caller's order.
  const pos = (b: Box) => (horizontal ? b.x : b.y);
  const size = (b: Box) => (horizontal ? b.w : b.h);
  const sorted = [...boxes].sort((a, b) => pos(a) - pos(b) || size(a) - size(b));
  const first = sorted[0];
  const last = sorted[sorted.length - 1];

  const out = new Map<string, number>();
  if (mode === "hspace" || mode === "vspace") {
    const span = pos(last) - (pos(first) + size(first)); // edge of first → start of last
    const inner = sorted.slice(1, -1).reduce((s, b) => s + size(b), 0);
    const gap = (span - inner) / (sorted.length - 1);
    let cursor = pos(first) + size(first) + gap;
    for (const b of sorted.slice(1, -1)) {
      out.set(b.id, Math.round(cursor - pos(b)));
      cursor += size(b) + gap;
    }
  } else {
    const c = (b: Box) => pos(b) + size(b) / 2;
    const step = (c(last) - c(first)) / (sorted.length - 1);
    sorted.slice(1, -1).forEach((b, i) => {
      out.set(b.id, Math.round(c(first) + step * (i + 1) - c(b)));
    });
  }

  return boxes.map((b) => {
    const d = out.get(b.id) ?? 0;
    return { id: b.id, dx: horizontal ? d : 0, dy: horizontal ? 0 : d };
  });
}

/** Drop deltas that move nothing, so a no-op align doesn't create an undo step. */
export const nonZero = (deltas: Delta[]): Delta[] => deltas.filter((d) => d.dx !== 0 || d.dy !== 0);

/** Labels for the history step / tooltips. */
export const ALIGN_LABEL: Record<AlignMode, string> = {
  left: "Align Left",
  hcenter: "Align Horizontal Centers",
  right: "Align Right",
  top: "Align Top",
  vcenter: "Align Vertical Centers",
  bottom: "Align Bottom",
};

export const DISTRIBUTE_LABEL: Record<DistributeMode, string> = {
  hspace: "Distribute Horizontally",
  vspace: "Distribute Vertically",
  hcenter: "Distribute Horizontal Centers",
  vcenter: "Distribute Vertical Centers",
};
