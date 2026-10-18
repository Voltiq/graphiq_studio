/**
 * Which shell does a given device get? (Ported from tools/verify-breakpoint.js, TODO 2.1.)
 *
 * The breakpoint was `(max-width: 767px)`, wrong in three directions at once:
 * a phone in landscape (844px wide) got the DESKTOP shell on a 390px-tall
 * screen; an iPad mini upright (744px) got the PHONE shell; and a desktop
 * window dragged narrow got touch sizing with a mouse attached. It now asks
 * about the device (`pointer: coarse` and `hover: none`) as well as either
 * dimension being small.
 *
 * Asserted on `document.documentElement.dataset.mobile`, which is what drives
 * the layout — not on the media query alone, which could agree while the
 * attribute never got set.
 *
 * `hasTouch` produces `pointer: coarse` with no hover. Without it a 390px
 * context still reports `pointer: fine`, so width-only tests would test nothing.
 */
import type { Page } from "@playwright/test";
import { test, expect, bootApp } from "./fixtures";

const shellOf = (page: Page) =>
  page.evaluate(() => ({
    shell: document.documentElement.dataset.mobile === "true" ? "mobile" : "desktop",
    coarse: matchMedia("(pointer: coarse)").matches,
    hoverNone: matchMedia("(hover: none)").matches,
    w: window.innerWidth,
    h: window.innerHeight,
  }));

/* name, viewport, the shell it must get. */
type Profile = [string, { width: number; height: number }, "mobile" | "desktop"];
const TOUCH: Profile[] = [
  ["a phone held upright", { width: 390, height: 844 }, "mobile"],
  ["the same phone turned sideways", { width: 844, height: 390 }, "mobile"],
  ["a small phone sideways", { width: 667, height: 375 }, "mobile"],
  ["a tablet held upright", { width: 744, height: 1133 }, "desktop"],
  ["the same tablet sideways", { width: 1133, height: 744 }, "desktop"],
  ["a large screen that happens to have a touchscreen", { width: 1500, height: 950 }, "desktop"],
];
const MOUSE: Profile[] = [
  ["a desktop window dragged narrow", { width: 700, height: 950 }, "desktop"],
  ["an ordinary desktop window", { width: 1500, height: 950 }, "desktop"],
];

/* One page per pointer type — hasTouch cannot change on a live context — with
   the viewport resized within it, which exercises the matchMedia listener
   rather than only the value read at first render. */
for (const [pointer, touch, profiles] of [
  ["a finger", true, TOUCH],
  ["a mouse", false, MOUSE],
] as const) {
  test.describe(`with ${pointer}`, () => {
    test.use({ viewport: { width: 1000, height: 800 }, hasTouch: touch });

    test("each device shape gets the right shell, as the window changes", async ({ app }) => {
      if (touch) {
        /* A malformed media query is not an error: matchMedia parses it to
           "not all" and never matches, pinning every device to desktop. */
        const parsed = await app.page.evaluate(
          () => matchMedia("(pointer: coarse) and (hover: none) and ((max-width: 600px) or (max-height: 500px))").media,
        );
        expect(parsed, "the query is well-formed, not silently parsed away").not.toBe("not all");
      }
      for (const [name, viewport, want] of profiles) {
        await app.page.setViewportSize(viewport);
        await app.settle(500);
        const s = await shellOf(app.page);
        expect
          .soft(s.shell, `${name}: ${s.w}×${s.h}, pointer ${s.coarse ? "coarse" : "fine"}, hover ${s.hoverNone ? "none" : "yes"}`)
          .toBe(want);
      }
      expect(app.consoleErrors).toEqual([]);
    });
  });
}

test.describe("a phone loading sideways from cold", () => {
  // Decided at load, which is the other way it has to be right.
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });

  test("gets the mobile shell too", async ({ app }) => {
    expect((await shellOf(app.page)).shell).toBe("mobile");
  });
});

declare global {
  interface Window {
    __frames?: { mobile: string; toolbar: string | null; canvasW: number | null }[];
    __gqFits?: number;
  }
}

