/* What a brush stroke on a filtered layer costs: region-scoped vs draft.
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/bench-livefilter.js
 *
 * THE THING BEING MEASURED. A live paint session cannot use the smart-filter
 * worker (it keys jobs by node key, and a live source has no key that describes
 * it), so every live frame runs the stack on the MAIN THREAD. renderFilteredDraft
 * shrinks that to a quarter-resolution pass over the whole document; the region
 * path instead filters the stroke's own dirty rect at FULL resolution and patches
 * it into a per-session copy of the settled product.
 *
 * WHY BOTH ARMS RUN IN ONE SITTING. Absolute wall-clock does not travel on this
 * machine — the same build measured 167 ms and 835 ms an hour apart. The arms are
 * therefore INTERLEAVED, stroke by stroke, through the dev A/B toggle, and only
 * medians are compared.
 *
 * NON-VACUITY. Byte-identity is proved elsewhere (tools/verify-region-scope.js).
 * What this tool has to prove is that the region arm ACTUALLY TOOK the region
 * path: liveRegionHits must move in arm A and stay put in arm B, and arm B must
 * report the draft frames arm A avoided. All three are asserted; a run that fails
 * them exits non-zero however good the milliseconds look.
 *
 * BASELINE, 4000x3000 with one gaussian blur smart filter, 160 px brush,
 * 20-step strokes (2026-08-19), across two sittings:
 *   MEDIAN blocking     region 51-118 ms   draft 2174-2293 ms   (95-98% less)
 *   worst single task   region  51- 55 ms   draft  111- 120 ms
 *   region frames filtered 204,215 px each against 750,000 for one draft frame
 *   (27.2%) — and at FULL resolution, so the draft's downscale/upscale softness
 *   is gone from the preview as well.
 * The range is not sloppiness: the reference loop read 5 ms in one sitting and
 * 2.7 ms in the other, i.e. the machine itself was twice as slow. Do not compare
 * these milliseconds against another run's — the RATIO is what travels, which is
 * why the arms are interleaved rather than measured separately.
 */
const { launchBrowser } = require("./lib/launch");

const DOC_W = 4000;
const DOC_H = 3000;
const STROKES = 5; // per arm, the first of which is discarded as warm-up

const INSTRUMENT = () => {
  const w = window;
  w.__perf = { long: [], on: false };
  new PerformanceObserver((l) => {
    if (w.__perf.on) for (const e of l.getEntries()) w.__perf.long.push(Math.round(e.duration));
  }).observe({ entryTypes: ["longtask"] });
  w.__perfStart = () => {
    w.__perf.long = [];
    w.__perf.on = true;
  };
  w.__perfStop = () => {
    w.__perf.on = false;
    const L = w.__perf.long;
    return { n: L.length, total: L.reduce((a, b) => a + b, 0), worst: L.length ? Math.max(...L) : 0 };
  };
  /* A reference primitive measured in THIS process, so the numbers can be read
     on another machine (the tools/bench-track.js calibration rule). */
  w.__ref = () => {
    const buf = new Float64Array(200000);
    const t = performance.now();
    for (let r = 0; r < 20; r++) for (let i = 0; i < buf.length; i++) buf[i] = i * 1.0001;
    return Math.round((performance.now() - t) * 10) / 10;
  };
};

