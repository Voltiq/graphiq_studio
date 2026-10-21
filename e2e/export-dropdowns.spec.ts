/**
 * The Export dialog's dropdowns — preset, format, and each batch target's
 * format — are the app's own dropdown (Select), not the browser's: the native
 * list ignored the theme and, on a phone, opened the OS picker over the sheet.
 *
 * What a native select gave for free is checked here because the custom one has
 * to earn it: the keyboard (arrows, Enter, Escape), and that those keys stay in
 * the list — Escape used to close the whole dialog, and Enter, the natural way
 * to open a list, would have started an export.
 */
import { test, expect, PHONE, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const DIALOG = 'div[role="dialog"][aria-label="Export image"]';

async function openExport(app: App) {
  await app.page.evaluate(() => window.graphiq!.run("export-as"));
  await app.page.locator(DIALOG).waitFor();
  await app.settle(300);
}
const trigger = (app: App, name: string) =>
  app.page.locator(DIALOG).getByRole("button", { name: new RegExp(`^${name}: `) });
const list = (app: App) => app.page.getByRole("listbox");
const said = async (app: App, name: string) =>
  ((await trigger(app, name).getAttribute("aria-label")) ?? "").slice(name.length + 2);

test("no native selects: preset, format and batch targets are the app's dropdown", async ({ app }) => {
  await openExport(app);
  const dialog = app.page.locator(DIALOG);
  await expect(dialog.locator("select")).toHaveCount(0);
  await expect(trigger(app, "Apply export preset")).toHaveAttribute("aria-haspopup", "listbox");
  await expect(trigger(app, "Format")).toHaveAttribute("aria-haspopup", "listbox");
  await dialog.getByRole("radio", { name: "Batch" }).or(dialog.getByRole("button", { name: "Batch" })).first().click();
  await expect(dialog.locator("select")).toHaveCount(0);
  await expect(trigger(app, "Target format").first()).toHaveAttribute("aria-haspopup", "listbox");
});

test("choosing a format changes the format, over the dialog", async ({ app }) => {
  await openExport(app);
  await trigger(app, "Format").click();
  await expect(list(app)).toBeVisible();
  const jpeg = list(app).getByRole("option", { name: "JPEG (.jpg)" });
  // The list paints above the dialog: its row is what a click there reaches.
  const hit = await jpeg.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2));
  });
  expect(hit, "the list is on top").toBe(true);
  await jpeg.click();
  await expect(list(app)).toHaveCount(0);
  expect(await said(app, "Format")).toBe("JPEG (.jpg)");
  await expect(app.page.locator(DIALOG).getByText("Quality")).toBeVisible(); // a lossy format's slider
});

test("the preset menu is grouped, applies a preset, and goes back to its prompt", async ({ app }) => {
  await openExport(app);
  expect(await said(app, "Apply export preset")).toBe("Apply a preset…");
  await trigger(app, "Apply export preset").click();
  await expect(list(app).getByText("Built-in", { exact: true })).toBeVisible();
  await list(app).getByRole("option", { name: /^WebP — web/ }).click();
  expect(await said(app, "Format"), "the preset set the format").toBe("WebP (.webp)");
  expect(await said(app, "Apply export preset"), "...and the menu is ready for the next one").toBe("Apply a preset…");
});

test("the keyboard works as on a native select, and its keys stay in the list", async ({ app }) => {
  const { page } = app;
  await openExport(app);
  const fmt = trigger(app, "Format");
  await fmt.focus();
  // Enter opens the list — and does NOT export.
  let downloads = 0;
  page.on("download", () => downloads++);
  await page.keyboard.press("Enter");
  await expect(list(app)).toBeVisible();
  await expect(list(app).getByRole("option", { selected: true })).toBeFocused();
  // Down to the next format, Enter to choose it; focus comes back to the trigger.
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(list(app)).toHaveCount(0);
  await expect(fmt).toBeFocused();
  expect(await said(app, "Format")).toBe("JPEG (.jpg)");
  // Escape closes the list, not the dialog.
  await page.keyboard.press("ArrowDown");
  await expect(list(app)).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(list(app)).toHaveCount(0);
  await expect(page.locator(DIALOG), "the dialog is still open").toBeVisible();
  await expect(fmt).toBeFocused();
  // Tabbing out of an open list closes it.
  await page.keyboard.press("ArrowDown");
  await expect(list(app)).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(list(app)).toHaveCount(0);
  await app.settle(500);
  expect(downloads, "nothing was exported").toBe(0);
});

test.describe("on a phone", () => {
  test.use(PHONE);

  test("the list fits the screen and takes a tap", async ({ app }) => {
    await openExport(app);
    await trigger(app, "Apply export preset").tap();
    await expect(list(app)).toBeVisible();
    const box = (await list(app).boundingBox())!;
    expect(box.x, "inside the left edge").toBeGreaterThanOrEqual(0);
    expect(box.x + box.width, "inside the right edge").toBeLessThanOrEqual(390);
    expect(box.y + box.height, "inside the bottom").toBeLessThanOrEqual(844);
    await list(app).getByRole("option", { name: /^JPEG — web/ }).tap();
    expect(await said(app, "Format")).toBe("JPEG (.jpg)");
  });
});
