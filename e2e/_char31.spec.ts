/**
 * TEMPORARY characterization for TODO 1.6, the smart-filter slice. Records, after
 * each step, the composite (hash and census), the history's last rows, the
 * cached product against an inline render (filterAB), and whether this step got
 * a product back from the worker, drew a live region or a draft — over bands of
 * colour and a gradient: a blur added, its radius changed (a stale product
 * drawn, the worker refreshing it), its opacity; a stroke on the filtered layer
 * (and the view mid-stroke), the same with the live region off (the draft); a
 * filter mask from a selection, painted; undo, redo; the render cache off. At
 * 1920 × 1080 (past the half-res preview's threshold) with workers on, the same
 * with workers off, and at 800 × 600.
 * Run: CHAR_OUT=<dir>/<before|after> npx playwright test e2e/_char31.spec.ts
 */
import { writeFileSync } from "node:fs";
import { test, type App } from "./fixtures";

const OUT = process.env.CHAR_OUT;
test.skip(!OUT, "characterization only: set CHAR_OUT");
test.use({ actionTimeout: 10_000 });

const save = (name: string, data: unknown) => writeFileSync(`${OUT}.${name}.json`, JSON.stringify(data, null, 1));

type Stats = { workerJobs: number; filterWorkerResults: number; liveRegionHits: number; liveDraftFrames: number };
const stats = (app: App) =>
  app.page.evaluate(() => window.__gqRenderCache!.stats() as unknown as Stats);

/** No worker job out, and the cached product current (or no filter at all). */
async function settled(app: App) {
  for (let i = 0; i < 40; i++) {
    const s = await stats(app);
    const ab = await app.page.evaluate(() => window.__gqRenderCache!.filterAB());
    const filtered = await app.page.evaluate(() =>
      JSON.stringify(window.graphiq!.layers()).includes('"filters":[{'),
    );
    if (!s.workerJobs && (ab || !filtered)) return;
    await app.settle(250);
  }
}

const recorder = (app: App, log: unknown[]) => {
  let last: Stats | null = null;
  return async (name: string, fn: () => Promise<unknown>) => {
    console.log(`step: ${name}`);
    last ??= await stats(app);
    await fn();
    await app.settle(600);
    await settled(app);
    const s = await stats(app);
    const pixels = await app.page.evaluate(async () => {
      const blob = await window.graphiq!.exportPNG(1);
      const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob!.arrayBuffer()));
      return [...buf].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
    });
    const ab = await app.page.evaluate(() => {
      const r = window.__gqRenderCache!.filterAB();
      return r && { differing: r.differing, digest: r.digest, quality: r.quality };
    });
    log.push([
      name,
      {
        pixels,
        census: await app.exported(),
        history: (await app.historyRows()).slice(-2),
        ab,
        worker: s.filterWorkerResults > last.filterWorkerResults,
        region: s.liveRegionHits > last.liveRegionHits,
        draft: s.liveDraftFrames > last.liveDraftFrames,
      },
    ]);
    last = s;
  };
};

/** Bands of colour across the canvas, and a black-to-white gradient beneath them. */
async function artwork(app: App, w: number, h: number) {
  await app.run("layer-new");
  await app.brush(Math.round(h / 7), 100);
  for (const [hex, fy] of [
    ["#d02020", 0.2],
    ["#20a040", 0.35],
    ["#2040d0", 0.5],
  ] as const) {
    await app.setForeground(hex);
    await app.drag(fy, 0.05, 0.95);
  }
  await app.page.evaluate(([w, h]) => window.graphiq!.select([{ x: 0, y: Math.round(h * 0.6), w, h }]), [w, h]);
  await app.setForeground("#000000");
  await app.pickTool("Gradient");
  await app.drag(0.8, 0.05, 0.95);
  await app.run("select-deselect");
}

const sfd = (app: App) => app.page.locator('div[role="dialog"][aria-label="Smart filters"]');

