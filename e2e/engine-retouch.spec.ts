/**
 * The engine's retouch brushes (TODO 1.6, app/lib/engine/retouch.ts), as the
 * engine wires them: each brush changes the picture where it passes and lands
 * as one step named for it; on a mask it works the mask; in a selection it keeps
 * inside it; blur can sample every layer; the History brush paints back from a
 * step or a snapshot; the magic wand's live re-run reads what a brush changed;
 * blur and dodge show as they are drawn, inside a group too.
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
const composite = (app: App) =>
  app.page.evaluate(async () => {
    const buf = await crypto.subtle.digest("SHA-256", await (await window.graphiq!.exportPNG(1))!.arrayBuffer());
    return [...new Uint8Array(buf)].slice(0, 8).join(",");
  });
const lastStep = async (app: App) => (await app.historyRows()).at(-1)?.replace(/\d+$/, "");
const select = (app: App, r: { x: number; y: number; w: number; h: number }) =>
  app.page.evaluate((r) => window.graphiq!.select([r]), r);
/** Bands of red, green and blue across the canvas on a layer of their own. */
async function bands(app: App) {
  await app.run("layer-new");
  await app.brush(160, 100);
  for (const [hex, fy] of [
    ["#d02020", 0.2],
    ["#20a040", 0.35],
    ["#2040d0", 0.5],
  ] as const) {
    await app.setForeground(hex);
    await app.drag(fy, 0.05, 0.95);
  }
}

test("each brush changes the picture where it passes, and lands as one step named for it", async ({ app }) => {
  await app.openPanelById("history");
  await bands(app);
  for (const [tool, fy, step] of [
    ["Blur", 0.28, "Blur"],
    ["Dodge", 0.35, "Dodge"],
    ["Sponge", 0.43, "Sponge"],
  ] as const) {
    const y = Math.round(fy * 1080);
    const before = await rgba(app, 960, y);
    await app.pickTool(tool);
    await app.drag(fy, 0.2, 0.8);
    // Halfway along: the stroke's moves reached it, not just its first dab.
    expect(await rgba(app, 960, y), `${tool} changed the picture along its path`).not.toEqual(before);
    expect(await lastStep(app)).toBe(step);
  }
  // The mixer lays down yellow into the blue.
  const blue = await composite(app);
  await app.setForeground("#f0c000");
  await app.pickTool("Mixer brush");
  await app.drag(0.5, 0.2, 0.8);
  expect([await composite(app) !== blue, await lastStep(app)], "the mixer changed the picture").toEqual([
    true,
    "Mixer Brush",
  ]);
  // Smudge drags one band into the next: a stroke across them.
  const before = await composite(app);
  await app.pickTool("Smudge");
  const b = await app.canvasBox();
  await app.page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.15);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.45, { steps: 25 });
  await app.page.mouse.up();
  await app.settle(600);
  expect([await composite(app) !== before, await lastStep(app)], "Smudge changed the picture").toEqual([
    true,
    "Smudge",
  ]);
  // The History brush, back to before the bands: the layer as it was then.
  await app.page
    .locator('[data-panel-id="history"]')
    .getByRole("button", { name: "Set as History-brush source", exact: true })
    .nth(1)
    .click();
  await app.pickTool("History brush");
  await app.drag(0.35, 0.3, 0.7);
  const back = (await rgba(app, 960, 378))[3];
  expect([back, await lastStep(app)], "painted back to nothing").toEqual([0, "History Brush"]);
});

test("on a mask a brush works the mask; in a selection it keeps inside", async ({ app }) => {
  await bands(app);
  await app.run("mask-add");
  await app.brush(100, 100);
  await app.setForeground("#000000");
  await app.drag(0.35, 0.3, 0.7); // a hard edge in the mask, across the green
  const sharp = await rgba(app, 960, 378 - 50);
  await app.pickTool("Blur");
  await app.drag(0.35 - 50 / 1080, 0.3, 0.7); // along the mask's edge
  const blurred = await rgba(app, 960, 378 - 50);
  expect(blurred[3], "the mask's edge softened").not.toBe(sharp[3]);
  await app.run("mask-delete");
  expect(await rgba(app, 960, 378), "the layer's own pixels untouched").toEqual([32, 160, 64, 255]);
  await select(app, { x: 900, y: 200, w: 120, h: 400 });
  await app.pickTool("Dodge");
  await app.drag(0.35, 0.3, 0.7);
  expect(await rgba(app, 800, 378), "outside the selection: as it was").toEqual([32, 160, 64, 255]);
  expect((await rgba(app, 960, 378))[1], "inside: lighter").toBeGreaterThan(160);
});

