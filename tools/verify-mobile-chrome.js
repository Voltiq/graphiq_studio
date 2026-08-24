/* What the phone spends on chrome, and what the shell used to delete.
 *
 * The item put the chrome at "roughly 120px of an 844px screen" and said the
 * mobile shell takes the zoom readout, the save-state indicator and the
 * document size with it. Measured at 390×844, both halves needed correcting:
 *
 *   - the chrome above the artwork was **154px**, not 120 — a 48px top bar, a
 *     48px options bar, 36px of tab strip showing a single tab, and 22px of
 *     ruler — plus 56px of MobileBar below, leaving **634px** to draw in;
 *   - the zoom readout was not deleted. It was BURIED. The on-canvas zoom pill
 *     sits at `bottom: 16px` inside a stage that runs the full height of the
 *     screen, so on a phone it landed at y=774–828 against a MobileBar
 *     starting at 788 — and lost the stacking contest 5 to 130. A press at the
 *     centre of Zoom out, Zoom in and Fit on screen each reached `button.tool`
 *     instead, so all three were unusable and the percentage was painted
 *     underneath the bar. That is a touch-parity bug that had been sitting
 *     inside a layout item.
 *
 * The item's own threshold (a stage ≥620px tall) therefore passed BEFORE any of
 * this work, at 634px. It is still asserted, because it is the stated contract
 * — but the number that shows the work is the one beside it.
 *
 * Run: node tools/verify-mobile-chrome.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1400, height: 900 };
const VIEW_KEY = "pe-view";

/** The vertical budget: what is chrome, and what is left to draw on. */
const BUDGET = () => {
  const box = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { y: Math.round(r.y), h: Math.round(r.height), bottom: Math.round(r.bottom) };
  };
  const bar = document.querySelector('[data-tour="mobilebar"]');
  const ruler = document.querySelector('[class*="rulerH"]');
  const stage = document.querySelector('[class*="stageWrap"]');
  /* Where the artwork can actually start: under the ruler when there is one,
     otherwise at the top of the stage. */
  const drawTop = ruler
    ? Math.round(ruler.getBoundingClientRect().bottom)
    : Math.round(stage.getBoundingClientRect().top);
  const drawBottom = bar
    ? Math.round(bar.getBoundingClientRect().top)
    : Math.round(document.querySelector('[data-tour="canvas"]').getBoundingClientRect().bottom);
  return {
    vh: window.innerHeight,
    topbar: box('[data-tour="topbar"]'),
    options: box('[data-tour="options"]'),
    tabs: box("[data-tabs]"),
    ruler: ruler ? box('[class*="rulerH"]') : null,
    mobilebar: box('[data-tour="mobilebar"]'),
    status: box('[data-tour="status"]'),
    drawTop,
    drawable: drawBottom - drawTop,
  };
};

