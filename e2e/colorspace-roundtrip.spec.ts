/**
 * A .gproj reopens byte-identically, whatever working colour space the
 * session that opens it is in. (Ported from tools/verify-colorspace-roundtrip.js, TODO 2.1.)
 *
 * WHY. Layer pixels are stored as PNG data URLs, and a canvas in a wide-gamut
 * space writes them with that profile attached. Until v24 the file recorded no
 * space, so reopening in a different one let the browser colour-manage every
 * layer on decode: 27,550 of 120,000 bytes on a small Display-P3 document
 * opened as sRGB — RGB shifted, alpha untouched, which is why it read as a
 * rendering quirk rather than a lossy reopen. The file now carries
 * `workingSpace`, and the loader adopts it before anything decodes.
 *
 * HOW. Each leg saves in one space and opens in a BRAND-NEW browser context
 * whose persisted preference is a DIFFERENT one — no shared localStorage or
 * IndexedDB, so what comes back can only have come from the file. Opening in
 * the same session was never broken; the mismatch is the whole point.
 *
 * NON-VACUITY. Byte-identity would also hold if the two spaces were secretly
 * the same, so each leg asserts that the opening session really was in the
 * other space BEFORE the file was opened, and in the file's space after.
 */
import { readFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, bootApp, type App } from "./fixtures";

const VIEWPORT = { width: 1500, height: 950 };
const DOC_W = 200;
const DOC_H = 150;

/* saved-in -> opened-in. adobe-rgb is the emulated space (its bytes stay on an
   sRGB canvas and only the adjustment maths changes), so it belongs here too:
   the file still has to say which it was. */
const LEGS = [
  { save: "display-p3", open: "srgb" },
  { save: "srgb", open: "display-p3" },
  { save: "adobe-rgb", open: "display-p3" },
];
/** What the canvas itself reports for a working space. */
const canvasSpaceOf = (ws: string) => (ws === "display-p3" ? "display-p3" : "srgb");

/** The document canvas's colour space and every byte of it. */
const readDoc = (page: Page) =>
  page.evaluate((width) => {
    const c = document.querySelector<HTMLCanvasElement>(`canvas[width="${width}"]`);
    if (!c) return null;
    const g = c.getContext("2d")!;
    return { space: g.getContextAttributes().colorSpace, px: Array.from(g.getImageData(0, 0, c.width, c.height).data) };
  }, DOC_W);

const viewSpace = (page: Page) =>
  page.evaluate(
    () => document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')?.getContext("2d")?.getContextAttributes().colorSpace ?? null,
  );

/** Varied colour: a gradient ramp plus a stroke in the contrasting colour. A
 *  flat fill would exercise one value, and a colour conversion is per-value. */
async function author(app: App): Promise<void> {
  const { page } = app;
  await app.menu("File", "New…");
  const nd = page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.waitFor({ timeout: 8_000 });
  await nd.locator('input[type="number"]').nth(0).fill(String(DOC_W));
  await nd.locator('input[type="number"]').nth(1).fill(String(DOC_H));
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_500);
  await app.run("layer-new");
  const box = await app.canvasBox();
  await page.getByRole("button", { name: /^Gradient/ }).first().click();
  await app.settle(500);
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height - 6, { steps: 10 });
  await page.mouse.up();
  await app.settle(1_100);
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await page.locator('button[aria-label="Swap foreground and background colors"]').first().click();
  await app.settle(300);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++)
    await page.mouse.move(box.x + box.width * (0.2 + 0.1 * i), box.y + box.height * 0.5, { steps: 2 });
  await page.mouse.up();
  await app.settle(1_200);
}

for (const leg of LEGS) {
  test(`saved in ${leg.save}, reopened in ${leg.open}: byte-identical`, async ({ browser, baseURL }, info) => {
    const session = async (space: string) => {
      const ctx = await browser.newContext({ baseURL, viewport: VIEWPORT });
      const app = await bootApp(await ctx.newPage(), { filePickers: false, storage: { "pe-colorspace": space } });
      return { ctx, app };
    };

    // ---- author and save ----
    const a = await session(leg.save);
    await author(a.app);
    const orig = await readDoc(a.app.page);
    expect(orig, "the authored document is on screen").not.toBeNull();
    expect(orig!.space, "the authoring session really is in its space").toBe(canvasSpaceOf(leg.save));
    const saved = a.app.page.waitForEvent("download", { timeout: 20_000 });
    await a.app.page.getByText("File", { exact: true }).first().click();
    await a.app.settle(400);
    await a.app.page.locator('[role="menu"] button').filter({ hasText: /^Save/ }).first().click();
    const file = info.outputPath(`${leg.save}.gproj`);
    await (await saved).saveAs(file);
    expect(JSON.parse(readFileSync(file, "utf8")).workingSpace, "the file records the space it was written in").toBe(
      leg.save,
    );
    expect(a.app.errors, "no page errors while authoring").toEqual([]);
    await a.ctx.close();

    // ---- open it somewhere else entirely ----
    const b = await session(leg.open);
    const before = await viewSpace(b.app.page);
    expect(before, "the opening session really starts in its own space").toBe(canvasSpaceOf(leg.open));
    expect(before, "...which is not the file's").not.toBe(orig!.space);
    await b.app.page.setInputFiles('input[accept*=".gproj"]', file);
    await b.app.settle(4_000);
    const back = await readDoc(b.app.page);
    expect(back, "the document opened").not.toBeNull();
    let n = 0;
    let worst = 0;
    const chan = [0, 0, 0, 0];
    for (let i = 0; i < orig!.px.length; i++) {
      const d = Math.abs(orig!.px[i] - back!.px[i]);
      if (!d) continue;
      n++;
      chan[i & 3]++;
      worst = Math.max(worst, d);
    }
    expect.soft(n, `reopens byte-identically (worst Δ ${worst}, RGBA ${JSON.stringify(chan)})`).toBe(0);
    expect.soft(back!.space, `...and adopted the file's space (${before} -> ${back!.space})`).toBe(orig!.space);
    expect(b.app.errors, "no page errors while reopening").toEqual([]);
    await b.ctx.close();
  });
}
