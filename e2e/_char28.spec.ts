/**
 * TEMPORARY characterization for TODO 1.6, the masks slice. Records, after each
 * step — a mask added, painted (and the stroke undone and redone), viewed on
 * the canvas, made from a selection, made a selection, applied, deleted, added
 * hidden and painted back; the image turned with a mask on; the quick mask
 * entered from a selection, painted and left; selections saved as channels and
 * loaded back; a project with a mask saved and opened back — the composite,
 * the view canvas, the layers, the Channels panel (its rows, thumbnails and
 * mask histogram), the history's last rows, the status bar and any toast.
 * Run: CHAR_OUT=<dir>/<before|after> npx playwright test e2e/_char28.spec.ts
 */
import { writeFileSync } from "node:fs";
import { test, type App } from "./fixtures";

const OUT = process.env.CHAR_OUT;
test.skip(!OUT, "characterization only: set CHAR_OUT");
test.use({ actionTimeout: 10_000 });

const save = (name: string, data: unknown) => writeFileSync(`${OUT}.${name}.json`, JSON.stringify(data, null, 1));

const state = async (app: App) => {
  const s = await app.page.evaluate(async () => {
    const hash = (d: ArrayLike<number>) => {
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) h = Math.imul(h ^ d[i], 0x01000193);
      return (h >>> 0).toString(36);
    };
    const blob = await window.graphiq!.exportPNG(1);
    const composite = hash(new Uint8Array(await blob!.arrayBuffer()));
    const view = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
    const viewHash = hash(view.getContext("2d")!.getImageData(0, 0, view.width, view.height).data);
    const panel = document.querySelector('[data-panel-id="channels"]');
    const hist = panel?.querySelector("canvas");
    return {
      composite,
      view: viewHash,
      layers: JSON.stringify(window.graphiq!.layers()),
      channels: [...(panel?.querySelectorAll("img") ?? [])].map((i) => hash(new TextEncoder().encode(i.src))),
      channelText: panel?.textContent?.replace(/\s+/g, " ").trim().slice(0, 300) ?? null,
      histogram: hist ? hash(hist.getContext("2d")!.getImageData(0, 0, hist.width, hist.height).data) : null,
      status: document.querySelector('footer[data-tour="status"]')?.textContent?.replace(/\s+/g, " ").trim() ?? null,
      toast: document.querySelector('[role="status"]')?.textContent?.trim() ?? null,
    };
  });
  return { ...s, history: (await app.historyRows()).slice(-3) };
};

const recorder = (app: App, log: unknown[]) => async (name: string, fn: () => Promise<unknown>) => {
  console.log(`step: ${name}`);
  await fn();
  await app.settle(600);
  log.push([name, await state(app)]);
};

