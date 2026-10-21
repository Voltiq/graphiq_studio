/**
 * Type set along a curve, and taken off it again. (Ported from
 * tools/verify-text-on-path.js, TODO 2.1. The geometry — arc-length lookup,
 * tangents, glyph placement — is tests/textpath.test.ts.)
 *
 * The observable cannot pass by accident: a line of type is a short band; the
 * same string climbing a V is a tall one. So the painted box's HEIGHT is the
 * evidence. ("Did any pixel change" would also pass if the text had merely
 * moved, or vanished.) The pen strokes its path onto the layer, so that layer
 * is hidden before measuring; the Work Path lives on the document, untouched.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 1500, height: 950 } });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** Painted pixels of the document, and the box they occupy. */
const sample = (app: App) =>
  app.page.evaluate(() => {
    const doc = (window as unknown as { __gqMemory: () => { w: number; h: number } }).__gqMemory();
    const c = [...document.querySelectorAll<HTMLCanvasElement>('[data-tour="canvas"] canvas')].find((x) => x.width === doc.w && x.height === doc.h)!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    let x0 = 1e9;
    let y0 = 1e9;
    let x1 = -1;
    let y1 = -1;
    for (let px = 0; px * 4 < d.length; px++)
      if (d[px * 4 + 3]) {
        n++;
        const x = px % c.width;
        const y = (px / c.width) | 0;
        x0 = Math.min(x0, x);
        x1 = Math.max(x1, x);
        y0 = Math.min(y0, y);
        y1 = Math.max(y1, y);
      }
    return n ? { painted: n, w: x1 - x0, h: y1 - y0 } : { painted: 0, w: 0, h: 0 };
  });

/** A Work Path through three points (fractions of the canvas), committed. */
async function workPath(app: App, points: [number, number][]) {
  await app.key("p");
  const box = await app.canvasBox();
  for (const [fx, fy] of points) {
    await app.page.mouse.click(Math.round(box.x + box.width * fx), Math.round(box.y + box.height * fy));
    await app.settle(300);
  }
  await app.page.keyboard.press("Enter");
  await app.settle(800);
}
const hideAllBut = (app: App, keep: string | null) =>
  app.page.evaluate((keep) => {
    const g = window.graphiq!;
    for (const l of g.layers()) if (l.id !== keep) (g as unknown as { setLayer(id: string, p: object): void }).setLayer(l.id, { visible: false });
  }, keep);
const textLayerId = (app: App) => app.page.evaluate(() => window.graphiq!.layers().find((l) => /curving/i.test(l.name ?? ""))?.id ?? null);

test("type climbs a curve, undo and redo move it on and off, and detaching is undoable from the stored layer", async ({ app }) => {
  const { page } = app;
  await app.run("layer-new");
  /* A deep V: a shallow arc would leave the height difference in the noise. */
  await workPath(app, [
    [0.15, 0.35],
    [0.5, 0.8],
    [0.85, 0.35],
  ]);
  expect((await sample(app)).painted, "the pen painted its path (so its layer is hidden to measure type)").toBeGreaterThan(1000);

  await app.key("t");
  const box = await app.canvasBox();
  await page.mouse.click(Math.round(box.x + box.width * 0.2), Math.round(box.y + box.height * 0.45));
  await app.settle(900);
  await page.keyboard.type("Curving type");
  await page.keyboard.press("Control+Enter");
  await app.settle(1500);
  await hideAllBut(app, await textLayerId(app));
  await app.settle(800);
  const flat = await sample(app);
  expect(flat.painted, "the type rasterized").toBeGreaterThan(200);
  expect(flat.h, "...as a flat line first").toBeLessThan(flat.w);

  await app.run("text-on-path");
  await app.settle(1500);
  const curved = await sample(app);
  expect(curved.painted, "Text on path keeps the type").toBeGreaterThan(100);
  expect(curved.h, `...climbing the curve: height ${flat.h} → ${curved.h}`).toBeGreaterThan(flat.h * 3);

  await page.evaluate(() => window.graphiq!.undo());
  await app.settle(1300);
  const undone = await sample(app);
  expect(Math.abs(undone.h - flat.h), "one Undo puts it back on its line").toBeLessThanOrEqual(2);
  expect(Math.abs(undone.painted - flat.painted)).toBeLessThan(flat.painted * 0.1);
  await page.evaluate(() => window.graphiq!.redo());
  await app.settle(1300);
  const again = await sample(app);
  expect(again.h, "...redo puts it back on the path").toBeGreaterThan(flat.h * 3);

  await app.run("text-off-path");
  await app.settle(1400);
  expect(Math.abs((await sample(app)).h - flat.h), "Take text off its path returns it to a line").toBeLessThanOrEqual(2);
  /* Every step above renders from a spec built in the same breath; undoing the
     DETACH is the one that rebuilds it from the stored on-path vector —
     dropping `onPath` from specFromTextVector passed everything else. */
  await page.evaluate(() => window.graphiq!.undo());
  await app.settle(1300);
  expect(Math.abs((await sample(app)).h - again.h), "undoing the detach restores the curve, rebuilt from the layer").toBeLessThanOrEqual(2);
});

test("on a vertical path each glyph is turned onto its side, not left upright", async ({ app }) => {
  /* A box is rotation-BLIND on a V (removing ctx.rotate passed every check
     above). On a vertical path turned glyphs make the ink ribbon as wide as
     the type is tall — 46px measured, against 32px upright — so the threshold
     sits midway. */
  const { page } = app;
  await app.run("layer-new");
  await app.key("t");
  const box = await app.canvasBox();
  await page.mouse.click(Math.round(box.x + box.width * 0.2), Math.round(box.y + box.height * 0.45));
  await app.settle(900);
  await page.keyboard.type("Curving type");
  await page.keyboard.press("Control+Enter");
  await app.settle(1500);
  await workPath(app, [
    [0.62, 0.12],
    [0.62, 0.5],
    [0.62, 0.88],
  ]);
  const text = await textLayerId(app);
  await hideAllBut(app, text);
  await page.evaluate((id) => window.graphiq!.selectLayer(id!), text);
  await app.settle(600);
  await app.run("text-on-path");
  await app.settle(1500);
  const v = await sample(app);
  expect(v.h, `the type runs down the path: ${v.w}×${v.h}`).toBeGreaterThan(v.w * 2);
  expect(v.w, "...each glyph turned (the ribbon is the type's height; upright is 32px)").toBeGreaterThan(39);
});
