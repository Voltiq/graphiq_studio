/**
 * A panel and the picture it describes, at the same time: the panels sheet.
 * (Ported from tools/verify-panel-sheet.js, TODO 2.1. The chip strip itself
 * is e2e/phone-shell.spec.ts.)
 *
 * The panels began as a 320px drawer down the right of a 390px screen —
 * measured open, 13% of the stage was left — so a panel could never be seen
 * beside the artwork it describes. Height is the axis a phone has to spare, so
 * they are a bottom sheet with three heights.
 *
 *  - At peek the picture keeps the larger share of the screen. (The item's
 *    number was 55%. 3.0 floats the sheet above the tool's options card, so
 *    the card and its keys stay reachable while a panel is open; that costs a
 *    point — 54% at 390×844 — and the assertion is the share, not the digit.)
 *  - The handle snaps to exactly three heights and nothing in between, by tap
 *    and by drag (they fail differently: a drag is the gesture people try, a
 *    tap the one that always works).
 *  - The sheet is usable, not just measurable: a panel opens from inside it,
 *    and the artwork above it stays touchable and undimmed.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const geom = (app: App) =>
  app.page.evaluate(() => {
    const d = document.querySelector('[data-tour="dock"]')!.getBoundingClientRect();
    const s = document.querySelector('[data-tour="canvas"] [class*="viewport"]')!.getBoundingClientRect();
    const opts = document.querySelector('[data-tour="options"]')!.getBoundingClientRect();
    return {
      detent: document.documentElement.dataset.sheet ?? "(none)",
      top: Math.round(d.top),
      bottom: Math.round(d.bottom),
      left: Math.round(d.left),
      right: Math.round(d.right),
      h: Math.round(d.height),
      optionsTop: Math.round(opts.top),
      /* The stage above the sheet: what is still seen of the picture. */
      free: Math.round(Math.max(0, Math.min(s.bottom, d.top) - s.top)),
      vh: innerHeight,
      vw: innerWidth,
    };
  });

const openSheet = async (app: App) => {
  await app.run("layer-new");
  await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
  await expect(app.page.locator("html")).toHaveAttribute("data-drawer", "panels");
  await app.settle(700);
};

test("the sheet opens at half height, as a card above the options, with a handle to hold", async ({ app }) => {
  await openSheet(app);
  const g = await geom(app);
  expect(g.detent, "at the middle height, so a panel and the picture share the screen").toBe("half");
  expect(g.left, "10px in from the left, like every phone surface").toBe(10);
  expect(g.right, "...and from the right").toBe(g.vw - 10);
  expect(g.bottom, "it ends above the options card, whose keys stay reachable").toBeLessThanOrEqual(g.optionsTop);
  const handle = (await app.page.locator("[data-sheet-handle]").boundingBox())!;
  expect(handle.height >= 20 && handle.width > 100, `the handle is a real target: ${handle.width}×${handle.height}`).toBe(true);
});

test("tapping the handle visits three different heights, and at peek the picture keeps the larger share", async ({ app }) => {
  await openSheet(app);
  const handle = app.page.locator("[data-sheet-handle]");
  const seen: Record<string, number> = {};
  let peekFree = 0;
  for (let i = 0; i < 3; i++) {
    await handle.tap();
    await app.settle(600);
    const g = await geom(app);
    seen[g.detent] = g.h;
    if (g.detent === "peek") peekFree = g.free / g.vh;
  }
  expect(Object.keys(seen).sort(), "taps reach all three heights").toEqual(["full", "half", "peek"]);
  expect(new Set(Object.values(seen)).size, `...three DIFFERENT heights: ${JSON.stringify(seen)}`).toBe(3);
  expect(peekFree, "at peek more of the screen is picture than anything else").toBeGreaterThan(0.5);
});

test("dragging the handle snaps to a height, up and down", async ({ app }) => {
  await openSheet(app);
  const handle = app.page.locator("[data-sheet-handle]");
  const heights: Record<string, number> = {};
  for (let i = 0; i < 3; i++) {
    await handle.tap();
    await app.settle(600);
    const g = await geom(app);
    heights[g.detent] = g.h;
  }
  expect(await app.setSheetDetent("half")).toBe(true);
  const before = await geom(app);
  const drag = async (dy: number) => {
    const b = (await handle.boundingBox())!;
    const x = Math.round(b.x + b.width / 2);
    const y = Math.round(b.y + b.height / 2);
    await app.touchDown(x, y);
    await app.touchMove(x, y + dy, 16);
    await app.touchUp();
    await app.settle(700);
    return geom(app);
  };
  /* Far enough to clear the midpoint between half and full: a shorter drag
     correctly snaps back to half and reads as "dragging does nothing". */
  const up = await drag(-320);
  expect(up.h, "dragging up makes it taller").toBeGreaterThan(before.h);
  expect(Math.abs(up.h - heights[up.detent]), `...landing ON a detent: ${up.detent} at ${up.h}px`).toBeLessThanOrEqual(2);
  const down = await drag(288);
  expect(down.h, "dragging down makes it shorter").toBeLessThan(up.h);
  expect(Math.abs(down.h - heights[down.detent]), `...and snaps too: ${down.detent} at ${down.h}px`).toBeLessThanOrEqual(2);
});

