/**
 * The shell's size: does it fill exactly the part of the screen you can see?
 * (Ported from tools/verify-viewport.js, TODO 2.1. Its source check — the
 * shell asks for `100svh` and `100%` — is tests/shell-viewport-source.test.ts.)
 *
 * `.app` was `height: 100vh; width: 100vw`. On a phone `vh` is the LARGE
 * viewport — the height with the URL bar retracted — so with the bar showing
 * the shell was taller than the visible area. It is now `100svh` (the small
 * viewport) and `100%` (which, unlike `100vw`, excludes a classic scrollbar).
 *
 * WHAT THIS CAN AND CANNOT SHOW. In a desktop Chromium `vh`, `svh`, `lvh` and
 * `dvh` all resolve to the SAME number, and nothing in the protocol makes them
 * diverge — there is no collapsing toolbar to emulate. So no geometric check
 * here can tell `100vh` from `100svh`; that is the source check's job. What the
 * geometry DOES catch is the unit failing to apply at all (a typo, a browser
 * without `svh`), which collapses the shell to its content height.
 *
 * A virtual keyboard cannot be emulated either. Page scale can, and produces
 * the same reading: visualViewport.height drops below innerHeight while the
 * layout viewport is unchanged — exactly what the overlays subtract. Those
 * tests click through the DOM rather than the mouse, so nothing depends on how
 * input coordinates map while the page is scaled.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const shell = (page: Page) =>
  page.evaluate(() => {
    /* The flex column holding the whole editor: the one child of body that
       contains the canvas. */
    let el: Element | null = document.querySelector('[data-tour="canvas"]');
    while (el && el.parentElement !== document.body) el = el.parentElement;
    const r = el!.getBoundingClientRect();
    const se = document.scrollingElement ?? document.documentElement;
    const bar = document.querySelector('[data-tour="mobilebar"]');
    return {
      top: Math.round(r.top),
      height: Math.round(r.height),
      width: Math.round(r.width),
      inner: window.innerHeight,
      innerW: window.innerWidth,
      visual: Math.round(window.visualViewport!.height),
      supportsSvh: CSS.supports("height", "100svh"),
      scrollH: se.scrollHeight,
      scrollW: se.scrollWidth,
      bar: bar ? Math.round(bar.getBoundingClientRect().bottom) : null,
    };
  });

