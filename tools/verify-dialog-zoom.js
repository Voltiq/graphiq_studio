/* Dialogs at every interface scale.
 *
 * `Editor.module.scss` puts `zoom: var(--ui-zoom)` on every dialog overlay, so
 * the chrome scales without resampling the canvas. Inside a zoomed subtree a
 * viewport unit still resolves against the UNZOOMED viewport and the zoom then
 * multiplies the result — so `max-height: calc(100dvh - 64px)` at Large caps
 * the dialog at 1.25 × (100dvh − 64px) on screen. That is not a cap.
 *
 * The item names 390×844, where it does NOT reproduce: the phone's sheets are
 * sized by their inset and override the caps outright. The failure is on a
 * desktop. Measured at Large on a 1280×620 laptop, Export ran **111px below the
 * bottom of the screen** with its Export button returning nothing from
 * `elementFromPoint`, and Preferences 75px below with the same result; on a
 * 1400×700 desktop, 71px and 25px. A laptop at DEFAULT scale was already 27px
 * over, because the 22 dialogs behind `PasteDialog.module.scss` had no cap at
 * all. So this walks four viewports × four scales, and the phone is the case
 * that was never broken rather than the case that matters.
 *
 * Run: node tools/verify-dialog-zoom.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

/* Short viewports on purpose: a dialog only overflows a screen it is taller
   than, and a 1400×900 desktop hides the bug the way 390×844 does. */
const VIEWS = [
  ["phone", 390, 844, true],
  ["tablet", 768, 1024, true],
  ["desktop", 1400, 700, false],
  ["laptop", 1280, 620, false],
];
const SCALES = ["compact", "default", "comfortable", "large"];
/* Preferences is the tallest capped dialog; Export the tallest uncapped one. */
const DIALOGS = [
  ["Settings", "Preferences"],
  ["File", "Export as"],
];

const MEASURE = () => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return null;
  const r = d.getBoundingClientRect();
  const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  const vw = window.innerWidth;
  const foot = d.querySelector("footer");
  const primary = (foot ? [...foot.querySelectorAll("button")] : [...d.querySelectorAll("button")]).pop();
  const pr = primary?.getBoundingClientRect();
  let reaches = "none";
  if (pr && pr.width > 0) {
    const el = document.elementFromPoint(Math.round(pr.x + pr.width / 2), Math.round(pr.y + pr.height / 2));
    reaches = el && primary.contains(el) ? "itself" : el ? el.tagName.toLowerCase() : "nothing";
  }
  const middle = [...d.children].filter((c) => !["HEADER", "FOOTER"].includes(c.tagName));
  return {
    label: d.getAttribute("aria-label") ?? "?",
    uiscale: document.documentElement.dataset.uiscale ?? "(unset)",
    /* The zoom is on the OVERLAY, not the dialog — that is what makes the
       compounding easy to miss when reading the dialog's own computed style. */
    overlayZoom: d.parentElement ? getComputedStyle(d.parentElement).zoom : null,
    w: Math.round(r.width), h: Math.round(r.height),
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    right: Math.round(r.right), left: Math.round(r.left),
    vw, vh: Math.round(vh),
    belowScreen: Math.round(r.bottom - vh),
    aboveScreen: Math.round(-r.top),
    pastRight: Math.round(r.right - vw),
    primary: primary ? primary.textContent.trim().slice(0, 16) : null,
    reaches,
    /* Non-vacuity for the tall cases: something in the middle has to scroll, or
       "the footer is reachable" is a claim about a dialog that always fitted. */
    middleScrolls: middle.some((c) => c.scrollHeight > c.clientHeight + 2),
  };
};

