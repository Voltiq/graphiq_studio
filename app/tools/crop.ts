// Crop: a box (straightened, aspect-locked, or free) or — in perspective mode
// — a free quad, adjusted by its handles. The box itself is the editor's (the
// options bar edits it; Enter applies it): this is the drag, and the crop's
// own overlay — the shield, the guides, the handles.

import type { CropGrid, CropQuad } from "../lib/tools";
import type { Rect } from "../lib/view";
import type { Pt, ToolController, ToolHost } from "./types";

type Handle = "nw" | "ne" | "sw" | "se" | "n" | "s" | "w" | "e" | "move" | "outside";

const CROP_CURSOR: Record<Handle, string> = {
  nw: "nwse-resize",
  se: "nwse-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  move: "move",
  outside: "crosshair",
};

/** Classify a doc-space point against the (possibly straightened) crop box: a
 *  corner (nw/ne/se/sw), an edge (n/e/s/w), "move" (inside), or "outside". */
export function cropHandleAt(h: ToolHost, pt: Pt): Handle | null {
  const cb = h.crop.box;
  if (!cb) return null;
  const a = (-h.crop.straighten * Math.PI) / 180;
  const cx = cb.x + cb.w / 2;
  const cy = cb.y + cb.h / 2;
  const cos = Math.cos(a);
  const sin = Math.sin(a);
  const dx = pt.x - cx;
  const dy = pt.y - cy;
  const lx = dx * cos - dy * sin; // into the box's leveled frame
  const ly = dx * sin + dy * cos;
  const hw = cb.w / 2;
  const hh = cb.h / 2;
  /* Capped at 40% of the box's smaller half-extent: without it a finger's
     radius on a small box would make every point a corner, and there would be
     nowhere left to grab that means "move". The cap never goes below the 9px
     a mouse gets, so a tiny box is no worse than it was. */
  const tol = h.grab(9, Math.min(hw, hh) * 0.4);
  if (lx < -hw - tol || lx > hw + tol || ly < -hh - tol || ly > hh + tol) return "outside";
  const nL = Math.abs(lx + hw) <= tol;
  const nR = Math.abs(lx - hw) <= tol;
  const nT = Math.abs(ly + hh) <= tol;
  const nB = Math.abs(ly - hh) <= tol;
  if (nT && nL) return "nw";
  if (nT && nR) return "ne";
  if (nB && nL) return "sw";
  if (nB && nR) return "se";
  if (nT) return "n";
  if (nB) return "s";
  if (nL) return "w";
  if (nR) return "e";
  return "move";
}

/** Resolve a crop drag (move / resize a handle / rubber-band a new box) to the
 *  next box, honouring the locked aspect ratio and clamping to the canvas when
 *  the crop isn't straightened. */
