/**
 * Pictures the start card remembers. (Ported from tools/verify-recents.js,
 * TODO 2.1.)
 *
 * The recent-files store held only PROJECTS; a picture opened by import left
 * no trace, so the phone's start card had nothing to offer. Pictures now go
 * into the same store as `kind: "image"`, with a preview and their own bytes —
 * one store, so "Clear recent files" still means what it says.
 *
 *  - Three pictures opened in turn come back after a RELOAD, newest first,
 *    with previews that carry the right pixels (checked by colour: a blank or
 *    wrong-row preview loads perfectly well).
 *  - A row opens the picture it names, from bytes that survived the reload.
 *  - The store is capped and evicts oldest-first.
 *  - The recents DIALOG still lists only projects: it opens `.gproj` text, and
 *    handing it a PNG would be a silent failure.
 */
import { test, expect, type App } from "./fixtures";
import { solidPng } from "./png";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, keepStartCard: true });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/* Big enough that a preview is really downscaled, in colours far enough apart
   that a preview can be matched to its row by what it shows. */
const PHOTOS = [
  { name: "sunset.png", w: 600, h: 400, rgb: [230, 60, 40] },
  { name: "forest.png", w: 520, h: 480, rgb: [40, 190, 90] },
  { name: "harbour.png", w: 640, h: 360, rgb: [60, 110, 235] },
];

const docSize = (app: App) =>
  app.page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas');
    return c ? `${c.width}×${c.height}` : "none";
  });
const rows = (app: App) =>
  app.page.evaluate(() => [...document.querySelectorAll("[data-recent]")].map((e) => e.getAttribute("data-recent")));
/** Open a picture through the start card, and reload: the store is what has to remember. */
const openAndReload = async (app: App, name: string, w: number, h: number, rgb: number[]) => {
  await app.page.locator('[data-start-input="open"]').setInputFiles({ name, mimeType: "image/png", buffer: solidPng(w, h, rgb) });
  await expect.poll(() => docSize(app), { message: `${name} opens as its own document` }).toBe(`${w}×${h}`);
  await app.boot({ keepStartCard: true });
};
/** JPEG previews move the colour a little; the three are far enough apart. */
const near = (a: number[], b: number[]) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 90;

test("opened pictures come back after a reload, newest first, with their own previews, and reopen", async ({ app }) => {
  test.slow(); // a reload after every picture
  expect(await rows(app), "a fresh profile has no recent pictures").toEqual([]);
  for (const p of PHOTOS) await openAndReload(app, p.name, p.w, p.h, p.rgb);
  expect(await rows(app), "all three, newest first").toEqual(["harbour.png", "forest.png", "sunset.png"]);

  const thumbs = await app.page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>("[data-recent-thumb]")].map((img) => {
      if (!img.complete || !img.naturalWidth) return null;
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext("2d")!;
      g.drawImage(img, 0, 0);
      const d = g.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
      return { w: img.naturalWidth, h: img.naturalHeight, rgb: [d[0], d[1], d[2]] };
    }),
  );
  expect(thumbs.every(Boolean), "every preview is a real, painted image").toBe(true);
  const want = [PHOTOS[2], PHOTOS[1], PHOTOS[0]];
  thumbs.forEach((t, i) => {
    expect(near(t!.rgb, want[i].rgb), `${want[i].name}'s preview shows that picture: rgb(${t!.rgb})`).toBe(true);
    expect(Math.max(t!.w, t!.h), "...downscaled, not stored whole").toBeLessThanOrEqual(160);
  });

  await app.page.locator('[data-recent="forest.png"]').tap();
  await expect.poll(() => docSize(app), { message: "a row opens its picture, from bytes that outlived the reload" }).toBe(
    `${PHOTOS[1].w}×${PHOTOS[1].h}`,
  );
  const centre = await app.page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
    return [...c.getContext("2d", { willReadFrequently: true })!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data].slice(0, 3);
  });
  expect(near(centre, PHOTOS[1].rgb), `...the right picture: rgb(${centre})`).toBe(true);
  await app.boot({ keepStartCard: true });
  expect(await rows(app), "reopening moves it to the top rather than listing it twice").toEqual([
    "forest.png",
    "harbour.png",
    "sunset.png",
  ]);
});

test("the list is capped and the oldest goes first; the recents dialog still lists projects only", async ({ app }) => {
  test.slow();
  await openAndReload(app, "sunset.png", 600, 400, [230, 60, 40]);
  /* The cap is a preference (default 8): filled past it, the oldest falls off. */
  for (let i = 0; i < 8; i++) await openAndReload(app, `filler-${i}.png`, 120 + i, 90, [10 + i * 5, 10, 10]);
  const capped = await rows(app);
  expect(capped.length, "capped").toBeLessThanOrEqual(8);
  expect(capped[0], "newest first").toBe("filler-7.png");
  expect(capped, "...and the oldest is the one that went").not.toContain("sunset.png");

  /* Through the MENU, not by reading IndexedDB: the claim is about what the
     dialog lists, and reading the store tested the store — which passed with
     the filter mutated away. */
  const { page } = app;
  await page.locator('header button[aria-label="Menu"]').first().tap();
  await page.locator('[data-menubar][data-sheet="true"] > div > button', { hasText: "File" }).first().tap();
  const openRecent = page.locator('[data-menubar][data-sheet="true"] [role="menu"] button', { hasText: "Open recent" }).first();
  await expect(openRecent, "the recents dialog is reachable from the menu").toHaveCount(1);
  await openRecent.scrollIntoViewIfNeeded();
  await openRecent.tap();
  const dialog = page.locator('[role="dialog"]').last();
  await expect(dialog).toHaveCount(1);
  expect(await dialog.textContent(), "it lists no pictures: it can only open project text").not.toContain(".png");
});
