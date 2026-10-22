/**
 * A second finger cancels the first one's gesture — completely.
 * (Ported from tools/verify-pinch-abort.js, TODO 2.1.)
 *
 * A pinch pre-empts whatever a one-finger drag had started, and the danger is
 * not the gesture that visibly stops. It is the one still holding state that
 * the pointer-up will happily COMMIT: a Move survived the pinch, so lifting off
 * baked the layer wherever the finger happened to be, as a real edit, with a
 * history entry to match.
 *
 * Both are asserted, because either alone can pass on broken code: the pixels
 * have to be where they started AND the history has to be the length it was. A
 * move silently reverted but still recorded is a phantom undo step; one
 * recorded but not reverted is the original bug.
 *
 * The setup proves itself first: the same drag WITHOUT a pinch must move the
 * layer and add a step, or the check would be measuring a drag that never did
 * anything.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** Where the ink sits: its centroid over the document-sized canvas (which a
 *  pinch-zoom does not resize — the view transforms it). */
const inkCentre = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
    const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < d.length; i += 4 * 11) {
      if (d[i + 3] > 8) {
        sx += (i / 4) % c.width;
        sy += Math.floor(i / 4 / c.width);
        n++;
      }
    }
    return n ? `${Math.round(sx / n)},${Math.round(sy / n)}` : "none";
  });

/** Steps in the History panel. */
async function historySteps(app: App): Promise<number> {
  const { page } = app;
  /* Wait out a Chromium quirk first: after a touch drag on the `touch-action:
     none` canvas, the next tap's click is dropped for ~2 s
     (REAL-DEVICE-CHECKLIST.md §10), and this tap follows one. */
  await app.settle(2_500);
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
  await app.settle(600);
  await app.setSheetDetent("full");
  expect(await app.openPanelById("history"), "the History panel opens").toBe(true);
  const n = (await app.historyRows()).length;
  await page.evaluate(() => window.history.back());
  await app.settle(600);
  return n;
}

test("a pinch mid-move abandons the move: the layer stays put, and no step is written", async ({ app }) => {
  const { page } = app;
  // A layer with a block of paint on it, so "did it move" is answerable.
  await app.run("layer-new");
  await app.setForeground("#d02060");
  await page.evaluate(() => window.graphiq!.select([{ x: 760, y: 340, w: 400, h: 400 }]));
  await app.key("Backspace");
  await app.run("select-deselect");
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().tap();
  await app.settle(500);
  await page.locator('[data-tour="toolbar"]').getByRole("button", { name: /^Move\b/ }).first().tap();
  await app.settle(500);
  if ((await page.evaluate(() => document.documentElement.dataset.drawer ?? "")) !== "") {
    await page.evaluate(() => window.history.back());
    await app.settle(500);
  }
  const b = await app.canvasBox();
  const c = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };

  // The setup proves itself: a plain one-finger drag DOES move and record.
  const inkBefore = await inkCentre(page);
  expect(inkBefore, "there is ink to move").not.toBe("none");
  const stepsBefore = await historySteps(app);
  await app.touches("touchStart", [c]);
  for (let i = 1; i <= 6; i++) await app.touches("touchMove", [{ x: c.x + i * 9, y: c.y }]);
  await app.touches("touchEnd", []);
  await app.settle(1_000);
  const inkMoved = await inkCentre(page);
  expect(inkMoved, "a one-finger drag moves the layer").not.toBe(inkBefore);
  const stepsMoved = await historySteps(app);
  expect(stepsMoved, "...and records a step for it").toBeGreaterThan(stepsBefore);

  // The real case: a second finger lands mid-drag, and the two pinch apart.
  const zoom = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-tour="canvas"] span')].find((s) => /^\d+%$/.test((s.textContent ?? "").trim()));
      return el ? parseInt(el.textContent!, 10) : NaN;
    });
  const zoomBefore = await zoom();
  await app.touches("touchStart", [c]);
  for (let i = 1; i <= 5; i++) await app.touches("touchMove", [{ x: c.x + i * 10, y: c.y }]);
  await app.touches("touchStart", [
    { x: c.x + 50, y: c.y },
    { x: c.x - 50, y: c.y },
  ]);
  await app.settle(150);
  for (let i = 1; i <= 5; i++)
    await app.touches("touchMove", [
      { x: c.x + 50 + i * 8, y: c.y },
      { x: c.x - 50 - i * 8, y: c.y },
    ]);
  await app.touches("touchEnd", []);
  await app.settle(1_200);
  // Non-vacuity: the second finger really was taken as a pinch.
  expect(await zoom(), "the two fingers zoomed the view").not.toBe(zoomBefore);
  expect(await inkCentre(page), "the pinch leaves the layer where it was").toBe(inkMoved);
  expect(await historySteps(app), "...and writes no history entry for the abandoned move").toBe(stepsMoved);
});

/** A digest of the composite: has the picture changed at all? */
const composite = (page: Page) =>
  page.evaluate(async () => {
    const blob = await window.graphiq!.exportPNG(1);
    const buf = await crypto.subtle.digest("SHA-256", await blob!.arrayBuffer());
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
  });

