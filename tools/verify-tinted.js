/* The layer-effects alpha mask: shared scratch must be as correct as a fresh
 * canvas, and faster.
 *
 *   npm i -D playwright-core   &&   npm run dev   &&   node tools/verify-tinted.js
 *
 * `alphaMask` used to allocate a canvas + an ImageData on every call, once per
 * ENABLED effect. It now reuses one of each, keyed on size. At 12 MP that
 * allocation — not the fill and not the destination-in composite — was where
 * the time went.
 *
 * Reuse buys speed with a hazard: the buffer survives between calls, so a stale
 * pixel or a stale canvas size would be a silent, wrong composite. The checks
 * below are aimed squarely at that:
 *   - two DIFFERENT alpha fields in a row must not bleed into each other
 *   - a field whose second version is strictly smaller must not leave the first
 *     one's pixels behind (the classic reuse bug)
 *   - changing the size must reallocate, and changing back must still be right
 *   - the RGB channels of the reused buffer must stay zero forever, since only
 *     alpha is ever written
 *
 * It also re-checks the two documented traps: half-to-even rounding of a
 * fractional alpha field, and `willReadFrequently`.
 *
 * Non-vacuity: every comparison prints how many pixels were actually non-
 * transparent and how many distinct alpha values the field carried. A field
 * that collapsed to all-zero would match perfectly and prove nothing.
 */
const { chromium } = require("playwright-core");

