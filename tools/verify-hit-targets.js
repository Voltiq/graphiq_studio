/* Every control a finger can reach — not just the tool buttons.
 *
 * The mobile stylesheet used to enlarge exactly one family,
 * `[data-tour="toolbar"] button[aria-pressed]`, and left everything else at
 * the size a mouse needs: 20px stepper buttons, 24px panel carets and header
 * buttons, 27px zoom and tab buttons, 30px selects and icon buttons, a 15px
 * swap. A sweep found 24 distinct kinds under 44×44, which is the smallest box
 * a fingertip lands on reliably.
 *
 * The sweep is the check, and it is run over surfaces rather than over one
 * screen: the dock alone is 1500px of scrolling content, so a single
 * measurement at the top would have declared victory over the two panels that
 * happened to be visible. Each surface is scrolled end to end and measured at
 * every position.
 *
 * Three things guard it against passing on nothing:
 *
 *   - a floor on how many controls were actually measured. "Zero boxes under
 *     44px" is exactly what a broken selector, a failed load or a drawer that
 *     never opened would report, and that is the failure this check is most
 *     likely to suffer.
 *   - reachability. A box that MEASURES 44px while something else sits on top
 *     of it is not a target; growing the toolbar's swap button in place, for
 *     instance, would have parked it over the swatch beside it. Points are
 *     tested against the nearest scroll container too, since a control clipped
 *     by a scroller answers `getBoundingClientRect` perfectly happily.
 *   - the rows that a 44px floor overflows. The Layers footer holds eight
 *     buttons and the Swatches toolbar seven; at 44px each they ran 366px and
 *     308px wide inside a 295px drawer that clips, so the last buttons were
 *     gone. Both are asserted to be inside the dock.
 *
 * Desktop is asserted UNCHANGED by naming the old sizes: a rule that leaked
 * out of the mobile block would make every panel row taller on a machine where
 * a mouse can already hit 20px.
 *
 * Run: node tools/verify-hit-targets.js [--url ...] [--channel ...]
 */
const { launchBrowser, openPanel, urlArg } = require("./lib/launch");

const MIN = 44;

/* Collected inside the page: every rendered control whose box is under the
   floor, keyed so the same control seen at two scroll positions counts once. */
const SWEEP = ({ min, scope }) => {
  const root = scope ? document.querySelector(scope) : document;
  if (!root) return { seen: 0, bad: [] };
  const bad = [];
  let seen = 0;
  for (const el of root.querySelectorAll('button, input, select, [role="menuitem"]')) {
    const r = el.getBoundingClientRect();
    /* Rendered and on screen. A zero box is a hidden control (the file inputs,
       the visually-hidden checkbox behind a custom tick) and has no target to
       measure; one scrolled past the edge is measured at another position. */
    if (r.width < 1 || r.height < 1) continue;
    if (r.bottom < 0 || r.top > window.innerHeight) continue;
    if (r.right < 0 || r.left > window.innerWidth) continue;
    seen++;
    if (r.width >= min && r.height >= min) continue;
    const cls = (el.className || "").toString().replace(/^\S*module__\w+__/, "").split(" ")[0];
    const label = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20);
    bad.push(
      `${el.tagName.toLowerCase()}${el.type ? `[${el.type}]` : ""}.${cls || "-"} ` +
        `${Math.round(r.width)}×${Math.round(r.height)} "${label}"`,
    );
  }
  return { seen, bad };
};

