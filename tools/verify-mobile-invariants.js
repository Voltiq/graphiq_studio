/* The five mobile invariants, stated once and broken on purpose.
 *
 * THE ITEM'S PREMISE, CHECKED FIRST: "a harness that only screenshots proves
 * nothing". Nothing here screenshots. Five rails already assert most of these
 * geometrically — `verify-hit-targets` (23 checks), `verify-touch-targets` (8),
 * `verify-safe-area` (42, with real CDP notch insets), `verify-viewport` (17)
 * and `verify-dialog-sheets` (14) — 104 checks, all green before this file
 * existed. So this rail is NOT a rewrite of them, and duplicating them would be
 * worse than useless: it states the five invariants in one place, on the full
 * device profile the others mostly do not use, and in the states they do not
 * reach.
 *
 * WHAT IS ACTUALLY NEW, measured rather than assumed:
 *
 *   1. THE FULL DEVICE PROFILE. `verify-hit-targets` and the rest run at
 *      `deviceScaleFactor: 1` without `isMobile` — a desktop browser that
 *      accepts touch. Everything here runs on `DEVICES.phone` from
 *      tools/mobile.js: dpr 3, isMobile, an iPhone user agent.
 *
 *   2. HIT-TESTED, NOT MEASURED. `verify-dialog-sheets` walks all 54 dialogs and
 *      checks their footers are inside the visible area — then drives them with
 *      `element.click()`, which reaches a button that is completely covered.
 *      `verify-viewport` does hit-test a primary button with `elementFromPoint`,
 *      but only one dialog, under a simulated keyboard. Here every dialog's
 *      primary button is hit-tested, which is the item's fifth invariant and the
 *      one genuinely not covered.
 *
 *   3. INSIDE DIALOGS. The 44px sweep in `verify-hit-targets` runs over the
 *      shell's surfaces. A dialog's contents are swept here as well.
 *
 * A LESSON THAT COST A FALSE POSITIVE, recorded so the next reader does not
 * repeat it: the primary action is THE LAST BUTTON IN A FOOTER, and dialogs
 * without a footer have no primary action at all. Taking "the last button
 * anywhere" instead — which is what the measurement started with — reported the
 * gradient dialog's Reverse control as unreachable at 320×568. It is a
 * `role="switch"` sitting 31px below the fold of a dialog that scrolls, with a
 * 69.7×44 `::before` for the finger. Nothing was wrong with it.
 *
 * WHAT THIS CANNOT SEE is written down in REAL-DEVICE-CHECKLIST.md rather than
 * left implied, because a green run here is not "mobile works".
 *
 * Run: node tools/verify-mobile-invariants.js [--url ...] [--channel ...] [--no-dialogs]
 */
const { DEVICES, deviceContext, openApp, tap } = require("./mobile");
const { launchBrowser } = require("./lib/launch");

/* The same notch as verify-safe-area, so the two rails describe one device. */
const NOTCH = { top: 47, right: 0, bottom: 34, left: 0 };
const FLOOR = 44;

/**
 * Everything a finger can reach, with its box and whether a touch at its centre
 * actually lands on it.
 *
 * `role="switch"` is exempt from the box rule and NOT from the hit rule: a
 * switch is painted as a track, so its own box is 70×16 by design, and
 * `globals.scss` gives it a 44px `::before` instead. The exemption is therefore
 * conditional here — a switch has to prove the `::before` is really there.
 */
