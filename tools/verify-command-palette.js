/* The command palette as the phone's primary menu.
 *
 * The item behind this said "163 menu rows rendered as one flat scrolling
 * column is not navigable". Measuring found something different and worth
 * writing down: the sheet is not flat. It is ten menu names, and tapping one
 * expands it inline. What was actually broken was narrower and sharper —
 *
 *   - the palette's trigger was a 44×44 magnifier with NO text, sitting among
 *     five other icon buttons, i.e. the least likely thing on the bar to be
 *     tried;
 *   - an expanded menu pushed the other nine off the end of the sheet. Opening
 *     Layer (44 items) grew it to 2471px — 2.9 screens — so reaching Select,
 *     the very next menu, meant scrolling past all forty-four.
 *
 * So the fix is: say what the button is, put search at the top of the sheet,
 * and let an open menu scroll inside the sheet rather than lengthening it.
 *
 * The keyboard is exercised through `--kb-inset`, the property the app really
 * uses (`useVisualViewport.ts`), rather than by shrinking the viewport —
 * mobile browsers mostly do NOT resize the layout viewport for a keyboard, so
 * a resize would be testing a case that does not happen.
 *
 * Run: node tools/verify-command-palette.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1400, height: 900 };
/* Two keyboards, and the second one is the point.
   The item names 300px. At 300 the palette fits above it even with its
   max-height clamp removed — the drop from the top shrinks with the inset, and
   59 + 46 + 430 = 535 lands just inside the 544 available. The clamp only
   starts doing work past ~309px, so a 300-only check passed two mutations that
   deleted it. 380px is an ordinary large keyboard (a tall layout, or one with a
   suggestion strip) and is comfortably the other side of that line. */
const KEYBOARDS = [300, 380];

const TRIGGER = 'button[aria-label="Open the command palette"]';
const HAMBURGER = () =>
  [...document.querySelectorAll("header button")].find((x) =>
    /^Menu$/i.test(x.getAttribute("aria-label") || ""),
  );

/** Box, plus the text a person can actually read on it. */
const readTrigger = (sel) => {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const text = [...el.querySelectorAll("*")]
    .filter((c) => {
      const cs = getComputedStyle(c);
      return (
        c.textContent?.trim() &&
        cs.display !== "none" &&
        cs.visibility !== "hidden" &&
        c.getBoundingClientRect().width > 0
      );
    })
    .map((c) => c.textContent.trim())
    .join(" ");
  const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
  return {
    w: Math.round(r.width),
    h: Math.round(r.height),
    text,
    reaches: hit?.closest(sel) ? "the trigger" : hit ? hit.tagName.toLowerCase() : "nothing",
  };
};

