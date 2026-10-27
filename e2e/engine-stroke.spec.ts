/**
 * The engine's stroke (TODO 1.6, app/lib/engine/stroke.ts), as the engine wires
 * it: a stroke paints as it is drawn and lands as one step; a pen's pressure
 * narrows it; a hard selection clips it and a soft one fades it; on a mask it
 * hides, live under the stroke, and lands on the mask; the clone stamp copies
 * from its layer, or from every layer.
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
/** How many rows of column `x` the stroke covers, between rows `y0` and `y1`. */
const thickness = (app: App, x: number, y0: number, y1: number) =>
  app.page.evaluate(
    async ([x, y0, y1]) => {
      const bmp = await createImageBitmap((await window.graphiq!.exportPNG(1))!);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(x, y0, 1, y1 - y0).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 128) n++;
      return n;
    },
    [x, y0, y1],
  );
/** The view's middle pixel — the document's middle, fitted on screen. */
const viewMiddle = (app: App) =>
  app.page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
    return [...c.getContext("2d")!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data];
  });
const select = (app: App, r: { x: number; y: number; w: number; h: number }) =>
  app.page.evaluate((r) => window.graphiq!.select([r]), r);
/** A press across the middle of the canvas, held while `whileDown` looks. */
const held = async (app: App, fy: number, whileDown: () => Promise<void>) => {
  const b = await app.canvasBox();
  await app.page.mouse.move(b.x + b.width * 0.3, b.y + b.height * fy);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x + b.width * 0.7, b.y + b.height * fy, { steps: 20 });
  await app.settle(400);
  await whileDown();
  await app.page.mouse.up();
  await app.settle(400);
};
/** A pen stroke at `force`, through the protocol — the only way to press lightly. */
const penStroke = async (app: App, fy: number, force: number) => {
  const b = await app.canvasBox();
  const y = b.y + b.height * fy;
  const at = (fx: number) => b.x + b.width * fx;
  const send = (type: string, x: number, buttons: number) =>
    app.cdp("Input.dispatchMouseEvent", {
      ...{ type, x, y, button: "left", buttons, clickCount: 1 },
      ...{ pointerType: "pen", force },
    });
  await send("mousePressed", at(0.3), 1);
  for (let i = 1; i <= 20; i++) await send("mouseMoved", at(0.3 + (0.4 * i) / 20), 1);
  await send("mouseReleased", at(0.7), 0);
  await app.settle(500);
};

test("a stroke paints as it is drawn, the whole of its path, and lands as one step", async ({ app }) => {
  await app.openPanelById("history");
  await app.run("layer-new");
  await app.brush(40, 100);
  await app.setForeground("#d02020");
  await app.parkMouse();
  const before = (await app.stableViewShot()).hash;
  await held(app, 0.5, async () => {
    expect((await app.viewShot()).hash, "the view shows it before it ends").not.toBe(before);
  });
  expect([await rgba(app, 600, 540), await rgba(app, 1320, 540)], "from end to end").toEqual([
    [208, 32, 32, 255],
    [208, 32, 32, 255],
  ]);
  expect((await app.historyRows()).at(-1)?.replace(/\d+$/, "")).toBe("Brush");
});

test("a pen pressing lightly draws a thinner line than the mouse", async ({ app }) => {
  await app.run("layer-new");
  await app.brush(60, 100);
  await app.setForeground("#202020");
  await app.drag(0.3, 0.3, 0.7);
  await penStroke(app, 0.7, 0.25);
  const mouse = await thickness(app, 960, 200, 450);
  const pen = await thickness(app, 960, 650, 900);
  expect(mouse, "the mouse: the full 60").toBeGreaterThanOrEqual(58);
  expect(pen, `the pen at a quarter: ${pen}`).toBeLessThan(mouse * 0.6);
  expect(pen).toBeGreaterThan(0);
  const start = await thickness(app, 580, 650, 900);
  expect(start, `from its first dab: ${start}`).toBeLessThan(mouse * 0.6);
});

