/**
 * Dialogs at every interface scale. (Ported from tools/verify-dialog-zoom.js,
 * TODO 2.1.)
 *
 * Every dialog overlay carries `zoom: var(--ui-zoom)`, so the chrome scales
 * without resampling the canvas. Inside a zoomed subtree a viewport unit still
 * resolves against the UNZOOMED viewport and the zoom then multiplies it — so
 * `max-height: calc(100dvh - 64px)` at Large capped a dialog at 1.25 × that on
 * screen, which is not a cap. Measured at Large on a 1280×620 laptop, Export
 * ran 111px below the screen with its button unreachable; at DEFAULT scale a
 * laptop was already 27px over. The phone (whose sheets are sized by inset) is
 * the case that never broke; short desktop viewports are the ones that matter.
 */
import { test, expect, type App } from "./fixtures";

const VIEWS = [
  ["phone", { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true }],
  ["tablet", { viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true }],
  ["desktop", { viewport: { width: 1400, height: 700 } }],
  ["laptop", { viewport: { width: 1280, height: 620 } }],
] as const;
const SCALES = ["compact", "default", "comfortable", "large"] as const;
/* Preferences is the tallest capped dialog; Export the tallest uncapped one. */
const DIALOGS = [
  ["Settings", "Preferences"],
  ["File", "Export as"],
] as const;

const measure = (app: App) =>
  app.page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const vh = visualViewport ? visualViewport.height : innerHeight;
    const foot = d.querySelector("footer");
    const primary = (foot ? [...foot.querySelectorAll("button")] : [...d.querySelectorAll("button")]).pop();
    const pr = primary?.getBoundingClientRect();
    const hit = pr && pr.width > 0 ? document.elementFromPoint(pr.x + pr.width / 2, pr.y + pr.height / 2) : null;
    const faults: string[] = [];
    if (r.bottom - vh > 1) faults.push(`${Math.round(r.bottom - vh)}px below the screen`);
    if (-r.top > 1) faults.push(`${Math.round(-r.top)}px above it`);
    if (r.right - innerWidth > 1) faults.push(`${Math.round(r.right - innerWidth)}px past the right edge`);
    if (!(hit && primary!.contains(hit))) faults.push(`"${primary?.textContent?.trim().slice(0, 16)}" cannot be pressed where it sits`);
    return {
      /* The zoom is on the OVERLAY, not the dialog — which is what made the
         compounding easy to miss in the dialog's own computed style. */
      overlayZoom: d.parentElement ? getComputedStyle(d.parentElement).zoom : null,
      faults,
      /* Non-vacuity: a tall case must fit by scrolling, not by being small. */
      middleScrolls: [...d.querySelectorAll("*")].some((c) => {
        if (c.closest("header, footer")) return false;
        const oy = getComputedStyle(c).overflowY;
        return (oy === "auto" || oy === "scroll") && c.scrollHeight > c.clientHeight + 2;
      }),
      h: Math.round(r.height),
      vh: Math.round(vh),
    };
  });

async function openDialog(app: App, menu: string, item: string) {
  const { page } = app;
  const menuButton = page.locator('header button[aria-label="Menu"]');
  if (await menuButton.isVisible().catch(() => false)) {
    await menuButton.click();
    await page.waitForSelector('[data-menubar][data-sheet="true"]');
    await app.settle(300);
  }
  /* Real clicks, and CHECK the menu that opened: a menu name toggles, so
     clicking one while another is expanded closes that instead — which once
     read as "Export will not open at Compact on a phone". */
  const name = page.locator("[data-menubar] > div > button", { hasText: new RegExp(`^${menu}$`) }).first();
  for (let i = 0; i < 2 && (await name.getAttribute("data-active")) !== "true"; i++) {
    await name.click();
    await app.settle(350);
  }
  const row = page.locator('[data-menubar] [role="menu"] button', { hasText: item }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await page.waitForSelector('[role="dialog"]');
  await app.still('[role="dialog"]');
}

for (const [vname, use] of VIEWS)
  for (const scale of SCALES)
    test.describe(`${vname} at ${scale}`, () => {
      test.use(use);

      test("Preferences and Export stay on screen, their primary button pressable", async ({ app }) => {
        await app.page.evaluate((s) => (document.documentElement.dataset.uiscale = s), scale);
        await app.run("layer-new");
        for (const [menu, item] of DIALOGS) {
          await openDialog(app, menu, item);
          const m = await measure(app);
          expect(m, `${item} opens`).not.toBeNull();
          if (scale === "large") expect(m!.overlayZoom, `${item}: the scale is really in force`).toBe("1.25");
          expect.soft(m!.faults, `${item} fits the screen`).toEqual([]);
          /* Where the cap has work to do — Large on a short desktop — it is
             doing it: the contents scroll inside a dialog that fits. */
          if (scale === "large" && (vname === "laptop" || vname === "desktop"))
            expect.soft(m!.middleScrolls, `${item}: fits by scrolling, not by being small (${m!.h}px in ${m!.vh})`).toBe(true);
          await app.page.keyboard.press("Escape");
          await expect(app.page.locator('[role="dialog"]')).toHaveCount(0);
        }
        expect(app.consoleErrors, "no console errors").toEqual([]);
      });
    });
