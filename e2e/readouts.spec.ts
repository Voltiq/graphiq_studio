/**
 * Numbers that change while you work never push their neighbours, and long menus
 * fit on the screen. (The 3.0.0 redesign.)
 *
 * Measured with each fix taken back out (current fonts, 1400×900):
 *  - the status bar's hint slid 20.7px sideways between a one-digit and a
 *    four-digit cursor position, so it twitched with every mouse move (the
 *    readout is a chip over the stage now, and holds its width the same way);
 *  - a Size readout growing from "1px" to "500px" took its extra 2px out of the
 *    very track being dragged, so the thumb shifted under the pointer;
 *  - the Layer menu, 46 rows in one column, was 1,584px tall in a 900px window,
 *    and its last rows could not be reached at all.
 * The zoom pill held already (its readout had room for "3200%"); its case is a
 * guard, so the same rule cannot quietly regress there.
 *
 * The probe is geometry: what sits AFTER a readout is measured with the number
 * at its shortest and at its longest, and must not move.
 */
import { test, expect, type App } from "./fixtures";
import type { Locator } from "@playwright/test";

const left = async (l: Locator) => (await l.boundingBox())!.x;

async function rangeMax(app: App, label: string): Promise<{ min: number; max: number }> {
  return app.page.evaluate((l) => {
    const el = document.querySelector<HTMLInputElement>(`[data-tour="options"] input[type="range"][aria-label="${l}"]`)!;
    return { min: Number(el.min), max: Number(el.max) };
  }, label);
}

test("the options bar holds still while the brush size readout grows", async ({ app }) => {
  await app.page.getByRole("button", { name: "Brush", exact: true }).click();
  await app.settle(300);
  const bar = app.page.locator('[data-tour="options"]');
  const size = bar.locator('input[type="range"][aria-label="Size"]');
  const hardness = bar.locator('input[type="range"][aria-label="Hardness"]');
  const readout = bar.getByRole("button", { name: /^\d+px$/ }).first();
  const { min, max } = await rangeMax(app, "Size");
  /* The track being dragged, and the next control along. A growing number can
     show up as either: pushing what follows, or — where the bar is short of
     room and the track is the part allowed to give — eating into the track
     itself, so the thumb jumps under the pointer mid-drag. */
  const probe = async () => {
    const t = (await size.boundingBox())!;
    return { x: t.x, right: t.x + t.width, next: await left(hardness) };
  };

  await app.setRange("Size", min);
  await expect(readout).toHaveText(`${min}px`);
  const atMin = await probe();
  await app.setRange("Size", max);
  await expect(readout).toHaveText(`${max}px`);
  const atMax = await probe();

  expect(String(max).length, "the range really does change digit count").toBeGreaterThan(String(min).length);
  expect(atMax.x, "the Size track moved when its readout grew").toBeCloseTo(atMin.x, 0);
  expect(atMax.right, "the Size track changed length when its readout grew").toBeCloseTo(atMin.right, 0);
  expect(atMax.next, "Hardness moved when Size grew").toBeCloseTo(atMin.next, 0);
});

test("the cursor chip keeps its width as the coordinates grow", async ({ app }) => {
  /* On desktop the readouts float over the foot of the stage as chips; the
     cursor's appears while the pointer is over the canvas. */
  const info = app.page.locator('[data-tour="status"] [data-status-info]');
  const b = await app.canvasBox();

  await app.page.mouse.move(b.x + 2, b.y + 2); // near the origin: one-digit coordinates
  await expect(info).toHaveText(/X \d(?!\d)/);
  const near = (await info.boundingBox())!.width;
  await app.page.mouse.move(b.x + b.width - 2, b.y + b.height - 2); // four digits
  await expect(info).toHaveText(/X \d{4}(?!\d)/);
  const far = (await info.boundingBox())!.width;

  expect(far, "the cursor chip changed width with the number").toBeCloseTo(near, 0);
});

test("the zoom pill does not change width with the zoom", async ({ app }) => {
  const zoomIn = app.page.locator('[data-zoombar] button[aria-label="Zoom in"]');
  const value = app.page.locator("[data-zoom-value]");
  // The Navigator's log-scale slider spans the whole zoom range.
  await app.expandPanel("Navigator");

  await app.setRange("Zoom", 0);
  await app.settle(300);
  const lo = (await value.innerText()).trim();
  const small = await left(zoomIn);
  await app.setRange("Zoom", 1000);
  await app.settle(300);
  const hi = (await value.innerText()).trim();
  const big = await left(zoomIn);

  expect(hi.length, `the readout really grew (${lo} to ${hi})`).toBeGreaterThan(lo.length);
  expect(big, "Zoom in moved when the readout grew").toBeCloseTo(small, 0);
});

test("every menu fits the window without scrolling, and none runs off the side", async ({ app }) => {
  const { page } = app;
  const vp = page.viewportSize()!;
  const names = await page.locator("[data-menubar] > div > button").allInnerTexts();
  expect(names.length).toBeGreaterThan(8);
  for (const name of names) {
    await page.locator("[data-menubar] > div > button", { hasText: name }).first().click();
    const menu = page.locator('[data-menubar] [role="menu"]');
    await expect(menu).toHaveCount(1);
    await app.settle(250); // the pop-in animation scales the box for 160ms
    const box = (await menu.boundingBox())!;
    const scrolls = await menu.evaluate((m) => m.scrollHeight > m.clientHeight + 1);
    expect(box.y + box.height, `${name} runs off the bottom`).toBeLessThanOrEqual(vp.height);
    expect(box.x + box.width, `${name} runs off the right`).toBeLessThanOrEqual(vp.width);
    expect(scrolls, `${name} needs scrolling at ${vp.width}×${vp.height}`).toBe(false);
    await page.keyboard.press("Escape");
    await expect(menu).toHaveCount(0);
  }
});

test.describe("in a short window", () => {
  test.use({ viewport: { width: 1280, height: 600 } });

  test("a menu taller than the window is capped and scrolls, rather than running off", async ({ app }) => {
    const { page } = app;
    await page.locator("[data-menubar] > div > button", { hasText: "View" }).first().click();
    const menu = page.locator('[data-menubar] [role="menu"]');
    await app.settle(250);
    const box = (await menu.boundingBox())!;
    expect(box.y + box.height, "View runs off the bottom").toBeLessThanOrEqual(600);
    // ...and its last row can still be reached.
    const last = menu.locator("button").last();
    await last.scrollIntoViewIfNeeded();
    const lb = (await last.boundingBox())!;
    expect(lb.y + lb.height).toBeLessThanOrEqual(600);
  });
});
