/**
 * Region-scoped change tracking and draft-resolution live rendering stay
 * byte-identical to a full recompute. (Ported from tools/verify-region-scope.js.)
 *
 * Two invariants, both of which have caught real bugs:
 *  1. A padded region is only allowed if the composite it produces is
 *     BYTE-IDENTICAL to a full recompute — an under-estimated reach shows up as a
 *     stale band at the edge of the re-blitted area.
 *  2. A gesture that painted DRAFT-resolution filters/effects must repaint the
 *     whole view on the frame that settles it, or draft pixels survive outside
 *     the last dirty rect. (This caught 15,470 differing bytes.)
 *
 * Byte-identity ALSO holds when the region path never activates, so every
 * identity check is paired with proof that the region path actually ran.
 * Sections 1–6 cover the SETTLED product; section 7 the LIVE frame, a separate
 * mechanism with its own oracle — so they are separate tests.
 */
import { test, expect, type App } from "./fixtures";
import type { Page } from "@playwright/test";

declare global {
  interface Window {
    __gqPerf?: { stats(): { full: boolean; dirty: { x: number; y: number; w: number; h: number } | null; dirtyAt: number } };
    __gqRenderCache?: {
      enable(): void;
      disable(): void;
      regionOn(): void;
      regionOff(): void;
      stats(): { regionHits: number; liveRegionHits: number; liveRegionPx: number; workerJobs: number };
    };
    __abBefore?: Uint8ClampedArray;
  }
}

test.use({ viewport: { width: 1500, height: 950 } });
/* Each test here is ~3 min alone (dozens of settle-and-diff cycles over a 2 MP
   canvas) and overran the 3 min default once it shared the machine with the
   rest of the suite. slow() triples the budget for this file only. */
test.slow();

/** Digest of the 1920-wide document canvas (sections 1–6 work on a 1920×1080 doc). */
const DOC = 'canvas[width="1920"]';

/** Wait until nothing more is coming: no worker render in flight, no blit for
 *  300ms, and the same digest twice running.
 *
 *  Fixed sleeps held on a fast machine and not on CI. Twice: the settled diff
 *  below caught a worker's render landing after its snapshot (reproduced at 8×
 *  CPU throttle), and on the GitHub runner the live arms seeded from a product
 *  the worker had not finished — 57–61k bytes off, worst Δ79 at a mask edge,
 *  the signature of a draft. "The canvas stopped changing" is not enough on its
 *  own: a stale product draws, unchanging, for as long as the worker is out. */
async function settled(page: Page, sel = DOC) {
  let prev: number | null = null;
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(250);
    const s = await page.evaluate((selector) => {
      const st = window.__gqPerf?.stats();
      const jobs = window.__gqRenderCache?.stats().workerJobs ?? 0;
      const cv = document.querySelector<HTMLCanvasElement>(selector)!;
      const d = cv.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, cv.width, cv.height).data;
      let sum = 0;
      for (let k = 0; k < d.length; k += 4) sum = (sum + d[k] * 3 + d[k + 1] * 5 + d[k + 2] * 7 + d[k + 3] * 11) >>> 0;
      return { quiet: jobs === 0 && (st ? performance.now() - st.dirtyAt > 300 : true), sum };
    }, sel);
    if (s.quiet && prev === s.sum) return;
    prev = s.quiet ? s.sum : null;
  }
  throw new Error(`the render never settled (${sel})`);
}

