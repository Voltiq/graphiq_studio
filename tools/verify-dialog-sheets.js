/* Dialogs on a phone.
 *
 * The mobile block never mentioned dialogs, so all 39 kept their desktop
 * metrics. Walked at 390×844, every one of the 44 a menu can open was narrower
 * than the screen — 358px of 390 — and the stylesheet behind 22 of them has no
 * `max-height` at all beside an `overflow: hidden`, so a tall dialog does not
 * scroll, it clips.
 *
 * At 390×844 that very nearly does not matter: Export is 816px tall and fits by
 * fourteen pixels. The failure is on a SHORT phone. At 375×667 the same dialog
 * is 816px in a 667px window: its header sits at top = -74, its footer 74px
 * past the fold, and `elementFromPoint` on the Export button returns
 * **nothing** — with no scroll to reach it, because the clipping IS the
 * overflow rule. A 300px keyboard on the tall phone does the same, 136px worse.
 *
 * So the walk runs at the item's 390×844 AND at 375×667, and the tall dialogs
 * run again with a keyboard up. A rail that only checked the stated viewport
 * would have passed the version of this code that cannot export at all on an
 * iPhone SE.
 *
 * Run: node tools/verify-dialog-sheets.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

const PHONE = [390, 844];
const SHORT = [375, 667]; // iPhone SE — where the clipping actually bites
const DESKTOP = [1400, 900];
const KB = 300;
/* The tall ones, for the keyboard pass: re-walking all 44 three times over is
   minutes of nothing, and a short dialog cannot demonstrate a clipped footer. */
const TALL = [
  ["File", "Export as"],
  ["File", "Merge to HDR"],
  ["File", "Batch process"],
  ["Settings", "Color management"],
  ["Image", "Adjust: curves"],
];

/** Geometry, plus whether the parts that matter can be reached. */
const MEASURE = () => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return null;
  const r = d.getBoundingClientRect();
  const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0;
  const visible = window.innerHeight - kb;
  const foot = d.querySelector("footer");
  /* The primary action is the last button in the footer, which is this
     codebase's convention; without a footer, the last button anywhere. */
  const primary = (foot ? [...foot.querySelectorAll("button")] : [...d.querySelectorAll("button")]).pop();
  const pr = primary?.getBoundingClientRect();
  let reaches = "none";
  if (pr && pr.width > 0) {
    const el = document.elementFromPoint(Math.round(pr.x + pr.width / 2), Math.round(pr.y + pr.height / 2));
    reaches = el && primary.contains(el) ? "itself" : el ? el.tagName.toLowerCase() : "nothing";
  }
  /* The scrolling middle: everything between the title bar and the actions. */
  const middle = [...d.children].filter((c) => !["HEADER", "FOOTER"].includes(c.tagName));
  return {
    label: d.getAttribute("aria-label") || d.querySelector("h2")?.textContent?.trim() || "?",
    w: Math.round(r.width), h: Math.round(r.height),
    top: Math.round(r.top), bottom: Math.round(r.bottom),
    vw: window.innerWidth, visible: Math.round(visible),
    hasHeader: !!d.querySelector(":scope > header"),
    hasFooter: !!foot,
    footBottom: foot ? Math.round(foot.getBoundingClientRect().bottom) : null,
    primary: primary ? primary.textContent.trim().slice(0, 20) : null,
    reaches,
    /* Does any middle region actually scroll, rather than the dialog clipping? */
    middleScrolls: middle.some((c) => c.scrollHeight > c.clientHeight + 2),
    middleOverflowY: middle.map((c) => getComputedStyle(c).overflowY),
  };
};

