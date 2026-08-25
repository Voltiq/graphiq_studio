/* The software keyboard.
 *
 * Measured at 390×844 with a 300px keyboard, before any of this: focusing
 * Export's last numeric field left it **185px below the keyboard line** —
 * typing into something you cannot see — and the MobileBar sat **300px behind
 * the keyboard**, entirely hidden, on a phone where it is the only route to the
 * tools and the panels. The viewport meta declared no `interactive-widget`, so
 * Chrome on Android drew the keyboard over the page rather than resizing it.
 *
 * WHAT A HARNESS CANNOT DO: summon a keyboard. The browser shrinks the VISUAL
 * viewport, and nothing Playwright drives does that — resizing the page moves
 * the layout viewport too, which is the opposite of the case being tested. So
 * the two halves are checked separately and honestly:
 *
 *   the CSS half — `--kb-inset` is written by hand and the shell is measured
 *   against it, which is exactly what the token is for;
 *
 *   the behaviour half — `__gqKeepFocusVisible` (a dev hook, in the family of
 *   `__gqFits` and `__gqPanelRenders`) is called directly, so the scrolling
 *   runs against a real dialog with a real scroller.
 *
 * And because "called directly" proves nothing about whether anything WOULD
 * call it, the wiring is checked too: a `visualViewport` resize event must make
 * the token recompute, which only happens if the listener is bound.
 *
 * Run: node tools/verify-keyboard.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

const PHONE = [390, 844];
const KB = 300;

const STATE = () => {
  const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0;
  const visible = window.innerHeight - kb;
  const bar = document.querySelector('[data-tour="mobilebar"]');
  const br = bar?.getBoundingClientRect();
  const active = document.activeElement;
  const ar = active && active !== document.body ? active.getBoundingClientRect() : null;
  const d = document.querySelector('[role="dialog"]');
  const dr = d?.getBoundingClientRect();
  return {
    kb,
    visible: Math.round(visible),
    vh: window.innerHeight,
    /* The item's second assertion, in its own words: the MobileBar's bottom
       still equals the visual viewport's. */
    barBottom: br ? Math.round(br.bottom) : null,
    barBehind: br ? Math.round(br.bottom - visible) : null,
    activeTag: active ? active.tagName.toLowerCase() : null,
    activeType: active?.getAttribute?.("type") ?? null,
    activeBottom: ar ? Math.round(ar.bottom) : null,
    activeBelow: ar ? Math.round(ar.bottom - visible) : null,
    dialogBottom: dr ? Math.round(dr.bottom) : null,
    meta: document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "",
  };
};

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const context = await browser.newContext({
    viewport: { width: PHONE[0], height: PHONE[1] },
    hasTouch: true,
    isMobile: true,
  });
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
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await dismissStartCard(page);
  await page.keyboard.press("Control+Shift+N");
  await page.waitForTimeout(1100);

  // ============================================== what the document declares ==
  const meta = (await page.evaluate(STATE)).meta;
  check("the viewport asks the browser to resize for the keyboard",
    /interactive-widget=resizes-content/.test(meta),
    meta || "(no viewport meta)");

  // ================================= the token is driven, not just declared ==
  /* A resize on `visualViewport` must recompute the token. Nothing about the
     value matters here — only that dispatching the event reaches a listener,
     which is the half `__gqKeepFocusVisible` cannot demonstrate. */
  const wired = await page.evaluate(() => {
    const root = document.documentElement;
    root.style.setProperty("--kb-inset", "999px");
    window.visualViewport?.dispatchEvent(new Event("resize"));
    return new Promise((resolve) =>
      setTimeout(
        () =>
          resolve({
            after: getComputedStyle(root).getPropertyValue("--kb-inset").trim(),
            hasVV: !!window.visualViewport,
          }),
        200,
      ),
    );
  });
  check("…and a visualViewport resize recomputes it",
    wired.hasVV && wired.after !== "999px",
    `set to 999px by hand, read back "${wired.after}" after a resize event`);

  const hook = await page.evaluate(() => typeof window.__gqKeepFocusVisible === "function");
  check("the focus-scroll behaviour is reachable for testing", hook,
    hook ? "__gqKeepFocusVisible is bound" : "dev hook missing");

  // =========================================== the bar rides above the keyboard ==
  const noKb = await page.evaluate(STATE);
  check("with no keyboard the bar sits on the bottom of the screen",
    noKb.barBottom === noKb.vh && noKb.kb === 0,
    `bar ends at ${noKb.barBottom} of ${noKb.vh}`);

  await page.evaluate((px) => document.documentElement.style.setProperty("--kb-inset", `${px}px`), KB);
  await page.waitForTimeout(500);
  const withKb = await page.evaluate(STATE);
  check(`with a ${KB}px keyboard the bar's bottom equals the visual viewport's`,
    withKb.barBottom === withKb.visible,
    `bar ends at ${withKb.barBottom}, visible area ends at ${withKb.visible} — it was ${withKb.vh}, i.e. ${KB}px behind`);

  // ================================== a focused field is brought above it ==
  await page.evaluate(() => document.documentElement.style.removeProperty("--kb-inset"));
  await page.waitForTimeout(300);
  await page.locator('header button[aria-label="Menu"]').click();
  await page.waitForSelector('[data-menubar][data-sheet="true"]', { timeout: 6000 });
  await page.waitForTimeout(350);
  await page.locator("[data-menubar] > div > button", { hasText: /^File$/ }).first().click();
  await page.waitForTimeout(400);
  const row = page.locator('[data-menubar] [role="menu"] button', { hasText: "Export as" }).first();
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.click();
  await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
  await page.waitForTimeout(1100);

  const focused = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const fields = [...d.querySelectorAll('input:not([type="range"]), select')];
    const last = fields[fields.length - 1];
    last?.focus();
    return { count: fields.length, tag: last?.tagName.toLowerCase() ?? null };
  });
  check("Export has fields to focus, and the last one takes focus",
    focused.count >= 2 && focused.tag !== null,
    `${focused.count} fields, last is a <${focused.tag}>`);

  await page.evaluate((px) => document.documentElement.style.setProperty("--kb-inset", `${px}px`), KB);
  await page.waitForTimeout(400);
  const before = await page.evaluate(STATE);
  /* Non-vacuity: the field has to START behind the keyboard, or "it ends up in
     front of it" is a claim about a field that was never hidden. */
  check("…and the keyboard does cover it to begin with", before.activeBelow > 0,
    `${before.activeBelow}px below the keyboard line`);

  await page.evaluate((px) => window.__gqKeepFocusVisible?.(px), KB);
  await page.waitForTimeout(500);
  const after = await page.evaluate(STATE);
  check("the focused field is scrolled above the keyboard",
    after.activeBelow < 0 && after.activeBottom < after.visible,
    `field ends at ${after.activeBottom}, visible area at ${after.visible} — it was ${before.activeBottom}`);

  /* Minimum movement: a field already in view must not be yanked around.
     Asked of the FIRST field, not the one just scrolled to. Repeating the call
     on the last field proves nothing — the body is at the end of its scroll by
     then, so an implementation that over-scrolls by a fixed amount is clamped
     to zero and looks well behaved. That is exactly what a mutation adding 40px
     to every delta did: it survived until this check moved to a field with room
     to move. */
  const idle = await page.evaluate((px) => {
    const d = document.querySelector('[role="dialog"]');
    const first = d.querySelector('input:not([type="range"]), select');
    first?.focus();
    const scroller = (() => {
      for (let n = first?.parentElement; n; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) return n;
      }
      return null;
    })();
    const beforeTop = first.getBoundingClientRect().top;
    const beforeScroll = scroller ? scroller.scrollTop : 0;
    const visible = window.innerHeight - px;
    const alreadyVisible = first.getBoundingClientRect().bottom < visible;
    window.__gqKeepFocusVisible?.(px);
    return {
      alreadyVisible,
      room: scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight - beforeScroll) : 0,
      moved: Math.round(first.getBoundingClientRect().top - beforeTop),
    };
  }, KB);
  check("…and a field that is already visible is left alone",
    idle.alreadyVisible && idle.room > 40 && idle.moved === 0,
    `first field visible: ${idle.alreadyVisible}, ${idle.room}px of scroll still available, moved ${idle.moved}px`);

  check("the bar is still above the keyboard with a dialog open",
    after.barBottom === after.visible,
    `bar ends at ${after.barBottom}, visible area at ${after.visible}`);

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await context.close();
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
