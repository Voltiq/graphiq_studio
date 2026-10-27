/**
 * The engine's smart filters (TODO 1.6, app/lib/engine/smart-filters.ts), as
 * the engine wires them: a change draws while the worker refreshes the product,
 * and once it lands the view and an export are what a fresh render gives; a
 * filter mask confines the stack; a stroke on a filtered layer previews its own
 * region at full resolution, or a draft with the region off, and settled the
 * view is whole again; Apply (bake) puts into the layer what the stack showed.
 * While the worker is out the view draws the stale product; with the render
 * cache off a change goes to no worker; with workers off a stroke drawn as
 * drafts settles to the whole view.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

type Stats = { workerJobs: number; filterWorkerResults: number; liveRegionHits: number; liveDraftFrames: number };
const stats = (app: App) => app.page.evaluate(() => window.__gqRenderCache!.stats() as unknown as Stats);
const filterAB = (app: App) => app.page.evaluate(() => window.__gqRenderCache!.filterAB());

/** No worker job out, and the product current at full resolution. */
async function settled(app: App) {
  for (let i = 0; i < 40; i++) {
    const ab = await filterAB(app);
    if (!(await stats(app)).workerJobs && ab?.quality === "full") return;
    await app.settle(250);
  }
}

const composite = (app: App) =>
  app.page.evaluate(async () => {
    const buf = await crypto.subtle.digest("SHA-256", await (await window.graphiq!.exportPNG(1))!.arrayBuffer());
    return [...new Uint8Array(buf)].slice(0, 8).join(",");
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
/** The on-screen view at (fx, fy) of its size. */
const onScreen = (app: App, fx: number, fy: number) =>
  app.page.evaluate(
    ([fx, fy]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
      return [...c.getContext("2d")!.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data];
    },
    [fx, fy] as const,
  );

const sfd = (app: App) => app.page.locator('div[role="dialog"][aria-label="Smart filters"]');
/** Open the smart-filter dialog, do `fn`, and close it if it is still up. */
async function inDialog(app: App, fn: () => Promise<unknown>) {
  await app.menu("Effects", "Smart filters…");
  await sfd(app).waitFor({ timeout: 8_000 });
  await fn();
  await app.settle(400);
  if (await sfd(app).count()) await app.key("Escape");
}
const radius = (app: App, v: number) =>
  app.page.evaluate((v) => {
    const el = document.querySelector<HTMLInputElement>(
      'div[role="dialog"][aria-label="Smart filters"] input[type="range"][aria-label="Radius"]',
    )!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, v);

/** Bands of red, green and blue on a layer of their own, blurred by a smart filter of `r`. */
async function blurredBands(app: App, r: number) {
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
  await app.menu("Effects", "Blur (smart filter)");
  await app.key("Escape");
  await inDialog(app, () => radius(app, r));
  await settled(app);
}

/** The view and an export now, and the same rendered afresh with the render cache off. */
async function againstFresh(app: App) {
  const now = [(await app.stableViewShot()).hash, await composite(app)];
  await app.page.evaluate(() => window.__gqRenderCache!.disable());
  const fresh = [(await app.stableViewShot()).hash, await composite(app)];
  await app.page.evaluate(() => window.__gqRenderCache!.enable());
  return [now, fresh];
}

test("a change draws while the worker refreshes it; landed, the view and an export are a fresh render's", async ({
  app,
}) => {
  await blurredBands(app, 8);
  const before = (await stats(app)).filterWorkerResults;
  await inDialog(app, () => radius(app, 20));
  await settled(app);
  expect((await stats(app)).filterWorkerResults, "the worker refreshed the product").toBeGreaterThan(before);
  const ab = await filterAB(app);
  expect([ab?.differing, ab?.quality], "the cached product is the stack's, at full resolution").toEqual([0, "full"]);
  const [now, fresh] = await againstFresh(app);
  expect(now, "the view and the export, against a fresh render").toEqual(fresh);
});

test("a filter mask confines the stack", async ({ app }) => {
  await blurredBands(app, 20);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 0, y: 0, w: 960, h: 1080 }]));
  await inDialog(app, () => sfd(app).getByRole("button", { name: "From Selection" }).click());
  await app.run("select-deselect");
  await settled(app);
  // Seven pixels inside the red band, above the green.
  expect(await rgba(app, 1440, 290), "outside the mask: the layer's own red").toEqual([208, 32, 32, 255]);
  expect(await rgba(app, 480, 290), "inside: blurred toward the green").not.toEqual([208, 32, 32, 255]);
});

