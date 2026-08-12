/* The settled FULL-RESOLUTION layer-effects pass on a large document — the one
 * place the blur kernel still dominates main-thread time.
 *
 *   npm i -D playwright-core   &&   npm run dev   &&   node tools/bench-bigdoc.js
 *
 * WHY A BIG DOCUMENT. Draft resolution already covers the live gesture, and the
 * kernel is a running-sum box blur, i.e. O(w·h) REGARDLESS of radius (measured:
 * radius 250 costs 1.04x radius 5). So neither "during the drag" nor "big blur"
 * is the variable that matters — DOCUMENT SIZE is. At 1920x1080 one
 * gaussianChannel is ~31 ms; at 4000x3000 it is ~250 ms.
 *
 * Ignore the first stroke: it carries JIT warm-up and runs ~50% high. Strokes
 * 2-5 land within a few ms of each other, which is why this reports a median.
 *
 * BASELINE, 4000x3000, one default drop shadow, stroke + settled full-res pass:
 *   column-at-a-time vertical blur pass   419 ms blocking (worst task 419 ms)
 *   cache-blocked vertical pass           323 ms blocking (worst task 323 ms)
 * The remaining ~323 ms is NOT the kernel — it is renderStyled's fixed setup
 * (full-canvas getImageData + a 48 MB Float32Array alpha buffer at this size).
 * That, not a faster blur, is where the next win is.
 */
const { chromium } = require("playwright-core");
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
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.addInitScript(INSTRUMENT);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 }).catch(() => null);
  if (t) { await page.keyboard.press("Escape"); await page.waitForTimeout(700); }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);
  const menu = async (a, b) => {
    await page.getByText(a, { exact: true }).first().click();
    await page.waitForTimeout(200);
    await page.getByText(b, { exact: true }).first().click();
    await page.waitForTimeout(700);
  };

  // --- a 4000x3000 document ---
  await menu("File", "New…");
  const dlg = page.locator('div[role="dialog"][aria-label="New document"]');
  await dlg.waitFor({ timeout: 8000 });
  const nums = dlg.locator('input[type="number"]');
  await nums.nth(0).fill("4000");
  await nums.nth(1).fill("3000");
  await dlg.getByText("Create", { exact: true }).click();
  await page.waitForTimeout(2500);

  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const size = await page.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    return c ? `${c.width}x${c.height}` : "?";
  });
  console.log("document canvas:", size);

  await menu("Layer", "New layer");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(200);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1500);
  await page.keyboard.press("b");
  await page.waitForTimeout(200);
  for (let i = 0; i < 26; i++) await page.keyboard.press("]");
  await page.waitForTimeout(300);

  await menu("Layer", "Layer style…");
  await page.waitForTimeout(1000);
  const ds = page.locator('button[aria-label="Drop Shadow off"]').first();
  if (!(await ds.count())) throw new Error("Drop Shadow toggle not found");
  await ds.click();
  await page.waitForTimeout(1200);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);

  // Several strokes, each measured with its own settle. Single runs vary by
  // 25%+ on this machine, so report the median rather than one number.
  const totals = [], worsts = [];
  for (let s = 0; s < 5; s++) {
    const fy = 0.25 + s * 0.1;
    await page.evaluate(() => window.__perfStart());
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * fy);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++)
      await page.mouse.move(box.x + box.width * (0.25 + 0.02 * i), box.y + box.height * fy);
    await page.mouse.up();
    await page.waitForTimeout(2500); // let the full-res pass settle
    const r = await page.evaluate(() => window.__perfStop());
    totals.push(r.total); worsts.push(r.worst);
    console.log(`  stroke ${s + 1}: ${String(r.total).padStart(4)} ms blocking, worst task ${r.worst} ms`);
  }
  const med = (a) => { const b = [...a].sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  console.log(`MEDIAN blocking ${med(totals)} ms | MEDIAN worst task ${med(worsts)} ms`);
  if (errors.length) console.log("ERRORS:", errors.join("; "));
  await browser.close();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
