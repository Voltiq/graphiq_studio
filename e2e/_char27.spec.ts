/**
 * TEMPORARY characterization for TODO 1.6, the selection slice. Records, after
 * each step, the selection itself (made into a mask and read off the
 * composite: its hash, its soft pixels, its weight), the status bar, the
 * history's last rows and any toast — through hard and soft selections,
 * Feather, Modify (border, smooth, expand, contract) and Grow on each, Inverse,
 * Refine Edge, rotate / nudge / resize by numbers, a faint selection, an
 * elliptical marquee, the lasso, the magic wand (re-run, add, subtract, sample
 * all), quick select (add, subtract), fills, strokes and deletes inside a
 * rotated and a soft selection, and a soft selection saved and opened back.
 * Run: CHAR_OUT=<dir>/<before|after> npx playwright test e2e/_char27.spec.ts
 */
import { writeFileSync } from "node:fs";
import { test, type App } from "./fixtures";

const OUT = process.env.CHAR_OUT;
test.skip(!OUT, "characterization only: set CHAR_OUT");
test.use({ actionTimeout: 10_000 });

const save = (name: string, data: unknown) => writeFileSync(`${OUT}.${name}.json`, JSON.stringify(data, null, 1));
const RECT = { x: 600, y: 300, w: 600, h: 400 };

const state = async (app: App, measure: boolean) => {
  const page = app.page;
  const base = await page.evaluate(async () => {
    const blob = await window.graphiq!.exportPNG(1);
    const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob!.arrayBuffer()));
    return {
      status: document.querySelector('footer[data-tour="status"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      toast: document.querySelector('[role="status"]')?.textContent?.trim() ?? null,
      pixels: [...buf].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join(""),
    };
  });
  let selection: unknown = null;
  if (measure && (await page.evaluate(() => window.graphiq!.commands().includes("mask-from-sel")))) {
    // The selection, as a mask on the layer, read off the composite — then undone.
    const ran = await page.evaluate(() => window.graphiq!.run("mask-from-sel"));
    if (ran) {
      await app.settle(300);
      selection = await app.exported();
      await page.evaluate(() => window.graphiq!.run("undo"));
      await app.settle(300);
    } else selection = "none";
  }
  return { ...base, selection, history: (await app.historyRows()).slice(-3) };
};

const recorder = (app: App, log: unknown[]) => async (name: string, fn: () => Promise<unknown>, measure = true) => {
  console.log(`step: ${name}`);
  await fn();
  await app.settle(500);
  log.push([name, await state(app, measure)]);
};

/** Select ▸ <op>… with its slider at `px`. */
async function modify(app: App, action: string, label: string, px: number, button: string) {
  await app.page.evaluate((a) => window.graphiq!.run(a), action);
  const dlg = app.page.locator('div[role="dialog"][aria-modal="true"]').last();
  await dlg.waitFor();
  await app.setRange(label, px);
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
};

test("char27 selection: soft and hard, the operations, by numbers, used by fills and strokes", async ({ app }) => {
  test.setTimeout(500_000);
  const log: unknown[] = [];
  const step = recorder(app, log);
  await app.openPanelById("history");
  await app.setForeground("#3aa0ff");
  await app.run("fill-solid");
  await app.run("layer-flatten");
  await step("a hard rect", () => select(app, RECT));
  await step("feathered", () => modify(app, "select-feather", "Radius", 20, "Feather"));
  await step("expanded, soft", () => modify(app, "select-expand", "Expand by", 12, "Expand"));
  await step("contracted, soft", () => modify(app, "select-contract", "Contract by", 12, "Contract"));
  await step("grown, soft", () => modify(app, "select-grow", "Expand by", 10, "Grow"));
  await step("inverse of a soft one", () => app.run("select-inverse"));
  await step("inverse again", () => app.run("select-inverse"));
  await step("a hard rect again", () => select(app, RECT));
  await step("border", () => modify(app, "select-border", "Width", 10, "Border"));
  await step("a hard rect, for smooth", () => select(app, { x: 300, y: 200, w: 500, h: 300 }));
  await step("smooth", () => modify(app, "select-smooth", "Radius", 8, "Smooth"));
  await step("expanded, hard", () => modify(app, "select-expand", "Expand by", 6, "Expand"));
  await step("contracted, hard", () => modify(app, "select-contract", "Contract by", 6, "Contract"));
  await step("grown, hard", () => modify(app, "select-grow", "Expand by", 10, "Grow"));
  await step("rotated by numbers", () => byNumbers(app, "Angle", "30"));
  await step("nudged", () => app.key("Control+ArrowRight"));
  await step("feathered while turned", () => modify(app, "select-feather", "Radius", 15, "Feather"));
  await step("a hard rect, then refined", async () => {
    await select(app, RECT);
    await app.page.evaluate(() => window.graphiq!.run("select-refine"));
    const dlg = app.page.locator('div[role="dialog"][aria-label="Refine edge"]');
    await dlg.waitFor();
    await app.setRange("Feather", 15);
    await app.setRange("Shift", 20);
    await dlg.getByRole("button", { name: /^(Apply|OK)$/ }).first().click();
  });
  await step("resized by numbers", () => byNumbers(app, "W", String(RECT.w * 1.5)));
  await step("a faint one", async () => {
    await select(app, { x: 900, y: 500, w: 24, h: 24 });
    await modify(app, "select-feather", "Radius", 30, "Feather");
  });
  await step("select all", () => app.run("select-all"));
  await step("deselect", () => app.run("select-deselect"));
  await step("reselect", () => app.run("select-reselect"));
  // Fills, strokes and deletes inside a turned and a soft selection.
  await step("a layer", () => app.run("layer-new"), false);
  await step("a turned rect", async () => {
    await select(app, { x: 200, y: 150, w: 700, h: 300 });
    await byNumbers(app, "Angle", "20");
  });
  await step("filled in it", async () => {
    await app.setForeground("#e0402a");
    await app.key("Backspace");
  });
  await step("a soft rect", async () => {
    await select(app, { x: 1000, y: 400, w: 600, h: 400 });
    await modify(app, "select-feather", "Radius", 25, "Feather");
  });
  await step("a stroke through it", async () => {
    await app.brush(120, 100);
    await app.setForeground("#20a050");
    await app.drag(0.55, 0.4, 0.95);
  });
  await step("deleted in it", () => app.key("Delete"));
  await step("deselected", () => app.run("select-deselect"));
  save("ops", log);
});