test("a hard selection clips the stroke; a soft one fades it at the edge", async ({ app }) => {
  await app.run("layer-new");
  await select(app, { x: 900, y: 300, w: 200, h: 500 });
  await app.brush(80, 100);
  await app.setForeground("#2040d0");
  await app.drag(0.35, 0.2, 0.8);
  const inside = (await rgba(app, 950, 378))[3];
  expect([inside, (await rgba(app, 880, 378))[3]], "inside, not outside").toEqual([255, 0]);
  await app.run("select-deselect");
  await select(app, { x: 900, y: 600, w: 200, h: 300 });
  await app.page.evaluate(() => window.graphiq!.run("select-feather"));
  const dlg = app.page.locator('div[role="dialog"][aria-modal="true"]').last();
  await dlg.waitFor();
  await app.setRange("Radius", 20);
  await dlg.getByRole("button", { name: "Feather", exact: true }).click();
  await app.settle();
  await app.brush(80, 100);
  await app.drag(0.65, 0.2, 0.8);
  const edge = (await rgba(app, 900, 702))[3];
  const within = (await rgba(app, 1000, 702))[3];
  expect([edge > 0, edge < 255, within], `soft at the edge: ${edge}`).toEqual([true, true, 255]);
});

test("on a mask, a stroke hides the layer — live under the stroke — and lands on the mask", async ({ app }) => {
  await app.setForeground("#ffffff");
  await app.run("fill-solid");
  await app.run("layer-flatten"); // white beneath
  await app.run("layer-new");
  await app.setForeground("#d02020");
  await select(app, { x: 0, y: 0, w: 1920, h: 1080 });
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.run("mask-add");
  await app.brush(120, 100);
  await app.setForeground("#000000");
  await held(app, 0.5, async () => {
    const mid = await viewMiddle(app);
    expect(mid.slice(0, 3), "the white beneath shows through, not black paint").toEqual([255, 255, 255]);
  });
  expect(await rgba(app, 960, 540), "hidden").toEqual([255, 255, 255, 255]);
  await app.run("mask-delete");
  expect(await rgba(app, 960, 540), "the layer's own pixels untouched").toEqual([208, 32, 32, 255]);
});

test.describe("the clone stamp sampling every layer", () => {
  test.use({
    storage: {
      "graphiq:tool-settings": JSON.stringify({
        clone: {
          ...{ size: 60, hardness: 100, opacity: 100, flow: 100, spacing: 10, smoothing: 0 },
          ...{ aligned: true, sampleAll: true },
        },
      }),
    },
  });

  test("copies what every layer shows, onto an empty layer", async ({ app }) => {
    const { page } = app;
    await app.run("layer-new");
    await app.brush(120, 100);
    await app.setForeground("#2040d0");
    await app.drag(0.3, 0.2, 0.3); // a blue blob on the lower layer
    await app.run("layer-new"); // an empty layer on top, to clone onto
    await app.key("s");
    const b = await app.canvasBox();
    const src = { x: b.x + b.width * 0.25, y: b.y + b.height * 0.3 };
    await page.keyboard.down("Alt");
    await page.mouse.click(src.x, src.y);
    await page.keyboard.up("Alt");
    await app.drag(0.7, 0.75, 0.8);
    expect(await rgba(app, 1488, 756), "cloned from the layer beneath").toEqual([32, 64, 208, 255]);
  });
});

test("the clone stamp sampling its own layer copies only that layer", async ({ app }) => {
  const { page } = app;
  await app.run("layer-new");
  await app.brush(120, 100);
  await app.setForeground("#2040d0");
  await app.drag(0.3, 0.2, 0.3);
  await app.run("layer-new");
  await app.key("s");
  await app.setRange("Hardness", 100);
  const b = await app.canvasBox();
  const src = { x: b.x + b.width * 0.25, y: b.y + b.height * 0.3 };
  await page.keyboard.down("Alt");
  await page.mouse.click(src.x, src.y);
  await page.keyboard.up("Alt");
  await app.drag(0.7, 0.75, 0.8);
  expect((await rgba(app, 1488, 756))[3], "its own layer is empty there").toBe(0);
});
