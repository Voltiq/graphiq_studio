/**
 * Panning without giving up the tool. (Ported from tools/verify-pan-mode.js, TODO 2.1.)
 *
 * Every drawing and selection tool consumes the one-finger drag, so on a phone
 * moving the picture meant switching to the Hand tool and back for each
 * adjustment. A Pan chip in the bottom bar takes that drag instead, and leaves
 * the selected tool exactly as it was.
 *
 * Both halves are asserted every time, because either alone is satisfiable by
 * something broken: a mode that pans but also paints is no better than before,
 * and one that paints nothing while not panning is a dead canvas.
 *
 * Driven with a FINGER as well as a mouse: the script used only the mouse,
 * which in a touch context still reports `pointerType: "mouse"`, and
 * tools/mobile.js (now e2e/mobile-profile.spec.ts) listed it among the touch rails that never touched.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const panChip = (page: Page) => page.locator('[data-tour="mobilebar"] button', { hasText: "Pan" }).first();
const activeTool = (page: Page) =>
  page.evaluate(() => document.querySelector('[data-tour="toolbar"] button[aria-pressed="true"]')?.getAttribute("aria-label") ?? "?");
/** Where the artwork sits in the stage — what a pan moves. By name: "the
 *  first transformed element" once measured a centred status pill instead. */
const artworkAt = (page: Page) =>
  page.evaluate(() => {
    const stage = document.querySelector('[data-tour="canvas"] [class*="viewport"]')!;
    const a = stage.querySelector("[data-artboard]")!.getBoundingClientRect();
    const v = stage.getBoundingClientRect();
    return `${Math.round(a.left - v.left)},${Math.round(a.top - v.top)}`;
  });
const ink = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
    const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) n++;
    return n;
  });

type Drag = (app: App, from: [number, number], to: [number, number]) => Promise<void>;
const INPUTS: [string, Drag][] = [
  [
    "a finger",
    async (app, [fx, fy], [tx, ty]) => {
      await app.touchDown(fx, fy);
      await app.touchMove(tx, ty, 6);
      await app.touchUp();
      /* Wait out a Chromium quirk before the next tap: after a touch drag on
         the `touch-action: none` canvas, the next tap's click is dropped for
         ~2 s (REAL-DEVICE-CHECKLIST.md §10) — and this flow, draw then tap
         Pan, is exactly the one it would bite on a real phone. */
      await app.settle(2_500);
    },
  ],
  [
    "a mouse",
    async (app, [fx, fy], [tx, ty]) => {
      const { mouse } = app.page;
      await mouse.move(fx, fy);
      await mouse.down();
      await mouse.move(tx, ty, { steps: 6 });
      await mouse.up();
      await app.settle(600);
    },
  ],
];

for (const [name, drag] of INPUTS) {
  test(`with ${name}: the chip turns the drag into a pan, and leaves the brush selected`, async ({ app }) => {
    const { page } = app;
    await app.run("layer-new"); // something to paint on
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().tap();
    await app.settle(500);
    await page.locator('[data-tour="toolbar"]').getByRole("button", { name: "Brush", exact: true }).tap();
    await app.settle(500);
    if ((await page.evaluate(() => document.documentElement.dataset.drawer ?? "")) !== "") {
      await page.evaluate(() => window.history.back());
      await app.settle(500);
    }
    await expect(panChip(page), "the chip is in the bottom bar").toBeVisible();
    expect((await activeTool(page)).toLowerCase(), "the brush is selected").toContain("brush");
    const b = await app.canvasBox();
    const at = (fx: number, fy: number): [number, number] => [b.x + b.width * fx, b.y + b.height * fy];

    // Chip off: a drag paints, and the picture stays put.
    let inkWas = await ink(page);
    let artWas = await artworkAt(page);
    await drag(app, at(0.35, 0.4), at(0.6, 0.5));
    expect(await ink(page), "without the chip, a drag paints").toBeGreaterThan(inkWas);
    expect(await artworkAt(page), "...and does not move the picture").toBe(artWas);

    // Chip on: the same kind of drag pans, and paints nothing.
    await panChip(page).tap();
    await app.settle(400);
    expect(await panChip(page).getAttribute("aria-pressed"), "tapping the chip turns pan on").toBe("true");
    expect((await activeTool(page)).toLowerCase(), "...and the tool is untouched").toContain("brush");
    inkWas = await ink(page);
    artWas = await artworkAt(page);
    await drag(app, at(0.4, 0.45), at(0.7, 0.65));
    expect(await artworkAt(page), "with the chip on, the drag pans").not.toBe(artWas);
    expect(await ink(page), "...and lays down no ink at all").toBe(inkWas);

    // Chip off again: painting resumes, and that drag does not pan.
    await panChip(page).tap();
    await app.settle(400);
    expect(await panChip(page).getAttribute("aria-pressed"), "tapping again turns it off").toBe("false");
    inkWas = await ink(page);
    artWas = await artworkAt(page);
    await drag(app, at(0.3, 0.6), at(0.5, 0.7));
    expect(await ink(page), "painting resumes").toBeGreaterThan(inkWas);
    expect(await artworkAt(page), "...and that drag did not pan").toBe(artWas);
  });
}
