/**
 * Fill layers and frames (TODO 1.10, app/commands/fills.ts): fills from the
 * current colours on the document in front, their editor opened, an open
 * adjustment gesture closed first; a frame from a layer and one drawn.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

type N = { id: string; name: string };
const names = (app: App) => app.page.evaluate(() => (window.graphiq!.layers() as N[]).map((n) => n.name));
const pixel = (app: App, x: number, y: number) =>
  app.page.evaluate(
    async ([x, y]) => {
      const bmp = await createImageBitmap((await window.graphiq!.exportPNG(1))!);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data];
    },
    [x, y],
  );
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 3);

test("fills from the current colours, on the document in front, their editor open", async ({ app }) => {
  await app.run("layer-new"); // the first document holds a layer of its own
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  await app.setForeground("#3366cc");
  await app.page.evaluate(() => window.graphiq!.run("fill-solid"));
  await expect(app.page.getByRole("dialog", { name: "Fill layer" }), "its editor opens").toBeVisible();
  await app.key("Escape");
  expect(await names(app)).toEqual(["Color Fill"]);
  expect(near(await pixel(app, 100, 75), [0x33, 0x66, 0xcc, 255]), "in the foreground colour").toBe(true);
  await app.run("fill-gradient");
  await app.settle(400);
  expect(await names(app)).toEqual(["Gradient Fill", "Color Fill"]);
  const [top, bottom] = [await pixel(app, 100, 0), await pixel(app, 100, 149)];
  // From the blue foreground at the top towards the white background at the bottom.
  expect(bottom[0] - top[0], "from one colour to the other").toBeGreaterThan(80);
  const ids = await app.page.evaluate(() => (window.graphiq!.layers() as N[]).map((n) => n.id));
  expect(new Set(ids).size).toBe(ids.length);
});

test("an adjustment's open gesture is closed before a fill goes in", async ({ app }) => {
  await app.openPanelById("history");
  await app.openPanelById("adjustments");
  await app.run("adj-brightness-contrast");
  await app.settle(300);
  // A slider move and the fill in one go: the gesture is still open when the fill arrives.
  await app.page.evaluate(() => {
    const el = document.querySelector<HTMLInputElement>('input[type="range"][aria-label="Contrast"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "40");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    window.graphiq!.run("fill-solid");
  });
  await app.settle(900);
  const rows = await app.historyRows();
  const edit = rows.findIndex((r) => r.startsWith("Edit Adjustment"));
  expect(edit, "the gesture is a step").toBeGreaterThan(-1);
  expect(rows.findIndex((r) => r.startsWith("New Fill Layer")), "before the fill's").toBeGreaterThan(edit);
});

test("a frame from a layer, and one drawn with the Frame tool", async ({ app }) => {
  await app.openPanelById("history");
  await app.run("layer-new");
  await app.setForeground("#c08040");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 100, y: 100, w: 300, h: 200 }]));
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.run("frame-from-layer");
  expect((await app.historyRows()).some((r) => r.startsWith("Frame from Layer"))).toBe(true);
  await app.pickTool("Frame");
  const b = await app.canvasBox();
  await app.page.mouse.move(b.x + b.width * 0.55, b.y + b.height * 0.2);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x + b.width * 0.8, b.y + b.height * 0.5, { steps: 10 });
  await app.page.mouse.up();
  await app.settle(400);
  expect((await names(app))[0]).toBe("Frame");
  expect((await app.historyRows()).some((r) => r.startsWith("New Frame"))).toBe(true);
});
