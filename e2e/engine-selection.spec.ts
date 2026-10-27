/**
 * The engine's selection (TODO 1.6, app/lib/engine/selection.ts), as the
 * engine wires it: the magic wand selects like colour — on the layer or on
 * every layer — re-runs on its cached source, adds and takes away; the lasso
 * selects its polygon; quick select grows through like colour and takes away;
 * Modify works on a hard selection; a soft selection stays soft through every
 * operation; fills, strokes and deletes stay inside a turned or a soft
 * selection; a soft selection saved with the project comes back soft.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The selection's box, as the status bar gives it ("W × H(x, y)"), or null. */
const selBox = (app: App) =>
  app.page.evaluate(() => {
    const t = document.querySelector('footer[data-tour="status"]')?.textContent ?? "";
    const m = /(\d+) × (\d+)\((\d+), (\d+)\)/.exec(t);
    return m ? { w: +m[1], h: +m[2], x: +m[3], y: +m[4] } : null;
  });
/** The selection made into a mask and read off the composite, then undone. */
const measure = async (app: App) => {
  await app.run("mask-from-sel");
  const c = await app.exported();
  await app.run("undo");
  return c;
};
const rgba = (app: App, x: number, y: number) =>
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
async function modify(app: App, action: string, label: string, px: number, button: string) {
  await app.page.evaluate((a) => window.graphiq!.run(a), action);
  const dlg = app.page.locator('div[role="dialog"][aria-modal="true"]').last();
  await dlg.waitFor();
  expect(await app.setRange(label, px), `${action}: its slider`).toBe(true);
  await dlg.getByRole("button", { name: button, exact: true }).click();
  await app.settle();
}
const select = (app: App, r: { x: number; y: number; w: number; h: number }) =>
  app.page.evaluate((r) => window.graphiq!.select([r]), r);
const byNumbers = async (app: App, field: "W" | "Angle", value: string) => {
  await app.key("m");
  const f = app.page.getByRole("textbox", { name: field }).first();
  await f.fill(value);
  await f.press("Enter");
  await app.settle();
};
const opaque = async (app: App) => {
  await app.setForeground("#3aa0ff");
  await app.run("fill-solid");
  await app.run("layer-flatten");
};
/** Three bands across the canvas — red, blue, green — on a layer of their own. */
const bands = async (app: App) => {
  await app.run("layer-new");
  await app.brush(160, 100);
  for (const [hex, fy] of [
    ["#d02020", 0.25],
    ["#2040d0", 0.5],
    ["#20a040", 0.75],
  ] as const) {
    await app.setForeground(hex);
    await app.drag(fy, 0.1, 0.9);
  }
};
const RECT = { x: 600, y: 300, w: 600, h: 400 };
/** How much the overlay draws — the ants and a soft selection's reach. */
const overlayInk = (app: App) =>
  app.page.evaluate(() => {
    let n = 0;
    for (const c of [...document.querySelectorAll("canvas")].filter((x) => /overlay/i.test(x.className))) {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    }
    return n;
  });

test("the magic wand: like colour, on the layer or every layer, re-run, added to and taken from", async ({ app }) => {
  const { page } = app;
  await bands(app);
  await app.pickTool("Magic wand");
  const b = await app.canvasBox();
  const click = async (fx: number, fy: number, mod?: string) => {
    if (mod) await page.keyboard.down(mod);
    await page.mouse.click(b.x + b.width * fx, b.y + b.height * fy);
    if (mod) await page.keyboard.up(mod);
    await app.settle(400);
  };
  await click(0.5, 0.25);
  const red = (await selBox(app))!;
  expect(red.h, "one band").toBeLessThan(200);
  await click(0.5, 0.5, "Control");
  const two = (await selBox(app))!;
  expect([two.y, two.h > red.h * 2], "the blue band added").toEqual([red.y, true]);
  await click(0.5, 0.25, "Alt");
  expect((await selBox(app))!.y, "the red one taken away").toBeGreaterThan(red.y + red.h - 1);
  await click(0.5, 0.25);
  expect(await app.setRange("Tolerance", 255), "Tolerance").toBe(true);
  await app.settle(500);
  expect(await selBox(app), "re-run at full tolerance: everything").toEqual({ w: 1920, h: 1080, x: 0, y: 0 });
  await app.setRange("Tolerance", 32);
  await page.getByText("Sample all layers", { exact: true }).first().click();
  await app.run("layer-new"); // an empty layer in front: only "all layers" sees the bands
  await click(0.5, 0.75);
  const green = (await selBox(app))!;
  expect([green.h, green.y > two.y + two.h - 1], "the green band, through the empty layer").toEqual([red.h, true]);
});

