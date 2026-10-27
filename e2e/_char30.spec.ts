/**
 * TEMPORARY characterization for TODO 1.6, the retouch slice. Records, after
 * each step, the composite (hash and census) and the history's last rows — over
 * bands of colour and a gradient: blur, dodge, sponge, smudge and the mixer at
 * their defaults, the History brush from a step, dodge inside a selection, blur
 * on a mask, undo and redo; then burn in the shadows, desaturate, smudge with
 * finger painting sampling every layer, blur sampling every layer, a mixer that
 * cleans after each stroke.
 * Run: CHAR_OUT=<dir>/<before|after> npx playwright test e2e/_char30.spec.ts
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
  await fn();
  await app.settle(600);
  log.push([name, await state(app)]);
};

/** Bands of colour across the canvas, and a black-to-white gradient beneath them. */
async function artwork(app: App) {
  await app.run("layer-new");
  await app.brush(160, 100);
  for (const [hex, fy] of [
    ["#d02020", 0.2],
    ["#20a040", 0.35],
    ["#2040d0", 0.5],
  ] as const) {
    await app.setForeground(hex);
    await app.drag(fy, 0.05, 0.95);
  }
  await app.page.evaluate(() => window.graphiq!.select([{ x: 0, y: 650, w: 1920, h: 430 }]));
  await app.setForeground("#000000");
  await app.pickTool("Gradient");
  await app.drag(0.8, 0.05, 0.95);
  await app.run("select-deselect");
}

test("char30 retouch: the brushes at their defaults, the History brush, in a selection, on a mask", async ({ app }) => {
  test.setTimeout(400_000);
  const { page } = app;
  const log: unknown[] = [];
  const step = recorder(app, log);
  await app.openPanelById("history");
  await artwork(app);
  await step("the artwork", async () => {});
  await step("blur", async () => {
    await app.pickTool("Blur");
    await app.drag(0.28, 0.1, 0.9);
  });
  await step("dodge", async () => {
    await app.pickTool("Dodge");
    await app.drag(0.8, 0.1, 0.9);
  });
  await step("sponge", async () => {
    await app.pickTool("Sponge");
    await app.drag(0.43, 0.1, 0.9);
  });
  await step("smudge", async () => {
    await app.pickTool("Smudge");
    const b = await app.canvasBox();
    await page.mouse.move(b.x + b.width * 0.5, b.y + b.height * 0.15);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.55, b.y + b.height * 0.55, { steps: 25 });
    await page.mouse.up();
  });
  await step("the mixer", async () => {
    await app.pickTool("Mixer brush");
    await app.drag(0.6, 0.2, 0.8);
  });
  await step("the History brush, from the bands", async () => {
    await page
      .locator('[data-panel-id="history"]')
      .getByRole("button", { name: "Set as History-brush source", exact: true })
      .nth(5)
      .click();
    await app.pickTool("History brush");
    await app.drag(0.28, 0.3, 0.7);
  });
  await step("dodge in a selection", async () => {
    await page.evaluate(() => window.graphiq!.select([{ x: 700, y: 750, w: 500, h: 200 }]));
    await app.pickTool("Dodge");
    await app.drag(0.78, 0.1, 0.9);
    await app.run("select-deselect");
  });
  await step("a mask, painted", async () => {
    await app.run("mask-add");
    await app.pickTool("Brush"); // its rail slot shows the History brush now
    await app.setRange("Size", 100);
    await app.setRange("Hardness", 100);
    await app.setForeground("#000000");
    await app.drag(0.43, 0.2, 0.8);
  });
  await step("blur on the mask", async () => {
    await app.pickTool("Blur");
    await app.drag(0.43, 0.1, 0.9);
  });
  await step("undo", () => app.key("Control+z"));
  await step("redo", () => app.key("Control+Shift+z"));
  save("defaults", log);
});

test.describe("other modes", () => {
  test.use({
    storage: {
      "graphiq:tool-settings": JSON.stringify({
        blur: { size: 50, hardness: 60, strength: 80, radius: 12, smoothing: 0, spacing: 15, sampleAll: true },
        dodge: { size: 80, hardness: 40, exposure: 80, mode: "burn", range: "shadows", protect: false, spacing: 12, smoothing: 0 },
        sponge: { size: 70, hardness: 50, flow: 80, mode: "desaturate", vibrance: false, spacing: 12, smoothing: 0 },
        smudge: { size: 50, hardness: 70, strength: 70, spacing: 12, smoothing: 0, sampleAll: true, fingerPaint: true },
        mixer: {
          size: 50,
          hardness: 60,
          wet: 80,
          load: 30,
          mix: 70,
          flow: 80,
          spacing: 12,
          smoothing: 0,
          sampleAll: false,
          cleanAfter: true,
          loadAfter: false,
        },
      }),
    },
  });

  test("char30 retouch: burn, desaturate, finger painting, sampling every layer, a cleaned mixer", async ({ app }) => {
    test.setTimeout(400_000);
    const log: unknown[] = [];
    const step = recorder(app, log);
    await app.openPanelById("history");
    await artwork(app);
    await app.run("layer-new"); // an empty layer on top: "every layer" reaches the artwork
    await step("blur, every layer", async () => {
      await app.pickTool("Blur");
      await app.drag(0.28, 0.1, 0.9);
    });
    await app.page.evaluate(() => window.graphiq!.run("layer-merge-down"));
    await step("merged down", async () => {});
    await step("burn the shadows", async () => {
      await app.pickTool("Dodge");
      await app.drag(0.8, 0.1, 0.9);
    });
    await step("desaturate", async () => {
      await app.pickTool("Sponge");
      await app.drag(0.43, 0.1, 0.9);
    });
    await step("finger painting", async () => {
      await app.setForeground("#f0c000");
      await app.pickTool("Smudge");
      await app.drag(0.2, 0.2, 0.6);
    });
    await step("a cleaned mixer, twice", async () => {
      await app.pickTool("Mixer brush");
      await app.drag(0.6, 0.2, 0.5);
      await app.drag(0.65, 0.5, 0.8);
    });
    save("modes", log);
  });
});
