/* Where the shared separable blur actually costs (TODO §8 P2).
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/bench-blur.js
 *
 *   A. stroke on a plain layer                     (no blur at all)
 *   B. stroke on a layer with a blur SMART FILTER  (draft path)
 *   C. stroke on a layer with a DROP SHADOW        (renderStyled)
 *   D. same, shadow size cranked to maximum        (~20× bigger kernel)
 *
 * The C vs D pair is the point: if a far bigger kernel costs about the same,
 * the kernel is not the bottleneck — the per-call full-canvas setup is, and a
 * GPU kernel would not have helped.
 *
 * 1920×1080, headless Edge, 20-step stroke:
 *
 *                     before draft-res effects   after
 *   A. plain                      0 ms            0 ms
 *   B. smart filter             227 ms           72 ms
 *   C. drop shadow (default)   1390 ms           64 ms
 *   D. drop shadow (size 250)  1450 ms           67 ms
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
    await page.waitForTimeout(600);
  };
  const measure = async (label, fn) => {
    await page.evaluate(() => window.__perfStart());
    const t0 = Date.now();
    await fn();
    const wall = Date.now() - t0;
    const r = await page.evaluate(() => window.__perfStop());
    console.log(`${label}\n   wall ${wall} ms · long tasks ${r.n} · blocking ${r.total} ms · worst ${r.worst} ms`);
    return { wall, ...r };
  };
  const stroke = async (fy) => {
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * fy);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++)
      await page.mouse.move(box.x + box.width * (0.25 + 0.02 * i), box.y + box.height * fy);
    await page.mouse.up();
    await page.waitForTimeout(600);
  };

  await menu("Layer", "New layer");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(700);
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("b");
  await page.waitForTimeout(250);
  for (let i = 0; i < 26; i++) await page.keyboard.press("]");
  await page.waitForTimeout(200);

  await measure("A. plain layer", () => stroke(0.25));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);

  // ---- B. blur smart filter (already on the draft path) ----
  await menu("Effects", "Blur (smart filter)");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
  await measure("B. blur SMART FILTER (draft path)", () => stroke(0.35));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);
  // Remove it again so C measures effects alone.
  await menu("Layer", "New layer");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(200);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(600);
  await page.keyboard.press("b");
  await page.waitForTimeout(200);

  // ---- C. drop shadow (renderStyled, inline) ----
  await menu("Layer", "Layer style…");
  await page.waitForTimeout(900);
  const ds = page.locator('button[aria-label="Drop Shadow off"]').first();
  if (await ds.count()) { await ds.click(); await page.waitForTimeout(700); }
  console.log(`   (drop shadow on: ${(await page.locator('button[aria-label="Drop Shadow on"]').count()) > 0})`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
  await measure("C. DROP SHADOW, default size", () => stroke(0.5));
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(500);

  // ---- D. large drop shadow ----
  await menu("Layer", "Layer style…");
  await page.waitForTimeout(900);
  const sliders = page.locator('[role="dialog"] input[type="range"]');
  const labels = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] input[type="range"]')].map((i) => i.getAttribute("aria-label")),
  );
  console.log(`   (style sliders: ${JSON.stringify(labels)})`);
  const sizeIdx = labels.findIndex((l) => l && /size/i.test(l));
  if (sizeIdx >= 0) {
    const s = sliders.nth(sizeIdx);
    const max = await s.evaluate((e) => e.max);
    await s.fill(String(max));
    await page.waitForTimeout(600);
    console.log(`   (shadow size set to ${max})`);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
  await measure("D. DROP SHADOW, max size", () => stroke(0.62));

  await browser.close();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
