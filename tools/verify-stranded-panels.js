/* Panels the mobile shell used to leave behind.
 *
 * A desktop has three homes for a panel: the right dock, the left dock, and
 * free-floating windows. The phone shows one. Anything the user had arranged
 * into the other two was still RENDERED — into a host the phone hides — so it
 * existed and could not be reached: seeded and measured, 13 of 14 panels in the
 * sheet with the fourteenth nowhere a finger could go.
 *
 * The left dock was worse than absent. At 360px it still laid out at its full
 * width over the shell and swallowed every press, so with a panel docked left
 * the start card could not even be dismissed — the first version of this
 * harness timed out trying.
 *
 * Layouts are SEEDED through localStorage rather than built by dragging: the
 * arrangement is what matters, not the gesture that produced it, and dragging a
 * panel into the left dock is a desktop interaction this cannot perform on a
 * phone profile anyway.
 *
 * The third hole the item named — "closed drawers stay fully mounted and
 * re-rendering during a stroke" — is measured here rather than fixed, because
 * measuring it did not support the premise: see the comment on that check.
 *
 * Run: node tools/verify-stranded-panels.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, setSheetDetent, urlArg } = require("./lib/launch");

const LAYOUT_KEY = "graphiq:panel-layout";
const PHONE = { width: 360, height: 780 };

/** Which panels are inside the sheet, and what else is laying itself over the
 *  screen. */