/* Can a touch at the centre of each control actually land on it? */
const REACH = (scope) => {
  const root = document.querySelector(scope);
  if (!root) return { tested: 0, bad: [] };
  const bad = [];
  let tested = 0;
  /** The visible slice of an element, after every scrolling ancestor clips it. */
  const clipped = (el) => {
    let box = el.getBoundingClientRect();
    for (let p = el.parentElement; p; p = p.parentElement) {
      const s = getComputedStyle(p);
      if (s.overflowY === "visible" && s.overflowX === "visible") continue;
      const c = p.getBoundingClientRect();
      box = {
        left: Math.max(box.left, c.left),
        right: Math.min(box.right, c.right),
        top: Math.max(box.top, c.top),
        bottom: Math.min(box.bottom, c.bottom),
      };
    }
    return box;
  };
  for (const el of root.querySelectorAll('button, select, [role="menuitem"]')) {
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    const v = clipped(el);
    /* Only controls that are wholly visible: a half-scrolled row is not a
       reachability failure, it is a row the user scrolls to. */
    if (v.right - v.left < r.width - 1 || v.bottom - v.top < r.height - 1) continue;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) continue;
    tested++;
    const hit = document.elementFromPoint(cx, cy);
    if (!hit || el.contains(hit) || hit.contains(el)) continue;
    const cls = (x) => (x.className || "").toString().replace(/^\S*module__\w+__/, "").split(" ")[0];
    bad.push(
      `.${cls(el)} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 18)}" ` +
        `covered by <${hit.tagName.toLowerCase()}>.${cls(hit)}`,
    );
  }
  return { tested, bad };
};

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const open = async (viewport, touch) => {
    const context = await browser.newContext({ viewport, hasTouch: touch });
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
    await page.waitForTimeout(800);
    await page.keyboard.press("Control+Shift+N"); // a layer, so the panels have content
    await page.waitForTimeout(1200);
    return { context, page };
  };

  // ---------------------------------------------------------------- touch --
  const { context, page } = await open({ width: 390, height: 844 }, true);

  let measured = 0;
  const undersized = new Map();
  /** Sweep one surface from top to bottom, and remember what it found. */
  const sweep = async (label, scroller) => {
    const positions = scroller
      ? await page.evaluate((sel) => {
          const el = document.querySelector(sel);
          if (!el) return [0];
          const out = [];
          for (let y = 0; y < el.scrollHeight; y += Math.max(200, el.clientHeight - 60)) out.push(y);
          return out.length ? out : [0];
        }, scroller)
      : [0];
    for (const y of positions) {
      if (scroller)
        await page.evaluate(
          ([sel, top]) => document.querySelector(sel)?.scrollTo(0, top),
          [scroller, y],
        );
      await page.waitForTimeout(260);
      const r = await page.evaluate(SWEEP, { min: MIN });
      measured += r.seen;
      for (const b of r.bad) undersized.set(b.replace(/ "\.*.*$/, ""), `${label}: ${b}`);
    }
  };

  const backOut = async () => {
    await page.evaluate(() => window.history.back());
    await page.waitForTimeout(800);
  };

  await sweep("canvas");

  // The tools drawer, scrolled the whole way down.
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().click();
  await page.waitForTimeout(1000);
  await sweep("tools drawer", '[data-tour="toolbar"] [class*="tools"]');
  const toolsReach = await page.evaluate(REACH, '[data-tour="toolbar"]');
  check(
    "every tool-drawer control is reachable at its own centre",
    toolsReach.bad.length === 0 && toolsReach.tested >= 10,
    `${toolsReach.tested} tested, ${toolsReach.bad.length} covered${
      toolsReach.bad.length ? ": " + toolsReach.bad.slice(0, 3).join(" | ") : ""
    }`,
  );
  await backOut();

  // The panels drawer, every panel expanded, scrolled the whole way down.
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
  await page.waitForTimeout(1000);
  await page.evaluate(() => {
    for (const c of document.querySelectorAll('[data-tour="dock"] button[class*="panelCaret"]'))
      if ((c.getAttribute("aria-label") || "").startsWith("Expand")) c.click();
  });
  await page.waitForTimeout(1200);
  const dockScroller = await page.evaluate(() => {
    const dock = document.querySelector('[data-tour="dock"]');
    const el = [...dock.querySelectorAll("*")].find((e) => e.scrollHeight > e.clientHeight + 40);
    if (el) el.setAttribute("data-scroller", "1");
    return !!el;
  });
  await sweep("panels drawer", dockScroller ? '[data-scroller="1"]' : '[data-tour="dock"]');
  const dockReach = await page.evaluate(REACH, '[data-tour="dock"]');
  check(
    "every panel control is reachable at its own centre",
    dockReach.bad.length === 0 && dockReach.tested >= 10,
    `${dockReach.tested} tested, ${dockReach.bad.length} covered${
      dockReach.bad.length ? ": " + dockReach.bad.slice(0, 3).join(" | ") : ""
    }`,
  );

  /* The two rows that a 44px floor overflows out of a drawer that clips. Each
     lives in its own panel, and the sheet is an accordion now — "expand
     everything" leaves only the last one open, so both are asked for in turn
     and measured while they are the open one. */
  const measureRow = async (panelId, selector) => {
    await openPanel(page, panelId);
    return page.evaluate((sel) => {
      const dock = document.querySelector('[data-tour="dock"]');
      const right = dock.getBoundingClientRect().right;
      const row = document.querySelector(sel);
      if (!row) return null;
      let over = 0;
      let n = 0;
      for (const b of row.children) {
        const r = b.getBoundingClientRect();
        if (r.width < 1) continue;
        n++;
        over = Math.max(over, Math.round(r.right - right));
      }
      return { n, over };
    }, selector);
  };
  const rowsMeasured = {
    layers: await measureRow("layers", '[class*="layerFooter"]'),
    swatches: await measureRow("swatches", '[class*="swToolbar"]'),
  };
  const rows = await page.evaluate(() => {
    const dock = document.querySelector('[data-tour="dock"]');
    const right = dock.getBoundingClientRect().right;
    const worst = (sel) => {
      const row = document.querySelector(sel);
      if (!row) return null;
      let over = 0;
      let n = 0;
      for (const b of row.children) {
        const r = b.getBoundingClientRect();
        if (r.width < 1) continue;
        n++;
        over = Math.max(over, Math.round(r.right - right));
      }
      return { n, over };
    };
    return {
      layers: worst('[class*="layerFooter"]'),
      swatches: worst('[class*="swToolbar"]'),
    };
  });
  check(
    "the Layers footer wraps instead of running off the drawer",
    rowsMeasured.layers && rowsMeasured.layers.n >= 6 && rowsMeasured.layers.over <= 0,
    rowsMeasured.layers ? `${rowsMeasured.layers.n} buttons, ${rowsMeasured.layers.over}px past the edge` : "row not found",
  );
  check(
    "the Swatches toolbar wraps too",
    rowsMeasured.swatches && rowsMeasured.swatches.n >= 5 && rowsMeasured.swatches.over <= 0,
    rowsMeasured.swatches
      ? `${rowsMeasured.swatches.n} children, ${rowsMeasured.swatches.over}px past the edge`
      : "row not found",
  );
  await backOut();

  // The menu sheet, and one menu open inside it.
  await page.locator('button[aria-label="Menu"]').first().click();
  await page.waitForTimeout(900);
  await sweep("menu sheet", '[data-menubar][data-sheet="true"]');
  /* `:not([data-sheet-search])` — the sheet's first row is the palette trigger,
     not a menu, and clicking it closes the sheet. Without this the "menu open"
     sweep ran against a sheet that had just shut itself. */
  await page
    .locator('[data-menubar][data-sheet="true"] > div > button:not([data-sheet-search])')
    .first()
    .click();
  await page.waitForTimeout(700);
  await sweep("menu open", '[data-menubar][data-sheet="true"]');
  const menuReach = await page.evaluate(REACH, '[data-menubar][data-sheet="true"]');
  check(
    "every menu row is reachable at its own centre",
    menuReach.bad.length === 0 && menuReach.tested >= 5,
    `${menuReach.tested} tested, ${menuReach.bad.length} covered`,
  );

  // A dialog — the item names dialog buttons, and they are a separate stylesheet.
  const dialogRow = page
    .locator('[data-menubar][data-sheet="true"] [role="menu"] button', { hasText: "…" })
    .first();
  let dialogSwept = 0;
  if (await dialogRow.count()) {
    await dialogRow.scrollIntoViewIfNeeded().catch(() => {});
    await dialogRow.click().catch(() => {});
    await page.waitForTimeout(1100);
    await sweep("dialog", '[role="dialog"]');
    /* Counted inside the dialog, not from the running total: the sweep above is
       document-wide by design (the claim is about everything on screen), so a
       delta would have counted the top bar behind the dialog as proof that a
       dialog had been measured. */
    dialogSwept = (await page.evaluate(SWEEP, { min: MIN, scope: '[role="dialog"]' })).seen;
    await page.keyboard.press("Escape");
    await page.waitForTimeout(600);
  }
  check("a dialog was opened and swept", dialogSwept >= 3, `${dialogSwept} controls in it`);

  // ---- the sweep's verdict, and the floor that stops it passing on nothing --
  check(
    `every control measures at least ${MIN}×${MIN}`,
    undersized.size === 0,
    undersized.size
      ? `${undersized.size} under it: ${[...undersized.values()].slice(0, 6).join(" | ")}`
      : `none under ${MIN}px`,
  );
  check(
    "…and enough controls were measured for that to mean something",
    measured >= 200,
    `${measured} control measurements across six surfaces`,
  );
  await context.close();

  // -------------------------------------------------------------- desktop --
  const desk = await open({ width: 1400, height: 900 }, false);
  const deskSweep = await desk.page.evaluate(SWEEP, { min: MIN });
  /* Named sizes, not just "some are small": this is the half that catches a
     rule which escaped the mobile block. */
  const deskSizes = await desk.page.evaluate(() => {
    const one = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return "absent";
      const r = el.getBoundingClientRect();
      return `${Math.round(r.width)}×${Math.round(r.height)}`;
    };
    return {
      caret: one('[data-tour="dock"] button[class*="panelCaret"]'),
      swatch: one('[data-tour="toolbar"] button[class*="swatch"]'),
      zoom: one('[data-tour="canvas"] [class*="zoomBar"] button'),
    };
  });
  check("desktop panel carets are still 24×24", deskSizes.caret === "24×24", deskSizes.caret);
  check("desktop toolbar swatches are still 24×24", deskSizes.swatch === "24×24", deskSizes.swatch);
  check("desktop zoom buttons are still 27×27", deskSizes.zoom === "27×27", deskSizes.zoom);
  check(
    "…and desktop still has plenty of controls under 44px, i.e. the rule stayed on touch",
    deskSweep.bad.length >= 10,
    `${deskSweep.bad.length} of ${deskSweep.seen} are under ${MIN}px, as before`,
  );
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
