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

/* TODO 1.3: every operation that makes a selection from another works on its
   coverage, so the rest of 0.2a's list keeps a soft selection soft too. */

const RECT = { x: 600, y: 300, w: 600, h: 400 };

/** Select ▸ <op>… with its slider at `px`. */
async function modify(app: App, action: string, label: string, px: number, button: string) {
  await app.page.evaluate((a) => window.graphiq!.run(a), action);
  const dlg = app.page.locator('div[role="dialog"][aria-modal="true"]').last();
  await dlg.waitFor();
  expect(await app.setRange(label, px), `${action}: its slider`).toBe(true);
  await dlg.getByRole("button", { name: button, exact: true }).click();
  await app.settle();
}

/** A hard rect, feathered — the soft selection most of these start from. */
async function feathered(app: App, px = 20) {
  await app.page.evaluate((r) => window.graphiq!.select([r]), RECT);
  await app.settle();
  await modify(app, "select-feather", "Radius", px, "Feather");
}

/** The selection as a layer mask, measured, then taken back off. */
async function measure(app: App) {
  await app.run("mask-from-sel");
  const c = await app.exported();
  await app.run("undo");
  return c;
}

test("I  Select ▸ Feather is a real operation: a soft selection, and one undo step", async ({ app }) => {
  await opaqueLayer(app);
  await feathered(app);
  const soft = await measure(app);
  expect(soft.partial, "the feather is in the selection itself").toBeGreaterThan(SOFT);
  await app.run("undo"); // the feather
  const hard = await measure(app);
  expect(hard.partial, "and undo takes it back to the hard rect").toBe(0);
});

test("J  a feather that would leave nothing selected is refused, and says so", async ({ app }) => {
  await opaqueLayer(app);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 400, y: 400, w: 4, h: 4 }]));
  await app.settle();
  // 16 pixels spread over a 60 px blur round to nothing at all.
  await modify(app, "select-feather", "Radius", 120, "Feather");
  await expect(app.page.getByText(/Nothing would be left selected/)).toBeVisible();
  const c = await measure(app);
  expect([c.partial, c.levels], "the selection is untouched: still the hard 4×4").toEqual([0, 2]);
});

test("K  Expand and Contract move a soft edge without hardening it", async ({ app }) => {
  await opaqueLayer(app);
  await feathered(app);
  const base = await measure(app);
  await modify(app, "select-expand", "Expand by", 12, "Expand");
  const out = await measure(app);
  expect(out.partial, "expanded, still soft").toBeGreaterThan(SOFT);
  expect(out.alphaSum, "...and more is selected").toBeGreaterThan(base.alphaSum);
  await app.run("undo");
  await modify(app, "select-contract", "Contract by", 12, "Contract");
  const inn = await measure(app);
  expect(inn.partial, "contracted, still soft").toBeGreaterThan(SOFT);
  expect(inn.alphaSum, "...and less is selected").toBeLessThan(base.alphaSum);
});

test("L  Grow keeps a soft selection soft", async ({ app }) => {
  await opaqueLayer(app);
  await feathered(app);
  const base = await measure(app);
  await modify(app, "select-grow", "Expand by", 10, "Grow");
  const grown = await measure(app);
  expect(grown.partial).toBeGreaterThan(SOFT);
  expect(grown.alphaSum).toBeGreaterThan(base.alphaSum);
});

test("M  Ctrl-dragging a marquee adds to a soft selection, keeping its soft edge", async ({ app }) => {
  await opaqueLayer(app);
  await feathered(app);
  const base = await measure(app);
  await app.key("m");
  const b = await app.canvasBox();
  await app.page.keyboard.down("Control");
  await app.page.mouse.move(b.x + b.width * 0.05, b.y + b.height * 0.05);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.2, { steps: 6 });
  await app.page.mouse.up();
  await app.page.keyboard.up("Control");
  await app.settle();
  const both = await measure(app);
  expect(both.partial, "the feathered part is still soft").toBeGreaterThan(SOFT);
  expect(both.alphaSum, "...and the new rect was added").toBeGreaterThan(base.alphaSum);
});

