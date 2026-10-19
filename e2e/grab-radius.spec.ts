/**
 * On-canvas handles a finger can actually catch. (Ported from tools/verify-grab-radius.js, TODO 2.1.)
 *
 * Every canvas hit test was written for a mouse: 8–12 CSS px, right for a
 * hotspot you can see. A fingertip's contact patch is ~8–10mm, the reported
 * point is its centroid rather than where the user aimed, and the finger
 * covers the target on the way down. Measured before the fix: a touch 12px
 * from a crop handle missed it — and landed outside the box, which the crop
 * tool reads as "rubber-band a new one", so a slightly-off grab DESTROYED the
 * box being adjusted.
 *
 * So no attempt here is perfectly aimed — a synthetic touch is infinitely
 * precise and would pass at any radius. Each is dispatched OFF the handle by
 * a realistic aiming error, and OUTWARD, where a miss is destructive. Three
 * things are asserted separately:
 *   - every one of the eight handles is caught on the first attempt;
 *   - no attempt started a new crop, checked by name, not inferred;
 *   - the same offsets with a MOUSE still miss: the control proving the
 *     offsets are genuinely outside the mouse radius, so the finger column
 *     measures the scaling and not a target that was always big enough.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** How far off each attempt lands — outside the mouse's 9px, inside a finger's. */
const OFFSET = 14;
type Box = { x: number; y: number; w: number; h: number };

/* The crop shield dims outside the box (alpha 166) far more than inside (58),
   so the box is the bounding box of the lighter overlay pixels — the box the
   user can SEE. The overlay is the last canvas that is not the loupe: "the
   last canvas" alone measured a 132px circle once the loupe was added. */
const cropBox = (page: Page) =>
  page.evaluate((): Box | null => {
    const ov = [...document.querySelectorAll<HTMLCanvasElement>('[data-tour="canvas"] canvas')].filter((c) => !c.hasAttribute("data-loupe")).pop()!;
    const d = ov.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, ov.width, ov.height).data;
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1;
    let y1 = -1;
    for (let y = 0; y < ov.height; y++)
      for (let x = 0; x < ov.width; x++) {
        if (d[(y * ov.width + x) * 4 + 3] > 100) continue;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    if (x1 < 0) return null;
    const r = ov.getBoundingClientRect();
    return { x: Math.round(r.left + x0), y: Math.round(r.top + y0), w: x1 - x0, h: y1 - y0 };
  });

const DIRS: Record<string, [number, number]> = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
};

async function drag(app: App, fx: number, fy: number, tx: number, ty: number, input: "finger" | "mouse") {
  if (input === "mouse") {
    const { mouse } = app.page;
    await mouse.move(fx, fy);
    await mouse.down();
    await mouse.move(tx, ty, { steps: 8 });
    await mouse.up();
  } else {
    await app.touchDown(fx, fy);
    await app.touchMove(tx, ty, 8);
    await app.touchUp();
  }
  await app.settle(520);
}

/* A crop box with room around it. Selecting Crop lays a box over the WHOLE
   document; Escape does not clear it and a drag inside it only moves it, so
   its corners are pulled in. Done zoomed out: at fit zoom the document's right
   edge lies under the 20px edge-swipe strip, which would take the press. The
   box is in document coordinates, so it comes back with the view.
     - both insets must exceed OFFSET, or an attempt starts off the artwork
       canvas (which carries the pointer handlers) for a mouse too;
     - the bottom-right inset is larger, so that corner plus its offset clears
       the right-hand strip;
     - the rest must stay big enough that the RADIUS, not the crop tool's cap
       (40% of the smaller half-extent), decides. */
async function freshBox(app: App): Promise<Box> {
  const { page } = app;
  await app.key("Escape");
  await app.key("c");
  await page.keyboard.press("Control+Minus");
  await app.settle(600);
  const f = (await cropBox(page))!;
  await drag(app, f.x, f.y, f.x + 11, f.y + 11, "mouse");
  await drag(app, f.x + f.w, f.y + f.h, f.x + f.w - 20, f.y + f.h - 20, "mouse");
  await page.keyboard.press("Control+0"); // back to fit, box and all
  await app.settle(700);
  return (await cropBox(page))!;
}

const edge = (b: Box, u: number, axis: "x" | "y") => (axis === "x" ? (u < 0 ? b.x : b.x + b.w) : u < 0 ? b.y : b.y + b.h);