/** Pixel-diff the live composite against a freshly forced full recompute. */
async function diffAgainstFullRecompute(page: Page) {
  await settled(page);
  await page.evaluate((sel) => {
    const cv = document.querySelector<HTMLCanvasElement>(sel)!;
    window.__abBefore = cv.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, cv.width, cv.height).data.slice();
  }, DOC);
  // Force the always-correct uncached path, then make it recomposite.
  await page.evaluate(() => window.__gqRenderCache?.disable());
  await page.waitForTimeout(200);
  await page.keyboard.press("Control+z"); // any journalled change forces a recomposite
  await page.waitForTimeout(500);
  await page.keyboard.press("Control+Shift+z");
  await page.waitForTimeout(900);
  await settled(page);
  const diff = await page.evaluate((sel) => {
    const cv = document.querySelector<HTMLCanvasElement>(sel)!;
    const now = cv.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, cv.width, cv.height).data;
    const was = window.__abBefore!;
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
  }, DOC);
  await page.evaluate(() => window.__gqRenderCache?.enable());
  await page.waitForTimeout(200);
  return diff;
}

const perfStats = (page: Page) => page.evaluate(() => window.__gqPerf?.stats() ?? null);
const regionHits = (page: Page) => page.evaluate(() => window.__gqRenderCache?.stats().regionHits ?? -1);
const identical = (d: { differing: number; worst: number; total: number }) =>
  `${d.differing} of ${d.total} bytes differ (worst Δ ${d.worst})`;

/** A 12-step horizontal stroke at height `fy`. Sections 1–6 run on the default
 *  brush: their oracle only needs the stroke to change the inputs. */
async function stroke(app: App, fy: number) {
  const box = await app.canvasBox();
  const { mouse } = app.page;
  await mouse.move(box.x + box.width * 0.3, box.y + box.height * fy);
  await mouse.down();
  for (let i = 1; i <= 12; i++) await mouse.move(box.x + box.width * (0.3 + 0.03 * i), box.y + box.height * fy, { steps: 2 });
  await mouse.up();
  await app.settle(900);
}

/** New layer, filled by a click of the gradient tool, brush selected. */
async function gradientLayer(app: App) {
  const box = await app.canvasBox();
  await app.menu("Layer", "New layer");
  await app.page.mouse.move(box.x + 30, box.y + 30);
  await app.page.keyboard.press("g");
  await app.settle(250);
  await app.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await app.settle(800);
  await app.page.mouse.move(box.x + 30, box.y + 30);
  await app.page.keyboard.press("b");
  await app.settle(250);
}

async function fxToggle(app: App, name: string, on: boolean) {
  await app.menu("Layer", "Layer style…");
  await app.settle(900);
  const b = app.page.locator(`button[aria-label="${name} ${on ? "off" : "on"}"]`).first();
  if (await b.count()) {
    await b.click();
    await app.settle(700);
  }
  await app.page.keyboard.press("Escape");
  await app.settle(1100);
}