test.describe("blur sampling every layer", () => {
  test.use({
    storage: {
      "graphiq:tool-settings": JSON.stringify({
        blur: { size: 60, hardness: 100, strength: 100, radius: 16, smoothing: 0, spacing: 15, sampleAll: true },
      }),
    },
  });

  test("blurs what every layer shows onto the layer it paints", async ({ app }) => {
    await bands(app);
    await app.run("layer-new"); // empty, on top
    const before = await rgba(app, 960, 302);
    await app.pickTool("Blur");
    await app.drag(0.28, 0.3, 0.7);
    // Blurring the empty layer by itself would change nothing.
    expect(await rgba(app, 960, 302), "the empty layer now holds the blurred bands").not.toEqual(before);
  });
});

test("the History brush paints back from a snapshot", async ({ app }) => {
  const history = app.page.locator('[data-panel-id="history"]');
  await app.openPanelById("history");
  await bands(app);
  await history.getByRole("button", { name: "Take snapshot" }).click();
  await app.setForeground("#ffffff");
  await app.drag(0.35, 0.05, 0.95); // white over the green
  await history.getByRole("button", { name: "Set Snapshot 1 as History-brush source" }).click();
  await app.pickTool("History brush");
  await app.drag(0.35, 0.4, 0.6);
  expect(await rgba(app, 960, 378), "green again, from the snapshot").toEqual([32, 160, 64, 255]);
  expect(await rgba(app, 1500, 378), "white where it did not paint").toEqual([255, 255, 255, 255]);
});

test.describe("the magic wand after a brush", () => {
  test.use({
    storage: {
      "graphiq:tool-settings": JSON.stringify({
        dodge: { size: 300, hardness: 100, exposure: 100, mode: "dodge", range: "midtones", protect: true },
      }),
    },
  });

  test("its live re-run reads what the brush changed", async ({ app }) => {
    await bands(app);
    await app.pickTool("Magic wand");
    const b = await app.canvasBox();
    await app.page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.35); // the green band
    await app.settle(400);
    // Lighten the band's whole height over its left third, well short of where the wand was clicked.
    await app.pickTool("Dodge");
    await app.drag(0.35, 0.02, 0.3);
    await app.pickTool("Magic wand");
    expect(await app.setRange("Tolerance", 10), "a Tolerance").toBe(true);
    await app.settle(600);
    const status = await app.page.locator('footer[data-tour="status"]').innerText();
    const x = +(status.match(/\d+ × \d+\s*\((\d+), \d+\)/)?.[1] ?? 0);
    expect(x, "only the green the dodge did not reach").toBeGreaterThan(550);
  });
});

/** The on-screen view at (fx, fy) of its size: what the user sees, mid-stroke too. */
const onScreen = (app: App, fx: number, fy: number) =>
  app.page.evaluate(
    ([fx, fy]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
      return [...c.getContext("2d")!.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data];
    },
    [fx, fy] as const,
  );

test("blur and dodge show as they are drawn, in a group too", async ({ app }) => {
  await bands(app);
  const id = await app.page.evaluate(() => window.graphiq!.layers()[0].id);
  await app.run("layer-group"); // a group's merge is cached: a live layer has to bypass it
  await app.page.evaluate((id) => window.graphiq!.selectLayer(id), id); // the bands again, not the group
  await app.settle(300);
  const b = await app.canvasBox();
  for (const [tool, fy] of [
    ["Blur", 0.28],
    ["Dodge", 0.35],
  ] as const) {
    await app.pickTool(tool);
    const before = await onScreen(app, 0.3, fy);
    await app.page.mouse.move(b.x + b.width * 0.2, b.y + b.height * fy);
    await app.page.mouse.down();
    await app.page.mouse.move(b.x + b.width * 0.6, b.y + b.height * fy, { steps: 20 });
    await app.settle(300);
    const live = await onScreen(app, 0.3, fy); // the pointer is still down, well past it
    await app.page.mouse.up();
    await app.settle();
    expect(live, `${tool}, before the stroke ends`).not.toEqual(before);
  }
});