export function cropDragTo(
  h: ToolHost,
  drag: { handle: Handle | "new"; px: number; py: number; box: Rect },
  pt: Pt,
): Rect {
  const { width, height } = h.doc;
  const aspect = h.crop.aspect;
  const ang = h.crop.straighten;
  const rad = (ang * Math.PI) / 180;
  const clampToCanvas = ang === 0;
  const minSize = 8;
  const round = (r: Rect): Rect => ({
    x: Math.round(r.x),
    y: Math.round(r.y),
    w: Math.max(1, Math.round(r.w)),
    h: Math.max(1, Math.round(r.h)),
  });

  if (drag.handle === "move") {
    let nx = drag.box.x + (pt.x - drag.px);
    let ny = drag.box.y + (pt.y - drag.py);
    if (clampToCanvas) {
      nx = Math.max(0, Math.min(width - drag.box.w, nx));
      ny = Math.max(0, Math.min(height - drag.box.h, ny));
    }
    return round({ ...drag.box, x: nx, y: ny });
  }

  if (drag.handle === "new") {
    let x = Math.min(drag.px, pt.x);
    let y = Math.min(drag.py, pt.y);
    let w = Math.abs(pt.x - drag.px);
    let ht = Math.abs(pt.y - drag.py);
    if (aspect) {
      if (w / Math.max(1, ht) > aspect) w = ht * aspect;
      else ht = w / aspect;
      x = pt.x < drag.px ? drag.px - w : drag.px;
      y = pt.y < drag.py ? drag.py - ht : drag.py;
    }
    if (clampToCanvas) {
      x = Math.max(0, Math.min(width - 1, x));
      y = Math.max(0, Math.min(height - 1, y));
      w = Math.min(w, width - x);
      ht = Math.min(ht, height - y);
    }
    return round({ x, y, w: Math.max(minSize, w), h: Math.max(minSize, ht) });
  }

  // Edge / corner resize, computed in the box's leveled frame.
  const b = drag.box;
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const toLocal = (q: Pt) => {
    const ddx = q.x - cx;
    const ddy = q.y - cy;
    return { x: ddx * cos + ddy * sin, y: -ddx * sin + ddy * cos };
  };
  const toDocPt = (l: Pt) => ({
    x: cx + l.x * cos - l.y * sin,
    y: cy + l.x * sin + l.y * cos,
  });
  const PL = toLocal(pt);
  let left = -b.w / 2;
  let right = b.w / 2;
  let top = -b.h / 2;
  let bottom = b.h / 2;
  const mL = drag.handle.includes("w");
  const mR = drag.handle.includes("e");
  const mT = drag.handle.includes("n");
  const mB = drag.handle.includes("s");
  if (mL) left = Math.min(PL.x, right - minSize);
  if (mR) right = Math.max(PL.x, left + minSize);
  if (mT) top = Math.min(PL.y, bottom - minSize);
  if (mB) bottom = Math.max(PL.y, top + minSize);

  if (aspect) {
    const corner = (mL || mR) && (mT || mB);
    let w = right - left;
    let ht = bottom - top;
    if (corner) {
      ht = w / aspect;
      if (mT) top = bottom - ht;
      else bottom = top + ht;
    } else if (mL || mR) {
      ht = w / aspect;
      const midY = (top + bottom) / 2;
      top = midY - ht / 2;
      bottom = midY + ht / 2;
    } else {
      w = ht * aspect;
      const midX = (left + right) / 2;
      left = midX - w / 2;
      right = midX + w / 2;
    }
  }

  const w = right - left;
  const ht = bottom - top;
  const center = toDocPt({ x: (left + right) / 2, y: (top + bottom) / 2 });
  let nx = center.x - w / 2;
  let ny = center.y - ht / 2;
  if (clampToCanvas) {
    nx = Math.max(0, Math.min(width - w, nx));
    ny = Math.max(0, Math.min(height - ht, ny));
  }
  return round({ x: nx, y: ny, w, h: ht });
}

