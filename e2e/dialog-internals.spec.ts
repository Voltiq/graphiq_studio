/**
 * The dialogs whose insides could not fit a phone. (Ported from
 * tools/verify-dialog-internals.js, TODO 2.1.)
 *
 * Full-screen sheets fixed the boxes, not what was in them:
 *  - PREVIEWS — Blur Gallery, Liquify, Warp and Refine Edge put a 500–560px
 *    canvas beside their controls; on a 390px phone the controls were pushed
 *    off the edge and clipped (Blur Gallery's only slider 294px past it,
 *    Liquify's and Warp's 354px). Gone, with nothing to scroll sideways.
 *  - RAILS — Layer Style and Smart Filters keep a list beside their panel;
 *    stacked, Layer Style's was 562px of an 844px sheet. They are a strip
 *    along the top now, and a strip legitimately overruns its edge — so the
 *    property is "the last item can be reached", not "nothing sticks out".
 *  - PREFERENCES — twelve sections: an icon column down the left, every one on
 *    screen, with a heading that names the open one.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const DESKTOP = { viewport: { width: 1400, height: 900 } };

/** A layer and a selection (Refine Edge needs one), then the dialog. */
async function openDialog(app: App, menu: string, item: string) {
  const { page } = app;
  await app.run("layer-new");
  await page.keyboard.press("Control+a");
  await app.settle(300);
  const menuButton = page.locator('header button[aria-label="Menu"]');
  if (await menuButton.isVisible().catch(() => false)) {
    await menuButton.click();
    await page.waitForSelector('[data-menubar][data-sheet="true"]');
  }
  await page.locator("[data-menubar] > div > button", { hasText: new RegExp(`^${menu}$`) }).first().click();
  const row = page.locator('[data-menubar] [role="menu"] button', { hasText: item }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await page.waitForSelector('[role="dialog"]');
  await app.still('[role="dialog"]');
}

/** Everything inside the dialog that the claims are about. */
const read = (app: App) =>
  app.page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')!;
    const dr = d.getBoundingClientRect();
    const past = (e: Element) => {
      const r = e.getBoundingClientRect();
      return Math.round(Math.max(r.right - dr.right, dr.left - r.left));
    };
    const sliders = [...d.querySelectorAll('input[type="range"]')];
    const foot = d.querySelector("footer");
    const primary = (foot ? [...foot.querySelectorAll("button")] : [...d.querySelectorAll("button")]).pop()!;
    const pr = primary.getBoundingClientRect();
    const hit = document.elementFromPoint(pr.x + pr.width / 2, pr.y + pr.height / 2);
    const rail = d.querySelector("[data-dialog-rail]");
    const rr = rail?.getBoundingClientRect();
    return {
      dialogScrollsX: d.scrollWidth > d.clientWidth + 1,
      sliders: sliders.length,
      slidersOut: sliders.map(past).filter((p) => p > 1),
      primary: primary.textContent!.trim().slice(0, 16),
      primaryOk: past(primary) <= 1 && !!hit && primary.contains(hit),
      canvases: [...d.querySelectorAll("canvas")]
        .map((c) => {
          const r = c.getBoundingClientRect();
          if (!r.width) return null;
          /* Capping the width without letting the height follow squashes it. */
          const squashed = c.width && c.height && r.height ? Math.abs(c.width / c.height - r.width / r.height) > 0.02 : false;
          return { w: Math.round(r.width), h: Math.round(r.height), past: past(c), squashed };
        })
        .filter((c) => c !== null),
      rail: rail
        ? {
            w: Math.round(rr!.width),
            h: Math.round(rr!.height),
            row: getComputedStyle(rail).flexDirection === "row",
            overflowing: rail.scrollWidth > rail.clientWidth + 2,
            /* SCROLLABLE, not just overflowing: `overflow: hidden` still lets
               script set scrollLeft, so a tail check that scrolls from script
               passes on a strip no finger could move. */
            scrolls: ["auto", "scroll"].includes(getComputedStyle(rail).overflowX),
          }
        : null,
    };
  });