test("the lasso selects its polygon; quick select grows through like colour, and takes away", async ({ app }) => {
  const { page } = app;
  await bands(app);
  const b = await app.canvasBox();
  const at = (fx: number, fy: number) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });
  await app.pickTool("Lasso");
  const pts = [at(0.2, 0.2), at(0.6, 0.2), at(0.6, 0.6), at(0.2, 0.6), at(0.2, 0.2)];
  await page.mouse.move(pts[0].x, pts[0].y);
  await page.mouse.down();
  for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 });
  await page.mouse.up();
  await app.settle(400);
  const lasso = (await selBox(app))!;
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  expect([near(lasso.w, 768), near(lasso.h, 432)], `the polygon's box: ${JSON.stringify(lasso)}`).toEqual([true, true]);
  await app.run("select-deselect");
  await app.pickTool("Quick selection");
  const drag = async (fx0: number, fx1: number, alt = false) => {
    const p = at(fx0, 0.5);
    const q = at(fx1, 0.5);
    if (alt) await page.keyboard.down("Alt");
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(q.x, q.y, { steps: 10 });
    await page.mouse.up();
    if (alt) await page.keyboard.up("Alt");
    await app.settle(400);
  };
  await drag(0.4, 0.6);
  const grown = (await selBox(app))!;
  expect(grown.w, "the whole blue band, past the brush").toBeGreaterThan(1500);
  await drag(0.4, 0.6, true);
  expect(await selBox(app), "taken away").toBeNull();
});

test("Modify on a hard selection: border, smooth, expand, contract", async ({ app }) => {
  await opaque(app);
  await select(app, RECT);
  await modify(app, "select-border", "Width", 10, "Border");
  expect(await selBox(app)).toEqual({ w: 610, h: 410, x: 595, y: 295 });
  await select(app, RECT);
  await modify(app, "select-expand", "Expand by", 6, "Expand");
  expect(await selBox(app)).toEqual({ w: 612, h: 412, x: 594, y: 294 });
  await modify(app, "select-contract", "Contract by", 6, "Contract");
  expect(await selBox(app), "the round kernel took the corners").toEqual({ w: 602, h: 402, x: 599, y: 299 });
  expect((await measure(app)).partial, "hard throughout").toBe(0);
});

test("a soft selection stays soft through feather, grow, expand, contract, a nudge, a resize and a turn", async ({
  app,
}) => {
  await opaque(app);
  await select(app, RECT);
  await modify(app, "select-feather", "Radius", 20, "Feather");
  const soft = await measure(app);
  expect(soft.partial).toBeGreaterThan(5000);
  const steps: [string, () => Promise<unknown>][] = [
    ["grow", () => modify(app, "select-grow", "Expand by", 10, "Grow")],
    ["expand", () => modify(app, "select-expand", "Expand by", 12, "Expand")],
    ["contract", () => modify(app, "select-contract", "Contract by", 12, "Contract")],
    ["inverse", () => app.run("select-inverse")],
    ["inverse back", () => app.run("select-inverse")],
    ["nudge", async () => (await app.key("m"), await app.key("Control+ArrowRight"))],
    ["resize", () => byNumbers(app, "W", "900")],
    ["turn", () => byNumbers(app, "Angle", "30")],
  ];
  let last = soft.hash;
  for (const [name, fn] of steps) {
    await fn();
    const m = await measure(app);
    expect([m.partial > 5000, m.hash !== last], `${name}: soft, and changed`).toEqual([true, true]);
    last = m.hash;
  }
  await select(app, RECT);
  await app.pickTool("Move"); // the marquee's own Feather would answer to the dialog's name
  await app.page.evaluate(() => window.graphiq!.run("select-refine"));
  const dlg = app.page.locator('div[role="dialog"][aria-label="Refine edge"]');
  await dlg.waitFor();
  await app.setRange("Feather", 15);
  await dlg.getByRole("button", { name: /^(Apply|OK)$/ }).first().click();
  await app.settle();
  expect((await measure(app)).partial, "refined: soft").toBeGreaterThan(5000);
});

