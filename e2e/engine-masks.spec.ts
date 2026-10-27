/**
 * The engine's masks (TODO 1.6, app/lib/engine/masks.ts), as the engine wires
 * them: a mask hides what it is painted black over — live under the stroke —
 * and undo and redo take the stroke; a click on the mask or the pixels chooses
 * what a stroke paints; mask view shows the mask's gray; a mask made from a
 * turned selection, made a selection, applied, deleted, added hidden; the image
 * turned with a mask on; a masked layer deleted and brought back, aligned, and
 * saved; the quick mask; saved channels and their thumbnails; the Channels
 * panel's mask histogram.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const rgba = (app: App, x: number, y: number) =>
  app.page.evaluate(
    async ([x, y]) => {
      const bmp = await createImageBitmap((await window.graphiq!.exportPNG(1))!);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data];
    },
    [x, y],
  );
const alpha = async (app: App, x: number, y: number) => (await rgba(app, x, y))[3];
/** The selection's box, as the status bar gives it ("W × H(x, y)"), or null. */
const selBox = (app: App) =>
  app.page.evaluate(() => {
    const t = document.querySelector('footer[data-tour="status"]')?.textContent ?? "";
    const m = /(\d+) × (\d+)\((\d+), (\d+)\)/.exec(t);
    return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
  });
/** How much the overlay draws: the ants, the quick mask's wash. */
const overlayInk = (app: App) =>
  app.page.evaluate(() => {
    let n = 0;
    for (const c of [...document.querySelectorAll("canvas")].filter((x) => /overlay/i.test(x.className))) {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    }
    return n;
  });
const run = (app: App, id: string) => app.page.evaluate((id) => window.graphiq!.run(id), id);
const select = (app: App, r: { x: number; y: number; w: number; h: number }) =>
  app.page.evaluate((r) => window.graphiq!.select([r]), r);
/** A red layer: all of it, or a block. */
const redLayer = async (app: App, r = { x: 0, y: 0, w: 1920, h: 1080 }) => {
  await app.run("layer-new");
  await app.setForeground("#d02020");
  await select(app, r);
  await app.key("Backspace");
  await app.run("select-deselect");
};
const byNumbers = async (app: App, field: "Angle", value: string) => {
  await app.key("m");
  const f = app.page.getByRole("textbox", { name: field }).first();
  await f.fill(value);
  await f.press("Enter");
  await app.settle();
};
/** A press-drag across the canvas at height `fy`, held down until `whileDown` has looked. */
const holdStroke = async (app: App, fy: number, whileDown: () => Promise<void>) => {
  const b = await app.canvasBox();
  await app.page.mouse.move(b.x + b.width * 0.4, b.y + b.height * fy);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x + b.width * 0.6, b.y + b.height * fy, { steps: 20 });
  await app.settle(400);
  await whileDown();
  await app.page.mouse.up();
  await app.settle(400);
};

test("a mask hides what it is painted black over, live under the stroke; undo and redo take the stroke", async ({
  app,
}) => {
  await redLayer(app);
  await run(app, "mask-add");
  await app.brush(80, 100);
  await app.setForeground("#000000");
  await app.parkMouse();
  const before = (await app.stableViewShot()).hash;
  await holdStroke(app, 0.5, async () => {
    expect((await app.viewShot()).hash, "the view shows it before the stroke ends").not.toBe(before);
  });
  expect([await alpha(app, 960, 540), await alpha(app, 300, 540)], "hidden there, not elsewhere").toEqual([0, 255]);
  await app.key("Control+z");
  expect(await alpha(app, 960, 540)).toBe(255);
  await app.key("Control+Shift+z");
  expect(await alpha(app, 960, 540)).toBe(0);
});

test("the pixels' thumbnail or the mask's chooses what a stroke paints", async ({ app }) => {
  await app.openPanelById("layers");
  await redLayer(app);
  await run(app, "mask-add"); // the mask, chosen
  const layers = app.page.locator('[data-panel-id="layers"]');
  await layers.locator('canvas[data-thumb-kind="layer"]').first().click();
  await app.brush(60, 100);
  await app.setForeground("#2040d0");
  await app.drag(0.3);
  expect(await rgba(app, 960, 324), "the pixels painted").toEqual([32, 64, 208, 255]);
  await layers.locator('canvas[data-thumb-kind="mask"]').first().click();
  await app.setForeground("#000000");
  await app.drag(0.7);
  expect([await alpha(app, 960, 756), (await rgba(app, 960, 756))[0]], "the mask painted: hidden, not black").toEqual([
    0, 0,
  ]);
});