const faultsOf = (m) => {
  const f = [];
  if (m.belowScreen > 1) f.push(`${m.belowScreen}px below the screen`);
  if (m.aboveScreen > 1) f.push(`${m.aboveScreen}px above it`);
  if (m.pastRight > 1) f.push(`${m.pastRight}px past the right edge`);
  if (m.reaches !== "itself") f.push(`"${m.primary}" reaches ${m.reaches}`);
  return f;
};

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  /* A fresh context per combination: the scale is a root attribute the whole
     shell reads, and a dialog left open would carry into the next reading. */
  const openAt = async ([w, h, touch], scale, menu, item, label) => {
    const context = await browser.newContext({
      viewport: { width: w, height: h },
      hasTouch: touch,
      isMobile: touch,
    });
    /* An init script runs BEFORE the document exists, so `documentElement` is
       null on the first pass — the first version threw a TypeError on every
       load, which the "no console errors" check caught and which would
       otherwise have been silent noise in someone else's failure. Set it when
       there is something to set it on, and again once the DOM is parsed. */
    await context.addInitScript((s) => {
      const set = () => {
        if (document.documentElement) document.documentElement.dataset.uiscale = s;
      };
      set();
      document.addEventListener("DOMContentLoaded", set);
    }, scale);
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
    /* Re-assert after hydration, in case the client rewrites the attribute. */
    await page.evaluate((s) => {
      document.documentElement.dataset.uiscale = s;
    }, scale);
    await dismissStartCard(page);
    await page.keyboard.press("Control+Shift+N");
    await page.waitForTimeout(1000);
    /* REAL clicks, not `element.click()` from inside the page. At Compact scale
       the programmatic version opened the Edit menu when asked for File — every
       time, only at that scale — and the walk reported "Export will not open at
       Compact on a phone", which a real click disproves at once. A locator
       click also waits for the thing to be actionable, which is what a finger
       does and what an `evaluate` cannot. */
    if (touch) {
      await page.locator('header button[aria-label="Menu"]').click();
      await page.waitForSelector('[data-menubar][data-sheet="true"]', { timeout: 6000 });
      await page.waitForTimeout(350);
    }
    /* Click the menu, then CHECK it is the one that opened, and try again if
       not. Clicking a menu name toggles rather than selects, so if anything
       already expanded one the first click closes that instead — this walk lost
       exactly one of thirty-two combinations to it, and the symptom was "Export
       will not open at Compact scale on a phone", which was never true. The
       same fix as `verify-dialog-sheets.js`, for the same reason. */
    const clickMenu = async () => {
      await page
        .locator("[data-menubar] > div > button", { hasText: new RegExp(`^${menu}$`) })
        .first()
        .click()
        .catch(() => {});
      await page.waitForTimeout(400);
      return page.evaluate(
        (l) =>
          [...document.querySelectorAll("[data-menubar] > div > button")].find(
            (x) => x.getAttribute("data-active") === "true",
          )?.textContent.trim() === l,
        menu,
      );
    };
    if (!(await clickMenu())) await clickMenu();
    const row = page.locator('[data-menubar] [role="menu"] button', { hasText: item }).first();
    if (await row.count()) {
      await row.scrollIntoViewIfNeeded().catch(() => {});
      await row.click().catch(() => {});
      await page.waitForTimeout(1200);
    }
    const m = await page.evaluate(MEASURE);
    await context.close();
    return m;
  };

  const seen = [];
  const missed = [];
  for (const [vname, w, h, touch] of VIEWS)
    for (const scale of SCALES)
      for (const [menu, item] of DIALOGS) {
        const m = await openAt([w, h, touch], scale, menu, item, `${vname}/${scale}/${item}`);
        if (m) seen.push([`${vname} · ${scale} · ${item}`, m]);
        else missed.push(`${vname} · ${scale} · ${item}`);
      }

  const total = VIEWS.length * SCALES.length * DIALOGS.length;
  check("every viewport and scale opens its dialogs", seen.length === total,
    missed.length ? `missing: ${missed.join(", ")}` : `${seen.length} of ${total} combinations`);

  /* The scale really is applied, or the whole walk is sixteen readings of the
     same thing. */
  const zoomed = seen.filter(([n, m]) => n.includes("large") && m.overlayZoom === "1.25");
  check("…with the interface scale actually in force",
    zoomed.length === VIEWS.length * DIALOGS.length,
    `${zoomed.length} of ${VIEWS.length * DIALOGS.length} Large readings report zoom 1.25`);

  const broken = seen.filter(([, m]) => faultsOf(m).length);
  check("no dialog leaves the screen at any scale", broken.length === 0,
    broken.length
      ? broken.slice(0, 5).map(([n, m]) => `${n}: ${faultsOf(m).join("; ")}`).join(" | ") +
        (broken.length > 5 ? ` (+${broken.length - 5} more)` : "")
      : `all ${seen.length} fit, primary reachable — Large on a laptop was 111px over`);

  /* The item's own words, kept as its own check even though the phone is the
     case that never failed: the contract is the contract. */
  const stated = seen.find(([n]) => n === "phone · large · Preferences");
  check("Preferences at Large on a phone ends inside the viewport",
    !!stated && stated[1].bottom <= stated[1].vh,
    stated ? `bottom ${stated[1].bottom} of ${stated[1].vh}` : "not measured");

  /* Non-vacuity: at least one combination must be tall enough that the cap
     bites, or "nothing leaves the screen" is a claim about small dialogs. */
  const scrolled = seen.filter(([, m]) => m.middleScrolls);
  check("…and the tall ones fit by scrolling, not by being small",
    scrolled.length >= 4,
    `${scrolled.length} of ${seen.length} scroll their contents: ` +
      scrolled.slice(0, 4).map(([n]) => n.replace(/ · /g, "/")).join(", "));

  /* A cap that is applied but never divided reads as "fits" on a tall screen
     and fails on a short one, so the axis has to be checked where it is tight:
     the widest dialog against the narrowest desktop-shell viewport. */
  const wide = seen.filter(([n]) => n.startsWith("tablet") && n.includes("Preferences"));
  check("the width cap is scaled too", wide.every(([, m]) => m.right <= m.vw + 1),
    wide.map(([n, m]) => `${n.split(" · ")[1]} ${m.w}px in ${m.vw}`).join(", "));

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
