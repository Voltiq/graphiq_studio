/**
 * The clipboard (TODO 1.10, app/commands/clipboard.ts): a copy pastes back in
 * place on the document in front, the Move tool in hand; one from another
 * document asks where it goes, and lands there; a new canvas comes to the
 * front; cut is a step, and undo takes a float back before anything else.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

type N = { id: string; name: string };
const names = (app: App) => app.page.evaluate(() => (window.graphiq!.layers() as N[]).map((n) => n.name));
const docs = (app: App) => app.page.evaluate(() => window.graphiq!.docs());
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
const newDoc = async (app: App, w: number, h: number) => {
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill(String(w));
  await nd.locator('input[type="number"]').nth(1).fill(String(h));
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
};
const block = async (app: App, r: { x: number; y: number; w: number; h: number }) => {
  await app.run("layer-new");
  await app.setForeground("#d02060");
  await app.page.evaluate((r) => window.graphiq!.select([r]), r);
  await app.key("Backspace");
};
/** Run a command and leave the dialog it opens open (`app.run` closes it). */
const open = (app: App, id: string) => app.page.evaluate((id) => window.graphiq!.run(id), id);

test("a copy pastes back in place on the document in front, the Move tool in hand", async ({ app }) => {
  await app.openPanelById("history");
  await block(app, { x: 10, y: 10, w: 50, h: 50 }); // the first document has its own picture
  await newDoc(app, 200, 150);
  await block(app, { x: 40, y: 30, w: 60, h: 40 });
  await app.run("edit-copy");
  await app.run("select-deselect");
  await app.run("edit-paste");
  await app.settle(300);
  await expect(app.page.locator('[data-tool="move"][aria-pressed="true"]').first(), "the Move tool").toBeVisible();
  await expect(app.page.locator('footer[data-tour="status"]'), "the float selected").toContainText("60 × 40");
  await app.run("select-deselect");
  await app.settle(400);
  expect((await app.historyRows()).some((r) => r.startsWith("Paste")), "the paste put down").toBe(true);
  expect([await alpha(app, 50, 40), await alpha(app, 150, 120)], "in place").toEqual([255, 0]);
});

test("a copy from another document asks where it goes, and lands as a new layer or a new canvas", async ({ app }) => {
  await block(app, { x: 100, y: 100, w: 80, h: 60 });
  await app.run("edit-copy");
  await newDoc(app, 200, 150);
  await open(app, "edit-paste");
  const dialog = app.page.getByRole("dialog", { name: "Paste image" });
  await expect(dialog, "it asks").toBeVisible();
  await dialog.getByText("New layer", { exact: true }).first().click();
  await dialog.locator("footer button").last().click();
  await app.settle(500);
  expect(await names(app)).toEqual(["Pasted Layer"]);
  expect(await alpha(app, 100, 75), "centred").toBe(255);
  const before = (await docs(app)).length;
  await open(app, "edit-paste");
  await dialog.getByText("New canvas", { exact: true }).first().click();
  await dialog.locator("footer button").last().click();
  await app.settle(800);
  const after = await docs(app);
  expect(after.length).toBe(before + 1);
  expect(after.find((d) => d.active), "a canvas of its own, in front").toMatchObject({ width: 80, height: 60 });
  expect(new Set(after.map((d) => d.id)).size, "every document its own id").toBe(after.length);
});

test("cut is a step; undo takes a float back before the cut", async ({ app }) => {
  await app.openPanelById("history");
  await block(app, { x: 100, y: 100, w: 200, h: 100 });
  await app.page.evaluate(() => window.graphiq!.select([{ x: 120, y: 120, w: 50, h: 50 }]));
  await app.run("edit-cut");
  await app.settle(300);
  expect((await app.historyRows()).some((r) => r.startsWith("Cut"))).toBe(true);
  expect(await alpha(app, 140, 140), "cut away").toBe(0);
  await app.run("edit-paste"); // floats back in place
  await app.key("Control+z");
  await app.settle(400);
  expect(await alpha(app, 140, 140), "the float taken back, the cut still there").toBe(0);
  await app.key("Control+z");
  await app.settle(400);
  expect(await alpha(app, 140, 140), "then the cut undone").toBe(255);
});
