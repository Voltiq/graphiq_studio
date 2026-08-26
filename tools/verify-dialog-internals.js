/* The dialogs whose insides could not fit a phone.
 *
 * Sizing them as full-screen sheets (v1.20.0) fixed the boxes; it did nothing
 * for what was in them. Two families were still laid out for a wide window:
 *
 *   PREVIEWS — Blur Gallery, Liquify, Warp and Refine Edge each put a canvas
 *   of a hard-coded 500–560px beside a controls column, with the preview
 *   `flex-shrink: 0`. On a 390px phone the controls were pushed off the right
 *   edge and the dialog's own `overflow: hidden` clipped them away. Measured:
 *   Blur Gallery's only slider sat **294px past** the edge, Liquify's and
 *   Warp's **354px**, Layer Style's **142px**. Not cramped — gone, with
 *   nothing to scroll sideways.
 *
 *   RAILS — Layer Style, Smart Filter and Preferences each keep a 168–200px
 *   list beside their panel. Stacked, Layer Style's became **562px tall of an
 *   844px sheet**: nine rows to scroll past before reaching the controls they
 *   select. They are now a strip along the top that scrolls sideways, which is
 *   the same filmstrip the options bar uses.
 *
 * A scrolling strip legitimately has content beyond its edge — that is what
 * scrolling means — so the property is not "nothing sticks out" but "the last
 * one can be reached", exactly as `verify-dock-reach.js` establishes.
 *
 * Run: node tools/verify-dialog-internals.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

const PHONE = [390, 844];
const DESKTOP = [1400, 900];

const PREVIEWS = [
  ["Effects", "Blur gallery"],
  ["Effects", "Liquify"],
  ["Effects", "Warp"],
  ["Select", "Refine edge"],
];
/* The rails that lie DOWN into a strip along the top. Preferences used to be
   the third and no longer is: a filmstrip works for nine effects and does not
   for twelve preference sections, which it showed four of at a time behind a
   sideways scroll. That one is now an icon column down the left and is checked
   separately, further down, on the terms it actually has. */
const RAILS = [
  ["Layer", "Layer style"],
  ["Effects", "Smart filters"],
];

/** Everything the item cares about, plus what makes each claim non-vacuous. */
const READ = () => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return null;
  const dr = d.getBoundingClientRect();
  /** How far outside the dialog's own box an element sits. */
  const past = (e) => {
    const r = e.getBoundingClientRect();
    return Math.round(Math.max(r.right - dr.right, dr.left - r.left));
  };
  const sliders = [...d.querySelectorAll('input[type="range"]')];
  const foot = d.querySelector("footer");
  const primary = (foot ? [...foot.querySelectorAll("button")] : [...d.querySelectorAll("button")]).pop();
  const pr = primary?.getBoundingClientRect();
  let reaches = "none";
  if (pr && pr.width > 0) {
    const el = document.elementFromPoint(Math.round(pr.x + pr.width / 2), Math.round(pr.y + pr.height / 2));
    reaches = el && primary.contains(el) ? "itself" : el ? el.tagName.toLowerCase() : "nothing";
  }
  const canvases = [...d.querySelectorAll("canvas")]
    .map((c) => {
      const r = c.getBoundingClientRect();
      if (r.width === 0) return null;
      const attr = c.width && c.height ? c.width / c.height : null;
      const css = r.height ? r.width / r.height : null;
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        past: past(c),
        /* Capping width without letting height follow squashes the picture. */
        squashed: attr && css ? Math.abs(attr - css) > 0.02 : false,
      };
    })
    .filter(Boolean);
  const rail = d.querySelector("[data-dialog-rail]");
  const rr = rail?.getBoundingClientRect();
  return {
    label: d.getAttribute("aria-label") ?? "?",
    dw: Math.round(dr.width),
    /* The dialog itself must not need sideways scrolling. */
    dialogScrollsX: d.scrollWidth > d.clientWidth + 1,
    sliders: sliders.length,
    slidersOut: sliders.filter((s) => past(s) > 1).map((s) => past(s)),
    primary: primary ? primary.textContent.trim().slice(0, 16) : null,
    primaryPast: primary ? past(primary) : null,
    reaches,
    canvases,
    rail: rail
      ? {
          w: Math.round(rr.width),
          h: Math.round(rr.height),
          row: getComputedStyle(rail).flexDirection === "row",
          overflowing: rail.scrollWidth > rail.clientWidth + 2,
          /* SCROLLABLE, not merely overflowing. `overflow: hidden` still lets
             `scrollLeft` be set from script, so a tail check that scrolls
             programmatically passes on a strip no finger could move — the same
             trap the tablet shell hit with `.app`. The computed value is the
             thing that decides whether a user can scroll it. */
          scrolls:
            rail.scrollWidth > rail.clientWidth + 2 &&
            ["auto", "scroll"].includes(getComputedStyle(rail).overflowX),
          items: rail.querySelectorAll('[role="option"], button').length,
        }
      : null,
  };
};

