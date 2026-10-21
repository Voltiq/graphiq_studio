/**
 * Panels the phone used to leave behind. (Ported from
 * tools/verify-stranded-panels.js, TODO 2.1.)
 *
 * A desktop has three homes for a panel — the right dock, the left dock,
 * floating windows — and the phone shows one. Anything arranged into the other
 * two was still RENDERED, into a host the phone hides: seeded and measured, 13
 * of 14 panels in the sheet and the fourteenth nowhere a finger could go. The
 * left dock was worse than absent: at 360px it laid out at full width over the
 * shell and swallowed every press, so the start card could not be dismissed.
 *
 * Layouts are SEEDED through localStorage: the arrangement is what matters,
 * and dragging a panel into the left dock is not a phone gesture anyway.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const LAYOUT_KEY = "graphiq:panel-layout";
const LEFT = { order: [], left: ["layers"], floats: {}, open: { layers: true } };
const FLOAT = { order: [], left: [], floats: { info: { x: 40, y: 80 } }, open: { info: true } };
const BOTH = { order: [], left: ["layers"], floats: { info: { x: 40, y: 80 } }, open: { layers: true, info: true } };

const report = (app: App) =>
  app.page.evaluate(() => {
    const dock = document.querySelector('[data-tour="dock"]')!;
    const inSheet = [...dock.querySelectorAll("[data-panel-id]")].map((e) => e.getAttribute("data-panel-id")!);
    const anywhere = [...document.querySelectorAll("[data-panel-id]")].map((e) => e.getAttribute("data-panel-id")!);
    const left = document.querySelector('[aria-label="Left dock"]')?.getBoundingClientRect();
    const mid = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    return {
      inSheet,
      stranded: anywhere.filter((id) => !inSheet.includes(id)),
      twice: anywhere.length - inSheet.length,
      leftWidth: left ? Math.round(left.width) : 0,
      midIsLeftDock: !!mid?.closest('[aria-label="Left dock"]'),
    };
  });

for (const [label, layout, wanted] of [
  ["a panel docked LEFT", LEFT, "layers"],
  ["a panel FLOATING", FLOAT, "info"],
  ["both at once", BOTH, "layers"],
] as const) {
  test.describe(`a 360px phone with ${label}`, () => {
    test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, storage: { [LAYOUT_KEY]: JSON.stringify(layout) } });

    test("nothing lies over the screen, and every panel is in the sheet and opens", async ({ app }) => {
      const before = await report(app);
      expect({ leftWidth: before.leftWidth, midIsLeftDock: before.midIsLeftDock }, "no host lies over the shell").toEqual({
        leftWidth: 0,
        midIsLeftDock: false,
      });
      await app.run("layer-new");
      await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
      await app.settle(700);
      const r = await report(app);
      expect(r.stranded, "every panel is in the sheet").toEqual([]);
      expect(r.twice, "...each once").toBe(0);
      expect(r.inSheet, "including the one that was arranged away").toContain(wanted);
      expect(await app.openPanelById(wanted), "...and it opens when tapped").toBe(true);
    });
  });
}

test.describe("the arrangement, round trip", () => {
  test.use({ viewport: { width: 360, height: 780 }, hasTouch: true, storage: { [LAYOUT_KEY]: JSON.stringify(BOTH) } });

  test("the phone folds the arrangement into one sheet without rewriting it", async ({ app }) => {
    /* In ONE context, resized: a fresh desktop context re-seeds and shares no
       storage, so it only ever proves that seeding works — it passed a
       mutation that wrote `setLeft([])` on the phone. */
    const { page } = app;
    await app.run("layer-new");
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
    await app.settle(700);
    expect(await app.openPanelById("layers")).toBe(true); // give a rewrite its chance
    await app.settle(500);
    const stored = () => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "null"), LAYOUT_KEY);
    const s = await stored();
    expect({ left: s?.left, float: !!s?.floats?.info }, "the phone does not rewrite the stored arrangement").toEqual({
      left: ["layers"],
      float: true,
    });
    /* Widening a TOUCH context gives a tablet, which folds panels into one dock
       for the phone's reason (both other hosts are placed by dragging). */
    await page.setViewportSize({ width: 1400, height: 900 });
    await app.settle(1400);
    const wide = await page.evaluate(() => {
      const dock = document.querySelector('[data-tour="dock"]')!;
      return {
        tablet: document.documentElement.dataset.tablet ?? null,
        inDock: dock.querySelectorAll("[data-panel-id]").length,
        everywhere: document.querySelectorAll("[data-panel-id]").length,
      };
    });
    expect(wide.tablet, "1400×900 with touch is a tablet").toBe("true");
    expect(wide.inDock, "...which holds every panel in its one dock").toBe(wide.everywhere);
    const after = await stored();
    expect({ left: after?.left, float: !!after?.floats?.info }, "...with the arrangement still intact underneath").toEqual({
      left: ["layers"],
      float: true,
    });
  });
});

test.describe("a phone, painting", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("a stroke with the sheet shut barely touches the panels", async ({ app }) => {
    /* The item asked for ZERO panel renders during a stroke with the sheet
       shut, on the premise that it was "fully mounted and re-rendering".
       Measured: two across a thirty-step stroke (start and end), against 52
       with it open — the Info readout doing its job. Zero means unmounting
       the dock and losing its state, so a bound is asserted instead. */
    const { page } = app;
    await app.run("layer-new");
    await app.key("b");
    const cv = await app.canvasBox();
    await page.evaluate(() => ((window as unknown as { __gqPanelRenders: number }).__gqPanelRenders = 0));
    await page.mouse.move(cv.x + cv.width * 0.3, cv.y + cv.height * 0.4);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++) await page.mouse.move(cv.x + cv.width * (0.3 + 0.012 * i), cv.y + cv.height * (0.4 + 0.008 * i));
    await page.mouse.up();
    await app.settle(800);
    const renders = await page.evaluate(() => (window as unknown as { __gqPanelRenders?: number }).__gqPanelRenders ?? -1);
    expect(renders, "the hook is counting").toBeGreaterThanOrEqual(0);
    expect(renders, "a few renders across 30 steps, not one a step").toBeLessThanOrEqual(4);
  });
});
