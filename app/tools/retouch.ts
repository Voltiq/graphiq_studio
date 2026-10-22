// The retouch brushes — Blur, Smudge (and the Mixer brush, a smudge with a
// reservoir), Dodge/Burn and Sponge. Each is one engine session per stroke:
// begun on the press, fed every move, ended on the lift. A ring follows the
// pointer, and stays put while it is outside the canvas mid-stroke.

import { parseColor } from "../lib/color";
import type { Pt, ToolController, ToolHost } from "./types";

interface Retouch {
  /** Start the engine session at `p` on layer `id`. */
  begin(h: ToolHost, id: string, p: Pt): void;
  move(h: ToolHost, p: Pt): void;
  end(h: ToolHost): void;
  /** Abandon the session: the layer as it was, no history step. */
  cancel(h: ToolHost): void;
  /** The tip the ring shows. */
  tip(h: ToolHost): { size: number; hardness: number };
}

function retouch(r: Retouch): ToolController {
  /** A stroke is in progress. */
  let active = false;
  /** Where the ring is (doc px); null = not over the canvas. */
  let hover: Pt | null = null;
  return {
    down(e, h) {
      const id = h.activeLayerId;
      if (!id) return; // nothing to retouch on an empty doc
      if (h.paintBlocked(id)) return; // pixels-locked layer
      if (h.engine.isFloating) h.engine.commitFloat();
      e.preventDefault();
      h.capture(e);
      active = true;
      const p = h.toDoc(e);
      hover = { x: p.x, y: p.y };
      r.begin(h, id, p);
    },
    hover(cur, _e, h) {
      hover = { x: cur.x, y: cur.y };
      h.redraw();
    },
    move(e, h) {
      if (!active) return false;
      const p = h.toDoc(e);
      r.move(h, p);
      return true;
    },
    up(_e, h) {
      if (!active) return;
      r.end(h);
      active = false;
    },
    cancel(h) {
      if (!active) return;
      r.cancel(h);
      active = false;
    },
    leave(h) {
      if (active) return; // the ring stays while the stroke is dragged out
      hover = null;
      h.redraw();
    },
    drawOverlay(o, h) {
      if (!hover) return;
      const { p, s } = o;
      const t = r.tip(h);
      const hx = p.x + hover.x * s;
      const hy = p.y + hover.y * s;
      o.ring(hx, hy, Math.max(1, (t.size / 2) * s), t.hardness);
    },
    wantsOverlay: () => !!hover,
    busy: () => active,
  };
}

const confined = (h: ToolHost) => [h.selection.rects, h.selection.angle, h.selection.pivot] as const;

export const blurTool = (): ToolController =>
  retouch({
    begin: (h, id, p) => h.engine.beginBlur(id, h.settings.blur, p.x, p.y, ...confined(h)),
    move: (h, p) => h.engine.moveBlur(p.x, p.y),
    end: (h) => h.engine.endBlur(),
    cancel: (h) => h.engine.endBlur(false),
    tip: (h) => h.settings.blur,
  });

/** Smudge and the Mixer brush: one session (the mixer IS a smudge with a
 *  reservoir), one ring — so one controller serves both tools. */
export const smudgeTool = (): ToolController =>
  retouch({
    begin: (h, id, p) => {
      if (h.tool === "mixer") {
        const fc = parseColor(h.foreground);
        h.engine.beginMixer(
          id,
          h.settings.mixer,
          p.x,
          p.y,
          { r: fc.r, g: fc.g, b: fc.b, a: Math.round(fc.a * 255) },
          ...confined(h),
        );
        return;
      }
      // Finger painting seeds the smear with the foreground colour.
      const fc = h.settings.smudge.fingerPaint ? parseColor(h.foreground) : null;
      h.engine.beginSmudge(
        id,
        h.settings.smudge,
        p.x,
        p.y,
        fc ? { r: fc.r, g: fc.g, b: fc.b, a: Math.round(fc.a * 255) } : null,
        ...confined(h),
      );
    },
    move: (h, p) => h.engine.moveSmudge(p.x, p.y),
    end: (h) => h.engine.endSmudge(),
    cancel: (h) => h.engine.endSmudge(false),
    tip: (h) => (h.tool === "mixer" ? h.settings.mixer : h.settings.smudge),
  });

export const dodgeTool = (): ToolController =>
  retouch({
    begin: (h, id, p) => h.engine.beginDodge(id, h.settings.dodge, p.x, p.y, ...confined(h)),
    move: (h, p) => h.engine.moveDodge(p.x, p.y),
    end: (h) => h.engine.endDodge(),
    cancel: (h) => h.engine.endDodge(false),
    tip: (h) => h.settings.dodge,
  });

export const spongeTool = (): ToolController =>
  retouch({
    begin: (h, id, p) => h.engine.beginSponge(id, h.settings.sponge, p.x, p.y, ...confined(h)),
    move: (h, p) => h.engine.moveSponge(p.x, p.y),
    end: (h) => h.engine.endSponge(),
    cancel: (h) => h.engine.endSponge(false),
    tip: (h) => h.settings.sponge,
  });
