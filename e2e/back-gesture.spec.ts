/**
 * Back closes what is in front of you; it does not throw the document away.
 * (Ported from tools/verify-back-gesture.js, TODO 2.1.)
 *
 * On a phone the back gesture is how everything is dismissed, and nothing in
 * the app consumed it: back left the editor outright. A guard entry is now
 * pushed for it to land on, the layer in front is closed when it does, and only
 * with nothing left to close is the navigation allowed — at which point
 * `beforeunload` asks about unsaved work.
 *
 * The order matters as much as the behaviour: a dialog opened on top of a
 * drawer has to close FIRST, or back would dismantle the app from underneath.
 *
 * `beforeunload` does nothing at all on iOS, so it is the weaker half — the
 * autosave-on-hidden path (e2e/autosave.spec.ts) is what protects an iPhone.
 * Here it is raised with `page.close({ runBeforeUnload: true })`, the one way
 * an automated browser will.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** Press back the way the gesture does, without Playwright's navigation waits. */
async function back(app: App): Promise<void> {
  await app.page.evaluate(() => window.history.back());
  await app.settle(700);
}
const stillHere = (page: Page) => page.evaluate(() => !!document.querySelector('[data-tour="canvas"]'));
const drawer = (page: Page) => page.evaluate(() => document.documentElement.dataset.drawer ?? "");
const openTools = async (app: App) => {
  await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().click();
  await app.settle(600);
};

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("back closes an open drawer instead of leaving", async ({ app }) => {
    await openTools(app);
    expect(await drawer(app.page), "the drawer opened").toBe("tools");
    await back(app);
    expect(await drawer(app.page), "it closed").toBe("");
    expect(await stillHere(app.page), "...and the editor is still here").toBe(true);
  });

  test("back closes the menu sheet instead of leaving", async ({ app }) => {
    const sheet = app.page.locator('[data-menubar][data-sheet="true"]');
    await app.page.locator('button[aria-label="Menu"]').first().click();
    await app.settle(600);
    await expect(sheet, "the sheet opened").toHaveCount(1);
    await back(app);
    await expect(sheet, "it closed").toHaveCount(0);
    expect(await stillHere(app.page), "...and the editor is still here").toBe(true);
  });

  test("a dialog above a drawer closes first, and the drawer stays", async ({ app }) => {
    const { page } = app;
    await openTools(app);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
    await app.settle(500);
    await expect(page.locator('[role="dialog"]'), "the palette opened on top of the drawer").not.toHaveCount(0);
    await back(app);
    await expect(page.locator('[role="dialog"]'), "back closed the palette").toHaveCount(0);
    expect(await drawer(page), "...and left the drawer open").toBe("tools");
  });
});

/** Close the page with beforeunload live, and report whether it asked. */
async function closeAndWatch(page: Page): Promise<boolean> {
  let asked = false;
  page.on("dialog", async (d) => {
    asked = d.type() === "beforeunload";
    await d.dismiss().catch(() => {});
  });
  await page.close({ runBeforeUnload: true });
  await new Promise((r) => setTimeout(r, 1_200));
  return asked;
}

test("leaving an untouched document asks nothing", async ({ app }) => {
  expect(await closeAndWatch(app.page)).toBe(false);
});

test("leaving with unsaved work asks first", async ({ app }) => {
  const { page } = app;
  const b = await app.canvasBox();
  await page.mouse.move(b.x + b.width * 0.4, b.y + b.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(b.x + b.width * (0.4 + i * 0.02), b.y + b.height * (0.5 + i * 0.02));
  await page.mouse.up();
  await app.settle(900);
  await expect(page.locator('[data-tour="status"]'), "the edit registers as unsaved work").toContainText("Unsaved changes");
  expect(await closeAndWatch(page), "beforeunload prompted").toBe(true);
});
