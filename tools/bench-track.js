/* Tracked performance benchmarks (TODO §15).
 *
 *   npm i -D playwright-core          (dev tooling; esbuild comes with vitest)
 *   npm run dev                       (only the composite half needs it)
 *   npm run bench                     both halves, appends a record
 *   npm run bench -- --filters-only   no browser
 *   npm run bench -- --no-record      measure and compare, write nothing
 *
 * TWO NUMBERS, MEASURED WHERE THEY LIVE.
 *
 *   Filter throughput — megapixels per second for each of the 19 filters. The
 *   passes are pure ImageData maths, so this half needs no browser. MP/s rather
 *   than ms because it stays meaningful if the fixture size ever changes.
 *
 *   Composite time vs layer count — 1…32 layers in the real app, timed by the
 *   engine's own composite clock (`__gqPerf.stats().lastMs`) rather than by
 *   wrapping an export, whose PNG encode would dwarf the thing being measured.
 *   The headline is the fitted MARGINAL cost: what one more layer costs.
 *
 * WHY IT BUNDLES INSTEAD OF USING tsx. The filters are TypeScript, so something
 * has to transpile them, and the choice turned out to matter enormously: run
 * under `tsx`, the same benchmark file reported Add Noise at 128.7 ms and, run
 * under plain `node`, 17.0 ms — a 7.5x gap, from the runtime alone. A benchmark
 * that misranks the filters by 7x is worse than none, so this bundles the module
 * with esbuild and measures it in plain node. (Next also bundles, so the bundled
 * shape is the closer analogue of production anyway.)
 *
 * WHY IT NORMALIZES, AND WHY IT DOES NOT TRUST ITSELF TOO FAR. `tools/perf-suite.js`
 * records the lesson the hard way: the same commit scored 7/7 and then 2/7 hours
 * later because the MACHINE had become 1.5–3x slower, and chasing that as a code
 * regression cost a bisect. Absolute wall-clock cannot separate "the code got
 * slower" from "this computer got slower". So every record carries its own
 * calibration — reference primitives measured in the same process, at the same
 * moment — and comparisons are scaled by the ratio between two runs'
 * calibrations. That scaling is an approximation, not a fact: it assumes the
 * benchmark and the reference slow down together, which usually holds and
 * sometimes does not. So a difference is only called out past a wide threshold,
 * raw and normalized figures are both printed, and the word is "flagged".
 *
 * Unlike `tools/perf-suite.js` this file has no budgets and never fails a build:
 * it exists to make a trend visible, and a benchmark that fails CI on a noisy
 * machine gets muted within a week.
 *
 * IT FOUND SOMETHING ON ITS FIRST RUN. Add Noise — a hash and three adds —
 * ranked slowest of all nineteen filters, below Oil Paint and Median. It was
 * allocating a closure per pixel, ~400 000 per pass. Hoisting it made the pass
 * 2.5x faster with byte-identical output (the golden images did not move).
 *
 * History accumulates in tools/perf-history.json, newest last.
 */
const { execSync } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { pathToFileURL } = require("node:url");

const argv = process.argv.slice(2);
const FILTERS_ONLY = argv.includes("--filters-only");
const NO_RECORD = argv.includes("--no-record");
const URL_ARG = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "http://localhost:3000";
})();

const ROOT = join(__dirname, "..");
const HISTORY = join(__dirname, "perf-history.json");
const TMP = join(__dirname, ".tmp");
const BENCH_W = 768;
const BENCH_H = 512;
const MEGAPIXELS = (BENCH_W * BENCH_H) / 1e6;
/** Doublings, so the curve's shape shows in six points rather than thirty. */
const LAYER_STEPS = [1, 2, 4, 8, 16, 32];
const FILTER_TYPES = [
  "blur", "sharpen", "noise", "pixelate", "distort", "stylize", "highpass", "median",
  "dustscratches", "denoise", "lens", "dehaze", "clarity", "grain", "oil", "halftone",
  "crystallize", "glitch", "canvasshadow",
];

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};
const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * Median of `runs` timings after `warmups` untimed ones.
 *
 * The median is because one slow run — a GC pause, another process waking up —
 * is the normal case, and a mean would carry it into the recorded history for
 * ever. The warm-up count is not a formality: with a single warm-up, run-to-run
 * spread on IDENTICAL code reached 67% for Add Noise, 51% for Dehaze and 23% for
 * Stylize, and it was bimodal rather than scattered — the signature of V8
 * tiering up part-way through, so a run either caught the optimized code or did
 * not. Four warm-ups bring most filters inside 5%; Stylize still moves ~21% and
 * Dehaze ~14%, which is what FLAG_PCT is set from.
 */
