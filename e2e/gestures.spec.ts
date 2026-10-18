/**
 * The browser's own gestures, kept off the editor's. (Ported from tools/verify-gestures.js, TODO 2.1.)
 *
 * Two things this guards. An Android pull-to-refresh, started from a scroller
 * at its top, RELOADS the page — and takes an unsaved document with it;
 * `overscroll-behavior` switches that off. And a two-finger pinch over the
 * chrome zooms the PAGE, which fights the canvas's own zoom.
 *
 * WHAT CANNOT BE TESTED HERE, established by measurement rather than assumed:
 *  - Pull-to-refresh does not exist in desktop Chromium, so a
 *    `navigation.type !== "reload"` check passes whatever the CSS says. The
 *    declaration that disables it is asserted instead.
 *  - A page pinch cannot be provoked either. `Input.synthesizePinchGesture`
 *    zooms the page whatever `touch-action` says (it drives the compositor,
 *    below hit-testing); a pinch built from real touch events is blocked with
 *    the fix AND without it, because Chromium honours `user-scalable=no`. iOS
 *    ignores that, and there is no iOS here. So the guard is tested as CODE —
 *    its handlers, on synthetic events — and the declaration is asserted.
 *
 * The last test is the one that would catch this going too far: `touch-action`
 * is easy to over-restrict, and a drawer that no longer scrolls would be a
 * worse bug than the one being fixed.
 */
import { test, expect } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

test("the declarations that switch the browser's gestures off are in place", async ({ app }) => {
  const s = await app.page.evaluate(() => {
    const of = (el: Element | null) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { overscroll: cs.overscrollBehaviorY, touch: cs.touchAction };
    };
    const area = document.querySelector('[data-tour="canvas"]');
    /* The stage inside the canvas section carries touch-action:none; the
       section itself is only its container. */
    const stage = area ? [area, ...area.querySelectorAll("*")].find((e) => getComputedStyle(e).touchAction === "none") : null;
    return {
      root: of(document.documentElement),
      body: of(document.body),
      dock: of(document.querySelector('[data-tour="dock"]')),
      options: of(document.querySelector('[data-tour="options"]')),
      stage: stage ? String(stage.className || stage.tagName).slice(0, 28) : null,
    };
  });
  expect(s.root?.overscroll, "the root refuses the browser's overscroll").toBe("none");
  expect({ dock: s.dock?.overscroll, options: s.options?.overscroll }, "scrollers keep overscroll to themselves").toEqual({
    dock: "contain",
    options: "contain",
  });
  expect(s.body?.touch, "the page denies itself a pinch").toBe("pan-x pan-y");
  expect(s.stage, "...while the canvas stage still owns every touch on it").not.toBeNull();
});

test("the pinch guard cancels over the chrome and leaves the canvas alone", async ({ app }) => {
  /* `gesturestart` is WebKit's, so Chromium never fires it — but the handler
     that cancels it is ordinary code with a real decision in it. */
  const g = await app.page.evaluate(() => {
    const fire = (sel: string, type: string, touchCount: number) => {
      const el = document.querySelector(sel)!;
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + Math.min(r.height / 2, 20));
      let ev: Event;
      if (touchCount) {
        const touches = Array.from(
          { length: touchCount },
          (_, i) => new Touch({ identifier: i, target: el, clientX: x + i * 30, clientY: y }),
        );
        ev = new TouchEvent(type, { touches, targetTouches: touches, changedTouches: touches, bubbles: true, cancelable: true });
      } else {
        ev = new Event(type, { bubbles: true, cancelable: true });
      }
      el.dispatchEvent(ev);
      return ev.defaultPrevented;
    };
    return {
      gestureOnChrome: fire('[data-tour="topbar"]', "gesturestart", 0),
      gestureOnCanvas: fire('[data-tour="canvas"]', "gesturestart", 0),
      twoOnChrome: fire('[data-tour="topbar"]', "touchmove", 2),
      twoOnCanvas: fire('[data-tour="canvas"]', "touchmove", 2),
      oneOnChrome: fire('[data-tour="topbar"]', "touchmove", 1),
    };
  });
  expect(g).toEqual({
    gestureOnChrome: true, // a pinch over the chrome is cancelled
    gestureOnCanvas: false, // ...and one over the canvas is left to the canvas
    twoOnChrome: true, // two fingers on the chrome are cancelled
    twoOnCanvas: false, // ...and on the canvas are not
    oneOnChrome: false, // one finger is never cancelled, anywhere
  });
});

test("nothing denies the panel drawer a vertical pan", async ({ app }) => {
  /* Asserted as a declaration rather than by dragging: a hand-dispatched touch
     sequence and `Input.synthesizeScrollGesture` with a touch source BOTH leave
     the drawer at scrollTop 0 — with or without `touch-action: none` forced on
     it — so neither can tell a scrollable drawer from a frozen one. */
  const { page } = app;
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
  await app.settle(700);
  const p = await page.evaluate(() => {
    const dock = document.querySelector('[data-tour="dock"]')!;
    const allows = (v: string) => v === "auto" || v === "manipulation" || v.includes("pan-y");
    const blocked: string[] = [];
    for (let el: Element | null = dock; el; el = el.parentElement) {
      const v = getComputedStyle(el).touchAction;
      if (!allows(v)) blocked.push(`${el.getAttribute("data-tour") || el.tagName}: ${v}`);
    }
    return { blocked, scrollable: dock.scrollHeight > dock.clientHeight };
  });
  expect(p.scrollable, "the drawer has something to scroll").toBe(true);
  expect(p.blocked, "no ancestor declines a vertical pan").toEqual([]);
});
