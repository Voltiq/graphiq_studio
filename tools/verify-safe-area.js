/* Safe-area tokens: do the display's unusable edges actually reach the layout?
 *
 * The app used to write `env(safe-area-inset-bottom)` out at five call sites
 * and never mentioned top, left or right at all. Those five are now one set of
 * tokens — `--safe-t/r/b/l` — plus two derived offsets, `--chrome-top` and
 * `--chrome-bottom`, that everything between the bars anchors to.
 *
 * The checks below are worth more than "the token exists", because a token
 * that nothing consumes would satisfy that. Chromium can be handed real notch
 * insets over CDP (`Emulation.setSafeAreaInsetsOverride`), which makes `env()`
 * resolve for real — so every geometric claim here is measured twice, once
 * with no insets and once with a notch and a home indicator, and asserted as
 * the DIFFERENCE between them. A hard-coded 56px bar passes the first reading
 * and fails the second.
 *
 * Run: node tools/verify-safe-area.js [--url ...] [--channel ...]
 */
const fs = require("fs");
const path = require("path");
const { launchBrowser, urlArg } = require("./lib/launch");

/* An iPhone-ish profile: a notch at the top, the home indicator at the foot. */
const NOTCH = { top: 47, right: 0, bottom: 34, left: 0 };
/* Rotated, where the cutout moves to one side and the indicator with it. */
const LANDSCAPE = { top: 0, right: 34, bottom: 21, left: 47 };

