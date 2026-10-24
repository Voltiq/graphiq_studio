/**
 * Smart filters (TODO 1.10, app/commands/filters.ts): a filter from the menu
 * opens its stack on the document in front, a gesture in the dialog is one
 * step and one undo, and a layer's filter badge opens its stack and selects it.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

type N = { id: string; name: string };
const idOf = (app: App, name: string) =>
  app.page.evaluate((name) => (window.graphiq!.layers() as N[]).find((n) => n.name === name)!.id, name);
const row = async (app: App, name: string) =>
  app.page.locator(`[data-panel-id="layers"] [data-layer-id="${await idOf(app, name)}"]`).first();
const block = async (app: App, hex: string, r: { x: number; y: number; w: number; h: number }) => {
  await app.run("layer-new");
  await app.setForeground(hex);
  await app.page.evaluate((r) => window.graphiq!.select([r]), r);
  await app.key("Backspace");
  await app.run("select-deselect");
};
/** The composite once it stops changing: filters render off the main thread. */
const composite = (app: App) =>
  app.page.evaluate(async () => {
    const hash = async () => {
      const buf = await crypto.subtle.digest("SHA-256", await (await window.graphiq!.exportPNG(1))!.arrayBuffer());
      return [...new Uint8Array(buf)].slice(0, 8).join(",");
    };
    let h = await hash();
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const next = await hash();
      if (next === h) break;
      h = next;
    }
    return h;
  });
/** Move the dialog's first slider through `values`, 200 ms apart, inside the page. */
const sweep = (app: App, values: number[]) =>
  app.page.evaluate(async (values) => {
    for (const [i, v] of values.entries()) {
      if (i) await new Promise((r) => setTimeout(r, 200));
      const sel = '[role="dialog"][aria-label="Smart filters"] input[type="range"]';
      const el = document.querySelector<HTMLInputElement>(sel)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
  }, values);

test("a filter from the menu opens its stack on the document in front; a gesture is one step", async ({ app }) => {
  await app.run("layer-new"); // the first document holds a layer of its own
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  await app.openPanelById("layers");
  await app.openPanelById("history");
  await block(app, "#c08040", { x: 20, y: 20, w: 120, h: 80 });
  await app.page.evaluate(() => window.graphiq!.run("filter-add-noise"));
  const dialog = app.page.getByRole("dialog", { name: "Smart filters" });
  await expect(dialog, "the stack opens").toBeVisible();
  const badge = (await row(app, "Layer 2")).getByRole("button", { name: "Smart filters" });
  await expect(badge, "on the layer in front").toHaveCount(1);
  const added = await composite(app);
  await sweep(app, [10, 20, 30, 40]);
  await app.settle(900);
  const edits = (await app.historyRows()).filter((r) => r.startsWith("Edit Smart Filter"));
  expect(edits.length, "four moves, one step").toBe(1);
  await dialog.getByRole("button", { name: "Done", exact: true }).click();
  await app.key("Control+z");
  expect(await composite(app), "undone, all of it").toBe(added);
});

test("a layer's filter badge opens its stack, and selects it", async ({ app }) => {
  await app.openPanelById("layers");
  await block(app, "#c08040", { x: 20, y: 20, w: 60, h: 40 });
  await app.run("filter-add-noise"); // closes the stack it opens
  await block(app, "#4080c0", { x: 110, y: 80, w: 60, h: 40 });
  await expect(await row(app, "Layer 2")).toHaveAttribute("data-active", "true");
  await (await row(app, "Layer 1")).getByRole("button", { name: "Smart filters" }).click();
  await expect(app.page.getByRole("dialog", { name: "Smart filters" })).toBeVisible();
  await expect(await row(app, "Layer 1")).toHaveAttribute("data-active", "true");
});
