/**
 * The five mobile invariants, on the full device profile, in the states the
 * other rails do not reach. (Ported from tools/verify-mobile-invariants.js,
 * TODO 2.1.)
 *
 * Most of this is asserted elsewhere (hit-targets, touch-targets, safe-area,
 * viewport, dialog-sheets) at dpr 1 without `isMobile`; this file states the
 * invariants once on an iPhone profile — dpr 3, isMobile, a phone's UA — and
 * adds what those cannot see: the shell's drawers open, every dialog's primary
 * button HIT-TESTED rather than `element.click()`ed (which reaches a button
 * that is wholly covered), and the tab order.
 *
 *  1. Nothing a finger can press is under 44px, in any state of the shell.
 *  2. No control sits under the notch or the home indicator.
 *  3. The shell is exactly the visual viewport.
 *  4. The page never scrolls, even when pushed.
 *  5. Every dialog's primary action can be touched where it sits.
 *
 * "On screen" is the control's CENTRE inside every box that clips it: a
 * control scrolled out of its scroller (the options card's body, a long
 * dialog) is reached by scrolling, not a layout fault. The script measured
 * against the screen's edges alone and reported Pen pressure "covered by the
 * tools sheet" — it was below the fold of the card's own scroller.
 */
import { test, expect, type App } from "./fixtures";

test.use({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
  userAgent:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
    "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
});

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const NOTCH = { top: 47, right: 0, bottom: 34, left: 0 }; // as safe-area.spec

