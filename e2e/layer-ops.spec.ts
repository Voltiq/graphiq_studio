/**
 * The layer commands (TODO 1.10, app/commands/layers.ts): New, Duplicate,
 * Group, Merge, Flatten and the rest act on the document in front, each as one
 * step in its history — and Merge and Stamp Visible say when there is nothing
 * to do.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

type N = { id: string; name: string; children?: N[] };
const tree = (app: App) =>
  app.page.evaluate(() => {
    const walk = (ns: N[]): unknown[] => ns.map((n) => (n.children ? [n.name, walk(n.children)] : n.name));
    return walk(window.graphiq!.layers() as N[]);
  });
const ids = (app: App) =>
  app.page.evaluate(() => {
    const out: string[] = [];
    const walk = (ns: N[]) => ns.forEach((n) => (out.push(n.id), n.children && walk(n.children)));
    walk(window.graphiq!.layers() as N[]);
    return out;
  });
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

test("the layer commands act on the document in front, each one step", async ({ app }) => {
  // Something in the first document, so a command that read the wrong one would show.
  await app.run("layer-new");
  await app.run("layer-new");
  const first = await tree(app);
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  await app.openPanelById("history");

  await app.run("layer-new");
  await app.setForeground("#d02060");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 10, y: 10, w: 40, h: 40 }]));
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.run("layer-duplicate");
  await app.settle(300);
  expect(await tree(app)).toEqual(["Layer 3 copy", "Layer 3"]);
  await app.page.evaluate((id) => window.graphiq!.setLayer(id, { visible: false }), (await ids(app))[1]);
  await app.settle(300);
  expect(await pixel(app, 20, 20), "the copy has the pixels").toEqual([208, 32, 96, 255]);
  await app.page.evaluate((id) => window.graphiq!.setLayer(id, { visible: true }), (await ids(app))[1]);

  await app.run("layer-group");
  expect(await tree(app)).toEqual([["Group", ["Layer 3 copy"]], "Layer 3"]);
  await app.run("layer-ungroup");
  await app.run("layer-merge-down");
  expect(await tree(app)).toEqual(["Layer 3"]);
  await app.run("layer-new");
  await app.run("layer-flatten");
  expect(await tree(app)).toEqual(["Flattened"]);
  const all = await ids(app);
  expect(new Set(all).size, "every id its own").toBe(all.length);
  expect(await pixel(app, 20, 20), "and the picture survives it all").toEqual([208, 32, 96, 255]);
  const rows = await app.historyRows();
  for (const label of ["New Layer", "Duplicate Layer", "Group Layers", "Ungroup", "Merge Down", "Flatten Image"]) {
    expect(rows.some((r) => r.startsWith(label)), `"${label}" is a step`).toBe(true);
  }
  await app.key("Control+z");
  await app.settle(300);
  const undone = await tree(app);
  expect(undone, "undone, the merged layer and the new one are back").toHaveLength(2);
  expect([undone[0], undone[1]]).toEqual([expect.stringMatching(/^Layer \d+$/), "Layer 3"]);

  const docs = await app.page.evaluate(() => window.graphiq!.docs());
  await app.page.evaluate((id) => window.graphiq!.activate(id), docs[0].id);
  await app.settle(800);
  expect(await tree(app), "the first document is as it was").toEqual(first);
});

test("Merge Visible and Stamp Visible say when there is nothing to do", async ({ app }) => {
  const toast = app.page.locator('[role="status"]');
  await app.run("layer-merge-visible");
  await expect(toast).toContainText("Nothing visible to merge.");
  await app.run("layer-stamp-visible");
  await expect(toast).toContainText("Nothing visible to stamp.");
  await app.run("layer-new");
  await app.run("layer-merge-visible");
  await expect(toast).toContainText("Only one visible layer — nothing to merge into.");
});