/** A digest of what the canvas on screen shows: the document-sized view
 *  canvas (a pinch transforms it, it does not resize it). */
const onScreen = (page: Page) =>
  page.evaluate(async () => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
    const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
    const buf = await crypto.subtle.digest("SHA-256", d);
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
  });

/* The retouch brushes paint their layer LIVE, over a snapshot of how it was,
   and commit on the lift. A pinch used to leave such a stroke open: the
   engine has no scratch buffer to throw away, as it has for the brush, so
   the stroke survived — its pixels stayed, the next contact's moves fed it,
   and that contact's lift committed it. Now the pinch puts the layer back and
   ends the stroke, as it does a brush stroke. (The heal is a blob of points
   until the lift; the pinch drops it.) */
const RETOUCH = [
  { tool: "Blur", key: "r", live: true },
  /* An adjustment above keeps a cached product of the picture beneath it.
     The live stroke never bumped the layer's pixel version, so a product
     cached mid-stroke kept its key: unless the cancel tells the cache, the
     composite goes on showing the stroke that was taken back. */
  { tool: "Blur", key: "r", live: true, under: "adj-tone-curves" },
  /* On a layer MASK (half white, half black — its edge under the stroke):
     the engine keeps an alpha cache of a mask, refreshed as the stroke goes,
     so taking the stroke back has to refresh it back. */
  { tool: "Blur", key: "r", live: true, mask: true },
  { tool: "Dodge", key: "o", live: true },
  { tool: "Smudge", key: "f", live: true },
  { tool: "History brush", key: "k", live: true },
  { tool: "Spot heal", key: "j", live: false },
];

for (const r of RETOUCH as { tool: string; key: string; live: boolean; under?: string; mask?: boolean }[]) {
  const what = r.under
    ? `${r.tool} stroke under an adjustment layer`
    : r.mask
      ? `${r.tool} stroke on a layer mask`
      : `${r.tool} stroke`;
  test(`a pinch mid-${what} puts the layer back, writes no step, and leaves nothing open`, async ({ app }) => {
    const { page } = app;
    // A block of paint, so a stroke across its edge has something to change.
    await app.run("layer-new");
    await app.setForeground("#d02060");
    await page.evaluate(() => window.graphiq!.select([{ x: 760, y: 340, w: 400, h: 400 }]));
    await app.key("Backspace");
    await app.run("select-deselect");
    if (r.mask) {
      // A mask from the block's left half: its edge runs down the middle.
      await page.evaluate(() => window.graphiq!.select([{ x: 760, y: 340, w: 200, h: 400 }]));
      await app.run("mask-from-sel");
      await app.run("select-deselect");
    }
    if (r.under) {
      const painted = await page.evaluate(() => window.graphiq!.layers()[0].id);
      await app.run(r.under);
      await page.evaluate((id) => window.graphiq!.selectLayer(id), painted);
      await app.settle(300);
    }
    await app.key(r.key);
    const b = await app.canvasBox();
    const c = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    const zoom = () =>
      page.evaluate(() => {
        const el = [...document.querySelectorAll('[data-tour="canvas"] span')].find((s) =>
          /^\d+%$/.test((s.textContent ?? "").trim()),
        );
        return el ? parseInt(el.textContent!, 10) : NaN;
      });

    const before = await composite(page);
    const shown = await onScreen(page);
    const steps = await historySteps(app);
    const zoomBefore = await zoom();
    // One finger strokes across the block's edge...
    await app.touches("touchStart", [c]);
    for (let i = 1; i <= 5; i++) await app.touches("touchMove", [{ x: c.x - i * 12, y: c.y }]);
    await app.settle(200);
    if (r.live) expect(await composite(page), "the stroke is painting the layer, live").not.toBe(before);
    // ...and a second finger lands: a pinch.
    const at = { x: c.x - 60, y: c.y };
    await app.touches("touchStart", [at, { x: at.x + 100, y: at.y }]);
    await app.settle(150);
    for (let i = 1; i <= 5; i++)
      await app.touches("touchMove", [
        { x: at.x - i * 8, y: at.y },
        { x: at.x + 100 + i * 8, y: at.y },
      ]);
    await app.touches("touchEnd", []);
    await app.settle(1_200);
    expect(await zoom(), "the two fingers zoomed the view").not.toBe(zoomBefore);
    expect(await composite(page), "the pinch puts the layer back as it was").toBe(before);
    expect(await onScreen(page), "...on screen too, not only in the file").toBe(shown);
    expect(await historySteps(app), "...and writes no step for the abandoned stroke").toBe(steps);

    // Nothing was left open: the next stroke is a stroke of its own, one step.
    await app.touches("touchStart", [c]);
    for (let i = 1; i <= 10; i++) await app.touches("touchMove", [{ x: c.x - i * 12, y: c.y }]);
    await app.touches("touchEnd", []);
    await app.settle(1_500);
    expect(await composite(page), "the next stroke changes the picture").not.toBe(before);
    expect(await historySteps(app), "...as exactly one step").toBe(steps + 1);
  });
}
