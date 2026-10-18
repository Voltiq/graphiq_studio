/**
 * The smart-filter WORKER and the inline path must produce the same product,
 * for every blend mode and opacity. (Ported from tools/verify-worker-blend.js, TODO 2.1.)
 *
 * WHY. Handing the settled filter pass to a worker is only sound if the two
 * paths are interchangeable, and nothing checked that until a live region frame
 * seeded from a cached product and inherited a discrepancy. They were not: both
 * blended through a canvas at `globalAlpha`, and Chromium's HTMLCanvasElement
 * and OffscreenCanvas round that differently — measured on blending a colour
 * over ITSELF at 70%, which must return that colour:
 *
 *     HTMLCanvasElement    8 of 256 values wrong, rounded DOWN
 *     OffscreenCanvas     48 of 256 values wrong, rounded UP
 *
 * Both are now computed by app/lib/blend.ts in exact arithmetic, so they agree
 * by construction and the result is correct rather than merely consistent.
 *
 * HOW. Through `__gqRenderCache.filterAB()`, which diffs the cached product
 * against a fresh inline render of the same stack and nothing else. Diffing
 * whole COMPOSITES drags in every merge on the way to the canvas and cannot
 * localise a disagreement to the filter.
 *
 * NON-VACUITY. "Zero difference" is also what two renders of a configuration
 * that never took effect give you. So every leg also asserts that the product's
 * digest MOVED when the mode changed, and that all modes ended up distinct.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 1500, height: 950 } });

const DOC_W = 800;
const DOC_H = 600;
/* One representative per shape of blend function, plus the two that are not
   blend functions at all: Normal (source-over) and Add (Porter-Duff plus). */
const MODES = [
  "Normal",
  "Multiply",
  "Screen",
  "Overlay",
  "Soft Light",
  "Color Dodge",
  "Difference",
  "Add",
  "Hue",
  "Luminosity",
];

/** Wait for the in-flight worker job to land: filterAB reports null while the
 *  cached product's key is stale, which is exactly "not ready". */
async function settledAB(app: App) {
  for (let i = 0; i < 25; i++) {
    const r = await app.page.evaluate(() => window.__gqRenderCache!.filterAB());
    if (r) return r;
    await app.settle(400);
  }
  return null;
}

test("the smart-filter worker and the inline path agree, mode by mode", async ({ app }) => {
  test.slow();
  const { page } = app;
  await app.menu("File", "New…");
  const nd = page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.waitFor({ timeout: 8_000 });
  await nd.locator('input[type="number"]').nth(0).fill(String(DOC_W));
  await nd.locator('input[type="number"]').nth(1).fill(String(DOC_H));
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_600);

  await test.step("varied content under the filter", async () => {
    // A filled layer, then strokes in a contrasting colour: a blend is a
    // per-value function, and a flat fill would exercise one value.
    await app.run("layer-new");
    await app.setForeground("#2a6fdb");
    await page.evaluate(([w, h]) => window.graphiq!.select([{ x: 0, y: 0, w, h }]), [DOC_W, DOC_H] as const);
    await app.key("Backspace");
    await app.run("select-deselect");
    await app.setForeground("#f2c14e");
    await page.getByRole("button", { name: "Brush", exact: true }).click({ timeout: 10_000 });
    await app.settle(250);
    await app.setRange("Size", 120);
    const box = await app.canvasBox();
    for (const fy of [0.25, 0.5, 0.75]) {
      await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * fy);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++)
        await page.mouse.move(box.x + box.width * (0.15 + 0.08 * i), box.y + box.height * fy, { steps: 2 });
      await page.mouse.up();
      await app.settle(500);
    }
    await app.settle(800);
    await app.menu("Effects", "Blur (smart filter)");
    await app.key("Escape");
    await app.settle(1_000);
  });

  const sfd = page.locator('div[role="dialog"]').filter({ hasText: "Filter Mask" }).first();
  /* The dialog holds TWO listbox Selects — the filter's own kind ("Gaussian")
     comes first, Blend second — so `.first()` drives the wrong control. Locate
     it by its label, and verify what it shows is a blend mode: if the markup
     moves, this fails loudly instead of quietly setting a blur kind. */
  const blendTrigger = () =>
    sfd
      .locator("div")
      .filter({ has: page.locator("span", { hasText: /^Blend$/ }) })
      .last()
      .locator('button[aria-haspopup="listbox"]')
      .first();
  const setMode = async (mode: string, opacityPresses: number): Promise<string> => {
    await app.menu("Effects", "Smart filters…");
    await sfd.waitFor({ timeout: 8_000 });
    const trigger = blendTrigger();
    expect(MODES, "the Blend control was found (it shows a blend mode)").toContain(
      (await trigger.innerText()).trim(),
    );
    await trigger.click();
    await app.settle(300);
    await page.locator('[role="option"]').filter({ hasText: new RegExp(`^${mode}$`) }).first().click();
    await app.settle(400);
    const op = sfd.locator('input[aria-label="Opacity"]').first();
    if (opacityPresses) {
      await op.focus();
      for (let i = 0; i < opacityPresses; i++) await page.keyboard.press("ArrowLeft");
    }
    const opacity = await op.inputValue();
    await page.keyboard.press("Escape");
    await app.settle(1_400);
    return opacity;
  };

  const seen = new Map<string, number>();
  let prev = await test.step("Normal @100 (no blend at all)", async () => {
    const r = await settledAB(app);
    expect(r, "the cached product can be compared against an inline render").not.toBeNull();
    expect.soft(r!.differing, `Normal @100 agrees exactly (${r!.differing} of ${r!.total} bytes differ)`).toBe(0);
    seen.set("Normal@100", r!.digest);
    return r!.digest;
  });
  const workerResults = () => page.evaluate(() => window.__gqRenderCache!.stats().filterWorkerResults);
  // Counted from BEFORE the drop to 70%: the first leg (Normal) changes
  // nothing further, so its product is the one this change produced.
  let lastWorker = await workerResults();
  await setMode("Normal", 30); // 100 -> 70: every mode below runs at partial opacity

  for (const mode of MODES) {
    await test.step(mode, async () => {
      const opacity = await setMode(mode, 0);
      const r = await settledAB(app);
      // Else the cached side is an inline render too, and "agree" is empty.
      const results = await workerResults();
      expect.soft(results, `${mode}: the cached product came back from the worker`).toBeGreaterThan(lastWorker);
      lastWorker = results;
      expect.soft(r, `${mode} @${opacity}: the product settled in time`).not.toBeNull();
      if (!r) return;
      const where = r.sample ? `, first at px ${r.sample.at}: ${r.sample.cached} vs ${r.sample.inline}` : "";
      expect
        .soft(r.differing, `${mode} @${opacity}: worker and inline agree exactly (worst Δ ${r.worst}${where})`)
        .toBe(0);
      // The mode must actually have reached the pixels, or "they agree" is empty.
      expect.soft(r.digest, `switching to ${mode} changed the product`).not.toBe(prev);
      prev = r.digest;
      seen.set(`${mode}@${opacity}`, r.digest);
    });
  }

  // Two modes collapsing onto one digest would mean the dialog never switched.
  const digests = [...seen.values()];
  expect(new Set(digests).size, `every blend mode produced a distinct product (${[...seen.keys()]})`).toBe(
    digests.length,
  );
  expect(app.consoleErrors, "no console errors").toEqual([]);
});
