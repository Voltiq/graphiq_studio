/* Selection-path benchmark (TODO §8 P1).
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/bench-selection.js
 *
 * The C0 vs C pair is the useful part: PLAIN wand clicks take the "new" path
 * (flood fill + boundary trace, no combine) while add-clicks add
 * combineSelection, so the delta ATTRIBUTES the cost rather than guessing.
 *
 * Baseline 2026-08-11 (flood-filled 1920×1080, headless Edge), after the
 * combine buffer reuse — note the combine is the small part:
 *   A. quick-select drag (30)        221 ms blocking
 *   B. 12 add/subtract marquees        0 ms
 *   C0. 10 plain wand clicks         564 ms  (≈56 ms each: flood + trace)
 *   C.  10 wand add-clicks           637 ms  (≈64 ms each: + ~7 ms combine)
 *
 * ABSOLUTE NUMBERS HERE DO NOT TRAVEL. They are wall-clock on one machine with
 * no calibration reference (unlike tools/bench-track.js), and the same build
 * measured 167 ms and 835 ms for C0 within an hour of each other as this box
 * warmed up. Compare A/B in one sitting, never against a number from a previous
 * session.
 *
 * 2026-08-19, run-based boundary trace + scanline flood, measured back-to-back
 * against the previous build on a loaded machine:
 *   C0. 10 plain wand clicks   1032-1067 ms -> 832-840 ms  (worst 125 -> 109)
 *   C.  10 wand add-clicks     1142-1194 ms -> 555-614 ms  (worst 144 -> 88)
 * The add-click case gains most because combineSelection traces the union box
 * on every call, and that trace is now O(runs) rather than O(area).
 */
const { launchBrowser } = require("./lib/launch");

const INSTRUMENT = () => {
  const w = window;
  w.__perf = { long: [], on: false };
  new PerformanceObserver((l) => {
    if (w.__perf.on) for (const e of l.getEntries()) w.__perf.long.push(Math.round(e.duration));
  }).observe({ entryTypes: ["longtask"] });
  w.__perfStart = () => { w.__perf.long = []; w.__perf.on = true; };
  w.__perfStop = () => {
    w.__perf.on = false;
    const L = w.__perf.long;
    return { n: L.length, total: L.reduce((a, b) => a + b, 0), worst: L.length ? Math.max(...L) : 0 };
  };
};

(async () => {
  const browser = await launchBrowser();
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript(INSTRUMENT);
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 }).catch(() => null);
  if (t) { await page.keyboard.press("Escape"); await page.waitForTimeout(700); }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);
  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const menu = async (a, b) => {
    await page.getByText(a, { exact: true }).first().click();
    await page.waitForTimeout(200);
    await page.getByText(b, { exact: true }).first().click();
    await page.waitForTimeout(500);
  };
  const measure = async (label, fn) => {
    await page.evaluate(() => window.__perfStart());
    const t0 = Date.now();
    await fn();
    const wall = Date.now() - t0;
    const r = await page.evaluate(() => window.__perfStop());
    console.log(`${label}: wall ${wall} ms · long tasks ${r.n} · blocking ${r.total} ms · worst ${r.worst} ms`);
    return { wall, ...r };
  };

  // Some content so the wand / quick-select have edges to find.
  await menu("Layer", "New layer");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(700);

  // ---- A. quick-select brush drag ----
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("w");
  await page.waitForTimeout(200);
  await page.keyboard.press("Shift+W"); // wand → quick selection
  await page.waitForTimeout(300);
  await measure("A. quick-select drag (30 steps)", async () => {
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await page.mouse.down();
    for (let i = 1; i <= 30; i++)
      await page.mouse.move(box.x + box.width * (0.3 + 0.012 * i), box.y + box.height * (0.4 + 0.004 * i));
    await page.mouse.up();
    await page.waitForTimeout(500);
  });
  await page.keyboard.press("Control+d");
  await page.waitForTimeout(400);

  // ---- B. repeated add / subtract marquees ----
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("m");
  await page.waitForTimeout(250);
  await measure("B. 12 add/subtract marquees", async () => {
    for (let i = 0; i < 12; i++) {
      const mod = i % 2 === 0 ? ["Control"] : ["Alt"];
      const x = 0.2 + (i % 5) * 0.1;
      await page.keyboard.down(mod[0]);
      await page.mouse.move(box.x + box.width * x, box.y + box.height * 0.3);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * (x + 0.14), box.y + box.height * 0.62, { steps: 6 });
      await page.mouse.up();
      await page.keyboard.up(mod[0]);
      await page.waitForTimeout(120);
    }
  });
  await page.keyboard.press("Control+d");
  await page.waitForTimeout(400);

  // ---- C. wand clicks with add ----
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("w");
  await page.waitForTimeout(300);
  // PLAIN clicks take the "new" path: wand flood-fill + boundary trace, but NO
  // combineSelection. The delta against add-clicks is what the combine costs.
  await measure("C0. 10 plain wand clicks (no combine)", async () => {
    for (let i = 0; i < 10; i++) {
      await page.mouse.click(box.x + box.width * (0.2 + i * 0.06), box.y + box.height * 0.5);
      await page.waitForTimeout(150);
    }
  });
  await page.keyboard.press("Control+d");
  await page.waitForTimeout(400);
  await measure("C. 10 wand add-clicks (flood + combine + trace)", async () => {
    for (let i = 0; i < 10; i++) {
      await page.keyboard.down("Control");
      await page.mouse.click(box.x + box.width * (0.2 + i * 0.06), box.y + box.height * 0.5);
      await page.keyboard.up("Control");
      await page.waitForTimeout(150);
    }
  });

  await browser.close();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