/** A range in the smart-filter dialog, by its label. */
const dialogRange = (app: App, label: string, v: number) =>
  app.page.evaluate(
    ([l, v]) => {
      const d = document.querySelector('div[role="dialog"][aria-label="Smart filters"]')!;
      const el = d.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${l}"]`)!;
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [label, v] as const,
  );

async function inDialog(app: App, fn: () => Promise<unknown>) {
  await app.menu("Effects", "Smart filters…");
  await app.page.locator('div[role="dialog"][aria-label="Smart filters"]').waitFor({ timeout: 8_000 });
  await fn();
  await app.settle(400);
  if (await app.page.locator('div[role="dialog"][aria-label="Smart filters"]').count()) await app.key("Escape");
}

async function run(app: App, w: number, h: number, log: unknown[]) {
  const { page } = app;
  const step = recorder(app, log);
  await app.openPanelById("history");
  await artwork(app, w, h);
  await step("the artwork", async () => {});
  await step("a blur added", async () => {
    await app.menu("Effects", "Blur (smart filter)");
    await app.key("Escape");
  });
  await step("its radius", () => inDialog(app, () => dialogRange(app, "Radius", 20)));
  await step("its opacity", () => inDialog(app, () => dialogRange(app, "Opacity", 60)));
  const stroke = async (fy: number) => {
    await app.brush(Math.round(h / 10), 100);
    await app.setForeground("#ffffff");
    const b = await app.canvasBox();
    await page.mouse.move(b.x + b.width * 0.2, b.y + b.height * fy);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * 0.6, b.y + b.height * fy, { steps: 20 });
    await app.settle(500);
    log.push([`the view mid-stroke at ${fy}`, (await app.viewShot()).hash]);
    await page.mouse.up();
  };
  await step("a stroke on the filtered layer", () => stroke(0.35));
  await step("a stroke, the live region off", async () => {
    await page.evaluate(() => window.__gqRenderCache!.regionOff());
    await stroke(0.5);
    await page.evaluate(() => window.__gqRenderCache!.regionOn());
  });
  await step("a filter mask from a selection", async () => {
    await page.evaluate(([w, h]) => window.graphiq!.select([{ x: 0, y: 0, w: Math.round(w / 2), h }]), [w, h]);
    await inDialog(app, () => sfd(app).getByRole("button", { name: "From Selection" }).click());
    await app.run("select-deselect");
  });
  await step("the filter mask painted", async () => {
    await inDialog(app, () => sfd(app).getByRole("button", { name: "Paint", exact: true }).click());
    await app.brush(Math.round(h / 8), 100);
    await app.setForeground("#000000");
    await app.drag(0.35, 0.1, 0.4);
  });
  await step("undo", () => app.key("Control+z"));
  await step("redo", () => app.key("Control+Shift+z"));
  await step("the render cache off", () => page.evaluate(() => window.__gqRenderCache!.disable()));
  await page.evaluate(() => window.__gqRenderCache!.enable());
}

test("char31 smart filters at 1920 × 1080, workers on", async ({ app }) => {
  test.setTimeout(400_000);
  const log: unknown[] = [];
  await run(app, 1920, 1080, log);
  save("big", log);
});

test.describe("workers off", () => {
  test.use({ storage: { "graphiq:preferences": JSON.stringify({ useWorkers: false }) } });

  test("char31 smart filters at 1920 × 1080, workers off", async ({ app }) => {
    test.setTimeout(400_000);
    const log: unknown[] = [];
    await run(app, 1920, 1080, log);
    save("sync", log);
  });
});

test("char31 smart filters at 800 × 600", async ({ app }) => {
  test.setTimeout(400_000);
  const log: unknown[] = [];
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("800");
  await nd.locator('input[type="number"]').nth(1).fill("600");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_200);
  await run(app, 800, 600, log);
  save("small", log);
});
