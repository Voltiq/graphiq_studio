/**
 * Documents that cannot exist are refused, with a sentence, instead of opening
 * blank. (Ported from tools/verify-canvas-ceiling.js, TODO 2.1.)
 *
 * Past the browser's canvas limits NOTHING throws: `canvas.width` reports the
 * size you asked for, `getContext` works, `fillRect` is accepted, and
 * `getImageData` succeeds — returning zeros. A 20 KB file declaring itself
 * 70000×100 opened as a document with a tab, a name and not one pixel, with an
 * empty console. The failure is reproduced here so the reason cannot rot.
 *
 * The check the item names is "one pixel over the probed limit": the fixtures
 * are 65535×1 and 65536×1, the same file and path differing by one pixel. And
 * the probe is split on purpose: the side limit is cheap (a binary search at
 * height 1, 1.5ms, at boot); the area limit needs one allocation the size of
 * the ceiling (212ms, a transient 1 GB), so it is never done at boot —
 * `provenArea === 0` after start-up is how that is proven.
 */
import { join } from "node:path";
import { test, expect, type App } from "./fixtures";

const FIX = (n: string) => join(__dirname, "..", "tools", "fixtures", n);

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

type W = {
  __gqCeiling?: () => { maxSide: number; provenArea: number };
  __gqCheckSize: (w: number, h: number) => { ok: boolean; verdict: string; message: string };
};

/** An independent search for the side limit, owing nothing to the app's. */
const independentSide = (app: App) =>
  app.page.evaluate(() => {
    const holds = (w: number, h: number) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      if (c.width !== w || c.height !== h) return false;
      const g = c.getContext("2d", { willReadFrequently: true });
      if (!g) return false;
      g.fillStyle = "#ff0000";
      g.fillRect(w - 1, h - 1, 1, 1);
      const ok = g.getImageData(w - 1, h - 1, 1, 1).data[3] === 255;
      c.width = c.height = 0;
      return ok;
    };
    let lo = 1;
    let hi = 1 << 17;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (holds(mid, 1)) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  });

