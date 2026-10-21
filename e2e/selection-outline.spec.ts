/**
 * The ants of a many-row selection are traced once, from its raster, and kept
 * with the selection (TODO 1.3 slice 2).
 *
 * A selection set from outside the canvas — Select ▸ Inverse, a loaded channel,
 * Modify, one brought back by undo — arrived with no traced outline, and the
 * canvas traced one as a union of its rects: cubic in their number. Measured
 * before the change: Inverse of an ellipse drawn across the document froze the
 * main thread for 2.2 s, and undo + redo for another 1.25 s and 2.2 s.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** Long main-thread tasks (ms) observed from now on. */
const watchLongTasks = (app: App) =>
  app.page.evaluate(() => {
    const w = window as unknown as { __long: number[]; __longObs?: PerformanceObserver };
    w.__long = [];
    w.__longObs?.disconnect();
    w.__longObs = new PerformanceObserver((l) => {
      for (const e of l.getEntries()) w.__long.push(Math.round(e.duration));
    });
    w.__longObs.observe({ type: "longtask", buffered: false });
  });
const longest = (app: App) =>
  app.page.evaluate(() => Math.max(0, ...(window as unknown as { __long: number[] }).__long));

/** Painted pixels on the overlay canvases — where the ants are drawn. */
const overlayInk = (app: App) =>
  app.page.evaluate(() => {
    let n = 0;
    for (const ov of [...document.querySelectorAll("canvas")].filter((c) => /overlay/i.test(c.className))) {
      try {
        const d = ov.getContext("2d")!.getImageData(0, 0, ov.width, ov.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
      } catch {
        /* not an overlay we can read */
      }
    }
    return n;
  });

test("Select ▸ Inverse of a large ellipse, its undo and redo, never freeze the page", async ({ app }) => {
  const { page } = app;
  await app.run("layer-new");
  await app.key("m");
  await page.locator('[aria-label="Elliptical marquee"], [data-tip="Elliptical marquee"]').first().click();
  const b = await app.canvasBox();
  await page.mouse.move(b.x + b.width * 0.05, b.y + b.height * 0.05);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width * 0.95, b.y + b.height * 0.95, { steps: 6 });
  await page.mouse.up();
  await app.settle(800);
  await app.key("b"); // the brush: no transform box, so any ink is the ants
  await watchLongTasks(app);
  await app.run("select-inverse");
  await app.settle(1500);
  const inverse = await longest(app);
  expect(await overlayInk(app), "the inverse has its ants").toBeGreaterThan(500);
  await watchLongTasks(app);
  await app.run("undo");
  await app.run("redo");
  await app.settle(1500);
  const back = await longest(app);
  console.log(`longest task: inverse ${inverse} ms, undo+redo ${back} ms`);
  // Before: 2211 ms and 2227 ms. Now ~320 ms — the inverse itself, which was
  // there before too — and nothing. A slower CI machine gets ample room.
  expect(inverse, "Inverse traced its outline without freezing").toBeLessThan(1200);
  expect(back, "...and undo / redo back to it reuse the trace").toBeLessThan(600);
});