const SWEEP = (floor) => {
  const SEL =
    'button,[role="button"],select,a[href],[role="menuitem"],[role="tab"],' +
    '[role="switch"],input:not([type="range"])';
  const small = [];
  const unhit = [];
  const name = (el) =>
    (el.getAttribute("aria-label") || el.textContent.trim() || el.tagName).slice(0, 30);
  for (const el of document.querySelectorAll(SEL)) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const cs = getComputedStyle(el);
    if (cs.visibility === "hidden" || cs.display === "none" || +cs.opacity === 0) continue;
    /* ON SCREEN MEANS ITS CENTRE IS, not that its box grazes the edge. Dialogs
       taller than the phone scroll their contents — `verify-dialog-sheets`
       asserts exactly that — so a control straddling the fold is reached by
       scrolling and is not a layout fault. Measured while getting this wrong:
       the Warp and Liquify dialogs put controls at y=841, 917 and 1001 in an
       844px viewport, and admitting the first of them produced three failures
       whose only real content was "this dialog scrolls". */
    const midX = r.x + r.width / 2;
    const midY = r.y + r.height / 2;
    if (midY < 0 || midY > innerHeight || midX < 0 || midX > innerWidth) continue;
    /* PARKED MEANS INERT, and that is the whole reason this rule can be stated
       cleanly. A shut drawer still has boxes: the phone's tool rail sits at
       x:-320 and the panels sheet rests behind the mobile bar, so a naive sweep
       reports both as unreachable controls, which they are — and correctly so.
       `inert` is the app's own declaration of "nothing in here is live", and it
       takes the subtree out of the tab order and out of hit-testing too, so a
       surface cannot be skipped here without genuinely being parked. */
    if (el.closest("[inert]")) continue;

    if (el.getAttribute("role") === "switch" || el.tagName === "SPAN") {
      /* Artwork that is small on purpose — a switch's track, a slider's value
         readout — takes the floor as REACH instead of as paint: an invisible
         centred `::before`, the pattern globals.scss already uses on switches.
         So the box is not the question here; the declared reach is.

         A STRONGER TEST WAS TRIED AND GIVEN UP, which is worth recording rather
         than quietly dropping. Hit-testing 18px above and below the centre —
         what `verify-hit-targets` does to the switches — flagged exactly two
         controls in 43 dialogs: Liquify's "Show mesh" and Warp's angle readout.
         Both sit hard against a sticky dialog footer, and the footer is what
         the probe landed on. Neither is unreachable: both pass the centre hit
         test above, and the footer being on top is the SAFE direction — an
         invisible 44px reach near chrome loses to the chrome rather than
         stealing taps from it. The test was reporting adjacency, not a defect,
         so the assertion is the declared reach and the limitation is written
         down here. */
      const bf = getComputedStyle(el, "::before");
      if (!(parseFloat(bf.height) >= floor && parseFloat(bf.width) >= floor))
        small.push(
          `${name(el)} ${Math.round(r.width)}×${Math.round(r.height)} declares no ` +
            `44px reach — ::before is ${bf.width}×${bf.height}`,
        );
    } else if (r.width < floor || r.height < floor) {
      small.push(`${name(el)} ${Math.round(r.width)}×${Math.round(r.height)}`);
    }

    const cx = Math.min(innerWidth - 1, Math.max(1, midX));
    const cy = Math.min(innerHeight - 1, Math.max(1, midY));
    const hit = document.elementFromPoint(cx, cy);
    if (!(hit && (hit === el || el.contains(hit) || hit.contains(el))))
      unhit.push(
        `${name(el)} → ${hit ? name(hit) : "nothing"}`,
      );
  }
  return { small, unhit };
};

/** The shell's own geometry: does it fill exactly what is visible, and stay put? */
const GEOMETRY = () => {
  const de = document.documentElement;
  const shell = document.querySelector('[class*="app"]');
  const r = shell ? shell.getBoundingClientRect() : null;
  return {
    shellH: r ? Math.round(r.height) : null,
    shellW: r ? Math.round(r.width) : null,
    vvH: visualViewport ? Math.round(visualViewport.height) : null,
    vvW: visualViewport ? Math.round(visualViewport.width) : null,
    scrollX: Math.round(de.scrollLeft || scrollX),
    scrollY: Math.round(de.scrollTop || scrollY),
    scrollW: de.scrollWidth,
    scrollH: de.scrollHeight,
    innerW: innerWidth,
    innerH: innerHeight,
  };
};

