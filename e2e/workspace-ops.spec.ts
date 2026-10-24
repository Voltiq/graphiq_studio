/**
 * The workspace (TODO 1.10, app/commands/workspace.ts): the commands that open
 * a dialog or the tour, zoom, flip a view flag, compare, proof, gamut and the
 * HUD, and show, hide and reset the panels — each reaching what it changes.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** A menu's checkboxes, by label. */
const checks = async (app: App, menu: string): Promise<Record<string, boolean>> => {
  await app.page.getByText(menu, { exact: true }).first().click();
  await app.settle(250);
  const out = await app.page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[role="menuitemcheckbox"]')].map((e) => [
        (e.firstChild?.textContent ?? e.textContent ?? "").trim(),
        e.getAttribute("aria-checked") === "true",
      ]),
    ),
  );
  await app.page.keyboard.press("Escape");
  await app.settle(250);
  return out;
};
/** Run a command as the menus do — `app.run` would close the dialog it opens. */
const run = async (app: App, id: string) => {
  await app.page.evaluate((id) => window.graphiq!.run(id), id);
  await app.settle(400);
};

test("a dialog and the tour open; zoom steps in and back to fit; a view flag flips", async ({ app }) => {
  const { page } = app;
  await run(app, "view-new-guide");
  await expect(page.getByRole("dialog", { name: "New guide" })).toBeVisible();
  await page.keyboard.press("Escape");
  await run(app, "help-tour");
  await expect(page.getByRole("dialog", { name: "Interactive tour" })).toBeVisible();
  await page.keyboard.press("Escape");
  await app.settle(400);
  const fit = Math.round((await app.canvasBox()).width);
  await run(app, "view-zoom-in");
  expect((await app.canvasBox()).width, "zoomed in").toBeGreaterThan(fit);
  await run(app, "view-fit");
  expect(Math.round((await app.canvasBox()).width)).toBe(fit);
  const rulers = (await checks(app, "View"))["Show rulers"];
  await run(app, "view-rulers");
  expect((await checks(app, "View"))["Show rulers"]).toBe(!rulers);
  await expect(page.locator("[data-ruler]").first()).toBeVisible({ visible: !rulers });
  await run(app, "view-rulers");
  expect((await checks(app, "View"))["Show rulers"]).toBe(rulers);
});

test("compare, its axis, proof, gamut and the HUD come on and go off", async ({ app }) => {
  const { page } = app;
  await app.run("layer-new");
  await app.run("adj-x-invert"); // something to compare against
  const ids = ["view-compare", "view-compare-axis", "view-proof", "view-gamut", "view-perf-hud"];
  const labels = [
    "Compare before/after",
    "Compare axis: horizontal",
    "Proof colors",
    "Gamut warning",
    "Performance HUD",
  ];
  const on = async () => {
    const c = await checks(app, "View");
    return labels.map((l) => c[l]);
  };
  expect(await on()).toEqual([false, false, false, false, false]);
  for (const id of ids) await run(app, id);
  expect(await on()).toEqual([true, true, true, true, true]);
  await expect(page.locator('[class*="comparePane"]').first(), "the split on the canvas").toBeVisible();
  await expect(page.locator('[class*="PerfHud"]').first(), "the HUD over it").toBeVisible();
  for (const id of ids) await run(app, id);
  expect(await on()).toEqual([false, false, false, false, false]);
  await expect(page.locator('[class*="comparePane"]')).toHaveCount(0);
  await expect(page.locator('[class*="PerfHud"]')).toHaveCount(0);
});

test.describe("with the Layers panel docked on the left", () => {
  test.use({
    storage: {
      "graphiq:panel-layout": JSON.stringify({ order: [], left: ["layers"], floats: {}, open: { layers: true } }),
    },
  });

  test("a panel hides and shows; the reset brings every panel back, docked right", async ({ app }) => {
    const { page } = app;
    const leftLayers = page.locator('[aria-label="Left dock"] [data-panel-id="layers"]');
    await expect(leftLayers).toHaveCount(1);
    await run(app, "window-history");
    expect((await checks(app, "Window")).History).toBe(false);
    await expect(page.locator('[data-panel-id="history"]')).toHaveCount(0);
    await run(app, "window-history");
    expect((await checks(app, "Window")).History).toBe(true);
    await run(app, "window-history");
    await run(app, "window-reset");
    const w = await checks(app, "Window");
    expect(Object.values(w).every(Boolean), "every panel shown").toBe(true);
    await expect(leftLayers, "back in the right dock").toHaveCount(0);
    await expect(page.locator('[data-panel-id="layers"]').first()).toBeAttached();
  });
});