/** Every live control in `scope`: under-44 ones, and ones a touch at the centre misses. */
const sweep = (app: App, scope = "body") =>
  app.page.evaluate((scope) => {
    const SEL =
      'button,[role="button"],select,a[href],[role="menuitem"],[role="tab"],[role="switch"],input:not([type="range"])';
    const small: string[] = [];
    const unhit: string[] = [];
    const name = (el: Element) => (el.getAttribute("aria-label") || el.textContent!.trim() || el.tagName).slice(0, 30);
    /** The part of the screen `el` can be seen in: the viewport, cut by every clipping ancestor. */
    const view = (el: Element) => {
      let box = { l: 0, t: 0, r: innerWidth, b: innerHeight };
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX === "visible" && s.overflowY === "visible") continue;
        const r = p.getBoundingClientRect();
        box = { l: Math.max(box.l, r.left), t: Math.max(box.t, r.top), r: Math.min(box.r, r.right), b: Math.min(box.b, r.bottom) };
      }
      return box;
    };
    for (const el of document.querySelector(scope)!.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
      /* Parked means inert: a shut drawer still has boxes, and `inert` is the
         app's own declaration that nothing in it is live. */
      if (el.closest("[inert]")) continue;
      const v = view(el);
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      if (cx < v.l || cx > v.r || cy < v.t || cy > v.b) continue;
      if (el.getAttribute("role") === "switch" || el.tagName === "SPAN") {
        /* Small on purpose (a switch's track, a value readout): the floor is a
           declared REACH, an invisible centred ::before. */
        const bf = getComputedStyle(el, "::before");
        if (!(parseFloat(bf.height) >= 44 && parseFloat(bf.width) >= 44))
          small.push(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}, no 44px ::before`);
      } else if (r.width < 44 || r.height < 44) small.push(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
      const hit = document.elementFromPoint(cx, cy);
      if (!(hit && (hit === el || el.contains(hit) || hit.contains(el)))) unhit.push(`${name(el)} → ${hit ? name(hit) : "nothing"}`);
    }
    return { small, unhit };
  }, scope);

const toggleDrawer = async (app: App, label: string) => {
  await app.page.locator('[data-tour="mobilebar"] button', { hasText: label }).first().tap();
  await app.settle(800);
};

test("1: nothing under 44px in any state of the shell, and every control takes a touch where it sits", async ({ app }) => {
  await app.run("layer-new");
  const rest = await sweep(app);
  expect(rest.small, "at rest: nothing under 44px").toEqual([]);
  expect(rest.unhit, "at rest: a touch at each control's centre reaches it").toEqual([]);
  for (const drawer of ["Tools", "Panels"]) {
    await toggleDrawer(app, drawer);
    /* With a drawer open its scrim covers the header — the shell working — so
       only the floor is swept here. */
    expect((await sweep(app)).small, `${drawer} open: nothing under 44px`).toEqual([]);
    await toggleDrawer(app, drawer);
  }
});

test("keyboard focus never lands on something a finger cannot reach", async ({ app }) => {
  /* A shut drawer is off-screen, not gone: before the parked surfaces were made
     inert, 46 of 59 tab stops were controls no finger could reach. A sweep of
     the screen cannot see this — deleting `inert` from the parked rail left
     every other check green — only the tab order can. */
  const stops: string[] = [];
  const stray: string[] = [];
  for (let i = 0; i < 80; i++) {
    await app.page.keyboard.press("Tab");
    const f = await app.page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const r = a.getBoundingClientRect();
      const cy = r.y + r.height / 2;
      const hit = cy >= 0 && cy <= innerHeight ? document.elementFromPoint(Math.min(innerWidth - 1, Math.max(1, r.x + r.width / 2)), cy) : null;
      return {
        key: `${(a.getAttribute("aria-label") || a.textContent!.trim() || a.tagName).slice(0, 26)}@${Math.round(r.y)}`,
        reachable: !!hit && (hit === a || a.contains(hit) || hit.contains(a)),
      };
    });
    if (!f) continue;
    if (stops.includes(f.key)) break; // wrapped round
    stops.push(f.key);
    if (!f.reachable) stray.push(f.key);
  }
  expect(stops.length, "the walk found tab stops").toBeGreaterThan(4);
  expect(stray, "every tab stop is on screen and hit-testable").toEqual([]);
});

test("3 & 4: the shell is exactly the visual viewport, and the page never scrolls, even pushed", async ({ app }) => {
  const geometry = () =>
    app.page.evaluate(() => {
      const de = document.documentElement;
      const shell = document.querySelector("[data-app]")!.getBoundingClientRect();
      return {
        shell: { w: Math.round(shell.width), h: Math.round(shell.height) },
        vv: { w: Math.round(visualViewport!.width), h: Math.round(visualViewport!.height) },
        scroll: { x: Math.round(de.scrollLeft || scrollX), y: Math.round(de.scrollTop || scrollY) },
        fits: de.scrollWidth <= innerWidth && de.scrollHeight <= innerHeight,
      };
    });
  const rest = await geometry();
  expect(rest.shell, "the shell is the visual viewport").toEqual(rest.vv);
  for (const drawer of [null, "Tools", "Panels"]) {
    if (drawer) await toggleDrawer(app, drawer);
    const g = await geometry();
    expect({ scroll: g.scroll, fits: g.fits }, `${drawer ?? "at rest"}: nothing scrolls`).toEqual({ scroll: { x: 0, y: 0 }, fits: true });
    if (drawer) await toggleDrawer(app, drawer);
  }
  await app.page.evaluate(() => window.scrollTo(0, 500));
  await app.settle(300);
  expect((await geometry()).scroll, "scrollTo(0, 500) moves nothing").toEqual({ x: 0, y: 0 });
});

test("2: no control sits under the notch or the home indicator", async ({ app }) => {
  /* With a real notch handed to Chromium: with no insets the bands are zero
     pixels tall and the claim is trivially true. */
  await app.setSafeArea(NOTCH);
  await app.settle(400);
  const intruders = await app.page.evaluate((notch) => {
    const out: string[] = [];
    for (const el of document.querySelectorAll('button,[role="button"],select,a[href],[role="tab"],[role="switch"]')) {
      /* The part of it that can be seen: cut by every clipping ancestor, so a
         control scrolled out of the options card's body is not "under the
         home indicator" — it is not on screen at all. */
      const r = el.getBoundingClientRect();
      let box = { top: r.top, bottom: r.bottom };
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowX === "visible" && s.overflowY === "visible") continue;
        const c = p.getBoundingClientRect();
        box = { top: Math.max(box.top, c.top), bottom: Math.min(box.bottom, c.bottom) };
      }
      if (r.width < 1 || box.bottom - box.top < 1 || box.bottom < 0 || box.top > innerHeight) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || +cs.opacity === 0 || el.closest("[inert]")) continue;
      const label = (el.getAttribute("aria-label") || el.textContent!.trim() || el.tagName).slice(0, 26);
      if (box.top < notch.top) out.push(`${label} top ${Math.round(box.top)}`);
      if (box.bottom > innerHeight - notch.bottom) out.push(`${label} bottom ${Math.round(box.bottom)}`);
    }
    return out;
  }, NOTCH);
  expect(intruders, `nothing in the top ${NOTCH.top}px or the bottom ${NOTCH.bottom}px`).toEqual([]);
});

test("5: every dialog's primary button can be touched where it sits, and nothing in a dialog is under 44px", async ({ app }) => {
  test.slow(); // every dialog the menus open
  const { page } = app;
  const openSheet = async () => {
    if (await page.locator('[data-menubar][data-sheet="true"]').count()) return;
    await page.locator('header button[aria-label="Menu"]').first().click();
    await expect(page.locator('[data-menubar][data-sheet="true"]')).toHaveCount(1);
    await app.settle(250);
  };
  const toggleMenu = (m: string) =>
    page.evaluate(
      (l) => [...document.querySelectorAll<HTMLButtonElement>("[data-menubar] > div > button")].find((x) => x.textContent!.trim() === l)?.click(),
      m,
    );
  await openSheet();
  const menus = await page.evaluate(() =>
    [...document.querySelectorAll("[data-menubar] > div > button")]
      .filter((x) => !x.hasAttribute("data-sheet-search"))
      .map((x) => x.textContent!.trim()),
  );
  const rows: [string, string][] = [];
  for (const m of menus) {
    await openSheet();
    await toggleMenu(m);
    await app.settle(300);
    const items = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLButtonElement>('[data-menubar] [role="menu"] button')]
        .map((x) => (x.disabled ? "" : (x.querySelector("span")?.textContent ?? x.textContent ?? "").trim()))
        .filter((l) => /…\s*$/.test(l)),
    );
    for (const it of items) rows.push([m, it.replace(/…\s*$/, "")]);
    await toggleMenu(m);
  }

  let walked = 0;
  let footered = 0;
  const unreachable: string[] = [];
  const small: string[] = [];
  for (const [m, it] of rows) {
    await openSheet();
    await toggleMenu(m);
    await app.settle(300);
    const row = page.locator('[data-menubar] [role="menu"] button', { hasText: it }).first();
    if (!(await row.count())) continue;
    await row.click();
    await app.settle(800);
    /* The primary action is the LAST BUTTON IN A FOOTER; no footer, no primary.
       "The last button anywhere" once flagged a gradient switch below the fold
       of a dialog that scrolls — nothing was wrong with it. */
    const p = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]');
      if (!d) return null;
      const foot = d.querySelector("footer");
      const b = foot ? [...foot.querySelectorAll("button")].filter((x) => x.getBoundingClientRect().width > 0).at(-1) : undefined;
      if (!b) return { primary: false as const };
      const r = b.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      const inView = cy >= 0 && cy <= innerHeight && cx >= 0 && cx <= innerWidth;
      const hit = inView ? document.elementFromPoint(cx, cy) : null;
      return {
        primary: true as const,
        ok: !!hit && (hit === b || b.contains(hit)),
        name: (b.getAttribute("aria-label") || b.textContent!.trim()).slice(0, 24),
        why: inView ? `covered by ${hit?.getAttribute("aria-label") ?? hit?.tagName}` : `centre at y=${Math.round(cy)}`,
      };
    });
    if (p) {
      walked++;
      if (p.primary) {
        footered++;
        if (!p.ok) unreachable.push(`${m} > ${it}: ${p.name} — ${p.why}`);
      }
      for (const x of (await sweep(app, '[role="dialog"]')).small) small.push(`${m} > ${it}: ${x}`);
    }
    for (let i = 0; i < 4 && (await page.locator('[role="dialog"]').count()); i++) {
      await page.keyboard.press("Escape");
      await page.evaluate(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')?.click());
      await app.settle(320);
    }
  }
  expect(walked, "the walk opened the dialogs it claims to have checked").toBeGreaterThanOrEqual(40);
  expect(footered, "...enough of them with a footer to have a primary action").toBeGreaterThanOrEqual(20);
  expect(unreachable, "every primary button takes a touch where it sits").toEqual([]);
  expect([...new Set(small)], "nothing inside a dialog is under 44px").toEqual([]);
});
