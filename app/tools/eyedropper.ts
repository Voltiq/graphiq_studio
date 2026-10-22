// Eyedropper: a click (or a drag) samples the colour under the pointer into the
// foreground; Shift-click drops an Info-panel colour sampler, and a sampler is
// dragged by grabbing it (Alt or right-click removes it), as in Photoshop.
//
// On touch and pen a tap is provisional: it leaves a marker over the pixel it
// sampled, and a press near the marker picks it up — held by the offset the
// grab started with, so the finger sits clear of what it is aiming — rather
// than sampling afresh under the finger. A mouse hits its pixel first time and
// gets no marker in the way of its next click.

import type { Pt, ToolController, ToolHost } from "./types";

// Custom eyedropper cursor: the dropper's tip points down-left toward the sample
// point, with the body offset up-right and a gap so the sampled pixel stays
// visible (uncovered). The hotspot sits in that gap, on the sampled pixel.
const EYEDROPPER_PATHS =
  '<path d="m2 22 1-1h3l9-9"/>' +
  '<path d="M3 21v-3l9-9"/>' +
  '<path d="m15 6 3.4-3.4a2.1 2.1 0 1 1 3 3L18 9l.4.4a2.1 2.1 0 1 1-3 3l-3.8-3.8a2.1 2.1 0 1 1 3-3l.4.4Z"/>';
const EYEDROPPER_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">' +
  '<g transform="translate(7,3)" fill="none" stroke-linecap="round" stroke-linejoin="round">' +
  `<g stroke="#000" stroke-opacity="0.5" stroke-width="3.4">${EYEDROPPER_PATHS}</g>` +
  `<g stroke="#fff" stroke-width="1.6">${EYEDROPPER_PATHS}</g>` +
  "</g></svg>";
// Hotspot (4, 30): down-left of the drawn tip (~9, 25), so the tip aims at it.
export const EYEDROPPER_CURSOR = `url("data:image/svg+xml,${encodeURIComponent(EYEDROPPER_SVG)}") 4 30, crosshair`;