export function cropTool(): ToolController {
  /** A box drag: the handle (or "new"), where it began, and the box then. */
  let drag: { handle: Handle | "new"; px: number; py: number; box: Rect } | null = null;
  /** The perspective quad's corner being dragged, and the quad then. */
  let corner: { idx: number; quad: CropQuad } | null = null;
  return {
    layer: "crop",
    cursor: "crosshair",
    down(e, h) {
      const pq = h.crop.quad;
      if (pq) {
        // Perspective mode: grab the nearest corner.
        e.preventDefault();
        const p = h.toDoc(e);
        const hit = h.grab(12);
        let idx = -1;
        let best = hit;
        for (let i = 0; i < 4; i++) {
          const d = Math.hypot(p.x - pq[i].x, p.y - pq[i].y);
          if (d <= best) {
            best = d;
            idx = i;
          }
        }
        if (idx >= 0) {
          h.capture(e);
          corner = { idx, quad: pq };
          h.redraw();
        }
        return;
      }
      const box = h.crop.box;
      if (!box) return;
      e.preventDefault();
      const p = h.toDoc(e);
      const handle = cropHandleAt(h, p);
      h.capture(e);
      drag = {
        handle: handle === "outside" || handle === null ? "new" : handle,
        px: p.x,
        py: p.y,
        box: { ...box },
      };
      h.redraw();
    },
    // The selected tool's: a corner or the box follows the drag, else the
    // cursor says what a press would do. Crop takes every move.
    hover(cur, _e, h) {
      // Perspective mode: drag a quad corner (clamped to the canvas).
      const pq = h.crop.quad;
      if (pq) {
        if (corner) {
          const { idx } = corner;
          const nx = Math.max(0, Math.min(h.doc.width, cur.x));
          const ny = Math.max(0, Math.min(h.doc.height, cur.y));
          const next = pq.map((c, i) => (i === idx ? { x: nx, y: ny } : c)) as CropQuad;
          h.crop.setQuad(next);
          h.redraw();
        } else {
          const hit = h.grab(12);
          const onCorner = pq.some((c) => Math.hypot(cur.x - c.x, cur.y - c.y) <= hit);
          h.setCursor(onCorner ? "grab" : "crosshair");
        }
        return true;
      }
      if (drag) {
        h.crop.setBox(cropDragTo(h, drag, cur));
        h.redraw();
        return true;
      }
      if (h.crop.box) h.setCursor(CROP_CURSOR[cropHandleAt(h, cur) ?? "outside"] ?? "crosshair");
      return true;
    },
    up(e, h) {
      if (corner) {
        corner = null;
        h.release(e);
        h.redraw();
        return;
      }
      if (drag) {
        drag = null;
        h.release(e);
        h.redraw();
      }
    },
    // A pinch puts the box (or the quad) back as it was before the drag.
    cancel(h) {
      if (drag) h.crop.setBox(drag.box);
      if (corner) h.crop.setQuad(corner.quad);
      drag = null;
      corner = null;
    },
    // A double-click applies it: anywhere on a perspective quad, inside a box.
    doubleClick(e, h) {
      if (h.crop.quad || (h.crop.box && cropHandleAt(h, h.toDoc(e)) === "move")) h.crop.apply();
    },
    // Its own complete UI: shield + box/quad + guides + handles. It owns the
    // overlay: nothing else is drawn while it is up.
    drawOverlay(o, h) {
      const cb = h.crop.box;
      const pq = h.crop.quad; // non-null ⇒ perspective mode (free quad)
      if (!o.selected || !(cb || pq)) return;
      const { ctx, p, s } = o;
      let tl: [number, number];
      let tr: [number, number];
      let br: [number, number];
      let bl: [number, number];
      if (pq) {
        const sc = (pt: Pt): [number, number] => [p.x + pt.x * s, p.y + pt.y * s];
        tl = sc(pq[0]);
        tr = sc(pq[1]);
        br = sc(pq[2]);
        bl = sc(pq[3]);
      } else {
        const box = cb!;
        const ang = (h.crop.straighten * Math.PI) / 180;
        const cx = box.x + box.w / 2;
        const cy = box.y + box.h / 2;
        const scx = p.x + cx * s;
        const scy = p.y + cy * s;
        const cos = Math.cos(ang);
        const sin = Math.sin(ang);
        // A box corner offset (doc px from centre) → rotated screen point.
        const at = (dx: number, dy: number): [number, number] => [
          scx + (dx * cos - dy * sin) * s,
          scy + (dx * sin + dy * cos) * s,
        ];
        const hw = box.w / 2;
        const hh = box.h / 2;
        tl = at(-hw, -hh);
        tr = at(hw, -hh);
        br = at(hw, hh);
        bl = at(-hw, hh);
      }
      const lerp = (a: [number, number], b: [number, number], t: number): [number, number] => [
        a[0] + (b[0] - a[0]) * t,
        a[1] + (b[1] - a[1]) * t,
      ];
      const poly = (pts: [number, number][]) => {
        ctx.beginPath();
        ctx.moveTo(pts[0][0], pts[0][1]);
        for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i][0], pts[i][1]);
        ctx.closePath();
      };

      // Shield: dim everything, then punch out the crop rectangle.
      const shield = h.crop.shield / 100;
      if (shield > 0) {
        ctx.save();
        ctx.fillStyle = `rgba(8,10,14,${shield})`;
        ctx.fillRect(0, 0, o.width, o.height);
        ctx.globalCompositeOperation = "destination-out";
        poly([tl, tr, br, bl]);
        ctx.fill();
        ctx.restore();
      }

      // Composition guide lines inside the box.
      const grid: CropGrid = h.crop.grid;
      if (grid !== "none") {
        ctx.save();
        poly([tl, tr, br, bl]);
        ctx.clip();
        ctx.lineWidth = 1;
        ctx.strokeStyle = "rgba(255,255,255,0.4)";
        const vline = (f: number) => {
          const a = lerp(tl, tr, f);
          const b = lerp(bl, br, f);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        };
        const hline = (g: number) => {
          const a = lerp(tl, bl, g);
          const b = lerp(tr, br, g);
          ctx.beginPath();
          ctx.moveTo(a[0], a[1]);
          ctx.lineTo(b[0], b[1]);
          ctx.stroke();
        };
        if (grid === "thirds") {
          [1 / 3, 2 / 3].forEach(vline);
          [1 / 3, 2 / 3].forEach(hline);
        } else if (grid === "grid") {
          [0.25, 0.5, 0.75].forEach(vline);
          [0.25, 0.5, 0.75].forEach(hline);
        } else if (grid === "golden") {
          [0.382, 0.618].forEach(vline);
          [0.382, 0.618].forEach(hline);
        } else if (grid === "diagonal") {
          ctx.beginPath();
          ctx.moveTo(tl[0], tl[1]);
          ctx.lineTo(br[0], br[1]);
          ctx.moveTo(tr[0], tr[1]);
          ctx.lineTo(bl[0], bl[1]);
          ctx.stroke();
        }
        ctx.restore();
      }

      // Box outline.
      ctx.save();
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = "rgba(255,255,255,0.95)";
      poly([tl, tr, br, bl]);
      ctx.stroke();

      // Handles: 4 corners always; edge midpoints only for a rectangular box
      // (a free quad has no meaningful edge-midpoint drag).
      ctx.lineWidth = 1;
      const drawHandle = (hx: number, hy: number, big: boolean) => {
        const r = big ? 4.5 : 3.5;
        ctx.fillStyle = "rgba(255,255,255,0.98)";
        ctx.strokeStyle = "rgba(0,0,0,0.5)";
        ctx.beginPath();
        ctx.rect(hx - r, hy - r, r * 2, r * 2);
        ctx.fill();
        ctx.stroke();
      };
      [tl, tr, br, bl].forEach(([hx, hy]) => drawHandle(hx, hy, true));
      if (!pq) {
        [lerp(tl, tr, 0.5), lerp(tr, br, 0.5), lerp(br, bl, 0.5), lerp(bl, tl, 0.5)].forEach(([hx, hy]) =>
          drawHandle(hx, hy, false),
        );
      }

      // Size readout: for perspective, the estimated output rectangle.
      const straighten = h.crop.straighten;
      const label = pq
        ? (() => {
            const d = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
            const ow = Math.round((d(pq[0], pq[1]) + d(pq[3], pq[2])) / 2);
            const oh = Math.round((d(pq[0], pq[3]) + d(pq[1], pq[2])) / 2);
            return `${ow} × ${oh}  ⟂`;
          })()
        : `${Math.round(cb!.w)} × ${Math.round(cb!.h)}${straighten ? `   ${straighten}°` : ""}`;
      ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
      const tw = ctx.measureText(label).width;
      const lx = Math.min(tl[0], tr[0], br[0], bl[0]);
      const ly = Math.min(tl[1], tr[1], br[1], bl[1]) - 22;
      ctx.fillStyle = "rgba(8,10,14,0.8)";
      ctx.beginPath();
      ctx.rect(lx, ly, tw + 12, 17);
      ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.92)";
      ctx.textBaseline = "middle";
      ctx.fillText(label, lx + 6, ly + 9);
      ctx.restore();
      return true;
    },
    wantsOverlay: (selected, h) => selected && !!h.crop.box,
    busy: () => drag !== null || corner !== null,
  };
}
