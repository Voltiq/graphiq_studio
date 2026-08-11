/* Interaction performance harness (see TODO §8).
 *
 *   npm i -D playwright-core          (not a project dependency — dev tooling only)
 *   npm run dev                       (the harness drives http://localhost:3000)
 *   node tools/profile-perf.js
 *
 * Uses the installed Edge via `channel: "msedge"`, so it needs no browser download.
 *
 * Scripts the two gestures that block worst and reports MAIN-THREAD BLOCKING via
 * PerformanceObserver('longtask') — the thing that actually makes a UI feel
 * stuck. Frame intervals are also printed but mean little in headless Chrome,
 * where rAF runs unthrottled (a 4 ms "median frame" is the harness, not the app).
 *
 *   A: sweeping the triangle-marquee Apex slider.
 *   B: moving a selection with, and without, a blur smart filter.
 *
 * Baseline (flood-filled 1920×1080, headless Edge):
 *
 *                        2026-08-11 (before draft-res live filters)
 *   move, no filters     847 ms wall,   0 long tasks
 *   move, one blur       5596 ms wall, 26 long tasks / 4684 ms blocking
 *   apex sweep (30)      1217 ms wall,  0 long tasks
 *
 *                        2026-08-11 (after — engine draftScale/renderFilteredDraft)
 *   move, no filters     850 ms wall,   0 long tasks
 *   move, one blur       2011 ms wall,  1 long task  /   69 ms blocking
 *   apex sweep (30)      1231 ms wall,  0 long tasks
 */
const { chromium } = require("playwright-core");

const skipTour = async (page) => {
  const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 }).catch(() => null);
  if (t) {
    await page.keyboard.press("Escape");
    await page.waitForSelector('div[aria-label="Interactive tour"]', { state: "detached", timeout: 5000 });
  }
};

const INSTRUMENT = () => {
  const w = window;
  w.__perf = { long: [], frames: [], on: false };
  new PerformanceObserver((list) => {
    if (!w.__perf.on) return;
    for (const e of list.getEntries()) w.__perf.long.push(Math.round(e.duration));
  }).observe({ entryTypes: ["longtask"] });
  let last = 0;
  const tick = (t) => {
    if (w.__perf.on && last) w.__perf.frames.push(Math.round(t - last));
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
  w.__perfStart = () => {
    w.__perf.long = [];
    w.__perf.frames = [];
    w.__perf.on = true;
  };
  w.__perfStop = () => {
    w.__perf.on = false;
    const f = w.__perf.frames.slice().sort((a, b) => a - b);
    const long = w.__perf.long;
    return {
      frames: f.length,
      medianFrameMs: f.length ? f[f.length >> 1] : 0,
      p95FrameMs: f.length ? f[Math.floor(f.length * 0.95)] : 0,
      worstFrameMs: f.length ? f[f.length - 1] : 0,
      longTasks: long.length,
      longTaskTotalMs: long.reduce((a, b) => a + b, 0),
      worstLongTaskMs: long.length ? Math.max(...long) : 0,
    };
  };
};

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript(INSTRUMENT);
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  await skipTour(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);

  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const menu = async (top, item) => {
    await page.getByText(top, { exact: true }).first().click();
    await page.waitForTimeout(180);
    await page.getByText(item, { exact: true }).first().click();
    await page.waitForTimeout(500);
  };
  const measure = async (label, fn) => {
    await page.evaluate(() => window.__perfStart());
    const t0 = Date.now();
    await fn();
    const wall = Date.now() - t0;
    const r = await page.evaluate(() => window.__perfStop());
    console.log(
      `${label}\n` +
        `   wall ${wall} ms · frames ${r.frames} · median ${r.medianFrameMs} ms · p95 ${r.p95FrameMs} ms · worst ${r.worstFrameMs} ms\n` +
        `   long tasks ${r.longTasks} (total ${r.longTaskTotalMs} ms, worst ${r.worstLongTaskMs} ms)`,
    );
    return r;
  };

  // A canvas with real content to composite.
  await menu("Layer", "New layer");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(700);

  console.log("=== A. Triangle-marquee Apex slider ===");
  // Triangle marquee, dragged out, then the Apex slider swept.
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("m");
  await page.waitForTimeout(200);
  // TWO presses, not three: the cycle is rect → ellipse → triangle → rect, so
  // three lands back on rectangle and the "Apex" slider never appears.
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Shift+M");
    await page.waitForTimeout(200);
  }
  const shapeLabel = await page.locator('[data-tour="options"] [class*="toolBadge"]').first().textContent();
  console.log(`   (marquee shape now: ${shapeLabel.trim()})`);
  await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.85, { steps: 12 });
  await page.mouse.up();
  await page.waitForTimeout(600);

  const apex = page.locator('[data-tour="options"] input[type="range"][aria-label="Apex"]').first();
  const hasApex = (await apex.count()) > 0;
  console.log(`   apex slider present: ${hasApex}`);
  if (!hasApex) {
    const labels = await page.evaluate(() =>
      [...document.querySelectorAll('[data-tour="options"] input[type="range"]')].map((i) =>
        i.getAttribute("aria-label"),
      ),
    );
    console.log(`   (sliders found: ${JSON.stringify(labels)})`);
  }
  if (hasApex) {
    const ab = await apex.boundingBox();
    await measure("A1. sweeping the Apex slider (30 pointer steps)", async () => {
      await page.mouse.move(ab.x + ab.width * 0.5, ab.y + ab.height / 2);
      await page.mouse.down();
      for (let i = 0; i <= 30; i++) {
        await page.mouse.move(ab.x + ab.width * (0.15 + (0.7 * i) / 30), ab.y + ab.height / 2);
      }
      await page.mouse.up();
      await page.waitForTimeout(300);
    });
  }

  console.log("\n=== B. Moving a selection ===");
  // Baseline: a plain rectangular selection moved with no effects/filters.
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("m");
  await page.waitForTimeout(200);
  await page.keyboard.press("Shift+M"); // back to rectangle
  await page.waitForTimeout(200);
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(500);

  const dragSelection = async () => {
    await page.mouse.move(box.x + 30, box.y + 30);
    await page.keyboard.press("v"); // move tool
    await page.waitForTimeout(250);
    await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
    await page.mouse.down();
    for (let i = 1; i <= 25; i++) {
      await page.mouse.move(box.x + box.width * (0.5 + 0.008 * i), box.y + box.height * (0.5 + 0.006 * i));
    }
    await page.mouse.up();
    await page.waitForTimeout(400);
  };
  const base = await measure("B1. move selection — no effects, no filters", dragSelection);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(600);

  // Add a smart filter (blur) to the layer.
  await menu("Effects", "Blur (smart filter)");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
  const withFilter = await measure("B2. move selection — WITH a blur smart filter", dragSelection);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(600);

  console.log("\n=== summary ===");
  if (base.medianFrameMs && withFilter.medianFrameMs) {
    console.log(
      `median frame: ${base.medianFrameMs} ms → ${withFilter.medianFrameMs} ms ` +
        `(${(withFilter.medianFrameMs / base.medianFrameMs).toFixed(1)}× slower with one smart filter)`,
    );
  }
  await browser.close();
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