test("char28 masks: added, painted, viewed, from and to a selection, applied; quick mask; channels", async ({ app }) => {
  test.setTimeout(400_000);
  const { page } = app;
  const log: unknown[] = [];
  const step = recorder(app, log);
  const run = (id: string) => page.evaluate((id) => window.graphiq!.run(id), id);
  await app.openPanelById("history");
  await app.openPanelById("channels");
  await app.setForeground("#3aa0ff");
  await app.run("fill-solid");
  await app.run("layer-flatten");
  await app.run("layer-new");
  await app.brush(160, 100);
  for (const [hex, fy] of [
    ["#d02020", 0.25],
    ["#20a040", 0.6],
  ] as const) {
    await app.setForeground(hex);
    await app.drag(fy, 0.1, 0.9);
  }
  await step("start", async () => {});
  await step("a mask", () => run("mask-add"));
  await step("painted black", async () => {
    await app.brush(120, 100);
    await app.setForeground("#000000");
    await app.drag(0.4, 0.2, 0.8);
  });
  await step("painted grey, soft", async () => {
    await app.brush(200, 0);
    await app.setForeground("#808080");
    await app.drag(0.7, 0.3, 0.7);
  });
  await step("undo the grey", () => app.key("Control+z"));
  await step("redo it", () => app.key("Control+Shift+z"));
  await step("view the mask", () => page.getByRole("button", { name: "View mask on canvas" }).first().click());
  await step("a stroke while viewing it", async () => {
    await app.brush(80, 100);
    await app.setForeground("#ffffff");
    await app.drag(0.4, 0.4, 0.6);
  });
  await step("back to the composite", () => page.getByRole("button", { name: "View mask on canvas" }).first().click());
  await step("the mask as a selection", () => run("mask-to-sel"));
  await step("turned with it", () => run("image-rotate-cw"));
  await step("and back", () => run("image-rotate-ccw"));
  await step("applied", () => run("mask-apply"));
  await step("a hidden mask", () => run("mask-add-hide"));
  await step("painted back white", async () => {
    await app.brush(300, 50);
    await app.setForeground("#ffffff");
    await app.drag(0.5, 0.2, 0.8);
  });
  await step("deleted", () => run("mask-delete"));
  await step("a soft selection", async () => {
    await page.evaluate(() => window.graphiq!.select([{ x: 500, y: 300, w: 700, h: 400 }]));
    await page.evaluate(() => window.graphiq!.run("select-feather"));
    const dlg = page.locator('div[role="dialog"][aria-modal="true"]').last();
    await dlg.waitFor();
    await app.setRange("Radius", 25);
    await dlg.getByRole("button", { name: "Feather", exact: true }).click();
  });
  await step("a mask from it", () => run("mask-from-sel"));
  await step("deselect", () => run("select-deselect"));
  await step("the quick mask, from a selection", async () => {
    await page.evaluate(() => window.graphiq!.select([{ x: 200, y: 200, w: 500, h: 300 }]));
    await run("select-quickmask");
  });
  await step("painted in it", async () => {
    await app.brush(150, 100);
    await app.setForeground("#ffffff");
    await app.drag(0.7, 0.5, 0.9);
  });
  await step("out of it", () => run("select-quickmask"));
  const saveChannel = async (name: string) => {
    await page.getByRole("button", { name: "Save selection as channel" }).first().click();
    const dlg = page.locator('div[role="dialog"][aria-label="Save selection"]');
    await dlg.waitFor();
    await dlg.locator('input[aria-label="Channel name"]').fill(name);
    await dlg.getByRole("button", { name: "Save", exact: true }).click();
  };
  await step("saved as a channel", () => saveChannel("first"));
  await step("another, saved", async () => {
    await page.evaluate(() => window.graphiq!.select([{ x: 1300, y: 100, w: 300, h: 300 }]));
    await saveChannel("second");
  });
  await step("deselect again", () => run("select-deselect"));
  await step("the first loaded", async () => {
    await page.locator('[data-panel-id="channels"] img').first().click();
  });
  await step("the second added", async () => {
    await page.keyboard.down("Control");
    await page.locator('[data-panel-id="channels"] img').nth(1).click();
    await page.keyboard.up("Control");
  });
  save("masks", log);
});

test.describe("saved with the project", () => {
  test.use({ filePickers: false });

  test("char28 masks: a masked layer saved and opened back", async ({ app }, info) => {
    test.setTimeout(200_000);
    const log: unknown[] = [];
    const step = recorder(app, log);
    await app.openPanelById("channels");
    await app.run("layer-new");
    await app.setForeground("#d02020");
    await app.brush(200, 100);
    await app.drag(0.5, 0.1, 0.9);
    await step("masked", async () => {
      await app.page.evaluate(() => window.graphiq!.run("mask-add"));
      await app.setForeground("#000000");
      await app.drag(0.5, 0.4, 0.6);
    });
    const path = info.outputPath("masked.gproj");
    await step("saved", async () => {
      const dl = app.page.waitForEvent("download", { timeout: 20_000 });
      await app.run("save");
      await (await dl).saveAs(path);
    });
    await step("opened back", async () => {
      await app.page.locator('input[type="file"][accept*="gproj"]').setInputFiles(path);
      await app.settle(2_000);
    });
    save("project", log);
  });
});