/** Scroll the strip to its end: is the last item inside, and pressable? */
const railTail = (app: App) =>
  app.page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]')!;
    const rail = d.querySelector("[data-dialog-rail]")!;
    rail.scrollLeft = rail.scrollWidth;
    const items = [...rail.querySelectorAll('[role="option"], button')];
    const last = items[items.length - 1];
    const r = last.getBoundingClientRect();
    const dr = d.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return { inside: r.left >= dr.left - 1 && r.right <= dr.right + 1, pressable: !!hit && (last === hit || last.contains(hit)) };
  });

test.describe("on a phone", () => {
  test.use(PHONE);

  for (const [menu, item] of [
    ["Effects", "Blur gallery"],
    ["Effects", "Liquify"],
    ["Effects", "Warp"],
    ["Select", "Refine edge"],
  ] as const)
    test(`${item}: its preview fits, unsquashed, and every slider and the apply button are inside`, async ({ app }) => {
      await openDialog(app, menu, item);
      const m = await read(app);
      expect(m.slidersOut, "every slider lies inside the dialog (was 294–354px past)").toEqual([]);
      expect(m.primaryOk, `"${m.primary}" is inside and pressable`).toBe(true);
      expect(m.dialogScrollsX, "no sideways scrolling").toBe(false);
      /* Non-vacuity: there has to BE a preview. */
      expect(m.canvases.length, "a preview is rendered").toBeGreaterThan(0);
      for (const c of m.canvases) {
        expect(c.past, `a ${c.w}×${c.h} preview fits`).toBeLessThanOrEqual(1);
        expect(c.squashed, `...keeping its aspect ratio`).toBe(false);
      }
      expect(Math.max(...m.canvases.map((c) => c.w)), "...and is a real preview").toBeGreaterThan(100);
    });

  for (const [menu, item] of [
    ["Layer", "Layer style"],
    ["Effects", "Smart filters"],
  ] as const)
    test(`${item}: its side rail is a strip along the top whose last item can be reached`, async ({ app }) => {
      await openDialog(app, menu, item);
      const m = await read(app);
      expect(m.rail, "a rail").not.toBeNull();
      expect(m.rail!.row && m.rail!.h <= 120, `a strip, not a column (${m.rail!.w}×${m.rail!.h}; Layer Style's was 200×562)`).toBe(true);
      if (m.rail!.overflowing) {
        expect(m.rail!.scrolls, "overrunning, so it must scroll").toBe(true);
        expect(await railTail(app), "scrolled to the end, the last item is inside and pressable").toEqual({ inside: true, pressable: true });
      }
      expect({ out: m.slidersOut, primary: m.primaryOk, sideways: m.dialogScrollsX }, "sliders and buttons inside").toEqual({
        out: [],
        primary: true,
        sideways: false,
      });
    });

  test("Layer style ▸ Drop shadow: every slider and the primary button inside — the item's own check", async ({ app }) => {
    await openDialog(app, "Layer", "Layer style");
    const ds = app.page.locator('[role="dialog"] [role="option"]', { hasText: /Drop shadow/i }).first();
    await expect(ds, "Drop shadow can be selected").toHaveCount(1);
    await ds.scrollIntoViewIfNeeded();
    await ds.click();
    await app.settle(700);
    const m = await read(app);
    expect(m.sliders, "its sliders are there").toBeGreaterThan(0);
    expect({ out: m.slidersOut, primary: m.primaryOk }).toEqual({ out: [], primary: true });
  });

  test("Preferences: twelve sections as an icon column, all on screen, with a heading that follows", async ({ app }) => {
    await openDialog(app, "Settings", "Preferences");
    const readPrefs = () =>
      app.page.evaluate(() => {
        const d = document.querySelector('[role="dialog"][aria-label="Preferences"]')!;
        const rail = d.querySelector("[data-dialog-rail]")!;
        const head = d.querySelector<HTMLElement>("[data-pane-head]");
        const rr = rail.getBoundingClientRect();
        const items = [...rail.children].map((c) => {
          const r = c.getBoundingClientRect();
          return { y: r.y, h: r.height, label: c.getAttribute("aria-label") };
        });
        return {
          railW: Math.round(rr.width),
          column: items.length > 1 && items[1].y > items[0].y,
          total: items.length,
          onScreen: items.filter((i) => i.y >= rr.top - 1 && i.y + i.h <= rr.bottom + 1).length,
          undersized: items.filter((i) => i.h < 44).length,
          /* Hidden from the eye, not from a screen reader. */
          labelsHidden: [...rail.querySelectorAll("button > span")].every((e) => getComputedStyle(e).display === "none"),
          named: items.every((i) => !!i.label),
          head: head && getComputedStyle(head).display !== "none" ? head.innerText.trim() : null,
          besidePane: !!head && head.parentElement!.getBoundingClientRect().x >= rr.right - 1,
          scrollsX: d.scrollWidth - d.clientWidth,
        };
      });
    const p = await readPrefs();
    expect(p.column && p.railW <= 72, `a ${p.railW}px icon column`).toBe(true);
    expect(p.total, "twelve sections or more").toBeGreaterThanOrEqual(12);
    expect(p.onScreen, "all on screen at once").toBe(p.total);
    expect(p.undersized, "each a 44px target").toBe(0);
    expect(p.labelsHidden && p.named, "the words hidden from the eye, not the screen reader").toBe(true);
    expect(p.besidePane && p.scrollsX <= 0, "the pane beside the rail, nothing sideways").toBe(true);
    expect(p.head, "a heading names the open section").toBeTruthy();
    await app.page.locator("[data-dialog-rail] button").nth(10).click();
    await app.settle(500);
    expect((await readPrefs()).head, "...and follows the section you pick").not.toBe(p.head);
  });

  test("Preferences' footer: no button squeezed narrower than its label, all on one row", async ({ app }) => {
    /* The secondary actions shrank below their own labels and the words ran
       into one another ("Restore defaultsExport settings…"); the BOXES never
       overlapped, which is why box checks never complained. So: the text. */
    await openDialog(app, "Settings", "Preferences");
    const f = await app.page.evaluate(() => {
      const foot = document.querySelector('[role="dialog"][aria-label="Preferences"] footer')!;
      const fr = foot.getBoundingClientRect();
      const btns = [...foot.querySelectorAll<HTMLElement>("button")].map((e) => {
        const r = e.getBoundingClientRect();
        return {
          text: e.innerText.trim(),
          name: e.getAttribute("aria-label") || e.innerText.trim(),
          y: Math.round(r.y),
          h: r.height,
          past: r.right > fr.right + 1,
          cramped: e.scrollWidth > e.clientWidth + 1,
        };
      });
      return btns;
    });
    expect(f.filter((b) => b.cramped).map((b) => b.text), "no label squeezed").toEqual([]);
    expect(f.filter((b) => b.past).map((b) => b.text), "none past the edge").toEqual([]);
    expect(new Set(f.map((b) => b.y)).size, "one row at 390px").toBe(1);
    expect(Math.min(...f.map((b) => b.h)), "44px targets").toBeGreaterThanOrEqual(44);
    expect(
      f.filter((b) => b.name.length < b.text.replace(/…/g, "").length).map((b) => b.text),
      "shortened on screen, not in meaning",
    ).toEqual([]);
  });
});