test("a panel opens from inside the sheet, and the picture above it stays live", async ({ app }) => {
  await openSheet(app);
  expect(await app.openPanelById("history"), "a chip opens its panel").toBe(true);
  const live = await app.page.evaluate(() => {
    const stage = document.querySelector('[data-tour="canvas"] [class*="viewport"]')!.getBoundingClientRect();
    const dock = document.querySelector('[data-tour="dock"]')!.getBoundingClientRect();
    const y = Math.round(Math.min(stage.bottom, dock.top) - 40);
    const hit = document.elementFromPoint(Math.round(stage.left + stage.width / 2), y);
    const scrim = document.querySelector(".gq-m-scrim");
    return {
      inCanvas: !!hit?.closest('[data-tour="canvas"]'),
      /* Visibility, not existence: the scrim is rendered for the tools drawer. */
      scrim: !!scrim && getComputedStyle(scrim).display !== "none",
    };
  });
  expect(live, "the artwork above the sheet takes a tap, and nothing dims it").toEqual({ inCanvas: true, scrim: false });
});

/* One panel at a time (ported from tools/verify-panel-accordion.js). With the
   desktop's defaults the sheet once held 4086px — the Layers header 3488px
   down it, four of sixteen panels reachable at any height. One panel showing
   answers that, and "a height that suits the panel" falls out of it: the sheet
   grows to fit what was just opened, and never shrinks under you — someone who
   made it tall meant it. (The chip strip itself: phone-shell.spec.) */
test("opening a tall panel raises the sheet; opening a short one never lowers it", async ({ app }) => {
  await openSheet(app);
  expect(await app.setSheetDetent("peek")).toBe(true);
  const atPeek = await geom(app);
  expect(await app.openPanelById("adjustments"), "the tall one").toBe(true);
  await app.settle(600);
  const grown = await geom(app);
  /* A detent, not a pixel: the first version compared heights, and passed on
     a 1px wobble (151 → 152) while the sheet stayed at peek — the grow had
     been measuring a body still unfolding from nothing. */
  expect(grown.detent, "it grows to fit: off peek").not.toBe("peek");
  expect(grown.h, `...a real step taller: ${atPeek.h} → ${grown.h}`).toBeGreaterThan(atPeek.h + 100);
  expect(await app.setSheetDetent("full")).toBe(true);
  const atFull = await geom(app);
  expect(await app.openPanelById("info"), "a short one").toBe(true);
  await app.settle(600);
  expect((await geom(app)).h, "...does not shrink it under you").toBeGreaterThanOrEqual(atFull.h);
  expect(
    await app.page.evaluate(() => [...document.querySelectorAll("[data-panel-id][data-open='true']")].length),
    "one panel shows",
  ).toBe(1);
});

test("the phone's one-at-a-time never flattens the desktop's saved layout", async ({ app }) => {
  /* In ONE context, resized: a fresh desktop context could never see what the
     phone wrote to storage, and the first version of this passed with the
     phone overwriting the layout — asserting the desktop's defaults back to
     itself. */
  await openSheet(app);
  for (const id of ["layers", "info", "channels"]) expect(await app.openPanelById(id)).toBe(true);
  await app.page.setViewportSize({ width: 1400, height: 900 });
  await app.settle(1500);
  const open = await app.page.evaluate(() => document.querySelectorAll("[data-panel-id][data-open='true']").length);
  /* The desktop opens Color and Layers (3.0's defaults); the phone left one. */
  expect(open, "resizing up finds the desktop's panels open, not the phone's one").toBeGreaterThanOrEqual(2);
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 }, hasTouch: false });

  test("several panels open at once, and opening one more closes none", async ({ app }) => {
    const openCount = () => app.page.evaluate(() => document.querySelectorAll("[data-panel-id][data-open='true']").length);
    const before = await openCount();
    expect(before, "more than one open by default (Color and Layers)").toBeGreaterThanOrEqual(2);
    expect(await app.openPanelById("channels")).toBe(true);
    expect(await openCount(), "one more, the others kept").toBe(before + 1);
  });
});