test("char27 selection: the tools — ellipse, lasso, wand, quick select", async ({ app }) => {
  test.setTimeout(400_000);
  const { page } = app;
  const log: unknown[] = [];
  const step = recorder(app, log);
  await app.openPanelById("history");
  // Something to select: bands of colour on a layer.
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
  const b = await app.canvasBox();
  const at = (fx: number, fy: number) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });
  await step("the ellipse marquee", async () => {
    await app.pickTool("Rectangular marquee");
    await page.getByRole("button", { name: "Elliptical marquee" }).first().click();
    const p = at(0.3, 0.3);
    const q = at(0.6, 0.7);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(q.x, q.y, { steps: 12 });
    await page.mouse.up();
  });
  await step("the lasso", async () => {
    await app.pickTool("Lasso");
    const pts = [at(0.2, 0.2), at(0.5, 0.15), at(0.7, 0.4), at(0.5, 0.8), at(0.25, 0.6), at(0.2, 0.2)];
    await page.mouse.move(pts[0].x, pts[0].y);
    await page.mouse.down();
    for (const p of pts.slice(1)) await page.mouse.move(p.x, p.y, { steps: 8 });
    await page.mouse.up();
  });
  await step("the wand on red", async () => {
    await app.pickTool("Magic wand");
    const p = at(0.5, 0.25);
    await page.mouse.click(p.x, p.y);
  });
  await step("its tolerance re-run", () => app.setRange("Tolerance", 90));
  await step("the wand adds blue", async () => {
    await app.setRange("Tolerance", 32);
    const p = at(0.5, 0.5);
    await page.keyboard.down("Control");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Control");
  });
  await step("and takes red away", async () => {
    const p = at(0.5, 0.25);
    await page.keyboard.down("Alt");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Alt");
  });
  await step("the wand, not contiguous", async () => {
    await page.getByText("Contiguous", { exact: true }).first().click();
    const p = at(0.05, 0.05);
    await page.mouse.click(p.x, p.y);
  });
  await step("the wand on all layers", async () => {
    await page.getByText("Sample all layers", { exact: true }).first().click();
    const p = at(0.5, 0.75);
    await page.mouse.click(p.x, p.y);
  });
  await step("quick select", async () => {
    await app.run("select-deselect");
    await app.pickTool("Quick selection");
    const p = at(0.3, 0.5);
    const q = at(0.6, 0.5);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(q.x, q.y, { steps: 15 });
    await page.mouse.up();
  });
  await step("quick select takes some away", async () => {
    const p = at(0.45, 0.5);
    const q = at(0.55, 0.5);
    await page.keyboard.down("Alt");
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(q.x, q.y, { steps: 8 });
    await page.mouse.up();
    await page.keyboard.up("Alt");
  });
  await step("undo", () => app.key("Control+z"));
  await step("redo", () => app.key("Control+Shift+z"));
  save("tools", log);
});

test.describe("saved with the project", () => {
  test.use({ filePickers: false });

  test("char27 selection: a soft selection saved and opened back", async ({ app }, info) => {
    test.setTimeout(200_000);
    const log: unknown[] = [];
    const step = recorder(app, log);
    await app.setForeground("#3aa0ff");
    await app.run("fill-solid");
    await app.run("layer-flatten");
    await step("a soft selection", async () => {
      await select(app, RECT);
      await modify(app, "select-feather", "Radius", 20, "Feather");
    });
    const path = info.outputPath("soft.gproj");
    await step("saved", async () => {
      const dl = app.page.waitForEvent("download", { timeout: 20_000 });
      await app.run("save");
      await (await dl).saveAs(path);
    }, false);
    await step("opened back", async () => {
      await app.page.locator('input[type="file"][accept*="gproj"]').setInputFiles(path);
      await app.settle(2_000);
    });
    save("project", log);
  });
});