export function eyedropperTool(): ToolController {
  /** A press is sampling (the drag goes on sampling). */
  let picking = false;
  /** The pixel the outline is drawn round (doc px). */
  let hover: Pt | null = null;
  /** The provisional placement marker (touch and pen). */
  let place: Pt | null = null;
  /** Offset from the pointer to the marker while it is being dragged. */
  let grab: { dx: number; dy: number } | null = null;
  /** The sampler being dragged, and the list as it was when the drag began
   *  (so the whole gesture is one undo step). */
  let samplerDrag: { id: string; before: ReturnType<ToolHost["samplers"]["list"]> } | null = null;

  /** Sample at a DOCUMENT point, wherever the pointer itself happens to be.
   *  The Info panel reads the cursor stream, so it is told the sampled point
   *  rather than the finger's — while a marker is being dragged those differ,
   *  and the readout the item asks you to watch has to describe the marker. */
  const pickAt = (h: ToolHost, q: Pt) => {
    hover = { x: q.x, y: q.y };
    const { width, height } = h.doc;
    h.cursorAt(
      q.x >= 0 && q.y >= 0 && q.x < width && q.y < height ? { x: Math.floor(q.x), y: Math.floor(q.y) } : null,
    );
    const { size, all } = h.settings.sample;
    const hex = h.engine.sampleColor(Math.floor(q.x), Math.floor(q.y), size, all, h.activeLayerId);
    if (hex) h.pick(hex);
  };

  /** Esc, or another tool: the RESULT stands, the handle for adjusting it goes. */
  const clearPlacement = (h: ToolHost) => {
    if (!place && !grab) return;
    place = null;
    grab = null;
    h.redraw();
  };

  return {
    cursor: EYEDROPPER_CURSOR,
    layer: "sample",
    down(e, h) {
      e.preventDefault();
      h.capture(e);
      // Tolerance is in DOCUMENT units but wants to be a constant number of
      // SCREEN pixels — at 800% zoom a 6-document-pixel grab radius would be
      // half the viewport, and at 10% it would be unclickable.
      const p = h.toDoc(e);
      const tol = h.grab(8);
      const hit = h.samplers.hit(p.x, p.y, tol);
      if (hit && (e.altKey || e.button === 2)) {
        h.samplers.remove(hit.id);
        return;
      }
      if (hit) {
        // Grab it. The whole drag becomes one undo step, committed on release.
        samplerDrag = { id: hit.id, before: h.samplers.list() };
        return;
      }
      if (e.shiftKey) {
        h.samplers.add(p.x, p.y);
        return;
      }
      /* Near the existing marker: pick it up rather than sample where the
         finger landed. Uses the same pointer-scaled radius as every other
         on-canvas handle, so on touch anywhere within ~22px counts as "this
         one" — which is the point, since the finger covers roughly that much. */
      const mark = place;
      if (mark && e.pointerType !== "mouse") {
        const d = Math.hypot(p.x - mark.x, p.y - mark.y);
        if (d <= h.grab(12)) {
          grab = { dx: mark.x - p.x, dy: mark.y - p.y };
          picking = true;
          pickAt(h, mark);
          h.loupe(e, mark);
          h.redraw();
          return;
        }
      }
      picking = true;
      grab = null;
      pickAt(h, p);
      place = e.pointerType === "mouse" ? null : { x: p.x, y: p.y };
      h.redraw();
    },
    // The selected tool's: a sampler or the marker follows the drag, a press
    // samples as it goes, and otherwise the outline follows the pointer.
    hover(cur, e, h) {
      if (samplerDrag) {
        h.samplers.moveLive(samplerDrag.id, cur.x, cur.y);
        return true;
      }
      if (picking) {
        const g = grab;
        if (g) {
          const at = { x: cur.x + g.dx, y: cur.y + g.dy };
          place = at;
          pickAt(h, at);
          h.loupe(e, at);
        } else {
          pickAt(h, cur);
          if (e.pointerType !== "mouse") place = { x: cur.x, y: cur.y };
        }
      } else {
        hover = { x: cur.x, y: cur.y };
      }
      h.redraw();
      return true;
    },
    up(e, h) {
      if (samplerDrag) {
        // One undo step for the whole drag, not one per pointer move.
        h.samplers.commitMove(samplerDrag.before);
        samplerDrag = null;
        h.release(e);
        return;
      }
      if (picking) {
        picking = false;
        /* The marker stays where the sample was taken — that is what makes the
           placement provisional rather than final. Only the GRAB ends here. */
        grab = null;
        h.release(e);
      }
    },
    // A pinch stops the sampling — what a tap took stands, as a tap's does —
    // and puts a dragged sampler back where it was.
    cancel(h) {
      picking = false; // (a marker's grab is only read while picking)
      const d = samplerDrag;
      samplerDrag = null;
      const was = d?.before.find((s) => s.id === d.id);
      if (was) h.samplers.moveLive(was.id, was.x, was.y);
    },
    leave(h) {
      if (picking) return;
      hover = null;
      h.redraw();
    },
    // Another tool: the outline and the marker go.
    deselect(h) {
      hover = null;
      place = null;
      grab = null;
      h.redraw();
    },
    // Esc drops the marker, keeping the colour it sampled.
    keyDown(e, h) {
      if (e.key === "Escape" && place) {
        e.preventDefault();
        clearPlacement(h);
      }
    },
    drawOverlay(o, h) {
      if (!o.selected) return;
      const { ctx, p, s } = o;
      // A solid outline around the pixels being sampled.
      if (hover) {
        const size = Math.max(1, h.settings.sample.size);
        const half = Math.floor(size / 2);
        const x = Math.round(p.x + (Math.floor(hover.x) - half) * s) + 0.5;
        const y = Math.round(p.y + (Math.floor(hover.y) - half) * s) + 0.5;
        const w = Math.max(1, Math.round(size * s));
        const ht = Math.max(1, Math.round(size * s));
        ctx.setLineDash([]);
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(0,0,0,0.7)";
        ctx.strokeRect(x, y, w, ht);
        ctx.lineWidth = 1;
        ctx.strokeStyle = "#fff";
        ctx.strokeRect(x, y, w, ht);
      }
      // The provisional placement marker: a ring big enough to see past a
      // fingertip, with a hairline cross through the exact pixel it stands for.
      // Drawn last of the eyedropper's chrome so it reads as the thing you can
      // grab.
      if (place) {
        const mx = Math.round(p.x + (Math.floor(place.x) + 0.5) * s) + 0.5;
        const my = Math.round(p.y + (Math.floor(place.y) + 0.5) * s) + 0.5;
        ctx.setLineDash([]);
        for (const [w2, colour] of [[3.5, "rgba(0,0,0,0.65)"], [1.5, "#fff"]] as const) {
          ctx.lineWidth = w2;
          ctx.strokeStyle = colour;
          ctx.beginPath();
          ctx.arc(mx, my, 11, 0, Math.PI * 2);
          ctx.stroke();
          ctx.beginPath();
          ctx.moveTo(mx - 17, my);
          ctx.lineTo(mx - 4, my);
          ctx.moveTo(mx + 4, my);
          ctx.lineTo(mx + 17, my);
          ctx.moveTo(mx, my - 17);
          ctx.lineTo(mx, my - 4);
          ctx.moveTo(mx, my + 4);
          ctx.lineTo(mx, my + 17);
          ctx.stroke();
        }
      }
    },
    wantsOverlay: (selected) => selected && !!(hover || place),
    busy: () => picking || samplerDrag !== null,
  };
}
