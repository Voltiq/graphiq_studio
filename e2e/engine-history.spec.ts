/**
 * The engine's history (TODO 1.6, app/lib/engine/history.ts), as the engine
 * wires it: a brush step's pixels go back and come back, on the view too, and
 * the History panel follows; with non-linear history a branch stays; an open
 * pen path or bucket fill is something to undo on a document with no steps,
 * and is ended before Undo, which takes it alone; the magic wand's live re-run
 * reads what a step since put on its layer; a snapshot restores what it took,
 * and the History brush paints from it or from a step; the step cap holds for
 * pixel steps; a cancelled destructive Levels leaves no step; a document's
 * file carries its history.
 */
import { readFileSync } from "node:fs";
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The composite's pixel at document `x, y`. */
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
const smallDoc = async (app: App) => {
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("400");
  await nd.locator('input[type="number"]').nth(1).fill("300");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
};
const steps = async (app: App) => (await app.historyRows()).map((r) => r.replace(/\d+$/, ""));
const current = (app: App) =>
  app.page
    .locator('[data-panel-id="history"] button[data-active="true"]')
    .textContent()
    .then((t) => t?.trim().replace(/\d+$/, ""));
const status = (app: App) => app.page.locator('footer[data-tour="status"]');
const stroke = async (app: App, hex: string, fy: number) => {
  await app.setForeground(hex);
  await app.drag(fy, 0.2, 0.8);
};

test("a brush step's pixels go back on undo and come back on redo; the History panel follows", async ({ app }) => {
  await app.openPanelById("history");
  await smallDoc(app);
  await app.run("layer-new");
  await app.brush(30, 100);
  await app.parkMouse();
  const blank = (await app.stableViewShot()).hash;
  await stroke(app, "#d02020", 0.5);
  const painted = (await app.stableViewShot()).hash;
  expect(painted).not.toBe(blank);
  expect(await rgba(app, 200, 150)).toEqual([208, 32, 32, 255]);
  expect(await steps(app)).toEqual(["New", "New Layer", "Brush"]);
  await app.key("Control+z");
  expect((await rgba(app, 200, 150))[3], "undone").toBe(0);
  expect((await app.stableViewShot()).hash, "and the view shows it").toBe(blank);
  expect(await current(app)).toBe("New Layer");
  await app.key("Control+Shift+z");
  expect(await rgba(app, 200, 150)).toEqual([208, 32, 32, 255]);
  expect((await app.stableViewShot()).hash).toBe(painted);
  await app.page.locator('[data-panel-id="history"] button[data-active]').nth(1).click();
  await app.settle(400);
  expect([(await rgba(app, 200, 150))[3], await current(app)], "a jump from the panel").toEqual([0, "New Layer"]);
  // Non-linear: a new stroke from here keeps the old one, on a branch.
  await app.page.getByRole("button", { name: "Non-linear history" }).click();
  await stroke(app, "#2040d0", 0.5);
  expect(await steps(app)).toEqual(["New", "New Layer", "Brush", "Brush"]);
  await expect(app.page.locator('[data-panel-id="history"] button[data-offpath]')).toHaveCount(1);
});

test("an open pen path is something to undo on a document with no steps; Undo makes it one and takes it", async ({
  app,
}) => {
  const undo = () => app.page.evaluate(() => window.graphiq!.run("undo"));
  expect(await undo(), "a new document: nothing to undo").toBe(false);
  await app.pickTool("Pen");
  const b = await app.canvasBox();
  for (const fx of [0.3, 0.6]) {
    await app.page.mouse.click(b.x + b.width * fx, b.y + b.height * 0.4);
    await app.settle(200);
  }
  await app.settle(300);
  expect(await undo(), "the open path").toBe(true);
  await app.settle(400);
  expect(await undo(), "it was the only step: nothing left").toBe(false);
});

test("an open bucket fill ends before Undo, which takes it alone; on a document with no steps, Undo takes it", async ({
  app,
}) => {
  await app.openPanelById("history");
  await smallDoc(app);
  await app.run("layer-new");
  await app.brush(30, 100);
  await stroke(app, "#d02020", 0.3);
  await app.setForeground("#2040d0");
  await app.pickTool("Paint bucket");
  const b = await app.canvasBox();
  await app.page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.8);
  await app.settle(600);
  expect(await rgba(app, 200, 240), "the fill, still open").toEqual([32, 64, 208, 255]);
  await app.run("undo");
  expect((await rgba(app, 200, 240))[3], "Undo took the fill").toBe(0);
  expect(await rgba(app, 200, 90), "and only the fill").toEqual([208, 32, 32, 255]);
  // The document the app opened with has no layer and no step: the bucket makes
  // its layer quietly, and its open fill is all there is to undo.
  await app.activate((await app.docs())[0].id);
  expect(await app.page.evaluate(() => window.graphiq!.layers().length), "no layer yet").toBe(0);
  const box = await app.canvasBox();
  await app.page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await app.settle(600);
  expect(await app.page.evaluate(() => window.graphiq!.layers().length), "a layer to fill").toBe(1);
  const [w, h] = await app.page.evaluate(() => {
    const d = window.graphiq!.docs().find((x) => x.active)!;
    return [d.width, d.height];
  });
  expect((await rgba(app, w >> 1, h >> 1))[3], "filled").toBe(255);
  await app.run("undo");
  expect((await rgba(app, w >> 1, h >> 1))[3], "Undo had the open fill to take").toBe(0);
});

