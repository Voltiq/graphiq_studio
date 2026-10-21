/**
 * What an open document costs before you have edited it. (Ported from
 * tools/verify-memory-floor.js, TODO 2.1.)
 *
 * Measured on a 12 MP photo opened and left alone: view, textPreview, stroke,
 * scratch and layer — five document-sized buffers, 229 MB. Two were for edits
 * that had not happened (the live dab and its composite), and a third was a
 * text preview "hidden" with display:none, which frees nothing. Now: the
 * picture and its pixels. Only two of the five lived in the DOM, so
 * `querySelectorAll("canvas")` misses exactly the buffers this is about;
 * `memoryReport()` names the engine's. Both halves are counted, because each
 * can be wrong in a way the other catches.
 */
import { join } from "node:path";
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const PHOTO = join(__dirname, "..", "tools", "fixtures", "photo-4000x3000.png");
const DOC_BYTES = 4000 * 3000 * 4; // 45.8 MB

type Report = { w: number; h: number; total: number; buffers: { name: string; w: number; h: number }[] };

const floor = (app: App) =>
  app.page.evaluate(() => {
    const report = (window as unknown as { __gqMemory?: () => Report }).__gqMemory?.() ?? null;
    const canvases = [...document.querySelectorAll("canvas")];
    return {
      report,
      engineBig: report ? report.buffers.filter((b) => b.w * b.h >= 4_000_000).map((b) => b.name) : null,
      domBig: canvases
        .filter((c) => c.width * c.height >= 4_000_000)
        .map((c) => String(c.className).replace(/\S*module__\w+__/g, "") || "?"),
      domBytes: canvases.reduce((n, c) => n + c.width * c.height * 4, 0),
    };
  });

test("an untouched 12 MP photo holds its pixels and their picture — and a stroke makes, then keeps, the rest", async ({ app }) => {
  const { page } = app;
  await page.locator('input[type="file"][multiple][accept*="image/*"]').first().setInputFiles(PHOTO);
  const dlg = page.locator('[role="dialog"]');
  await dlg.waitFor();
  await dlg.getByText("New canvas").first().click();
  await dlg.locator("button", { hasText: /^Import$/ }).last().click();
  await expect.poll(async () => (await floor(app)).report?.w, { timeout: 20_000 }).toBe(4000);

  const photo = await floor(app);
  expect(photo.report?.h).toBe(3000);
  expect(photo.engineBig, "ONE document-sized engine buffer: the layer — no stroke, no scratch").toEqual([
    expect.stringMatching(/^layer:/),
  ]);
  expect(photo.domBig, "ONE in the DOM: the picture on screen (no text preview mounted)").toEqual([expect.stringMatching(/^view/)]);
  expect(photo.report!.total + photo.domBytes, "two buffers counted both ways (was five)").toBeLessThan(DOC_BYTES * 3);

  /* Lazy means later, not never: an edit brings them into being... */
  const box = (await page.locator('[data-tour="canvas"]').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2);
  await page.mouse.down();
  for (let i = 0; i < 8; i++) await page.mouse.move(box.x + box.width / 2 - 40 + i * 8, box.y + box.height / 2 + i * 4);
  await page.mouse.up();
  await app.settle(1500);
  const painted = (await floor(app)).engineBig!;
  expect(painted, "a stroke brings the operation buffers into being").toEqual(expect.arrayContaining(["stroke", "scratch"]));
  /* ...and they are kept: 45 MB between one stroke and the next is a worse
     bargain than holding it. */
  await page.mouse.move(box.x + 60, box.y + 60);
  await page.mouse.down();
  await page.mouse.move(box.x + 90, box.y + 90);
  await page.mouse.up();
  await app.settle(1200);
  expect((await floor(app)).engineBig!.length, "...reused, not remade").toBe(painted.length);
});

test("a blank 4000×3000 document holds no document-sized engine buffer at all", async ({ app }) => {
  const { page } = app;
  await page.keyboard.press("Control+n");
  const fields = page.locator('[role="dialog"] input[type="number"]');
  await fields.nth(0).fill("4000");
  await fields.nth(1).fill("3000");
  await page.locator('[role="dialog"] button', { hasText: /^Create$/ }).first().click();
  await expect.poll(async () => (await floor(app)).report?.w).toBe(4000);
  expect((await floor(app)).engineBig, "nothing drawn, nothing held").toEqual([]);
});
