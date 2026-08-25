/* Which keyboard opens, and whether it opens at all.
 *
 * Three separate faults, measured across ten dialogs on a phone:
 *
 *   AUTO-FOCUS — `preferredInitialFocus` lands on the first text field, so
 *   **6 of 10** dialogs opened with the software keyboard already covering
 *   them. Six more put `autoFocus` on their own input and never reached that
 *   function at all, and Canvas Size calls `select()` on a 30ms timeout, which
 *   focuses the field again after anything central has decided otherwise.
 *
 *   THE WRONG KEYBOARD — `NumberField` renders an input with no `type` and no
 *   `inputMode`, so a field that only ever takes digits offered QWERTY: New
 *   guide's position, and every numeric option in the options bar.
 *
 *   THE PAGE ZOOMING — Safari on iOS zooms when a field under 16px takes
 *   focus, and this app can never zoom back, because the viewport is
 *   `user-scalable=no` so the canvas can own the pinch. **7 of 10** dialogs had
 *   fields at 12–14px.
 *
 * A name field offering QWERTY is CORRECT — a document name is text. So the
 * numeric check asks which fields ARE numeric rather than inferring it: the
 * first version read the `numBox` WRAPPER, and New document puts its Name field
 * in one for the layout, so it reported a text field for offering the text
 * keyboard. `NumberField` now says `data-numeric` out loud.
 *
 * Run: node tools/verify-keyboard-fields.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg, withOptionsSheet } = require("./lib/launch");

const PHONE = [390, 844];
const DESKTOP = [1400, 900];
/* Ten dialogs with fields in them, spread across the menus. */
const DIALOGS = [
  ["File", "New"],
  ["File", "Export as"],
  ["File", "Save as"],
  ["File", "Export PDF"],
  ["Image", "Image size"],
  ["Image", "Canvas size"],
  ["Select", "Feather"],
  ["Layer", "New fill: solid color"],
  ["View", "New guide"],
  ["Settings", "Preferences"],
];

/** Is this the sort of thing a software keyboard opens for? */
const TYPEABLE = `input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="file"]), textarea`;

