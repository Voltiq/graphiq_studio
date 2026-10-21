/**
 * A phone as a real device profile: what only a true profile can measure.
 * (Ported from tools/mobile.js, TODO 2.1. Its `--self-test` — the checks run
 * again with the shell deliberately broken, which must fail — is what
 * mutation testing does for every spec here.)
 *
 * What the harness found when it was written: in a `hasTouch` context
 * `page.mouse` is still a MOUSE (`pointerType: "mouse"`), so rails driving a
 * touch subject with it never took the app's touch branches; `isMobile` and a
 * phone's pixel ratio were mostly missing; nothing throttled the CPU. So: the
 * whole profile (dpr 3, mobile UA, coarse pointer), real touch input, and a
 * throttled boot.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const IPHONE = {
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
};

test.describe("an iPhone profile", () => {
  test.use(IPHONE);

  test("the profile is fully applied, and only the touchscreen delivers a touch", async ({ app }) => {
    const profile = await app.page.evaluate(() => ({
      dpr: devicePixelRatio,
      coarse: matchMedia("(pointer: coarse) and (hover: none)").matches,
      mobileUA: /iPhone|Android/i.test(navigator.userAgent),
      shell: document.documentElement.dataset.mobile ?? null,
    }));
    expect(profile, "dpr 3, a finger, a phone's UA and the phone shell").toEqual({
      dpr: 3,
      coarse: true,
      mobileUA: true,
      shell: "true",
    });
    await app.page.evaluate(() => {
      const w = window as unknown as { __ptr: string[] };
      w.__ptr = [];
      addEventListener("pointerdown", (e: PointerEvent) => w.__ptr.push(e.pointerType), true);
    });
    const c = await app.canvasBox();
    await app.page.mouse.click(c.x + 20, c.y + 20);
    await app.page.touchscreen.tap(c.x + 40, c.y + 40);
    const seen = await app.page.evaluate(() => (window as unknown as { __ptr: string[] }).__ptr);
    expect(seen, "page.mouse is a mouse even here; the touchscreen is a finger").toEqual(["mouse", "touch"]);
  });

  test("a real touch opens the tools drawer, and a finger drag paints", async ({ app }) => {
    const { page } = app;
    /* The TRANSITION, not the presence: the drawer is in the DOM at all
       times, parked off-screen when shut. */
    const railX = () =>
      page.evaluate(() => {
        const r = document.querySelector('[data-tour="toolbar"][data-mobile-rail]');
        return r ? Math.round(r.getBoundingClientRect().x) : null;
      });
    const shut = await railX();
    const tools = page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first();
    await tools.tap();
    await app.settle(700);
    const open = await railX();
    expect(shut!, "parked off-screen while shut").toBeLessThan(0);
    expect(open!, "...on screen once a finger opens it").toBeGreaterThanOrEqual(0);
    await tools.tap(); // and shut again, so the stroke lands on the picture
    await app.settle(700);
    expect(await railX(), "the same tap shuts it").toBe(shut);

    /* Pixels, not an arrival: only a committed stroke proves the touch branch
       understood the event. Read from the exported document — a screenshot
       took in overlays and passed with touch pointers dropped (a mutation). */
    await app.run("layer-new");
    await app.key("b");
    const before = await app.exported();
    const b = await app.canvasBox();
    await app.touchDown(b.x + b.width * 0.25, b.y + b.height * 0.3);
    await app.touchMove(b.x + b.width * 0.75, b.y + b.height * 0.7, 16);
    await app.touchUp();
    await expect.poll(async () => (await app.exported()).ink, { message: "a touch drag paints a stroke" }).toBeGreaterThan(
      before.ink,
    );
  });

  test("a phone gets the phone's budgets", async ({ app }) => {
    const budget = await app.page.evaluate(() =>
      (window as unknown as { __gqBudgets?: () => { cacheMB: number; overlayDpr: number } }).__gqBudgets?.(),
    );
    expect(budget, "the budgets hook is there").toBeTruthy();
    expect(budget!.cacheMB, "a phone-sized render cache").toBeLessThanOrEqual(64);
    expect(budget!.overlayDpr, "overlays capped at 2× on a dpr-3 screen").toBeLessThanOrEqual(2);
  });
});

test.describe("an iPhone profile, throttled", () => {
  test.use({ ...IPHONE, hardware: { cores: 4, memoryGB: 4 } });

  test("a cold boot survives 4× CPU throttling", async ({ app }) => {
    test.slow();
    /* Throttled BEFORE the navigation: the expensive part of a boot is the
       first render, over before a post-load throttle takes effect. Reported
       loosely: a hard threshold on a shared runner is a flake generator. */
    await app.cdp("Emulation.setCPUThrottlingRate", { rate: 4 });
    const t0 = Date.now();
    await app.page.reload({ waitUntil: "domcontentloaded" });
    await app.page.waitForSelector('[data-tour="canvas"]', { timeout: 120_000 });
    const ms = Date.now() - t0;
    await app.cdp("Emulation.setCPUThrottlingRate", { rate: 1 });
    expect(ms, `booted in ${ms}ms at 4×`).toBeLessThan(60_000);
  });
});

test.describe("an iPhone SE (320×568)", () => {
  test.use({ viewport: { width: 320, height: 568 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });

  test("nothing in the header or the dock is clipped off the screen", async ({ app }) => {
    /* Its first run found the top bar's actions running to x=335 of 320, with
       "Switch to light mode" off the screen and no scroll to reach it. Only
       rows that must FIT: the shut drawers are off-screen on purpose. */
    const clipped = await clippedIn(app, ["header", '[data-tour="mobilebar"]']);
    expect(clipped, "every control in the header and the dock fits 320px").toEqual([]);
  });
});

const clippedIn = (app: App, rows: string[]) =>
  app.page.evaluate((rows) => {
    const out: string[] = [];
    for (const row of rows.flatMap((s) => [...document.querySelectorAll(s)]))
      for (const el of row.querySelectorAll("button")) {
        const r = el.getBoundingClientRect();
        if (r.width > 0 && (r.right > innerWidth + 1 || r.left < -1))
          out.push(`${(el.getAttribute("aria-label") || el.textContent!.trim() || "?").slice(0, 30)} @${Math.round(r.left)}..${Math.round(r.right)}`);
      }
    return out;
  }, rows);
