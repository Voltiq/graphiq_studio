/* The edge strips, and what they cost the canvas.
 *
 * Two 20px strips host the swipe that opens a drawer. They sit exactly where
 * iOS and Android put the system back gesture, so the swipe is unreliable on
 * both — which is why the MobileBar's buttons are the primary route and these
 * are a secondary one. The measurable cost is that they take the outer 20px of
 * each side from the canvas: `elementFromPoint` at x=4 returns the strip.
 *
 * There is no clean win available here; the honest one is that they stand aside
 * the moment a drag is live on the canvas, so a stroke that began inland can
 * run out to the very edge and a second finger landing there belongs to the
 * canvas. What is NOT fixed, and is asserted here so it stays visible: a stroke
 * still cannot BEGIN in the outer 20px while the strips are armed.
 *
 * Run: node tools/verify-edge-swipe.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

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
  /* A fresh phone opens on the launch card, which covers the canvas area — so
     every hit test below would land on it rather than on the strips or the
     artwork. A user starts blank; so does this. */
  await dismissStartCard(page);

  const Y = 500;
  const whatIsAt = (x, y) =>
    page.evaluate(
      ([x, y]) => {
        const el = document.elementFromPoint(x, y);
        if (!el) return "nothing";
        if (el.classList.contains("gq-m-edge")) return `strip:${el.dataset.side}`;
        return el.closest('[data-tour="canvas"]') ? "canvas" : el.getAttribute("data-tour") || el.tagName;
      },
      [x, y],
    );
  const drawer = () => page.evaluate(() => document.documentElement.dataset.drawer ?? "");
  const inkCount = () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-tour="canvas"] canvas');
      const d = c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4 * 37) if (d[i] > 8) n++;
      return n;
    });

  // ---------- 1. what the strips take while they are armed ----------
  check("the edge belongs to the strip, not the canvas",
    (await whatIsAt(4, Y)) === "strip:left" && (await whatIsAt(386, Y)) === "strip:right",
    `x=4 → ${await whatIsAt(4, Y)}, x=386 → ${await whatIsAt(386, Y)}`);
  check("…and only the outer 20px of it", (await whatIsAt(30, Y)) === "canvas",
    `x=30 → ${await whatIsAt(30, Y)}`);

  // ---------- 2. a slow edge drag opens a drawer and paints nothing ----------
  const before = await inkCount();
  await page.mouse.move(4, Y);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(4 + i * 6, Y);
    await page.waitForTimeout(30);
  }
  await page.mouse.up();
  await page.waitForTimeout(800);
  const after = await inkCount();
  check("a slow drag from the edge paints nothing", after === before, `ink ${before} → ${after}`);
  check("…and opens the drawer instead", (await drawer()) === "tools", `data-drawer="${await drawer()}"`);

  // Put it back, so the strips are armed again.
  await page.evaluate(() => window.history.back());
  await page.waitForTimeout(800);
  check("back closes it again, leaving the strips armed",
    (await drawer()) === "" && (await whatIsAt(4, Y)) === "strip:left",
    `data-drawer="${await drawer()}", x=4 → ${await whatIsAt(4, Y)}`);

  // ---------- 3. during a live drag the canvas owns the whole width ----------
  await page.mouse.move(200, Y);
  await page.mouse.down();
  await page.mouse.move(160, Y);
  await page.waitForTimeout(150);
  const grabbed = await page.evaluate(() => document.documentElement.dataset.toolgrab ?? "");
  const edgeDuringDrag = await whatIsAt(4, Y);
  const rightDuringDrag = await whatIsAt(386, Y);
  await page.mouse.move(4, Y);
  await page.mouse.up();
  await page.waitForTimeout(600);
  check("a live drag marks the canvas as holding the pointer", grabbed === "true",
    `data-toolgrab="${grabbed}"`);
  check("…so a pointer at x=4 reaches the canvas mid-drag",
    edgeDuringDrag === "canvas" && rightDuringDrag === "canvas",
    `x=4 → ${edgeDuringDrag}, x=386 → ${rightDuringDrag}`);
  check("…and the strips are armed again once the drag ends",
    (await page.evaluate(() => document.documentElement.dataset.toolgrab ?? "")) === "" &&
      (await whatIsAt(4, Y)) === "strip:left",
    `x=4 → ${await whatIsAt(4, Y)}`);
  check("…and dragging out to the edge did not open a drawer", (await drawer()) === "",
    `data-drawer="${await drawer()}"`);

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
