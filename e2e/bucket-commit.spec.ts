/**
 * A committed paint-bucket fill keeps the colour it was committed with.
 * (Ported from tools/verify-bucket-commit.js, TODO 2.1.)
 *
 * Measured before: fill a layer red, keep the bucket, pick green — the fill
 * turned green, with no click, no history step, nothing on screen. A bucket
 * fill stays LIVE after the click (tolerance, contiguity, anti-alias and
 * opacity can be auditioned against it), and that re-run read the foreground
 * at render time, from an effect that also re-ran ON a colour change.
 *
 * Dropping the colours from the effect's dependencies is not enough — the
 * re-run still READ the live foreground, so nudging tolerance turned it green
 * a click further from the cause. The colour is frozen into the handle at
 * commit. And "the fill did not change" also passes if the re-run stopped
 * happening (deleting the feature), so the option nudged is OPACITY, whose
 * effect on the pixel is asserted in the same breath.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The document's centre pixel, as "r,g,b,a". */
const centre = (app: App) =>
  app.page.evaluate(() => {
    const c = [...document.querySelectorAll<HTMLCanvasElement>('[data-tour="canvas"] canvas')].find((x) => /view/i.test(x.className))!;
    return [...c.getContext("2d")!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data].join(",");
  });
const setFg = async (app: App, hex: string) => app.setForeground(hex);
const hue = (px: string) => px.split(",").slice(0, 3).join(",");

test("a committed fill keeps its colour, re-runs live in that colour, and undoes in one step", async ({ app }) => {
  const { page } = app;
  await app.run("layer-new");
  await app.pickTool("Paint bucket");
  const box = (await page.locator('[data-tour="canvas"]').boundingBox())!;
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  const empty = await centre(app);
  await setFg(app, "#ff0000");
  await page.mouse.click(cx, cy);
  await app.settle(900);
  const filled = await centre(app);
  expect(filled, "a bucket fill puts the foreground on the layer").toBe("255,0,0,255");
  await setFg(app, "#00ff00");
  await app.settle(600);
  expect(await centre(app), "changing the foreground afterwards does not repaint it").toBe(filled);

  /* One step removed: an option re-runs the fill. Opacity, because its effect
     is visible — "nothing changed" cannot pass for "safe". */
  expect(await app.setRange("Opacity", 40)).toBe(true);
  await app.settle(900);
  const faded = await centre(app);
  expect(faded, "the fill is still live: an option re-runs it").not.toBe(filled);
  expect(hue(faded), "...in the colour it was committed with, not the picker's").toBe("255,0,0");

  /* The colour change is not a step of its own: one Undo lands on the empty canvas. */
  await page.evaluate(() => window.graphiq!.undo());
  await app.settle(900);
  expect(await centre(app), "one Undo removes the fill entirely").toBe(empty);
});

test("before release a fill still takes the colour picked, and is frozen from the moment it lands", async ({ app }) => {
  /* Before release there is nothing committed to protect, and auditioning a
     colour is the point: what is in the picker at release is what lands. */
  const { page } = app;
  await app.run("layer-new");
  await app.pickTool("Paint bucket");
  const box = (await page.locator('[data-tour="canvas"]').boundingBox())!;
  await setFg(app, "#ff0000");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await app.settle(500);
  await setFg(app, "#0000ff");
  await app.settle(500);
  await page.mouse.up();
  await app.settle(900);
  const landed = await centre(app);
  expect(landed, "held with red, picked blue, released → blue").toBe("0,0,255,255");
  await setFg(app, "#ffff00");
  await app.settle(600);
  expect(await centre(app), "...and frozen from then on").toBe(landed);
});