test.describe("phone", () => {
  // `hasTouch` matters: the mobile shell is chosen by a coarse-pointer query.
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the shell fills exactly the visible viewport, and nothing scrolls", async ({ app }) => {
    const s = await shell(app.page);
    expect(s.supportsSvh, "the browser understands the small-viewport unit").toBe(true);
    expect({ top: s.top, height: s.height }, "as tall as what is visible").toEqual({ top: 0, height: s.visual });
    expect(s.height, "...which is the layout viewport here").toBe(s.inner);
    expect(s.width, "as wide, without a scrollbar's worth of overflow").toBe(s.innerW);
    expect(s.scrollH, "no vertical scroll").toBeLessThanOrEqual(s.inner);
    expect(s.scrollW, "no horizontal scroll").toBeLessThanOrEqual(s.innerW);
    expect(s.bar, "the bottom bar's last row is on screen").not.toBeNull();
    expect(s.bar!).toBeLessThanOrEqual(s.inner);
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1500, height: 950 } });

  test("the shell still fills its window exactly, and does not scroll", async ({ app }) => {
    const s = await shell(app.page);
    expect({ top: s.top, w: s.width, h: s.height }).toEqual({ top: 0, w: s.innerW, h: s.inner });
    expect(s.scrollH).toBeLessThanOrEqual(s.inner);
    expect(s.scrollW).toBeLessThanOrEqual(s.innerW);
  });

  /** What is visible, the keyboard inset the app derived, and where the open overlays sit. */
  const band = (page: Page) =>
    page.evaluate(() => {
      const vv = window.visualViewport!;
      const cs = getComputedStyle(document.documentElement);
      const box = (el: Element | null) => {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
      };
      const dialog = document.querySelector('[role="dialog"]');
      /* Is the dialog's last button pressable where it now sits? */
      const primary = dialog ? [...dialog.querySelectorAll("button")].at(-1) : undefined;
      let reachable: boolean | null = null;
      if (primary) {
        const r = primary.getBoundingClientRect();
        const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
        reachable = !!hit && (hit === primary || primary.contains(hit));
      }
      return {
        inner: window.innerHeight,
        vvH: Math.round(vv.height),
        vvTop: Math.round(vv.offsetTop),
        bandBottom: Math.round(vv.offsetTop + vv.height),
        kbInset: cs.getPropertyValue("--kb-inset").trim(),
        dialog: box(dialog),
        listbox: box(document.querySelector('[role="listbox"]')),
        primaryReachable: reachable,
      };
    });

  /** Open a dialog through the command palette. */
  async function viaPalette(app: App, query: string): Promise<void> {
    const { page } = app;
    await page.click('button[aria-label="Open the command palette"]');
    await app.settle(400);
    await page.keyboard.type(query);
    await app.settle(500);
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="dialog"]', { timeout: 5_000 });
    await app.settle(500);
  }
  const scale = async (app: App, factor: number) => {
    await app.cdp("Emulation.setPageScaleFactor", { pageScaleFactor: factor });
    await app.settle(500);
  };

  test("when the visible area shrinks, an open dialog shrinks back inside it", async ({ app }) => {
    const { page } = app;
    expect((await band(page)).kbInset, "at rest nothing is hidden below the fold").toBe("0px");
    await viaPalette(app, "preferences");
    const opened = await band(page);
    expect(opened.dialog, "a dialog is open").not.toBeNull();
    expect(opened.dialog!.bottom, "...inside the viewport").toBeLessThanOrEqual(opened.bandBottom);

    await scale(app, 2); // shrink what is visible, as a keyboard would
    const shrunk = await band(page);
    const expected = shrunk.inner - shrunk.vvH - shrunk.vvTop;
    expect(expected, "the stand-in really hides part of the layout viewport").toBeGreaterThan(0);
    expect(shrunk.kbInset, "the hook reports what the keyboard would be covering").toBe(`${expected}px`);
    expect(shrunk.dialog!.bottom, "the dialog ends inside the visible band").toBeLessThanOrEqual(shrunk.bandBottom);
    expect(shrunk.dialog!.top, "...and starts inside it").toBeGreaterThanOrEqual(shrunk.vvTop);
    expect(shrunk.primaryReachable, "its last button can still be pressed").toBe(true);

    await scale(app, 1);
    const back = await band(page);
    expect({ inset: back.kbInset, h: back.dialog?.height }, "restoring puts it all back").toEqual({
      inset: "0px",
      h: opened.dialog!.height,
    });
  });

  test("a dropdown opened while the visible area is short stays inside it", async ({ app }) => {
    /* Canvas Size focuses a text field on open — the thing that raises a
       keyboard — and carries a dropdown. Squeezed to 3×: at a gentler scale the
       menu fits below its trigger either way, and the script's version stayed
       green with the menu placed against the layout viewport (a mutation
       proved it). */
    const { page } = app;
    await viaPalette(app, "canvas size");
    await scale(app, 3);
    const anchor = await page.evaluate(() => {
      const t = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button[aria-haspopup="listbox"]')].find(
        (b) => b.getBoundingClientRect().width > 0,
      );
      if (!t) return null;
      const r = t.getBoundingClientRect();
      t.click();
      return { bottom: Math.round(r.bottom) };
    });
    expect(anchor, "the dialog has a dropdown").not.toBeNull();
    await app.settle(450);
    const b = await band(page);
    expect(b.listbox, "the menu opened").not.toBeNull();
    // Non-vacuity: below its trigger, the menu would NOT have fitted.
    expect(anchor!.bottom + 4 + b.listbox!.height, "placement had to react").toBeGreaterThan(b.bandBottom);
    expect(b.listbox!.bottom, `inside the band ${b.vvTop}…${b.bandBottom}`).toBeLessThanOrEqual(b.bandBottom);
    expect(b.listbox!.top).toBeGreaterThanOrEqual(b.vvTop);
    await scale(app, 1);
  });
});
