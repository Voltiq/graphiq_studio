// Paint bucket: hold to preview the flood-fill region (it follows the pointer;
// Shift = every matching area, connected or not), release to fill. The fill
// then stays live — re-run from the same seed when the OPTIONS change, so the
// tolerance can be auditioned after the click — until the next action, Esc, or
// another tool bakes it.

import { parseColor, toHex8 } from "../lib/color";
import type { Rect } from "../lib/view";
import type { ToolController, ToolHost } from "./types";

export interface BucketController extends ToolController {
  /** The options changed: re-run a live fill with them (once a frame). */
  refill(h: ToolHost): void;
  /** The engine ended the live fill (an undo, another edit): drop its marker. */
  fillEnded(h: ToolHost): void;
}

export function bucketTool(): BucketController {
  /** The press being previewed (until the release fills it). */
  let seed: {
    x: number;
    y: number;
    shift: boolean;
    layerId: string | null;
    slot: "primary" | "secondary"; // chosen at press: left = primary, right = secondary
  } | null = null;
  /** The previewed fill region. */
  let preview: { rects: Rect[]; color: string } | null = null;
  /* Committed-but-still-editable fill: re-runs the flood + fill from the same
     seed when the OPTIONS change, until the next action.

     `color` is frozen at the moment of the commit, and that is the whole point
     of it being here rather than read from the colours when it re-runs. The
     re-run exists so tolerance, contiguity and opacity can be auditioned after
     the click; it must not be a second chance at the colour. Reading the live
     foreground meant that picking a new colour with the bucket still selected
     silently repainted a fill you had already committed — no click, no history
     step, and one Undo then removed the whole fill rather than the change you
     did not ask for. */
  let live: {
    seedX: number;
    seedY: number;
    sampleLayerId: string | null;
    fillLayerId: string;
    /** The slot's colour AS IT WAS when the fill was committed. */
    color: string;
    shift: boolean;
  } | null = null;
  let raf = 0;
  /** The preview's recomputes are throttled, so a big fill can't stall the drag. */
  const throttle = { last: 0, timer: 0 };

  // Recompute the preview region from the current seed (with the host as it is
  // NOW: it may run from the throttle timer). `reuse` reuses the cached layer
  // pixels (true after the first compute of a drag).
  const recompute = (h: ToolHost, reuse: boolean) => {
    if (!seed) return;
    const o = h.settings.bucket;
    const region = h.engine.magicWand(
      seed.layerId ?? "",
      seed.x,
      seed.y,
      { tolerance: o.tolerance, contiguous: !seed.shift && o.contiguous, sampleAll: false },
      reuse,
      null,
    );
    // No source (empty / no layer) → the whole canvas is the fill region.
    const rects = region?.rects ?? [{ x: 0, y: 0, w: h.doc.width, h: h.doc.height }];
    const c = parseColor(seed.slot === "secondary" ? h.background : h.foreground);
    preview = {
      rects,
      color: toHex8({ r: c.r, g: c.g, b: c.b, a: c.a * (o.opacity / 100) }),
    };
    h.redraw();
  };

  // Re-run the live fill from its seed with the current options — the magic
  // wand reuses the cached ORIGINAL pixels, so the region is right even though
  // the layer already shows the fill.
  const rerun = (h: ToolHost) => {
    const lb = live;
    if (!lb) return;
    const o = h.settings.bucket;
    const region = h.engine.magicWand(
      lb.sampleLayerId ?? "",
      lb.seedX,
      lb.seedY,
      { tolerance: o.tolerance, contiguous: !lb.shift && o.contiguous, sampleAll: false },
      true, // reuse the cached original source
      null,
    );
    const rects = region?.rects ?? [{ x: 0, y: 0, w: h.doc.width, h: h.doc.height }];
    /* The frozen colour, not the current one. Opacity is still read live from
       the options above — it is one of the things this re-run exists for. */
    const c = parseColor(lb.color);
    h.engine.liveFill(
      lb.fillLayerId,
      rects,
      toHex8({ r: c.r, g: c.g, b: c.b, a: c.a * (o.opacity / 100) }),
      o.antialias,
    );
  };

  // Commit (bake) the live fill and drop the editing marker.
  const finish = (h: ToolHost) => {
    if (raf) {
      cancelAnimationFrame(raf);
      raf = 0;
    }
    h.engine.endFill();
    live = null;
    h.redraw();
  };

  return {
    layer: "fill",
    cursor: "crosshair",
    rightButton: true, // fills with the secondary colour
    down(e, h) {
      if (h.paintBlocked(h.activeLayerId)) return; // pixels-locked layer
      if (h.engine.isFloating) h.engine.commitFloat();
      finish(h); // bake any previous editable fill before a new one
      e.preventDefault();
      h.capture(e);
      const p = h.toDoc(e);
      // Left button fills with the primary colour, right button with the secondary.
      seed = {
        x: p.x,
        y: p.y,
        shift: e.shiftKey,
        layerId: h.activeLayerId,
        slot: e.button === 2 ? "secondary" : "primary",
      };
      throttle.last = performance.now();
      recompute(h, false); // load source fresh
    },
    move(e, h) {
      if (!seed) return false;
      const p = h.toDoc(e);
      seed = { ...seed, x: p.x, y: p.y, shift: e.shiftKey };
      const now = performance.now();
      clearTimeout(throttle.timer);
      if (now - throttle.last >= 40) {
        throttle.last = now;
        recompute(h, true);
      } else {
        throttle.timer = window.setTimeout(() => {
          throttle.last = performance.now();
          recompute(h.latest(), true);
        }, 40 - (now - throttle.last));
      }
      return true;
    },
    up(e, h) {
      if (!seed) return;
      clearTimeout(throttle.timer);
      // Recompute precisely from the release point, then start an editable fill.
      const p = h.toDoc(e);
      const at = { ...seed, x: p.x, y: p.y, shift: e.shiftKey };
      seed = at;
      recompute(h, true);
      const hasRegion = !!preview?.rects.length;
      seed = null;
      preview = null; // the fill goes onto the layer now (no overlay preview)
      h.release(e);
      if (hasRegion) {
        // Keep the fill live: re-runs from this seed when the options change,
        // until the next action. The seed pixel is marked on the overlay.
        live = {
          seedX: Math.floor(p.x),
          seedY: Math.floor(p.y),
          sampleLayerId: at.layerId,
          fillLayerId: at.layerId ?? h.ensureLayer(),
          color: at.slot === "secondary" ? h.background : h.foreground,
          shift: at.shift,
        };
        rerun(h);
      }
      h.redraw();
    },
    // A pinch drops the press: nothing is filled.
    cancel(h) {
      if (!seed) return;
      seed = null; // (a throttled preview then finds no press)
      preview = null;
      h.redraw();
    },
    refill(h) {
      if (!live || raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        rerun(h.latest());
      });
    },
    fillEnded(h) {
      live = null;
      h.redraw();
    },
    // Leaving the bucket bakes the live fill.
    deselect(h) {
      if (live) finish(h);
    },
    // Esc deselects the just-filled pixel — keeping the fill, dropping the marker.
    keyDown(e, h) {
      if (e.key === "Escape" && live) {
        e.preventDefault();
        finish(h);
      }
    },
    drawOverlay(o) {
      const { ctx, p, s } = o;
      // The area that will be filled. Clip to the whole region and fill once:
      // filling each rect separately anti-aliases both sides of every shared
      // edge, which shows as faint seam lines through a semi-transparent fill.
      const bk = preview;
      if (bk && bk.rects.length) {
        ctx.save();
        ctx.beginPath();
        for (const r of bk.rects) ctx.rect(p.x + r.x * s, p.y + r.y * s, r.w * s, r.h * s);
        ctx.clip();
        ctx.fillStyle = bk.color;
        ctx.fillRect(0, 0, o.width, o.height);
        ctx.restore();
      }
      // The live fill: a solid border on the clicked (seed) pixel — the pixel
      // itself, but never smaller than ~7px so it stays visible.
      const lb = live;
      if (lb) {
        const size = Math.max(s, 7);
        const cx = p.x + (lb.seedX + 0.5) * s;
        const cy = p.y + (lb.seedY + 0.5) * s;
        const x = Math.round(cx - size / 2) + 0.5;
        const y = Math.round(cy - size / 2) + 0.5;
        ctx.setLineDash([]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.6)";
        ctx.strokeRect(x, y, size, size);
        ctx.lineWidth = 1.5;
        ctx.strokeStyle = "#fff";
        ctx.strokeRect(x, y, size, size);
      }
    },
    wantsOverlay: () => !!(preview || live),
    busy: () => seed !== null,
  };
}