test("N  nudging the outline moves a soft selection, soft and whole", async ({ app }) => {
  await opaqueLayer(app);
  await feathered(app);
  const base = await measure(app);
  await app.key("m");
  for (let i = 0; i < 5; i++) await app.key("ArrowRight");
  await app.settle();
  const moved = await measure(app);
  expect(moved.partial).toBeGreaterThan(SOFT);
  expect(moved.alphaSum, "the same coverage, five pixels over").toBe(base.alphaSum);
  expect(moved.hash, "...and really moved").not.toBe(base.hash);
});

test("O  Refine Edge is baked into the selection, and undoable", async ({ app }) => {
  await opaqueLayer(app);
  await app.page.evaluate((r) => window.graphiq!.select([r]), RECT);
  await app.settle();
  await app.page.evaluate(() => window.graphiq!.run("select-refine"));
  const dlg = app.page.locator('div[role="dialog"][aria-label="Refine edge"]');
  await dlg.waitFor();
  await app.setRange("Feather", 15);
  await dlg.getByRole("button", { name: /^(Apply|OK)$/ }).first().click();
  await app.settle();
  expect((await measure(app)).partial, "refined: soft").toBeGreaterThan(SOFT);
  await app.run("undo");
  expect((await measure(app)).partial, "undone: the hard rect again").toBe(0);
});

test("P  resizing a soft selection by numbers keeps it soft", async ({ app }) => {
  await opaqueLayer(app);
  await feathered(app);
  const base = await measure(app);
  await app.key("m");
  const w = app.page.getByRole("textbox", { name: "W" }).first();
  await w.fill(String(RECT.w * 1.5));
  await w.press("Enter");
  await app.settle();
  const wide = await measure(app);
  expect(wide.partial, "still soft").toBeGreaterThan(SOFT);
  expect(wide.alphaSum, "and wider").toBeGreaterThan(base.alphaSum);
});

test.describe("saved with the project", () => {
  test.use({ filePickers: false });

  test("Q  a soft selection survives saving and reopening the .gproj", async ({ app }, info) => {
    const { page } = app;
    await opaqueLayer(app);
    await feathered(app);
    const before = await measure(app);
    const saved = page.waitForEvent("download", { timeout: 20_000 });
    await app.menu("File", "Save");
    const file = info.outputPath("soft.gproj");
    await (await saved).saveAs(file);
    await page.setInputFiles('input[accept*=".gproj"]', file);
    await app.settle(3_000);
    expect((await app.docs()).length, "it opened as a second tab").toBe(2);
    const after = await measure(app);
    expect(after.partial, "the reopened selection is soft").toBeGreaterThan(SOFT);
    expect(after.alphaSum, "...and the same coverage").toBe(before.alphaSum);
  });
});

test("R  dragging a resize handle keeps a soft selection soft", async ({ app }) => {
  await opaqueLayer(app);
  await feathered(app);
  const base = await measure(app);
  await app.key("m");
  const b = await app.canvasBox();
  const sx = b.width / 1920;
  const sy = b.height / 1080;
  // The bottom-right corner handle of the selection's box, dragged outward.
  const cx = b.x + (RECT.x + RECT.w) * sx;
  const cy = b.y + (RECT.y + RECT.h) * sy;
  await app.page.mouse.move(cx, cy);
  await app.page.mouse.down();
  await app.page.mouse.move(cx + 120 * sx, cy + 80 * sy, { steps: 8 });
  await app.page.mouse.up();
  await app.settle();
  const big = await measure(app);
  expect(big.partial, "resized, still soft").toBeGreaterThan(SOFT);
  expect(big.alphaSum, "...and bigger").toBeGreaterThan(base.alphaSum);
});

/* The ants mark the 50% line; a feathered selection also shows how far its
   soft edge reaches, as two faint lines either side. That extent now comes
   from the selection's own mask (it is what knows it was feathered). */
