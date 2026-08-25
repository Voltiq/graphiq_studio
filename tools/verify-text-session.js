/* Finishing and abandoning a text session on a phone.
 *
 * The item said the Text tool's only exits were keyboard-only. That was true
 * when it was written and is not now: the ✓/✕ pair from the touch-commit work
 * already covers a text session, with 52×52 buttons. What was still broken is
 * narrower and only shows with a keyboard up — which, for TEXT, is always:
 *
 *   the pair sat at `--chrome-bottom` and so **232px behind a 300px
 *   keyboard**, i.e. Done and Cancel unreachable at exactly the moment they
 *   are the way out;
 *
 *   and the caret went behind it too — tapping low in the artwork and typing
 *   six lines put it **61px past the keyboard line**, so the line being typed
 *   could not be seen.
 *
 * A harness cannot summon a keyboard (see verify-keyboard.js), so `--kb-inset`
 * is written by hand for the CSS half and `__gqKeepCaretVisible` is called for
 * the panning half. What would call it is checked separately: the listeners are
 * bound only while a session is live, so the hook's presence and absence are
 * both asserted.
 *
 * Run: node tools/verify-text-session.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg, withPanel } = require("./lib/launch");

const PHONE = [390, 844];
const DESKTOP = [1400, 900];
const KB = 300;

const STATE = () => {
  const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0;
  const visible = window.innerHeight - kb;
  const pair = document.querySelector(".gq-m-commit");
  const pr = pair?.getBoundingClientRect();
  const buttons = pair
    ? [...pair.querySelectorAll("button")].map((b) => {
        const r = b.getBoundingClientRect();
        const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
        return {
          label: b.getAttribute("aria-label") ?? b.textContent.trim(),
          w: Math.round(r.width),
          h: Math.round(r.height),
          reaches: el && (b === el || b.contains(el)) ? "itself" : el ? el.tagName.toLowerCase() : "nothing",
        };
      })
    : [];
  const sel = window.getSelection();
  let caret = null;
  if (sel && sel.rangeCount) {
    const rr = sel.getRangeAt(0).getBoundingClientRect();
    if (rr.width || rr.height) caret = Math.round(rr.bottom);
  }
  return {
    live: document.documentElement.dataset.commit === "1",
    editing: !!document.querySelector('[contenteditable="true"]'),
    pairOnScreen: pr ? pr.width > 0 && pr.height > 0 : false,
    pairBottom: pr ? Math.round(pr.bottom) : null,
    pairBehind: pr ? Math.round(pr.bottom - visible) : null,
    buttons,
    caret,
    caretBehind: caret === null ? null : Math.round(caret - visible),
    hasCaretHook: typeof window.__gqKeepCaretVisible === "function",
    kb,
    visible: Math.round(visible),
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

  /** How many rows the Layers panel lists — the observable for "it committed". */
  const layerCount = (page) =>
    withPanel(page, "layers", async () =>
      page.evaluate(
        () =>
          document.querySelectorAll('[data-panel-id="layers"] [class*="layerRow"], [data-panel-id="layers"] li')
            .length,
      ),
    );

  /** Start a session low in the artwork and type `lines` of text. */
  const startText = async (page, lines) => {
    await page.keyboard.press("t");
    await page.waitForTimeout(600);
    const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await page.mouse.click(
      Math.round(box.x + box.width * 0.3),
      Math.round(box.y + box.height * 0.92),
    );
    await page.waitForTimeout(900);
    for (let i = 0; i < lines; i++) {
      await page.keyboard.type(`line ${i}`);
      await page.keyboard.press("Enter");
    }
    await page.keyboard.type("last");
    await page.waitForTimeout(600);
  };

  // ============================================================ the phone ==
  const { context, page } = await open(PHONE, true, "phone");
  const before = await layerCount(page);

  await startText(page, 5);
  const typing = await page.evaluate(STATE);
  check("a text session is live and editable", typing.live && typing.editing,
    `data-commit=${typing.live}, contenteditable present: ${typing.editing}`);
  check("…and the finish/cancel pair is on screen", typing.pairOnScreen,
    typing.buttons.map((b) => `${b.label} ${b.w}×${b.h}`).join(", ") || "no pair");
  check("…with both buttons big enough to tap and actually reachable",
    typing.buttons.length === 2 &&
      typing.buttons.every((b) => b.w >= 44 && b.h >= 44 && b.reaches === "itself"),
    typing.buttons.map((b) => `${b.label} ${b.w}×${b.h} reaches ${b.reaches}`).join(", "));
  check("…and the panning hook is bound while the session runs", typing.hasCaretHook,
    typing.hasCaretHook ? "__gqKeepCaretVisible present" : "missing");

  // ------------------------------------------------- now raise the keyboard
  await page.evaluate((px) => document.documentElement.style.setProperty("--kb-inset", `${px}px`), KB);
  await page.waitForTimeout(600);
  const kbUp = await page.evaluate(STATE);
  check(`with a ${KB}px keyboard the pair stays above it`, kbUp.pairBehind <= 0,
    `pair ends at ${kbUp.pairBottom}, visible area at ${kbUp.visible} — it used to sit at ${typing.pairBottom}, i.e. ${typing.pairBottom - kbUp.visible}px behind`);
  check("…and its buttons are still reachable there",
    kbUp.buttons.every((b) => b.reaches === "itself"),
    kbUp.buttons.map((b) => `${b.label} reaches ${b.reaches}`).join(", "));

  /* Non-vacuity: the caret must START behind the keyboard, or bringing it back
     is a claim about a caret that was never hidden. */
  check("the caret begins behind the keyboard", kbUp.caretBehind > 0,
    `${kbUp.caretBehind}px past the keyboard line`);

  await page.evaluate(() => window.__gqKeepCaretVisible?.());
  await page.waitForTimeout(600);
  const panned = await page.evaluate(STATE);
  check("…and panning the view brings it back", panned.caretBehind < 0,
    `caret at ${panned.caret}, visible area at ${panned.visible} — it was at ${kbUp.caret}`);

  /* By the MINIMUM needed. Asking "did a second call move anything?" does not
     test that: by then the view is panned as far as the clamp allows, so an
     implementation that over-pans by a fixed amount is clamped to zero and
     looks well behaved — a mutation adding 40px to every delta survived exactly
     that check. Where it shows is the resting place: the caret should come to
     rest just above the line, not be flung up the screen. */
  check("…landing just above the line rather than being flung up it",
    panned.caretBehind >= -40,
    `caret rests ${-panned.caretBehind}px above the keyboard line (the margin is 12)`);

  const idle = await page.evaluate(() => {
    const sel = window.getSelection();
    const before = sel.getRangeAt(0).getBoundingClientRect().bottom;
    window.__gqKeepCaretVisible?.();
    return Math.round(sel.getRangeAt(0).getBoundingClientRect().bottom - before);
  });
  check("…and a caret already in view is left where it is", idle === 0,
    `${idle}px on a second call`);

  // --------------------------------------------------------- Done commits
  await page.evaluate(() => document.documentElement.style.removeProperty("--kb-inset"));
  await page.waitForTimeout(300);
  await page.locator('.gq-m-commit button[aria-label="Commit"]').click();
  await page.waitForTimeout(1200);
  const after = await page.evaluate(STATE);
  check("Done ends the session", !after.live && !after.editing,
    `data-commit=${after.live}, still editing: ${after.editing}`);
  const committed = await layerCount(page);
  check("…and commits the text as a layer", committed > before,
    `${before} layers before, ${committed} after`);

  // -------------------------------------------------------- Cancel abandons
  await startText(page, 2);
  const live2 = await page.evaluate(STATE);
  check("a second session starts", live2.live && live2.editing, "");
  await page.locator('.gq-m-commit button[aria-label="Cancel"]').click();
  await page.waitForTimeout(1200);
  const after2 = await page.evaluate(STATE);
  check("Cancel ends the session too", !after2.live && !after2.editing, "");
  const cancelled = await layerCount(page);
  check("…and leaves no layer behind", cancelled === committed,
    `${committed} layers before cancelling, ${cancelled} after`);

  const gone = await page.evaluate(() => typeof window.__gqKeepCaretVisible === "function");
  check("the panning hook is unbound once nothing is being edited", !gone,
    gone ? "still bound with no session" : "cleaned up");
  await context.close();

  // ========================================================== the desktop ==
  const desk = await open(DESKTOP, false, "desktop");
  await startText(desk.page, 2);
  const d = await desk.page.evaluate(STATE);
  check("a desktop gets no on-canvas pair", d.live && !d.pairOnScreen,
    `session live: ${d.live}, pair on screen: ${d.pairOnScreen}`);
  await desk.page.keyboard.press("Escape");
  await desk.page.waitForTimeout(600);
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