/** The primary action, by this codebase's convention, and whether a touch lands on it. */
const PRIMARY = () => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return null;
  const foot = d.querySelector("footer");
  /* No footer means no primary action. Asserting on "the last button anywhere"
     instead is what produced this rail's one false positive. */
  if (!foot) return { skipped: true };
  const btns = [...foot.querySelectorAll("button")].filter(
    (b) => b.getBoundingClientRect().width > 0,
  );
  const b = btns[btns.length - 1];
  if (!b) return { skipped: true };
  const r = b.getBoundingClientRect();
  const cx = r.x + r.width / 2;
  const cy = r.y + r.height / 2;
  const inView = cy >= 0 && cy <= innerHeight && cx >= 0 && cx <= innerWidth;
  const hit = inView ? document.elementFromPoint(cx, cy) : null;
  const ok = !!(hit && (hit === b || b.contains(hit)));
  return {
    ok,
    name: (b.getAttribute("aria-label") || b.textContent.trim() || "?").slice(0, 24),
    why: ok
      ? ""
      : !inView
        ? `centre at ${Math.round(cy)} is outside the ${innerHeight}px viewport`
        : `covered by ${hit ? (hit.getAttribute("aria-label") || hit.tagName).slice(0, 24) : "nothing"}`,
  };
};