test("a fill, a stroke and a delete stay inside a turned or a soft selection", async ({ app }) => {
  await app.run("layer-new");
  await select(app, { x: 200, y: 150, w: 700, h: 300 });
  await byNumbers(app, "Angle", "20");
  await app.setForeground("#e0402a");
  await app.key("Backspace");
  expect(await rgba(app, 550, 300), "inside the turned rect").toEqual([224, 64, 42, 255]);
  expect((await rgba(app, 210, 160))[3], "its corner, turned away").toBe(0);
  expect(await rgba(app, 915, 300), "inside it, past its upright box").toEqual([224, 64, 42, 255]);
  await app.key("Control+z");
  expect((await rgba(app, 915, 300))[3], "and undone there too").toBe(0);
  await app.key("Control+Shift+z");
  await select(app, { x: 1000, y: 400, w: 600, h: 400 });
  await modify(app, "select-feather", "Radius", 25, "Feather");
  await app.brush(120, 100);
  await app.setForeground("#20a050");
  await app.drag(0.55, 0.4, 0.95);
  const edge = await rgba(app, 1000, 590);
  expect([edge[3] > 0, edge[3] < 255], `the hard brush, soft at the edge: ${edge}`).toEqual([true, true]);
  expect((await rgba(app, 900, 590))[3], "nothing outside").toBe(0);
  await app.key("Delete");
  expect((await rgba(app, 1300, 600))[3], "deleted inside").toBe(0);
});

test("what the canvas shows of a selection: its ants, a soft one's reach, a faint one's warning", async ({ app }) => {
  await opaque(app);
  await select(app, RECT);
  await app.settle(400);
  const hard = await overlayInk(app);
  expect(hard, "the ants").toBeGreaterThan(500);
  await modify(app, "select-feather", "Radius", 20, "Feather");
  await app.settle(400);
  expect(await overlayInk(app), "and the soft band's inner and outer edge").toBeGreaterThan(hard * 2);
  await select(app, { x: 900, y: 500, w: 24, h: 24 });
  await modify(app, "select-feather", "Radius", 30, "Feather");
  await expect(app.page.getByText(/No pixels are more than 50% selected/).first()).toBeVisible();
});

test("Refine Edge previews the selection as it is, turned when it is", async ({ app }) => {
  await opaque(app);
  const preview = async () => {
    await app.pickTool("Move");
    await app.page.evaluate(() => window.graphiq!.run("select-refine"));
    const dlg = app.page.locator('div[role="dialog"][aria-label="Refine edge"]');
    await dlg.waitFor();
    await app.settle(800);
    const hash = await dlg.evaluate((d) => {
      let h = 0x811c9dc5;
      for (const c of d.querySelectorAll("canvas")) {
        const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
        for (let i = 0; i < data.length; i += 16) h = Math.imul(h ^ data[i], 0x01000193);
      }
      return h >>> 0;
    });
    await app.page.keyboard.press("Escape");
    await app.settle(300);
    return hash;
  };
  await select(app, RECT);
  const upright = await preview();
  await byNumbers(app, "Angle", "30");
  expect(await preview(), "turned").not.toBe(upright);
});

test("quick select's brush: on a smooth gradient at the lowest tolerance, it selects the brush's width", async ({
  app,
}) => {
  const { page } = app;
  await app.run("layer-new");
  await app.setForeground("#000000");
  await app.pickTool("Gradient");
  await app.drag(0.5, 0.02, 0.98);
  await app.pickTool("Quick selection");
  expect(await app.setRange("Size", 160), "a Size").toBe(true);
  expect(await app.setRange("Tolerance", 1), "a Tolerance").toBe(true);
  const b = await app.canvasBox();
  const p = { x: b.x + b.width * 0.5, y: b.y + b.height * 0.5 };
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 2, p.y, { steps: 2 });
  await page.mouse.up();
  await app.settle(400);
  const box = (await selBox(app))!;
  expect([box.w > 120, box.w < 400], `the brush's width, not the band's: ${JSON.stringify(box)}`).toEqual([true, true]);
});

test("a soft selection that reaches everywhere comes out of Quick Mask still soft", async ({ app }) => {
  await opaque(app);
  await app.run("select-quickmask"); // nothing selected: all of it, to start
  await app.brush(300, 100);
  expect(await app.setRange("Opacity", 30), "an Opacity").toBe(true);
  await app.setForeground("#000000");
  await app.drag(0.5, 0.2, 0.8); // masks a little, nowhere under half
  await app.run("select-quickmask");
  expect(await selBox(app), "all of it, still selected").toEqual({ w: 1920, h: 1080, x: 0, y: 0 });
  expect((await measure(app)).partial, "softly").toBeGreaterThan(5000);
});

test.describe("saved with the project", () => {
  test.use({ filePickers: false });

  test("a soft selection comes back soft", async ({ app }, info) => {
    await opaque(app);
    await select(app, RECT);
    await modify(app, "select-feather", "Radius", 20, "Feather");
    const before = await measure(app);
    const path = info.outputPath("soft.gproj");
    const dl = app.page.waitForEvent("download", { timeout: 20_000 });
    await app.run("save");
    await (await dl).saveAs(path);
    await app.page.locator('input[type="file"][accept*="gproj"]').setInputFiles(path);
    await app.settle(2_000);
    const after = await measure(app);
    expect([after.partial, after.hash]).toEqual([before.partial, before.hash]);
  });
});
