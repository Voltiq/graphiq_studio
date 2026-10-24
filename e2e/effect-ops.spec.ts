/**
 * Layer styles (TODO 1.10, app/commands/effects.ts): Add Layer Effect opens
 * the dialog on the document in front, a gesture in it is one step, a style
 * copies and pastes from the Layers panel's menu, and Layer Style… opened on
 * another layer selects it.
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
const menu = async (app: App, name: string, item: string) => {
  await (await row(app, name)).click({ button: "right", position: { x: 60, y: 10 } });
  await app.page.getByRole("menu").getByText(item, { exact: false }).first().click();
};
const block = async (app: App, hex: string, r: { x: number; y: number; w: number; h: number }) => {
  await app.run("layer-new");
  await app.setForeground(hex);
  await app.page.evaluate((r) => window.graphiq!.select([r]), r);
  await app.key("Backspace");
  await app.run("select-deselect");
};
/** Move a slider through `values`, `gap` ms apart, inside the page: the gaps hold even on a
 *  busy machine, where a round trip from the test could stretch past the half second that
 *  ends a gesture. */
const sweep = (app: App, selector: string, values: number[], gap = 200) =>
  app.page.evaluate(
    async ([selector, values, gap]) => {
      for (const [i, v] of values.entries()) {
        if (i) await new Promise((r) => setTimeout(r, gap));
        const el = document.querySelector<HTMLInputElement>(selector)!;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }
    },
    [selector, values, gap] as const,
  );
const composite = (app: App) =>
  app.page.evaluate(async () => {
    const buf = await crypto.subtle.digest("SHA-256", await (await window.graphiq!.exportPNG(1))!.arrayBuffer());
    return [...new Uint8Array(buf)].slice(0, 8).join(",");
  });

test("in front: an effect opens its dialog, a gesture is one step, a style copies and pastes", async ({ app }) => {
  await app.run("layer-new"); // the first document holds a layer of its own
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  await app.openPanelById("layers");
  await app.openPanelById("history");
  await block(app, "#c08040", { x: 20, y: 20, w: 60, h: 40 });
  await block(app, "#4080c0", { x: 110, y: 80, w: 60, h: 40 });

  await app.page.evaluate(() => window.graphiq!.run("fx-add-dropShadow"));
  const dialog = app.page.getByRole("dialog", { name: "Layer style" });
  await expect(dialog, "the dialog opens on it").toBeVisible();
  await expect(await row(app, "Layer 3"), "the effect is on the layer in front").toContainText("fx");
  const added = await composite(app);
  // Moves each inside half a second of the last, longer than one in all: one gesture.
  const distance = '[role="dialog"][aria-label="Layer style"] input[type="range"][aria-label="Distance"]';
  await sweep(app, distance, [20, 30, 40, 50]);
  await app.settle(900);
  const edits = (await app.historyRows()).filter((r) => r.startsWith("Edit Layer Style"));
  expect(edits.length, "four moves, one step").toBe(1);
  await app.key("Escape");
  await app.settle(300);
  await app.key("Control+z");
  await app.settle(400);
  expect(await composite(app), "undone, all of it").toBe(added);
  await app.key("Control+Shift+z");
  await app.settle(400);

  const before = await composite(app);
  await menu(app, "Layer 3", "Copy Layer Style");
  await menu(app, "Layer 2", "Paste Layer Style");
  await app.settle(400);
  await expect(await row(app, "Layer 2"), "pasted").toContainText("fx");
  expect((await app.historyRows()).some((r) => r.startsWith("Paste Layer Style"))).toBe(true);
  expect(await composite(app), "and drawn").not.toBe(before);
});

test("a layer's fx badge opens its style, and selects it", async ({ app }) => {
  await app.openPanelById("layers");
  await block(app, "#c08040", { x: 20, y: 20, w: 60, h: 40 });
  await app.run("fx-add-stroke"); // closes the dialog it opens
  await block(app, "#4080c0", { x: 110, y: 80, w: 60, h: 40 });
  await expect(await row(app, "Layer 2")).toHaveAttribute("data-active", "true");
  await (await row(app, "Layer 1")).locator("[data-fx]").click();
  await expect(app.page.getByRole("dialog", { name: "Layer style" })).toBeVisible();
  await expect(await row(app, "Layer 1")).toHaveAttribute("data-active", "true");
});
