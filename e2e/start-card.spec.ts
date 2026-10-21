/**
 * The phone's launch state: a photo-first start card.
 * (Ported from tools/verify-start-card.js, TODO 2.1.)
 *
 * The app opens on a blank 1920×1080 artboard, the desktop's job: you came to
 * make something. On a phone you almost always came to edit a picture already
 * on the device, and reaching it meant the menu sheet, then File, then Import.
 *
 * What a headless browser can settle, it does: the card is there with zero
 * taps, and a photo returned by the camera input becomes the document
 * (`setInputFiles` is exactly what the OS picker does when it returns). What
 * it cannot — that the OS opens the CAMERA — is decided by the `capture`
 * attribute, so that is asserted. And it must never be a nuisance: never over
 * work, never on a mouse.
 */
import { test, expect, type App } from "./fixtures";
import { solidPng } from "./png";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const PHOTO = { w: 61, h: 43, rgb: [0, 128, 255] };

const cardBox = (app: App) =>
  app.page.evaluate(() => {
    const el = document.querySelector("[data-startcard]");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) };
  });
const docSize = (app: App) =>
  app.page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas');
    return c ? `${c.width}×${c.height}` : "none";
  });

test.describe("on a fresh phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, keepStartCard: true });

  test("the card is there with no taps, over the stage and under the header", async ({ app }) => {
    const box = await cardBox(app);
    expect(box, "a fresh profile shows the start card").not.toBeNull();
    expect(box!.w > 200 && box!.h > 200, `${box!.w}×${box!.h}`).toBe(true);
    /* The header and the dock stay usable — the card is an offer. It covers
       the whole stage, the tool's options card included: there is nothing to
       set options for until there is a picture. */
    const at = await app.page.evaluate(() => {
      const header = document.querySelector("header")!.getBoundingClientRect();
      const dock = document.querySelector('[data-tour="mobilebar"]')!.getBoundingClientRect();
      const opts = document.querySelector('[data-tour="options"]')!.getBoundingClientRect();
      const on = (r: DOMRect) => document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return {
        headerBottom: Math.round(header.bottom),
        dockTop: Math.round(dock.top),
        headerFree: !on(header)?.closest("[data-startcard]"),
        dockFree: !on(dock)?.closest("[data-startcard]"),
        optionsCovered: !!on(opts)?.closest("[data-startcard]"),
      };
    });
    expect(box!.top, "it starts below the header").toBeGreaterThanOrEqual(at.headerBottom - 1);
    expect(box!.bottom, "...and ends above the dock").toBeLessThanOrEqual(at.dockTop + 1);
    expect(at, "the header and dock take their own presses; the options card is under it").toMatchObject({
      headerFree: true,
      dockFree: true,
      optionsCovered: true,
    });

    const rows = await app.page.evaluate(() =>
      Object.fromEntries([...document.querySelectorAll("[data-start]")].map((e) => [e.getAttribute("data-start"), e.textContent!.trim()])),
    );
    expect(Object.keys(rows).sort(), "it offers a photo, a camera and a way out").toEqual(["blank", "camera", "open"]);
    const inputs = await app.page.evaluate(() =>
      Object.fromEntries(
        [...document.querySelectorAll<HTMLInputElement>("[data-start-input]")].map((e) => [
          e.getAttribute("data-start-input"),
          { accept: e.accept, capture: e.getAttribute("capture") },
        ]),
      ),
    );
    expect(inputs, "both filter to images; only the camera carries `capture`, which opens the camera").toEqual({
      open: { accept: "image/*", capture: null },
      camera: { accept: "image/*", capture: "environment" },
    });
  });

  test("a photo from the camera becomes the document, at its own size, as one layer", async ({ app }) => {
    const { page } = app;
    await page.locator('[data-start-input="camera"]').setInputFiles({
      name: "snap.png",
      mimeType: "image/png",
      buffer: solidPng(PHOTO.w, PHOTO.h, PHOTO.rgb),
    });
    await expect.poll(() => docSize(app), { message: "the photo becomes the document, at its own size" }).toBe(
      `${PHOTO.w}×${PHOTO.h}`,
    );
    const centre = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
      return [...c.getContext("2d", { willReadFrequently: true })!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data];
    });
    expect(centre, "...with its pixels on a layer").toEqual([...PHOTO.rgb, 255]);
    expect(await app.page.evaluate(() => window.graphiq!.layers().length), "...as exactly one layer").toBe(1);
    expect(await cardBox(app), "and the card is gone once there is something to edit").toBeNull();
  });

  test("“Start with a blank canvas” dismisses it and leaves the artboard", async ({ app }) => {
    await app.page.locator('[data-start="blank"]').tap();
    await expect.poll(() => cardBox(app)).toBeNull();
    expect(await docSize(app)).toBe("1920×1080");
  });

  test("making a layer takes it away without dismissing it", async ({ app }) => {
    await app.page.keyboard.press("Control+Shift+N");
    await expect.poll(() => cardBox(app), { message: "a layer is work" }).toBeNull();
  });

  test("ignored, it does not come back over a picture opened the ordinary way", async ({ app }) => {
    /* The CONTENT half of the predicate: nothing was dismissed, so a card that
       only knew about dismissal would sit on the picture that just opened. As
       a new canvas, it is also the `docs.length === 1` case. By accept, not by
       position: the first multiple-file input is the animation-pack picker,
       which silently ignores a PNG. */
    const { page } = app;
    const input = page.locator('input[type="file"][multiple][accept*="image/*"]').first();
    await expect(input, "the ordinary import picker is there").toHaveCount(1);
    await input.setInputFiles({ name: "ignored.png", mimeType: "image/png", buffer: solidPng(PHOTO.w, PHOTO.h, [255, 0, 128]) });
    const importBtn = page.locator('[role="dialog"] button', { hasText: /^Import$/ }).first();
    await expect(importBtn, "the ordinary path goes through the import dialog").toHaveCount(1);
    await page.locator('[role="dialog"] button', { hasText: "New canvas" }).first().click();
    await importBtn.click();
    await expect.poll(() => docSize(app), { message: "it opens as a second document" }).toBe(`${PHOTO.w}×${PHOTO.h}`);
    expect((await app.docs()).length).toBe(2);
    expect(await cardBox(app), "the card stays away").toBeNull();
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 }, keepStartCard: true });

  test("a mouse never sees it, and opens on the blank artboard", async ({ app }) => {
    expect(await cardBox(app)).toBeNull();
    expect(await docSize(app)).toBe("1920×1080");
  });
});
