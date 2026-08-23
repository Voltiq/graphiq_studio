/* A panel and the picture it describes, at the same time.
 *
 * The panels dock was a 320px drawer down the right-hand side. On a 390px
 * screen that is 82% of the width, and measured with it open, 13% of the stage
 * was left visible — so a panel that describes the artwork could never be seen
 * beside it. Height is the axis a phone has to spare, so the dock is a bottom
 * sheet now, with three heights.
 *
 * The item's three checks, and what each is really about:
 *
 *   - at peek the canvas keeps at least 55% of the screen. That is the number
 *     that decides whether the change was worth making.
 *   - the handle snaps to exactly three heights, and to nothing in between: a
 *     drag that ends anywhere has to land on one of them.
 *   - every detent is reachable by drag AND by tap, because the two fail
 *     differently — a drag is the gesture people try, a tap is the one that
 *     always works.
 *
 * The trap in a geometric harness is a sheet that measures beautifully and is
 * not usable, so the panels inside it are driven too: a control is pressed
 * through the sheet, and the artwork behind it is checked to be still
 * touchable — dimming or swallowing taps on the very thing the panel describes
 * would undo the point of the change.
 *
 * Run: node tools/verify-panel-sheet.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

const GEOM = () => {
  const dock = document.querySelector('[data-tour="dock"]');
  const stage = document.querySelector('[data-tour="canvas"] [class*="viewport"]');
  const d = dock.getBoundingClientRect();
  const s = stage.getBoundingClientRect();
  return {
    detent: document.documentElement.dataset.sheet ?? "(none)",
    sheetTop: Math.round(d.top),
    sheetH: Math.round(d.height),
    sheetW: Math.round(d.width),
    /* The stage above the sheet — what you can still see of the picture. */
    freeH: Math.round(Math.max(0, Math.min(s.bottom, d.top) - s.top)),
    vh: window.innerHeight,
    vw: window.innerWidth,
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

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
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
  await page.waitForTimeout(1000);
  await dismissStartCard(page);
  await page.keyboard.press("Control+Shift+N");
  await page.waitForTimeout(1200);
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })),
    });

  await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
  await page.waitForTimeout(900);

  const opened = await page.evaluate(GEOM);
  check("the panels open as a full-width sheet from the bottom",
    opened.sheetW >= opened.vw - 1 && opened.sheetTop > 100,
    `${opened.sheetW}×${opened.sheetH} with its top at y=${opened.sheetTop}`);
  check("…at the middle height, so a panel and the picture share the screen",
    opened.detent === "half", `data-sheet="${opened.detent}"`);

  const handle = page.locator("[data-sheet-handle]");
  check("there is a handle to take hold of", (await handle.count()) === 1);
  const hbox = await handle.boundingBox();
  check("…and it is a real target", hbox && hbox.height >= 20 && hbox.width > 100,
    hbox ? `${Math.round(hbox.width)}×${Math.round(hbox.height)}` : "none");

  // ------------------------------------------------ tap: every detent in turn
  /* A tap steps to the next height and wraps, so three taps from "half" visit
     full, peek and half again — which is every detent, by tap. */
  const seen = [];
  const measured = {};
  for (let i = 0; i < 3; i++) {
    await handle.click();
    await page.waitForTimeout(600);
    const g = await page.evaluate(GEOM);
    seen.push(g.detent);
    measured[g.detent] = g;
  }
  check("tapping the handle reaches all three heights",
    new Set(seen).size === 3, `taps visited: ${seen.join(" → ")}`);
  check("…and they are three DIFFERENT heights",
    new Set(Object.values(measured).map((g) => g.sheetH)).size === 3,
    Object.entries(measured).map(([k, g]) => `${k}=${g.sheetH}px`).join(", "));

  // ------------------------------------------------------ the item's headline
  const peek = measured.peek;
  check("at peek the canvas keeps at least 55% of the screen",
    peek && peek.freeH / peek.vh >= 0.55,
    peek ? `${peek.freeH}px of ${peek.vh} — ${Math.round((peek.freeH / peek.vh) * 100)}%` : "peek not measured");
  check("…which it never did as a side drawer",
    peek && peek.freeH > 0,
    "the drawer left 13% of the stage visible and none of it above the panel");

  // ------------------------------------------------------- drag, and snapping
  /* Dragged to nowhere in particular: it has to land on a detent, not stay
     wherever the finger stopped. */
  const toHalf = async () => {
    for (let i = 0; i < 4; i++) {
      if ((await page.evaluate(() => document.documentElement.dataset.sheet)) === "half") return;
      await handle.click();
      await page.waitForTimeout(450);
    }
  };
  await toHalf();
  const before = await page.evaluate(GEOM);
  const hb = await handle.boundingBox();
  const hx = Math.round(hb.x + hb.width / 2);
  const hy = Math.round(hb.y + hb.height / 2);
  /* Far enough to clear the midpoint between half and full. A 112px drag from
     half ends at 534, which is nearer 422 than 692 — so it snapped back to
     half, correctly, and read as "dragging up does nothing". */
  await touch("touchStart", [{ x: hx, y: hy }]);
  for (let i = 1; i <= 16; i++) await touch("touchMove", [{ x: hx, y: hy - i * 20 }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(700);
  const afterUp = await page.evaluate(GEOM);
  check("dragging the handle up makes the sheet taller",
    afterUp.sheetH > before.sheetH, `${before.sheetH}px → ${afterUp.sheetH}px`);
  check("…and it lands on a detent rather than wherever the finger stopped",
    ["peek", "half", "full"].includes(afterUp.detent) &&
      Math.abs(afterUp.sheetH - (measured[afterUp.detent]?.sheetH ?? -1)) <= 2,
    `data-sheet="${afterUp.detent}" at ${afterUp.sheetH}px (that detent measures ${measured[afterUp.detent]?.sheetH}px)`);

  const hb2 = await handle.boundingBox();
  const hx2 = Math.round(hb2.x + hb2.width / 2);
  const hy2 = Math.round(hb2.y + hb2.height / 2);
  await touch("touchStart", [{ x: hx2, y: hy2 }]);
  for (let i = 1; i <= 12; i++) await touch("touchMove", [{ x: hx2, y: hy2 + i * 24 }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(700);
  const afterDown = await page.evaluate(GEOM);
  check("dragging it down makes it shorter, and snaps too",
    afterDown.sheetH < afterUp.sheetH && ["peek", "half", "full"].includes(afterDown.detent),
    `${afterUp.sheetH}px → ${afterDown.sheetH}px, data-sheet="${afterDown.detent}"`);

  // ------------------------------------------------- the panels still work --
  await toHalf();
  const panelWorks = await page.evaluate(async () => {
    const caret = [...document.querySelectorAll('[data-tour="dock"] button[class*="panelCaret"]')].find(
      (c) => (c.getAttribute("aria-label") || "").startsWith("Expand"),
    );
    if (!caret) return "no collapsed panel to open";
    const label = caret.getAttribute("aria-label");
    caret.click();
    await new Promise((r) => setTimeout(r, 600));
    return caret.getAttribute("aria-label") === label ? "did not toggle" : "ok";
  });
  check("a panel still opens from inside the sheet", panelWorks === "ok", panelWorks);

  /* And the artwork above it is still live: the panels sheet deliberately has
     no scrim, because dimming the thing the panel describes would undo this. */
  const canvasLive = await page.evaluate(() => {
    const stage = document.querySelector('[data-tour="canvas"] [class*="viewport"]');
    const dock = document.querySelector('[data-tour="dock"]');
    const r = stage.getBoundingClientRect();
    const y = Math.round(Math.min(r.bottom, dock.getBoundingClientRect().top) - 40);
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), y);
    return {
      y,
      tag: hit ? hit.tagName.toLowerCase() : "none",
      inCanvas: !!hit?.closest('[data-tour="canvas"]'),
      /* Visibility, not existence: the scrim is still rendered for the tools
         drawer and is hidden by CSS for this one. */
      scrim: (() => {
        const el = document.querySelector(".gq-m-scrim");
        return !!el && getComputedStyle(el).display !== "none";
      })(),
    };
  });
  check("the picture above the sheet is still touchable",
    canvasLive.inCanvas, `a tap at y=${canvasLive.y} hits <${canvasLive.tag}>`);
  check("…and is not dimmed by a scrim", !canvasLive.scrim,
    canvasLive.scrim ? "a scrim is showing over the artwork" : "no scrim showing");

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await context.close();
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