test("settled product: region-scoped composites match a full recompute", async ({ app }) => {
  const { page } = app;
  await gradientLayer(app);

  // ---- baseline: a plain layer already region-blits ----
  await stroke(app, 0.25);
  const st0 = await perfStats(page);
  const plainRect = st0?.dirty ?? null;
  expect.soft(st0?.full, "plain layer: region blit (pre-existing behaviour)").toBe(false);

  // ---- 1. layer effects ----
  await app.menu("Layer", "Layer style…");
  await app.settle(800);
  const dsToggle = page.locator('button[aria-label="Drop Shadow off"]').first();
  expect(await dsToggle.count(), "the Layer Style dialog exposes the drop-shadow toggle").toBeGreaterThan(0);
  await dsToggle.click();
  await app.settle(700);
  expect.soft(await page.locator('button[aria-label="Drop Shadow on"]').count(), "…and it is on").toBeGreaterThan(0);
  await page.keyboard.press("Escape");
  await app.settle(900);
  await stroke(app, 0.4);
  /* The settled frame right after a GESTURE is deliberately a full blit (live
     frames painted draft effects into region blits). The padding is proved on an
     undo patch instead — same bumpPixel(rect) path, no draft involved. */
  expect.soft((await perfStats(page))?.full, "the frame settling a draft gesture repaints fully").toBe(true);
  await page.keyboard.press("Control+z");
  await app.settle(900);
  const st1 = await perfStats(page);
  expect.soft(st1?.full === false && !!st1?.dirty, "an undo patch on a SHADOWED layer takes the region path").toBe(true);
  expect.soft(
    !!st1?.dirty && !!plainRect && st1.dirty.w > plainRect.w && st1.dirty.h > plainRect.h,
    `…and the rect GREW by the shadow's reach (plain ${plainRect?.w}×${plainRect?.h} → ${st1?.dirty?.w}×${st1?.dirty?.h})`,
  ).toBe(true);
  if (st1?.dirty) {
    expect.soft((st1.dirty.w * st1.dirty.h) / (1920 * 1080), "…while staying a fraction of the document").toBeLessThan(0.5);
  }
  await page.keyboard.press("Control+Shift+z");
  await app.settle(900);
  const d1 = await diffAgainstFullRecompute(page);
  expect.soft(d1.differing, `drop shadow: region composite is byte-identical — ${identical(d1)}`).toBe(0);

  // ---- 2. a blur smart filter on top ----
  await app.menu("Effects", "Blur (smart filter)");
  await page.keyboard.press("Escape");
  await app.settle(1200);
  await stroke(app, 0.6);
  const d2 = await diffAgainstFullRecompute(page);
  expect.soft(d2.differing, `shadow + blur filter: still byte-identical — ${identical(d2)}`).toBe(0);

  // ---- 3. an UNSAFE filter falls back to the full pass ----
  await app.menu("Effects", "Noise…");
  await page.keyboard.press("Escape");
  await app.settle(1000);
  expect.soft((await perfStats(page))?.full, "a position-dependent filter (noise) falls BACK to the full pass").toBe(true);
  const d3 = await diffAgainstFullRecompute(page);
  expect.soft(d3.differing, `…and still matches the full recompute — ${identical(d3)}`).toBe(0);

  // ---- 4. every effect's REACH, proved empirically ----
  /* A FRESH layer: the one above carries smart filters, and regionPatchable()
     refuses any node with filters — measuring there would report "never ran"
     while the product behaved correctly. */
  await gradientLayer(app);
  let yy = 0.3;
  for (const name of ["Outer Glow", "Inner Shadow", "Inner Glow", "Bevel & Emboss", "Stroke"]) {
    await fxToggle(app, name, true);
    /* TWO strokes: toggling changes the node's key, so the first stroke has no
       cached product to repair and must take the full pass. */
    await stroke(app, (yy += 0.06));
    await app.settle(1200);
    const h0 = await regionHits(page);
    await stroke(app, (yy += 0.06));
    await app.settle(1200);
    const ran = (await regionHits(page)) > h0;
    const d = await diffAgainstFullRecompute(page);
    expect.soft(d.differing, `${name}: region-scoped render is byte-identical — ${identical(d)}`).toBe(0);
    expect.soft(ran, `…and the region path actually ran for ${name}`).toBe(true);
    await fxToggle(app, name, false);
  }

  // ---- 5. a POSITION-DEPENDENT effect must decline ----
  await fxToggle(app, "Gradient Overlay", true);
  const hg = await regionHits(page);
  await stroke(app, 0.72);
  await app.settle(1200);
  expect.soft(await regionHits(page), "a gradient overlay does NOT take the region recompute").toBe(hg);
  const dg = await diffAgainstFullRecompute(page);
  expect.soft(dg.differing, `…and its full pass is still byte-identical — ${identical(dg)}`).toBe(0);

  // ---- 6. a MASKED layer ----
  /* The cached product for a masked node is styled-THEN-masked: repainting the
     styled pixels without re-masking would reopen the mask's hole in the rect. */
  await fxToggle(app, "Gradient Overlay", false);
  await fxToggle(app, "Drop Shadow", true);
  await app.menu("Layer", "Add layer mask");
  await app.settle(1300);
  // Adding a mask targets it; click the image thumbnail so strokes hit the PIXELS.
  const imgThumb = page.locator('li[class*="layerItem"] span[class*="layerThumb"]').first();
  expect(await imgThumb.count(), "the masked layer exposes an image thumbnail").toBeGreaterThan(0);
  await imgThumb.click();
  await app.settle(900);
  await stroke(app, 0.8); // warm-up: no cached product to repair yet
  await app.settle(1200);
  const hm = await regionHits(page);
  await stroke(app, 0.86);
  await app.settle(1200);
  expect.soft((await regionHits(page)) > hm, "a masked + shadowed layer takes the region path").toBe(true);
  const dm = await diffAgainstFullRecompute(page);
  expect.soft(dm.differing, `…and its region-scoped render is byte-identical — ${identical(dm)}`).toBe(0);

  expect.soft(app.consoleErrors, "no console errors").toEqual([]);
});

