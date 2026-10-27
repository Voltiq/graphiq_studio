/**
 * TEMPORARY characterization for TODO 1.6, the stroke slice. Records, after
 * each step, the composite (hash and census) and the history's last rows —
 * through hard and soft brushes, flow and opacity, smoothing, the eraser,
 * strokes inside a hard, a turned and a soft selection, on a mask, on a
 * transparency-locked layer, undo and redo; a brush with texture, dual tip,
 * shape, scatter and pressure dynamics (Math.random seeded before each step);
 * the clone stamp, aligned and not.
 * Run: CHAR_OUT=<dir>/<before|after> npx playwright test e2e/_char29.spec.ts
 */
import { writeFileSync } from "node:fs";
import { test, type App } from "./fixtures";

const OUT = process.env.CHAR_OUT;
test.skip(!OUT, "characterization only: set CHAR_OUT");
test.use({ actionTimeout: 10_000 });

const save = (name: string, data: unknown) => writeFileSync(`${OUT}.${name}.json`, JSON.stringify(data, null, 1));

const state = async (app: App) => {
  const pixels = await app.page.evaluate(async () => {
    const blob = await window.graphiq!.exportPNG(1);
    const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob!.arrayBuffer()));
    return [...buf].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
  });
  return { pixels, census: await app.exported(), history: (await app.historyRows()).slice(-2) };
};

const recorder = (app: App, log: unknown[]) => async (name: string, fn: () => Promise<unknown>) => {
  console.log(`step: ${name}`);
  await app.page.evaluate(() => {
    let s = 20261027;
    Math.random = () => (s = (Math.imul(s, 1103515245) + 12345) >>> 0) / 4294967296;
  });
  await fn();
  await app.settle(500);
  log.push([name, await state(app)]);
};

const select = (app: App, r: { x: number; y: number; w: number; h: number }) =>
  app.page.evaluate((r) => window.graphiq!.select([r]), r);

test("char29 strokes: brushes, the eraser, through selections, on a mask, locked, undone", async ({ app }) => {
  test.setTimeout(400_000);
  const { page } = app;
  const log: unknown[] = [];
  const step = recorder(app, log);
  await app.openPanelById("history");
  await app.openPanelById("layers");
  await step("a layer", () => app.run("layer-new"));
  await step("hard", async () => {
    await app.brush(40, 100);
    await app.setForeground("#d02020");
    await app.drag(0.2);
  });
  await step("soft", async () => {
    await app.brush(80, 0);
    await app.setForeground("#2040d0");
    await app.drag(0.35);
  });
  await step("flow and opacity", async () => {
    await app.setRange("Flow", 30);
    await app.setRange("Opacity", 60);
    await app.setForeground("#20a040");
    await app.drag(0.5);
    await app.setRange("Flow", 100);
    await app.setRange("Opacity", 100);
  });
  await step("smoothed zigzag", async () => {
    await app.setRange("Smoothing", 90);
    const b = await app.canvasBox();
    await page.mouse.move(b.x + b.width * 0.1, b.y + b.height * 0.6);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(b.x + b.width * (0.1 + i * 0.1), b.y + b.height * (i % 2 ? 0.55 : 0.65), { steps: 6 });
    await page.mouse.up();
    await app.setRange("Smoothing", 20);
  });
  await step("the eraser", async () => {
    await app.pickTool("Eraser");
    await app.setRange("Size", 60);
    await app.drag(0.35, 0.3, 0.7);
  });
  await step("in a hard selection", async () => {
    await select(app, { x: 600, y: 650, w: 500, h: 100 });
    await app.brush(80, 100);
    await app.setForeground("#c08000");
    await app.drag(0.65, 0.1, 0.9);
    await app.run("select-deselect");
  });
  await step("in a turned selection", async () => {
    await select(app, { x: 500, y: 760, w: 800, h: 80 });
    await app.key("m");
    const f = page.getByRole("textbox", { name: "Angle" }).first();
    await f.fill("25");
    await f.press("Enter");
    await app.brush(120, 100);
    await app.setForeground("#8000c0");
    await app.drag(0.75, 0.1, 0.9);
    await app.run("select-deselect");
  });
  await step("in a soft selection", async () => {
    await select(app, { x: 400, y: 880, w: 1100, h: 120 });
    await page.evaluate(() => window.graphiq!.run("select-feather"));
    const dlg = page.locator('div[role="dialog"][aria-modal="true"]').last();
    await dlg.waitFor();
    await app.setRange("Radius", 30);
    await dlg.getByRole("button", { name: "Feather", exact: true }).click();
    await app.brush(150, 100);
    await app.setForeground("#008080");
    await app.drag(0.87, 0.1, 0.9);
    await app.run("select-deselect");
  });
  await step("on a mask", async () => {
    await app.run("mask-add");
    await app.brush(100, 100);
    await app.setForeground("#000000");
    await app.drag(0.5, 0.3, 0.6);
  });
  await step("back to the pixels", async () => {
    await page.locator('[data-panel-id="layers"] canvas[data-thumb-kind="layer"]').first().click();
  });
  await step("transparency locked", async () => {
    await page.getByRole("button", { name: "Lock the layer" }).first().click();
    await page.getByRole("menuitemcheckbox", { name: /transparen/i }).first().click();
    await page.keyboard.press("Escape");
    await app.brush(200, 100);
    await app.setForeground("#ffffff");
    await app.drag(0.2, 0.05, 0.95);
  });
  await step("undo", () => app.key("Control+z"));
  await step("redo", () => app.key("Control+Shift+z"));
  save("plain", log);
});

