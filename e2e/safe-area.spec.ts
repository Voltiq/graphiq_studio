/**
 * Safe-area tokens: do the display's unusable edges actually reach the layout?
 * (Ported from tools/verify-safe-area.js, TODO 2.1. Its source scan — no
 * hand-rolled env(), no re-added chrome heights, no innerWidth clamps — is the
 * unit test tests/safe-area-source.test.ts.)
 *
 * The app once wrote `env(safe-area-inset-bottom)` at five call sites and never
 * mentioned top, left or right. Those are now one set of tokens, `--safe-t/r/b/l`,
 * plus two derived offsets, `--chrome-top` and `--chrome-bottom`, that
 * everything between the bars anchors to.
 *
 * "The token exists" proves nothing — a token nothing consumes satisfies it.
 * Chromium takes real notch insets over CDP (`Emulation.setSafeAreaInsetsOverride`),
 * which makes `env()` resolve for real, so every geometric claim is measured
 * with no insets and with them, and asserted as the DIFFERENCE. A hard-coded
 * 56px bar passes the first reading and fails the second.
 *
 * `hasTouch` is not decoration: the mobile shell is chosen by a query asking
 * for a coarse pointer with no hover, so without it a small viewport still
 * gets the desktop shell.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

/* An iPhone-ish profile: a notch at the top, the home indicator at the foot. */
const NOTCH = { top: 47, right: 0, bottom: 34, left: 0 };
const NONE = { top: 0, right: 0, bottom: 0, left: 0 };
const MOBILE = { width: 390, height: 844 };
const LAND = { width: 844, height: 390 };

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

interface Box {
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
}
/** The tokens as the browser computed them, plus the geometry they drive. */
const readout = (page: Page) =>
  page.evaluate(() => {
    const cs = getComputedStyle(document.documentElement);
    const px = (n: string) => {
      const s = cs.getPropertyValue(n).trim();
      return s.endsWith("px") ? parseFloat(s) : NaN;
    };
    /* A custom property holding a calc() of other properties computes to the
       SUBSTITUTED TOKEN STREAM, not to a length. Measuring an element sized by
       it is what the layout itself does, and gives the used value. */
    const resolve = (expr: string) => {
      const probe = document.createElement("div");
      probe.style.cssText = `position:fixed;left:-9999px;top:0;visibility:hidden;height:${expr}`;
      document.body.appendChild(probe);
      const h = probe.getBoundingClientRect().height;
      probe.remove();
      return Math.round(h);
    };
    const box = (sel: string): Box | null => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return {
        top: Math.round(r.top),
        bottom: Math.round(r.bottom),
        left: Math.round(r.left),
        right: Math.round(r.right),
        height: Math.round(r.height),
      };
    };
    const bar = document.querySelector('[data-tour="mobilebar"]');
    return {
      mobile: document.documentElement.dataset.mobile ?? "(absent)",
      safe: { t: px("--safe-t"), r: px("--safe-r"), b: px("--safe-b"), l: px("--safe-l") },
      chromeTop: resolve("var(--chrome-top)"),
      chromeBottom: resolve("var(--chrome-bottom)"),
      toolbar: box('[data-tour="toolbar"]'),
      dock: box('[data-tour="dock"]'),
      bar: box('[data-tour="mobilebar"]'),
      topbar: box('[data-tour="topbar"]'),
      hamburger: box('button[aria-label="Menu"]'),
      barPadBottom: bar ? Math.round(parseFloat(getComputedStyle(bar).paddingBottom)) : null,
      /* The lowest edge of anything the user has to be able to press. */
      barContentBottom: bar
        ? Math.round(Math.max(...[...bar.querySelectorAll("button")].map((b) => b.getBoundingClientRect().bottom)))
        : null,
    };
  });

test.describe("desktop", () => {
  test.use({ viewport: { width: 1500, height: 950 } });

  test("every token is 0, the offsets are the chrome's own heights, the shell is untouched", async ({ app }) => {
    const d = await readout(app.page);
    expect(d.safe).toEqual({ t: 0, r: 0, b: 0, l: 0 });
    expect({ top: d.chromeTop, bottom: d.chromeBottom }, "48+48 and 28").toEqual({ top: 96, bottom: 28 });
    expect(d.mobile, "no mobile shell").toBe("(absent)");
  });
});

