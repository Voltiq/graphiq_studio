/* Correctness rail for region-scoped change tracking AND draft-resolution live
 * rendering (TODO §8 P0).
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/verify-region-scope.js
 *
 * Two invariants, both of which have already caught real bugs:
 *
 *  1. A padded region is only allowed if the composite it produces is
 *     BYTE-IDENTICAL to a full recompute — an under-estimated reach shows up as
 *     a stale band at the edge of the re-blitted area.
 *  2. A gesture that painted DRAFT-resolution filters/effects must repaint the
 *     whole view on the frame that settles it, or draft pixels survive outside
 *     the last dirty rect. (This caught 15,470 differing bytes.)
 *
 * IMPORTANT — why the assertions are ordered as they are: byte-identity ALSO
 * holds when the region path never activates and everything silently takes the
 * full pass, so an early version passed while proving nothing. The padding is
 * therefore proved on an UNDO PATCH (a rect-bounded change with no live session,
 * hence no draft), where a region blit is still expected.
 */
const { chromium } = require("playwright-core");

const skipTour = async (page) => {
  const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 }).catch(() => null);
  if (t) {
    await page.keyboard.press("Escape");
    await page.waitForSelector('div[aria-label="Interactive tour"]', { state: "detached", timeout: 5000 });
  }
};

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  await skipTour(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);

  const results = [];
  const check = (name, cond, detail = "") => {
    results.push({ name, ok: !!cond, detail });
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };

  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const menu = async (top, item) => {
    await page.getByText(top, { exact: true }).first().click();
    await page.waitForTimeout(200);
    await page.getByText(item, { exact: true }).first().click();
    await page.waitForTimeout(600);
  };
  const grab = () =>
    page.evaluate(() => {
      const cv = document.querySelector('canvas[width="1920"]');
      const d = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
      // A cheap digest plus a copy for diffing.
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum = (sum + d[i] * 3 + d[i + 1] * 5 + d[i + 2] * 7 + d[i + 3] * 11) >>> 0;
      return { sum, bytes: Array.from(d.slice(0, 0)) };
    });
  /** Pixel-diff the live composite against a freshly forced full recompute. */
  const diffAgainstFullRecompute = async () => {
    const before = await page.evaluate(() => {
      const cv = document.querySelector('canvas[width="1920"]');
      const g = cv.getContext("2d", { willReadFrequently: true });
      window.__abBefore = g.getImageData(0, 0, cv.width, cv.height).data.slice();
      return true;
    });
    void before;
    // Force the always-correct uncached path, then make it recomposite.
    await page.evaluate(() => window.__gqRenderCache && window.__gqRenderCache.disable());
    await page.waitForTimeout(200);
    await page.keyboard.press("Control+z"); // any journalled change forces a recomposite
    await page.waitForTimeout(500);
    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(900);
    const diff = await page.evaluate(() => {
      const cv = document.querySelector('canvas[width="1920"]');
      const g = cv.getContext("2d", { willReadFrequently: true });
      const now = g.getImageData(0, 0, cv.width, cv.height).data;
      const was = window.__abBefore;
      let n = 0;
      let worst = 0;
      for (let i = 0; i < now.length; i++) {
        const d = Math.abs(now[i] - was[i]);
        if (d) {
          n++;
          if (d > worst) worst = d;
        }
      }
      return { differing: n, worst, total: now.length };
    });
    await page.evaluate(() => window.__gqRenderCache && window.__gqRenderCache.enable());
    await page.waitForTimeout(200);
    return diff;
  };
  const bigBrush = async () => {
    for (let i = 0; i < 26; i++) await page.keyboard.press("]");
    await page.waitForTimeout(200);
  };
  const stroke = async (fy) => {
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * fy);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++)
      await page.mouse.move(box.x + box.width * (0.3 + 0.03 * i), box.y + box.height * fy, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(900);
  };
  /** Wall time for a stroke, to compare against the pre-change baseline. */
  const timedStroke = async (fy) => {
    const t = Date.now();
    await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * fy);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++)
      await page.mouse.move(box.x + box.width * (0.3 + 0.03 * i), box.y + box.height * fy, { steps: 2 });
    await page.mouse.up();
    await page.waitForFunction(() => {
      const s = window.__gqPerf && window.__gqPerf.stats();
      return s && performance.now() - s.dirtyAt > 250;
    }, { timeout: 15000 }).catch(() => {});
    return Date.now() - t;
  };

  // ---------- a layer with content ----------
  await menu("Layer", "New layer");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(700);

  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("b");
  await page.waitForTimeout(250);
  await bigBrush();

  // ---------- baseline: a plain layer already region-blits ----------
  await stroke(0.25);
  const st0 = await page.evaluate(() => window.__gqPerf && window.__gqPerf.stats());
  const plainRect = st0 && st0.dirty;
  check("plain layer: region blit (pre-existing behaviour)", st0 && st0.full === false, `dirty=${JSON.stringify(plainRect)}`);

  // ---------- 1. LAYER EFFECTS — the case this change actually enables -------
  // Effects render inline (no worker), so the padded rect reaches the blit.
  await menu("Layer", "Layer style…");
  await page.waitForTimeout(800);
  const dsToggle = page.locator('button[aria-label="Drop Shadow off"]').first();
  check("the Layer Style dialog exposes the drop-shadow toggle", (await dsToggle.count()) > 0);
  await dsToggle.click();
  await page.waitForTimeout(700);
  check("…and it is on", (await page.locator('button[aria-label="Drop Shadow on"]').count()) > 0);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(900);
  await stroke(0.4);
  // Byte-identity alone would also pass if the region path never activated and
  // everything still went through the full pass — so first prove it IS active:
  // the last composite must have been a REGION blit with a bounded dirty rect.
  // The settled frame right after a GESTURE is deliberately a full blit: live
  // frames painted draft-resolution effects into region blits, so the first
  // settled frame has to repaint everywhere those landed. Prove the padding on a
  // change with no live session instead — an undo patch, which goes through the
  // same bumpPixel(rect) path with no draft involved.
  const stAfterStroke = await page.evaluate(() => window.__gqPerf && window.__gqPerf.stats());
  check(
    "the frame settling a draft gesture repaints fully (draft pixels can't linger)",
    stAfterStroke && stAfterStroke.full === true,
    `full=${stAfterStroke && stAfterStroke.full}`,
  );
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(900);
  const st1 = await page.evaluate(() => window.__gqPerf && window.__gqPerf.stats());
  check(
    "an undo patch on a SHADOWED layer takes the region path (was always full)",
    st1 && st1.full === false && st1.dirty,
    st1 ? `full=${st1.full} dirty=${JSON.stringify(st1.dirty)}` : "no perf hook",
  );
  check(
    "…and the rect GREW by the shadow's reach (proving the padding, not a no-op)",
    st1 && st1.dirty && plainRect && st1.dirty.w > plainRect.w && st1.dirty.h > plainRect.h,
    `plain ${plainRect && plainRect.w}×${plainRect && plainRect.h} → shadowed ${st1?.dirty?.w}×${st1?.dirty?.h}`,
  );
  if (st1 && st1.dirty) {
    const share = (st1.dirty.w * st1.dirty.h) / (1920 * 1080);
    check("…while staying a fraction of the document", share < 0.5, `${(share * 100).toFixed(1)}% of the canvas`);
  }
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(900);
  const d1 = await diffAgainstFullRecompute();
  check(
    "drop shadow: the region-scoped composite is byte-identical to the full pass",
    d1.differing === 0,
    `${d1.differing} of ${d1.total} bytes differ (worst Δ ${d1.worst})`,
  );

  // ---------- 2. a blur smart filter on top ----------
  await menu("Effects", "Blur (smart filter)");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1200);
  await stroke(0.6);
  const d2 = await diffAgainstFullRecompute();
  check(
    "shadow + blur filter: still byte-identical",
    d2.differing === 0,
    `${d2.differing} of ${d2.total} bytes differ (worst Δ ${d2.worst})`,
  );

  // ---------- 3. an UNSAFE filter must fall back to the full pass ----------
  await menu("Effects", "Noise…");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1000);
  const st3 = await page.evaluate(() => window.__gqPerf && window.__gqPerf.stats());
  check(
    "a position-dependent filter (noise) falls BACK to the full pass",
    st3 && st3.full === true,
    st3 ? `full=${st3.full}` : "no perf hook",
  );
  const d3 = await diffAgainstFullRecompute();
  check(
    "…and still matches the full recompute",
    d3.differing === 0,
    `${d3.differing} of ${d3.total} bytes differ (worst Δ ${d3.worst})`,
  );

  console.log(errors.length ? "\nCONSOLE ERRORS:\n" + errors.join("\n") : "\nno console errors");
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  if (failed.length || errors.length) process.exit(1);
})().catch((e) => {
  console.error("HARNESS FAIL:", e.message);
  process.exit(1);
});