/** The readouts, and whether a press reaches what it looks like it should. */
const READOUTS = () => {
  const hit = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return "absent";
    const r = e.getBoundingClientRect();
    const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2));
    if (!el) return "nothing";
    if (el === e || e.contains(el)) return "itself";
    return el.tagName.toLowerCase() + "." + String(el.className).replace(/\S*module__\w+__/g, "").slice(0, 20);
  };
  const st = document.querySelector("[data-mobile-status]");
  const txt = (sel) => document.querySelector(sel)?.textContent.trim() ?? null;
  const zb = document.querySelector("[data-zoombar]");
  const bar = document.querySelector('[data-tour="mobilebar"]');
  return {
    present: !!st,
    name: txt("[data-status-name]"),
    size: txt("[data-status-size]"),
    save: txt("[data-status-save]"),
    saved: document.querySelector("[data-status-save]")?.getAttribute("data-saved"),
    zoom: txt("[data-zoom-value]"),
    /* A readout must not eat a stroke aimed at the artwork under it. */
    statusHit: hit("[data-mobile-status]"),
    zoomHits: {
      out: hit('[data-zoombar] button[aria-label="Zoom out"]'),
      in: hit('[data-zoombar] button[aria-label="Zoom in"]'),
      fit: hit('[data-zoombar] button[aria-label="Fit on screen"]'),
    },
    zoomBarBottom: zb ? Math.round(zb.getBoundingClientRect().bottom) : null,
    barTop: bar ? Math.round(bar.getBoundingClientRect().top) : null,
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

  const open = async (viewport, touch, label, seedView) => {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
    if (seedView)
      await context.addInitScript(
        ([k, v]) => window.localStorage.setItem(k, v),
        [VIEW_KEY, JSON.stringify(seedView)],
      );
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
    await page.waitForTimeout(1200);
    return { context, page };
  };

  // ============================================ the phone's vertical budget ==
  const { context, page } = await open(PHONE, true, "phone");
  const before = await page.evaluate(BUDGET);

  check("the tab strip is not spent on a single document",
    !before.tabs || before.tabs.h === 0,
    before.tabs ? `${before.tabs.h}px tall` : "not rendered");
  check("the ruler is off by default", before.ruler === null,
    before.ruler ? `ruler at y=${before.ruler.y}` : "no ruler");
  check("the top chrome is the two bars and nothing else",
    before.drawTop === before.options.bottom,
    `artwork starts at ${before.drawTop}; the options bar ends at ${before.options.bottom}`);
  check("the desktop status bar stays hidden here", !before.status || before.status.h === 0,
    "the mobile readout replaces it");
  /* The item's stated contract, and then the number that shows the work. */
  check("the stage clears the 620px the item asked for", before.drawable >= 620,
    `${before.drawable}px of ${before.vh} (it was already 634 before this item — see the header)`);
  check("…and the reclaim is real", before.drawable >= 690,
    `${before.drawable}px, up from 634 — 36px of tab strip and 22px of ruler`);

  /* Reclaiming the ruler moved the artwork 22px left — into the edge-swipe
     strips, which sit fixed over the outer 20px of each side and only stand
     aside once a pointer has already landed on the canvas. So the artwork's
     own left column stopped being pressable: the Crop corner at x=13 could not
     be grabbed at all, and the options-sheet rail caught it as an Apply that
     committed nothing. `fit()` now insets by `--edge-strip`. */
  const edges = await page.evaluate(() => {
    const board = document.querySelector("[data-artboard]").getBoundingClientRect();
    const at = (x) => {
      const el = document.elementFromPoint(Math.round(x), Math.round(board.top + board.height / 2));
      if (!el) return "nothing";
      if (el.closest(".gq-m-edge")) return "an edge strip";
      return el.closest('[data-tour="canvas"]') ? "the canvas" : el.tagName.toLowerCase();
    };
    return {
      left: Math.round(board.left), right: Math.round(board.right),
      vw: window.innerWidth,
      atLeft: at(board.left + 2), atRight: at(board.right - 2),
      strip: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--edge-strip")) || 0,
    };
  });
  check("the fitted artwork opens clear of the edge-swipe strips",
    edges.left >= edges.strip && edges.vw - edges.right >= edges.strip,
    `artwork spans ${edges.left}–${edges.right} of ${edges.vw}; strips claim ${edges.strip}px a side`);
  check("…so a press at its own edge reaches the canvas",
    edges.atLeft === "the canvas" && edges.atRight === "the canvas",
    `left edge reaches ${edges.atLeft}, right edge reaches ${edges.atRight}`);

  // ================================================ the three readouts back ==
  const r0 = await page.evaluate(READOUTS);
  check("a visible element reports the zoom", !!r0.zoom && /^\d+%$/.test(r0.zoom), `reads "${r0.zoom}"`);
  check("…and the document's size", !!r0.size && /\d+\s*×\s*\d+/.test(r0.size), `reads "${r0.size}"`);
  check("…and its name", !!r0.name && r0.name.length > 0, `reads "${r0.name}"`);
  check("…and whether the work is saved", !!r0.save, `reads "${r0.save}" (saved=${r0.saved})`);
  check("the readout does not eat a press aimed at the artwork",
    r0.statusHit !== "itself" && r0.statusHit !== "absent",
    `a press at its centre reaches ${r0.statusHit}`);

  // ---- the buried zoom pill
  check("the zoom pill clears the MobileBar",
    r0.zoomBarBottom !== null && r0.barTop !== null && r0.zoomBarBottom <= r0.barTop,
    `pill ends at ${r0.zoomBarBottom}, bar starts at ${r0.barTop}`);
  const buried = Object.entries(r0.zoomHits).filter(([, v]) => v !== "itself");
  check("…so all three of its buttons can be pressed", buried.length === 0,
    buried.length ? buried.map(([k, v]) => `${k} reaches ${v}`).join(", ") : "zoom out, zoom in, fit");

  const zoomBefore = r0.zoom;
  await page.locator('[data-zoombar] button[aria-label="Zoom in"]').click();
  await page.waitForTimeout(700);
  const afterTap = await page.evaluate(READOUTS);
  check("…and tapping Zoom in changes the zoom", afterTap.zoom !== zoomBefore,
    `${zoomBefore} → ${afterTap.zoom}`);

  // ---- the readout tracks a pinch
  const cdp = await context.newCDPSession(page);
  const stage = await page.locator('[data-tour="canvas"]').boundingBox();
  const cx = Math.round(stage.x + stage.width / 2);
  const cy = Math.round(stage.y + stage.height / 2);
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    });
  const zoomPrePinch = (await page.evaluate(READOUTS)).zoom;
  await touch("touchStart", [{ x: cx - 40, y: cy }, { x: cx + 40, y: cy }]);
  await page.waitForTimeout(120);
  for (let i = 1; i <= 8; i++)
    await touch("touchMove", [
      { x: cx - 40 - i * 12, y: cy },
      { x: cx + 40 + i * 12, y: cy },
    ]);
  await touch("touchEnd", []);
  await page.waitForTimeout(900);
  const afterPinch = await page.evaluate(READOUTS);
  check("the zoom readout follows a pinch", afterPinch.zoom !== zoomPrePinch,
    `${zoomPrePinch} → ${afterPinch.zoom}`);

  // ---- the save indicator flips on an edit
  /* From SAVED to unsaved, which needs a saved state to start from. A blank
     document is "Unsaved changes" the moment the start card is dismissed, so
     asserting `saved === "false"` after an edit passes on a readout that is
     hard-wired to the word: it read false → false. An autosave is forced first
     — the same `visibilitychange → hidden` path `verify-autosave` drives — and
     only then is the edit made. */
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1600);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(400);
  const savedState = await page.evaluate(READOUTS);
  check("an autosave shows the work as saved", savedState.saved === "true",
    `reads "${savedState.save}"`);

  await page.keyboard.press("Control+Shift+N"); // a new layer is a real edit
  await page.waitForTimeout(1200);
  const afterEdit = await page.evaluate(READOUTS);
  check("…and the indicator flips back the moment something is edited",
    savedState.saved === "true" && afterEdit.saved === "false",
    `"${savedState.save}" → "${afterEdit.save}"`);

  await context.close();

  // ================================= what the reclaimed strip used to carry ==
  /* Renaming lived only on the document tab, so reclaiming the strip would have
     deleted it outright. It is a menu action now, which also puts it in the
     palette — and gives a desktop keyboard user a route that never existed.

     On its own page: the block above ends with a synthetic pinch, and driving
     the menu sheet straight afterwards found no File menu at all — the sheet
     never opened. Isolating it costs one load and removes a dependency on
     whatever pointer state a CDP touch sequence leaves behind. */
  const m = await open(PHONE, true, "phone+menus");
  const page2 = m.page;
  await page2.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) =>
      /^Menu$/i.test(x.getAttribute("aria-label") || ""),
    )?.click();
  });
  await page2.waitForSelector('[data-menubar][data-sheet="true"]', { timeout: 6000 });
  await page2.waitForTimeout(400);
  await page2.evaluate(() => {
    [...document.querySelectorAll("[data-menubar] > div > button")]
      .find((x) => x.textContent.trim() === "File")
      ?.click();
  });
  await page2.waitForTimeout(500);
  const renameRow = page2.locator('[data-menubar] [role="menu"] button', { hasText: "Rename document" });
  /* PRESENT is not the property — USABLE is. Marking the row `disabled: true`
     leaves it in the tree, so a count check passed on it and the harness then
     failed thirty seconds later on a click that could never land. A disabled
     row is also withheld from the palette by design, so that route is checked
     too rather than assumed. */
  const renameCount = await renameRow.count();
  const renameUsable = renameCount ? await renameRow.first().isEnabled() : false;
  check("renaming survives the reclaimed tab strip", renameCount > 0 && renameUsable,
    renameCount
      ? renameUsable
        ? "File ▸ Rename document…"
        : "the row is in the tree but disabled, so it cannot be used"
      : "no such row");
  if (renameCount && renameUsable) {
    await renameRow.first().scrollIntoViewIfNeeded().catch(() => {});
    await renameRow.first().click();
    await page2.waitForSelector("[data-rename-doc]", { timeout: 6000 });
    await page2.fill("[data-rename-doc] input", "Holiday photo");
    await page2.locator("[data-rename-doc] button", { hasText: "Rename" }).click();
    await page2.waitForTimeout(800);
  }
  const renamed = await page2.evaluate(READOUTS);
  check("…and the readout shows the new name", renamed.name === "Holiday photo",
    `reads "${renamed.name}"`);

  /* …and search finds it, which is the route that matters most on a phone. */
  await page2.keyboard.press("Escape");
  await page2.waitForTimeout(400);
  await page2.locator('button[aria-label="Open the command palette"]').click();
  await page2.waitForTimeout(600);
  await page2.fill('[role="combobox"], input[type="text"]', "rename doc");
  await page2.waitForTimeout(500);
  const inPalette = await page2.evaluate(() =>
    [...(document.getElementById("command-palette-list")?.querySelectorAll('[role="option"]') ?? [])]
      .map((r) => r.textContent.trim())
      .filter((s) => /rename/i.test(s)),
  );
  check("…and the palette offers it too", inPalette.length > 0,
    inPalette.length ? `"${inPalette[0].slice(0, 40)}"` : "search finds no rename command");
  await page2.keyboard.press("Escape");
  await page2.waitForTimeout(400);

  // ---- two documents bring the strip back, because now it says something
  /* Ctrl+Alt+N opens the New-document DIALOG; it does not make a document. The
     first version of this check pressed it and asserted on a tab strip that
     had no reason to have changed. */
  await page2.keyboard.press("Control+Alt+N");
  await page2.waitForSelector('[role="dialog"][aria-label="New document"]', { timeout: 8000 });
  await page2.waitForTimeout(400);
  await page2
    .locator('[role="dialog"][aria-label="New document"] button', { hasText: /^(Create|New|OK)$/ })
    .first()
    .click();
  await page2.waitForTimeout(1600);
  const twoDocs = await page2.evaluate(() => ({
    ...((() => {
      const e = document.querySelector("[data-tabs]");
      const r = e?.getBoundingClientRect();
      return { h: r ? Math.round(r.height) : 0, count: e?.getAttribute("data-count") };
    })()),
  }));
  check("a second document brings the tab strip back",
    twoDocs.h > 0 && twoDocs.count === "2",
    `${twoDocs.h}px tall, data-count="${twoDocs.count}"`);
  await m.context.close();

  // ================================ the ruler is a DEFAULT, not an override ==
  const seeded = await open(PHONE, true, "phone+rulers", {
    rulers: true, grid: false, snap: true, docgrid: false,
    guides: true, lockguides: false, smartguides: true,
  });
  const withRulers = await seeded.page.evaluate(BUDGET);
  check("a stored ruler preference still wins on a phone",
    withRulers.ruler !== null && withRulers.ruler.h > 0,
    withRulers.ruler ? `ruler ${withRulers.ruler.h}px at y=${withRulers.ruler.y}` : "no ruler — the default overrode a stored choice");
  await seeded.context.close();

  // ===================================================== desktop untouched ==
  const desk = await open(DESKTOP, false, "desktop");
  const d = await desk.page.evaluate(BUDGET);
  const dr = await desk.page.evaluate(READOUTS);
  check("desktop keeps its tab strip", !!d.tabs && d.tabs.h > 0,
    d.tabs ? `${d.tabs.h}px tall` : "missing");
  check("…and its rulers", d.ruler !== null && d.ruler.h > 0,
    d.ruler ? `${d.ruler.h}px` : "missing");
  check("…and its status bar", !!d.status && d.status.h > 0,
    d.status ? `${d.status.h}px tall` : "missing");
  check("…and does not render the mobile readout", !dr.present, "phone-only, as intended");
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