test("the shell is decided before the first paint, and the picture lands centred", async ({ browser, baseURL }) => {
  /* The shell used to be chosen in an effect, so a phone painted the desktop
     layout first — toolbar and dock in flow, canvas measured against what was
     left — and then reflowed. An inline script in <head> settles it first.
     Watched frame by frame from an init script (it runs before the page's own
     scripts) under 6× CPU throttling, so any gap between paint and effect is
     wide enough to catch. */
  const ctx = await browser.newContext({ baseURL, viewport: { width: 390, height: 844 }, hasTouch: true });
  await ctx.addInitScript(() => {
    window.__frames = [];
    const tick = () => {
      const toolbar = document.querySelector('[data-tour="toolbar"]');
      const canvas = document.querySelector('[data-tour="canvas"]');
      window.__frames!.push({
        mobile: document.documentElement.dataset.mobile ?? "",
        /* "static" is the desktop flow; the mobile shell lifts it to "fixed". */
        toolbar: toolbar ? getComputedStyle(toolbar).position : null,
        canvasW: canvas ? canvas.clientWidth : null,
      });
      if (window.__frames!.length < 900) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const page = await ctx.newPage();
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  // The start card stays: dismissing it starts a document, which fits again.
  const app = await bootApp(page, { keepStartCard: true });
  await app.settle(1_500);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  const seen = await page.evaluate(() => {
    const f = window.__frames ?? [];
    const withToolbar = f.filter((x) => x.toolbar);
    return {
      firstMobile: f.length ? f[0].mobile : "(no frames)",
      toolbarFrames: withToolbar.length,
      inFlow: withToolbar.filter((x) => x.toolbar !== "fixed").length,
      widths: [...new Set(f.map((x) => x.canvasW).filter((w) => w))],
      fits: window.__gqFits ?? null,
    };
  });
  expect(seen.firstMobile, "the shell is settled before the first frame runs").toBe("true");
  expect(seen.toolbarFrames, "the toolbar was seen at all").toBeGreaterThan(0);
  expect(seen.inFlow, "no frame paints the toolbar in the desktop flow").toBe(0);
  expect(seen.widths, "the canvas is never measured against a layout that then reflows").toHaveLength(1);
  expect(seen.fits, "the view is fitted once, not fitted and then re-fitted").toBe(1);

  /* Where it has to end up: the picture centred in the stage. This is the
     check that caught a real bug — the stage is momentarily 0px wide during
     the cold load, and a pan clamped against it came back as -80 instead of
     11, parking the picture to the left while every other reading looked
     right. The artwork is asked for by name ([data-artboard]): "the first
     transformed element" once measured a centred status pill instead. */
  const gaps = await page.evaluate(() => {
    const stage = document.querySelector('[data-tour="canvas"] [class*="viewport"]');
    const board = stage?.querySelector("[data-artboard]");
    if (!stage || !board) return null;
    const v = stage.getBoundingClientRect();
    const a = board.getBoundingClientRect();
    return { left: a.left - v.left, right: v.right - a.right, top: a.top - v.top, bottom: v.bottom - a.bottom };
  });
  expect(gaps, "the artwork is in the stage").not.toBeNull();
  expect(Math.abs(gaps!.left - gaps!.right), `centred across (${JSON.stringify(gaps)})`).toBeLessThanOrEqual(1);
  expect(Math.abs(gaps!.top - gaps!.bottom), "centred down").toBeLessThanOrEqual(1);

  /* The other half: the callback that no longer fires on the starting size
     must still fire on a real change, or rotating would leave the view off-centre. */
  await page.setViewportSize({ width: 844, height: 390 });
  await app.settle(800);
  expect(await page.evaluate(() => window.__gqFits ?? null), "rotating the phone re-fits it").toBe(seen.fits! + 1);
  expect(app.errors.concat(app.consoleErrors), "no page or console errors").toEqual([]);
  await ctx.close();
});