test("the magic wand's live re-run reads what a step since put on its layer", async ({ app }) => {
  await app.openPanelById("history");
  await smallDoc(app);
  await app.run("layer-new");
  await app.brush(30, 100);
  await app.setForeground("#d02020");
  await app.drag(0.5, 0, 1); // right across
  await app.pickTool("Magic wand");
  const b = await app.canvasBox();
  await app.page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.15); // above the stroke
  await app.settle(500);
  await expect(status(app), "the empty band above the stroke").toContainText("400 × 135(0, 0)");
  await app.key("Backspace"); // filled red, down to the red stroke: one region now
  await app.settle(400);
  // Tolerance re-runs the click on the source it cached — which the fill, a
  // step, must have let go of.
  expect(await app.setRange("Tolerance", 40), "a Tolerance to drag").toBe(true);
  await app.settle(600);
  await expect(status(app), "the fill and the stroke, one red").toContainText("400 × 165(0, 0)");
});

test("a snapshot restores what it took; the History brush paints from it, or from a step", async ({ app }) => {
  const { page } = app;
  const history = page.locator('[data-panel-id="history"]');
  await app.openPanelById("history");
  await smallDoc(app);
  await app.run("layer-new");
  await app.brush(40, 100);
  await stroke(app, "#20a040", 0.7);
  await stroke(app, "#d02020", 0.3);
  await history.getByRole("button", { name: "Take snapshot" }).click();
  await stroke(app, "#101010", 0.3);
  expect(await rgba(app, 200, 90)).toEqual([16, 16, 16, 255]);
  await history.locator('li:has([aria-label^="Delete "])').first().locator("button").nth(1).click(); // Restore
  await app.settle(500);
  expect(await rgba(app, 200, 90), "the snapshot's pixels").toEqual([208, 32, 32, 255]);
  await app.key("Control+z");
  expect(await rgba(app, 200, 90)).toEqual([16, 16, 16, 255]);
  await history.getByRole("button", { name: "Set Snapshot 1 as History-brush source" }).click();
  await app.pickTool("History brush");
  await app.setRange("Size", 40);
  await app.drag(0.3, 0.4, 0.6);
  expect(await rgba(app, 200, 90), "painted back from the snapshot").toEqual([208, 32, 32, 255]);
  expect(await rgba(app, 320, 90), "where it did not paint").toEqual([16, 16, 16, 255]);
  // From a step: the state with only the green stroke (the original, the layer,
  // then it) — no red, no black there; the green, untouched since, stays.
  await history.getByRole("button", { name: "Set as History-brush source", exact: true }).nth(2).click();
  await app.drag(0.3, 0.7, 0.85);
  expect((await rgba(app, 320, 90))[3], "painted back from the step: nothing there then").toBe(0);
  await app.drag(0.7, 0.4, 0.6);
  expect(await rgba(app, 200, 210), "the green, as it was then and is now").toEqual([32, 160, 64, 255]);
});

test.describe("with the steps capped at 10", () => {
  test.use({ storage: { "graphiq:preferences": JSON.stringify({ historyLimit: 10 }) } });

  test("pixel steps beyond the cap drop the oldest", async ({ app }) => {
    await app.openPanelById("history");
    await smallDoc(app);
    await app.run("layer-new");
    await app.brush(10, 100);
    for (let i = 0; i < 12; i++) await stroke(app, i % 2 ? "#d02020" : "#2040d0", 0.1 + i * 0.07);
    const rows = await steps(app);
    expect(rows, "the original and ten steps").toHaveLength(11);
    expect(rows.slice(1).every((r) => r === "Brush"), "the layer's step went first").toBe(true);
  });
});

test("a destructive Levels, previewed and cancelled, leaves no step", async ({ app }) => {
  const { page } = app;
  await app.openPanelById("history");
  await smallDoc(app);
  await app.run("layer-new");
  await app.brush(40, 100);
  await stroke(app, "#806040", 0.5);
  const before = await steps(app);
  await page.evaluate(() => window.graphiq!.run("tone-dest-levels"));
  const dialog = page.getByRole("dialog", { name: "Levels" });
  await dialog.waitFor();
  await dialog.locator("label", { hasText: "Gamma" }).locator("input").fill("1.8");
  await app.settle(800);
  expect(await rgba(app, 200, 150), "previewed on the layer").not.toEqual([128, 96, 64, 255]);
  expect((await steps(app)).length, "the preview stands as a step").toBe(before.length + 1);
  await page.keyboard.press("Escape");
  await app.settle(600);
  expect(await steps(app)).toEqual(before);
  expect(await rgba(app, 200, 150), "the pixels as they were").toEqual([128, 96, 64, 255]);
});

test.describe("saving to a file", () => {
  test.use({ filePickers: false });

  test("a document's file carries its history: the steps and where it stood", async ({ app }, info) => {
    await smallDoc(app);
    await app.run("layer-new");
    await app.brush(20, 100);
    await stroke(app, "#d02020", 0.5);
    await stroke(app, "#2040d0", 0.6);
    await app.key("Control+z");
    const dl = app.page.waitForEvent("download", { timeout: 20_000 });
    await app.run("save");
    const path = info.outputPath("history.gproj");
    await (await dl).saveAs(path);
    const file = JSON.parse(readFileSync(path, "utf8")) as { history: { labels: string[]; index: number } };
    expect(file.history).toEqual({ labels: ["New Layer", "Brush", "Brush"], index: 2 });
  });
});
