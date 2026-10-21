/**
 * The tablet tier: a touch device that is not a phone.
 * (Ported from tools/verify-tablet.js, TODO 2.1.)
 *
 * It used to get the mouse shell whole — a rail and a 320px dock both in flow,
 * every control at a pointer's size. Measured before: the canvas 354px on an
 * iPad mini (48% of the screen), 378px on an iPad, and 23 kinds of control
 * under 44px, down to a 15×15 swap arrow. The tier splits two questions that
 * had been answered together: how big a control must be follows the POINTER
 * (`data-touch`, phone and tablet alike); how the shell is laid out follows
 * the SCREEN (`data-mobile` / `data-tablet`). The rail stays — a tablet has the
 * width — and the dock becomes an overlay: panels are consulted, not worked in.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const TABLETS = [
  ["iPad mini", 744, 1133],
  ["iPad", 768, 1024],
  ["iPad Pro", 1024, 1366],
] as const;

/** Which tier the shell picked, and what that produced. */
const read = (app: App) =>
  app.page.evaluate(() => {
    const d = document.documentElement;
    const box = (sel: string) => {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      return r ? { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) } : null;
    };
    const dock = document.querySelector('[data-tour="dock"]');
    const dr = dock?.getBoundingClientRect();
    const bar = document.querySelector('[data-tour="topbar"]');
    const appEl = document.querySelector("[data-app]");
    /* Everything pressable under the 44px floor, by kind. A range's box is its
       track, so its HEIGHT is the hit area. */
    const small = new Map<string, string>();
    for (const e of document.querySelectorAll("button, select, input, [role='menuitem']")) {
      const r = e.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (e.getAttribute("type") === "range" ? r.height >= 44 : r.width >= 44 && r.height >= 44) continue;
      const kind =
        String(e.className).replace(/\S*module__\w+__/g, "").split(/\s+/)[0] ||
        e.tagName.toLowerCase() + (e.getAttribute("type") ? `[${e.getAttribute("type")}]` : "");
      if (!small.has(kind)) small.set(kind, `${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    const toggle = document.querySelector("[data-panels-toggle]");
    const tr = toggle?.getBoundingClientRect();
    const hit = tr && document.elementFromPoint(tr.x + tr.width / 2, tr.y + tr.height / 2);
    return {
      mobile: d.dataset.mobile ?? null,
      tablet: d.dataset.tablet ?? null,
      touch: d.dataset.touch ?? null,
      stage: box('[data-tour="canvas"] [class*="viewport"]'),
      toolbar: box('[data-tour="toolbar"]'),
      dockOnScreen: dr ? dr.left < innerWidth - 2 : null,
      dockInFlow: dock ? getComputedStyle(dock).position === "static" : null,
      barOverflow: bar ? bar.scrollWidth - bar.clientWidth : null,
      toggle: tr ? { w: Math.round(tr.width), h: Math.round(tr.height), reaches: !!hit && toggle!.contains(hit) } : null,
      under44: [...small.entries()].map(([k, v]) => `${k} ${v}`),
      menubar: (document.querySelector("[data-menubar]")?.getBoundingClientRect().width ?? 0) > 0,
      hamburger: !!document.querySelector('header button[aria-label="Menu"]'),
      panels: document.querySelectorAll("[data-panel-id]").length,
      inDock: dock?.querySelectorAll("[data-panel-id]").length ?? 0,
      /* The shell must not be a sideways scroll container: `overflow: hidden`
         still permits a programmatic scroll, and a drawer parked off to the
         side once dragged the rail and canvas to x=-355 when it opened. */
      appScrollW: appEl ? appEl.scrollWidth - appEl.clientWidth : null,
      /* A closed drawer is not part of the page. `checkVisibility`, not a rect:
         a `visibility: hidden` element still has a box, which once passed a
         drawer that was wholly in the focus order. */
      focusableInDock: dock
        ? [...dock.querySelectorAll("button, select, input, [tabindex]")].filter((e) =>
            e.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }),
          ).length
        : null,
    };
  });

for (const [label, w, h] of TABLETS) {
  test.describe(label, () => {
    test.use({ viewport: { width: w, height: h }, hasTouch: true, isMobile: true });

    test("is a tablet: touch-sized, with a persistent rail, an overlay dock, and a top bar that fits", async ({ app }) => {
      const r = await read(app);
      expect({ mobile: r.mobile, tablet: r.tablet, touch: r.touch }, "the tablet tier, and touch").toEqual({
        mobile: null,
        tablet: "true",
        touch: "true",
      });
      expect(r.under44, "nothing pressable under 44px").toEqual([]);
      expect(r.toolbar!.x, "the rail is on screen").toBe(0);
      expect(r.toolbar!.w, "...and a real rail").toBeGreaterThan(40);
      expect({ inFlow: r.dockInFlow, onScreen: r.dockOnScreen }, "the dock starts closed, out of flow").toEqual({
        inFlow: false,
        onScreen: false,
      });
      expect(r.toggle, "a panels toggle a finger can reach").toMatchObject({ reaches: true });
      expect(r.toggle!.w >= 44 && r.toggle!.h >= 44).toBe(true);
      expect(r.barOverflow, "the top bar fits").toBeLessThanOrEqual(0);
      expect(r.appScrollW, "the shell is not a sideways scroll container").toBe(0);
    });
  });
}

test.describe("iPad, with a panel docked left and one floating", () => {
  test.use({
    viewport: { width: 768, height: 1024 },
    hasTouch: true,
    isMobile: true,
    /* Hosts a finger cannot drag a panel into: the one dock must fold them in. */
    storage: {
      "graphiq:panel-layout": JSON.stringify({
        order: [],
        left: ["layers"],
        floats: { info: { x: 40, y: 80 } },
        open: { layers: true, info: true },
      }),
    },
  });

  test("the toggle opens the dock over the canvas and shuts it, and the shell never slides", async ({ app }) => {
    const shut = await read(app);
    expect(shut.stage!.w, "the canvas stage clears 700px (it was 378)").toBeGreaterThanOrEqual(700);
    expect(shut.inDock, `no panel stranded outside the one dock (${shut.inDock} of ${shut.panels})`).toBe(shut.panels);
    expect(shut.focusableInDock, "a closed drawer is not in the focus order").toBe(0);
    const toggle = app.page.locator("[data-panels-toggle]");
    await toggle.tap();
    await app.settle(900);
    const opened = await read(app);
    expect(opened.dockOnScreen, "the toggle opens the dock").toBe(true);
    expect(opened.stage, "...leaving the canvas exactly as wide, where it was").toEqual(shut.stage);
    expect(opened.toolbar!.x, "...and the shell does not slide sideways").toBe(0);
    expect(opened.appScrollW, "...nor become scrollable").toBe(0);
    expect(opened.focusableInDock, "an open drawer is in the focus order").toBeGreaterThan(0);
    await toggle.tap();
    await app.settle(900);
    const reshut = await read(app);
    expect(reshut.dockOnScreen, "the toggle shuts it again").toBe(false);
    expect({ rail: reshut.toolbar!.x, stage: reshut.stage!.x }, "...with everything back where it was").toEqual({
      rail: 0,
      stage: shut.stage!.x,
    });
  });
});

test.describe("an iPad, cold", () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true });

  test("the tablet shell is settled before the first frame, so nothing reflows under the fit", async ({ app }) => {
    /* The tier changes the rail and takes the dock out of flow; settled in an
       effect it would paint the mouse layout first and reflow under the
       cold-load fit. The inline script in layout.tsx stamps `data-tablet`
       first. Watched from an init script under 6× CPU throttle, so a gap
       between paint and effect is wide enough to see. */
    const { page } = app;
    await page.addInitScript(() => {
      const w = window as unknown as { __frames: { tablet: string; canvasW: number; railW: number | null }[] };
      w.__frames = [];
      const tick = () => {
        const canvas = document.querySelector('[data-tour="canvas"]');
        const rail = document.querySelector('[data-tour="toolbar"]');
        if (canvas)
          w.__frames.push({
            tablet: document.documentElement.dataset.tablet ?? "",
            canvasW: canvas.clientWidth,
            railW: rail ? Math.round(rail.getBoundingClientRect().width) : null,
          });
        if (w.__frames.length < 90) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    await app.cdp("Emulation.setCPUThrottlingRate", { rate: 6 });
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-tour="canvas"]');
    await app.settle(2500);
    await app.cdp("Emulation.setCPUThrottlingRate", { rate: 1 });
    const frames = await page.evaluate(
      () => (window as unknown as { __frames: { tablet: string; canvasW: number; railW: number | null }[] }).__frames,
    );
    expect(frames.length, "frames were recorded").toBeGreaterThan(0);
    expect(frames[0].tablet, "the first frame is already the tablet shell").toBe("true");
    expect([...new Set(frames.map((f) => f.canvasW))], "the canvas is never re-measured against a reflow").toHaveLength(1);
    expect([...new Set(frames.map((f) => f.railW))], "...and the rail is its tablet width from the first frame").toHaveLength(1);
  });
});

test.describe("a phone and a desktop", () => {
  test.describe("phone", () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    test("a phone is a phone, and is touch", async ({ app }) => {
      const r = await read(app);
      expect({ mobile: r.mobile, tablet: r.tablet, touch: r.touch }).toEqual({ mobile: "true", tablet: null, touch: "true" });
    });
  });

  test.describe("desktop", () => {
    test.use({ viewport: { width: 1400, height: 900 } });
    test("a desktop is neither, keeps its dock in flow, its menu bar, and its mouse-sized controls", async ({ app }) => {
      const r = await read(app);
      expect({ mobile: r.mobile, tablet: r.tablet, touch: r.touch }).toEqual({ mobile: null, tablet: null, touch: null });
      expect(r.dockInFlow, "the dock beside the canvas").toBe(true);
      expect(r.menubar && !r.hamburger, "the inline menu bar").toBe(true);
      expect(r.under44.length, "controls at a mouse's size").toBeGreaterThan(0);
    });
  });
});