const READ = (typeable) => {
  const d = document.querySelector('[role="dialog"]');
  if (!d) return null;
  const a = document.activeElement;
  const fields = [...d.querySelectorAll(typeable)];
  return {
    label: d.getAttribute("aria-label") ?? "?",
    fieldCount: fields.length,
    /* The item's own words: `document.activeElement` is off the text input. */
    focusedAField: !!(a && fields.includes(a)),
    activeTag: a ? a.tagName.toLowerCase() : null,
    /* Anything under 16px is what makes iOS zoom. */
    small: fields
      .map((e) => ({ px: Math.round(parseFloat(getComputedStyle(e).fontSize)) }))
      .filter((f) => f.px < 16)
      .map((f) => f.px),
    fonts: [...new Set(fields.map((e) => Math.round(parseFloat(getComputedStyle(e).fontSize))))],
    /* Fields that take a NUMBER: `type="number"`, or `NumberField`, which says
       so with `data-numeric`. Reading the `numBox` WRAPPER instead was wrong —
       New document puts its Name field in one for the layout, so the check
       called a text field numeric and complained that it offered QWERTY, which
       for a document name is the right keyboard. */
    numeric: [...d.querySelectorAll('input[type="number"], input[data-numeric]')].map((e) => ({
      type: (e.getAttribute("type") || "text").toLowerCase(),
      mode: (e.getAttribute("inputmode") || "").toLowerCase(),
    })),
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

  const boot = async ([w, h], touch, label) => {
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

  const openDialog = async (page, menu, item, touch) => {
    if (touch) {
      await page.evaluate(() => {
        if (document.querySelector('[data-menubar][data-sheet="true"]'))
          document.querySelector('header button[aria-label="Menu"]')?.click();
      });
      await page.waitForTimeout(250);
      await page.locator('header button[aria-label="Menu"]').click();
      await page.waitForSelector('[data-menubar][data-sheet="true"]', { timeout: 6000 });
      await page.waitForTimeout(300);
    }
    await page
      .locator("[data-menubar] > div > button", { hasText: new RegExp(`^${menu}$`) })
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(400);
    const row = page.locator('[data-menubar] [role="menu"] button', { hasText: item }).first();
    if (!(await row.count())) return null;
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.click().catch(() => {});
    /* Long enough for a dialog that focuses itself on a timeout to have done
       so — Canvas Size uses 30ms, and a check that reads sooner would find the
       central decision still standing and pass on a dialog that then grabs
       focus back. */
    await page.waitForTimeout(1200);
    const m = await page.evaluate(READ, TYPEABLE);
    for (let i = 0; i < 4; i++) {
      if (!(await page.evaluate(() => !!document.querySelector('[role="dialog"]')))) break;
      if (i % 2 === 0) await page.keyboard.press("Escape");
      else
        await page.evaluate(() =>
          document.querySelector('[role="dialog"] button[aria-label="Close"]')?.click(),
        );
      await page.waitForTimeout(400);
    }
    return m;
  };

  // ================================================================ phone ==
  const { context, page } = await boot(PHONE, true, "phone");
  const seen = [];
  for (const [menu, item] of DIALOGS) {
    const m = await openDialog(page, menu, item, true);
    if (m) seen.push([item, m]);
  }
  check("the dialogs open on a phone", seen.length >= 8,
    `${seen.length} of ${DIALOGS.length}: ${seen.map(([n]) => n).join(", ")}`);

  const withFields = seen.filter(([, m]) => m.fieldCount > 0);
  check("…and enough of them have fields for this to mean anything",
    withFields.length >= 6, `${withFields.length} of ${seen.length} contain a typeable field`);

  const grabbed = seen.filter(([, m]) => m.focusedAField);
  check("no dialog opens with the keyboard already up", grabbed.length === 0,
    grabbed.length
      ? grabbed.map(([n, m]) => `${n} focused a <${m.activeTag}>`).join(", ")
      : `${seen.length} dialogs, none landing on a field — it was 6 of 10`);

  const smallOnes = seen.filter(([, m]) => m.small.length);
  check("no typeable field is under 16px, which is what makes iOS zoom",
    smallOnes.length === 0,
    smallOnes.length
      ? smallOnes.map(([n, m]) => `${n}: ${[...new Set(m.small)].join(",")}px`).join(" | ")
      : `smallest is ${Math.min(...withFields.flatMap(([, m]) => m.fonts))}px — seven dialogs had 12–14px`);

  const nums = seen.flatMap(([n, m]) => m.numeric.map((f) => [n, f]));
  const qwerty = nums.filter(([, f]) => f.type !== "number" && !["numeric", "decimal"].includes(f.mode));
  check("every numeric field asks for a numeric keyboard", qwerty.length === 0,
    qwerty.length
      ? qwerty.map(([n, f]) => `${n}: type=${f.type} inputmode=${f.mode || "(none)"}`).join(", ")
      : `${nums.length} numeric fields, all type=number or inputmode numeric/decimal`);

  /* The options bar is the other home of NumberField. The TEXT tool is where
     they are — Size, Tracking, Baseline — so the tool is selected first; with
     the default brush the sheet has none and the check passed on an empty list,
     which is the failure mode this comment exists to prevent. */
  await page.keyboard.press("t");
  await page.waitForTimeout(700);
  const barNums = await withOptionsSheet(page, async () =>
    page.evaluate(() =>
      [...document.querySelectorAll('input[type="number"], input[data-numeric]')].map((e) => ({
        type: (e.getAttribute("type") || "text").toLowerCase(),
        mode: (e.getAttribute("inputmode") || "").toLowerCase(),
        px: Math.round(parseFloat(getComputedStyle(e).fontSize)),
      })),
    ),
  );
  const barBad = (barNums ?? []).filter(
    (f) => f.type !== "number" && !["numeric", "decimal"].includes(f.mode),
  );
  check("…including the ones in the tool options",
    !!barNums && barNums.length >= 3 && barBad.length === 0,
    !barNums || !barNums.length
      ? "no numeric options found — the check would have proved nothing"
      : barBad.length
        ? barBad.map((f) => `type=${f.type} inputmode=${f.mode || "(none)"}`).join(", ")
        : `${barNums.length} numeric options on the Text tool, all covered`);
  await context.close();

  // ============================================================== desktop ==
  /* Non-vacuity for the whole item: a mouse should still land on the text
     field, because there "you can type straight away" costs nothing. And the
     16px floor must be touch-only — it exists to stop iOS zooming, not to
     restyle a desktop. */
  const desk = await boot(DESKTOP, false, "desktop");
  const deskSeen = [];
  for (const [menu, item] of [["File", "Save as"], ["File", "Export as"], ["Image", "Canvas size"]]) {
    const m = await openDialog(desk.page, menu, item, false);
    if (m) deskSeen.push([item, m]);
  }
  const deskFocus = deskSeen.filter(([, m]) => m.focusedAField);
  check("a desktop still lands on the text field", deskFocus.length === deskSeen.length,
    `${deskFocus.length} of ${deskSeen.length}: ${deskSeen.map(([n, m]) => `${n} → ${m.activeTag}`).join(", ")}`);
  const deskSmall = deskSeen.filter(([, m]) => m.small.length);
  check("…and keeps its smaller fields, so the floor is touch-only",
    deskSmall.length > 0,
    deskSmall.length
      ? `${deskSmall.map(([n, m]) => `${n} ${[...new Set(m.small)].join(",")}px`).join(", ")}`
      : "every desktop field is ≥16px — the floor is not touch-scoped");
  await desk.context.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
