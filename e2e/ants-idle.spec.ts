/**
 * The overlay loop stops animating when nobody is looking, without losing the
 * picture. (Ported from tools/verify-ants-idle.js, TODO 2.1.)
 *
 * Measured before: a selection left alone re-armed requestAnimationFrame 722
 * times in three seconds, for as long as it existed — a frame of work every
 * four milliseconds to march a dashed line. Parked is not stopped, though: the
 * loop's own exit CLEARS the overlay, right when there is nothing to show and
 * wrong when there is. So both halves are asserted — no frames AND the outline
 * still on screen, unchanged.
 *
 * "Animating" is judged by the pattern MOVING and frames still coming, not by
 * a frame count: CI measured 12 frames in 700ms where a desktop gives 40+, and
 * a threshold of 20 failed a loop that was animating correctly. Parked is
 * exactly zero frames either way.
 */
import { test, expect, bootApp, type App } from "./fixtures";

test.use({ viewport: { width: 1400, height: 900 } });

/** Count rAF callbacks, and fingerprint what the overlays paint. */
const PROBE = () => {
  const w = window as unknown as { __raf: number; __ants: () => { painted: number; sum: number } };
  w.__raf = 0;
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (cb) =>
    orig((t) => {
      w.__raf++;
      return cb(t);
    });
  /* A COUNT and a position-weighted CHECKSUM: marching ants shift the phase of
     a 4-on-4-off dash and the lit-pixel count is the same at most phases (the
     first version "saw" motion as 1317 → 1317). */
  w.__ants = () => {
    let best = { painted: 0, sum: 0 };
    for (const ov of [...document.querySelectorAll("canvas")].filter((c) => /overlay/i.test(c.className))) {
      try {
        const d = ov.getContext("2d")!.getImageData(0, 0, ov.width, ov.height).data;
        let n = 0;
        let sum = 0;
        for (let i = 3, px = 0; i < d.length; i += 4, px++)
          if (d[i] > 0) {
            n++;
            sum = (sum + px * 31 + d[i]) % 2147483647;
          }
        if (n > best.painted) best = { painted: n, sum };
      } catch {
        // a dead or tainted canvas is not the overlay we are after
      }
    }
    return best;
  };
};

type W = { __raf: number; __ants: () => { painted: number; sum: number } };
const PARK_WAIT = 2600; // the loop parks after 2s idle

/** rAF callbacks over `ms`, and what is painted at the end of it. */
const sample = async (app: App, ms: number) => {
  await app.page.evaluate(() => ((window as unknown as W).__raf = 0));
  await app.page.waitForTimeout(ms);
  return app.page.evaluate(() => ({ raf: (window as unknown as W).__raf, ants: (window as unknown as W).__ants() }));
};
const ants = (app: App) => app.page.evaluate(() => (window as unknown as W).__ants());

test("a selection's ants march while someone is there, park when left, and wake on a move or a key", async ({ page }) => {
  test.slow(); // several multi-second quiet spells
  await page.addInitScript(PROBE);
  const app = await bootApp(page);
  await app.run("layer-new");

  const empty = await sample(app, 1500);
  expect(empty, "with nothing on the overlay the loop does not run at all").toEqual({ raf: 0, ants: { painted: 0, sum: 0 } });

  await app.key("m");
  const box = (await page.locator('[data-tour="canvas"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  await app.settle(300);
  const a = await ants(app);
  const fresh = await sample(app, 700);
  expect(fresh.ants.painted, "a selection just made is drawn").toBeGreaterThan(0);
  expect(fresh.raf, "...and animates: frames keep coming").toBeGreaterThan(5);
  expect(fresh.ants.sum, "...and the dashes travel").not.toBe(a.sum);

  await page.waitForTimeout(PARK_WAIT);
  const parked = await sample(app, 3000);
  expect(parked.raf, "left alone, the loop stops (722 frames in 3s before)").toBe(0);
  expect((await sample(app, 3000)).raf, "...and stays stopped").toBe(0);
  expect(parked.ants.painted, "...while the outline is still on screen: parked, not cleared").toBeGreaterThan(0);
  expect(await ants(app), "...and frozen, not just un-redrawn").toEqual(parked.ants);

  await page.mouse.move(box.x + 320, box.y + 300);
  const woken = await sample(app, 800);
  expect(woken.raf, "one movement of the pointer brings it back").toBeGreaterThan(5);
  expect(woken.ants.sum, "...and the ants march again").not.toBe(parked.ants.sum);

  await page.waitForTimeout(PARK_WAIT);
  expect((await sample(app, 1500)).raf, "it parks again after the next quiet spell").toBe(0);
  await page.keyboard.press("Shift");
  expect((await sample(app, 800)).raf, "...and a key wakes it, not only the mouse").toBeGreaterThan(5);

  /* A hidden tab has nothing to animate for; what is ours to check is that the
     overlay survives the round trip rather than being cleared on the way out. */
  const other = await page.context().newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await page.waitForTimeout(1200);
  await page.bringToFront();
  await app.settle(400);
  expect((await ants(app)).painted, "back from a background tab, the selection is still drawn").toBeGreaterThan(0);
  await other.close();

  await page.keyboard.press("Control+d");
  await app.settle(1200);
  expect((await ants(app)).painted, "deselecting still clears the overlay").toBe(0);
  expect(app.errors, "no page errors").toEqual([]);
  expect(app.consoleErrors, "no console errors").toEqual([]);
});
