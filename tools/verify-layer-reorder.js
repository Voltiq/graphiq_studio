/* Reordering layers with a finger.
 *
 * The rows reorder with HTML5 drag and drop, and those events do not fire for
 * touch at all — so on a phone the layer order could not be changed by any
 * route. Touch now gets long-press to lift and drag to move; the mouse keeps
 * the drag-and-drop it already had, and the last section here checks that it
 * still does, because "leaving the mouse path identical" is only a claim until
 * something drives it.
 *
 * The order is read from the Layers panel, and confirmed against the COMPOSITE:
 * a panel that lists rows in a new order while the picture is unchanged would
 * be a rename, not a reorder. Each layer is filled with a different colour so
 * the topmost one is whatever the canvas shows.
 *
 * Run: node tools/verify-layer-reorder.js [--url ...] [--channel ...]
 */
const { launchBrowser, openPanel, setSheetDetent, urlArg } = require("./lib/launch");

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const boot = async (page) => {
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
  };

  /** Three opaque layers, the top one a DIFFERENT colour from the bottom.
   *
   *  Order only shows in the composite if the layers differ and cover each
   *  other, and driving the colour picker to get three colours proved more
   *  trouble than it was worth — `d` (default colours) and `x` (swap) give two,
   *  which is all the arrangement needs: fill the bottom two black and the top
   *  one white, and the centre pixel says which layer is on top. */
  const buildDocument = async (page, canvasBox) => {
    await page.keyboard.press("d");
    await page.waitForTimeout(300);
    for (let i = 0; i < 3; i++) {
      await page.keyboard.press("Control+Shift+N");
      await page.waitForTimeout(900);
      if (i === 2) {
        await page.keyboard.press("x"); // swap: the top layer gets the other colour
        await page.waitForTimeout(300);
      }
      await page.keyboard.press("g"); // paint bucket
      await page.waitForTimeout(300);
      await page.mouse.click(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
      await page.waitForTimeout(900);
    }
  };

  const order = (page) =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-tour="dock"] [data-layer-id]')].map(
        (el) => el.textContent?.trim().split("\n")[0]?.slice(0, 12) ?? "?",
      ),
    );
  /** The colour the composite actually shows, which is the topmost layer's. */
  const topColour = (page) =>
    page.evaluate(() => {
      const c = document.querySelector('[data-tour="canvas"] canvas');
      const g = c.getContext("2d", { willReadFrequently: true });
      const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      return `${d[0]},${d[1]},${d[2]}`;
    });
  const openPanels = async (page) => {
    if ((await page.evaluate(() => document.documentElement.dataset.drawer ?? "")) !== "panels")
      await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
    await page.waitForTimeout(700);
    await showLayers(page);
  };
  /* The dock is a tall scroller and the Layers panel sits well down it: the
     rows' boxes read y≈2858 on a 844px screen, and a touch dispatched there
     lands on nothing at all. Collapsing everything above it brings all three
     rows on screen together, which a drag between them needs. */
  const showLayers = async (page) => {
    /* The panels dock is a bottom sheet on a phone and opens half-height, which
       leaves the layer rows below the fold — their boxes are off screen and a
       dispatched touch lands on nothing. A person raises it to work with
       layers; so does this. */
    await setSheetDetent(page, "full");
    /* One request instead of collapsing everything else by hand: the phone's
       sheet is an accordion, and on desktop this just expands Layers. */
    await openPanel(page, "layers");
    await page.evaluate(() => {
      for (const section of document.querySelectorAll('[data-tour="dock"] section')) {
        const caret = section.querySelector('button[class*="panelCaret"]');
        const label = caret?.getAttribute("aria-label") ?? "";
        if (label.startsWith("Collapse") && !label.endsWith("Layers")) caret.click();
      }
    });
    await page.waitForTimeout(600);
    await page.evaluate(() => {
      const section = [...document.querySelectorAll('[data-tour="dock"] section')].find((s) =>
        (s.querySelector('button[class*="panelCaret"]')?.getAttribute("aria-label") || "").endsWith("Layers"),
      );
      section?.scrollIntoView({ block: "start" });
    });
    await page.waitForTimeout(500);
  };

  // ---------- touch ----------
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  await boot(page);
  let box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  await buildDocument(page, box);
  await openPanels(page);

  const rows = page.locator('[data-tour="dock"] [data-layer-id]');
  const startOrder = await order(page);
  const startColour = await topColour(page);
  check("three layers, stacked", startOrder.length === 3, `top to bottom: ${startOrder.join(" / ")}`);
  /* Hide the top layer to see what is under it, so the check below cannot pass
     on two layers that happen to look the same. */
  const underneath = await page.evaluate(async () => {
    const rows = [...document.querySelectorAll('[data-tour="dock"] [data-layer-id]')];
    const eye = rows[0]?.querySelector("button");
    eye?.click();
    await new Promise((r) => setTimeout(r, 700));
    const c = document.querySelector('[data-tour="canvas"] canvas');
    const d = c.getContext("2d", { willReadFrequently: true })
      .getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    eye?.click();
    await new Promise((r) => setTimeout(r, 700));
    return `${d[0]},${d[1]},${d[2]}`;
  });
  check("the top layer covers a DIFFERENT one, so order is visible",
    underneath !== startColour, `top shows ${startColour}, under it ${underneath}`);

  /* The bottom row, lifted and carried above the top one — the item's own
     case, from the end of the list to the start. */
  const last = await rows.nth(2).boundingBox();
  const first = await rows.nth(0).boundingBox();
  await page.touchscreen.tap(last.x + last.width / 2, last.y + last.height / 2);
  await page.waitForTimeout(300);

  const cdp = await context.newCDPSession(page);
  const touchAt = async (type, x, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : [{ x: Math.round(x), y: Math.round(y) }],
    });
  await touchAt("touchStart", last.x + last.width / 2, last.y + last.height / 2);
  await page.waitForTimeout(600); // hold: long-press lifts it
  const liftedFlag = await page.evaluate(
    () => document.querySelectorAll('[data-tour="dock"] [data-dragging="true"]').length,
  );
  check("a long press lifts the row", liftedFlag === 1, `${liftedFlag} row(s) marked as dragging`);

  for (let i = 1; i <= 8; i++) {
    const y = last.y + ((first.y - last.y) * i) / 8;
    await touchAt("touchMove", last.x + last.width / 2, y + last.height / 2);
    await page.waitForTimeout(60);
  }
  await touchAt("touchMove", first.x + first.width / 2, first.y + 4);
  await page.waitForTimeout(200);
  await touchAt("touchEnd", 0, 0);
  await page.waitForTimeout(900);

  const movedOrder = await order(page);
  check("the row moved to the top of the list",
    movedOrder[0] === startOrder[2] && movedOrder.join() !== startOrder.join(),
    `${startOrder.join(" / ")} → ${movedOrder.join(" / ")}`);
  const movedColour = await topColour(page);
  check("…and the picture is re-composited in the new order", movedColour !== startColour,
    `centre pixel ${startColour} → ${movedColour}`);

  /* ONE Undo, not several. The drag reorders live, so every intermediate
     position would be its own step if the gesture were recorded as it went;
     the whole drag is written as a single entry when it ends instead. */
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1200);
  const undoneOrder = await order(page);
  const undoneColour = await topColour(page);
  check("one Undo puts the order back", undoneOrder.join() === startOrder.join(),
    `${movedOrder.join(" / ")} → ${undoneOrder.join(" / ")}`);
  check("…and the picture with it", undoneColour === startColour,
    `centre pixel ${movedColour} → ${undoneColour}`);
  await page.keyboard.press("Control+y");
  await page.waitForTimeout(1200);
  const redoneOrder = await order(page);
  check("…and Redo brings it back again", redoneOrder.join() === movedOrder.join(),
    `${undoneOrder.join(" / ")} → ${redoneOrder.join(" / ")}`);
  await context.close();

  // ---------- the mouse path, unchanged ----------
  const deskContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const desk = await deskContext.newPage();
  await boot(desk);
  box = await desk.locator('[data-tour="canvas"] canvas').first().boundingBox();
  await buildDocument(desk, box);
  await showLayers(desk);
  const deskRows = desk.locator('[data-tour="dock"] [data-layer-id]');
  const deskStart = await order(desk);
  /* dragTo, not a hand-rolled mouse sequence: these rows reorder with HTML5
     drag and drop, which plain mouse events do not start. */
  await deskRows.nth(2).dragTo(deskRows.nth(0), { targetPosition: { x: 20, y: 4 } });
  await desk.waitForTimeout(900);
  const deskEnd = await order(desk);
  check("the mouse still reorders as it did", deskEnd.join() !== deskStart.join(),
    `${deskStart.join(" / ")} → ${deskEnd.join(" / ")}`);
  await desk.keyboard.press("Control+z");
  await desk.waitForTimeout(1200);
  const deskUndone = await order(desk);
  check("…and one Undo puts a mouse reorder back too",
    deskUndone.join() === deskStart.join(),
    `${deskEnd.join(" / ")} → ${deskUndone.join(" / ")}`);
  await deskContext.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