test("live frame: the region-patched filter frame matches a full-res frame", async ({ app }) => {
  const { page } = app;
  /* On a document at or under DRAFT_MAX_PIXELS (500k) draftScale() is 1, so the
     region-off arm is a real full-resolution renderFiltered — precisely what the
     region path claims to reproduce. On a big document the off arm is a
     quarter-res draft and nothing would be proved (that case is benched:
     tools/bench-livefilter.js). */
  const LW = 800;
  const LH = 600;
  await app.menu("File", "New…");
  const ndlg = page.locator('div[role="dialog"][aria-label="New document"]');
  await ndlg.waitFor({ timeout: 8000 });
  await ndlg.locator('input[type="number"]').nth(0).fill(String(LW));
  await ndlg.locator('input[type="number"]').nth(1).fill(String(LH));
  await ndlg.getByText("Create", { exact: true }).click();
  await app.settle(1600);
  const lbox = await app.canvasBox();

  await app.menu("Layer", "New layer");
  await page.mouse.move(lbox.x + 30, lbox.y + 30);
  await page.keyboard.press("g");
  await app.settle(250);
  await page.mouse.click(lbox.x + lbox.width / 2, lbox.y + lbox.height / 2);
  await app.settle(1000);
  await page.keyboard.press("b");
  await app.settle(250);
  /* THE STROKE HAS TO BE VISIBLE: the gradient fills with the foreground, so a
     brush straight after paints that colour onto itself — the first version of
     this section reported "identical" for an invisible stroke. Swap colours, and
     set Size directly (the `]` shortcut does not reach the engine from here). */
  await page.locator('button[aria-label="Swap foreground and background colors"]').first().click();
  await app.settle(400);
  await app.setRange("Size", 160);
  await app.settle(500);
  const liveBrush = await page.locator('[data-tour="options"] input[aria-label="Size"]').first().inputValue();
  expect(Number(liveBrush), "the live section paints with a brush big enough to see").toBeGreaterThanOrEqual(100);

  const grabLive = () =>
    page.evaluate((w) => {
      const cv = document.querySelector<HTMLCanvasElement>(`canvas[width="${w}"]`);
      if (!cv) return null;
      return Array.from(cv.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, cv.width, cv.height).data);
    }, LW);
  const liveStats = () => page.evaluate(() => window.__gqRenderCache!.stats());
  /* One MID-STROKE frame (the live path only exists while the button is down),
     then undone so the next arm starts from identical pixels. */
  const liveArm = async (on: boolean, fy: number) => {
    await page.evaluate((o) => (o ? window.__gqRenderCache!.regionOn() : window.__gqRenderCache!.regionOff()), on);
    await app.settle(400);
    // The ON arm seeds from the settled product: it must BE settled first.
    await settled(page, `canvas[width="${LW}"]`);
    const s0 = await liveStats();
    const pre = await grabLive();
    await page.mouse.move(lbox.x + lbox.width * 0.25, lbox.y + lbox.height * fy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++) await page.mouse.move(lbox.x + lbox.width * (0.25 + 0.05 * i), lbox.y + lbox.height * fy, { steps: 2 });
    await app.settle(700);
    const px = await grabLive();
    const s1 = await liveStats();
    await page.mouse.up();
    await app.settle(900);
    await page.keyboard.press("Control+z");
    await app.settle(1400);
    await settled(page, `canvas[width="${LW}"]`);
    return { px, pre, hits: s1.liveRegionHits - s0.liveRegionHits, rpx: s1.liveRegionPx - s0.liveRegionPx };
  };
  const liveLeg = async (name: string, fy: number, expectRegion = true) => {
    // Does the worker's settled product match an inline render right now?
    const ab = await page.evaluate(() => {
      const r = (window.__gqRenderCache as unknown as { filterAB(): { differing: number; worst: number; quality: string } | null }).filterAB();
      return r ? `${r.differing} bytes, worst Δ${r.worst}, ${r.quality}` : "no settled product";
    });
    const on = await liveArm(true, fy);
    const off = await liveArm(false, fy);
    expect(on.px && off.px, `${name}: the document canvas was found`).toBeTruthy();
    /* NEAR = the stroke's whole footprint plus a blur margin: what the region
       path re-renders. FAR = everything else, seeded from the settled product.
       Kept apart because they have failed for different reasons.

       NEAR used to be a ±4px band down the stroke's centre line — the one place
       a blur gives the same answer on any path (it is a solid colour there), so
       it could not fail; the real region-render differences at the stroke's
       soft edges were counted as "seeded" instead, which sent the diagnosis the
       wrong way for two rounds. Stroke: x 0.25–0.65 of the width, 160px brush
       (radius 80), plus 30px for the blur's reach. */
    const R = 80 + 30;
    const bx0 = Math.round(LW * 0.25) - R;
    const bx1 = Math.round(LW * 0.65) + R;
    const by0 = Math.round(LH * fy) - R;
    const by1 = Math.round(LH * fy) + R;
    let inN = 0;
    let inWorst = 0;
    let outN = 0;
    let outWorst = 0;
    let painted = 0;
    /* Diagnostics, carried in the failure message — CI annotations are public
       where its logs are not, and this leg once failed on Linux only. They are
       what found that bug, so they stay:
       - preDiff: did the two arms START from the same frame? (If not, the undo
         between them did not restore the pixels — a different bug entirely.)
       - box: where the differences are.
       - ab: worker product vs inline render, compared directly.
       - samples: the first differing pixels, whole (on / off / pre RGBA). */
    let preDiff = 0;
    let bx = [LW, LH, -1, -1];
    const samples: string[] = [];
    const rgba = (a: number[] | null, p: number) => (a ? a.slice(p * 4, p * 4 + 4).join(",") : "-");
    for (let i = 0; i < on.px!.length; i++) {
      const pix = i >> 2;
      const x = pix % LW;
      const y = (pix - x) / LW;
      const near = x >= bx0 && x < bx1 && y >= by0 && y < by1;
      if (near && on.pre && on.pre[i] !== on.px![i]) painted++;
      if (on.pre && off.pre && on.pre[i] !== off.pre[i]) preDiff++;
      const d = Math.abs(on.px![i] - off.px![i]);
      if (!d) continue;
      bx = [Math.min(bx[0], x), Math.min(bx[1], y), Math.max(bx[2], x), Math.max(bx[3], y)];
      if (samples.length < 3 && (i & 3) === 0) {
        samples.push(`(${x},${y}) on ${rgba(on.px, pix)} off ${rgba(off.px, pix)} pre ${rgba(on.pre, pix)}`);
      }
      if (near) {
        inN++;
        if (d > inWorst) inWorst = d;
      } else {
        outN++;
        if (d > outWorst) outWorst = d;
      }
    }
    const where = bx[2] < 0 ? "none" : `x ${bx[0]}–${bx[2]}, y ${bx[1]}–${bx[3]} of ${LW}×${LH}`;
    const diag = `preDiff ${preDiff} bytes; diffs at ${where} (stroke row y≈${Math.round(LH * fy)}); filterAB ${ab}; samples ${samples.join(" | ") || "none"}`;
    expect.soft(inN, `${name}: near the stroke (region-rendered) byte-identical to the full-res frame (worst Δ ${inWorst}) — ${diag}`).toBe(0);
    // "Identical" over pixels the stroke never reached would prove nothing.
    expect.soft(painted, `${name}: the near region is pixels the stroke actually repainted`).toBeGreaterThan(500);
    expect.soft(outN, `${name}: away from the stroke (seeded) byte-identical too (worst Δ ${outWorst}) — ${diag}`).toBe(0);
    if (expectRegion) {
      expect.soft(on.hits > 0 && on.rpx > 0 && off.hits === 0,
        `…and the live region path ran for ${name} (on +${on.hits} / ${on.rpx} px, off +${off.hits})`).toBe(true);
    } else {
      expect.soft(on.hits, `…and ${name} DECLINED the live region path`).toBe(0);
    }
  };

  await app.menu("Effects", "Blur (smart filter)");
  await page.keyboard.press("Escape");
  await app.settle(1600);
  await liveLeg("blur", 0.3);

  /* Partial opacity takes filterStack's BLEND branch (a second scratch buffer). */
  await app.menu("Effects", "Smart filters…");
  const sfd = page.locator('div[role="dialog"]').filter({ hasText: "Filter Mask" }).first();
  await sfd.waitFor({ timeout: 8000 });
  const fop = sfd.locator('input[aria-label="Opacity"]').first();
  expect(await fop.count(), "the smart-filter dialog exposes a per-filter Opacity slider").toBeGreaterThan(0);
  await fop.focus();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(35);
  }
  expect(Number(await fop.inputValue()), "…and the sweep moved it off 100 (or the blend branch never runs)").toBeLessThan(100);
  await page.keyboard.press("Escape");
  await app.settle(1600);
  await liveLeg("blur at partial opacity", 0.45);

  /* A PAINTED filter mask: a reveal-all mask short-circuits and proves nothing. */
  await app.menu("Effects", "Smart filters…");
  await sfd.waitFor({ timeout: 8000 });
  const addMask = sfd.locator("button", { hasText: "Add Mask" }).first();
  expect(await addMask.count(), "the smart-filter dialog offers Add Mask").toBeGreaterThan(0);
  await addMask.click();
  await app.settle(900);
  const paintMask = sfd.locator("button", { hasText: "Paint" }).first();
  expect(await paintMask.count(), "…and a Paint button once the mask exists").toBeGreaterThan(0);
  await paintMask.click();
  await app.settle(1200);
  await page.mouse.move(lbox.x + lbox.width * 0.2, lbox.y + lbox.height * 0.62);
  await page.mouse.down();
  for (let i = 1; i <= 10; i++) await page.mouse.move(lbox.x + lbox.width * (0.2 + 0.05 * i), lbox.y + lbox.height * 0.62, { steps: 2 });
  await page.mouse.up();
  await app.settle(1400);
  const liveThumb = page.locator('li[class*="layerItem"] span[class*="layerThumb"]').first();
  expect(await liveThumb.count(), "the layer list exposes an image thumbnail to switch back to pixels").toBeGreaterThan(0);
  await liveThumb.click();
  await app.settle(1200);
  await liveLeg("blur through a painted filter mask", 0.62);

  // An unsafe filter declines the live path exactly as it declines the settled one.
  await app.menu("Effects", "Noise…");
  await page.keyboard.press("Escape");
  await app.settle(1600);
  await liveLeg("noise (position-dependent)", 0.78, false);

  expect.soft(app.consoleErrors, "no console errors").toEqual([]);
});
