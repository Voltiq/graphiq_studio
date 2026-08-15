/* Interaction performance regression suite (TODO §8).
 *
 *   npm i -D playwright-core          (dev tooling; not a project dependency)
 *   npm run dev                       (the suite drives http://localhost:3000)
 *   node tools/perf-suite.js          (exit 1 if any scenario blows its budget)
 *
 * WHY THIS EXISTS. Every performance assumption made about this engine by
 * reading the code has been wrong at least once; only measurement caught it —
 * the smart-filter path blocking for 3.9 s and layer effects for 1.4 s, and,
 * pointing the other way, selection combines and per-pixel filters costing
 * essentially nothing. This pins the numbers so a regression is a failed run
 * rather than a bug report.
 *
 * WHAT IT MEASURES. Main-thread BLOCKING via PerformanceObserver('longtask') —
 * the thing that makes a UI feel stuck. Frame intervals are deliberately not
 * asserted: headless Chrome runs rAF unthrottled, so a "4 ms median frame" is an
 * artefact of the harness, not a property of the app.
 *
 * ISOLATION MATTERS. Each scenario builds its own layer and deletes it again, so
 * scenario N never composites over scenario N-1's filters. Without this the
 * per-pixel case read 151 ms — all of it the blurred and shadowed layers left
 * below it — and every budget after the first would measure the wrong thing.
 * `assertBaseline()` re-checks the layer count between scenarios so a teardown
 * that silently stops working fails the run instead of inflating the numbers.
 *
 * CALIBRATE FIRST. The budgets are absolute wall-clock, so on their own they
 * cannot tell "the code got slower" from "this machine got slower" — and the
 * second really happens: the same commit that scored 7/7 scored 2/7 a few hours
 * later, and an app-independent canvas benchmark showed the MACHINE had become
 * 1.5-3x slower (getImageData over 8 MB: 10.5 ms -> 30.5 ms). Chasing that as a
 * code regression cost a bisect and a git-stash scare. So the suite now measures
 * a reference primitive on a blank page before touching the app, and says
 * plainly when the machine is off-baseline.
 *
 * BUDGETS sit well above the measured figure (`budget` vs `was` per scenario) so
 * ordinary noise passes, while the regressions that actually happened — every
 * one of them 1.4 s and up — trip immediately.
 *
 * Companion tools that ATTRIBUTE cost rather than gate it:
 *   tools/bench-blur.js       kernel size vs fixed setup (C vs D)
 *   tools/bench-selection.js  wand flood+trace vs combineSelection (C0 vs C)
 *   tools/verify-region-scope.js  byte-identity rail for region-scoped renders
 */
