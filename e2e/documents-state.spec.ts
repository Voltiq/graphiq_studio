/**
 * The open documents (TODO 1.5, app/state/documents.ts): the tabs, which is
 * active, the pixels queued for a document just opened, and the history the
 * engine reports for the active one.
 */
import { test, expect, type App } from "./fixtures";

test.use({ filePickers: false });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const docs = (app: App) => app.page.evaluate(() => window.graphiq!.docs());
/** A block of colour on a new layer of the active document (or on the active layer). */
const block = async (app: App, hex: string, r: { x: number; y: number; w: number; h: number }, onNew = true) => {
  if (onNew) await app.run("layer-new");
  await app.setForeground(hex);
  await app.page.evaluate((r) => window.graphiq!.select([r]), r);
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.settle(300);
};
const pixel = (app: App, x: number, y: number) =>
  app.page.evaluate(
    async ([x, y]) => {
      const blob = await window.graphiq!.exportPNG(1);
      const bmp = await createImageBitmap(blob!);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data];
    },
    [x, y],
  );

test("a project opened from a file keeps what is done to it after — through a tab switch", async ({ app }, info) => {
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  await block(app, "#d02060ff", { x: 10, y: 10, w: 50, h: 50 });
  const saved = app.page.waitForEvent("download", { timeout: 20_000 });
  await app.menu("File", "Save as…");
  const sa = app.page.locator('div[role="dialog"][aria-label="Save project as"]');
  await sa.locator('input[aria-label="File name"]').fill("kept");
  await sa.getByText("Save", { exact: true }).click();
  const path = info.outputPath("kept.gproj");
  await (await saved).saveAs(path);
  await app.page.locator('input[type="file"][accept*="gproj"]').setInputFiles(path);
  await expect.poll(async () => (await docs(app)).length, { message: "it opens as a tab of its own" }).toBe(3);
  await app.settle(1_500);
  expect(await pixel(app, 30, 30), "its pixels arrived").toEqual([208, 32, 96, 255]);
  // Worked on after it opened — on the very layer the file brought...
  await block(app, "#20a0d0ff", { x: 100, y: 60, w: 50, h: 50 }, false);
  expect(await pixel(app, 120, 80)).toEqual([32, 160, 208, 255]);
  // ...it keeps that work when the tab is left and come back to: the file's
  // pixels were applied once, not again.
  const opened = (await docs(app)).find((d) => d.active)!.id;
  const other = (await docs(app)).find((d) => !d.active)!.id;
  await app.page.evaluate((id) => window.graphiq!.activate(id), other);
  await app.settle(800);
  await app.page.evaluate((id) => window.graphiq!.activate(id), opened);
  await app.settle(1_200);
  expect(await pixel(app, 120, 80), "the later block is still there").toEqual([32, 160, 208, 255]);
  expect(await pixel(app, 30, 30)).toEqual([208, 32, 96, 255]);
});

test("the History panel shows the active document's history, and changes with the tab", async ({ app }) => {
  await app.openPanelById("history");
  await block(app, "#d02060ff", { x: 10, y: 10, w: 50, h: 50 });
  const first = await app.historyRows();
  expect(first.length, "steps of its own").toBeGreaterThan(1);
  await app.menu("File", "New…");
  await app.page.locator('div[role="dialog"][aria-label="New document"]').getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  expect(await app.historyRows(), "a new document: nothing done yet").toEqual(["New1"]);
  const firstId = (await docs(app))[0].id;
  await app.page.evaluate((id) => window.graphiq!.activate(id), firstId);
  await expect.poll(() => app.historyRows(), { message: "back to the first: its history" }).toEqual(first);
});