/** What is wrong with this dialog, in the item's own terms. */
const faultsOf = (m) => {
  const f = [];
  if (m.w !== m.vw) f.push(`width ${m.w} of ${m.vw}`);
  if (m.top < 0) f.push(`top ${m.top}`);
  if (m.bottom > m.visible) f.push(`bottom ${m.bottom} > ${m.visible}`);
  if (m.reaches !== "itself") f.push(`primary "${m.primary}" reaches ${m.reaches}`);
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

  const open = async ([w, h], touch, label) => {
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
    await page.waitForTimeout(1100);
    return { context, page };
  };

  const openSheet = async (page) => {
    if (await page.evaluate(() => !!document.querySelector('[data-menubar][data-sheet="true"]'))) return;
    await page.evaluate(() =>
      [...document.querySelectorAll("header button")]
        .find((x) => /^Menu$/i.test(x.getAttribute("aria-label") || ""))
        ?.click(),
    );
    await page.waitForSelector('[data-menubar][data-sheet="true"]', { timeout: 6000 });
    await page.waitForTimeout(300);
  };

  /** Open one menu row and measure whatever dialog it produced.
   *
   *  Deliberately starts from a CLOSED sheet every time. Walking 44 dialogs in
   *  a row leaves whatever menu the last one came from expanded, and clicking
   *  the next menu name toggles rather than selects — after Color management,
   *  asking for Image ▸ Adjust: curves found the Layer menu open and reported
   *  "Curves will not open on a short phone", which was a statement about this
   *  function and not about the app. The active menu is now asserted before the
   *  row is looked for. */
  const openDialog = async (page, menu, item, touch) => {
    if (touch) {
      await page.evaluate(() => {
        const nav = document.querySelector('[data-menubar][data-sheet="true"]');
        if (nav)
          [...document.querySelectorAll("header button")]
            .find((x) => /^Menu$/i.test(x.getAttribute("aria-label") || ""))
            ?.click();
      });
      await page.waitForTimeout(300);
      await openSheet(page);
    }
    const clickMenu = async () => {
      if (touch)
        await page.evaluate(
          (l) =>
            [...document.querySelectorAll("[data-menubar] > div > button")]
              .find((x) => x.textContent.trim() === l)
              ?.click(),
          menu,
        );
      else await page.locator("[data-menubar] > div > button", { hasText: menu }).first().click();
      await page.waitForTimeout(350);
      return page.evaluate(
        (l) =>
          [...document.querySelectorAll("[data-menubar] > div > button")].find(
            (x) => x.getAttribute("data-active") === "true",
          )?.textContent.trim() === l,
        menu,
      );
    };
    if (!(await clickMenu())) await clickMenu(); // it was open on something else
    const row = page.locator('[data-menubar] [role="menu"] button', { hasText: item }).first();
    if (!(await row.count())) return null;
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.click().catch(() => {});
    await page.waitForTimeout(900);
    return page.evaluate(MEASURE);
  };

  /* Close it and WAIT until it is gone. Firing Escape and moving on left the
     previous dialog standing often enough to lose one of the five tall ones —
     which then read as "Curves would not open on a short phone" rather than
     "Color management was still on screen". Some dialogs ignore Escape, so the
     Close button is the second attempt and the absence of a dialog is the
     condition, not a timeout. */
  const closeDialog = async (page) => {
    for (let i = 0; i < 4; i++) {
      if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"]')))) return true;
      if (i % 2 === 0) await page.keyboard.press("Escape");
      else
        await page.evaluate(() =>
          document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click(),
        );
      await page.waitForTimeout(450);
    }
    return !(await page.evaluate(() => !!document.querySelector('[role="dialog"]')));
  };

  /** Every dialog-opening row the menus offer. */
  const listRows = async (page) => {
    await openSheet(page);
    const menus = await page.evaluate(() =>
      [...document.querySelectorAll("[data-menubar] > div > button")]
        .filter((x) => !x.hasAttribute("data-sheet-search"))
        .map((x) => x.textContent.trim()),
    );
    const rows = [];
    for (const m of menus) {
      await openSheet(page);
      await page.evaluate(
        (l) =>
          [...document.querySelectorAll("[data-menubar] > div > button")]
            .find((x) => x.textContent.trim() === l)
            ?.click(),
        m,
      );
      await page.waitForTimeout(300);
      const items = await page.evaluate(() =>
        [...document.querySelectorAll('[data-menubar] [role="menu"] button')]
          .filter((x) => {
            const label = x.querySelector("span")?.textContent?.trim() ?? x.textContent.trim();
            return !x.disabled && /…\s*$/.test(label);
          })
          .map((x) => (x.querySelector("span")?.textContent?.trim() ?? x.textContent.trim())),
      );
      for (const it of items) rows.push([m, it.replace(/…$/, "")]);
      await page.evaluate(
        (l) =>
          [...document.querySelectorAll("[data-menubar] > div > button")]
            .find((x) => x.textContent.trim() === l)
            ?.click(),
        m,
      );
      await page.waitForTimeout(200);
    }
    return rows;
  };

  /** Walk them all and collect the ones that break the item's rules. */
  const stuck = [];
  const walk = async (page, rows) => {
    const seen = [];
    for (const [menu, item] of rows) {
      const m = await openDialog(page, menu, item, true);
      if (m) seen.push([`${menu} ▸ ${item}`, m]);
      if (!(await closeDialog(page))) stuck.push(`${menu} ▸ ${item}`);
    }
    return seen;
  };

  // ============================================= the item's stated viewport ==
  const tall = await open(PHONE, true, "390x844");
  const rows = await listRows(tall.page);
  check("the menus offer a serious number of dialogs to check", rows.length >= 40,
    `${rows.length} dialog-opening rows`);

  const seen = await walk(tall.page, rows);
  check("…and every one of them opens", seen.length >= 40,
    `${seen.length} of ${rows.length} produced a dialog`);

  const broken = seen.filter(([, m]) => faultsOf(m).length);
  check("every dialog is a full-screen sheet at 390×844", broken.length === 0,
    broken.length
      ? broken.slice(0, 4).map(([n, m]) => `${n}: ${faultsOf(m).join("; ")}`).join(" | ") +
        (broken.length > 4 ? ` (+${broken.length - 4} more)` : "")
      : `all ${seen.length}, each ${seen[0][1].vw}px wide from top 0`);

  const noBars = seen.filter(([, m]) => !m.hasHeader);
  check("…each with the title bar the rule is scoped on", noBars.length === 0,
    noBars.length ? noBars.map(([n]) => n).join(", ") : `all ${seen.length} have a <header>`);

  /* The half that matters: the footer holds Apply and Cancel, and clipping it
     is what made Export unusable. It must be pinned INSIDE the sheet. */
  const footersOut = seen.filter(([, m]) => m.hasFooter && m.footBottom > m.visible);
  check("…and every footer inside the visible area", footersOut.length === 0,
    footersOut.length
      ? footersOut.map(([n, m]) => `${n}: ${m.footBottom} > ${m.visible}`).join(", ")
      : `${seen.filter(([, m]) => m.hasFooter).length} dialogs with a footer, none past the fold`);
  await tall.context.close();

  // ====================================== the short phone, where it bit ==
  /* A FRESH context per dialog. Walking them in one session made each result
     depend on what the previous dialog left behind — after Color management,
     asking for Curves found a different menu expanded and reported "Curves will
     not open on a short phone", which was a fact about the harness. Five loads
     is a cheap price for five independent answers. */
  const shortSeen = [];
  for (const [menu, item] of TALL) {
    const s = await open(SHORT, true, `375x667 ${item}`);
    const m = await openDialog(s.page, menu, item, true);
    if (m) shortSeen.push([`${menu} ▸ ${item}`, m]);
    await s.context.close();
  }
  check("the tall dialogs open on a short phone too", shortSeen.length === TALL.length,
    `${shortSeen.length} of ${TALL.length}: got [${shortSeen.map(([n]) => n).join(", ")}]`);
  const shortBroken = shortSeen.filter(([, m]) => faultsOf(m).length);
  check("…and fit it", shortBroken.length === 0,
    shortBroken.length
      ? shortBroken.map(([n, m]) => `${n}: ${faultsOf(m).join("; ")}`).join(" | ")
      : `at 375×667, where Export used to sit at top=-74 with its button off the fold`);
  /* Non-vacuity: at least one of them must be long enough to need scrolling,
     or "the footer is reachable" is a claim about dialogs that always fit. */
  const scrollers = shortSeen.filter(([, m]) => m.middleScrolls);
  check("…by SCROLLING their contents, not by shrinking them", scrollers.length > 0,
    scrollers.length
      ? `${scrollers.length} of ${shortSeen.length} scroll internally: ${scrollers.map(([n]) => n.split(" ▸ ")[1]).join(", ")}`
      : "nothing scrolled — the check proves nothing");
  // ================================================ …and with a keyboard up ==
  const kbSeen = [];
  for (const [menu, item] of TALL) {
    const k = await open(PHONE, true, `keyboard ${item}`);
    const m0 = await openDialog(k.page, menu, item, true);
    if (m0) {
      await k.page.evaluate(
        (px) => document.documentElement.style.setProperty("--kb-inset", `${px}px`),
        KB,
      );
      await k.page.waitForTimeout(500);
      kbSeen.push([`${menu} ▸ ${item}`, await k.page.evaluate(MEASURE)]);
    }
    await k.context.close();
  }
  const kbBroken = kbSeen.filter(([, m]) => faultsOf(m).length);
  check(`all ${TALL.length} tall dialogs open under a ${KB}px keyboard`, kbSeen.length === TALL.length,
    `${kbSeen.length} of ${TALL.length}`);
  check(`a ${KB}px keyboard leaves every one of them usable`, kbBroken.length === 0,
    kbBroken.length
      ? kbBroken.map(([n, m]) => `${n}: ${faultsOf(m).join("; ")}`).join(" | ")
      : `${kbSeen.length} tall dialogs end at ${kbSeen[0]?.[1].bottom}, above the keyboard line`);
  // ============================ what is NOT a dialog stays what it was ==
  /* `:has(> header)` is the scope. The command palette, the colour popover and
     the onboarding tour all wear `role="dialog"` and have no title bar, so none
     of them should be wearing a sheet. */
  const other = await open(PHONE, true, "not-dialogs");
  await other.page.locator('button[aria-label="Open the command palette"]').click();
  await other.page.waitForTimeout(700);
  const pal = await other.page.evaluate(() => {
    const d = document.querySelector('[role="dialog"][aria-label="Command palette"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    return { w: Math.round(r.width), top: Math.round(r.top), vw: window.innerWidth,
             hasHeader: !!d.querySelector(":scope > header") };
  });
  check("the command palette is not dressed as a dialog sheet",
    !!pal && !pal.hasHeader && (pal.w < pal.vw || pal.top > 0),
    pal ? `${pal.w}px of ${pal.vw} at top ${pal.top}, header: ${pal.hasHeader}` : "palette not found");
  await other.context.close();

  // ===================================================== desktop untouched ==
  const desk = await open(DESKTOP, false, "desktop");
  const deskSeen = [];
  for (const [menu, item] of [["File", "Export as"], ["Settings", "Preferences"], ["Select", "Feather"]]) {
    const m = await openDialog(desk.page, menu, item, false);
    if (m) deskSeen.push([`${menu} ▸ ${item}`, m]);
    await closeDialog(desk.page);
  }
  const fullBleed = deskSeen.filter(([, m]) => m.w === m.vw || m.top === 0);
  check("a desktop keeps its centred, self-sized dialogs", fullBleed.length === 0,
    fullBleed.length
      ? fullBleed.map(([n, m]) => `${n}: ${m.w}×${m.h} at top ${m.top}`).join(", ")
      : deskSeen.map(([n, m]) => `${n.split(" ▸ ")[1]} ${m.w}×${m.h}`).join(", "));
  await desk.context.close();

  check("every dialog can be dismissed again", stuck.length === 0,
    stuck.length ? `still on screen after Escape and Close: ${stuck.join(", ")}` : "all of them closed");

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
