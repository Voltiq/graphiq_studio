/* Nothing in the panels drawer is out of reach.
 *
 * This began as a reported bug: "panel content overflows the 320px dock
 * horizontally — on a 740×390 viewport the widest control ends 133px past the
 * display edge, and the drawer scrolls vertically, so the overhang is simply
 * clipped rather than reachable."
 *
 * The overhang is real. The conclusion was not. Everything past the edge is
 * inside the Adjustments panel's filter filmstrip, which scrolls sideways by
 * design — 145px of it — and a finger swipe brings the last chip from 133px
 * past the dock to 12px inside it. Nothing is lost.
 *
 * So the check the item proposed — every control's `rect.right` inside the
 * dock — would FAIL on correct code, because a scrollable strip is a
 * legitimate way to hold more than fits. What is asserted instead is the
 * property that actually matters: every control is either inside the dock or
 * inside something that can bring it in, and the strip that holds the rest
 * really does respond to a finger.
 *
 * Both orientations, because the report came from landscape and the dock is a
 * different shape there.
 *
 * Run: node tools/verify-dock-reach.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

/* Every interactive control past the dock's right edge, split by whether
   anything can scroll it into view. Deliberately NOT filtered to "deepest
   offenders" — that filter hid the chip buttons behind their own spans and
   reported an empty list for both, which looked like a clean bill of health. */
const SCAN = () => {
  const dock = document.querySelector('[data-tour="dock"]');
  if (!dock) return null;
  const right = dock.getBoundingClientRect().right;
  const scroller = (el) => {
    for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) {
      const ox = getComputedStyle(p).overflowX;
      if ((ox === "auto" || ox === "scroll") && p.scrollWidth > p.clientWidth + 1) return p;
    }
    return null;
  };
  const lost = [];
  const scrollable = [];
  let seen = 0;
  for (const el of dock.querySelectorAll("button, input, select, [role='switch'], [role='option']")) {
    const r = el.getBoundingClientRect();
    if (r.width < 1) continue;
    seen++;
    if (r.right <= right + 1) continue;
    const cls = (el.className || "").toString().replace(/^\S*module__\w+__/, "").split(" ")[0];
    const label = (el.getAttribute("aria-label") || el.textContent || "?").trim().slice(0, 16);
    const line = `${cls || el.tagName.toLowerCase()} "${label}" ${Math.round(r.right - right)}px past`;
    (scroller(el) ? scrollable : lost).push(line);
  }
  return { lost, scrollable, seen, dockWidth: Math.round(dock.getBoundingClientRect().width) };
};

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const openDock = async (viewport, label) => {
    const context = await browser.newContext({ viewport, hasTouch: true });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror(${label}): ` + String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(`console(${label}): ` + m.text()));
    await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
    const tour = await page
      .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
      .catch(() => null);
    if (tour) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(700);
    }
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
    await page.waitForTimeout(1000);
    await dismissStartCard(page);
    await page.keyboard.press("Control+Shift+N"); // a layer, so the panels have content
    await page.waitForTimeout(1200);
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
    await page.waitForTimeout(900);
    /* Every panel expanded: a collapsed one renders nothing, so a scan of the
       default state would be measuring two panels and calling it fourteen. */
    await page.evaluate(() => {
      for (const c of document.querySelectorAll('[data-tour="dock"] button[class*="panelCaret"]'))
        if ((c.getAttribute("aria-label") || "").startsWith("Expand")) c.click();
    });
    await page.waitForTimeout(1600);
    return { context, page };
  };

  for (const [label, viewport] of [
    ["portrait", { width: 390, height: 844 }],
    ["landscape", { width: 740, height: 390 }],
  ]) {
    const { context, page } = await openDock(viewport, label);
    const r = await page.evaluate(SCAN);
    check(`${label}: the dock is open with its panels expanded`,
      !!r && r.seen >= 40, r ? `${r.seen} controls rendered in a ${r.dockWidth}px dock` : "no dock");
    check(`${label}: nothing is stranded past the edge with no way back`,
      r && r.lost.length === 0,
      r && r.lost.length ? r.lost.slice(0, 4).join(", ") : "none stranded");

    /* The positive half: what DOES hang over is inside a strip, and a finger
       brings it in. Without this the check above would also pass on a panel
       that had quietly stopped rendering its widest row. */
    const strip = await page.evaluate(() => {
      const dock = document.querySelector('[data-tour="dock"]');
      const el = [...dock.querySelectorAll("*")].find((e) => {
        const ox = getComputedStyle(e).overflowX;
        return (ox === "auto" || ox === "scroll") && e.scrollWidth > e.clientWidth + 1;
      });
      if (!el) return null;
      el.setAttribute("data-strip", "1");
      /* The dock is a ~3000px scroller: the strip sat at y=2491 on an 844px
         screen, where a dispatched touch lands on nothing and the strip looks
         as though it does not scroll. */
      el.scrollIntoView({ block: "center" });
      const b = el.getBoundingClientRect();
      const last = el.children[el.children.length - 1];
      return {
        x: Math.round(b.left + b.width * 0.75),
        y: Math.round(b.top + b.height / 2),
        range: el.scrollWidth - el.clientWidth,
        lastPast: Math.round(
          last.getBoundingClientRect().right - dock.getBoundingClientRect().right,
        ),
      };
    });
    /* Either nothing hangs over at this width, or what does is in a strip a
       finger can scroll. Since the dock became a full-width bottom sheet the
       landscape case is the first kind — 740px of room, and the filmstrip fits
       — while portrait is still the second, which is what keeps the swipe
       below from being skipped everywhere. */
    check(`${label}: any overhang is in a strip that scrolls, not content that is gone`,
      !!strip || (r && r.scrollable.length === 0),
      strip
        ? `${strip.range}px of travel, last chip ${strip.lastPast}px past the edge`
        : "nothing overflows at this width");

    if (strip) {
      const cdp = await context.newCDPSession(page);
      const touch = (type, points) =>
        cdp.send("Input.dispatchTouchEvent", {
          type,
          touchPoints: points.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })),
        });
      await touch("touchStart", [{ x: strip.x, y: strip.y }]);
      for (let i = 1; i <= 10; i++) await touch("touchMove", [{ x: strip.x - i * 14, y: strip.y }]);
      await touch("touchEnd", []);
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => {
        const el = document.querySelector('[data-strip="1"]');
        const dock = document.querySelector('[data-tour="dock"]');
        const last = el.children[el.children.length - 1];
        return {
          scrolled: Math.round(el.scrollLeft),
          range: el.scrollWidth - el.clientWidth,
          lastPast: Math.round(
            last.getBoundingClientRect().right - dock.getBoundingClientRect().right,
          ),
        };
      });
      check(`${label}: a finger swipe scrolls it`,
        after.scrolled > after.range * 0.8, `scrollLeft ${after.scrolled} of ${after.range}`);
      check(`${label}: …and the far chip ends up inside the dock`,
        after.lastPast <= 0, `last chip ${strip.lastPast}px past → ${after.lastPast}px`);
    }
    await context.close();
  }

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