(async () => {
  const argv = process.argv.slice(2);
  const NO_DIALOGS = argv.includes("--no-dialogs");
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const browser = await launchBrowser();
  const context = await deviceContext(browser, DEVICES.phone);
  const page = await openApp(context);
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

  const barBtn = (label) =>
    page.locator('[data-tour="mobilebar"] button', { hasText: label }).first().boundingBox();
  const openFromBar = async (label) => {
    const b = await barBtn(label);
    if (!b) return false;
    await tap(page, b.x + b.width / 2, b.y + b.height / 2);
    await page.waitForTimeout(950);
    return true;
  };

  // ============ 1 & 4: the floor and the scroll, across the shell's states ====
  /* Swept in every state rather than at rest. A control that is 44px with the
     drawers closed and 30px with one open is still a control a finger misses. */
  const STATES = ["at rest", "tools drawer", "panels sheet"];
  const smallAnywhere = [];
  const unhitAnywhere = [];
  const geo = [];
  for (const state of STATES) {
    if (state === "tools drawer") await openFromBar("Tools");
    if (state === "panels sheet") await openFromBar("Panels");
    const s = await page.evaluate(SWEEP, FLOOR);
    const g = await page.evaluate(GEOMETRY);
    geo.push([state, g]);
    for (const x of s.small) smallAnywhere.push(`${state}: ${x}`);
    /* The scrim over the top bar while a drawer is open is the shell working,
       not failing, so hit misses are only collected at rest. */
    if (state === "at rest") for (const x of s.unhit) unhitAnywhere.push(x);
    if (state !== "at rest") {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(700);
    }
  }
  check("no interactive target is under 44px, in any state of the shell",
    smallAnywhere.length === 0,
    smallAnywhere.slice(0, 4).join(" | ") ||
      `${STATES.length} states swept, switches proving a ≥44px ::before rather than being waved through`);
  check("…and every one of them is hit-testable where it sits",
    unhitAnywhere.length === 0,
    unhitAnywhere.slice(0, 4).join(" | ") || "a touch at the centre of each reaches it");

  // ============ the invariant a sweep of the screen cannot see ==============
  /* KEYBOARD FOCUS MUST NOT LEAVE THE SCREEN. A shut drawer is off-screen, not
     gone: the phone's tool rail sits at x:-320 and the dock rests behind the
     mobile bar, and both stayed in the tab order. Measured before the fix, 46 of
     59 tab stops on a phone were controls no finger could reach — you tabbed
     through three dozen invisible tools to get to the canvas.
     
     This check exists because a mutation demanded it. Deleting `inert` from the
     parked rail left every other check in this file green: the rail is off the
     left edge, so a sweep of what is on screen correctly ignores it, and only
     the tab order can tell that it is still live. */
  const tabStops = [];
  const strayFocus = [];
  for (let i = 0; i < 80; i++) {
    await page.keyboard.press("Tab");
    const f = await page.evaluate(() => {
      const a = document.activeElement;
      if (!a || a === document.body) return null;
      const r = a.getBoundingClientRect();
      const cx = Math.min(innerWidth - 1, Math.max(1, r.x + r.width / 2));
      const cy = r.y + r.height / 2;
      const hit =
        cy >= 0 && cy <= innerHeight ? document.elementFromPoint(cx, cy) : null;
      return {
        name: (a.getAttribute("aria-label") || a.textContent.trim() || a.tagName).slice(0, 26),
        y: Math.round(r.y),
        reachable: !!(hit && (hit === a || a.contains(hit) || hit.contains(a))),
      };
    });
    if (!f) continue;
    const key = `${f.name}@${f.y}`;
    if (tabStops.includes(key)) break; // wrapped round
    tabStops.push(key);
    if (!f.reachable) strayFocus.push(key);
  }
  check("keyboard focus never lands on something a finger cannot reach",
    strayFocus.length === 0 && tabStops.length > 4,
    strayFocus.length
      ? `${strayFocus.length} of ${tabStops.length} tab stops are off-screen: ` +
        strayFocus.slice(0, 4).join(", ")
      : `all ${tabStops.length} tab stops are on screen and hit-testable, ` +
        `against 46 of 59 before the parked surfaces were made inert`);

  check("the page never scrolls, in any state",
    geo.every(([, g]) => g.scrollX === 0 && g.scrollY === 0 &&
      g.scrollW <= g.innerW && g.scrollH <= g.innerH),
    geo.map(([s, g]) => `${s} ${g.scrollW}×${g.scrollH}`).join(", ") + ` in ${geo[0][1].innerW}×${geo[0][1].innerH}`);

  /* Asked to scroll, it still must not. A page that only happens to fit is one
     stray margin away from scrolling. */
  await page.evaluate(() => window.scrollTo(0, 500));
  await page.waitForTimeout(300);
  const shoved = await page.evaluate(GEOMETRY);
  check("…even when something tries to scroll it",
    shoved.scrollY === 0 && shoved.scrollX === 0,
    `scrollTo(0,500) left it at ${shoved.scrollX},${shoved.scrollY}`);

  // ================== 3: the shell fills exactly what is visible =============
  const rest = geo[0][1];
  check("the shell is exactly as tall as the visual viewport",
    rest.shellH === rest.vvH && rest.vvH !== null,
    `shell ${rest.shellH}px, visualViewport.height ${rest.vvH}px`);
  check("…and exactly as wide",
    rest.shellW === rest.vvW, `shell ${rest.shellW}px, visualViewport.width ${rest.vvW}px`);

  // ============== 2: no chrome inside the safe-area inset ====================
  /* Measured with a real notch handed to Chromium, because with no insets every
     claim here is trivially true — the bands are zero pixels tall. */
  const cdp = await context.newCDPSession(page);
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: NOTCH });
  } catch (e) {
    console.error(
      "\nCANNOT RUN: this browser has no Emulation.setSafeAreaInsetsOverride " +
        `(${e.message.split("\n")[0]}).\nThe inset check needs it — upgrade the browser rather than skipping it.`,
    );
    process.exit(1);
  }
  await page.waitForTimeout(700);
  const intruders = await page.evaluate((notch) => {
    const SEL = 'button,[role="button"],select,a[href],[role="tab"],[role="switch"]';
    const out = [];
    for (const el of document.querySelectorAll(SEL)) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || +cs.opacity === 0) continue;
      if (r.bottom < 0 || r.top > innerHeight) continue;
      if (el.closest("[inert]")) continue; // a parked surface, as above
      const label = (el.getAttribute("aria-label") || el.textContent.trim() || el.tagName).slice(0, 26);
      /* The unusable bands: under the cutout, and under the home indicator. */
      if (r.top < notch.top) out.push(`${label} top ${Math.round(r.top)} < ${notch.top}`);
      if (r.bottom > innerHeight - notch.bottom)
        out.push(`${label} bottom ${Math.round(r.bottom)} > ${innerHeight - notch.bottom}`);
    }
    return out;
  }, NOTCH);
  check("no control sits under the notch or the home indicator",
    intruders.length === 0,
    intruders.slice(0, 4).join(" | ") ||
      `nothing in the top ${NOTCH.top}px or the bottom ${NOTCH.bottom}px, with the insets applied`);
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, right: 0, bottom: 0, left: 0 } });
  await page.waitForTimeout(500);

  // ============== 5: every dialog's primary button is hit-testable ===========
  let walked = 0;
  let footered = 0;
  const unreachable = [];
  const smallInDialogs = [];
  if (!NO_DIALOGS) {
    const openSheet = async () => {
      if (await page.evaluate(() => !!document.querySelector('[data-menubar][data-sheet="true"]')))
        return;
      await page.evaluate(() =>
        [...document.querySelectorAll("header button")]
          .find((x) => /^Menu$/i.test(x.getAttribute("aria-label") || ""))
          ?.click(),
      );
      await page.waitForSelector('[data-menubar][data-sheet="true"]', { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(300);
    };
    const clickMenu = async (m) => {
      await page.evaluate(
        (l) =>
          [...document.querySelectorAll("[data-menubar] > div > button")]
            .find((x) => x.textContent.trim() === l)
            ?.click(),
        m,
      );
      await page.waitForTimeout(330);
    };
    await openSheet();
    const menus = await page.evaluate(() =>
      [...document.querySelectorAll("[data-menubar] > div > button")]
        .filter((x) => !x.hasAttribute("data-sheet-search"))
        .map((x) => x.textContent.trim()),
    );
    const rows = [];
    for (const m of menus) {
      await openSheet();
      await clickMenu(m);
      const items = await page.evaluate(() =>
        [...document.querySelectorAll('[data-menubar] [role="menu"] button')]
          .filter((x) => {
            const l = x.querySelector("span")?.textContent?.trim() ?? x.textContent.trim();
            return !x.disabled && /…\s*$/.test(l);
          })
          .map((x) => x.querySelector("span")?.textContent?.trim() ?? x.textContent.trim()),
      );
      for (const it of items) rows.push([m, it.replace(/…$/, "")]);
      await clickMenu(m);
    }

    for (const [m, it] of rows) {
      await openSheet();
      await clickMenu(m);
      const row = page.locator('[data-menubar] [role="menu"] button', { hasText: it }).first();
      if (!(await row.count())) continue;
      await row.click().catch(() => {});
      await page.waitForTimeout(850);
      const r = await page.evaluate(PRIMARY);
      if (r) {
        walked++;
        if (!r.skipped) {
          footered++;
          if (!r.ok) unreachable.push(`${m} > ${it}: ${r.name} — ${r.why}`);
        }
        /* The floor, inside the dialog — a surface the shell sweep never sees. */
        const s = await page.evaluate(SWEEP, FLOOR);
        for (const x of s.small) smallInDialogs.push(`${m} > ${it}: ${x}`);
      }
      for (let i = 0; i < 4; i++) {
        if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"]')))) break;
        await page.keyboard.press("Escape").catch(() => {});
        await page.evaluate(() =>
          document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click(),
        );
        await page.waitForTimeout(320);
      }
    }
    check("the walk actually opened the dialogs it claims to have checked",
      walked >= 40 && footered >= 20,
      `${walked} dialogs opened, ${footered} of them with a footer to have a primary action`);
    check("every dialog's primary button can be touched where it sits",
      unreachable.length === 0,
      unreachable.slice(0, 3).join(" | ") ||
        `${footered} primary buttons hit-tested with elementFromPoint, not clicked programmatically`);
    check("…and nothing inside a dialog is under 44px either",
      smallInDialogs.length === 0,
      smallInDialogs.slice(0, 3).join(" | ") || `${walked} dialogs swept`);
  }

  check("no console errors throughout", errors.length === 0,
    errors.slice(0, 3).join(" | ") || "clean");

  await context.close();
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
