/**
 * Nothing in the panels sheet is out of reach.
 * (Ported from tools/verify-dock-reach.js, TODO 2.1; it checked Adjustments,
 * this checks every panel.)
 *
 * It began as a report: "on a 740×390 viewport the widest control ends 133px
 * past the display edge, and the drawer scrolls vertically, so the overhang is
 * simply clipped rather than reachable." The overhang was real; the conclusion
 * was not. All of it was inside the Adjustments filter filmstrip, which
 * scrolls sideways by design — a finger swipe brings its last chip in.
 *
 * So "every control's right edge inside the dock" would FAIL correct code: a
 * strip that scrolls is a legitimate way to hold more than fits. What matters
 * is that every control is inside the dock OR inside something that can bring
 * it in — and that the strip really answers a finger. (hit-targets.spec only
 * hit-tests controls wholly in view, so it cannot see a stranded one.)
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** Controls past the dock's sides with nothing that can scroll them into view. */
const stranded = (app: App) =>
  app.page.evaluate(() => {
    const dock = document.querySelector('[data-tour="dock"]')!;
    const d = dock.getBoundingClientRect();
    const scrollsX = (el: Element) => {
      for (let p = el.parentElement; p && p !== dock.parentElement; p = p.parentElement) {
        const ox = getComputedStyle(p).overflowX;
        if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth + 1) return true;
      }
      return false;
    };
    const lost: string[] = [];
    let seen = 0;
    for (const el of dock.querySelectorAll("button, input, select, [role='switch'], [role='option']")) {
      const r = el.getBoundingClientRect();
      if (r.width < 1) continue;
      seen++;
      if ((r.right <= d.right + 1 && r.left >= d.left - 1) || scrollsX(el)) continue;
      lost.push(`"${(el.getAttribute("aria-label") || el.textContent || "?").trim().slice(0, 16)}" ${Math.round(r.right - d.right)}px past`);
    }
    return { lost, seen };
  });

const openSheet = async (app: App) => {
  await app.run("layer-new"); // so the panels have content
  await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
  await app.settle(800);
  await app.setSheetDetent("full");
};

for (const [label, viewport] of [
  ["portrait", { width: 390, height: 844 }],
  ["landscape", { width: 740, height: 390 }],
] as const) {
  test.describe(label, () => {
    test.use({ viewport, hasTouch: true });

    test("no panel strands a control past the edge with no way back", async ({ app }) => {
      await openSheet(app);
      const ids = await app.page.evaluate(() =>
        [...document.querySelectorAll("[data-panel-id]")].map((s) => s.getAttribute("data-panel-id")!),
      );
      expect(ids.length, "the sheet lists its panels").toBeGreaterThanOrEqual(8);
      const lost: string[] = [];
      let seen = 0;
      for (const id of ids) {
        if (!(await app.openPanelById(id))) continue;
        const s = await stranded(app);
        seen += s.seen;
        lost.push(...s.lost.map((l) => `${id}: ${l}`));
      }
      expect(seen, "enough controls were looked at to mean something").toBeGreaterThanOrEqual(150);
      expect(lost, "every control is inside the sheet, or in a strip that scrolls it in").toEqual([]);
    });
  });
}

test.describe("portrait", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("the Adjustments filmstrip that hangs over answers a finger swipe", async ({ app }) => {
    await openSheet(app);
    expect(await app.openPanelById("adjustments")).toBe(true);
    const strip = await app.page.evaluate(() => {
      /* Within the panel: the sheet's own chip strip scrolls sideways too. */
      const panel = document.querySelector('[data-panel-id="adjustments"]')!;
      const el = [...panel.querySelectorAll("*")].find((e) => {
        const ox = getComputedStyle(e).overflowX;
        return (ox === "auto" || ox === "scroll") && e.scrollWidth > e.clientWidth + 1;
      });
      if (!el) return null;
      el.setAttribute("data-strip", "1");
      el.scrollIntoView({ block: "center" });
      const b = el.getBoundingClientRect();
      return { x: Math.round(b.left + b.width * 0.75), y: Math.round(b.top + b.height / 2) };
    });
    expect(strip, "something overhangs at 390px, in a strip that scrolls").not.toBeNull();
    await app.touchDown(strip!.x, strip!.y);
    for (let i = 1; i <= 10; i++) await app.touchMove(strip!.x - i * 14, strip!.y, 1);
    await app.touchUp();
    await app.settle(700);
    const after = await app.page.evaluate(() => {
      const el = document.querySelector('[data-strip="1"]')!;
      const dock = document.querySelector('[data-tour="dock"]')!;
      const last = el.children[el.children.length - 1];
      return {
        scrolled: el.scrollLeft,
        range: el.scrollWidth - el.clientWidth,
        lastPast: Math.round(last.getBoundingClientRect().right - dock.getBoundingClientRect().right),
      };
    });
    expect(after.scrolled, `a finger swipe scrolls it: ${JSON.stringify(after)}`).toBeGreaterThan(after.range * 0.8);
    expect(after.lastPast, "...and the far chip ends up inside the sheet").toBeLessThanOrEqual(0);
  });
});

test.describe("desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  /* The same overhang, from the fold's grid: left `auto`, its column grew to
     the body's min-content, and Adjustments was laid out 440px wide in a
     266px dock (Metadata 280px) — the filmstrip no longer what scrolled. */
  test("no panel's body is laid out wider than its card", async ({ app }) => {
    await app.run("layer-new");
    const ids = await app.page.evaluate(() =>
      [...document.querySelectorAll("[data-panel-id]")].map((s) => s.getAttribute("data-panel-id")!),
    );
    const wide: string[] = [];
    for (const id of ids) {
      if (!(await app.openPanelById(id))) continue;
      const w = await app.page.evaluate((id) => {
        const sec = document.querySelector(`[data-panel-id="${id}"]`)!;
        const body = sec.querySelector('[class*="panelFoldInner"]');
        return body ? Math.round(body.getBoundingClientRect().width - sec.getBoundingClientRect().width) : null;
      }, id);
      if (w !== null && w > 0) wide.push(`${id}: ${w}px wider`);
    }
    expect(wide).toEqual([]);
  });
});
