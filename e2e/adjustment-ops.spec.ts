/**
 * The adjustment commands (TODO 1.10, app/commands/adjustments.ts): layers
 * added to the document in front, a slider gesture as one step, clipping,
 * Curves and Hue/Saturation opening their editors, a .cube becoming a Color
 * Lookup layer, and Levels on a pixel layer.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

type N = { id: string; name: string; type: string; children?: N[] };
const names = (app: App) =>
  app.page.evaluate(() => (window.graphiq!.layers() as N[]).map((n) => `${n.type}:${n.name}`));
const composite = (app: App) =>
  app.page.evaluate(async () => {
    const buf = await crypto.subtle.digest("SHA-256", await (await window.graphiq!.exportPNG(1))!.arrayBuffer());
    return [...new Uint8Array(buf)].slice(0, 8).join(",");
  });
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
/** Run a command and leave the dialog it opens open (`app.run` closes it). */
const open = (app: App, id: string) => app.page.evaluate((id) => window.graphiq!.run(id), id);
const CUBE = [
  "LUT_3D_SIZE 2",
  ...Array.from({ length: 8 }, (_, i) => `${i & 1} ${(i >> 1) & 1} ${(i >> 2) & 1}`),
].join("\n");

test("adjustment layers on the document in front: a gesture is one step, clipping, editors", async ({ app }) => {
  await app.run("layer-new"); // the first document holds a layer of its own
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  await app.openPanelById("history");
  await app.openPanelById("adjustments");
  await app.run("layer-new");
  await app.setForeground("#c08040"); // off mid-grey, where contrast pivots
  await app.page.evaluate(() => window.graphiq!.select([{ x: 0, y: 0, w: 200, h: 150 }]));
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.run("adj-brightness-contrast");
  await app.settle(300);
  expect(await names(app)).toEqual(["adjustment:Adjustment", "layer:Layer 2"]);
  const before = await composite(app);
  const steps = async () => (await app.historyRows()).filter((r) => r.startsWith("Edit Adjustment")).length;
  // Moves each inside half a second of the last, longer than one in all: one gesture.
  await sweep(app, 'input[type="range"][aria-label="Contrast"]', [20, 30, 45, 60]);
  await app.settle(900);
  expect(await steps(), "four moves, one step").toBe(1);
  expect(await composite(app), "and the picture changed").not.toBe(before);
  await app.key("Control+z");
  await app.settle(400);
  expect(await composite(app), "undone, as it was").toBe(before);

  await app.run("layer-clip");
  await app.settle(300);
  expect((await app.historyRows()).some((r) => r.startsWith("Create Clipping Mask"))).toBe(true);

  await open(app, "adj-tone-curves");
  await expect(app.page.getByRole("dialog", { name: "Curves" }), "Curves opens on its layer").toBeVisible();
  await app.key("Escape");
  await open(app, "adj-x-huesat");
  await expect(app.page.getByRole("dialog", { name: "Hue / Saturation" })).toBeVisible();
  await app.key("Escape");
  const chooser = app.page.waitForEvent("filechooser");
  await open(app, "adj-x-colorlookup");
  await (await chooser).setFiles({ name: "tiny.cube", mimeType: "text/plain", buffer: Buffer.from(CUBE) });
  await app.settle(500);
  expect((await names(app))[0], "a .cube becomes a layer").toBe("adjustment:Color Lookup — tiny");
  const all = await app.page.evaluate(() => {
    const out: string[] = [];
    const walk = (ns: N[]) => ns.forEach((n) => (out.push(n.id), n.children && walk(n.children)));
    walk(window.graphiq!.layers() as N[]);
    return out;
  });
  expect(new Set(all).size, "every id its own").toBe(all.length);
});

test("Levels on a pixel layer opens on its pixels", async ({ app }) => {
  await app.run("layer-new");
  await app.settle(300);
  await open(app, "tone-dest-levels");
  await expect(app.page.getByRole("dialog", { name: "Levels" })).toBeVisible();
});
