/* Finishing what you started, on a device with no Enter and no Escape.
 *
 * A pen path, a crop, a transform and a text session are all in-progress state
 * that only those two keys resolve — so on a phone those tools could be started
 * and never finished. A ✓/✕ pair appears on the canvas while such a session is
 * live and sends exactly those keys, so every handler in the app stays as it
 * was; nothing learned a new way to be committed.
 *
 * The pair is CSS-gated on `html[data-commit]`, which CanvasArea publishes from
 * one predicate over all five sessions. That attribute is checked here too —
 * appearing and disappearing at the right moments is half the feature, and a
 * pair of buttons parked permanently over the picture would be the other kind
 * of failure.
 *
 * Run: node tools/verify-commit-cancel.js [--url ...] [--channel ...]
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

  const committable = () => page.evaluate(() => document.documentElement.dataset.commit ?? "");
  const pairVisible = () =>
    page.locator('[aria-label="Finish or cancel"]').isVisible().catch(() => false);
  /** How many paths the Paths panel lists. */
  const pathCount = async () => {
    if ((await page.evaluate(() => document.documentElement.dataset.drawer ?? "")) !== "panels")
      await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
    await page.waitForTimeout(700);
    const expand = page.locator('[data-tour="dock"] button[aria-label="Expand Paths"]');
    if (await expand.count()) {
      await expand.first().click();
      await page.waitForTimeout(500);
    }
    const n = await page.evaluate(() => {
      const section = [...document.querySelectorAll('[data-tour="dock"] section')].find((s) =>
        (s.querySelector('button[class*="panelCaret"]')?.getAttribute("aria-label") || "").endsWith("Paths"),
      );
      if (!section) return -1;
      /* A row per saved path; the empty state has none. */
      return section.querySelectorAll('[class*="pathRow"], li').length;
    });
    await page.evaluate(() => window.history.back());
    await page.waitForTimeout(700);
    return n;
  };

  // A layer to draw on, then the pen.
  await page.keyboard.press("Control+Shift+N");
  await page.waitForTimeout(1200);

  check("nothing is committable to begin with", (await committable()) === "", `data-commit="${await committable()}"`);
  check("…so the ✓/✕ pair is not on screen", (await pairVisible()) === false);

  const before = await pathCount();
  await page.keyboard.press("p"); // pen
  await page.waitForTimeout(500);
  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);
  const dot = async (dx, dy) => {
    await page.mouse.click(cx + dx, cy + dy);
    await page.waitForTimeout(350);
  };

  // ---------- a three-point path, thrown away with ✕ ----------
  /* CANCEL FIRST, from an empty Paths panel, because that is the only ordering
     in which the row count can tell the two apart. A path being drawn becomes
     the single reusable Work Path, so once one exists, committing a second
     REPLACES it and the count stays at 1 — an earlier version of this ran the
     cancel second and passed while ✕ was quietly committing. */
  await dot(-70, 60);
  await dot(70, 60);
  await dot(0, -60);
  check("a pen path in progress is committable", (await committable()) === "1",
    `data-commit="${await committable()}"`);
  check("…and the ✓/✕ pair appears for it", await pairVisible());

  await page.locator('[aria-label="Finish or cancel"] button[aria-label="Cancel"]').click();
  await page.waitForTimeout(1200);
  const afterCancel = await pathCount();
  check("tapping ✕ leaves nothing behind", afterCancel === before,
    `Paths panel: ${before} → ${afterCancel} row(s)`);
  check("…and the pair goes away with it", (await committable()) === "" && !(await pairVisible()),
    `data-commit="${await committable()}"`);

  // ---------- another one, finished with ✓ ----------
  await dot(-60, -40);
  await dot(60, -40);
  await dot(0, 50);
  check("a second path is in progress", (await committable()) === "1");
  await page.locator('[aria-label="Finish or cancel"] button[aria-label="Commit"]').click();
  await page.waitForTimeout(1200);
  const afterCommit = await pathCount();
  check("tapping ✓ finishes it, and it lands in the Paths panel", afterCommit > afterCancel,
    `Paths panel: ${afterCancel} → ${afterCommit} row(s)`);
  check("…and the pair goes away too", (await committable()) === "" && !(await pairVisible()));

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
