/**
 * The pattern library, its picker, and the fill that consumes them. (Ported
 * from tools/verify-pattern-fill.js, TODO 2.1. The pure half — file contents,
 * de-duplicated names, the byte budget — is tests/patterns.test.ts.)
 *
 * The tiles are DRAWN on canvases, the library lives in IndexedDB and the fill
 * goes through the engine: only observable here. And a pattern fill is not
 * one colour — so the check is MANY colours where a colour fill gives one.
 * "The pixels changed" would pass a pattern that silently became its average,
 * which is exactly what a broken createPattern produces.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 1500, height: 950 } });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** Painted pixels and distinct colours across the document. */
const sample = (app: App) =>
  app.page.evaluate(() => {
    const doc = (window as unknown as { __gqMemory: () => { w: number; h: number } }).__gqMemory();
    const c = [...document.querySelectorAll<HTMLCanvasElement>('[data-tour="canvas"] canvas')].find((x) => x.width === doc.w && x.height === doc.h)!;
    const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    const seen = new Set<number>();
    let painted = 0;
    for (let px = 0; px * 4 < d.length; px += 7) {
      const i = px * 4;
      if (d[i + 3]) {
        painted++;
        seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
      }
    }
    return { painted, colours: seen.size };
  });

test("Edit ▸ Fill with pattern: every built-in tile draws, a fill repeats, and one Undo takes it away", async ({ app }) => {
  const { page } = app;
  await app.run("layer-new");
  expect((await sample(app)).painted, "a blank layer to fill").toBe(0);
  /* Through the scripting API directly: `app.run` closes the modal it opens. */
  await page.evaluate(() => window.graphiq!.run("pattern-fill"));
  const dialog = page.locator('[role="dialog"][aria-label="Fill with pattern"]');
  await expect(dialog, "the dialog opens").toHaveCount(1);

  const tiles = await page.evaluate(() =>
    [...document.querySelectorAll('[role="listbox"][aria-label="Patterns"] [role="option"]')].map((o) => {
      /* The tiles are procedures: a button is no evidence that one produced pixels. */
      const c = o.querySelector("canvas");
      const d = c && c.width ? c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data : null;
      let drew = false;
      for (let i = 3; d && i < d.length && !drew; i += 4) if (d[i]) drew = true;
      return { name: o.textContent!.trim(), drew };
    }),
  );
  expect(tiles.length, "the picker lists the built-in tiles").toBeGreaterThanOrEqual(4);
  expect(tiles.filter((t) => !t.drew).map((t) => t.name), "every swatch drew").toEqual([]);

  await dialog.locator('[role="option"]', { hasText: /checker/i }).first().click();
  await dialog.getByRole("button", { name: "Fill", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await sample(app)).painted, { message: "the layer is covered" }).toBeGreaterThan(1000);
  expect((await sample(app)).colours, "more than one colour: it repeated rather than flattened").toBeGreaterThanOrEqual(2);

  await page.evaluate(() => window.graphiq!.undo());
  await expect.poll(async () => (await sample(app)).painted, { message: "one Undo takes the whole fill away" }).toBe(0);
});
