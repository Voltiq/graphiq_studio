/**
 * The engine's heal (TODO 1.6, app/lib/engine/heal.ts), as the engine wires it:
 * a spot heal takes a blemish off as one step, worked out by the heal worker,
 * and undoes; content-aware fill fills the selection and nothing round it; in a
 * selection a spot heal keeps inside it; a heal whose document has gone to the
 * back lands there and not in front; a heal out to the worker counts as a job
 * until it lands; on a layer in a group it shows on screen and in an export once
 * it lands; red-eye in a selection keeps inside it, clipped as a heal is.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** Count the heal worker's replies, and hold them from `hold` until `release`. */
const watched = (app: App) =>
  app.page.evaluate(() => {
    const w = window as unknown as { __replies: number; __hold: boolean; __held: (() => void)[] };
    Object.assign(w, { __replies: 0, __hold: false, __held: [] });
    const Real = window.Worker;
    window.Worker = class extends Real {
      private heal: boolean;
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        this.heal = String(url).includes("heal");
      }
      set onmessage(fn: ((e: MessageEvent) => void) | null) {
        super.onmessage = (e: MessageEvent) => {
          if (this.heal) w.__replies++;
          if (w.__hold) w.__held.push(() => fn!(e));
          else fn!(e);
        };
      }
    } as typeof Worker;
  });
const replies = (app: App) => app.page.evaluate(() => (window as unknown as { __replies: number }).__replies);
const hold = (app: App) => app.page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = true));
const release = (app: App) =>
  app.page.evaluate(() => {
    const w = window as unknown as { __hold: boolean; __held: (() => void)[] };
    w.__hold = false;
    for (const f of w.__held.splice(0)) f();
  });

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
const lastStep = async (app: App) => (await app.historyRows()).at(-1)?.replace(/\d+$/, "");
const WHITE = [255, 255, 255, 255];
const GREEN = [32, 160, 64, 255];

/** A green band, with white blemishes at x 0.3, 0.5 and 0.7 of it (y 378). */
async function blemished(app: App) {
  await app.run("layer-new");
  await app.brush(160, 100);
  await app.setForeground("#20a040");
  await app.drag(0.35, 0.05, 0.95);
  await app.brush(14, 100);
  await app.setForeground("#ffffff");
  for (const fx of [0.3, 0.5, 0.7]) await app.drag(0.35, fx, fx + 0.005);
}
/** A spot heal over the blemish at `fx`, landed. */
async function heal(app: App, fx: number, wait = true) {
  await app.pickTool("Spot heal");
  await app.drag(0.35, fx - 0.01, fx + 0.015);
  if (wait) await expect.poll(() => rgba(app, Math.round(fx * 1920) + 5, 378), { timeout: 15_000 }).not.toEqual(WHITE);
}

test("a spot heal takes a blemish off as one step, worked out by the worker, and undoes", async ({ app }) => {
  await app.openPanelById("history");
  await watched(app);
  await blemished(app);
  expect(await rgba(app, 581, 378), "the blemish").toEqual(WHITE);
  await heal(app, 0.3);
  const healed = await rgba(app, 581, 378);
  expect(Math.abs(healed[1] - 160), `green again: ${healed}`).toBeLessThan(40);
  expect([await lastStep(app), (await replies(app)) > 0]).toEqual(["Spot Heal", true]);
  await app.key("Control+z");
  expect(await rgba(app, 581, 378), "undone").toEqual(WHITE);
});

test("content-aware fill fills the selection, and nothing round it", async ({ app }) => {
  await app.openPanelById("history");
  await blemished(app);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 950, y: 360, w: 30, h: 36 }]));
  await app.run("edit-caf");
  await expect.poll(() => rgba(app, 965, 378), { timeout: 15_000 }).not.toEqual(WHITE);
  expect(await lastStep(app)).toBe("Content-Aware Fill");
  expect(await rgba(app, 940, 378), "beside it, as it was").toEqual(GREEN);
});

test("in a selection a spot heal keeps inside it", async ({ app }) => {
  await blemished(app);
  // The selection ends halfway across the blemish at 0.7 (x 1344 to 1354).
  await app.page.evaluate(() => window.graphiq!.select([{ x: 1200, y: 300, w: 149, h: 160 }]));
  await heal(app, 0.7, false);
  await expect.poll(() => rgba(app, 1345, 378), { timeout: 15_000 }).not.toEqual(WHITE);
  expect(await rgba(app, 1352, 378), "outside the selection, still white").toEqual(WHITE);
});

test("a heal whose document has gone to the back lands there, not in front", async ({ app }) => {
  await app.openPanelById("history");
  await watched(app);
  await blemished(app);
  const first = (await app.docs()).find((d) => d.active)!.id;
  await hold(app);
  await heal(app, 0.5, false);
  await app.settle(500);
  expect(await app.page.evaluate(() => window.__gqRenderCache!.stats().workerJobs), "out to the worker").toBe(1);
  await app.newDoc();
  await release(app);
  await app.settle(800);
  expect(await app.page.evaluate(() => window.__gqRenderCache!.stats().workerJobs), "landed").toBe(0);
  expect(await lastStep(app), "the document in front has no heal").not.toBe("Spot Heal");
  await app.activate(first);
  expect(await lastStep(app)).toBe("Spot Heal");
  expect(await rgba(app, 965, 378), "healed").not.toEqual(WHITE);
});

/** The on-screen view at (fx, fy) of its size. */
const onScreen = (app: App, fx: number, fy: number) =>
  app.page.evaluate(
    ([fx, fy]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
      return [...c.getContext("2d")!.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data];
    },
    [fx, fy] as const,
  );

test("a heal on a layer in a group, whose merge is cached, shows on screen and in an export once it lands", async ({
  app,
}) => {
  await blemished(app);
  const id = await app.page.evaluate(() => window.graphiq!.layers()[0].id);
  await app.run("layer-group");
  await app.page.evaluate((id) => window.graphiq!.selectLayer(id), id);
  await app.settle(300);
  expect(await onScreen(app, 0.3 + 2 / 1920, 0.35), "the blemish, on screen").toEqual(WHITE);
  await heal(app, 0.3); // waits for the export to show it
  await expect.poll(() => onScreen(app, 0.3 + 2 / 1920, 0.35), { timeout: 15_000 }).not.toEqual(WHITE);
});

test("red-eye in a selection keeps inside it, clipped as a heal is", async ({ app }) => {
  await app.run("layer-new");
  await app.brush(40, 100);
  await app.setForeground("#d01010");
  await app.drag(0.5, 0.5, 0.501); // a red pupil at the middle
  const red = await rgba(app, 970, 540);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 0, y: 0, w: 960, h: 1080 }]));
  await app.pickTool("Red eye");
  const b = await app.canvasBox();
  await app.page.mouse.click(b.x + b.width * 0.5, b.y + b.height * 0.5);
  await app.settle(600);
  expect((await rgba(app, 950, 540))[0], "inside: the red darkened").toBeLessThan(red[0] - 40);
  expect(await rgba(app, 970, 540), "outside: as it was").toEqual(red);
});
