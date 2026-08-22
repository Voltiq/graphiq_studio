/* A second finger cancels the first one's gesture — completely.
 *
 * A pinch pre-empts whatever a one-finger drag had started, and the danger is
 * not the gesture that visibly stops. It is the one still holding state that
 * the pointer-up will happily COMMIT: a Move survived the pinch, so lifting off
 * baked the layer wherever the finger happened to be, as a real edit, with a
 * history entry to match.
 *
 * Both things are asserted, because either alone can pass on broken code: the
 * pixels have to be where they started AND the history has to be the length it
 * was. A move that is silently reverted but still recorded is a phantom undo
 * step; one that is recorded but not reverted is the original bug.
 *
 * The setup proves itself first — the same drag WITHOUT a pinch must move the
 * layer and add a step, or the check would be measuring a drag that never did
 * anything.
 *
 * Run: node tools/verify-pinch-abort.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

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
  await page.waitForTimeout(800);
  const cdp = await context.newCDPSession(page);

  // A layer with a blob of paint on it, so "did it move" is answerable.
  await page.keyboard.press("Control+Shift+N");
  await page.waitForTimeout(1200);
  await page.keyboard.press("b");
  await page.waitForTimeout(300);
  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);
  await page.mouse.move(cx - 30, cy - 30);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(cx - 30 + i * 6, cy - 30 + i * 5);
  await page.mouse.up();
  await page.waitForTimeout(900);

  /** Where the ink sits, as a centroid over the whole document. */
  const inkCentre = () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-tour="canvas"] canvas');
      const d = c.getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, c.width, c.height).data;
      let n = 0, sx = 0, sy = 0;
      for (let i = 0; i < d.length; i += 4 * 11) {
        if (d[i + 3] > 8) {
          const px = (i / 4) % c.width;
          const py = Math.floor(i / 4 / c.width);
          sx += px; sy += py; n++;
        }
      }
      return n ? `${Math.round(sx / n)},${Math.round(sy / n)}` : "none";
    });
  /** How many steps the History panel lists. */
  const historySteps = async () => {
    if ((await page.evaluate(() => document.documentElement.dataset.drawer ?? "")) !== "panels")
      await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
    await page.waitForTimeout(600);
    const expand = page.locator('[data-tour="dock"] button[aria-label="Expand History"]');
    if (await expand.count()) {
      await expand.first().click();
      await page.waitForTimeout(500);
    }
    const n = await page.evaluate(() => {
      const section = [...document.querySelectorAll('[data-tour="dock"] section')].find((s) =>
        (s.querySelector('button[class*="panelCaret"]')?.getAttribute("aria-label") || "").endsWith("History"),
      );
      return section ? section.querySelectorAll("li, [class*='historyRow'], [class*='step']").length : -1;
    });
    await page.evaluate(() => window.history.back());
    await page.waitForTimeout(600);
    return n;
  };

  await page.keyboard.press("v"); // move tool
  await page.waitForTimeout(400);

  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p) => ({ x: Math.round(p.x), y: Math.round(p.y) })),
    });

  // ---------- the setup proves itself: a plain drag DOES move and record ----------
  const inkBefore = await inkCentre();
  const stepsBefore = await historySteps();
  await touch("touchStart", [{ x: cx, y: cy }]);
  for (let i = 1; i <= 6; i++) await touch("touchMove", [{ x: cx + i * 9, y: cy }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(1000);
  const inkMoved = await inkCentre();
  const stepsMoved = await historySteps();
  check("a one-finger drag moves the layer", inkMoved !== inkBefore,
    `ink centre ${inkBefore} → ${inkMoved}`);
  check("…and records a step for it", stepsMoved > stepsBefore,
    `history ${stepsBefore} → ${stepsMoved}`);

  // ---------- the real case: a pinch mid-drag ----------
  const inkArmed = await inkCentre();
  const stepsArmed = await historySteps();
  await touch("touchStart", [{ x: cx, y: cy }]);
  for (let i = 1; i <= 5; i++) await touch("touchMove", [{ x: cx + i * 10, y: cy }]);
  // …and now a second finger lands, and the two pinch apart.
  await touch("touchStart", [{ x: cx + 50, y: cy }, { x: cx - 50, y: cy }]);
  await page.waitForTimeout(150);
  for (let i = 1; i <= 5; i++)
    await touch("touchMove", [
      { x: cx + 50 + i * 8, y: cy },
      { x: cx - 50 - i * 8, y: cy },
    ]);
  await touch("touchEnd", []);
  await page.waitForTimeout(1200);

  const inkAfter = await inkCentre();
  const stepsAfter = await historySteps();
  check("the pinch leaves the layer where it was", inkAfter === inkArmed,
    `ink centre ${inkArmed} → ${inkAfter}`);
  check("…and writes no history entry for the abandoned move", stepsAfter === stepsArmed,
    `history ${stepsArmed} → ${stepsAfter}`);

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
