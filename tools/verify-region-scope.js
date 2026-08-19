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
 *
 * Sections 1-6 cover the SETTLED product (a cached render repaired a rect at a
 * time). Section 7 covers the LIVE frame, which is a separate mechanism sharing
 * the same two-rect construction, and needs its own oracle — see the note there.
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
  /* NOTE: `]` does not reach the engine from Playwright — the Size control reads
     24 before and 24 after 26 presses — so this is inert and sections 1-6 run on
     the default 24 px brush. They do not care: their oracle is "cached composite
     == full recompute", which only needs the stroke to change the INPUTS, not to
     be visible. Section 7 does care, and sets Size directly. */
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
  // ---------- 4. every effect's REACH, proved empirically ----------
  /* The region recompute trusts effectsReach() for how far each effect spreads.
     An UNDER-estimate is a correctness bug that shows up as a seam at the edge
     of the repainted rect — invisible in a screenshot, obvious to a byte diff.
     So turn each effect on alone, paint, and demand byte-identity; and demand
     that the region recompute actually RAN, because identity also holds when it
     quietly declines and takes the full pass. */
  const fxToggle = async (name, on) => {
    await menu("Layer", "Layer style…");
    await page.waitForTimeout(900);
    const b = page.locator(`button[aria-label="${name} ${on ? "off" : "on"}"]`).first();
    if (await b.count()) { await b.click(); await page.waitForTimeout(700); }
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1100);
  };
  const regionHits = async () => {
    const st = await page.evaluate(() => window.__gqRenderCache && window.__gqRenderCache.stats());
    return st ? st.regionHits : -1;
  };

  /* A FRESH layer for this section. The layer used above still carries the blur
     and noise smart filters from sections 2-3, and regionPatchable() refuses any
     node with filters — so measuring on it would report "never ran" for every
     effect while the product was behaving correctly. (It did, until this line.) */
  await menu("Layer", "New layer");
  await page.waitForTimeout(800);
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(800);
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("b");
  await page.waitForTimeout(250);
  await bigBrush();
  let yy = 0.3;
  for (const name of ["Outer Glow", "Inner Shadow", "Inner Glow", "Bevel & Emboss", "Stroke"]) {
    await fxToggle(name, true);
    /* TWO strokes. Toggling the effect changes the node's key, so the first
       stroke after it has no cached product to repair and must take the full
       pass — the region path only has something to patch from the second
       stroke on. Measuring across the first is what made this check fail while
       the product was working correctly. */
    await stroke((yy += 0.06));
    await page.waitForTimeout(1200);
    const h0 = await regionHits();
    await stroke((yy += 0.06));
    await page.waitForTimeout(1200);
    const ran = (await regionHits()) > h0;
    const d = await diffAgainstFullRecompute();
    check(`${name}: region-scoped render is byte-identical`, d.differing === 0,
      `${d.differing} of ${d.total} bytes differ (worst Δ ${d.worst})`);
    check(`…and the region path actually ran for ${name}`, ran, `regionHits moved: ${ran}`);
    await fxToggle(name, false);
  }

  // ---------- 5. a POSITION-DEPENDENT effect must decline ----------
  /* A gradient overlay takes its geometry from the canvas it is handed, so a
     sub-canvas would silently rescale it. effectsPositionDependent() keeps it on
     the full pass — proved by the counter NOT moving while the pixels match. */
  await fxToggle("Gradient Overlay", true);
  const hg = await regionHits();
  await stroke(0.72);
  await page.waitForTimeout(1200);
  const stayed = (await regionHits()) === hg;
  check("a gradient overlay does NOT take the region recompute (position-dependent)",
    stayed, `regionHits unchanged: ${stayed}`);
  const dg = await diffAgainstFullRecompute();
  check("…and its full pass is still byte-identical", dg.differing === 0,
    `${dg.differing} of ${dg.total} bytes differ (worst Δ ${dg.worst})`);

  // ---------- 6. a MASKED layer ----------
  /* Both mask kinds multiply the styled render per-pixel, so they reach nothing
     and are simply re-applied over the repainted rect. Worth its own leg because
     the cached product for a masked node is styled-THEN-masked: repainting the
     styled pixels without re-masking would punch the mask's hole open again
     inside the rect, and only a byte diff would notice. */
  await fxToggle("Gradient Overlay", false);
  await fxToggle("Drop Shadow", true);
  await menu("Layer", "Add layer mask");
  await page.waitForTimeout(1300);
  // Adding a mask selects it for painting — click the image thumbnail so the
  // stroke lands on the PIXELS (a mask paint is a different, unpatched path).
  const imgThumb = page.locator('li[class*="layerItem"] span[class*="layerThumb"]').first();
  check("the masked layer exposes an image thumbnail to paint through",
    (await imgThumb.count()) > 0, `${await imgThumb.count()} found`);
  await imgThumb.click();
  await page.waitForTimeout(900);
  await stroke(0.8); // warm-up: no cached product to repair yet
  await page.waitForTimeout(1200);
  const hm = await regionHits();
  await stroke(0.86);
  await page.waitForTimeout(1200);
  check("a masked + shadowed layer takes the region path", (await regionHits()) > hm,
    `regionHits moved: ${(await regionHits()) > hm}`);
  const dm = await diffAgainstFullRecompute();
  check("…and its region-scoped render is byte-identical", dm.differing === 0,
    `${dm.differing} of ${dm.total} bytes differ (worst Δ ${dm.worst})`);

  // ---------- 7. the LIVE filter frame ----------
  /* Everything above is the SETTLED product. The live half is a different
     mechanism with the same two rects: a per-stroke copy of the settled product,
     with the stroke's dirty rect re-filtered into it at full resolution, in place
     of a quarter-resolution pass over the whole document.
   *
   * The oracle has to be chosen carefully. Region-on vs region-off on a large
   * document compares a full-res region against a QUARTER-RES draft: those differ
   * by design, so nothing is proved. On a document at or under DRAFT_MAX_PIXELS
   * (500k) draftScale() is 1 and the off arm is a real full-document,
   * full-resolution renderFiltered — precisely what the region path claims to
   * reproduce. Hence the small document below; a big one is benched, not verified
   * (tools/bench-livefilter.js). */
  const LW = 800;
  const LH = 600;
  await menu("File", "New…");
  const ndlg = page.locator('div[role="dialog"][aria-label="New document"]');
  await ndlg.waitFor({ timeout: 8000 });
  await ndlg.locator('input[type="number"]').nth(0).fill(String(LW));
  await ndlg.locator('input[type="number"]').nth(1).fill(String(LH));
  await ndlg.getByText("Create", { exact: true }).click();
  await page.waitForTimeout(1600);
  const lbox = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();

  await menu("Layer", "New layer");
  await page.mouse.move(lbox.x + 30, lbox.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(250);
  await page.mouse.click(lbox.x + lbox.width / 2, lbox.y + lbox.height / 2);
  await page.waitForTimeout(1000);
  await page.keyboard.press("b");
  await page.waitForTimeout(250);

  /* THE STROKE HAS TO BE VISIBLE, and neither half of that is automatic here.
   *
   * Colour: the gradient fills the layer with the FOREGROUND colour, so a brush
   * straight afterwards paints that same colour onto itself and changes nothing
   * but a few antialiased edge bytes — which a blur then smooths below one LSB.
   * The first version of this section duly reported "byte-identical" for a
   * stroke that was invisible, i.e. proved nothing at all. Swapping foreground
   * and background gives the brush something to contrast against.
   *
   * Size: the `]` shortcut does NOT reach the engine from Playwright (measured:
   * 24 before and 24 after 22 presses), so bigBrush() above is inert too. Set
   * the options-bar Size directly instead, through the native value setter so
   * React's onChange actually fires. */
  await page.locator('button[aria-label="Swap foreground and background colors"]').first().click();
  await page.waitForTimeout(400);
  await page
    .locator('[data-tour="options"] input[aria-label="Size"]')
    .first()
    .evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "160");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await page.waitForTimeout(500);
  const liveBrush = await page.locator('[data-tour="options"] input[aria-label="Size"]').first().inputValue();
  check("the live section paints with a brush big enough to see", Number(liveBrush) >= 100, `size=${liveBrush}`);

  const grabLive = () =>
    page.evaluate((w) => {
      const cv = document.querySelector(`canvas[width="${w}"]`);
      if (!cv) return null;
      const g = cv.getContext("2d", { willReadFrequently: true });
      return Array.from(g.getImageData(0, 0, cv.width, cv.height).data);
    }, LW);
  const liveStats = () => page.evaluate(() => window.__gqRenderCache.stats());
  /* One MID-STROKE frame, captured without releasing the button (the live path
     only exists while the button is down), then undone so the next arm starts
     from identical pixels. */
  const liveArm = async (on, fy) => {
    await page.evaluate(
      (o) => (o ? window.__gqRenderCache.regionOn() : window.__gqRenderCache.regionOff()),
      on,
    );
    await page.waitForTimeout(400);
    const s0 = await liveStats();
    const pre = await grabLive(); // for the band's non-vacuity check
    await page.mouse.move(lbox.x + lbox.width * 0.25, lbox.y + lbox.height * fy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(lbox.x + lbox.width * (0.25 + 0.05 * i), lbox.y + lbox.height * fy, { steps: 2 });
    await page.waitForTimeout(700);
    const px = await grabLive();
    const s1 = await liveStats();
    await page.mouse.up();
    await page.waitForTimeout(900);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(1400);
    return { px, pre, hits: s1.liveRegionHits - s0.liveRegionHits, rpx: s1.liveRegionPx - s0.liveRegionPx };
  };
  const liveLeg = async (name, fy, expectRegion = true) => {
    const on = await liveArm(true, fy);
    const off = await liveArm(false, fy);
    if (!on.px || !off.px) {
      check(`${name}: the document canvas was found`, false, `canvas[width="${LW}"] missing`);
      return;
    }
    /* Two numbers, because they answer two different questions.
     *
     * PATCHED — a band along the stroke's centreline, inside the dirty rect and
     * therefore inside OUT: pixels the region path itself rendered. That is the
     * region maths, and it must be exactly zero.
     *
     * SEEDED — everywhere else, copied verbatim from the settled product in
     * filteredCache. That product comes from the smart-filter WORKER, and the
     * worker's blend disagrees with the inline one by 1 on the red channel
     * whenever a filter carries a blend mode or a partial opacity. Measured with
     * NO live session in play at all — 480,000 of 1,920,000 bytes, every one of
     * them −1 — so it is a pre-existing defect this rail inherits rather than
     * anything the region path did. Reported separately and bounded at 1: folding
     * it into the check above would either mask a real region bug or fail for
     * something the region path never touched. */
    const bx0 = Math.round(LW * 0.32);
    const bx1 = Math.round(LW * 0.58);
    const by0 = Math.round(LH * fy) - 4;
    const by1 = Math.round(LH * fy) + 4;
    let inN = 0;
    let inWorst = 0;
    let outN = 0;
    let outWorst = 0;
    let painted = 0; // band bytes the stroke actually changed (non-vacuity)
    for (let i = 0; i < on.px.length; i++) {
      const pix = i >> 2;
      const x = pix % LW;
      const y = (pix - x) / LW;
      const band = x >= bx0 && x < bx1 && y >= by0 && y < by1;
      if (band && on.pre && on.pre[i] !== on.px[i]) painted++;
      const d = Math.abs(on.px[i] - off.px[i]);
      if (!d) continue;
      if (band) {
        inN++;
        if (d > inWorst) inWorst = d;
      } else {
        outN++;
        if (d > outWorst) outWorst = d;
      }
    }
    check(`${name}: the PATCHED pixels are byte-identical to the full-res frame`, inN === 0,
      `${inN} bytes differ inside the stroke band (worst Δ ${inWorst})`);
    // "Identical" over a band the stroke never reached would prove nothing.
    check(`…and that band is pixels the stroke actually repainted`, painted > 500,
      `${painted} band bytes changed during the stroke`);
    check(`${name}: the SEEDED pixels carry only the worker's known Δ1`, outWorst <= 1,
      `${outN} bytes differ outside it (worst Δ ${outWorst})`);
    if (expectRegion)
      check(`…and the live region path ran for ${name}`, on.hits > 0 && on.rpx > 0 && off.hits === 0,
        `on +${on.hits} frames / ${on.rpx.toLocaleString()} px, off +${off.hits}`);
    else
      check(`…and ${name} DECLINED the live region path`, on.hits === 0, `on +${on.hits} frames`);
  };

  await menu("Effects", "Blur (smart filter)");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1600);
  await liveLeg("blur", 0.3);

  /* A filter at partial opacity takes filterStack's BLEND branch, which needs a
     second scratch buffer — the one place a reused, deliberately oversized canvas
     could read the wrong rect back. */
  await menu("Effects", "Smart filters…");
  const sfd = page.locator('div[role="dialog"]').filter({ hasText: "Filter Mask" }).first();
  await sfd.waitFor({ timeout: 8000 });
  const fop = sfd.locator('input[aria-label="Opacity"]').first();
  check("the smart-filter dialog exposes a per-filter Opacity slider", (await fop.count()) > 0);
  await fop.focus();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(35);
  }
  const fopVal = await fop.inputValue();
  check("…and the sweep actually moved it off 100 (or the blend branch never runs)",
    Number(fopVal) < 100, `opacity=${fopVal}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1600);
  await liveLeg("blur at partial opacity", 0.45);

  /* A PAINTED filter mask, so the premultiplied interpolation runs over a sub-rect
     with a mask that is not uniformly white (a reveal-all mask short-circuits on
     `t >= 1` for every pixel and would prove nothing). */
  await menu("Effects", "Smart filters…");
  await sfd.waitFor({ timeout: 8000 });
  const addMask = sfd.locator("button", { hasText: "Add Mask" }).first();
  check("the smart-filter dialog offers Add Mask", (await addMask.count()) > 0);
  await addMask.click();
  await page.waitForTimeout(900);
  const paintMask = sfd.locator("button", { hasText: "Paint" }).first();
  check("…and a Paint button once the mask exists", (await paintMask.count()) > 0);
  await paintMask.click();
  await page.waitForTimeout(1200);
  await page.mouse.move(lbox.x + lbox.width * 0.2, lbox.y + lbox.height * 0.62);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++)
    await page.mouse.move(lbox.x + lbox.width * (0.2 + 0.05 * i), lbox.y + lbox.height * 0.62, { steps: 2 });
  await page.mouse.up();
  await page.waitForTimeout(1400);
  const liveThumb = page.locator('li[class*="layerItem"] span[class*="layerThumb"]').first();
  check("the layer list exposes an image thumbnail to switch back to pixels",
    (await liveThumb.count()) > 0, `${await liveThumb.count()} found`);
  await liveThumb.click();
  await page.waitForTimeout(1200);
  await liveLeg("blur through a painted filter mask", 0.62);

  // An unsafe filter must decline the live path exactly as it declines the settled one.
  await menu("Effects", "Noise…");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1600);
  await liveLeg("noise (position-dependent)", 0.78, false);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  if (failed.length || errors.length) process.exit(1);
})().catch((e) => {
  console.error("HARNESS FAIL:", e.message);
  process.exit(1);
});