/** The palette's list, and whether its 5th row can be tapped. */
const readPalette = () => {
  const list = document.getElementById("command-palette-list");
  if (!list) return { open: false };
  const rows = [...list.querySelectorAll('[role="option"]')];
  const fifth = rows[4];
  const fr = fifth?.getBoundingClientRect();
  let reaches = "nothing";
  if (fr) {
    const el = document.elementFromPoint(fr.x + fr.width / 2, fr.y + fr.height / 2);
    reaches = el?.closest('[role="option"]') === fifth ? "the 5th row" : el ? el.tagName.toLowerCase() : "nothing";
  }
  const lr = list.getBoundingClientRect();
  const visibleBottom = window.innerHeight - (parseFloat(
    getComputedStyle(document.documentElement).getPropertyValue("--kb-inset"),
  ) || 0);
  return {
    open: true,
    rows: rows.length,
    rowH: rows.length ? Math.round(rows[0].getBoundingClientRect().height) : 0,
    minRowH: rows.length ? Math.round(Math.min(...rows.map((r) => r.getBoundingClientRect().height))) : 0,
    scrolls: list.scrollHeight > list.clientHeight + 2,
    listBottom: Math.round(lr.bottom),
    visibleBottom: Math.round(visibleBottom),
    fifthReaches: reaches,
    fifthOnScreen: fr ? fr.top >= 0 && fr.bottom <= visibleBottom : null,
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
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
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

  // =========================================================== the trigger ==
  const { context, page } = await open(PHONE, true, "phone");

  const trig = await page.evaluate(readTrigger, TRIGGER);
  check("the palette trigger says what it is", !!trig && trig.text.length > 0,
    trig ? `reads "${trig.text || "(nothing)"}"` : "no trigger at all");
  check("…and is big enough to tap", !!trig && trig.h >= 44 && trig.w >= 44,
    trig ? `${trig.w}×${trig.h}` : "-");
  check("…and a press at its centre reaches it", trig?.reaches === "the trigger",
    `a press reaches ${trig?.reaches}`);

  await page.locator(TRIGGER).click();
  await page.waitForTimeout(700);
  check("tapping it opens the palette", (await page.evaluate(readPalette)).open, "");

  // ---- rows are sized for a finger, and the 5th one is reachable
  await page.fill('[role="combobox"], input[type="text"]', "la");
  await page.waitForTimeout(500);
  const noKb = await page.evaluate(readPalette);
  check("its rows are sized for a finger", noKb.minRowH >= 44,
    `${noKb.rows} rows, shortest ${noKb.minRowH}px`);
  check("the list scrolls when the results outrun it", noKb.scrolls,
    `${noKb.rows} rows shown`);
  check("the 5th row can be tapped", noKb.fifthReaches === "the 5th row" && noKb.fifthOnScreen,
    `a press reaches ${noKb.fifthReaches}; on screen: ${noKb.fifthOnScreen}`);

  // ---- and again with a keyboard eating the bottom of the screen
  /* `--kb-inset` is what `useVisualViewport` publishes and what every overlay
     in the app already reads. Setting it directly is the honest simulation:
     a real keyboard on a phone does not resize the layout viewport. */
  for (const kb of KEYBOARDS) {
    await page.evaluate((px) => {
      document.documentElement.style.setProperty("--kb-inset", `${px}px`);
    }, kb);
    await page.waitForTimeout(600);
    const withKb = await page.evaluate(readPalette);
    check(`with a ${kb}px keyboard, the list still scrolls`, withKb.scrolls,
      `${withKb.rows} rows in ${withKb.visibleBottom}px of visible page`);
    check(`…and at ${kb}px the 5th row is still hit-testable`,
      withKb.fifthReaches === "the 5th row" && withKb.fifthOnScreen,
      `a press reaches ${withKb.fifthReaches}; on screen: ${withKb.fifthOnScreen}`);
    check(`…and at ${kb}px the list ends above the keyboard, not behind it`,
      withKb.listBottom <= withKb.visibleBottom,
      `list ends at ${withKb.listBottom}, keyboard starts at ${withKb.visibleBottom}`);
  }
  await page.evaluate(() => document.documentElement.style.removeProperty("--kb-inset"));
  await page.waitForTimeout(300);

  // ---- it actually RUNS things, which is the whole point
  await page.fill('[role="combobox"], input[type="text"]', "new layer");
  await page.waitForTimeout(500);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  const ran = await page.evaluate(() => {
    const undo = [...document.querySelectorAll("header button")].find((b) =>
      /^Undo/.test(b.getAttribute("title") || ""),
    );
    return { paletteGone: !document.getElementById("command-palette-list"), canUndo: !undo?.disabled };
  });
  check("running a command from the palette does the thing", ran.canUndo && ran.paletteGone,
    `undo enabled: ${ran.canUndo}, palette closed: ${ran.paletteGone}`);

  // ====================================== search leads the browsable sheet ==
  await page.evaluate(HAMBURGER).then(() => {});
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("header button")].find((x) =>
      /^Menu$/i.test(x.getAttribute("aria-label") || ""),
    );
    b?.click();
  });
  await page.waitForTimeout(800);
  const firstRow = await page.evaluate(() => {
    const nav = document.querySelector("[data-menubar]");
    const rows = [...nav.querySelectorAll(":scope > div > button")];
    const s = rows[0];
    const r = s?.getBoundingClientRect();
    return {
      isSearch: s?.hasAttribute("data-sheet-search"),
      text: s?.textContent.trim(),
      h: r ? Math.round(r.height) : 0,
      w: r ? Math.round(r.width) : 0,
    };
  });
  check("search is the first row of the menu sheet", firstRow.isSearch,
    `first row reads "${firstRow.text}"`);
  check("…and it is a full-width, tappable row", firstRow.h >= 44 && firstRow.w >= 300,
    `${firstRow.w}×${firstRow.h}`);

  await page.locator("[data-sheet-search]").click();
  await page.waitForTimeout(800);
  const fromSheet = await page.evaluate(() => ({
    palette: !!document.getElementById("command-palette-list"),
    sheetGone: document.querySelector('[data-menubar][data-sheet="true"]') === null,
  }));
  check("tapping it opens the palette and closes the sheet",
    fromSheet.palette && fromSheet.sheetGone,
    `palette: ${fromSheet.palette}, sheet closed: ${fromSheet.sheetGone}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  // ================================== the fallback stays browsable as well ==
  /* The measured defect: an open menu lengthened the sheet instead of scrolling
     inside it, so the other nine menus went off the end. */
  await page.evaluate(() => {
    const b = [...document.querySelectorAll("header button")].find((x) =>
      /^Menu$/i.test(x.getAttribute("aria-label") || ""),
    );
    b?.click();
  });
  await page.waitForTimeout(800);
  const menuNames = await page.evaluate(() =>
    [...document.querySelectorAll("[data-menubar] > div > button")]
      .filter((x) => !x.hasAttribute("data-sheet-search"))
      .map((x) => x.textContent.trim()),
  );
  check("the sheet still lists every menu", menuNames.length >= 10, menuNames.join(", "));

  let worst = { label: "-", screens: 0 };
  const neighbours = [];
  for (const label of menuNames) {
    const tap = (l) =>
      page.evaluate((x) => {
        [...document.querySelectorAll("[data-menubar] > div > button")]
          .find((b) => b.textContent.trim() === x)
          ?.click();
      }, l);
    await tap(label);
    await page.waitForTimeout(320);
    const m = await page.evaluate((l) => {
      const nav = document.querySelector("[data-menubar]");
      const dd = nav.querySelector('[role="menu"]');
      const tops = [...nav.querySelectorAll(":scope > div > button")].filter(
        (x) => !x.hasAttribute("data-sheet-search"),
      );
      const i = tops.findIndex((x) => x.textContent.trim() === l);
      const self = tops[i];
      const next = tops[i + 1] ?? tops[i - 1];
      const sr = self.getBoundingClientRect();
      const nr = next?.getBoundingClientRect();
      return {
        screens: +(nav.scrollHeight / window.innerHeight).toFixed(2),
        items: dd ? dd.querySelectorAll("button").length : 0,
        innerScrolls: dd ? dd.scrollHeight > dd.clientHeight + 2 : false,
        neighbour: next?.textContent.trim(),
        /* The DISTANCE between two menu names, not their absolute position.
           Absolute position only says whether a row happens to sit above the
           fold — with the sheet at 1.09 screens the last one or two never do,
           and demanding it would fail on correct code. What went wrong before
           was the gap: an open Layer put ~2000px of its own items between
           itself and Select. */
        gap: nr ? Math.round(nr.top - sr.top) : null,
        vh: window.innerHeight,
      };
    }, label);
    if (m.screens > worst.screens) worst = { label, ...m };
    neighbours.push({ label, ...m });
    await tap(label);
    await page.waitForTimeout(200);
  }

  check("no menu turns the sheet into a scroll marathon", worst.screens <= 1.5,
    `worst is ${worst.label} at ${worst.screens} screens (${worst.items} items), was 2.93`);
  const far = neighbours.filter((n) => n.gap === null || n.gap > n.vh);
  check("an open menu never pushes its neighbour more than a screen away",
    far.length === 0,
    far.length
      ? far.map((n) => `${n.label}→${n.neighbour} is ${n.gap}px`).join(", ")
      : `worst gap ${Math.max(...neighbours.map((n) => n.gap))}px across ${neighbours.length} menus, was ~2000`);
  const longest = neighbours.find((n) => n.items >= 40);
  check("the longest menu scrolls inside the sheet rather than lengthening it",
    !!longest && longest.innerScrolls,
    longest ? `${longest.label} has ${longest.items} items and scrolls internally` : "no menu that long");

  await context.close();

  // ===================================================== desktop untouched ==
  const desk = await open(DESKTOP, false, "desktop");
  const deskTrig = await desk.page.evaluate(readTrigger, TRIGGER);
  check("desktop still shows the hint and the Ctrl+K chip",
    !!deskTrig && /Search tools/.test(deskTrig.text) && /Ctrl\+K/.test(deskTrig.text),
    `reads "${deskTrig?.text}"`);
  const deskSheet = await desk.page.evaluate(() => ({
    searchRow: !!document.querySelector("[data-sheet-search]"),
    hamburger: !!document.querySelector('header button[aria-label="Menu"]'),
  }));
  check("…and has neither the sheet's search row nor the hamburger",
    !deskSheet.searchRow && !deskSheet.hamburger,
    `search row: ${deskSheet.searchRow}, hamburger: ${deskSheet.hamburger}`);
  /* The cap is a mobile-sheet rule; a desktop dropdown must be free to be as
     tall as it likes. */
  /* Clicked and read in SEPARATE evaluates: the first version did both in one
     tick and found no dropdown, because React had not rendered it yet — which
     reads as "not capped" and would have passed on a capped menu too. */
  await desk.page.evaluate(() => {
    [...document.querySelectorAll("[data-menubar] > div > button")]
      .find((x) => x.textContent.trim() === "Layer")
      ?.click();
  });
  await desk.page.waitForTimeout(600);
  const deskDrop = await desk.page.evaluate(() => {
    const dd = document.querySelector('[role="menu"]');
    return dd
      ? {
          h: Math.round(dd.getBoundingClientRect().height),
          items: dd.querySelectorAll("button").length,
          capped: dd.scrollHeight > dd.clientHeight + 2,
        }
      : null;
  });
  check("the desktop Layer menu is not capped",
    !!deskDrop && deskDrop.items >= 40 && !deskDrop.capped,
    deskDrop ? `${deskDrop.items} items, ${deskDrop.h}px tall, inner scroll: ${deskDrop.capped}` : "no dropdown");
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