function timed(fn, runs = 7, warmups = 4) {
  for (let i = 0; i < warmups; i++) fn();
  const ts = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    fn();
    ts.push(performance.now() - t0);
  }
  return median(ts);
}

// ---------------------------------------------------------------------------
// Node half — filter throughput
// ---------------------------------------------------------------------------

/** Two app-independent primitives standing in for what the filters mostly do:
 *  move bytes, and evaluate transcendentals per pixel. */
function calibrateNode() {
  const n = 4 << 20;
  const src = new Uint8ClampedArray(n);
  for (let i = 0; i < n; i++) src[i] = i & 255;
  const dst = new Uint8ClampedArray(n);
  const copy = timed(() => dst.set(src), 3, 2);
  const f = new Float64Array(1 << 20);
  const math = timed(() => {
    for (let i = 0; i < f.length; i++) f[i] = Math.pow((i & 255) / 255, 2.2);
  }, 3, 2);
  return { copy: round(copy), math: round(math) };
}

/** Bundle filters.ts (plus the ImageData stand-in the golden tests use, since
 *  Node has no such global) into one ESM file this process can import. */
async function loadFilters() {
  const esbuild = require("esbuild");
  mkdirSync(TMP, { recursive: true });
  const outfile = join(TMP, "filters.bundle.mjs");
  await esbuild.build({
    stdin: {
      contents: `import "./tests/setup";\nexport { applyFilter, defaultFilter } from "./app/lib/filters";\n`,
      resolveDir: ROOT,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: "node20",
    outfile,
    logLevel: "warning",
  });
  return import(pathToFileURL(outfile).href);
}

/** Deterministic and structured — a flat fill would let any filter with an
 *  early-out for uniform regions look artificially fast. Partly transparent,
 *  because several passes branch on alpha. */
function benchImage() {
  const d = new Uint8ClampedArray(BENCH_W * BENCH_H * 4);
  for (let y = 0; y < BENCH_H; y++) {
    for (let x = 0; x < BENCH_W; x++) {
      const o = (y * BENCH_W + x) * 4;
      d[o] = (x * 3) & 255;
      d[o + 1] = (y * 5) & 255;
      d[o + 2] = (x ^ y) & 255;
      d[o + 3] = x > 40 && y > 40 && x < BENCH_W - 40 && y < BENCH_H - 40 ? 255 : 128;
    }
  }
  return new ImageData(d, BENCH_W, BENCH_H, { colorSpace: "srgb" });
}

async function filterThroughput() {
  const { applyFilter, defaultFilter } = await loadFilters();
  const img = benchImage();
  const out = {};
  for (const type of FILTER_TYPES) {
    const f = defaultFilter(type);
    const ms = timed(() => void applyFilter(img, f, "srgb"));
    out[type] = round((MEGAPIXELS / ms) * 1000); // MP/s
  }
  return out;
}

// ---------------------------------------------------------------------------
// Browser half — composite time vs layer count
// ---------------------------------------------------------------------------

async function compositeSeries() {
  const { chromium } = require("playwright-core");
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  try {
    const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
    await page.goto(URL_ARG, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
    const tour = await page
      .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 })
      .catch(() => null);
    if (tour) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(700);
    }
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await page.waitForTimeout(600);

    if ((await page.evaluate(() => typeof window.__gqPerf)) !== "object") {
      console.log("  __gqPerf is missing (it is dev-only) — skipping the composite series.\n");
      return null;
    }

    // The browser's own calibration: the same two ideas as the Node one, but
    // through a canvas, since that is what the compositor actually costs.
    const cal = await page.evaluate(() => {
      const w = 2000;
      const h = 1500;
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      ctx.fillStyle = "rgba(200,120,60,0.8)";
      ctx.fillRect(0, 0, w, h);
      const med = (fn) => {
        const t = [];
        for (let i = 0; i < 3; i++) {
          const t0 = performance.now();
          fn();
          t.push(performance.now() - t0);
        }
        t.sort((a, b) => a - b);
        return Math.round(t[1] * 100) / 100;
      };
      let sd = null;
      const copy = med(() => {
        sd = ctx.getImageData(0, 0, w, h).data;
      });
      const a = new Float32Array(w * h);
      const math = med(() => {
        for (let i = 0; i < w * h; i++) a[i] = Math.pow(sd[i * 4 + 3] / 255, 2.2);
      });
      return { copy, math };
    });

    const menu = async (a, b) => {
      await page.getByText(a, { exact: true }).first().click();
      await page.waitForTimeout(220);
      await page.getByText(b, { exact: true }).first().click();
      await page.waitForTimeout(900);
    };
    await menu("File", "New…");
    const dlg = page.locator('div[role="dialog"][aria-label="New document"]');
    await dlg.waitFor({ timeout: 8000 });
    await dlg.locator('input[type="number"]').nth(0).fill("1920");
    await dlg.locator('input[type="number"]').nth(1).fill("1080");
    await dlg.getByText("Create", { exact: true }).click();
    await page.waitForTimeout(1800);

    // One painted layer carrying a drop shadow, then duplicates of it.
    // Duplicating rather than painting each keeps every layer's content
    // identical, so the only variable across the series is how MANY there are.
    // The shadow is what makes the COLD series mean anything: a plain layer
    // composites with one `drawImage`, and the cost worth tracking is
    // `renderStyled`.
    const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await page.getByRole("button", { name: "Brush" }).first().click();
    await page.waitForTimeout(300);
    for (let i = 0; i < 14; i++) await page.keyboard.press("]");
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.25);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 24 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    await page.evaluate(() => window.graphiq.run("fx-add-dropShadow"));
    await page.waitForTimeout(900);
    for (let i = 0; i < 3 && (await page.locator('div[role="dialog"]').count()); i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }

    /** WARM: opacity is EXTRINSIC to the cache key, so toggling it re-composites
     *  the whole document without invalidating one cached product — the state
     *  the app is in while a user drags a slider. */
    const measureWarm = async () => {
      const samples = [];
      for (let i = 0; i < 9; i++) {
        await page.evaluate((op) => {
          const id = window.graphiq.layers()[0]?.id;
          if (id) window.graphiq.setLayer(id, { opacity: op });
        }, i % 2 ? 100 : 99);
        await page.waitForTimeout(180);
        const ms = await page.evaluate(() => window.__gqPerf.stats().lastMs);
        if (ms > 0) samples.push(ms);
      }
      return samples.length ? round(median(samples)) : 0;
    };

    /** COLD: every styled product recomputed — the first frame after a change,
     *  which is where the time actually goes. `disable()` clears the cache and
     *  emits, so the composite it triggers is the uncached one. */
    const measureCold = async () => {
      const samples = [];
      for (let i = 0; i < 3; i++) {
        await page.evaluate(() => window.__gqRenderCache.disable());
        await page.waitForTimeout(700);
        const ms = await page.evaluate(() => window.__gqPerf.stats().lastMs);
        if (ms > 0) samples.push(ms);
        await page.evaluate(() => window.__gqRenderCache.enable());
        await page.waitForTimeout(500);
      }
      return samples.length ? round(median(samples)) : 0;
    };

    const series = [];
    let made = 1;
    for (const target of LAYER_STEPS) {
      while (made < target) {
        await page.evaluate(() => window.graphiq.run("layer-duplicate"));
        await page.waitForTimeout(320);
        made++;
      }
      const count = await page.evaluate(() => window.graphiq.layers().length);
      if (count !== target) {
        console.log(`  WARNING: wanted ${target} layers, the document has ${count} — skipping this point.`);
        continue;
      }
      series.push({ layers: target, ms: await measureWarm(), coldMs: await measureCold() });
    }
    return { cal, series };
  } finally {
    await browser.close();
  }
}

