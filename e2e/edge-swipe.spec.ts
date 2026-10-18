/**
 * The edge strips, and what they cost the canvas. (Ported from tools/verify-edge-swipe.js, TODO 2.1.)
 *
 * Two 20px strips host the swipe that opens a drawer. They sit exactly where
 * iOS and Android put the system back gesture, so the swipe is unreliable on
 * both — the MobileBar's buttons are the primary route, these a secondary one.
 * The measurable cost is that they take the outer 20px of each side from the
 * canvas: `elementFromPoint` at x=4 returns the strip.
 *
 * There is no clean win; the honest one is that they stand aside the moment a
 * drag is live on the canvas, so a stroke begun inland can run to the very
 * edge. What is NOT fixed, and asserted so it stays visible: a stroke still
 * cannot BEGIN in the outer 20px while the strips are armed.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const Y = 500;
const whatIsAt = (page: Page, x: number) =>
  page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y) as HTMLElement | null;
      if (!el) return "nothing";
      if (el.classList.contains("gq-m-edge")) return `strip:${el.dataset.side}`;
      return el.closest('[data-tour="canvas"]') ? "canvas" : el.getAttribute("data-tour") || el.tagName;
    },
    [x, Y],
  );
const drawer = (page: Page) => page.evaluate(() => document.documentElement.dataset.drawer ?? "");
const ink = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
    const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) n++;
    return n;
  });

test("while armed, the strips take the outer 20px of each side, and only that", async ({ app }) => {
  expect(await whatIsAt(app.page, 4), "x=4").toBe("strip:left");
  expect(await whatIsAt(app.page, 386), "x=386").toBe("strip:right");
  expect(await whatIsAt(app.page, 30), "x=30 is the canvas").toBe("canvas");
});

/* Each gesture with a FINGER — what the strips exist for, and what the app's
   `pointerType === "touch"` branches see — and with a mouse. The script this
   came from drove only the mouse, which in a touch context still reports
   `pointerType: "mouse"`. */
interface Input {
  down(x: number, y: number): Promise<void>;
  move(x: number, y: number, steps?: number): Promise<void>;
  up(): Promise<void>;
}
const INPUTS: [string, "touch" | "mouse", (app: App) => Input][] = [
  [
    "a finger",
    "touch", (app) => ({ down: (x, y) => app.touchDown(x, y), move: (x, y, s) => app.touchMove(x, y, s), up: () => app.touchUp() }),
  ],
  [
    "a mouse",
    "mouse",
    (app) => ({
      down: async (x, y) => {
        await app.page.mouse.move(x, y);
        await app.page.mouse.down();
      },
      move: (x, y, s) => app.page.mouse.move(x, y, { steps: s }),
      up: () => app.page.mouse.up(),
    }),
  ],
];

for (const [name, pointerType, make] of INPUTS) {
  test.describe(`with ${name}`, () => {
    test("a slow drag from the edge opens a drawer and paints nothing; back re-arms the strips", async ({ app }) => {
      const { page } = app;
      const input = make(app);
      const before = await ink(page);
      await input.down(4, Y);
      for (let i = 1; i <= 12; i++) {
        await input.move(4 + i * 6, Y, 1);
        await app.settle(30);
      }
      await input.up();
      await app.settle(800);
      expect(await ink(page), "nothing was painted").toBe(before);
      expect(await drawer(page), "the drawer opened instead").toBe("tools");
      await page.evaluate(() => window.history.back());
      await app.settle(800);
      expect(await drawer(page), "back closed it").toBe("");
      expect(await whatIsAt(page, 4), "...leaving the strips armed").toBe("strip:left");
    });

    test("during a live canvas drag the strips stand aside, and re-arm when it ends", async ({ app }) => {
      const { page } = app;
      const input = make(app);
      // Non-vacuity: the app really sees this input as what it claims to be.
      await page.evaluate(() =>
        window.addEventListener("pointerdown", (e) => ((window as unknown as { __pt?: string }).__pt ??= e.pointerType), true),
      );
      await input.down(200, Y);
      await input.move(160, Y, 4);
      await app.settle(150);
      const grabbed = await page.evaluate(() => document.documentElement.dataset.toolgrab ?? "");
      const left = await whatIsAt(page, 4);
      const right = await whatIsAt(page, 386);
      await input.move(4, Y, 6);
      await input.up();
      await app.settle(600);
      expect(await page.evaluate(() => (window as unknown as { __pt?: string }).__pt), "the pointer type the app saw").toBe(
        pointerType,
      );
      expect(grabbed, "a live drag marks the canvas as holding the pointer").toBe("true");
      expect({ left, right }, "mid-drag, the edges reach the canvas").toEqual({ left: "canvas", right: "canvas" });
      expect(await page.evaluate(() => document.documentElement.dataset.toolgrab ?? ""), "the grab ends with the drag").toBe("");
      expect(await whatIsAt(page, 4), "the strips are armed again").toBe("strip:left");
      expect(await drawer(page), "dragging out to the edge opened no drawer").toBe("");
    });
  });
}
