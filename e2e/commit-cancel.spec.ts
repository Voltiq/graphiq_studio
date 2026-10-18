/**
 * Finishing what you started, on a device with no Enter and no Escape.
 * (Ported from tools/verify-commit-cancel.js, TODO 2.1.)
 *
 * A pen path, a crop, a transform and a text session are in-progress state that
 * only those two keys resolve — so on a phone those tools could be started and
 * never finished. A ✓/✕ pair appears on the canvas while such a session is
 * live and sends exactly those keys, so no handler learned a new way to commit.
 *
 * The pair is CSS-gated on `html[data-commit]`, which CanvasArea publishes from
 * one predicate over every session. Appearing and disappearing at the right
 * moments is half the feature: a pair parked permanently over the picture
 * would be the other kind of failure.
 *
 * Every press is a real touch. The script drove the pen with mouse clicks, and
 * covered only the pen; the crop session is added here.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const committable = (page: Page) => page.evaluate(() => document.documentElement.dataset.commit ?? "");
const pair = (page: Page) => page.locator('[aria-label="Finish or cancel"]');

async function pickTool(app: App, name: RegExp): Promise<void> {
  const { page } = app;
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().tap();
  await app.settle(500);
  await page.locator('[data-tour="toolbar"]').getByRole("button", { name }).first().tap();
  await app.settle(500);
  if ((await page.evaluate(() => document.documentElement.dataset.drawer ?? "")) !== "") {
    await page.evaluate(() => window.history.back());
    await app.settle(500);
  }
}
async function fingerTap(app: App, x: number, y: number): Promise<void> {
  await app.touchDown(x, y);
  await app.touchUp();
  await app.settle(350);
}

test("nothing is committable to begin with, so the pair is not on screen", async ({ app }) => {
  expect(await committable(app.page)).toBe("");
  await expect(pair(app.page)).toBeHidden();
});

test("a pen path: ✕ throws it away, ✓ keeps it", async ({ app }) => {
  const { page } = app;
  /** Rows in the Paths panel. */
  const paths = async () => {
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
    await app.settle(700);
    await app.setSheetDetent("full");
    expect(await app.openPanelById("paths"), "the Paths panel opens").toBe(true);
    const n = await page.evaluate(() => document.querySelectorAll('[data-panel-id="paths"] [class*="pathRow"], [data-panel-id="paths"] li').length);
    await page.evaluate(() => window.history.back());
    await app.settle(700);
    return n;
  };
  await app.run("layer-new");
  const before = await paths();
  await pickTool(app, /^Pen\b/);
  const b = await app.canvasBox();
  const c = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };

  /* CANCEL FIRST, from an empty Paths panel: the only order in which the row
     count tells the two apart. A path being drawn becomes the single reusable
     Work Path, so once one exists, committing another REPLACES it and the count
     stays at 1 — a version that cancelled second passed while ✕ was quietly
     committing. */
  for (const [dx, dy] of [[-70, 60], [70, 60], [0, -60]]) await fingerTap(app, c.x + dx, c.y + dy);
  expect(await committable(page), "a pen path in progress is committable").toBe("1");
  await expect(pair(page), "...and the pair appears for it").toBeVisible();
  await pair(page).locator('button[aria-label="Cancel"]').tap();
  await app.settle(1_200);
  expect(await committable(page), "✕ ends the session").toBe("");
  await expect(pair(page), "...and the pair goes away").toBeHidden();
  const afterCancel = await paths();
  expect(afterCancel, "✕ leaves nothing behind").toBe(before);

  await pickTool(app, /^Pen\b/);
  for (const [dx, dy] of [[-60, -40], [60, -40], [0, 50]]) await fingerTap(app, c.x + dx, c.y + dy);
  expect(await committable(page), "a second path is in progress").toBe("1");
  await pair(page).locator('button[aria-label="Commit"]').tap();
  await app.settle(1_200);
  expect(await committable(page), "✓ ends the session too").toBe("");
  await expect(pair(page)).toBeHidden();
  expect(await paths(), "✓ keeps it: it lands in the Paths panel").toBeGreaterThan(afterCancel);
});

test("a crop: ✕ resets the box, ✓ crops to it", async ({ app }) => {
  /* For crop, ✕ (Escape) RESETS the box to the whole canvas, as in Photoshop:
     the box lives as long as the Crop tool does, so the pair stays up. (My first
     draft expected ✕ to end the session, and read that as a failure.) The
     reset is checked by what ✓ does next: crop to a reset box and the size is
     unchanged; had ✕ done nothing, ✓ would crop it smaller. */
  const { page } = app;
  const size = async () => {
    const d = (await app.docs()).find((x) => x.active)!;
    return { w: d.width, h: d.height };
  };
  const start = await size();
  /** Shrink the crop box by dragging its bottom-right handle inward. The Crop
   *  tool starts with a full-canvas box, and a drag INSIDE a box moves it —
   *  which an earlier draft did, so its ✕ leg "passed" with the box never
   *  changed at all. */
  const shrinkBox = async () => {
    const a = (await page.locator("[data-artboard]").first().boundingBox())!;
    await app.touchDown(a.x + a.width - 2, a.y + a.height - 2);
    await app.touchMove(a.x + a.width * 0.6, a.y + a.height * 0.6, 8);
    await app.touchUp();
    /* Wait out a Chromium quirk before tapping: after a touch drag on the
       `touch-action: none` canvas, the next tap's click is dropped for ~2 s
       (REAL-DEVICE-CHECKLIST.md §10). */
    await app.settle(2_500);
  };

  await pickTool(app, /^Crop\b/);
  expect(await committable(page), "the crop tool's box is a session").toBe("1");
  await expect(pair(page), "...so the pair is up").toBeVisible();

  await shrinkBox();
  await pair(page).locator('button[aria-label="Cancel"]').tap();
  await app.settle(900);
  await pair(page).locator('button[aria-label="Commit"]').tap();
  await app.settle(1_200);
  expect(await size(), "✕ reset the box: committing it changes nothing").toEqual(start);

  // Still the Crop tool, with a fresh full-canvas box: draw a smaller one.
  expect(await committable(page), "the crop tool is still live after ✓").toBe("1");
  await shrinkBox();
  await pair(page).locator('button[aria-label="Commit"]').tap();
  await app.settle(1_200);
  const after = await size();
  expect(after.w * after.h, `✓ crops to the box: ${start.w}×${start.h} → ${after.w}×${after.h}`).toBeLessThan(start.w * start.h);
});