test.describe("phone, portrait", () => {
  test.use({ viewport: MOBILE, hasTouch: true });

  test("with no insets: the bottom chrome is exactly the bar, and the drawers sit between the bars", async ({
    app,
  }) => {
    const flat = await readout(app.page);
    expect(flat.mobile, "the phone profile gets the mobile shell").toBe("true");
    expect(flat.chromeBottom).toBe(56);
    expect({ h: flat.bar?.height, bottom: flat.bar?.bottom }, "the bar's box matches").toEqual({
      h: 56,
      bottom: MOBILE.height,
    });
    /* The tools drawer slides in from the side and spans the chrome band. The
       panels dock is a bottom sheet: closed, it is translated down below the
       fold, resting on the bar rather than under it. */
    expect({ top: flat.toolbar?.top, bottom: flat.toolbar?.bottom }, "the tools drawer").toEqual({
      top: 96,
      bottom: MOBILE.height - 56,
    });
    expect(flat.dock?.top, "the panels sheet rests on the bar").toBe(MOBILE.height - 56);
  });

  test("a notch and a home indicator move everything by exactly their size", async ({ app }) => {
    const flat = await readout(app.page);
    await app.setSafeArea(NOTCH);
    const n = await readout(app.page);
    expect({ t: n.safe.t, b: n.safe.b }, "both reach their tokens").toEqual({ t: NOTCH.top, b: NOTCH.bottom });
    expect(n.chromeBottom - flat.chromeBottom, "the bottom chrome grows by the indicator, not a guess").toBe(
      NOTCH.bottom,
    );
    expect(n.bar!.height - flat.bar!.height, "...and so does the bar").toBe(NOTCH.bottom);
    expect(n.bar!.bottom, "still flush with the display").toBe(MOBILE.height);
    /* The bar's BACKGROUND still reaches the bottom of the display, but nothing
       pressable is under the home indicator. */
    expect(n.barPadBottom).toBe(NOTCH.bottom);
    expect(n.barContentBottom!, "the bar's buttons clear the indicator").toBeLessThanOrEqual(
      MOBILE.height - NOTCH.bottom,
    );
    expect(flat.toolbar!.bottom - n.toolbar!.bottom, "the tools drawer stops above it").toBe(NOTCH.bottom);
    expect(flat.dock!.bottom - n.dock!.bottom, "...and the panels sheet, by the same amount").toBe(NOTCH.bottom);
    expect(n.topbar!.height - flat.topbar!.height, "the top bar grows by the notch").toBe(NOTCH.top);
    expect(n.topbar!.top, "still flush at the top").toBe(0);
    expect(n.hamburger!.top, "the hamburger sits below the notch").toBeGreaterThanOrEqual(NOTCH.top);
    expect(n.chromeTop - flat.chromeTop, "the top offset follows the bar").toBe(NOTCH.top);
    /* They have to move together, or a strip of bare canvas opens under the chrome. */
    expect(n.toolbar!.top, "no gap between the chrome and the tools drawer (+48px options bar)").toBe(
      n.topbar!.bottom + 48,
    );
  });

  test("the menu sheet sits between the bars, and its last row can be pressed", async ({ app }) => {
    /* The sheet is the collapsed menubar behind the hamburger. It once ran to
       `bottom: 0`, so its scroller continued under the MobileBar and the last
       rows of a long menu could not be reached at all. */
    const { page } = app;
    await app.setSafeArea(NOTCH);
    const n = await readout(page);
    const sheetSel = '[data-menubar][data-sheet="true"]';
    await page.click('button[aria-label="Menu"]');
    await page.waitForSelector(sheetSel, { timeout: 5_000 });
    await app.settle(300);
    /* The LONGEST menu, since that is the one that overflows — found, not
       hard-coded. `[data-sheet-search]` is the palette trigger leading the
       sheet, not a menu: clicking it closes the sheet. */
    const roots = page.locator(`${sheetSel} > div > button:not([data-sheet-search])`);
    let longest = { index: 0, items: 0, name: "?" };
    for (let i = 0; i < (await roots.count()); i++) {
      await roots.nth(i).click();
      await app.settle(160);
      const items = await page.locator(`${sheetSel} [role="menu"] button`).count();
      if (items > longest.items) longest = { index: i, items, name: (await roots.nth(i).textContent())?.trim() ?? "?" };
      await roots.nth(i).click(); // shut again, so the next count is its own
      await app.settle(120);
    }
    await roots.nth(longest.index).click();
    await app.settle(300);
    // Both scrollers: an expanded menu is capped and scrolls within the sheet.
    await page.evaluate((sel) => {
      const s = document.querySelector(sel)!;
      const inner = s.querySelector('[role="menu"]');
      if (inner) inner.scrollTop = inner.scrollHeight;
      s.scrollTop = s.scrollHeight;
    }, sheetSel);
    await app.settle(250);
    const probe = await page.evaluate((sel) => {
      const sheet = document.querySelector(sel)!;
      /* The lowest row ON SCREEN once scrolled to the end — "lowest" outright
         picks a row parked inside the capped menu's own scroller, below the
         fold, where elementFromPoint returns null. */
      const rows = [...sheet.querySelectorAll("button")].filter((b) => {
        const r = b.getBoundingClientRect();
        return r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
      });
      const el = rows.reduce((lo, b) => (b.getBoundingClientRect().bottom > lo.getBoundingClientRect().bottom ? b : lo));
      const r = el.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      const sr = sheet.getBoundingClientRect();
      return {
        label: (el.textContent ?? "").trim().slice(0, 28),
        reachable: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
        blockedBy: !hit
          ? "nothing"
          : hit.closest('[data-tour="mobilebar"]')
            ? "the MobileBar"
            : hit.closest('[data-tour="topbar"]')
              ? "the top bar"
              : hit.tagName.toLowerCase(),
        top: Math.round(sr.top),
        bottom: Math.round(sr.bottom),
        atEnd: Math.abs(sheet.scrollTop - (sheet.scrollHeight - sheet.clientHeight)) <= 2,
        gapToFoot: Math.round(sr.bottom - r.bottom),
      };
    }, sheetSel);
    expect(probe.top, "the sheet starts below the whole top bar, notch included").toBe(n.topbar!.bottom);
    expect(probe.bottom, "...and ends above the MobileBar").toBe(MOBILE.height - n.chromeBottom);
    // Non-vacuity: scrolled to its end, with the row down at the sheet's foot.
    expect(probe.atEnd && probe.gapToFoot <= 24, `scrolled to the last row (gap ${probe.gapToFoot}px)`).toBe(true);
    expect(
      probe.reachable,
      `"${longest.name}" (${longest.items} items): bottom row "${probe.label}" blocked by ${probe.blockedBy}`,
    ).toBe(true);
  });

  test("side insets reach their tokens when rotated, and clearing puts everything back", async ({ app }) => {
    const ROTATED = { top: 0, right: 34, bottom: 21, left: 47 };
    await app.setSafeArea(ROTATED);
    const r = await readout(app.page);
    expect({ l: r.safe.l, r: r.safe.r, b: r.safe.b }).toEqual({ l: ROTATED.left, r: ROTATED.right, b: ROTATED.bottom });
    expect(r.chromeBottom, "the bottom follows the rotation").toBe(56 + ROTATED.bottom);
    await app.setSafeArea(NONE);
    const c = await readout(app.page);
    expect({ chrome: c.chromeBottom, bar: c.bar?.height }).toEqual({ chrome: 56, bar: 56 });
  });
});