test("a layer chosen again shows the surface it was left on", async ({ app }) => {
  await redLayer(app);
  const masked = await app.page.evaluate(() => window.graphiq!.layers()[0].id);
  await run(app, "mask-add");
  const pill = app.page.locator('[data-tour="options"]').getByText("Editing mask", { exact: true });
  await expect(pill).toBeVisible();
  await app.run("layer-new");
  await expect(pill, "another layer: its pixels").toHaveCount(0);
  await app.page.evaluate((id) => window.graphiq!.selectLayer(id), masked);
  await expect(pill, "back: its mask, as it was left").toBeVisible();
});

test("mask view shows the mask's gray, and a stroke while viewing it previews in it", async ({ app }) => {
  await app.openPanelById("channels");
  await redLayer(app);
  await run(app, "mask-add-hide");
  await app.parkMouse();
  const composite = (await app.stableViewShot()).hash;
  const view = app.page.getByRole("button", { name: "View mask on canvas" }).first();
  await view.click();
  await app.parkMouse();
  const gray = (await app.stableViewShot()).hash;
  expect(gray, "the mask, not the composite").not.toBe(composite);
  await app.brush(80, 100);
  await app.setForeground("#ffffff");
  await holdStroke(app, 0.5, async () => {
    expect((await app.viewShot()).hash, "the stroke shows in the mask as it is drawn").not.toBe(gray);
  });
  await view.click();
  expect(await alpha(app, 960, 540), "and revealed the layer").toBe(255);
});

test("a mask from a turned selection; the mask as a selection; applied; deleted; added hidden", async ({ app }) => {
  await redLayer(app);
  await select(app, { x: 600, y: 300, w: 700, h: 400 });
  await byNumbers(app, "Angle", "20");
  await run(app, "mask-from-sel");
  await run(app, "select-deselect");
  expect(await alpha(app, 950, 500), "inside").toBe(255);
  expect(await alpha(app, 610, 310), "the upright box's corner, turned away").toBe(0);
  await run(app, "mask-to-sel");
  const box = (await selBox(app))!;
  expect([box.w > 700, box.h > 400], `the turned rect's box: ${JSON.stringify(box)}`).toEqual([true, true]);
  await run(app, "select-deselect");
  await run(app, "mask-apply");
  expect([await alpha(app, 950, 500), await alpha(app, 610, 310)], "baked into the layer").toEqual([255, 0]);
  await run(app, "mask-add-hide");
  expect(await alpha(app, 950, 500), "all hidden").toBe(0);
  await app.key("Control+z");
  await app.key("Control+Shift+z");
  expect(await alpha(app, 950, 500), "undone and redone: hidden again, as it was made").toBe(0);
  await run(app, "mask-delete");
  expect(await alpha(app, 950, 500), "and back").toBe(255);
  await app.brush(60, 100);
  await app.setForeground("#2040d0");
  await app.drag(0.9);
  expect(await rgba(app, 960, 972), "a stroke after it paints the pixels").toEqual([32, 64, 208, 255]);
});

test("the image turned with a mask on: the mask turns with its layer", async ({ app }) => {
  await redLayer(app);
  await select(app, { x: 0, y: 0, w: 400, h: 1080 });
  await run(app, "mask-from-sel");
  await run(app, "select-deselect");
  await run(app, "image-rotate-cw"); // 1080 × 1920: the left strip is now the top
  expect([await alpha(app, 540, 100), await alpha(app, 540, 1000)]).toEqual([255, 0]);
});

test("a masked layer deleted and brought back keeps its mask; aligned, the mask goes with it", async ({ app }) => {
  await redLayer(app, { x: 800, y: 400, w: 200, h: 200 });
  await select(app, { x: 800, y: 400, w: 100, h: 200 }); // its left half shows
  await run(app, "mask-from-sel");
  await run(app, "select-deselect");
  await run(app, "layer-delete");
  expect(await alpha(app, 850, 500)).toBe(0);
  await app.key("Control+z");
  expect([await alpha(app, 850, 500), await alpha(app, 950, 500)], "back, masked as it was").toEqual([255, 0]);
  await app.pickTool("Move");
  await app.page.locator('[data-tour="options"]').getByText("Canvas", { exact: true }).first().click();
  await app.page.getByRole("button", { name: "Align left edges" }).first().click();
  await app.settle(500);
  expect([await alpha(app, 50, 500), await alpha(app, 150, 500)], "at the left, its mask with it").toEqual([255, 0]);
});

