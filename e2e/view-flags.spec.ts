/**
 * The View menu's toggles and the Window menu's panels (TODO 1.5, app/state/
 * view.ts): one store the menus, the canvas, the options bar and the dock all
 * read — so each switch is the same switch wherever it is shown — kept for the
 * next session when a menu changes it.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The View menu's check marks, by item. */
const viewChecks = async (app: App) => {
  await app.page.getByText("View", { exact: true }).first().click();
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
const run = (app: App, id: string) => app.page.evaluate((id) => window.graphiq!.run(id), id);

test("the menus' toggles survive a reload, and the Move tool's Snap is View ▸ Snap", async ({ app }) => {
  const before = await viewChecks(app);
  expect([before["Show rulers"], before["Snap"]], "rulers off, snap on, by default").toEqual([false, true]);
  await run(app, "view-rulers");
  await run(app, "view-docgrid");
  await run(app, "view-snap");
  await run(app, "window-layers");
  await run(app, "window-history");
  await run(app, "window-color");
  await run(app, "window-color");
  await app.settle(300);
  await expect(app.page.locator("[data-stagewrap]")).toHaveAttribute("data-rulers", "true");
  await expect(app.page.locator('[data-panel-id="layers"]'), "Layers hidden").toHaveCount(0);
  await expect(app.page.locator('[data-panel-id="history"]'), "and History").toHaveCount(0);
  await expect(app.page.locator('[data-panel-id="color"]'), "Color hidden and shown again").toHaveCount(1);
  // The Move tool's switch is the same setting the View menu shows.
  await app.pickTool("Move");
  const sw = app.page.locator('[data-tour="options"]:visible').getByRole("switch", { name: "Snap" }).first();
  await expect(sw).toHaveAttribute("aria-checked", "false");
  await sw.click();
  await expect(sw, "the switch shows it").toHaveAttribute("aria-checked", "true");
  expect((await viewChecks(app))["Snap"], "switched on there, on in the menu").toBe(true);
  await run(app, "view-snap");
  await expect(sw, "and back off from the menu").toHaveAttribute("aria-checked", "false");
  await app.boot();
  const after = await viewChecks(app);
  expect([after["Show rulers"], after["Document grid"], after["Snap"]]).toEqual([true, true, false]);
  await expect(app.page.locator("[data-stagewrap]")).toHaveAttribute("data-rulers", "true");
  await expect(app.page.locator('[data-panel-id="layers"]'), "still hidden").toHaveCount(0);
  await run(app, "window-reset");
  await expect(app.page.locator('[data-panel-id="layers"]'), "Window ▸ Reset brings it back").toHaveCount(1);
});

test("a guide pulled from a ruler shows the guides if they were hidden; locked, the rulers are inert", async ({
  app,
}) => {
  await run(app, "view-rulers");
  await run(app, "view-guides"); // hidden
  await app.settle(300);
  expect((await viewChecks(app))["Show guides"]).toBe(false);
  const ruler = app.page.locator("[data-ruler][data-guides]").first(); // the top one
  const r = (await ruler.boundingBox())!;
  const c = await app.canvasBox();
  const pull = async () => {
    await app.page.mouse.move(r.x + r.width / 2, r.y + r.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(c.x + c.width / 2, c.y + c.height / 2, { steps: 8 });
    await app.page.mouse.up();
    await app.settle(400);
  };
  await app.openPanelById("history");
  const rows = (await app.historyRows()).length;
  await pull();
  expect((await viewChecks(app))["Show guides"], "shown by the pull").toBe(true);
  expect(await app.page.evaluate(() => JSON.parse(localStorage.getItem("pe-view")!).guides), "and remembered").toBe(true);
  expect((await app.historyRows()).length, "the guide is a step").toBe(rows + 1);
  await run(app, "view-lock-guides");
  await app.settle(300);
  await expect(app.page.locator("[data-ruler][data-guides]"), "the rulers say they are inert").toHaveCount(0);
  await pull();
  expect((await app.historyRows()).length, "locked: no guide").toBe(rows + 1);
});