(async () => {
  const browser = await launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.addInitScript(INSTRUMENT);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 }).catch(() => null);
  if (t) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);

  const menu = async (a, b) => {
    await page.getByText(a, { exact: true }).first().click();
    await page.waitForTimeout(230);
    await page.getByText(b, { exact: true }).first().click();
    await page.waitForTimeout(800);
  };
  await menu("File", "New…");
  const nd = page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.waitFor({ timeout: 8000 });
  await nd.locator('input[type="number"]').nth(0).fill(String(DOC_W));
  await nd.locator('input[type="number"]').nth(1).fill(String(DOC_H));
  await nd.getByText("Create", { exact: true }).click();
  await page.waitForTimeout(2500);

  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  await menu("Layer", "New layer");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1800);
  await page.keyboard.press("b");
  await page.waitForTimeout(250);
  /* Set Size through the options bar, not `]` — the shortcut does not reach the
     engine from Playwright (24 before, 24 after 26 presses). It matters here and
     not only in the correctness rail: the brush size IS the dirty rect, and a
     24 px stroke would hand the region arm a flatteringly small region. 160 px
     is a realistic retouching brush on a 12 MP document. */
  await page
    .locator('[data-tour="options"] input[aria-label="Size"]')
    .first()
    .evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "160");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await page.waitForTimeout(400);
  const brush = await page.locator('[data-tour="options"] input[aria-label="Size"]').first().inputValue();
  console.log(`brush size ${brush}`);

  await menu("Effects", "Blur (smart filter)");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(2500);

  const stats = () => page.evaluate(() => window.__gqRenderCache.stats());
  const stroke = async (on, fy) => {
    await page.evaluate((o) => (o ? window.__gqRenderCache.regionOn() : window.__gqRenderCache.regionOff()), on);
    await page.waitForTimeout(300);
    const s0 = await stats();
    await page.evaluate(() => window.__perfStart());
    await page.mouse.move(box.x + box.width * 0.22, box.y + box.height * fy);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++)
      await page.mouse.move(box.x + box.width * (0.22 + 0.022 * i), box.y + box.height * fy);
    await page.mouse.up();
    await page.waitForTimeout(2600); // let the settled full-res pass land
    const r = await page.evaluate(() => window.__perfStop());
    const s1 = await stats();
    return {
      total: r.total,
      worst: r.worst,
      hits: s1.liveRegionHits - s0.liveRegionHits,
      px: s1.liveRegionPx - s0.liveRegionPx,
      drafts: s1.liveDraftFrames - s0.liveDraftFrames,
    };
  };

  const ref = await page.evaluate(() => window.__ref());
  console.log(`\nLive filter frames on a ${DOC_W}x${DOC_H} document, one gaussian blur`);
  console.log(`(interleaved arms, reference loop ${ref} ms)\n`);
  const A = [];
  const B = [];
  let fy = 0.16;
  for (let s = 0; s < STROKES; s++) {
    const a = await stroke(true, (fy += 0.055));
    const b = await stroke(false, (fy += 0.055));
    A.push(a);
    B.push(b);
    const tag = s === 0 ? "   (warm-up, discarded)" : "";
    console.log(
      `  stroke ${s + 1}  region ${String(a.total).padStart(4)} ms (${a.hits} region frames, ${a.drafts} drafts)` +
        `   draft ${String(b.total).padStart(4)} ms (${b.hits} region frames, ${b.drafts} drafts)${tag}`,
    );
  }
  const med = (a) => {
    const b = [...a].sort((x, y) => x - y);
    return b[Math.floor(b.length / 2)];
  };
  const mA = med(A.slice(1).map((r) => r.total));
  const mB = med(B.slice(1).map((r) => r.total));
  const hits = A.reduce((n, r) => n + r.hits, 0);
  const apx = A.reduce((n, r) => n + r.px, 0);
  const draftPx = Math.round(DOC_W * 0.25) * Math.round(DOC_H * 0.25);
  console.log(
    `\n  MEDIAN blocking    region ${mA} ms   draft ${mB} ms` +
      `   (${mB ? ((1 - mA / mB) * 100).toFixed(0) : "?"}% less)`,
  );
  console.log(
    `  worst single task  region ${med(A.slice(1).map((r) => r.worst))} ms   ` +
      `draft ${med(B.slice(1).map((r) => r.worst))} ms`,
  );
  if (hits)
    console.log(
      `  region frames ${hits}, ${Math.round(apx / hits).toLocaleString()} px each ` +
        `vs ${draftPx.toLocaleString()} px for one draft frame ` +
        `(${((apx / hits / draftPx) * 100).toFixed(1)}%), and at FULL resolution`,
    );

  let fail = 0;
  const need = (ok, msg) => {
    if (!ok) {
      fail++;
      console.log(`  FAILED: ${msg}`);
    }
  };
  need(hits > 0, "the region arm never took the region path — every millisecond above is vacuous");
  need(B.every((r) => r.hits === 0), "the draft arm took the region path — the A/B toggle did nothing");
  need(B.some((r) => r.drafts > 0), "the draft arm rendered no draft frames — it measured something else");
  if (errors.length) console.log("\nERRORS: " + errors.slice(0, 4).join(" | "));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