const MOBILE = { width: 390, height: 844 };

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const open = async (viewport) => {
    const context = await browser.newContext({ viewport });
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
    await page.waitForTimeout(600);
    return { context, page, cdp: await context.newCDPSession(page) };
  };

  /** The tokens as the browser has actually computed them, plus the geometry
   *  they are supposed to be driving. */
  const readout = (page) =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const v = (n) => cs.getPropertyValue(n).trim();
      const px = (s) => (s.endsWith("px") ? parseFloat(s) : NaN);
      /* A custom property holding a calc() of other properties computes to the
         SUBSTITUTED TOKEN STREAM — "calc(48px + 48px)" — not to a length, so it
         cannot simply be parsed. Measuring an element sized by it is what the
         layout itself does, and gives the used value. */
      const resolve = (expr) => {
        const probe = document.createElement("div");
        probe.style.cssText = `position:fixed;left:-9999px;top:0;visibility:hidden;height:${expr}`;
        document.body.appendChild(probe);
        const h = probe.getBoundingClientRect().height;
        probe.remove();
        return Math.round(h);
      };
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
                 right: Math.round(r.right), height: Math.round(r.height) };
      };
      const bar = document.querySelector('[data-tour="mobilebar"]');
      return {
        mobile: document.documentElement.dataset.mobile ?? "(absent)",
        safe: { t: px(v("--safe-t")), r: px(v("--safe-r")), b: px(v("--safe-b")), l: px(v("--safe-l")) },
        chromeTop: resolve("var(--chrome-top)"),
        chromeBottom: resolve("var(--chrome-bottom)"),
        toolbar: box('[data-tour="toolbar"]'),
        dock: box('[data-tour="dock"]'),
        edge: box(".gq-m-edge"),
        bar: box('[data-tour="mobilebar"]'),
        topbar: box('[data-tour="topbar"]'),
        hamburger: box('button[aria-label="Menu"]'),
        sheet: box('[data-menubar][data-sheet="true"]'),
        barPadBottom: bar ? Math.round(parseFloat(getComputedStyle(bar).paddingBottom)) : null,
        /* The lowest edge of anything the user has to be able to press. */
        barContentBottom: bar
          ? Math.round(Math.max(...[...bar.querySelectorAll("button")].map((b) => b.getBoundingClientRect().bottom)))
          : null,
        innerHeight: window.innerHeight,
      };
    });

  // ---------- 1. desktop: the tokens exist and are inert ----------
  {
    const { context, page } = await open({ width: 1500, height: 950 });
    const d = await readout(page);
    check("on a desktop browser every safe-area token resolves to 0",
      d.safe.t === 0 && d.safe.r === 0 && d.safe.b === 0 && d.safe.l === 0,
      `t${d.safe.t} r${d.safe.r} b${d.safe.b} l${d.safe.l}`);
    check("…so the derived offsets are just the chrome's own heights",
      d.chromeTop === 96 && d.chromeBottom === 28,
      `--chrome-top ${d.chromeTop}px, --chrome-bottom ${d.chromeBottom}px (48+48, 28)`);
    check("the desktop shell is untouched by any of it", d.mobile === "(absent)", `data-mobile=${d.mobile}`);
    await context.close();
  }

  // ---------- 2. mobile, no insets: the baseline every later number moves from ----------
  const { context, page, cdp } = await open(MOBILE);
  const flat = await readout(page);
  check("the phone profile gets the mobile shell", flat.mobile === "true", `data-mobile=${flat.mobile}`);
  check("with no insets the bottom chrome is exactly the bar", flat.chromeBottom === 56,
    `--chrome-bottom ${flat.chromeBottom}px`);
  check("…and the bar's box matches it", flat.bar?.height === 56 && flat.bar?.bottom === MOBILE.height,
    `${flat.bar?.height}px tall, bottom at ${flat.bar?.bottom}`);
  check("the drawers span from under the chrome to above the bar",
    flat.toolbar?.top === 96 && flat.toolbar?.bottom === MOBILE.height - 56 &&
    flat.dock?.top === 96 && flat.dock?.bottom === MOBILE.height - 56,
    `toolbar ${flat.toolbar?.top}–${flat.toolbar?.bottom}, dock ${flat.dock?.top}–${flat.dock?.bottom}`);

  // ---------- 3. mobile WITH a notch and a home indicator ----------
  /* Everything below depends on the browser being able to emulate insets. If it
     cannot, say so in those words: a silent skip here would leave the rail
     green while proving nothing at all about the half that matters. */
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: NOTCH });
  } catch (e) {
    console.error(
      "\nCANNOT RUN: this browser has no Emulation.setSafeAreaInsetsOverride " +
        `(${e.message.split("\n")[0]}).` +
        "\nEvery inset check needs it — upgrade the browser rather than skipping them.",
    );
    process.exit(1);
  }
  await page.waitForTimeout(300);
  const notched = await readout(page);

  check("a notch reaches the top token", notched.safe.t === NOTCH.top, `--safe-t ${notched.safe.t}px`);
  check("the home indicator reaches the bottom token", notched.safe.b === NOTCH.bottom,
    `--safe-b ${notched.safe.b}px`);
  check("the bottom chrome grows by exactly the indicator, not by a guess",
    notched.chromeBottom - flat.chromeBottom === NOTCH.bottom,
    `--chrome-bottom ${flat.chromeBottom} -> ${notched.chromeBottom} (+${notched.chromeBottom - flat.chromeBottom})`);
  check("…and the bar's box grows with it",
    notched.bar.height - flat.bar.height === NOTCH.bottom && notched.bar.bottom === MOBILE.height,
    `${flat.bar.height} -> ${notched.bar.height}px, still flush at ${notched.bar.bottom}`);
  /* The point of the exercise: the bar's BACKGROUND still reaches the bottom of
     the display, but nothing pressable is under the home indicator. */
  check("the bar's buttons clear the home indicator",
    notched.barPadBottom === NOTCH.bottom && notched.barContentBottom <= MOBILE.height - NOTCH.bottom,
    `padding-bottom ${notched.barPadBottom}px, lowest button ends at ${notched.barContentBottom} (limit ${MOBILE.height - NOTCH.bottom})`);
  check("both drawers stop above the indicator, by the same amount",
    flat.toolbar.bottom - notched.toolbar.bottom === NOTCH.bottom &&
    flat.dock.bottom - notched.dock.bottom === NOTCH.bottom,
    `toolbar ${flat.toolbar.bottom} -> ${notched.toolbar.bottom}, dock ${flat.dock.bottom} -> ${notched.dock.bottom}`);

  /* The top bar now reserves the inset, so --chrome-top includes it. (This
     check previously asserted the opposite, on purpose: the seam was left open
     until the bar's own box grew, so that closing it had to be deliberate.) */
  check("the top bar's box grows by exactly the notch",
    notched.topbar.height - flat.topbar.height === NOTCH.top && notched.topbar.top === 0,
    `${flat.topbar.height} -> ${notched.topbar.height}px, still flush at y=${notched.topbar.top}`);
  check("the hamburger sits below the notch, not under it",
    notched.hamburger.top >= NOTCH.top,
    `button top at ${notched.hamburger.top}, inset is ${NOTCH.top}`);
  check("the top offset follows the bar",
    notched.chromeTop - flat.chromeTop === NOTCH.top,
    `--chrome-top ${flat.chromeTop} -> ${notched.chromeTop}`);
  /* The reason --safe-t was NOT folded in before the bar reserved it: the two
     have to move together or a strip of bare canvas opens under the chrome. */
  check("…leaving no gap between the chrome and the drawers",
    notched.toolbar.top === notched.topbar.bottom + 48 && notched.dock.top === notched.toolbar.top,
    `bar ends at ${notched.topbar.bottom}, +48px options bar, drawers start at ${notched.toolbar.top}`);

  // ---------- 3b. the mobile menu sheet, still under the notch and the bar ----------
  /* The sheet is the collapsed menubar behind the hamburger. It ran from the
     top bar to `bottom: 0`, so its scroll container continued underneath the
     MobileBar and the last rows of a long menu could not be reached at all —
     scrolling to the end simply parked them behind the bar. */
  const sheetSel = '[data-menubar][data-sheet="true"]';
  await page.click('button[aria-label="Menu"]');
  await page.waitForSelector(sheetSel, { timeout: 5000 });
  await page.waitForTimeout(300);

  /* Use the LONGEST menu, since that is the one that overflows. Which one that
     is should not be hard-coded — it changes as menus gain items. */
  const roots = page.locator(`${sheetSel} > div > button`);
  const rootCount = await roots.count();
  let longest = { index: 0, items: 0, name: "?" };
  for (let i = 0; i < rootCount; i++) {
    await roots.nth(i).click();
    await page.waitForTimeout(160);
    const items = await page.locator(`${sheetSel} [role="menu"] button`).count();
    if (items > longest.items)
      longest = { index: i, items, name: (await roots.nth(i).textContent())?.trim() ?? "?" };
    await roots.nth(i).click(); // toggle shut so the next count is its own
    await page.waitForTimeout(120);
  }
  await roots.nth(longest.index).click();
  await page.waitForTimeout(300);
  await page.evaluate((sel) => {
    const s = document.querySelector(sel);
    s.scrollTop = s.scrollHeight; // all the way to the last row
  }, sheetSel);
  await page.waitForTimeout(250);

  const sheetProbe = await page.evaluate((sel) => {
    const sheet = document.querySelector(sel);
    /* The LOWEST row on screen once scrolled to the end — not the expanded
       menu's last item, which is followed by the remaining root buttons and so
       sits comfortably mid-sheet. The bottom row is the one the MobileBar used
       to cover, and the only one that can tell the two layouts apart. */
    const rows = [...sheet.querySelectorAll("button")];
    const el = rows.reduce((lowest, b) =>
      b.getBoundingClientRect().bottom > lowest.getBoundingClientRect().bottom ? b : lowest);
    const r = el.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    const hit = document.elementFromPoint(cx, cy);
    const sr = sheet.getBoundingClientRect();
    return {
      label: el.textContent.trim().slice(0, 28),
      centre: cy,
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
      /* Non-vacuity: the sheet has to be scrolled to its end AND the row has to
         be down at the sheet's foot, or this proves nothing about occlusion. */
      atEnd: Math.abs(sheet.scrollTop - (sheet.scrollHeight - sheet.clientHeight)) <= 2,
      gapToFoot: Math.round(sr.bottom - r.bottom),
    };
  }, sheetSel);

  check(`the sheet starts below the whole top bar, notch included`,
    sheetProbe.top === notched.topbar.bottom,
    `sheet top ${sheetProbe.top}, bar ends at ${notched.topbar.bottom}`);
  check("…and ends above the MobileBar rather than behind it",
    sheetProbe.bottom === MOBILE.height - notched.chromeBottom,
    `sheet bottom ${sheetProbe.bottom}, bar starts at ${MOBILE.height - notched.chromeBottom}`);
  check("the sheet really is scrolled to its last row",
    sheetProbe.atEnd && sheetProbe.gapToFoot <= 24,
    `scrolled to end: ${sheetProbe.atEnd}, bottom row ends ${sheetProbe.gapToFoot}px above the sheet's foot`);
  check("…and that bottom row can actually be pressed",
    sheetProbe.reachable,
    `"${longest.name}" was the longest menu (${longest.items} items); bottom row "${sheetProbe.label}" at y=${sheetProbe.centre}` +
      (sheetProbe.reachable ? "" : ` — blocked by ${sheetProbe.blockedBy}`));

  await page.click('button[aria-label="Menu"]'); // close it again
  await page.waitForTimeout(250);

  // ---------- 4. rotated: the side insets exist, ready for the item that uses them ----------
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: LANDSCAPE });
  await page.waitForTimeout(300);
  const rotated = await readout(page);
  check("a side cutout reaches the left and right tokens",
    rotated.safe.l === LANDSCAPE.left && rotated.safe.r === LANDSCAPE.right,
    `--safe-l ${rotated.safe.l}px, --safe-r ${rotated.safe.r}px`);
  check("…and the bottom follows the rotation too",
    rotated.safe.b === LANDSCAPE.bottom && rotated.chromeBottom === 56 + LANDSCAPE.bottom,
    `--safe-b ${rotated.safe.b}px, --chrome-bottom ${rotated.chromeBottom}px`);

  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, right: 0, bottom: 0, left: 0 } });
  await page.waitForTimeout(200);
  const cleared = await readout(page);
  check("clearing the insets puts everything back", cleared.chromeBottom === 56 && cleared.bar.height === 56,
    `--chrome-bottom ${cleared.chromeBottom}px, bar ${cleared.bar.height}px`);

  // ---------- 5. landscape: the cutout moves to a side ----------
  /* A real iPhone in landscape is 844px wide, which today resolves to the
     DESKTOP shell, because the breakpoint is width-only — that is the NEXT
     item, not this one. 740px keeps the mobile shell while still being wider
     than it is tall, so the drawers, the bottom bar and the swipe strips are
     all in play with a side inset applied.

     The item proposed asserting `rect.left >= safeLeft + 16`. That margin is
     larger than the app's own gutters (--sp-2 is 8px, --sp-3 is 12px), so it
     would fail on correct layout; what is asserted instead is that nothing
     pressable intrudes into the inset AT ALL, which is the actual claim. */
  const LAND = { width: 740, height: 390 };
  for (const [label, insets] of [
    ["a cutout on the left", { top: 0, right: 34, bottom: 21, left: 47 }],
    ["a cutout on the right", { top: 0, right: 47, bottom: 21, left: 34 }],
  ]) {
    const land = await open(LAND);
    await land.cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
    await land.page.waitForTimeout(350);
    const lp = land.page;
    const W = LAND.width;
    const fits = (r) => !!r && r.left >= insets.left && r.right <= W - insets.right;
    const say = (r) => (r ? `${r.left}…${r.right}` : "missing");
    const bounds = `safe box is ${insets.left}…${W - insets.right}`;

    const chrome = await lp.evaluate(() => {
      const r = (el) => {
        if (!el) return null;
        const b = el.getBoundingClientRect();
        return { left: Math.round(b.left), right: Math.round(b.right) };
      };
      const barBtns = [...document.querySelectorAll('[data-tour="mobilebar"] button')];
      return {
        hamburger: r(document.querySelector('button[aria-label="Menu"]')),
        barFirst: r(barBtns[0]),
        barLast: r(barBtns[barBtns.length - 1]),
        edgeL: r(document.querySelector('.gq-m-edge[data-side="left"]')),
        edgeR: r(document.querySelector('.gq-m-edge[data-side="right"]')),
      };
    });
    check(`${label}: the top bar's first control clears it`, fits(chrome.hamburger),
      `${say(chrome.hamburger)} — ${bounds}`);
    check(`${label}: the bottom bar's buttons clear it`,
      fits(chrome.barFirst) && fits(chrome.barLast),
      `first ${say(chrome.barFirst)}, last ${say(chrome.barLast)} — ${bounds}`);
    /* The swipe strips are invisible hit targets, so they move rather than pad:
       a 20px strip under a 47px cutout could not be touched at all. */
    check(`${label}: the swipe strips sit inside it`, fits(chrome.edgeL) && fits(chrome.edgeR),
      `left ${say(chrome.edgeL)}, right ${say(chrome.edgeR)} — ${bounds}`);

    // The drawers, which are the halves the item names.
    await lp.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().click();
    await lp.waitForTimeout(500);
    const tools = await lp.evaluate(() => {
      const b = document.querySelector('[data-tour="toolbar"] button');
      if (!b) return null;
      const r = b.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right) };
    });
    check(`${label}: the tool drawer's first button clears it`, fits(tools), `${say(tools)} — ${bounds}`);
    /* Close before opening the other one. The bar genuinely sits above the
       scrim (z-130 against z-110, and elementFromPoint at the button's centre
       returns the button), but Playwright's actionability check refuses to
       click through an overlay that covers the point, so switching drawers
       directly stalls the run rather than failing anything real. */
    await lp.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().click();
    await lp.waitForTimeout(500);
    await lp.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
    await lp.waitForTimeout(600);
    const dock = await lp.evaluate(() => {
      const el = document.querySelector('[data-tour="dock"]');
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const pad = Math.round(parseFloat(getComputedStyle(el).paddingRight));
      /* Only the controls actually inside the drawer's visible width. Panel
         content can be wider than the dock and scroll horizontally, so the
         widest button in there sits off to the right of the viewport whether or
         not there is an inset — measuring those would say nothing about this. */
      const vis = [...el.querySelectorAll("button")]
        .map((b) => b.getBoundingClientRect())
        .filter((b) => b.right <= r.right + 1 && b.width > 0);
      return {
        boxRight: Math.round(r.right),
        pad,
        left: vis.length ? Math.round(Math.min(...vis.map((b) => b.left))) : 0,
        right: vis.length ? Math.round(Math.max(...vis.map((b) => b.right))) : 0,
        count: vis.length,
      };
    });
    check(`${label}: the panel drawer reserves it`,
      dock && dock.boxRight === W && dock.pad === insets.right,
      `drawer ends at ${dock?.boxRight} (viewport ${W}), padding-right ${dock?.pad} (inset ${insets.right})`);
    /* Measured as a DIFFERENCE, not against the safe box. Panel content is
       already wider than the 320px dock on a viewport this narrow — with no
       inset at all the widest control ends past the display edge — so an
       absolute bound would be asserting something that was never true. What
       this item changed is that the whole column moves inboard by the inset. */
    await land.cdp.send("Emulation.setSafeAreaInsetsOverride",
      { insets: { top: 0, right: 0, bottom: 0, left: 0 } });
    await lp.waitForTimeout(300);
    const dockFlat = await lp.evaluate(() => {
      const el = document.querySelector('[data-tour="dock"]');
      const vis = [...el.querySelectorAll("button")]
        .map((b) => b.getBoundingClientRect())
        .filter((b) => b.width > 0);
      return { right: Math.round(Math.max(...vis.map((b) => b.right))) };
    });
    await land.cdp.send("Emulation.setSafeAreaInsetsOverride", { insets });
    await lp.waitForTimeout(300);
    const dockInset = await lp.evaluate(() => {
      const el = document.querySelector('[data-tour="dock"]');
      const vis = [...el.querySelectorAll("button")]
        .map((b) => b.getBoundingClientRect())
        .filter((b) => b.width > 0);
      return { right: Math.round(Math.max(...vis.map((b) => b.right))) };
    });
    check(`${label}: …and its contents move inboard by exactly that much`,
      dockFlat.right - dockInset.right === insets.right,
      `widest control ends at ${dockFlat.right} with no inset, ${dockInset.right} with one ` +
        `(moved ${dockFlat.right - dockInset.right}, inset is ${insets.right})`);

    await land.context.close();
  }

  // ---------- 5b. a popup that would overflow the cutout is pulled back ----------
  /* Deliberately fatter than any real phone. With the true insets above, every
     popup that can be opened on screen happens to fit anyway — so opening one
     would pass whether or not the clamp does anything, which is precisely what
     an earlier version of this check did: reverting a popup to window.innerWidth
     left it green. 200px guarantees the clamp has work to do. */
  {
    const FAT = 200;
    const land = await open(LAND);
    const lp = land.page;
    await lp.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
    await lp.waitForTimeout(700);
    await land.cdp.send("Emulation.setSafeAreaInsetsOverride",
      { insets: { top: 0, right: FAT, bottom: 0, left: 0 } });
    await lp.waitForTimeout(350);

    /* The rightmost trigger inside the drawer, which is flush to that edge.
       Clicked by coordinate rather than by locator: the drawer's scrim makes
       Playwright's actionability check refuse a click the browser would land. */
    const anchor = await lp.evaluate(async () => {
      const all = [...document.querySelectorAll('[data-tour="dock"] button[aria-haspopup="listbox"]')]
        .filter((b) => b.getBoundingClientRect().width > 0);
      if (!all.length) return null;
      /* The rightmost one, then scrolled into view: the dock is a tall scroller,
         and its selects sit well below a 390px-high viewport, so a rect taken
         where they lie unscrolled points thousands of pixels off screen. */
      const el = all.reduce((a, b) =>
        b.getBoundingClientRect().left > a.getBoundingClientRect().left ? b : a);
      el.scrollIntoView({ block: "center" });
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 120)));
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > window.innerHeight) return null;
      return { x: Math.round(r.left), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
    });
    if (!anchor) {
      check("a popup that would overflow the cutout is pulled back inside it", false,
        "no listbox trigger was on screen inside the drawer");
    } else {
      await lp.mouse.click(anchor.x + anchor.w / 2, anchor.y);
      await lp.waitForTimeout(450);
      const pop = await lp.evaluate(() => {
        const el = document.querySelector('[role="listbox"]');
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
      });
      const limit = LAND.width - FAT;
      check("a popup that would overflow the cutout is pulled back inside it",
        !!pop && pop.right <= limit && pop.left < anchor.x,
        pop
          ? `anchored at ${anchor.x}, ${pop.width}px wide — would have ended at ${anchor.x + pop.width}, ` +
            `lands at ${pop.left}…${pop.right} (safe edge ${limit})`
          : "no popup opened");
    }
    await land.context.close();
  }

  // ---------- 6. the source itself: nothing hand-rolls env() any more ----------
  const scss = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".scss")) scss.push(f);
    }
  };
  walk(path.join(process.cwd(), "app"));
  const envUses = [];
  const strayOffsets = [];
  /* Popups place from JS, so their equivalent of a hand-rolled env() is a clamp
     against window.innerWidth — the whole display, cutouts included. */
  const strayClamps = [];
  const walkTsx = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walkTsx(f);
      else if (e.name.endsWith(".tsx")) {
        for (const line of fs.readFileSync(f, "utf8").split("\n"))
          if (line.includes("window.innerWidth") && line.includes("Math.min"))
            strayClamps.push(`${path.basename(f)}: ${line.trim()}`);
      }
    }
  };
  walkTsx(path.join(process.cwd(), "app"));
  for (const f of scss) {
    const text = fs.readFileSync(f, "utf8");
    for (const line of text.split("\n")) {
      if (line.includes("env(safe-area-inset")) envUses.push(`${path.basename(f)}: ${line.trim()}`);
      /* The two sums the tokens replaced, written out longhand again —
         excluding the token definitions, which are the one place they belong. */
      if (/^\s*--(chrome|safe)-/.test(line)) continue;
      if (/var\(--topbar-h\)\s*\+\s*var\(--optionsbar-h\)/.test(line) ||
          /var\(--mobilebar-h\)\s*\+/.test(line))
        strayOffsets.push(`${path.basename(f)}: ${line.trim()}`);
    }
  }
  const defsOnly = envUses.every((u) => u.startsWith("globals.scss: --safe-"));
  check("env(safe-area-inset) survives only in the four token definitions",
    envUses.length === 4 && defsOnly, `${envUses.length} use(s)${defsOnly ? "" : " — " + envUses.join(" | ")}`);
  check("no offset re-adds the chrome heights by hand", strayOffsets.length === 0,
    strayOffsets.length ? strayOffsets.join(" | ") : "none");

  check("every popup clamps to the safe box, not to the whole display",
    strayClamps.length === 0, strayClamps.length ? strayClamps.join(" | ") : "none");

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