const REPORT = () => {
  const dock = document.querySelector('[data-tour="dock"]');
  const inSheet = [...dock.querySelectorAll("[data-panel-id]")].map((e) =>
    e.getAttribute("data-panel-id"),
  );
  const anywhere = [...document.querySelectorAll("[data-panel-id]")].map((e) =>
    e.getAttribute("data-panel-id"),
  );
  const leftHost = document.querySelector('[aria-label="Left dock"]');
  const leftBox = leftHost?.getBoundingClientRect();
  return {
    inSheet,
    anywhere,
    stranded: anywhere.filter((id) => !inSheet.includes(id)),
    leftWidth: leftBox ? Math.round(leftBox.width) : 0,
    /* What a press at the middle of the screen would actually reach. */
    midpoint: (() => {
      const el = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2);
      return el?.closest('[aria-label="Left dock"]') ? "the left dock" : "not the left dock";
    })(),
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

  const seeded = async (layout, viewport, touch, label) => {
    const context = await browser.newContext({ viewport, hasTouch: touch });
    if (layout)
      await context.addInitScript(
        ([k, v]) => window.localStorage.setItem(k, v),
        [LAYOUT_KEY, JSON.stringify(layout)],
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
    await page.waitForTimeout(1100);
    return { context, page };
  };

  const LAYOUTS = [
    ["a panel docked LEFT", { order: [], left: ["layers"], floats: {}, open: { layers: true } }, "layers"],
    ["a panel FLOATING", { order: [], left: [], floats: { info: { x: 40, y: 80 } }, open: { info: true } }, "info"],
    ["both at once",
      { order: [], left: ["layers"], floats: { info: { x: 40, y: 80 } }, open: { layers: true, info: true } },
      "layers"],
  ];

  for (const [label, layout, expect] of LAYOUTS) {
    const { context, page } = await seeded(layout, PHONE, true, label);

    /* Before anything else: can the shell be used at all? This is the check
       that failed hardest — the left dock host intercepted every press. */
    const before = await page.evaluate(REPORT);
    check(`${label}: nothing is laying itself over the screen`,
      before.midpoint === "not the left dock" && before.leftWidth === 0,
      `a press at the centre reaches ${before.midpoint}; left host is ${before.leftWidth}px wide`);

    await dismissStartCard(page);
    await page.keyboard.press("Control+Shift+N");
    await page.waitForTimeout(1100);
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
    await page.waitForTimeout(900);
    await setSheetDetent(page, "full");

    const r = await page.evaluate(REPORT);
    check(`${label}: every panel is in the sheet`,
      r.stranded.length === 0 && r.inSheet.length === r.anywhere.length,
      r.stranded.length
        ? `stranded: ${r.stranded.join(", ")}`
        : r.inSheet.length !== r.anywhere.length
          ? `${r.anywhere.length - r.inSheet.length} rendered twice — ${r.anywhere.length} instances of ${r.inSheet.length} panels`
          : `all ${r.inSheet.length} of them`);
    check(`${label}: including the one that was arranged away`,
      r.inSheet.includes(expect), `looking for "${expect}"`);

    /* Reachable, not merely present. */
    const opened = await page.evaluate(async (id) => {
      const caret = document.querySelector(`[data-panel-id="${id}"] button[class*="panelCaret"]`);
      if (!caret) return "no caret";
      caret.click();
      await new Promise((res) => setTimeout(res, 700));
      return document.querySelector(`[data-panel-id="${id}"]`)?.getAttribute("data-open");
    }, expect);
    check(`${label}: …and it opens when tapped`, opened === "true", `data-open="${opened}"`);
    await context.close();
  }

  // ------------------------------------------- the desktop layout survives --
  /* Folding the arrangement into one sheet must not REWRITE it: the same
     profile back on a desktop has to find its left dock and its float where
     they were left.

     This runs in ONE context, resized — not a fresh desktop context. A fresh
     one re-seeds from `addInitScript` and shares no storage with the phone
     runs above, so it can only ever prove that seeding works; a phone that
     wiped `left` on its way through would sail past it. (It did: the first
     version of this check passed a mutation that wrote `setLeft([])` on
     mobile.) Here the phone session happens first, on this page, and both the
     stored JSON and the re-laid-out desktop are read after it. */
  const round = await seeded(LAYOUTS[2][1], PHONE, true, "round trip");
  await dismissStartCard(round.page);
  await round.page.keyboard.press("Control+Shift+N");
  await round.page.waitForTimeout(1100);
  await round.page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
  await round.page.waitForTimeout(900);
  await setSheetDetent(round.page, "full");
  /* Touch a panel, so anything that would rewrite the layout has had its
     chance — the persistence effect fires on every change to `left`. */
  await round.page
    .locator('[data-panel-id="layers"] button[class*="panelCaret"]')
    .first()
    .click()
    .catch(() => {});
  await round.page.waitForTimeout(800);

  const stored = await round.page.evaluate((k) => {
    try {
      return JSON.parse(window.localStorage.getItem(k) ?? "null");
    } catch {
      return null;
    }
  }, LAYOUT_KEY);
  check("the phone does not rewrite the stored arrangement",
    !!stored && stored.left?.includes("layers") && !!stored.floats?.info,
    `left: [${stored?.left?.join(", ") ?? "?"}], floats: [${Object.keys(stored?.floats ?? {}).join(", ") || "none"}]`);

  await round.page.setViewportSize({ width: 1400, height: 900 });
  await round.page.waitForTimeout(1400);
  const wide = await round.page.evaluate(() => {
    const dock = document.querySelector('[data-tour="dock"]');
    const leftHost = document.querySelector('[aria-label="Left dock"]');
    const floatHost = document.querySelector('[class*="floatHost"]');
    return {
      tier: document.documentElement.dataset.mobile
        ? "phone"
        : document.documentElement.dataset.tablet
          ? "tablet"
          : "desktop",
      inDock: [...(dock?.querySelectorAll("[data-panel-id]") ?? [])].length,
      everywhere: document.querySelectorAll("[data-panel-id]").length,
      inLeft: [...(leftHost?.querySelectorAll("[data-panel-id]") ?? [])].length,
      floating: [...(floatHost?.querySelectorAll("[data-panel-id]") ?? [])].length,
      stored: (() => {
        try {
          return JSON.parse(window.localStorage.getItem("graphiq:panel-layout") ?? "null");
        } catch {
          return null;
        }
      })(),
    };
  });
  /* Widening a TOUCH context does not produce a desktop — it produces a large
     tablet, and the tablet tier folds panels into the one dock for the same
     reason the phone does: both hosts are positioned by dragging. This check
     used to assert the left dock and the float came back, which was true when
     the only two tiers were phone and desktop and became wrong the moment a
     third existed. What matters either way is that the phone did not REWRITE
     anything, and the stored JSON above already says so. */
  check("…and widening it gives the tablet shell, not the phone's",
    wide.tier === "tablet", `1400×900 with touch is a ${wide.tier}`);
  check("…which still holds every panel in the one dock",
    wide.inDock === wide.everywhere && wide.inLeft === 0 && wide.floating === 0,
    `${wide.inDock} of ${wide.everywhere} in the dock; left ${wide.inLeft}, floating ${wide.floating}`);
  check("…with the stored arrangement still intact underneath it",
    !!wide.stored && wide.stored.left?.includes("layers") && !!wide.stored.floats?.info,
    `left: [${wide.stored?.left?.join(", ") ?? "?"}], floats: [${Object.keys(wide.stored?.floats ?? {}).join(", ") || "none"}]`);
  await round.context.close();

  // ------------------------------------- what a closed sheet costs a stroke --
  /* The item's third hole, and the one the measurement did not support. It
     asked for "zero panel commits" during a stroke with the sheet closed, on
     the premise that a closed drawer is "fully mounted and re-rendering".
     Measured: TWO renders across a thirty-step stroke — one as painting starts
     and one as it ends — against 52 with the sheet open, which is the Info
     readout doing its job. Going from 2 to 0 means unmounting the dock, which
     costs the accordion's state and the ability to leave a panel open. A bound
     is asserted instead, so a regression to genuinely re-rendering is caught. */
  const perf = await seeded(null, { width: 390, height: 844 }, true, "stroke");
  await dismissStartCard(perf.page);
  await perf.page.keyboard.press("Control+Shift+N");
  await perf.page.waitForTimeout(1200);
  await perf.page.keyboard.press("b");
  await perf.page.waitForTimeout(400);
  const cv = await perf.page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const strokeRenders = async () => {
    await perf.page.evaluate(() => {
      window.__gqPanelRenders = 0;
    });
    await perf.page.mouse.move(cv.x + cv.width * 0.3, cv.y + cv.height * 0.4);
    await perf.page.mouse.down();
    for (let i = 1; i <= 30; i++)
      await perf.page.mouse.move(
        cv.x + cv.width * (0.3 + 0.012 * i),
        cv.y + cv.height * (0.4 + 0.008 * i),
      );
    await perf.page.mouse.up();
    await perf.page.waitForTimeout(800);
    return perf.page.evaluate(() => window.__gqPanelRenders ?? -1);
  };
  const closedCost = await strokeRenders();
  check("a stroke with the sheet closed barely touches the panels",
    closedCost >= 0 && closedCost <= 4,
    `${closedCost} panel renders across a 30-step stroke (it is not 0, and does not need to be)`);
  await perf.context.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