const { chromium } = require("playwright-core");

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
};

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const page = await ctx.newPage();
  await page.addInitScript(INSTRUMENT);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
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

  // ---- machine calibration -------------------------------------------------
  // Deliberately app-independent: a bare canvas and two primitives the engine
  // leans on. If these are off, every number below is off for the same reason,
  // and a failure says nothing about the code.
  const CAL_BASELINE = { read: 10.5, loop: 14.5 }; // ms, recorded 2026-08-15
  const cal = await page.evaluate(() => {
    const w = 4000;
    const h = 3000;
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
      return +t[1].toFixed(1);
    };
    let sd = null;
    const read = med(() => {
      sd = ctx.getImageData(0, 0, w, h).data;
    });
    const a = new Float32Array(w * h);
    const loop = med(() => {
      for (let i = 0; i < w * h; i++) a[i] = sd[i * 4 + 3];
    });
    return { read, loop };
  });
  const machine = (cal.read / CAL_BASELINE.read + cal.loop / CAL_BASELINE.loop) / 2;
  console.log(
    `calibration: getImageData ${cal.read} ms (baseline ${CAL_BASELINE.read}), ` +
      `fill loop ${cal.loop} ms (baseline ${CAL_BASELINE.loop}) — machine is ` +
      `${machine.toFixed(2)}x baseline\n`,
  );
  if (machine > 1.3)
    console.log(
      "  WARNING: this machine is materially slower than when the budgets were set.\n" +
        "  Failures below are NOT evidence of a code regression. Re-measure on a quiet\n" +
        "  machine, or compare against a known-good commit on THIS one.\n",
    );

  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const layerRows = page.locator("li[data-selected]");
  const menu = async (top, item) => {
    await page.getByText(top, { exact: true }).first().click();
    await page.waitForTimeout(200);
    await page.getByText(item, { exact: true }).first().click();
    await page.waitForTimeout(700);
  };
  const stroke = async (fy) => {
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * fy);
    await page.mouse.down();
    for (let i = 1; i <= 20; i++)
      await page.mouse.move(box.x + box.width * (0.25 + 0.02 * i), box.y + box.height * fy);
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  const tool = async (key) => {
    await page.mouse.move(box.x + 30, box.y + 30); // focus the canvas, not a field
    await page.keyboard.press(key);
    await page.waitForTimeout(250);
  };
  /** A fresh layer flooded with colour, brush selected and sized up. */
  const setupLayer = async () => {
    await menu("Layer", "New layer");
    await tool("g");
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await page.waitForTimeout(600);
    await tool("b");
    for (let i = 0; i < 26; i++) await page.keyboard.press("]"); // fat brush
    await page.waitForTimeout(200);
  };
  // GQ_PERF_SELFTEST=1 skips teardown on purpose, to prove assertBaseline can
  // actually fail. A guard nobody has ever seen fail is a guard nobody knows
  // works — this suite exists precisely because untested assumptions were wrong.
  const selftest = process.env.GQ_PERF_SELFTEST === "1";
  const teardownLayer = async () => {
    await page.keyboard.press("Control+d"); // drop any selection
    await page.waitForTimeout(250);
    if (selftest) return;
    await menu("Layer", "Delete layer");
  };

  // The layer count the document must be back to before every scenario. A
  // teardown that stops working shows up here rather than as inflated timings.
  // Latch on null, not falsiness: this document starts at ZERO layers, so `if
  // (!baseLayers)` would keep re-baselining and quietly absorb a leak.
  let baseLayers = null;
  const assertBaseline = async (name) => {
    const n = await layerRows.count();
    if (baseLayers === null) baseLayers = n;
    else if (n !== baseLayers)
      throw new Error(`isolation broken before "${name}": ${n} layers, expected ${baseLayers}`);
  };

  const rows = [];
  const run = async (name, budget, was, setup, gesture) => {
    await assertBaseline(name);
    await setupLayer();
    if (setup) await setup();
    await page.evaluate(() => window.__perfStart());
    await gesture();
    const r = await page.evaluate(() => window.__perfStop());
    await teardownLayer();
    const ok = r.total <= budget;
    rows.push({ name, blocking: r.total, tasks: r.n, worst: r.worst, budget, was, ok });
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${name.padEnd(38)} ${String(r.total).padStart(5)} ms ` +
        `(budget ${budget}, was ${was})`,
    );
  };
  const escape = async (ms = 1000) => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(ms);
  };

  // ---- 1. baseline: painting with nothing attached -------------------------
  await run("stroke — plain layer", 60, 0, null, () => stroke(0.28));

  // ---- 2. smart filter — draft-resolution live path ------------------------
  const withBlur = async () => {
    await menu("Effects", "Blur (smart filter)");
    await escape(1100);
  };
  await run("stroke — blur smart filter", 400, 72, withBlur, () => stroke(0.4));

  // ---- 3. moving a selection over a filtered layer -------------------------
  await run(
    "move selection — blur filter",
    400,
    69,
    async () => {
      await withBlur();
      await tool("m");
      await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.3);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(500);
    },
    async () => {
      await tool("v");
      await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
      await page.mouse.down();
      for (let i = 1; i <= 25; i++)
        await page.mouse.move(
          box.x + box.width * (0.5 + 0.008 * i),
          box.y + box.height * (0.5 + 0.006 * i),
        );
      await page.mouse.up();
      await page.waitForTimeout(500);
    },
  );

  // ---- 4. layer effects — draft-resolution live path -----------------------
  await run(
    "stroke — drop shadow",
    400,
    64,
    async () => {
      await menu("Layer", "Layer style…");
      await page.waitForTimeout(900);
      const ds = page.locator('button[aria-label="Drop Shadow off"]').first();
      if (!(await ds.count())) throw new Error("Drop Shadow toggle not found");
      await ds.click(); // the LABEL only selects the row — the toggle is this button
      await page.waitForTimeout(600);
      await escape(900);
    },
    () => stroke(0.5),
  );

  // ---- 5. per-pixel filter — measured free; guards against a regression ----
  await run(
    "stroke — per-pixel stylize",
    150,
    0,
    async () => {
      await menu("Effects", "Stylize…");
      await page.waitForTimeout(600);
      const post = page.locator('[role="dialog"] button', { hasText: /posterize/i }).first();
      if (!(await post.count())) throw new Error("posterize mode not found");
      await post.click();
      await page.waitForTimeout(400);
      await escape(900);
    },
    () => stroke(0.6),
  );

  // ---- 6. wand add-clicks — flood fill + boundary trace --------------------
  await run("10 wand add-clicks", 1200, 637, () => tool("w"), async () => {
    for (let i = 0; i < 10; i++) {
      await page.keyboard.down("Control");
      await page.mouse.click(box.x + box.width * (0.2 + i * 0.06), box.y + box.height * 0.5);
      await page.keyboard.up("Control");
      await page.waitForTimeout(150);
    }
  });

  // ---- 7. triangle Apex sweep — a tool-option slider during a live gesture --
  let apexBox = null;
  await run(
    "apex sweep (30 steps)",
    150,
    0,
    async () => {
      await tool("m");
      for (let i = 0; i < 2; i++) {
        await page.keyboard.press("Shift+M"); // rect → ellipse → triangle
        await page.waitForTimeout(220);
      }
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.8, { steps: 10 });
      await page.mouse.up();
      await page.waitForTimeout(600);
      const apex = page.locator('[data-tour="options"] input[type="range"][aria-label="Apex"]').first();
      if (!(await apex.count())) throw new Error("Apex slider not found (wrong marquee shape?)");
      apexBox = await apex.boundingBox();
    },
    async () => {
      const b = apexBox;
      await page.mouse.move(b.x + b.width * 0.5, b.y + b.height / 2);
      await page.mouse.down();
      for (let i = 0; i <= 30; i++)
        await page.mouse.move(b.x + b.width * (0.15 + (0.7 * i) / 30), b.y + b.height / 2);
      await page.mouse.up();
      await page.waitForTimeout(400);
    },
  );

  // ---- report --------------------------------------------------------------
  console.log("\n  scenario                               blocking  tasks  worst  budget");
  for (const r of rows)
    console.log(
      `  ${r.name.padEnd(38)} ${String(r.blocking).padStart(5)} ms ${String(r.tasks).padStart(5)} ` +
        `${String(r.worst).padStart(6)} ${String(r.budget).padStart(7)}`,
    );
  if (errors.length) console.log("\nCONSOLE ERRORS:\n" + errors.join("\n"));
  if (machine > 1.3)
    console.log(
      `\nNOTE: the machine measured ${machine.toFixed(2)}x the calibration baseline, so any ` +
        `failure above is unproven until re-measured on a quiet machine.`,
    );
  const failed = rows.filter((r) => !r.ok);
  console.log(
    `\n${rows.length - failed.length}/${rows.length} scenarios within budget ` +
      `(document held at ${baseLayers} layer${baseLayers === 1 ? "" : "s"} between scenarios)`,
  );
  if (selftest) {
    console.error("SELFTEST: teardown was disabled but isolation never failed — guard is dead");
    await browser.close();
    process.exit(1);
  }
  await browser.close();
  if (failed.length || errors.length) process.exit(1);
})().catch((e) => {
  console.error("SUITE FAIL:", e.message);
  process.exit(1);
});
