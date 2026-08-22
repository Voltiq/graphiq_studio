/* Panning without giving up the tool.
 *
 * Every drawing and selection tool consumes the one-finger drag, so on a phone
 * moving the picture around meant switching to the Hand tool and back for each
 * adjustment. A Pan chip in the bottom bar takes that drag instead, and leaves
 * the selected tool exactly as it was.
 *
 * Both halves are asserted every time, because either alone is satisfiable by
 * something broken: a mode that pans but also paints is no better than before,
 * and a mode that paints nothing while not panning is just a dead canvas.
 *
 * Run: node tools/verify-pan-mode.js [--url ...] [--channel ...]
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

  await page.keyboard.press("Control+Shift+N"); // something to paint on
  await page.waitForTimeout(1200);
  await page.keyboard.press("b"); // brush
  await page.waitForTimeout(400);

  const panChip = page.locator('[data-tour="mobilebar"] button', { hasText: "Pan" }).first();
  const activeTool = () =>
    page.evaluate(
      () =>
        document
          .querySelector('[data-tour="toolbar"] button[aria-pressed="true"]')
          ?.getAttribute("aria-label") ?? "?",
    );
  /** Where the artwork sits inside the stage — the thing a pan moves. */
  const artworkAt = () =>
    page.evaluate(() => {
      const stage = document.querySelector('[data-tour="canvas"] [class*="viewport"]');
      const art = [...stage.querySelectorAll("*")]
        .filter((e) => getComputedStyle(e).transform !== "none")
        .map((e) => e.getBoundingClientRect())
        .filter((b) => b.width > 20 && b.width < stage.clientWidth)[0];
      const v = stage.getBoundingClientRect();
      return art ? `${Math.round(art.left - v.left)},${Math.round(art.top - v.top)}` : "none";
    });
  const inkCount = () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-tour="canvas"] canvas');
      const d = c.getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) n++;
      return n;
    });

  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const drag = async (fromX, fromY, toX, toY) => {
    await page.mouse.move(fromX, fromY);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++)
      await page.mouse.move(fromX + ((toX - fromX) * i) / 6, fromY + ((toY - fromY) * i) / 6);
    await page.mouse.up();
    await page.waitForTimeout(600);
  };

  check("the chip is in the bottom bar", await panChip.isVisible());
  check("the brush is the selected tool", (await activeTool()).toLowerCase().includes("brush"),
    `toolbar says "${await activeTool()}"`);

  // ---------- with the chip off: the brush paints ----------
  const inkStart = await inkCount();
  const artStart = await artworkAt();
  await drag(box.x + box.width * 0.35, box.y + box.height * 0.4, box.x + box.width * 0.6, box.y + box.height * 0.5);
  const inkAfterPaint = await inkCount();
  check("without the chip, a drag paints", inkAfterPaint > inkStart,
    `ink ${inkStart} → ${inkAfterPaint}`);
  check("…and does not move the picture", (await artworkAt()) === artStart,
    `artwork at ${artStart} → ${await artworkAt()}`);

  // ---------- chip on: the same drag pans, and paints nothing ----------
  await panChip.click();
  await page.waitForTimeout(400);
  check("tapping the chip turns pan on", (await panChip.getAttribute("aria-pressed")) === "true");
  check("…and the tool is untouched", (await activeTool()).toLowerCase().includes("brush"),
    `toolbar still says "${await activeTool()}"`);

  const inkBeforePan = await inkCount();
  const artBeforePan = await artworkAt();
  await drag(box.x + box.width * 0.4, box.y + box.height * 0.45, box.x + box.width * 0.7, box.y + box.height * 0.65);
  const artAfterPan = await artworkAt();
  const inkAfterPan = await inkCount();
  check("with the chip on, the same drag pans", artAfterPan !== artBeforePan,
    `artwork at ${artBeforePan} → ${artAfterPan}`);
  check("…and lays down no ink at all", inkAfterPan === inkBeforePan,
    `ink ${inkBeforePan} → ${inkAfterPan}`);

  // ---------- chip off again: painting resumes ----------
  await panChip.click();
  await page.waitForTimeout(400);
  check("tapping again turns it off", (await panChip.getAttribute("aria-pressed")) === "false");
  const artBeforeResume = await artworkAt();
  await drag(box.x + box.width * 0.3, box.y + box.height * 0.6, box.x + box.width * 0.5, box.y + box.height * 0.7);
  const inkResumed = await inkCount();
  check("painting resumes", inkResumed > inkAfterPan, `ink ${inkAfterPan} → ${inkResumed}`);
  check("…and that drag did not pan", (await artworkAt()) === artBeforeResume,
    `artwork at ${artBeforeResume} → ${await artworkAt()}`);

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
