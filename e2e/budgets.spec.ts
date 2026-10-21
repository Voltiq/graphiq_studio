/**
 * The performance budgets follow the device, not the machine they were tuned
 * on. (Ported from tools/verify-budgets.js, TODO 2.1.)
 *
 * Four desktop constants — a 256 MB render cache, 512 MB of history, a 0.5 MP
 * live-filter frame, overlays at the screen's full devicePixelRatio. The
 * device CLASS decides, and the hardware hints only shrink it: an emulated
 * phone reports the HOST's `deviceMemory` and cores, and `deviceMemory` is
 * Chromium-only (undefined on the iPhone, the tightest budget of all). A
 * coarse pointer on a small screen is emulated exactly and true of the device.
 * The hints have their own tests (tests/budgets.test.ts); `bootApp` pins them
 * to a roomy machine so this tests the classes alone — a 4-core CI runner
 * halving the frame once failed "a desktop keeps its budgets" correctly.
 */
import type { Browser } from "@playwright/test";
import { test, expect, bootApp, type App } from "./fixtures";

const DESKTOP = { viewport: { width: 1400, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 3 };
const TABLET = { viewport: { width: 820, height: 1180 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 };

type Budgets = { historyMB: number; draftPixels: number; draftScale: number | null };

async function session(browser: Browser, opts: object, prefs?: object): Promise<App> {
  const ctx = await browser.newContext({ ...opts, baseURL: test.info().project.use.baseURL });
  const page = await ctx.newPage();
  return bootApp(page, prefs ? { storage: { "graphiq:preferences": JSON.stringify(prefs) } } : {});
}

const read = (app: App) =>
  app.page.evaluate(() => {
    const w = window as unknown as {
      __gqBudgets?: () => Budgets;
      __gqRenderCache?: { stats(): { budget: number } };
    };
    const vp = document.querySelector('[data-tour="canvas"]')!;
    const overlays = [...document.querySelectorAll("canvas")]
      .filter((c) => /overlay/i.test(c.className))
      .map((c) => ({ w: c.width, h: c.height, ratio: +(c.width / vp.clientWidth).toFixed(2) }));
    return {
      derived: w.__gqBudgets?.() ?? null,
      /* What the engine will evict beyond: the number the item calls "reported". */
      cacheMB: Math.round(((w.__gqRenderCache?.stats() as unknown as { budget: number })?.budget ?? 0) / 1048576),
      dpr: devicePixelRatio,
      overlays,
      viewportMPx: (vp.clientWidth * vp.clientHeight) / 1e6,
    };
  });

/** A 2 MP document: where the two filter budgets differ (at 12 MP both clamp to 0.25). */
async function prepare(app: App) {
  await app.run("layer-new");
  await app.key("m");
  const box = (await app.page.locator('[data-tour="canvas"]').boundingBox())!;
  await app.page.mouse.move(box.x + 50, box.y + 50);
  await app.page.mouse.down();
  await app.page.mouse.move(box.x + 180, box.y + 140);
  await app.page.mouse.up(); // the ants overlay sizes itself
  await app.page.keyboard.press("Control+n");
  const fields = app.page.locator('[role="dialog"] input[type="number"]');
  await fields.nth(0).fill("2000");
  await fields.nth(1).fill("1000");
  await app.page.locator('[role="dialog"] button', { hasText: /^Create$/ }).first().click();
  await app.settle(2000);
}

test("a desktop keeps its budgets, a phone shrinks them and really works smaller, a tablet sits between", async ({ browser }) => {
  test.slow();
  const d = await session(browser, DESKTOP);
  await prepare(d);
  const desk = await read(d);
  expect(desk.cacheMB, "a desktop keeps 256 MB").toBe(256);
  expect(desk.derived, "...and its history and filter budgets").toMatchObject({ historyMB: 512, draftPixels: 500000 });
  /* A cap, not a constant: a 1× display is not scaled up to meet it. */
  expect(desk.overlays.length).toBeGreaterThanOrEqual(2);
  expect(desk.overlays.every((o) => o.ratio <= 1.01), "...overlays not scaled up").toBe(true);
  expect(d.consoleErrors).toEqual([]);
  await d.page.context().close();

  const p = await session(browser, PHONE);
  await prepare(p);
  const phone = await read(p);
  expect(phone.cacheMB, "a phone gets at most 64 MB of render cache").toBeLessThanOrEqual(64);
  expect(phone.derived!.historyMB, "...less history").toBeLessThan(512);
  expect(phone.derived!.draftPixels, "...a smaller live-filter frame").toBeLessThan(500000);
  /* ...which the ENGINE works at: reading the model alone missed an engine
     reverted to its desktop constant. */
  expect(phone.derived!.draftScale!, "the engine really renders filter frames smaller, same 2 MP document").toBeLessThan(
    desk.derived!.draftScale!,
  );
  /* Both overlays agree at 2 (they used to disagree: ants at 3, grid at 1). */
  expect(phone.overlays.map((o) => o.ratio), `both overlays at a ratio of 2 on a dpr-${phone.dpr} screen`).toEqual(
    phone.overlays.map(() => 2),
  );
  /* Cost goes as the square: each overlay 4× the viewport, not the screen's 9×. */
  for (const o of phone.overlays) expect((o.w * o.h) / 1e6 / phone.viewportMPx, "each overlay ~4× the viewport").toBeLessThan(4.2);
  expect(p.consoleErrors).toEqual([]);
  await p.page.context().close();

  const t = await session(browser, TABLET);
  const tab = await read(t);
  expect(tab.cacheMB, `a tablet between: ${phone.cacheMB} < ${tab.cacheMB} < ${desk.cacheMB}`).toBeGreaterThan(phone.cacheMB);
  expect(tab.cacheMB).toBeLessThan(desk.cacheMB);
  await t.page.context().close();
});

test("a budget the person set is not overridden by the device", async ({ browser }) => {
  /* Deriving a default is not overruling a person. */
  const app = await session(browser, PHONE, { cacheBudgetMB: 512, historyBudgetMB: 512 });
  expect((await read(app)).cacheMB).toBe(512);
  await app.page.context().close();
});