/** Least-squares fit of ms = base + perLayer·n over `key`. */
function fit(series, key) {
  const n = series.length;
  if (!n) return { base: 0, perLayer: 0 };
  const sx = series.reduce((a, s) => a + s.layers, 0);
  const sy = series.reduce((a, s) => a + s[key], 0);
  const sxx = series.reduce((a, s) => a + s.layers * s.layers, 0);
  const sxy = series.reduce((a, s) => a + s.layers * s[key], 0);
  const denom = n * sxx - sx * sx;
  if (!denom) return { base: round(sy / n), perLayer: 0 };
  const perLayer = (n * sxy - sx * sy) / denom;
  return { base: round((sy - perLayer * sx) / n), perLayer: round(perLayer, 3) };
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

/** How much slower this machine is than the one that took `prev`, judged only
 *  by the reference primitives. */
const machineRatio = (now, prev) => (now.copy / prev.copy + now.math / prev.math) / 2;

/**
 * The threshold is measured, not chosen. Running the filter half four times
 * over unchanged code, the worst run-to-run spread was 20.6% (Stylize) with
 * Dehaze at 13.5% and everything else inside 6%; at the 25% this started with,
 * a clean re-run flagged Dehaze as a 27% regression. 35% sits above the
 * observed floor while still catching anything worth a look — the regressions
 * this codebase has actually had were 1.4 s and up, i.e. multiples, not
 * percentages. Re-derive it (scratch script, four runs, per-filter min/max) if
 * the fixture or the sample counts change.
 */
const FLAG_PCT = 35;

function delta(now, then, machine, higherIsBetter) {
  if (!then || !now) return "";
  const norm = higherIsBetter ? (now * machine) / then : now / (then * machine);
  const pct = (norm - 1) * 100;
  const worse = higherIsBetter ? norm < 1 : norm > 1;
  const mark = Math.abs(pct) >= FLAG_PCT ? (worse ? "  <-- FLAGGED" : "  <-- improved") : "";
  return `${pct >= 0 ? "+" : ""}${round(pct, 1)}%${mark}`;
}

(async () => {
  console.log("\nGraphiq performance benchmarks\n");

  const nodeCal = calibrateNode();
  console.log(`node calibration: copy ${nodeCal.copy} ms, math ${nodeCal.math} ms`);
  const filters = await filterThroughput();

  const snap = {
    at: new Date().toISOString(),
    commit: (() => {
      try {
        return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
      } catch {
        return null;
      }
    })(),
    node: process.version,
    nodeCal,
    filters,
  };

  if (!FILTERS_ONLY) {
    console.log("composite series: driving the app…");
    const comp = await compositeSeries().catch((e) => {
      console.log(`  could not reach ${URL_ARG} (${String(e.message).split("\n")[0]}) — filters only.\n`);
      return null;
    });
    if (comp) {
      snap.browserCal = comp.cal;
      snap.composite = {
        series: comp.series,
        warm: fit(comp.series, "ms"),
        cold: fit(comp.series, "coldMs"),
      };
    }
  }

  const history = existsSync(HISTORY) ? JSON.parse(readFileSync(HISTORY, "utf8")) : [];
  const prev = history.length ? history[history.length - 1] : null;
  const nodeM = prev ? machineRatio(nodeCal, prev.nodeCal) : 1;

  console.log(
    `\nfilter throughput — ${BENCH_W}x${BENCH_H} (${round(MEGAPIXELS)} MP), MP/s, higher is better` +
      (prev
        ? `\n(vs ${prev.commit ?? "the previous run"}; this machine measured ${round(nodeM)}x that one)`
        : ""),
  );
  for (const name of Object.keys(filters).sort((a, b) => filters[b] - filters[a])) {
    const d = prev && prev.filters[name] ? delta(filters[name], prev.filters[name], nodeM, true) : "";
    console.log(
      `  ${name.padEnd(14)} ${String(filters[name]).padStart(8)} MP/s   ` +
        `${round((MEGAPIXELS / filters[name]) * 1000, 1).toString().padStart(7)} ms   ${d}`,
    );
  }

  if (snap.composite) {
    const bM = prev && prev.browserCal && snap.browserCal ? machineRatio(snap.browserCal, prev.browserCal) : 1;
    const c = snap.composite;
    console.log(
      "\ncomposite time vs layer count — 1920x1080, one drop shadow per layer\n" +
        "  warm = caches intact (a slider drag);  cold = every styled product recomputed",
    );
    for (const s of c.series) {
      const was = prev && prev.composite && prev.composite.series.find((p) => p.layers === s.layers);
      console.log(
        `  ${String(s.layers).padStart(2)} layers   warm ${String(s.ms).padStart(6)} ms   ` +
          `cold ${String(s.coldMs).padStart(7)} ms   ` +
          (was && was.coldMs ? delta(s.coldMs, was.coldMs, bM, false) : ""),
      );
    }
    console.log(`  warm fit: ${c.warm.base} ms + ${c.warm.perLayer} ms per layer`);
    // Below ~0.3 ms the browser's clock (100 us granularity) is most of what is
    // being read, so the warm slope is a floor statement, not a measurement.
    if (c.warm.base + c.warm.perLayer * 32 < 1)
      console.log("            (at the browser clock's 0.1 ms resolution — plain compositing is a blit)");
    console.log(
      `  cold fit: ${c.cold.base} ms + ${c.cold.perLayer} ms per styled layer` +
        (prev && prev.composite && prev.composite.cold
          ? `   (was ${prev.composite.cold.base} + ${prev.composite.cold.perLayer}; per-layer ` +
            `${delta(c.cold.perLayer, prev.composite.cold.perLayer, bM, false) || "unchanged"})`
          : ""),
    );
  }

  rmSync(TMP, { recursive: true, force: true });

  if (NO_RECORD) {
    console.log("\n--no-record: history not written.");
    return;
  }
  history.push(snap);
  writeFileSync(HISTORY, JSON.stringify(history, null, 1) + "\n");
  console.log(`\nrecorded to tools/perf-history.json (${history.length} run${history.length === 1 ? "" : "s"})`);
})().catch((e) => {
  rmSync(TMP, { recursive: true, force: true });
  console.error("BENCH FAILURE:", e.message);
  process.exit(1);
});
