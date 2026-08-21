/* The browser's own gestures, kept off the editor's.
 *
 * Two things this guards. An Android pull-to-refresh, started from a scroller
 * sitting at its top, RELOADS the page — and takes an unsaved document with it;
 * `overscroll-behavior` switches that off and nothing in the app set it. And a
 * two-finger pinch over the chrome zooms the PAGE, which fights the canvas's
 * own zoom rather than adding to it.
 *
 * WHAT CANNOT BE TESTED HERE, established by measurement rather than assumed:
 *
 *  - Pull-to-refresh does not exist in a desktop Chromium, so the item's
 *    `navigation.type !== "reload"` check passes whatever the CSS says. What is
 *    asserted instead is the declaration that disables it, on the elements that
 *    carry it.
 *
 *  - A page pinch cannot be provoked either. `Input.synthesizePinchGesture`
 *    zooms the page to 2.5x no matter what — with `touch-action: none` on the
 *    root, on the body, on both — because it drives the compositor below
 *    hit-testing, so it cannot tell a page that would zoom from one that would
 *    not. A pinch built from real touch events is the opposite: blocked with
 *    the fix AND without it, because Chromium honours `user-scalable=no` in the
 *    viewport meta. iOS is the engine that ignores it, and there is no iOS
 *    here. So the pinch guard is tested as CODE — its handlers, on synthetic
 *    events — and the declaration is asserted, rather than pretending an
 *    end-to-end result.
 *
 * The last check is the one that would catch this change going too far:
 * `touch-action` is easy to over-restrict, and a drawer that no longer scrolls
 * would be a worse bug than the one being fixed.
 *
 * Run: node tools/verify-gestures.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const tour = await page
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(700);
  const cdp = await context.newCDPSession(page);

  // ---------- 1. the declarations that switch the gestures off ----------
  const styles = await page.evaluate(() => {
    const of = (sel) => {
      const el = sel === ":root" ? document.documentElement : document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { overscroll: cs.overscrollBehaviorY, touch: cs.touchAction };
    };
    return {
      root: of(":root"),
      body: of("body"),
      canvas: of('[data-tour="canvas"]'),
      /* The stage inside the canvas section is what carries touch-action:none —
         the section itself is just its container. */
      canvasStage: (() => {
        const area = document.querySelector('[data-tour="canvas"]');
        if (!area) return null;
        const el = [area, ...area.querySelectorAll("*")]
          .find((e) => getComputedStyle(e).touchAction === "none");
        return el ? (el.className || el.tagName).toString().slice(0, 28) : null;
      })(),
      dock: of('[data-tour="dock"]'),
      options: of('[data-tour="options"]'),
    };
  });
  check("the root refuses the browser's overscroll", styles.root.overscroll === "none",
    `html overscroll-behavior-y: ${styles.root.overscroll}`);
  check("scroll containers keep their overscroll to themselves",
    styles.dock.overscroll === "contain" && styles.options.overscroll === "contain",
    `dock ${styles.dock.overscroll}, options bar ${styles.options.overscroll}`);
  check("the page denies itself a pinch", styles.body.touch === "pan-x pan-y",
    `body touch-action: ${styles.body.touch}`);
  check("…while the canvas stage still owns every touch on it", !!styles.canvasStage,
    styles.canvasStage
      ? `touch-action: none on ${styles.canvasStage}`
      : "nothing inside the canvas section declines browser touches");

  // ---------- 2. the guard's own handlers ----------
  /* `gesturestart` is WebKit's, so Chromium never fires it — but the handler
     that cancels it is ordinary code with a real decision in it, and that is
     what is checked: cancelled over the chrome, left alone over the canvas. */
  const guard = await page.evaluate(() => {
    const fire = (sel, type, touchCount) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const x = Math.round(r.left + r.width / 2);
      const y = Math.round(r.top + Math.min(r.height / 2, 20));
      let ev;
      if (touchCount) {
        const touches = Array.from({ length: touchCount }, (_, i) =>
          new Touch({ identifier: i, target: el, clientX: x + i * 30, clientY: y }));
        ev = new TouchEvent(type, {
          touches, targetTouches: touches, changedTouches: touches,
          bubbles: true, cancelable: true,
        });
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
  check("a pinch over the chrome is cancelled", guard.gestureOnChrome === true,
    `gesturestart on the top bar → defaultPrevented ${guard.gestureOnChrome}`);
  check("…and a pinch over the canvas is left to the canvas", guard.gestureOnCanvas === false,
    `gesturestart on the canvas → defaultPrevented ${guard.gestureOnCanvas}`);
  check("two fingers on the chrome are cancelled", guard.twoOnChrome === true,
    `2-touch touchmove on the top bar → defaultPrevented ${guard.twoOnChrome}`);
  check("…and two fingers on the canvas are not", guard.twoOnCanvas === false,
    `2-touch touchmove on the canvas → defaultPrevented ${guard.twoOnCanvas}`);
  check("one finger is never cancelled, anywhere", guard.oneOnChrome === false,
    `1-touch touchmove on the top bar → defaultPrevented ${guard.oneOnChrome}`);

  // ---------- 3. the thing this change could plausibly break ----------
  /* `touch-action` is easy to over-restrict, and a drawer that no longer
     scrolled under a finger would be a worse bug than the one being fixed.

     This is asserted as a declaration rather than by dragging, because a touch
     scroll could not be synthesized here: a hand-dispatched touch sequence and
     `Input.synthesizeScrollGesture` with a touch source BOTH leave the drawer
     at scrollTop 0 — and they do so whether or not `touch-action: none` is
     forced onto it, so neither can tell a scrollable drawer from a frozen one.
     What is checked instead is that nothing in the chain denies a vertical pan,
     which is the property the fix could have broken. */
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
  await page.waitForTimeout(700);
  const panning = await page.evaluate(() => {
    const dock = document.querySelector('[data-tour="dock"]');
    if (!dock) return null;
    const allows = (v) => v === "auto" || v === "manipulation" || v.includes("pan-y");
    const chain = [];
    for (let el = dock; el; el = el.parentElement) {
      const v = getComputedStyle(el).touchAction;
      if (!allows(v)) chain.push(`${(el.getAttribute("data-tour") || el.tagName)}: ${v}`);
    }
    return { blocked: chain, scrollable: dock.scrollHeight > dock.clientHeight, own: getComputedStyle(dock).touchAction };
  });
  check("nothing denies the panel drawer a vertical pan",
    !!panning && panning.scrollable && panning.blocked.length === 0,
    panning
      ? `drawer touch-action ${panning.own}, ${panning.scrollable ? "scrollable" : "NOT scrollable"}` +
        (panning.blocked.length ? `, blocked by ${panning.blocked.join(" | ")}` : ", nothing blocking above it")
      : "no drawer");

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");
  console.log(
    "  NOTE  neither pull-to-refresh nor a page pinch can be provoked in this browser; " +
      "see the header for what was tried and why the checks are shaped this way.",
  );

  await context.close();
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