test.describe("a shaped brush", () => {
  test.use({
    storage: {
      "graphiq:tool-settings": JSON.stringify({
        brush: {
          size: 70,
          hardness: 60,
          opacity: 100,
          flow: 100,
          blend: "Normal",
          smoothing: 0,
          pressureSize: true,
          pressureFlow: true,
          pressureMin: 30,
          texture: { enabled: true, pattern: "canvas", scale: 120, depth: 80, invert: false },
          dualTip: { enabled: true, size: 40, hardness: 80, scatter: 50, count: 3 },
          tipShape: { angle: 30, roundness: 40 },
          scatter: { enabled: true, amount: 80, count: 2, bothAxes: true },
        },
      }),
    },
  });

  test("char29 strokes: texture, dual tip, shape, scatter, pressure", async ({ app }) => {
    test.setTimeout(300_000);
    const log: unknown[] = [];
    const step = recorder(app, log);
    await app.openPanelById("history");
    await step("a layer", () => app.run("layer-new"));
    await step("shaped", async () => {
      await app.pickTool("Brush");
      await app.setForeground("#d02020");
      await app.drag(0.3);
    });
    await step("again, lower", async () => {
      await app.setForeground("#2040d0");
      await app.drag(0.6, 0.3, 0.7);
    });
    await step("a dab", async () => {
      const b = await app.canvasBox();
      await app.page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.85);
    });
    save("shaped", log);
  });
});

test("char29 strokes: the clone stamp, aligned and not", async ({ app }) => {
  test.setTimeout(300_000);
  const { page } = app;
  const log: unknown[] = [];
  const step = recorder(app, log);
  await app.openPanelById("history");
  await app.run("layer-new");
  await app.brush(120, 100);
  await app.setForeground("#d02020");
  await app.drag(0.3, 0.1, 0.4);
  await app.setForeground("#2040d0");
  await app.drag(0.4, 0.1, 0.4);
  const b = await app.canvasBox();
  const at = (fx: number, fy: number) => ({ x: b.x + b.width * fx, y: b.y + b.height * fy });
  await step("a source", async () => {
    await app.key("s");
    await app.setRange("Size", 60);
    await app.setRange("Hardness", 100);
    const p = at(0.25, 0.35);
    await page.keyboard.down("Alt");
    await page.mouse.click(p.x, p.y);
    await page.keyboard.up("Alt");
  });
  const drag = async (fx0: number, fx1: number, fy: number) => {
    const p = at(fx0, fy);
    const q = at(fx1, fy);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move(q.x, q.y, { steps: 20 });
    await page.mouse.up();
  };
  await step("cloned, aligned", () => drag(0.6, 0.8, 0.35));
  await step("cloned again, aligned", () => drag(0.6, 0.8, 0.6));
  await step("unaligned", async () => {
    const aligned = page.locator('[data-tour="options"] button[role="switch"]', { hasText: "Aligned" }).first();
    if ((await aligned.getAttribute("aria-checked")) === "true") await aligned.click();
    await drag(0.6, 0.8, 0.8);
  });
  await step("undo", () => app.key("Control+z"));
  save("clone", log);
});
