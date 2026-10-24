/**
 * The Select menu (TODO 1.10, app/commands/selection.ts): it works on the
 * document in front, and a floating paste is put down before the selection
 * changes under it.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The selection's box, as the marquee's options show it. */
const selBox = (app: App) =>
  app.page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-tour="options"] input[data-numeric]')]
        .filter((i) => (i as HTMLElement).offsetParent)
        .map((i) => [
          i.closest("label")?.querySelector("span")?.textContent?.trim(),
          Number((i as HTMLInputElement).value),
        ]),
    ),
  );
const alpha = (app: App, x: number, y: number) =>
  app.page.evaluate(
    async ([x, y]) => {
      const bmp = await createImageBitmap((await window.graphiq!.exportPNG(1))!);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(x, y, 1, 1).data[3];
    },
    [x, y],
  );

test("the Select menu works on the document in front", async ({ app }) => {
  await app.page.evaluate(() => window.graphiq!.select([{ x: 0, y: 0, w: 300, h: 300 }]));
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  await app.pickTool("Rectangular marquee");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 20, y: 20, w: 50, h: 50 }]));
  await app.settle(300);
  expect(await selBox(app)).toMatchObject({ X: 20, Y: 20, W: 50, H: 50 });
  await app.run("select-inverse");
  await app.settle(300);
  expect(await selBox(app), "everything but the box, in this document").toMatchObject({ X: 0, Y: 0, W: 200, H: 150 });
  await app.run("select-inverse");
  await app.run("select-all");
  await app.settle(300);
  expect(await selBox(app)).toMatchObject({ X: 0, Y: 0, W: 200, H: 150 });
  await app.run("select-deselect");
  await app.run("select-reselect");
  await app.settle(300);
  expect(await selBox(app), "the last selection back").toMatchObject({ X: 0, Y: 0, W: 200, H: 150 });
});

test("a floating paste is put down before the selection changes", async ({ app }) => {
  await app.openPanelById("history");
  await app.run("layer-new");
  await app.setForeground("#d02060");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 100, y: 100, w: 100, h: 100 }]));
  await app.key("Backspace");
  await app.run("edit-copy");
  await app.run("edit-paste"); // an in-app copy floats in place, not yet a step
  await app.settle(300);
  expect((await app.historyRows()).some((r) => r.startsWith("Paste")), "floating, it is no step yet").toBe(false);
  await app.run("select-all");
  await app.settle(500);
  const rows = await app.historyRows();
  const paste = rows.findIndex((r) => r.startsWith("Paste"));
  expect(paste, "Select All put it down: the paste is a step").toBeGreaterThan(-1);
  expect(rows.findIndex((r) => r.startsWith("Select All")), "before the selection's").toBeGreaterThan(paste);
  expect(await alpha(app, 150, 150), "and in the picture").toBe(255);
});
