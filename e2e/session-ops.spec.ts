/**
 * The sessions (TODO 1.10, app/commands/sessions.ts): the Blur Gallery
 * previews on the document in front, Cancel puts the pixels back, Apply is
 * one step at the amount chosen; Liquify and Warp open on a pixel layer,
 * apply as a step, and refuse an adjustment.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The composite once it stops changing: the blur previews off the main thread. */
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
const open = (app: App, id: string) => app.page.evaluate((id) => window.graphiq!.run(id), id);
const amount = (app: App, v: number) =>
  app.page.evaluate((v) => {
    const sel = '[role="dialog"][aria-label="Blur gallery"] input[type="range"]';
    const el = document.querySelector<HTMLInputElement>(sel)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, v);

test("the Blur Gallery previews in front, Cancel puts it back, Apply is one step at its amount", async ({ app }) => {
  await app.run("layer-new"); // the first document holds a layer of its own
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  await app.openPanelById("history");
  await app.run("layer-new");
  await app.setForeground("#c08040");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 50, y: 40, w: 100, h: 70 }]));
  await app.key("Backspace");
  await app.run("select-deselect");
  const before = await composite(app);

  const dialog = app.page.getByRole("dialog", { name: "Blur gallery" });
  await open(app, "effect-blur");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByText("Rendering preview…"), "a preview arrives").toHaveCount(0);
  await amount(app, 40);
  await app.settle(600);
  expect(await composite(app), "previewed on the canvas").not.toBe(before);
  await dialog.locator("footer button").first().click();
  expect(await composite(app), "Cancel puts the pixels back").toBe(before);

  await open(app, "effect-blur");
  await expect(dialog.getByText("Rendering preview…")).toHaveCount(0);
  await amount(app, 40);
  await app.settle(600);
  await dialog.locator("footer button").last().click();
  await app.settle(600);
  expect((await app.historyRows()).filter((r) => r.startsWith("Gaussian Blur")).length).toBe(1);
  // 20 px outside the block: a blur of 40 reaches it, the default 12 does not.
  expect(await alpha(app, 30, 75), "at the amount chosen").toBeGreaterThan(10);
});

test("Liquify and Warp open on a pixel layer, apply as a step, and refuse an adjustment", async ({ app }) => {
  await app.openPanelById("history");
  await app.run("layer-new");
  for (const [id, name, label] of [
    ["effect-liquify", "Liquify", "Liquify"],
    ["effect-warp", "Warp", "Warp"],
  ] as const) {
    await open(app, id);
    const dialog = app.page.getByRole("dialog", { name });
    await expect(dialog).toBeVisible();
    await dialog.locator("footer button").last().click();
    await app.settle(500);
    expect((await app.historyRows()).some((r) => r.startsWith(label)), `${label} is a step`).toBe(true);
  }
  await app.run("adj-x-invert");
  await open(app, "effect-liquify");
  await expect(app.page.locator('[role="status"]')).toContainText("Select a pixel layer to liquify.");
});