/** Scroll the rail to its end and see whether the last item lands inside. */
const RAIL_TAIL = () => {
  const d = document.querySelector('[role="dialog"]');
  const rail = d?.querySelector("[data-dialog-rail]");
  if (!rail) return null;
  rail.scrollLeft = rail.scrollWidth;
  const dr = d.getBoundingClientRect();
  const items = [...rail.querySelectorAll('[role="option"], button')];
  const last = items[items.length - 1];
  if (!last) return null;
  const r = last.getBoundingClientRect();
  const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
  return {
    inside: r.left >= dr.left - 1 && r.right <= dr.right + 1,
    reaches: el && (last === el || last.contains(el)) ? "the last item" : el ? el.tagName.toLowerCase() : "nothing",
    at: `${Math.round(r.left)}..${Math.round(r.right)} of ${Math.round(dr.right)}`,
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

  /* A fresh context per dialog: walking them in one session makes each answer
     depend on what the last one left behind — the lesson from the sheet rail,
     where a stuck dialog read as "Curves will not open on a short phone". */
  const openDialog = async ([w, h], touch, menu, item, label) => {
    const context = await browser.newContext({
      viewport: { width: w, height: h },
      hasTouch: touch,
      isMobile: touch,
    });
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
    await dismissStartCard(page);
    await page.keyboard.press("Control+Shift+N");
    await page.waitForTimeout(1000);
    /* Refine Edge is the one that needs something selected before it will open. */
    await page.keyboard.press("Control+a");
    await page.waitForTimeout(500);
    if (touch) {
      await page.evaluate(() =>
        [...document.querySelectorAll("header button")]
          .find((x) => /^Menu$/i.test(x.getAttribute("aria-label") || ""))
          ?.click(),
      );
      await page.waitForSelector('[data-menubar][data-sheet="true"]', { timeout: 6000 });
      await page.waitForTimeout(350);
    }
    await page.evaluate(
      (l) =>
        [...document.querySelectorAll("[data-menubar] > div > button")]
          .find((x) => x.textContent.trim() === l)
          ?.click(),
      menu,
    );
    await page.waitForTimeout(400);
    const row = page.locator('[data-menubar] [role="menu"] button', { hasText: item }).first();
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded().catch(() => {});
      await row.click().catch(() => {});
      await page.waitForTimeout(1400);
    }
    return { context, page };
  };

  // ================================================== the preview dialogs ==
  const previews = [];
  for (const [menu, item] of PREVIEWS) {
    const s = await openDialog(PHONE, true, menu, item, item);
    const m = await s.page.evaluate(READ);
    if (m) previews.push([item, m]);
    await s.context.close();
  }
  check("all four preview dialogs open on a phone", previews.length === PREVIEWS.length,
    `${previews.length} of ${PREVIEWS.length}: ${previews.map(([n]) => n).join(", ")}`);

  const pOut = previews.filter(([, m]) => m.slidersOut.length);
  check("every slider in them lies inside the dialog", pOut.length === 0,
    pOut.length
      ? pOut.map(([n, m]) => `${n}: ${m.slidersOut.length} out, worst +${Math.max(...m.slidersOut)}px`).join(" | ")
      : `${previews.reduce((a, [, m]) => a + m.sliders, 0)} sliders across four dialogs, was 294–354px past the edge`);

  const pPrim = previews.filter(([, m]) => m.primaryPast > 1 || m.reaches !== "itself");
  check("…and so does the button that applies them", pPrim.length === 0,
    pPrim.length
      ? pPrim.map(([n, m]) => `${n}: "${m.primary}" +${m.primaryPast}px, reaches ${m.reaches}`).join(" | ")
      : previews.map(([n, m]) => `${n.split(" ")[0]} "${m.primary}"`).join(", "));

  const pScroll = previews.filter(([, m]) => m.dialogScrollsX);
  check("…with no horizontal overflow anywhere", pScroll.length === 0,
    pScroll.length ? pScroll.map(([n]) => n).join(", ") : "none of the four scrolls sideways");

  /* Non-vacuity: there has to BE a preview, or the three checks above are about
     dialogs with nothing in them. */
  const canvases = previews.flatMap(([n, m]) => m.canvases.map((c) => [n, c]));
  check("every preview canvas is actually rendered and fits", canvases.length >= 4 &&
    canvases.every(([, c]) => c.past <= 1 && c.w > 100),
    canvases.length
      ? `${canvases.length} canvases, widest ${Math.max(...canvases.map(([, c]) => c.w))}px in a ${previews[0][1].dw}px dialog — the source is 500–560px`
      : "no canvas found");
  const squashed = canvases.filter(([, c]) => c.squashed);
  check("…without being squashed to fit", squashed.length === 0,
    squashed.length
      ? squashed.map(([n, c]) => `${n} ${c.w}×${c.h}`).join(", ")
      : "each keeps the aspect ratio of its backing store");

  // ========================================================= the side rails ==
  const rails = [];
  for (const [menu, item] of RAILS) {
    const s = await openDialog(PHONE, true, menu, item, item);
    const m = await s.page.evaluate(READ);
    const tail = await s.page.evaluate(RAIL_TAIL);
    if (m) rails.push([item, m, tail]);
    await s.context.close();
  }
  check("both strip-rail dialogs open on a phone", rails.length === RAILS.length,
    `${rails.length} of ${RAILS.length}`);

  const notStrips = rails.filter(([, m]) => !m.rail || !m.rail.row || m.rail.h > 120);
  check("each side rail becomes a strip along the top", notStrips.length === 0,
    notStrips.length
      ? notStrips.map(([n, m]) => `${n}: ${m.rail ? `${m.rail.w}×${m.rail.h} ${m.rail.row ? "row" : "column"}` : "no rail"}`).join(" | ")
      : rails.map(([n, m]) => `${n.split(" ")[0]} ${m.rail.w}×${m.rail.h}`).join(", ") + " — Layer Style's was 200×562");

  /* A strip that scrolls has items past its edge by definition; what matters is
     that the last one can be reached, not that none sticks out. */
  /* A strip whose contents overrun it MUST be scrollable, and scrolling it must
     bring the last item within reach. Both halves: overflowing-but-not-
     scrollable is exactly the broken state, and it reads as healthy to any
     check that only drives `scrollLeft`. */
  const unreachable = rails.filter(([, m, tail]) => {
    if (!m.rail) return true;
    if (!m.rail.overflowing) return false; // short enough to need no scrolling
    return !m.rail.scrolls || !tail || !tail.inside || tail.reaches !== "the last item";
  });
  check("…and scrolling one brings its last item within reach", unreachable.length === 0,
    unreachable.length
      ? unreachable
          .map(([n, m, t]) =>
            !m.rail
              ? `${n}: no rail`
              : !m.rail.scrolls
                ? `${n}: overflows by ${m.rail.w}px but cannot be scrolled`
                : `${n}: ${t ? `${t.at}, reaches ${t.reaches}` : "no tail"}`,
          )
          .join(" | ")
      : rails
          .filter(([, m]) => m.rail?.overflowing)
          .map(([n, , t]) => `${n.split(" ")[0]} ${t?.at}`)
          .join(", "));

  const railOut = rails.filter(([, m]) => m.slidersOut.length || m.primaryPast > 1 || m.dialogScrollsX);
  check("…while their sliders and buttons stay inside", railOut.length === 0,
    railOut.length
      ? railOut.map(([n, m]) => `${n}: ${m.slidersOut.length} sliders out, primary +${m.primaryPast}`).join(" | ")
      : `${rails.reduce((a, [, m]) => a + m.sliders, 0)} sliders, all inside`);

  // ============================== the item's own check, in its own words ==
  /* "…open Blur Gallery and Layer Style ▸ Drop Shadow and assert every slider
     track and the Apply button lie inside the dialog rect." */
  const ls = await openDialog(PHONE, true, "Layer", "Layer style", "drop shadow");
  const ds = ls.page.locator('[role="dialog"] [role="option"]', { hasText: /Drop shadow/i }).first();
  const found = await ds.count();
  if (found) {
    await ds.scrollIntoViewIfNeeded().catch(() => {});
    await ds.click().catch(() => {});
    await ls.page.waitForTimeout(900);
  }
  const dsm = await ls.page.evaluate(READ);
  check("Layer Style ▸ Drop Shadow can be selected at all", found > 0,
    found ? "found it in the strip" : "no Drop Shadow row");
  check("…and every slider and the primary button lie inside the dialog",
    !!dsm && dsm.slidersOut.length === 0 && dsm.primaryPast <= 1 && dsm.reaches === "itself" && dsm.sliders > 0,
    dsm ? `${dsm.sliders} sliders, ${dsm.slidersOut.length} out; "${dsm.primary}" reaches ${dsm.reaches}` : "no dialog");
  await ls.context.close();

  // ===================================================== desktop untouched ==
  const dBlur = await openDialog(DESKTOP, false, "Effects", "Blur gallery", "desktop blur");
  const dbm = await dBlur.page.evaluate(READ);
  check("a desktop keeps its big preview", !!dbm && dbm.canvases.some((c) => c.w >= 450),
    dbm ? `widest canvas ${Math.max(...dbm.canvases.map((c) => c.w), 0)}px` : "no dialog");
  await dBlur.context.close();

  const dLs = await openDialog(DESKTOP, false, "Layer", "Layer style", "desktop layer style");
  const dlm = await dLs.page.evaluate(READ);
  check("…and its rails as vertical columns", !!dlm && dlm.rail && !dlm.rail.row && dlm.rail.h > 200,
    dlm?.rail ? `${dlm.rail.w}×${dlm.rail.h}, ${dlm.rail.row ? "row" : "column"}` : "no rail");
  await dLs.context.close();

  // ===================== Preferences: an icon column, not a filmstrip =========
  /* Twelve sections. Laid down as a strip they cost a full 44px band across the
     sheet and showed FOUR at a time, with the other eight behind a sideways
     scroll — measured before this changed: a 390×44 strip whose contents ran to
     1,124px. Down the left as icons all twelve are on screen at once in 56px,
     and the pane keeps the remaining 334.

     Dropping the labels is what buys the width, so the heading above the pane is
     not decoration: the rail says where you can go, the heading says where you
     ARE. Both halves are checked, including that the heading follows the
     selection — a heading stuck on "Appearance" would be worse than none. */
  const prefs = await openDialog(PHONE, true, "Settings", "Preferences", "preferences");
  const READ_PREFS = () => {
    const d = document.querySelector('[role="dialog"][aria-label="Preferences"]');
    if (!d) return null;
    const rail = d.querySelector("[data-dialog-rail]");
    const head = d.querySelector("[data-pane-head]");
    if (!rail) return { noRail: true };
    const rr = rail.getBoundingClientRect();
    const items = [...rail.children].map((c) => {
      const r = c.getBoundingClientRect();
      return { y: Math.round(r.y), h: Math.round(r.height), w: Math.round(r.width), label: c.getAttribute("aria-label") };
    });
    const pane = head ? head.parentElement.getBoundingClientRect() : null;
    return {
      railW: Math.round(rr.width),
      /* A column, not a row: the second item sits BELOW the first. */
      column: items.length > 1 && items[1].y > items[0].y,
      total: items.length,
      /* On screen without scrolling — the whole point of the change. */
      onScreen: items.filter((i) => i.y >= rr.top - 1 && i.y + i.h <= rr.bottom + 1).length,
      /* Every one still a 44px target, labels or no labels. */
      undersized: items.filter((i) => i.h < 44).length,
      /* Labels hidden from the eye but not from the accessibility tree. */
      labelsHidden: [...rail.querySelectorAll("button > span")].every(
        (e) => getComputedStyle(e).display === "none",
      ),
      named: items.every((i) => !!i.label),
      head: head ? { text: head.innerText.trim(), shown: getComputedStyle(head).display !== "none" } : null,
      besidePane: pane ? pane.x >= rr.right - 1 : false,
      scrollsX: d.scrollWidth - d.clientWidth,
    };
  };
  const pr = await prefs.page.evaluate(READ_PREFS);

  check("Preferences puts its sections down the left as icons",
    pr && pr.column && pr.railW <= 72,
    pr ? `${pr.railW}px column of ${pr.total}` : "no dialog");
  check("…with every one of them on screen at once",
    pr && pr.onScreen === pr.total && pr.total >= 12,
    pr ? `${pr.onScreen} of ${pr.total} visible without scrolling` : "");
  check("…each still a 44px target once the words are gone",
    pr && pr.undersized === 0, `${pr?.undersized} under 44px`);
  check("…the words hidden from the eye, not from a screen reader",
    pr && pr.labelsHidden && pr.named,
    `labels hidden: ${pr?.labelsHidden}, every item still named: ${pr?.named}`);
  check("…and the pane sits beside the rail rather than under it",
    pr && pr.besidePane && pr.scrollsX <= 0,
    pr ? `pane starts at the rail's right edge, dialog scrollX ${pr.scrollsX}` : "");

  check("the open section is named in a heading above its settings",
    pr && pr.head && pr.head.shown && pr.head.text.length > 0,
    pr?.head ? `"${pr.head.text}"` : "no heading");

  /* …and follows the selection. */
  await prefs.page.locator("[data-dialog-rail] button").nth(10).click();
  await prefs.page.waitForTimeout(700);
  const after = await prefs.page.evaluate(READ_PREFS);
  check("…and it changes with the section you pick",
    after && after.head && after.head.text !== pr.head.text,
    `"${pr?.head?.text}" → "${after?.head?.text}"`);
  await prefs.context.close();

  /* Desktop keeps the labelled 168px rail and shows no heading, because the
     rail already names every section beside it. */
  const dPrefs = await openDialog(DESKTOP, false, "Settings", "Preferences", "desktop preferences");
  const dp = await dPrefs.page.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label="Preferences"]');
    const rail = d.querySelector("[data-dialog-rail]");
    const head = d.querySelector("[data-pane-head]");
    /* Null-safe on purpose: against markup without the label span this threw
       instead of failing, and a check that crashes tells you less than one that
       reports. */
    const span = rail && rail.querySelector("button > span");
    return {
      railW: rail ? Math.round(rail.getBoundingClientRect().width) : 0,
      labelled: span ? getComputedStyle(span).display !== "none" : false,
      headShown: head ? getComputedStyle(head).display !== "none" : false,
    };
  });
  check("…while a desktop keeps the labelled rail and needs no heading",
    dp.railW >= 160 && dp.labelled && dp.headShown === false,
    `${dp.railW}px rail, labels ${dp.labelled ? "shown" : "hidden"}, heading ${dp.headShown ? "shown" : "hidden"}`);
  await dPrefs.context.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