/** What a refusal must leave untouched. */
const state = (app: App) =>
  app.page.evaluate(() => ({
    docs: (window as unknown as { graphiq: { docs(): unknown[] } }).graphiq.docs().length,
    oversized: [...document.querySelectorAll("canvas")].filter((c) => c.width > 65535 || c.height > 65535).length,
    canvases: [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height}`),
  }));
const message = (app: App) =>
  app.page.evaluate(() => document.body.innerText.match(/This (?:image|document|canvas) is [^\n]*/)?.[0] ?? null);

async function importAsCanvas(app: App, file: string) {
  const { page } = app;
  await page.locator('input[type="file"][multiple][accept*="image/*"]').first().setInputFiles(file);
  const dlg = page.locator('[role="dialog"]');
  await dlg.waitFor({ timeout: 10_000 }).catch(() => {});
  if (await dlg.count()) {
    await dlg.getByText("New canvas").first().click();
    await dlg.locator("button", { hasText: /^Import$/ }).last().click();
  }
  await app.settle(2000);
}

test("the silent failure is real, the probe agrees with an independent one, and allocated nothing", async ({ app }) => {
  const side = await independentSide(app);
  const silent = await app.page.evaluate((side) => {
    const c = document.createElement("canvas");
    c.width = side + 1;
    c.height = 1;
    const g = c.getContext("2d")!;
    g.fillStyle = "#ff0000";
    g.fillRect(0, 0, 1, 1);
    return { width: c.width, alpha: g.getImageData(0, 0, 1, 1).data[3] };
  }, side);
  expect(silent, "one over the limit: it keeps the size asked for, draws without throwing, and reads back empty").toEqual({
    width: side + 1,
    alpha: 0,
  });
  const ceiling = await app.page.evaluate(() => (window as unknown as W).__gqCeiling?.() ?? null);
  expect(ceiling?.maxSide, "the app's probe agrees with an independent search").toBe(side);
  expect(ceiling?.provenArea, "the boot probe allocated nothing large — proving an area means allocating it").toBe(0);

  const at = await app.page.evaluate((s) => (window as unknown as W).__gqCheckSize(s, 1), side);
  const over = await app.page.evaluate((s) => (window as unknown as W).__gqCheckSize(s + 1, 1), side);
  expect(at.ok, `${side}×1 is accepted`).toBe(true);
  expect(over.ok, `${side + 1}×1 is refused`).toBe(false);
  expect(over.message, "...naming the size").toContain((side + 1).toLocaleString("en-US"));
  expect(over.message, "...and the limit").toContain(side.toLocaleString("en-US"));
});

test("through the real import: at the limit opens with pixels, one over and 70000×100 are refused aloud", async ({ app }) => {
  /* The control first: if this did not open, a rail that only tested refusal
     would pass with the app refusing everything. */
  const before = await state(app);
  await importAsCanvas(app, FIX("size-65535x1.png"));
  const ok = await state(app);
  expect(ok.docs, "a document exactly at the limit opens").toBe(before.docs + 1);
  expect(ok.canvases, "...really allocated").toContain("65535x1");
  /* Allocated is not holding pixels — that is the whole lesson. */
  const ink = await app.page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].find((x) => x.width === 65535 && x.height === 1)!;
    return c.getContext("2d", { willReadFrequently: true })!.getImageData(c.width - 1, 0, 1, 1).data[3];
  });
  expect(ink, "...and holds pixels at its far edge").toBe(255);

  await importAsCanvas(app, FIX("size-65536x1.png"));
  const over = await state(app);
  expect(over.docs, "ONE PIXEL over is refused").toBe(ok.docs);
  expect(await message(app), "...with a message naming the size").toContain("65,536");
  expect(over.oversized, "...and no blank canvas left behind").toBe(0);

  await importAsCanvas(app, FIX("size-70000x100.png"));
  const big = await state(app);
  expect({ docs: big.docs, oversized: big.oversized }, "the 20 KB file that opened blank is refused").toEqual({ docs: ok.docs, oversized: 0 });
});

test("New document caps its fields from the probe, and an ordinary 4000×3000 is untouched", async ({ app }) => {
  const { page } = app;
  const side = await independentSide(app);
  await page.keyboard.press("Control+n");
  const fields = page.locator('[role="dialog"] input[type="number"]');
  await expect(fields.first()).toBeVisible();
  const caps = await fields.evaluateAll((els) => els.map((e) => e.getAttribute("max")).filter(Boolean).map(Number));
  expect(caps.slice(0, 2), "the caps come from the probe, not a constant").toEqual([Math.min(8192, side), Math.min(8192, side)]);
  /* No false refusals: invisible for ordinary work. */
  const before = await state(app);
  await fields.nth(0).fill("4000");
  await fields.nth(1).fill("3000");
  await page.locator('[role="dialog"] button', { hasText: /^Create$/ }).first().click();
  await expect.poll(async () => (await state(app)).docs).toBe(before.docs + 1);
  expect((await state(app)).canvases).toContain("4000x3000");
});

test("sizes from storage are as untrusted as files: a project and a stored default", async ({ app }) => {
  const { page } = app;
  /* A project declaring an impossible size. */
  const before = await state(app);
  await page.locator('input[type="file"][accept*="gproj"]').first().setInputFiles({
    name: "impossible.gproj",
    mimeType: "application/json",
    buffer: Buffer.from(JSON.stringify({ format: "graphiq-project", version: 24, name: "impossible", width: 70000, height: 100, layers: [] })),
  });
  await app.settle(2000);
  const proj = await state(app);
  expect({ docs: proj.docs, oversized: proj.oversized }, "a project declaring an impossible size is refused").toEqual({
    docs: before.docs,
    oversized: 0,
  });
  expect(await message(app), "...and says so").toBeTruthy();

  /* Preferences are read back with a plain spread, and "just use my default"
     never goes near the dialog's capped fields. */
  await page.evaluate(() => {
    const KEY = "graphiq:preferences";
    const cur = JSON.parse(localStorage.getItem(KEY) || "{}");
    localStorage.setItem(KEY, JSON.stringify({ ...cur, newDocAsk: false, newDocWidth: 70000, newDocHeight: 100 }));
  });
  await app.boot();
  const prefBefore = await state(app);
  await page.keyboard.press("Control+n");
  await app.settle(1500);
  const prefAfter = await state(app);
  expect({ docs: prefAfter.docs, oversized: prefAfter.oversized }, "a stored default the browser cannot hold is refused").toEqual({
    docs: prefBefore.docs,
    oversized: 0,
  });
  expect(await message(app), "...rather than opening with no pixels").toBeTruthy();
});