test.describe("on a desktop", () => {
  test.use(DESKTOP);

  test("Blur gallery keeps its big preview", async ({ app }) => {
    await openDialog(app, "Effects", "Blur gallery");
    expect(Math.max(...(await read(app)).canvases.map((c) => c.w))).toBeGreaterThanOrEqual(450);
  });

  test("Layer style keeps its rail as a column", async ({ app }) => {
    await openDialog(app, "Layer", "Layer style");
    const r = (await read(app)).rail!;
    expect(!r.row && r.h > 200, `${r.w}×${r.h}`).toBe(true);
  });

  test("Preferences keeps its labelled rail, and needs no heading", async ({ app }) => {
    await openDialog(app, "Settings", "Preferences");
    const p = await app.page.evaluate(() => {
      const d = document.querySelector('[role="dialog"][aria-label="Preferences"]')!;
      const rail = d.querySelector("[data-dialog-rail]")!;
      const head = d.querySelector("[data-pane-head]");
      const span = rail.querySelector("button > span");
      return {
        railW: Math.round(rail.getBoundingClientRect().width),
        labelled: !!span && getComputedStyle(span).display !== "none",
        headShown: !!head && getComputedStyle(head).display !== "none",
      };
    });
    expect(p.railW, "the labelled rail").toBeGreaterThanOrEqual(160);
    expect(p).toMatchObject({ labelled: true, headShown: false });
  });
});