test("the quick mask: from a selection, painted, left as a selection; its strokes leave the render cache be", async ({
  app,
}) => {
  await redLayer(app);
  await select(app, { x: 200, y: 200, w: 300, h: 200 });
  await run(app, "select-quickmask");
  expect(await selBox(app), "in the mask now").toBeNull();
  await app.brush(100, 100);
  await app.setForeground("#ffffff");
  type W = { __gqRenderCache: { stats: () => { misses: number } } };
  const misses = () => app.page.evaluate(() => (window as unknown as W).__gqRenderCache.stats().misses);
  const m0 = await misses();
  await app.drag(0.8, 0.6, 0.9);
  expect(await misses(), "the document's render did not change").toBe(m0);
  await run(app, "select-quickmask");
  const box = (await selBox(app))!;
  expect([box.x, box.y, box.x + box.w > 1700], `both: ${JSON.stringify(box)}`).toEqual([200, 200, true]);
  await run(app, "select-deselect");
  await app.drag(0.1, 0.6, 0.9);
  expect(await rgba(app, 1440, 108), "out of it, a stroke paints the layer").toEqual([255, 255, 255, 255]);
  await app.key("Control+z"); // the stroke
  await app.key("Control+z"); // the deselect
  await app.key("Control+z"); // back into the quick mask, as it was left
  expect(await selBox(app)).toBeNull();
  await app.parkMouse();
  expect(await overlayInk(app), "its red wash over what is masked").toBeGreaterThan(100_000);
  await app.drag(0.2, 0.6, 0.9);
  expect(await rgba(app, 1440, 216), "the stroke went to the mask, not the layer").toEqual([208, 32, 32, 255]);
  await run(app, "select-quickmask");
  expect((await selBox(app))!.y, "and the selection took it").toBeLessThan(200);
});

test("selections saved as channels show as thumbnails, and load back", async ({ app }) => {
  const { page } = app;
  await app.openPanelById("channels");
  await select(app, { x: 100, y: 100, w: 300, h: 200 });
  await page.getByRole("button", { name: "Save selection as channel" }).first().click();
  const dlg = page.locator('div[role="dialog"][aria-label="Save selection"]');
  await dlg.locator('input[aria-label="Channel name"]').fill("kept");
  await dlg.getByRole("button", { name: "Save", exact: true }).click();
  await app.settle(400);
  const thumb = page.locator('[data-panel-id="channels"] img').first();
  await expect(thumb).toHaveAttribute("src", /^data:image\/png/);
  await run(app, "select-deselect");
  await thumb.click();
  await app.settle(400);
  expect(await selBox(app)).toEqual({ w: 300, h: 200, x: 100, y: 100 });
});

test("the Channels panel draws a masked layer's mask histogram", async ({ app }) => {
  await app.openPanelById("channels");
  await redLayer(app, { x: 0, y: 0, w: 960, h: 1080 }); // the right half empty
  await run(app, "mask-add");
  const panel = app.page.locator('[data-panel-id="channels"]');
  /** How high the histogram reaches at its left edge — the black bin — once
   *  settled (it is redrawn on a timer after each change). */
  const histogram = async () => {
    await app.settle(2_000);
    return panel.locator("canvas").first().evaluate((c: HTMLCanvasElement) => {
      const d = c.getContext("2d")!.getImageData(0, 0, 1, c.height).data;
      for (let y = 0; y < c.height; y++) if (d[y * 4 + 3] > 0) return c.height - y;
      return 0;
    });
  };
  const before = await histogram();
  const edge = await rgba(app, 950, 648);
  await app.brush(400, 100);
  await app.setForeground("#000000");
  await app.drag(0.6, 0.72, 0.95); // black on the mask, where the layer has nothing
  expect(await rgba(app, 950, 648), "nothing to see in the picture: the red is all there").toEqual(edge);
  expect([before < 10, (await histogram()) > 100], "but the mask's curve rose at black").toEqual([true, true]);
});

test.describe("saved with the project", () => {
  test.use({ filePickers: false });

  test("a masked layer comes back masked", async ({ app }, info) => {
    await redLayer(app);
    await select(app, { x: 0, y: 0, w: 960, h: 1080 });
    await run(app, "mask-from-sel");
    await run(app, "select-deselect");
    const path = info.outputPath("masked.gproj");
    const dl = app.page.waitForEvent("download", { timeout: 20_000 });
    await app.run("save");
    await (await dl).saveAs(path);
    await app.page.locator('input[type="file"][accept*="gproj"]').setInputFiles(path);
    await app.settle(2_000);
    expect([await alpha(app, 400, 500), await alpha(app, 1500, 500)]).toEqual([255, 0]);
  });
});
