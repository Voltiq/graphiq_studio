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