/** One attempt at one handle, OFFSET px outside it: grabbed / new crop / missed / moved. */
async function attempt(app: App, box: Box, key: string, input: "finger" | "mouse"): Promise<string> {
  const [ux, uy] = DIRS[key];
  const ox = box.x + box.w * (ux === 0 ? 0.5 : ux < 0 ? 0 : 1) + ux * OFFSET;
  const oy = box.y + box.h * (uy === 0 ? 0.5 : uy < 0 ? 0 : 1) + uy * OFFSET;
  await drag(app, ox, oy, ox - ux * 34, oy - uy * 34, input);
  const after = await cropBox(app.page);
  if (!after) return "gone";
  // A new crop shares no edge with the old box and is much smaller — named, not inferred.
  const shares =
    Math.abs(after.x - box.x) <= 4 ||
    Math.abs(after.y - box.y) <= 4 ||
    Math.abs(after.x + after.w - (box.x + box.w)) <= 4 ||
    Math.abs(after.y + after.h - (box.y + box.h)) <= 4;
  if (!shares && after.w < box.w * 0.6 && after.h < box.h * 0.6) return "new crop";
  /* Grabbed ⇔ the handle's own edge moved inward, the opposite edge stayed,
     and an axis the handle does not own did not move. Not "shrank by the drag
     distance": the corner snaps to the pointer, so a start OFFSET px away
     shrinks it by 34 − OFFSET — reading that as a miss once measured every
     radius as 4px. */
  for (const [u, axis] of [
    [ux, "x"],
    [uy, "y"],
  ] as const) {
    if (u === 0) {
      if (Math.abs(edge(after, -1, axis) - edge(box, -1, axis)) > 4 || Math.abs(edge(after, 1, axis) - edge(box, 1, axis)) > 4) return "moved";
      continue;
    }
    const inward = (edge(after, u, axis) - edge(box, u, axis)) * -u;
    const opposite = Math.abs(edge(after, -u, axis) - edge(box, -u, axis));
    if (inward < 10 || opposite > 4) return "missed";
  }
  return "grabbed";
}

async function sweep(app: App, input: "finger" | "mouse") {
  const out: Record<string, string> = {};
  for (const key of Object.keys(DIRS)) out[key] = await attempt(app, await freshBox(app), key, input);
  return out;
}

test("the setup: a crop box to grab, clear of the edge strips, big enough that the radius decides", async ({ app }) => {
  const b = await freshBox(app);
  expect(b.w > 120 && b.h > 60, `a box ${b.w}×${b.h} at ${b.x},${b.y}`).toBe(true);
  expect(b.x - OFFSET > 20 && b.x + b.w + OFFSET < 370, `attempts span ${b.x - OFFSET}–${b.x + b.w + OFFSET} of 20–370`).toBe(true);
  expect(Math.min(b.w, b.h) * 0.2, "the 40% cap is not below a finger's 22.5px radius").toBeGreaterThanOrEqual(22.5);
});

test(`a finger ${OFFSET}px off catches all eight handles, and never starts a new crop`, async ({ app }) => {
  const r = await sweep(app, "finger");
  expect(Object.values(r).filter((v) => v === "new crop"), "no attempt replaced the box").toEqual([]);
  expect(r, "every handle caught on the first attempt").toEqual(Object.fromEntries(Object.keys(DIRS).map((k) => [k, "grabbed"])));
});

test(`the same ${OFFSET}px misses with a mouse — so it is a real miss — and a mouse ON a handle still grabs`, async ({ app }) => {
  const r = await sweep(app, "mouse");
  expect(Object.values(r).filter((v) => v === "grabbed"), `the mouse caught none: ${JSON.stringify(r)}`).toEqual([]);
  // The radius shrank for nobody: a mouse on the corner still takes it.
  const box = await freshBox(app);
  await drag(app, box.x + box.w, box.y + box.h, box.x + box.w - 34, box.y + box.h - 34, "mouse");
  const after = (await cropBox(app.page))!;
  expect(box.w - after.w >= 10 && box.h - after.h >= 10, `${box.w}×${box.h} → ${after.w}×${after.h}`).toBe(true);
});

test("the middle of a SMALL box still moves it: the finger radius is capped", async ({ app }) => {
  /* A finger's radius is 2.5× a mouse's, and on a small box wider than the
     box: every point would be within reach of both the top and bottom handle,
     and "move" would have nowhere to live. So it is capped at 40% of the
     smaller half-extent. ~30px tall is the size where the cap decides: half of
     it, 15px, is INSIDE an uncapped 22.5px radius — a 44px-tall box (the
     script's first version) sat on the wrong side and its mutant survived. */
  const { page } = app;
  await app.key("Escape");
  await app.key("c");
  const full = (await cropBox(page))!;
  await drag(app, full.x, full.y, full.x + full.w - 70, full.y + full.h - 30, "mouse");
  const small = (await cropBox(page))!;
  expect(small.h >= 20 && small.h <= 36 && small.w > 50, `a small box: ${small.w}×${small.h}`).toBe(true);
  const cx = small.x + small.w / 2;
  const cy = small.y + small.h / 2;
  await drag(app, cx, cy, cx - 30, cy - 30, "finger");
  const moved = (await cropBox(page))!;
  expect(Math.abs(moved.w - small.w) <= 4 && Math.abs(moved.h - small.h) <= 4, `size kept: ${small.w}×${small.h} → ${moved.w}×${moved.h}`).toBe(true);
  expect(small.x - moved.x, "...and it moved").toBeGreaterThan(10);
});
