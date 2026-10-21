/**
 * Menu commands, end to end, through the command registry (TODO 1.1).
 * Its completeness is a compile-time guarantee; this checks that real clicks
 * and real strings reach it, and that the families route.
 */
import { test, expect } from "./fixtures";

test("File ▸ Close closes the active document (it used to do nothing)", async ({ app }) => {
  const first = (await app.docs())[0].id;
  const second = await app.newDoc();
  await app.menu("File", "Close");
  const left = (await app.docs()).map((d) => d.id);
  expect(left).toEqual([first]);
  expect(left).not.toContain(second);
});

test("File ▸ Close on the last document keeps it, and says why", async ({ app }) => {
  await app.menu("File", "Close");
  expect(await app.docs()).toHaveLength(1);
  await expect(app.page.getByText("This is the only open document")).toBeVisible();
});

/* The one command that opens something which is not a "…" dialog, so the
   dialog walkers never reach it. */
test("Help ▸ the tour starts the tour", async ({ app }) => {
  const tour = app.page.locator('div[aria-label="Interactive tour"]');
  await expect(tour).toHaveCount(0);
  // Not app.run: that closes the modal a command opens, and the tour is one.
  expect(await app.page.evaluate(() => window.graphiq!.run("help-tour"))).toBe(true);
  await expect(tour).toBeVisible();
  await app.page.keyboard.press("Escape");
  await expect(tour).toHaveCount(0);
});

test("the scripting console refuses an unknown command, and runs a real one", async ({ app }) => {
  expect(await app.page.evaluate(() => window.graphiq!.run("no-such-command"))).toBe(false);
  expect(await app.page.evaluate(() => window.graphiq!.run("layer-new"))).toBe(true);
  await app.settle();
  expect(await app.layerNames()).toHaveLength(1);
});

test("each command family routes to its handler", async ({ app }) => {
  const history = app.page.locator('[data-panel-id="history"]');
  const shown = async () => (await history.count()) > 0;
  // panel: window-<panel> toggles that panel
  const before = await shown();
  await app.run("window-history");
  expect(await shown(), "window-history toggled the History panel").toBe(!before);
  await app.run("window-history");
  expect(await shown()).toBe(before);
  // effect and filter: they act on the active layer
  await app.run("layer-new");
  await app.run("fx-add-stroke");
  await app.run("filter-add-blur");
  await app.expandPanel("History");
  const steps = (await app.historyRows()).join(" | ");
  expect(steps, "fx-add-stroke added an effect").toMatch(/Add Layer Effect/);
  expect(steps, "filter-add-blur added a smart filter").toMatch(/Add .*Blur/i);
  // adjustment: adds an adjustment layer
  const n = (await app.layerNames()).length;
  await app.run("adj-exposure");
  expect((await app.layerNames()).length).toBe(n + 1);
});
