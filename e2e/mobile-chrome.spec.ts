/**
 * What the phone spends on chrome.
 * (Ported from tools/verify-mobile-chrome.js, TODO 2.1. The 3.0 header, chip
 * and dock themselves are e2e/phone-shell.spec.ts.)
 *
 * Measured at 390×844 before the work: 154px of chrome above the artwork — a
 * 48px top bar, a 48px options bar, 36px of tab strip showing ONE tab, 22px of
 * ruler — and 56px below, leaving 634px to draw in. The item asked for 620;
 * the number that shows the work is the one beside it. And the readouts the
 * phone shell was said to delete must still be there, somewhere a person can
 * read them. (The pre-3.0 zoom pill and three-destination bar are gone by
 * design: the readout chip fits the picture, the dock carries the tools.)
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const budget = (app: App) =>
  app.page.evaluate(() => {
    const box = (sel: string) => {
      const e = document.querySelector(sel);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return { y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom) };
    };
    const stage = document.querySelector('[class*="stageWrap"]')!.getBoundingClientRect();
    const dock = document.querySelector('[data-tour="mobilebar"]');
    return {
      tabs: box("[data-tabs]"),
      ruler: box('[class*="rulerH"]'),
      status: box('[data-tour="status"]'),
      drawable: Math.round((dock ? dock.getBoundingClientRect().top : innerHeight) - stage.top),
    };
  });

/** The header's document button, whose name carries the save state. */
const docButton = (app: App) => app.page.locator('header button[aria-label$="document menu"]');

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("one document spends nothing on tabs, rulers or a status bar, and leaves 690px to draw in", async ({ app }) => {
    const b = await budget(app);
    expect(b.tabs?.h ?? 0, "no tab strip for a single document").toBe(0);
    expect(b.ruler?.h ?? 0, "the ruler is off by default").toBe(0);
    expect(b.status?.h ?? 0, "the desktop status bar stays hidden").toBe(0);
    expect(b.drawable, "the item's contract: 620px of stage").toBeGreaterThanOrEqual(620);
    expect(b.drawable, "...and the reclaim is real (634 before)").toBeGreaterThanOrEqual(690);
  });

  test("the readouts are there: size and zoom on the chip, the name and save state in the header", async ({ app }) => {
    const chip = await app.page.evaluate(() => ({
      size: document.querySelector("[data-status-size]")?.textContent?.trim() ?? null,
      zoom: document.querySelector("[data-status-zoom]")?.textContent?.trim() ?? null,
    }));
    expect(chip.size, "the document's size").toMatch(/\d+\s*×\s*\d+/);
    expect(chip.zoom, "the zoom").toMatch(/^\d+%$/);
    await expect(docButton(app), "the document's name").toHaveAccessibleName(/^Untitled-\d/);

    /* From SAVED to unsaved, which needs a saved state to start from: a blank
       document is unsaved from the start, so "unsaved after an edit" passes on
       a readout hard-wired to it. An autosave is forced first (the
       visibilitychange path autosave.spec drives), then the edit. */
    await app.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await app.settle(1600);
    await app.page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(docButton(app), "an autosave shows the work as saved").not.toHaveAccessibleName(/unsaved/);
    await app.run("layer-new"); // a real edit
    await expect(docButton(app), "...and it flips back the moment something is edited").toHaveAccessibleName(/unsaved/);
  });

  test("a second document brings the tab strip back", async ({ app }) => {
    await app.newDoc();
    const tabs = await app.page.evaluate(() => {
      const e = document.querySelector("[data-tabs]");
      return { h: e ? Math.round(e.getBoundingClientRect().height) : 0, count: e?.getAttribute("data-count") };
    });
    expect(tabs.h, "the strip is back").toBeGreaterThan(0);
    expect(tabs.count).toBe("2");
  });

  test.describe("with rulers chosen before", () => {
    test.use({
      storage: {
        "pe-view": JSON.stringify({
          rulers: true,
          grid: false,
          snap: true,
          docgrid: false,
          guides: true,
          lockguides: false,
          smartguides: true,
        }),
      },
    });

    test("a stored ruler preference still wins on a phone", async ({ app }) => {
      expect((await budget(app)).ruler?.h ?? 0, "the off-by-default is a default, not an override").toBeGreaterThan(0);
    });
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("the desktop keeps its status readouts and has no phone chip", async ({ app }) => {
    const b = await budget(app);
    expect(b.status?.h ?? 0, "its status readouts").toBeGreaterThan(0);
    expect(await app.page.locator("[data-mobile-status]").count(), "no phone readout").toBe(0);
  });
});

/* At 390 the stage's own 10px inset and the fit's rounding happen to clear
   the strips anyway (an inset-free fit still passed there); at 360 — a common
   Android width — only the fit's strip inset does. */
for (const width of [390, 360]) {
  test.describe(`on a ${width}px phone`, () => {
    test.use({ viewport: { width, height: 800 }, hasTouch: true, isMobile: true });

    test("the fitted artwork opens clear of the edge-swipe strips, so its edges take a press", async ({ app }) => {
      /* Reclaiming the ruler moved the artwork into the strips, which only stand
         aside once a pointer is already on the canvas: the Crop corner at x=13
         could not be grabbed. fit() insets by --edge-strip. */
      const e = await app.page.evaluate(() => {
        const board = document.querySelector("[data-artboard]")!.getBoundingClientRect();
        const at = (x: number) => {
          const el = document.elementFromPoint(Math.round(x), Math.round(board.top + board.height / 2));
          if (!el) return "nothing";
          if (el.closest(".gq-m-edge")) return "an edge strip";
          return el.closest('[data-tour="canvas"]') ? "the canvas" : el.tagName.toLowerCase();
        };
        return {
          left: board.left,
          right: innerWidth - board.right,
          strip: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--edge-strip")) || 0,
          atLeft: at(board.left + 2),
          atRight: at(board.right - 2),
        };
      });
      expect(e.strip, "the strips exist on a phone").toBeGreaterThan(0);
      expect(e.left >= e.strip && e.right >= e.strip, `clear of ${e.strip}px a side: ${e.left} / ${e.right}`).toBe(true);
      expect([e.atLeft, e.atRight], "a press at its own edge reaches the canvas").toEqual(["the canvas", "the canvas"]);
    });
  });
}
