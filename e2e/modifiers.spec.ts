/**
 * Shift / Alt / Ctrl on a device that has none. (Ported from tools/verify-modifiers.js, TODO 2.1.)
 *
 * Roughly thirty canvas behaviours are gated on a held modifier, across 83
 * call sites, and a finger could reach none of them. Rather than thirty bespoke
 * gestures, the modifier is latched by a chip and injected into the event
 * before anything reads it — so every site keeps the `e.altKey` test it had.
 *
 * That injection is the load-bearing claim, so it is checked through REAL
 * behaviour, not by reading a flag back: with Alt armed the Zoom tool zooms out
 * instead of in, and a marquee dragged across a selection subtracts from it.
 *
 * Every press here is a real touch — chips and rows by `tap()`, the canvas by
 * the fixture's finger. The script this came from clicked with the mouse,
 * which in a touch context still reports `pointerType: "mouse"`: the device
 * the chips exist for was never the one driving them.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("the chips stay out of the way where there is a keyboard", async ({ app }) => {
    await expect(app.page.locator('[role="group"][aria-label="Keyboard modifiers"]')).toBeHidden();
  });
});

const chip = (page: Page, name: string) =>
  page.locator('[aria-label="Keyboard modifiers"] button', { hasText: new RegExp(`^${name}`) }).first();
const mode = (page: Page, name: string) => chip(page, name).getAttribute("data-mode");
const zoom = (page: Page) =>
  page.evaluate(() => {
    const el = [...document.querySelectorAll('[data-tour="canvas"] span')].find((s) => /^\d+%$/.test((s.textContent ?? "").trim()));
    return el ? parseInt(el.textContent!, 10) : NaN;
  });
async function centre(app: App) {
  const b = await app.canvasBox();
  return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
}
/** A finger tap on the canvas. */
async function tapCanvas(app: App, at: { x: number; y: number }): Promise<void> {
  await app.touchDown(at.x, at.y);
  await app.touchUp();
  await app.settle(500);
}
/** A finger drag on the canvas. */
async function dragCanvas(app: App, x1: number, y1: number, x2: number, y2: number): Promise<void> {
  await app.touchDown(x1, y1);
  await app.touchMove(x2, y2, 8);
  await app.touchUp();
  await app.settle(700);
}
async function pickTool(app: App, name: RegExp): Promise<void> {
  await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().tap();
  await app.settle(500);
  await app.page.locator('[data-tour="toolbar"]').getByRole("button", { name }).first().tap();
  await app.settle(500);
  if ((await app.page.evaluate(() => document.documentElement.dataset.drawer ?? "")) !== "") {
    await app.page.evaluate(() => window.history.back());
    await app.settle(500);
  }
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("a chip cycles off → armed → locked → off", async ({ app }) => {
    const { page } = app;
    await expect(chip(page, "Shift"), "the chips are there when there is no keyboard").toBeVisible();
    const seen = [await mode(page, "Alt")];
    for (let i = 0; i < 3; i++) {
      await chip(page, "Alt").tap();
      seen.push(await mode(page, "Alt"));
    }
    expect(seen).toEqual(["off", "armed", "locked", "off"]);
  });

  test("Alt reaches the Zoom tool: armed zooms out once, locked keeps zooming out", async ({ app }) => {
    const { page } = app;
    await pickTool(app, /^Zoom\b/);
    const at = await centre(app);
    const z0 = await zoom(page);
    await tapCanvas(app, at);
    const z1 = await zoom(page);
    expect(z1, "without a modifier the zoom tool zooms in").toBeGreaterThan(z0);

    await chip(page, "Alt").tap(); // armed
    await tapCanvas(app, at);
    const z2 = await zoom(page);
    expect(z2, "with Alt armed the same tap zooms OUT").toBeLessThan(z1);
    expect(await mode(page, "Alt"), "...and the arming was spent by that gesture").toBe("off");
    await tapCanvas(app, at);
    expect(await zoom(page), "so the next tap zooms in again").toBeGreaterThan(z2);

    /* Climb away from the floor first: zoom clamps at its minimum, and two
       steps out from near it look the same whether or not the lock held. */
    for (let i = 0; i < 3; i++) await tapCanvas(app, at);
    const high = await zoom(page);
    await chip(page, "Alt").tap();
    await chip(page, "Alt").tap(); // locked
    await tapCanvas(app, at);
    const z4 = await zoom(page);
    await tapCanvas(app, at);
    const z5 = await zoom(page);
    expect([z4 < high, z5 < z4], `a locked Alt survives more than one gesture: ${high}% → ${z4}% → ${z5}%`).toEqual([true, true]);
    expect(await mode(page, "Alt")).toBe("locked");
  });

  test("an armed modifier does not leak onto the rest of the interface", async ({ app }) => {
    /* A latched Alt has no business changing what a tap on a button does.
       Recorded from a listener on the bottom bar, which is not the canvas. */
    const { page } = app;
    await chip(page, "Alt").tap();
    const bar = page.locator('[data-tour="mobilebar"] button').first();
    await page.evaluate(() => {
      const b = document.querySelector<HTMLElement>('[data-tour="mobilebar"] button')!;
      b.addEventListener("pointerdown", (e) => ((window as unknown as { __alt?: boolean }).__alt = e.altKey), {
        capture: true,
        once: true,
      });
    });
    await bar.tap();
    await app.settle(300);
    expect(await page.evaluate(() => (window as unknown as { __alt?: boolean }).__alt), "altKey on a bottom-bar tap").toBe(false);
  });

  test("with Alt armed, a marquee across a selection subtracts from it", async ({ app }) => {
    const { page } = app;
    /** The Info panel's Pixels row — the COUNT, not the bounds: dragging across
     *  the top half of a square leaves a remainder the same size as a replace,
     *  and a mutation that disabled the injection passed that version. */
    const selected = async () => {
      /* Wait out a Chromium quirk before tapping the bar: after a touch drag on a
         `touch-action: none` element (the canvas), the next tap within ~2 s gets
         pointerdown/pointerup but NO click. Reproduced with a bare div outside
         the app, so it is the browser's touch pipeline, not this code (see
         REAL-DEVICE-CHECKLIST.md: whether a real phone does it too is open). */
      await app.settle(2_500);
      await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
      await app.settle(700);
      await app.setSheetDetent("full");
      expect(await app.openPanelById("info"), "the Info panel opens").toBe(true);
      const n = await page.evaluate(() => {
        const label = [...document.querySelectorAll('[data-tour="dock"] *')].find(
          (el) => el.children.length === 0 && el.textContent?.trim() === "Pixels",
        );
        const v = label?.parentElement?.textContent?.replace(/[^0-9]/g, "") ?? "";
        return v ? parseInt(v, 10) : 0;
      });
      await page.evaluate(() => window.history.back());
      await app.settle(700);
      return n;
    };
    await pickTool(app, /^Rectangular marquee\b|^Marquee\b/);
    const c = await centre(app);
    await dragCanvas(app, c.x - 90, c.y - 90, c.x + 90, c.y + 90);
    const whole = await selected();
    expect(whole, "a marquee makes a selection").toBeGreaterThan(0);
    /* The top-left quadrant: subtracting it leaves an L of three quarters;
       replacing with it leaves one quarter. */
    await chip(page, "Alt").tap(); // armed
    await dragCanvas(app, c.x - 90, c.y - 90, c.x, c.y);
    const cut = await selected();
    expect(cut / whole, `${whole} px → ${cut} px: ~0.75 is a subtract, ~0.25 a replace`).toBeGreaterThan(0.6);
    expect(cut / whole).toBeLessThan(0.9);

    /* One-shot means ONE gesture, even back to back. A drag ends with no
       click, so its latch waits on a fallback timer; a drag started straight
       after it must not inherit the Alt. The second drag starts OUTSIDE the
       selection — inside the quadrant just cut away, since a marquee drag that
       starts inside a selection moves it instead (the first draft of this did
       that and read as a failure). A replace leaves that small rectangle
       (~0.15 of the square); an inherited subtract removes nothing (~0.75). */
    await chip(page, "Alt").tap();
    await app.touchDown(c.x - 90, c.y - 90);
    await app.touchMove(c.x, c.y, 8);
    await app.touchUp();
    /* 200 ms: a quick human, and well inside the 600 ms fallback. (22 ms, which
       no hand manages, lands before the first selection has been committed.) */
    await app.settle(200);
    await app.touchDown(c.x - 80, c.y - 80);
    await app.touchMove(c.x - 10, c.y - 10, 8);
    await app.touchUp();
    await app.settle(700);
    const again = await selected();
    expect(again / whole, `${whole} px → ${again} px: ~0.15 is a replace, ~0.75 an inherited subtract`).toBeLessThan(0.3);
    expect(again, "...and it did select something").toBeGreaterThan(0);
  });

  /** Two layers, with the panels drawer open on the Layers panel. */
  async function twoLayersInTheDrawer(app: App) {
    const { page } = app;
    await app.run("layer-new");
    await app.run("layer-new");
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
    await app.settle(700);
    await app.setSheetDetent("full");
    expect(await app.openPanelById("layers"), "the Layers panel opens").toBe(true);
  }

  test("with a drawer open the chips stay reachable, and Alt-tapping a layer clips it", async ({ app }) => {
    const { page } = app;
    await twoLayersInTheDrawer(app);
    /* The enabling fix: the drawer's scrim covered the options bar, so the
       chips were unreachable exactly when the panel behaviours were on screen. */
    const reachable = await page.evaluate(() => {
      const c = document.querySelector('[aria-label="Keyboard modifiers"] button')!;
      const r = c.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      return !!hit && (hit === c || c.contains(hit));
    });
    expect(reachable, "a tap on a chip lands on the chip").toBe(true);
    /* A clip group underlines the base layer's name — read as the observable. */
    const clipBases = () =>
      page.evaluate(
        () =>
          [...document.querySelectorAll<HTMLElement>('[data-tour="dock"] [class*="layerName"]')].filter(
            (e) => e.style.textDecoration === "underline",
          ).length,
      );
    const rows = page.locator('[data-tour="dock"] [class*="layerItem"]');
    expect(await rows.count(), "two layers to clip together").toBeGreaterThanOrEqual(2);
    expect(await clipBases(), "nothing clipped yet").toBe(0);
    await chip(page, "Alt").tap();
    await rows.first().tap();
    await app.settle(900);
    expect(await clipBases(), "Alt-tapping a layer row clips it to the one below").toBeGreaterThan(0);
  });

  test("Shift-tapping a layer mask disables it", async ({ app }) => {
    const { page } = app;
    await app.run("layer-new");
    await app.run("mask-add");
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
    await app.settle(700);
    await app.setSheetDetent("full");
    expect(await app.openPanelById("layers")).toBe(true);
    /* `data-tip`, not `title`: Tooltip.tsx relocates every title attribute so
       the app can draw its own tooltip. */
    const thumb = page.locator('[data-tour="dock"] [data-tip*="Layer mask"]').first();
    await expect(thumb, "the mask is in the panel").toHaveCount(1);
    const before = (await thumb.getAttribute("data-tip")) ?? "";
    expect(before, "it starts enabled").not.toMatch(/disabled/i);
    await chip(page, "Shift").tap();
    await thumb.tap();
    await app.settle(900);
    expect(await thumb.getAttribute("data-tip"), "Shift-tap disabled it").toMatch(/disabled/i);
  });
});
