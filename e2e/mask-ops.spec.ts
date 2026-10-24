/**
 * The mask commands (TODO 1.10, app/commands/masks.ts): a layer mask hides
 * and shows what it should, turned off and on from its chip, applied into the
 * pixels; a vector mask from the Pen's path; all on the document in front,
 * with the Layers panel showing the mask as what the brush paints.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The composite's alpha at a document point. */
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
const activeRow = (app: App) =>
  app.page.locator('[data-panel-id="layers"] [data-layer-id][data-active="true"]').first();

test("a layer mask hides, shows, turns off and on, and applies — on the document in front", async ({ app }) => {
  await app.run("layer-new"); // the first document has a layer of its own
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  await app.openPanelById("layers");
  await app.openPanelById("history");
  await app.run("layer-new");
  await app.setForeground("#d02060");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 20, y: 20, w: 100, h: 100 }]));
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.settle(300);
  expect(await alpha(app, 50, 50)).toBe(255);

  await app.run("mask-add-hide");
  await app.settle(400);
  expect(await alpha(app, 50, 50), "a hiding mask hides it").toBe(0);
  const chip = activeRow(app).locator('[class*="maskThumb"]');
  await expect(chip, "and is what the brush paints now").toHaveAttribute("data-active", "true");
  await chip.click({ modifiers: ["Shift"] });
  await app.settle(400);
  expect(await alpha(app, 50, 50), "turned off, it shows again").toBe(255);
  await chip.click({ modifiers: ["Shift"] });
  await app.settle(400);
  expect(await alpha(app, 50, 50), "and on, hides").toBe(0);
  await app.run("mask-delete");
  await app.settle(400);
  expect(await alpha(app, 50, 50), "deleted, the layer is whole").toBe(255);

  await app.page.evaluate(() => window.graphiq!.select([{ x: 20, y: 20, w: 50, h: 100 }]));
  await app.run("mask-from-sel");
  await app.run("select-deselect");
  await app.settle(400);
  expect([await alpha(app, 40, 50), await alpha(app, 100, 50)], "a mask from the selection").toEqual([255, 0]);
  await app.run("mask-apply");
  await app.settle(400);
  await expect(activeRow(app).locator('[class*="maskThumb"]'), "applied, the mask is gone").toHaveCount(0);
  expect([await alpha(app, 40, 50), await alpha(app, 100, 50)], "into the pixels").toEqual([255, 0]);
  await app.key("Control+z");
  await app.settle(400);
  await expect(activeRow(app).locator('[class*="maskThumb"]'), "undone, it is back").toHaveCount(1);
  const rows = await app.historyRows();
  const labels = ["Add Layer Mask", "Disable Layer Mask", "Enable Layer Mask", "Delete Layer Mask", "Apply Layer Mask"];
  for (const label of labels) {
    expect(rows.some((r) => r.startsWith(label)), `"${label}" is a step`).toBe(true);
  }
});

test("a vector mask from the Pen's path, inverted and deleted", async ({ app }) => {
  await app.run("layer-new");
  await app.setForeground("#20a0d0");
  const doc = await app.page.evaluate(() => window.graphiq!.docs().find((d) => d.active)!);
  await app.page.evaluate(([w, h]) => window.graphiq!.select([{ x: 0, y: 0, w, h }]), [doc.width, doc.height]);
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.pickTool("Pen");
  const b = await app.canvasBox();
  // A triangle in the left half of the view.
  for (const [fx, fy] of [[0.1, 0.2], [0.4, 0.2], [0.25, 0.8], [0.1, 0.2]]) {
    await app.page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
    await app.settle(120);
  }
  await app.key("Enter");
  await app.settle(300);
  const s = doc.width / b.width;
  const inside = [Math.round(b.width * 0.25 * s), Math.round(b.height * 0.4 * s)] as const;
  const outside = [Math.round(b.width * 0.8 * s), Math.round(b.height * 0.5 * s)] as const;
  await app.run("vmask-add");
  await app.settle(500);
  expect([await alpha(app, ...inside), await alpha(app, ...outside)], "shown inside the path only").toEqual([255, 0]);
  await app.run("vmask-invert");
  await app.settle(500);
  expect([await alpha(app, ...inside), await alpha(app, ...outside)], "inverted").toEqual([0, 255]);
  await app.run("vmask-delete");
  await app.settle(500);
  expect([await alpha(app, ...inside), await alpha(app, ...outside)], "deleted").toEqual([255, 255]);
});
