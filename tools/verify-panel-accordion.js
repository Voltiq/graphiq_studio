/* Finding a panel on a phone.
 *
 * The bottom sheet fixed the axis — a panel and the picture now share the
 * screen. It did nothing for the stack inside it, and measuring that is what
 * settled this item: with the desktop defaults (five panels open, Adjustments
 * alone 1804px tall) the sheet held **4086px** of content, the LAYERS header
 * sat **3488px** down it, and only four of sixteen panels could be reached
 * without scrolling — at any of the three heights.
 *
 * So the question the item posed — should the sheet open at a height that
 * suits the panel? — was aimed at the wrong thing. A per-panel height does
 * nothing for someone who cannot find the panel.
 *
 * One panel open at a time answers both. The stack becomes fifteen headers
 * plus whatever is open, everything is a tap away, and "the height that suits
 * the panel" falls out of it: the sheet grows to fit what was just opened.
 *
 * It grows and never shrinks, deliberately. Someone who made the sheet tall
 * meant it, and having it collapse because they glanced at Info would be the
 * kind of help nobody asks for twice.
 *
 * Run: node tools/verify-panel-accordion.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, setSheetDetent, urlArg } = require("./lib/launch");

const SURVEY = () => {
  const dock = document.querySelector('[data-tour="dock"]');
  const scroller = [...dock.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 40) ?? dock;
  const sections = [...dock.querySelectorAll("[data-panel-id]")];
  const top = dock.getBoundingClientRect().top;
  return {
    detent: document.documentElement.dataset.sheet ?? "(none)",
    sheetH: Math.round(dock.getBoundingClientRect().height),
    content: scroller.scrollHeight,
    client: scroller.clientHeight,
    panels: sections.length,
    open: sections.filter((s) => s.getAttribute("data-open") === "true").length,
    openIds: sections
      .filter((s) => s.getAttribute("data-open") === "true")
      .map((s) => s.getAttribute("data-panel-id")),
    /* Headers you could tap without scrolling at all. */
    reachable: sections.filter((s) => {
      const r = s.getBoundingClientRect();
      return r.top >= top - 1 && r.top < top + scroller.clientHeight;
    }).length,
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

  const open = async (viewport, touch, label) => {
    const context = await browser.newContext({ viewport, hasTouch: touch });
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
    await page.keyboard.press("Control+Shift+N");
    await page.waitForTimeout(1200);
    return { context, page };
  };

  // ==================================================================== phone
  const phone = await open({ width: 390, height: 844 }, true, "phone");
  const page = phone.page;
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
  await page.waitForTimeout(900);
  await setSheetDetent(page, "full");

  const start = await page.evaluate(SURVEY);
  check("the sheet starts with nothing expanded",
    start.open === 0, `${start.open} of ${start.panels} panels open`);
  check("…so every panel is a tap away, with no scrolling",
    start.reachable === start.panels,
    `${start.reachable} of ${start.panels} headers reachable at full height`);
  check("…and the stack fits the sheet",
    start.content <= start.client + 1,
    `${start.content}px of content in a ${start.client}px sheet (it was 4086px)`);

  /* The measurement that decided the item: Layers, the panel people reach for
     most, used to be 3488px down. */
  const layers = await page.evaluate(() => {
    const dock = document.querySelector('[data-tour="dock"]');
    const sec = document.querySelector('[data-panel-id="layers"]');
    if (!sec) return null;
    return Math.round(sec.getBoundingClientRect().top - dock.getBoundingClientRect().top);
  });
  check("Layers is on screen rather than 3488px down the stack",
    layers !== null && layers < 692, `its header sits ${layers}px below the sheet's top`);

  // ------------------------------------------------------------- accordion --
  const tapPanel = async (id) => {
    await page.locator(`[data-panel-id="${id}"] button[class*="panelCaret"]`).click();
    await page.waitForTimeout(700);
  };
  await tapPanel("layers");
  const withLayers = await page.evaluate(SURVEY);
  check("tapping a panel opens it", withLayers.openIds.join() === "layers",
    `open: ${withLayers.openIds.join(", ") || "none"}`);
  await tapPanel("info");
  const withInfo = await page.evaluate(SURVEY);
  check("…and opening another closes the first",
    withInfo.openIds.join() === "info", `open: ${withInfo.openIds.join(", ") || "none"}`);
  await tapPanel("info");
  check("…and tapping the open one closes it",
    (await page.evaluate(SURVEY)).open === 0);

  // --------------------------------------------------- the height that fits --
  await setSheetDetent(page, "peek");
  const atPeek = await page.evaluate(SURVEY);
  check("back at peek to test the growing", atPeek.detent === "peek", `data-sheet="${atPeek.detent}"`);
  await tapPanel("adjustments"); // the tall one: 1804px on its own
  await page.waitForTimeout(900);
  const grown = await page.evaluate(SURVEY);
  check("opening a tall panel raises the sheet to fit it",
    grown.sheetH > atPeek.sheetH,
    `${atPeek.sheetH}px at ${atPeek.detent} → ${grown.sheetH}px at ${grown.detent}`);

  await setSheetDetent(page, "full");
  const atFull = await page.evaluate(SURVEY);
  await tapPanel("info"); // a short one
  await page.waitForTimeout(900);
  const afterShort = await page.evaluate(SURVEY);
  check("…but opening a short one never shrinks it under you",
    afterShort.sheetH >= atFull.sheetH,
    `${atFull.sheetH}px at ${atFull.detent} → ${afterShort.sheetH}px at ${afterShort.detent}`);

  /* And the panel still works — an accordion that renders nothing usable would
     satisfy every count above. */
  await tapPanel("layers");
  const layersWorks = await page.evaluate(() => {
    const rows = document.querySelectorAll('[data-panel-id="layers"] [data-layer-id]');
    return rows.length;
  });
  check("the panel that is open actually shows its contents",
    layersWorks >= 1, `${layersWorks} layer row(s) in the open Layers panel`);
  await phone.context.close();

  // ================================================================== desktop
  const desk = await open({ width: 1400, height: 900 }, false, "desktop");
  const deskState = await desk.page.evaluate(SURVEY);
  check("desktop still opens several panels at once",
    deskState.open >= 4, `${deskState.open} of ${deskState.panels} open: ${deskState.openIds.join(", ")}`);
  await desk.page.locator('[data-panel-id="channels"] button[class*="panelCaret"]').click();
  await desk.page.waitForTimeout(600);
  const deskAfter = await desk.page.evaluate(SURVEY);
  check("…and opening one more does not close the others",
    deskAfter.open === deskState.open + 1,
    `${deskState.open} → ${deskAfter.open} open`);
  await desk.context.close();

  // ------------------------------- the phone must not flatten the desktop --
  /* In ONE context, resized. A fresh desktop context could never see what a
     phone wrote to localStorage, so the first version of this check passed
     with the accordion deliberately writing itself over the saved layout —
     it was asserting the desktop's own defaults back to itself. */
  const both = await open({ width: 390, height: 844 }, true, "resize");
  await both.page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
  await both.page.waitForTimeout(900);
  await setSheetDetent(both.page, "full");
  for (const id of ["layers", "info", "channels"]) {
    await both.page.locator(`[data-panel-id="${id}"] button[class*="panelCaret"]`).click();
    await both.page.waitForTimeout(500);
  }
  const phoneOpen = (await both.page.evaluate(SURVEY)).open;
  check("the phone still has one panel open after all that", phoneOpen === 1, `${phoneOpen} open`);

  await both.page.setViewportSize({ width: 1400, height: 900 });
  await both.page.waitForTimeout(1500);
  const resized = await both.page.evaluate(SURVEY);
  check("…and resizing up finds the desktop layout intact, not flattened to one",
    resized.open >= 4,
    `${resized.open} of ${resized.panels} open after the resize: ${resized.openIds.join(", ")}`);
  await both.context.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