test("S  a feathered selection shows its soft extent around the ants", async ({ app }) => {
  await feathered(app, 20);
  await app.key("m");
  await app.settle(600);
  const b = await app.canvasBox();
  const sx = b.width / 1920;
  const midY = b.y + (RECT.y + RECT.h / 2) * (b.height / 1080);
  const from = b.x + (RECT.x + RECT.w / 2) * sx; // the selection's middle…
  const to = b.x + (RECT.x + RECT.w + 80) * sx; // …to well past its right edge
  const lines = await app.page.evaluate(
    ({ y, x0, x1 }) => {
      const ov = [...document.querySelectorAll("canvas")].filter((c) => /overlay/i.test(c.className));
      let best = 0;
      for (const c of ov) {
        const r = c.getBoundingClientRect();
        const k = c.width / r.width;
        const py = Math.round((y - r.top) * k);
        if (py < 0 || py >= c.height) continue;
        const row = c.getContext("2d")!.getImageData(0, py, c.width, 1).data;
        let n = 0;
        let inInk = false;
        for (let x = Math.round((x0 - r.left) * k); x < Math.round((x1 - r.left) * k); x++) {
          const ink = row[x * 4 + 3] > 0;
          if (ink && !inInk) n++;
          inInk = ink;
        }
        best = Math.max(best, n);
      }
      return best;
    },
    { y: midY, x0: from, x1: to },
  );
  expect(lines, "the ants, plus the inner and outer edge of the soft band").toBeGreaterThanOrEqual(3);
});

/* Rotating never dropped the coverage: the angle rides beside the outline and
   the mask is rotated where it is used. Checked rather than assumed. */
test("T  rotating a soft selection by numbers keeps it soft", async ({ app }) => {
  await opaqueLayer(app);
  await feathered(app);
  const base = await measure(app);
  await app.key("m");
  const angle = app.page.getByRole("textbox", { name: "Angle" }).first();
  await angle.fill("30");
  await angle.press("Enter");
  await app.settle();
  const turned = await measure(app);
  expect(turned.partial, "rotated, still soft").toBeGreaterThan(SOFT);
  expect(turned.hash, "...and really rotated").not.toBe(base.hash);
});

/* TODO 1.3 slice 2: a FAINT selection — under 50% everywhere — still selects.
   Its outline marks half its peak strength, so it can be seen and grabbed. */
test("U  a small selection feathered hard is faint, but still selects", async ({ app }) => {
  await opaqueLayer(app);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 900, y: 500, w: 24, h: 24 }]));
  await app.settle();
  await modify(app, "select-feather", "Radius", 30, "Feather");
  await expect(app.page.getByText(/No pixels are more than 50% selected/)).toBeVisible();
  const c = await measure(app);
  expect(c.partial, "it selects, softly").toBeGreaterThan(SOFT);
  expect(c.alphaSum / c.partial, "...and nowhere as much as half").toBeLessThan(128);
});

/* A rotated outline moved by the arrow keys used to bypass history: Ctrl+Z then
   undid the step BEFORE it (here, the rotation) and lost the nudge. */
test("V  nudging a rotated selection is its own undo step", async ({ app }) => {
  await opaqueLayer(app);
  await app.page.evaluate((r) => window.graphiq!.select([r]), RECT);
  await app.settle();
  await app.key("m");
  const angle = app.page.getByRole("textbox", { name: "Angle" }).first();
  await angle.fill("30");
  await angle.press("Enter");
  await app.settle();
  const rotated = await measure(app);
  await app.key("Control+ArrowRight"); // one nudge, 10 px — each press is its own step
  await app.settle();
  const nudged = await measure(app);
  expect(nudged.hash, "the nudge moved it").not.toBe(rotated.hash);
  // Still rotated: a turned rect's mask has anti-aliased edges, an upright one none.
  expect(nudged.partial, "...and kept its rotation").toBeGreaterThan(0);
  await app.run("undo");
  const undone = await measure(app);
  expect(undone.hash, "undo takes back the nudge — and only the nudge").toBe(rotated.hash);
});