const rectOf = (page: Page, sel: string) =>
  page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: Math.round(b.left), right: Math.round(b.right) };
  }, sel);

/** The rightmost edge of any control in the panels drawer. */
const dockRight = (page: Page) =>
  page.evaluate(() => {
    const vis = [...document.querySelectorAll('[data-tour="dock"] button')]
      .map((b) => b.getBoundingClientRect())
      .filter((b) => b.width > 0);
    return Math.round(Math.max(...vis.map((b) => b.right)));
  });

test.describe("phone, landscape", () => {
  /* A real iPhone in landscape. What is asserted is that nothing pressable
     intrudes into the inset AT ALL — a "+16px" margin was proposed, but that is
     larger than the app's own gutters and would fail correct layout. */
  test.use({ viewport: LAND, hasTouch: true });

  for (const [label, insets] of [
    ["a cutout on the left", { top: 0, right: 34, bottom: 21, left: 47 }],
    ["a cutout on the right", { top: 0, right: 47, bottom: 21, left: 34 }],
  ] as const) {
    test(`${label}: no control intrudes into it, and the panel drawer reserves it`, async ({ app }) => {
      const { page } = app;
      await app.setSafeArea(insets);
      const W = LAND.width;
      const fits = (r: { left: number; right: number } | null) => !!r && r.left >= insets.left && r.right <= W - insets.right;
      const bounds = `safe box ${insets.left}…${W - insets.right}`;
      const chrome = await page.evaluate(() => {
        const r = (el: Element | null | undefined) => {
          if (!el) return null;
          const b = el.getBoundingClientRect();
          return { left: Math.round(b.left), right: Math.round(b.right) };
        };
        const btns = [...document.querySelectorAll('[data-tour="mobilebar"] button')];
        return {
          hamburger: r(document.querySelector('button[aria-label="Menu"]')),
          barFirst: r(btns[0]),
          barLast: r(btns.at(-1)),
          edgeL: r(document.querySelector('.gq-m-edge[data-side="left"]')),
          edgeR: r(document.querySelector('.gq-m-edge[data-side="right"]')),
        };
      });
      expect.soft(fits(chrome.hamburger), `the top bar's first control ${JSON.stringify(chrome.hamburger)}, ${bounds}`).toBe(true);
      expect.soft(fits(chrome.barFirst) && fits(chrome.barLast), `the bottom bar's buttons, ${bounds}`).toBe(true);
      /* The swipe strips are invisible hit targets, so they move rather than
         pad: a 20px strip under a 47px cutout could not be touched at all. */
      expect.soft(fits(chrome.edgeL) && fits(chrome.edgeR), `the swipe strips, ${bounds}`).toBe(true);

      const bar = page.locator('[data-tour="mobilebar"] button');
      await bar.filter({ hasText: "Tools" }).first().click();
      await app.settle(500);
      expect.soft(fits(await rectOf(page, '[data-tour="toolbar"] button')), `the tool drawer's first button, ${bounds}`).toBe(true);
      /* Close before opening the other: the bar sits above the scrim, but
         Playwright's actionability check refuses to click through an overlay
         covering the point, so switching drawers directly stalls. */
      await bar.filter({ hasText: "Tools" }).first().click();
      await app.settle(500);
      await bar.filter({ hasText: "Panels" }).first().click();
      await app.settle(600);
      const dock = await page.evaluate(() => {
        const el = document.querySelector('[data-tour="dock"]')!;
        return {
          right: Math.round(el.getBoundingClientRect().right),
          pad: Math.round(parseFloat(getComputedStyle(el).paddingRight)),
        };
      });
      expect.soft(dock, "the panel drawer runs to the display edge and pads by the inset").toEqual({
        right: W,
        pad: insets.right,
      });
      /* A DIFFERENCE, not against the safe box: panel content is already wider
         than the dock here, so with no inset the widest control ends past the
         display edge. What changed is that the column moves inboard by the inset. */
      const withInset = await dockRight(page);
      await app.setSafeArea(NONE);
      const without = await dockRight(page);
      expect(without - withInset, "its contents move inboard by exactly the inset").toBe(insets.right);
    });
  }

  test("a popup that would overflow the cutout is pulled back inside it", async ({ app }) => {
    /* Deliberately fatter than any real phone: with real insets every popup
       happens to fit anyway, so opening one passed whether or not the clamp
       did anything — reverting a popup to window.innerWidth left it green. */
    const FAT = 200;
    const { page } = app;
    await page.locator('[data-tour="mobilebar"] button').filter({ hasText: "Panels" }).first().click();
    await app.settle(700);
    await app.setSafeArea({ top: 0, right: FAT, bottom: 0, left: 0 });
    /* The panels sheet is an accordion and starts shut, so a collapsed panel's
       controls are ABSENT. Layers carries a listbox trigger flush right. */
    await app.setSheetDetent("full");
    expect(await app.openPanelById("layers"), "the Layers panel opens").toBe(true);
    const anchor = await page.evaluate(async () => {
      const all = [...document.querySelectorAll('[data-tour="dock"] button[aria-haspopup="listbox"]')].filter(
        (b) => b.getBoundingClientRect().width > 0,
      );
      if (!all.length) return null;
      const el = all.reduce((a, b) => (b.getBoundingClientRect().left > a.getBoundingClientRect().left ? b : a));
      el.scrollIntoView({ block: "center" });
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)));
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) return null;
      return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
    });
    expect(anchor, "a listbox trigger is on screen inside the drawer").not.toBeNull();
    // By coordinate: the drawer's scrim makes the actionability check refuse a
    // click the browser would land.
    await page.mouse.click(anchor!.x + anchor!.w / 2, anchor!.y);
    await app.settle(450);
    const pop = await rectOf(page, '[role="listbox"]');
    expect(pop, "the popup opened").not.toBeNull();
    expect(pop!.right, `it ends inside the safe edge ${LAND.width - FAT}`).toBeLessThanOrEqual(LAND.width - FAT);
    expect(pop!.left, "...because it was pulled back from its anchor").toBeLessThan(anchor!.x);
  });
});

