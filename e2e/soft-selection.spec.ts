/**
 * A soft selection stays soft (fixed in v2.6.0).
 *
 * Before: a 120 px, 0%-hardness Quick Mask stroke became a mask with exactly two
 * alpha levels — grayscale selections were thresholded at 50% into rects. The
 * engine now keeps the 8-bit coverage beside the rects (PaintEngine.coverageOf).
 * Each case is its own test, on a fresh page, so they run in parallel.
 *
 * MUTATION: stop maskSelectionRects registering coverage and A–E fail while the
 * F control passes; disable only the brush path and only D fails; only the fill
 * path and only B fails. (Ported from tools/verify-soft-selection.js.)
 */
import { test, expect, type App } from "./fixtures";

/** Partial pixels a soft edge must produce at least (the band alone is ~200k). */
const SOFT = 5000;

/** Quick Mask → a soft BLACK stroke → the selection. With nothing selected, Quick
 *  Mask starts fully revealed, so this selects everything but a soft-edged band. */
async function softSelection(app: App) {
  await app.run("select-quickmask");
  await app.brush(200, 0);
  await app.setForeground("#000000");
  await app.drag(0.5);
  await app.run("select-quickmask");
}

async function opaqueLayer(app: App) {
  await app.setForeground("#3aa0ff");
  await app.run("fill-solid");
  await app.run("layer-flatten");
}

test("A  mask from a soft selection is soft", async ({ app }) => {
  await opaqueLayer(app);
  await softSelection(app);
  await app.run("mask-from-sel");
  expect((await app.exported()).partial).toBeGreaterThan(SOFT);
});

test("B  Backspace fills a soft selection softly", async ({ app }) => {
  await softSelection(app);
  await app.setForeground("#e0402a");
  await app.key("Backspace");
  expect((await app.exported()).partial).toBeGreaterThan(SOFT);
});

test("C  Delete erases a soft selection softly", async ({ app }) => {
  await opaqueLayer(app);
  await softSelection(app);
  await app.key("Delete");
  expect((await app.exported()).partial).toBeGreaterThan(SOFT);
});

test("D  a hard brush inside a soft selection paints softly", async ({ app }) => {
  await softSelection(app);
  await app.run("layer-new");
  await app.brush(500, 100);
  await app.setForeground("#20a050");
  await app.drag(0.5, 0.1, 0.9);
  expect((await app.exported()).partial).toBeGreaterThan(SOFT);
});

test("E  a Quick Mask round trip is lossless", async ({ app }) => {
  await opaqueLayer(app);
  await softSelection(app);
  await app.run("mask-from-sel");
  const once = await app.exported();
  await app.run("undo");
  await app.run("select-quickmask"); // back into Quick Mask FROM the soft selection…
  await app.run("select-quickmask"); // …and straight out again
  await app.run("mask-from-sel");
  const twice = await app.exported();
  expect(once.partial).toBeGreaterThan(SOFT);
  expect(twice.hash).toBe(once.hash);
});

/* Without this, "soft" could pass on something merely blurry everywhere. */
test("F  control: a marquee selection still fills hard", async ({ app }) => {
  await app.page.evaluate(() => window.graphiq!.select([{ x: 300, y: 200, w: 700, h: 400 }]));
  await app.settle();
  await app.setForeground("#e0402a");
  await app.key("Backspace");
  const c = await app.exported();
  expect(c.levels).toBe(2);
  expect(c.partial).toBe(0);
});

/* TODO 0.2a: operations that used to rebuild a soft selection as hard rects. */

test("G  Select ▸ Inverse of a soft selection is its exact complement, still soft", async ({ app }) => {
  await opaqueLayer(app);
  await softSelection(app);
  await app.run("mask-from-sel");
  const direct = await app.exported();
  await app.run("undo"); // the mask
  await app.run("select-inverse");
  await app.run("mask-from-sel");
  const inverted = await app.exported();
  expect(inverted.partial, "the inverse kept its soft edge").toBeGreaterThan(SOFT);
  /* Every pixel's coverage became 255 − a, so the two masks' alpha sums add up
     to exactly 255 per pixel — a hard inverse could not land on that. */
  const px = 1920 * 1080;
  expect(direct.alphaSum + inverted.alphaSum).toBe(255 * px);
});

test("H  intersecting with a soft saved channel keeps the soft edge", async ({ app }) => {
  await opaqueLayer(app);
  await softSelection(app);
  // Save it as a channel…
  await app.page.evaluate(() => window.graphiq!.run("select-save"));
  const save = app.page.locator('div[role="dialog"][aria-label="Save selection"]');
  await save.waitFor();
  await save.locator('input[aria-label="Channel name"]').fill("soft");
  await save.getByRole("button", { name: "Save", exact: true }).click();
  await app.settle();
  // …then a hard rect over the left half, intersected with it.
  await app.page.evaluate(() => window.graphiq!.select([{ x: 0, y: 0, w: 960, h: 1080 }]));
  await app.settle();
  await app.page.evaluate(() => window.graphiq!.run("select-load"));
  const load = app.page.locator('div[role="dialog"][aria-label="Load selection"]');
  await load.waitFor();
  await load.getByRole("button", { name: "Intersect", exact: true }).click();
  await load.getByRole("button", { name: "Load", exact: true }).click();
  await app.settle();
  await app.run("mask-from-sel");
  const c = await app.exported();
  // Soft, and roughly half the band's soft pixels (the other half was cut away).
  expect(c.partial, `${c.partial} partial px`).toBeGreaterThan(SOFT);
  expect(c.partial).toBeLessThan(211_264 * 0.75);
});
