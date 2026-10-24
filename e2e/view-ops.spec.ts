/**
 * The view and text families (TODO 1.10, app/commands/view.ts and text.ts):
 * Quick Mask goes in and out of the document in front as steps, Isolate solos
 * the chosen layer and says when there is nothing to hide, each guide edit is
 * a step, and text goes on the Work Path as one — refusing what it cannot set.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const status = (app: App) => app.page.locator('footer[data-tour="status"]');
const toast = (app: App) => app.page.locator('[role="status"]');
const pill = (app: App) => app.page.locator('[data-tour="options"]').getByText("Quick Mask", { exact: true });
const lastStep = async (app: App) => (await app.historyRows()).at(-1)?.replace(/\d+$/, "");
/** How much the overlay draws: guides and ants, never the document's pixels. */
const overlayInk = (app: App) =>
  app.page.evaluate(() => {
    let n = 0;
    for (const c of [...document.querySelectorAll("canvas")].filter((x) => /overlay/i.test(x.className))) {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    }
    return n;
  });
const smallDoc = async (app: App) => {
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
};

test("Quick Mask goes in and out of the document in front as steps, its coverage back as the selection", async ({
  app,
}) => {
  await app.openPanelById("history");
  const first = (await app.docs()).find((d) => d.active)!.id;
  await smallDoc(app);
  const second = (await app.docs()).find((d) => d.active)!.id;
  await app.page.evaluate(() => window.graphiq!.select([{ x: 20, y: 20, w: 50, h: 50 }]));
  await app.settle(300);
  await expect(status(app)).toContainText("50 × 50");
  await app.run("select-quickmask");
  await expect(pill(app)).toBeVisible();
  await expect(status(app), "the selection is the mask now").not.toContainText("50 × 50");
  expect(await lastStep(app)).toBe("Quick Mask");
  await app.activate(first);
  await expect(pill(app), "only that document is in Quick Mask").toHaveCount(0);
  await app.activate(second);
  await expect(pill(app)).toBeVisible();
  await app.run("select-quickmask");
  await expect(pill(app)).toHaveCount(0);
  await expect(status(app), "its coverage is the selection again").toContainText("50 × 50");
  expect(await lastStep(app)).toBe("Exit Quick Mask");
  await app.key("Control+z");
  await expect(pill(app), "undo goes back into it").toBeVisible();
  await app.key("Control+Shift+z");
  await expect(pill(app)).toHaveCount(0);
  await expect(status(app)).toContainText("50 × 50");
});

test("Isolate solos the chosen layer in front, and says when there is nothing to hide", async ({ app }) => {
  const chip = status(app).getByText("Isolated", { exact: true });
  await app.run("layer-isolate");
  await expect(toast(app)).toContainText("Select a layer to isolate.");
  await app.run("layer-new");
  await app.run("layer-isolate");
  await expect(toast(app)).toContainText("Nothing else is visible to hide.");
  await expect(chip).toHaveCount(0);
  await smallDoc(app);
  await app.run("layer-new");
  await app.run("layer-new");
  await app.run("layer-isolate");
  await expect(chip).toBeVisible();
  await app.run("layer-isolate");
  await expect(chip, "a second time turns it off").toHaveCount(0);
});

test("each guide edit is a step: added, cleared, and back with an undo", async ({ app }) => {
  const guide = async (axis: "Vertical" | "Horizontal", pos: number) => {
    await app.page.evaluate(() => window.graphiq!.run("view-new-guide")); // app.run would close the dialog
    const d = app.page.getByRole("dialog", { name: "New guide" });
    await d.waitFor();
    await d.getByText(axis, { exact: true }).first().click();
    await d.locator("input").first().fill(String(pos));
    await d.locator("footer button").last().click();
    await app.settle(500);
  };
  await app.openPanelById("history");
  await smallDoc(app);
  expect(await overlayInk(app)).toBe(0);
  await guide("Vertical", 100);
  expect(await lastStep(app)).toBe("New Guide");
  expect(await overlayInk(app), "a guide on screen").toBeGreaterThan(0);
  await guide("Horizontal", 60);
  await app.run("view-clear-guides");
  expect(await lastStep(app)).toBe("Clear Guides");
  expect(await overlayInk(app)).toBe(0);
  await app.key("Control+z");
  await app.settle(300);
  expect(await overlayInk(app), "undo brings them back").toBeGreaterThan(0);
});

test("text goes on the Work Path as a step, refusing what is not text and a document with no path", async ({
  app,
}) => {
  const { page } = app;
  await app.openPanelById("history");
  await smallDoc(app); // the second document: the one in front is the one worked on
  await app.run("layer-new");
  await app.run("text-on-path");
  await expect(toast(app)).toContainText("Select a text layer first.");
  await app.key("t");
  const b = await app.canvasBox();
  await page.mouse.click(b.x + b.width * 0.3, b.y + b.height * 0.4);
  await app.settle(900);
  await page.keyboard.type("On a curve");
  await page.keyboard.press("Control+Enter");
  await app.settle(1_500);
  const textId = await page.evaluate(() => window.graphiq!.layers().find((l) => l.name === "On a curve")?.id);
  expect(textId, "a text layer").toBeTruthy();
  await app.run("text-on-path");
  await expect(toast(app)).toContainText("Draw a path with the Pen tool first (at least 3 points).");
  await app.run("text-off-path");
  await expect(toast(app)).toContainText("This text is not on a path.");
  await app.pickTool("Pen");
  for (const [fx, fy] of [
    [0.2, 0.6],
    [0.5, 0.4],
    [0.8, 0.6],
  ]) {
    await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
    await app.settle(120);
  }
  await app.key("Enter");
  await page.evaluate((id) => window.graphiq!.selectLayer(id!), textId);
  await app.settle(500);
  await app.run("text-on-path");
  expect(await lastStep(app)).toBe("Text on Path");
  await app.run("text-off-path");
  expect(await lastStep(app)).toBe("Text off Path");
});