const RUN = ([w, h]) => {
  // ---- the two implementations, side by side in the page ------------------
  /** OLD: a brand-new canvas and ImageData on every call. */
  const freshMask = (a, ww, hh) => {
    const c = document.createElement("canvas");
    c.width = ww;
    c.height = hh;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const id = new ImageData(ww, hh);
    const d = id.data;
    for (let i = 0; i < a.length; i++) d[i * 4 + 3] = a[i] < 0 ? 0 : a[i] > 255 ? 255 : a[i];
    ctx.putImageData(id, 0, 0);
    return c;
  };
  /** NEW: one canvas + one ImageData, reused, keyed on size. */
  let scratch = null;
  const sharedMask = (a, ww, hh) => {
    if (!scratch || scratch.c.width !== ww || scratch.c.height !== hh) {
      const c = document.createElement("canvas");
      c.width = ww;
      c.height = hh;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      scratch = { c, ctx, id: ctx.createImageData(ww, hh), allocs: (scratch?.allocs ?? 0) + 1 };
    }
    const d = scratch.id.data;
    for (let i = 0; i < a.length; i++) d[i * 4 + 3] = a[i] < 0 ? 0 : a[i] > 255 ? 255 : a[i];
    scratch.ctx.putImageData(scratch.id, 0, 0);
    return scratch.c;
  };
  const allocs = () => scratch?.allocs ?? 0;

  const read = (c, ww, hh) =>
    c.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, ww, hh).data;
  const compare = (A, B) => {
    let px = 0;
    let worst = 0;
    for (let i = 0; i < A.length; i++) {
      const d = Math.abs(A[i] - B[i]);
      if (d) {
        px++;
        if (d > worst) worst = d;
      }
    }
    return { px, worst };
  };
  const stats = (a) => {
    let nonZero = 0;
    const distinct = new Set();
    for (let i = 0; i < a.length; i++) {
      if (a[i] > 0) nonZero++;
      distinct.add(Math.round(a[i] * 4));
    }
    return { nonZero, distinct: distinct.size };
  };

  // ---- alpha fields with the awkward values in them -----------------------
  const field = (ww, hh, seed0, opts = {}) => {
    const a = new Float32Array(ww * hh);
    let seed = seed0;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (let y = 0; y < hh; y++)
      for (let x = 0; x < ww; x++) {
        const i = y * ww + x;
        if (opts.shrunk && (x > ww / 2 || y > hh / 2)) a[i] = 0; // strictly inside the last one
        else if (x < 8) a[i] = 0;
        else if (x < 16) a[i] = 255;
        else if (x < 24) a[i] = i % 2 ? 0.5 : 1.5; // round-half-to-even territory
        else if (x < 32) a[i] = 254.5;
        else if (x < 40) a[i] = -3; // out of range low
        else if (x < 48) a[i] = 300; // out of range high
        else a[i] = rnd() * 255; // fractional, like blur output
      }
    return a;
  };

  const out = { size: [w, h], cases: [] };
  const A1 = field(w, h, 12345);
  const A2 = field(w, h, 999);
  const A3 = field(w, h, 777, { shrunk: true });

  // 1. a single call agrees with a fresh canvas
  out.cases.push({
    name: "one call matches a freshly allocated mask",
    ...compare(read(freshMask(A1, w, h), w, h), read(sharedMask(A1, w, h), w, h)),
    ...stats(A1),
  });

  // 2. two different fields back to back — no bleed
  sharedMask(A1, w, h);
  out.cases.push({
    name: "a second, different field does not inherit the first",
    ...compare(read(freshMask(A2, w, h), w, h), read(sharedMask(A2, w, h), w, h)),
    ...stats(A2),
  });

  // 3. a strictly SMALLER field after a larger one — the classic reuse bug
  sharedMask(A2, w, h);
  out.cases.push({
    name: "a smaller field leaves none of the bigger one behind",
    ...compare(read(freshMask(A3, w, h), w, h), read(sharedMask(A3, w, h), w, h)),
    ...stats(A3),
  });

  // 4. RGB must stay zero — only alpha is ever written
  const d4 = read(sharedMask(A1, w, h), w, h);
  let rgbNonZero = 0;
  for (let i = 0; i < d4.length; i += 4)
    if (d4[i] | d4[i + 1] | d4[i + 2]) rgbNonZero++;
  out.rgbNonZero = rgbNonZero;

  // 5. a size change reallocates, and going back is still correct
  const before = allocs();
  const sw = Math.floor(w / 2);
  const sh = Math.floor(h / 2);
  const B1 = field(sw, sh, 42);
  const small = compare(read(freshMask(B1, sw, sh), sw, sh), read(sharedMask(B1, sw, sh), sw, sh));
  const grew = allocs();
  const backAgain = compare(read(freshMask(A1, w, h), w, h), read(sharedMask(A1, w, h), w, h));
  out.cases.push({ name: "a different size is correct", ...small, ...stats(B1) });
  out.cases.push({ name: "...and going back to the first size still is", ...backAgain, ...stats(A1) });
  out.reallocated = grew > before;
  out.allocsTotal = allocs();

  // ---- timing --------------------------------------------------------------
  const timed = (fn, runs = 9, warm = 4) => {
    for (let i = 0; i < warm; i++) fn();
    const t = [];
    for (let i = 0; i < runs; i++) {
      const s = performance.now();
      fn();
      t.push(performance.now() - s);
    }
    t.sort((x, y) => x - y);
    return Math.round(t[t.length >> 1] * 100) / 100;
  };
  // A reference primitive measured in the SAME process, so these numbers can be
  // read on another machine (the bench-track calibration rule).
  const refBuf = new Float32Array(w * h);
  out.msRef = timed(() => {
    let s = 0;
    for (let i = 0; i < w * h; i++) s += (refBuf[i] = i & 255);
    return s;
  });
  out.msFresh = timed(() => freshMask(A1, w, h));
  out.msShared = timed(() => sharedMask(A1, w, h));
  return out;
};

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1200, height: 800 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  await page.waitForTimeout(500);

  let pass = 0;
  let fail = 0;
  const check = (name, ok, note = "") => {
    ok ? pass++ : fail++;
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${note ? " — " + note : ""}`);
  };

  for (const size of [[512, 384], [2000, 1500], [4000, 3000]]) {
    const r = await page.evaluate(RUN, size);
    console.log(`\n${size[0]}x${size[1]}`);
    for (const c of r.cases) {
      check(`${c.name}`, c.px === 0, c.px ? `${c.px} bytes differ, worst ${c.worst}` : "byte-for-byte");
      check(`  ...on a field worth comparing`, c.nonZero > size[0] * size[1] * 0.2 && c.distinct > 300,
        `${c.nonZero} non-transparent, ${c.distinct} distinct quarter-steps`);
    }
    check("the reused buffer's RGB stays zero", r.rgbNonZero === 0, `${r.rgbNonZero} px with colour`);
    check("a size change reallocates", r.reallocated === true);
    check("...and only a handful of times in total", r.allocsTotal <= 4, `${r.allocsTotal} allocations`);
    const speedup = r.msFresh / r.msShared;
    console.log(`  timing: fresh ${r.msFresh} ms, shared ${r.msShared} ms → ${speedup.toFixed(2)}x ` +
      `(reference loop ${r.msRef} ms for calibration)`);
    check("shared scratch is faster", speedup > 1.1, `${speedup.toFixed(2)}x`);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (errors.length) console.log("\nERRORS:\n" + errors.slice(0, 4).join("\n"));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