test("a stroke previews its region, or a draft with the region off; settled, the view is whole", async ({
  app,
}) => {
  await blurredBands(app, 8);
  const b = await app.canvasBox();
  await app.brush(40, 100);
  await app.setForeground("#ffffff");
  for (const [fy, region] of [
    [0.35, true],
    [0.5, false],
  ] as const) {
    if (!region) await app.page.evaluate(() => window.__gqRenderCache!.regionOff());
    const s0 = await stats(app);
    const before = await onScreen(app, 0.3, fy);
    await app.page.mouse.move(b.x + b.width * 0.2, b.y + b.height * fy);
    await app.page.mouse.down();
    await app.page.mouse.move(b.x + b.width * 0.6, b.y + b.height * fy, { steps: 20 });
    await app.settle(400);
    const live = await onScreen(app, 0.3, fy); // the pointer still down, well past it
    const s1 = await stats(app);
    await app.page.mouse.up();
    await app.page.evaluate(() => window.__gqRenderCache!.regionOn());
    await settled(app);
    expect(live, `the stroke shows before it ends (region ${region})`).not.toEqual(before);
    expect(
      [s1.liveRegionHits > s0.liveRegionHits, s1.liveDraftFrames > s0.liveDraftFrames],
      "its region at full resolution, or a draft",
    ).toEqual([region, !region]);
  }
  const [now, fresh] = await againstFresh(app);
  expect(now, "settled: the view and the export, against a fresh render").toEqual(fresh);
});

test("Apply (bake) puts into the layer what the stack showed", async ({ app }) => {
  await app.openPanelById("history");
  await blurredBands(app, 20);
  const shown = await composite(app);
  await inDialog(app, () => sfd(app).getByText("Apply (bake)", { exact: true }).click());
  await settled(app);
  expect(await composite(app), "the same picture").toBe(shown);
  expect((await app.historyRows()).at(-1)?.replace(/\d+$/, "")).toBe("Apply Smart Filters");
  expect(await filterAB(app), "and no filter left to compare").toBeNull();
});

/** Hold every worker's replies from now on until `release`, from workers made after this. */
const holdable = (app: App) =>
  app.page.evaluate(() => {
    const w = window as unknown as { __hold: boolean; __held: (() => void)[] };
    w.__hold = false;
    w.__held = [];
    const Real = window.Worker;
    window.Worker = class extends Real {
      set onmessage(fn: ((e: MessageEvent) => void) | null) {
        super.onmessage = (e: MessageEvent) => (w.__hold ? w.__held.push(() => fn!(e)) : fn!(e));
      }
    } as typeof Worker;
  });
const hold = (app: App) => app.page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = true));
const release = (app: App) =>
  app.page.evaluate(() => {
    const w = window as unknown as { __hold: boolean; __held: (() => void)[] };
    w.__hold = false;
    for (const f of w.__held.splice(0)) f();
  });

test("while the worker is out the view draws the stale product, and the fresh one once it answers", async ({
  app,
}) => {
  await holdable(app);
  await blurredBands(app, 8);
  const old = (await app.stableViewShot()).hash;
  await hold(app);
  await inDialog(app, () => radius(app, 20));
  await app.settle(600);
  expect((await stats(app)).workerJobs, "the refresh is out").toBeGreaterThan(0);
  expect((await app.viewShot()).hash, "meanwhile, the old product").toBe(old);
  await release(app);
  await settled(app);
  const [now, fresh] = await againstFresh(app);
  expect([now[0] !== old, now], "answered: the new radius, as a fresh render draws it").toEqual([true, fresh]);
});

test("with the render cache off, a change computes in line and goes to no worker", async ({ app }) => {
  await blurredBands(app, 8);
  await app.page.evaluate(() => window.__gqRenderCache!.disable());
  const before = (await stats(app)).filterWorkerResults;
  await inDialog(app, () => radius(app, 20));
  await app.settle(1_000);
  const after = (await stats(app)).filterWorkerResults;
  await app.page.evaluate(() => window.__gqRenderCache!.enable());
  expect(after, "no product from the worker").toBe(before);
});

test.describe("workers off", () => {
  test.use({ storage: { "graphiq:preferences": JSON.stringify({ useWorkers: false }) } });

  test("a stroke drawn as drafts settles to the whole view", async ({ app }) => {
    await blurredBands(app, 8);
    await app.brush(40, 100);
    await app.setForeground("#ffffff");
    await app.page.evaluate(() => window.__gqRenderCache!.regionOff());
    const s0 = await stats(app);
    await app.drag(0.35, 0.2, 0.6);
    await app.page.evaluate(() => window.__gqRenderCache!.regionOn());
    await settled(app);
    expect((await stats(app)).liveDraftFrames, "drawn as drafts").toBeGreaterThan(s0.liveDraftFrames);
    const [now, fresh] = await againstFresh(app);
    expect(now, "the view and the export, against a fresh render").toEqual(fresh);
  });
});
