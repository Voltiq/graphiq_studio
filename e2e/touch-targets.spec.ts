/**
 * Sliders and colour strips a finger can actually hit. (Ported from tools/verify-touch-targets.js, TODO 2.1.)
 *
 * A range input IS the hit target — not its thumb — and it was 4px tall, about
 * a tenth of what a fingertip reliably lands on; the hue and alpha strips were
 * 10px. Both are used everywhere (the slider alone has ~220 call sites), so the
 * fix is one rule each rather than 220 edits: padding grows the reachable box
 * while the background, clipped to the content box, keeps the visible track
 * where it was.
 *
 * The check that matters is not the height but whether a touch LANDS: a 24px
 * box with something on top of it is no use. So the hit test is done with
 * elementFromPoint at the extremes of the new box, and then by dragging it —
 * with a finger here; the script this came from dragged with the mouse.
 *
 * Desktop is asserted unchanged: the padding is deliberately touch-only, since
 * the same rule there would make every row holding a slider 20px taller.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The first range input fully on screen — horizontally too: the options bar
 *  scrolls sideways, and the first one in the DOM once sat at x=613 on a 390px
 *  phone, so every hit test missed it and read as "covered". */
const visibleSlider = (page: Page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')].find((i) => {
      const r = i.getBoundingClientRect();
      return r.width > 20 && r.height > 0 && r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth;
    });
    if (!el) return null;
    el.setAttribute("data-probe", "1");
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), w: Math.round(r.width), h: Math.round(r.height) };
  });
const probeValue = (page: Page) => page.evaluate(() => document.querySelector<HTMLInputElement>('input[data-probe="1"]')!.value);

async function openPanels(app: App): Promise<void> {
  await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
  await app.settle(900);
  await app.setSheetDetent("full");
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("a slider's box is finger-sized, a touch near it lands on it, and a finger drag moves it", async ({ app }) => {
    const { page } = app;
    await app.run("layer-new");
    await openPanels(app);
    /* The NAVIGATOR's zoom slider: the Colour panel has no range input (its hue
       and alpha are custom elements), and the sheet is an accordion. */
    expect(await app.openPanelById("navigator"), "the Navigator opens").toBe(true);
    const s = await visibleSlider(page);
    expect(s, "a slider is on screen to measure").not.toBeNull();
    expect(s!.h, "its box is at least 24px tall").toBeGreaterThanOrEqual(24);
    const hits = await page.evaluate(
      ({ x, y }) => [-10, 0, 10].map((dy) => document.elementFromPoint(x, y + dy) === document.querySelector('input[data-probe="1"]')),
      s!,
    );
    expect(hits, "a touch 10px above, on, and below the centre all reach it").toEqual([true, true, true]);
    const before = await probeValue(page);
    await app.touchDown(s!.x - 40, s!.y);
    await app.touchMove(s!.x + 40, s!.y, 8);
    await app.touchUp();
    await app.settle(500);
    expect(await probeValue(page), `a finger drag across it changes the value (was ${before})`).not.toBe(before);
  });

  test("the colour picker's strips are finger-sized", async ({ app }) => {
    await app.run("layer-new");
    await openPanels(app);
    expect(await app.openPanelById("color"), "the Colour panel opens").toBe(true);
    const strips = await app.page.evaluate(() =>
      /* The strips themselves: `.alphaTrack` and the handles also match a loose
         "hue|alpha" search and are not hit targets — measuring those reported
         a 10px strip that does not exist. */
      [...document.querySelectorAll('[class*="hue"], [class*="alpha"]')]
        .filter((el) => !/track|handle|checker/i.test(el.className.toString()))
        .map((el) => Math.round(el.getBoundingClientRect().height))
        .filter((h) => h > 0),
    );
    expect(strips.length, "the strips are on screen").toBeGreaterThan(0);
    for (const h of strips) expect(h, `strip heights ${strips.join(", ")}`).toBeGreaterThanOrEqual(24);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("the slider keeps its original slim box", async ({ app }) => {
    await app.run("layer-new");
    await app.openPanelById("navigator");
    const s = await visibleSlider(app.page);
    expect(s, "a slider is on screen").not.toBeNull();
    expect(s!.h, "the touch padding is not applied").toBeLessThan(24);
  });
});
