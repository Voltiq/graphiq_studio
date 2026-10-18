/**
 * Closing a document frees its pixels. (TODO 1.2, the part that is a leak)
 *
 * The engine is shared by every tab and keeps each document's layer and mask
 * canvases in one map. Closing a tab discarded its history and its React state
 * but never told the engine, so every canvas of a closed document stayed
 * resident until the page reloaded — unreachable, since its history was gone,
 * and on a phone the difference between a session that lasts and one that dies.
 */
import { test, expect, type App } from "./fixtures";

type Report = { total: number; buffers: { name: string; bytes: number }[] };
const memory = (page: import("@playwright/test").Page) =>
  page.evaluate(() => (window as unknown as { __gqMemory: () => Report }).__gqMemory());

/** A Pen path, then Layer ▸ Vector Mask from it, on the active layer. */
async function addVectorMask(app: App): Promise<void> {
  await app.key("p");
  const b = await app.canvasBox();
  for (const [fx, fy] of [[0.3, 0.3], [0.7, 0.3], [0.7, 0.7], [0.3, 0.7]])
    await app.page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
  await app.key("Enter");
  await app.run("vmask-add");
}

test("closing a document releases every canvas it owned", async ({ app }) => {
  const keep = (await app.docs())[0].id;
  const doomed = await app.newDoc();

  // Three painted layers and a layer mask in the document about to be closed.
  for (let i = 0; i < 3; i++) {
    await app.run("layer-new");
    await app.page.evaluate(() => window.graphiq!.select([{ x: 100, y: 100, w: 400, h: 300 }]));
    await app.setForeground("#e0402a");
    await app.key("Backspace");
  }
  await app.run("select-deselect");
  await app.run("mask-add");
  // And a vector mask, whose raster is document-sized too.
  await addVectorMask(app);
  const ids = (await app.page.evaluate(() => window.graphiq!.layers())).map((l) => l.id);
  expect(ids, "the document has its three layers").toHaveLength(3);

  const before = await memory(app.page);
  const owned = before.buffers.filter((b) => ids.some((id) => b.name.endsWith(`:${id}`)));
  expect(owned.length, "its layers and masks are resident").toBeGreaterThanOrEqual(5);
  expect(owned.map((b) => b.name), "the vector mask is rasterised").toContainEqual(
    expect.stringMatching(/^vmask:/),
  );
  const ownedBytes = owned.reduce((n, b) => n + b.bytes, 0);

  const name = (await app.docs()).find((d) => d.id === doomed)!.name;
  await app.page.locator(`[aria-label="Close ${name}"]`).first().click({ force: true });
  await app.settle();
  expect((await app.docs()).map((d) => d.id)).toEqual([keep]);

  const after = await memory(app.page);
  const left = after.buffers.filter((b) => ids.some((id) => b.name.endsWith(`:${id}`)));
  expect(left.map((b) => b.name), "no canvas of the closed document is left").toEqual([]);
  expect(before.total - after.total, "and the memory came back").toBeGreaterThanOrEqual(ownedBytes);
});

test("deleting a vector mask frees its raster", async ({ app }) => {
  await app.run("layer-new");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 100, y: 100, w: 400, h: 300 }]));
  await app.setForeground("#e0402a");
  await app.key("Backspace");
  await app.run("select-deselect");
  await addVectorMask(app);
  const rasters = async () =>
    (await memory(app.page)).buffers.filter((b) => b.name.startsWith("vmask:")).length;
  expect(await rasters(), "the mask is rasterised while it is in use").toBe(1);

  await app.run("vmask-delete");
  await app.settle();
  expect(await rasters(), "and let go once it is gone").toBe(0);
});
