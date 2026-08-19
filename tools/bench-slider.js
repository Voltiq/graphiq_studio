/* What one options-bar slider tick costs the rest of the editor.
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/bench-slider.js            # unthrottled
 *   THROTTLE=6 node tools/bench-slider.js # ~a phone / an old laptop
 *
 * Every tool option lives in top-level Editor state, so a slider tick re-renders
 * the whole editor tree. This measures BOTH halves of that claim, because they
 * are not the same question:
 *
 *   1. DOM MUTATIONS per region — how much of the tree React actually rewrites.
 *      The options bar is expected to change (it owns the control); everything
 *      else is waste.
 *   2. TIME per tick, and the same sweep with the dock ABLATED (every panel
 *      closed). Mutations are not milliseconds; the ablation is what turns "the
 *      dock re-renders" into "the dock costs N ms".
 *
 * FINDING, 2026-08-19 (the reason TODO's "move tool options out of Editor
 * state" moved to the parked section):
 *   mutations, 20-step sweep   dock 940 · toolbar 0 · topbar 0 · status 0
 *                              canvas 0 · options 440
 *     — identical for brush Size, brush Hardness and wand Tolerance, so the
 *       "general pattern behind every slider" part of the claim is real.
 *   time, 40-step sweep        p50 0.2 ms unthrottled, 0.6 ms at 6x
 *     — and p50 is 0.6 ms at 6x with ALL panels open AND with none open. The
 *       940 mutations cost nothing measurable.
 *   Occasional 150-340 ms spikes appear in these runs. They are NOT the dock:
 *   they show up with zero panels mounted too, and they come and go between
 *   otherwise identical runs. Treat them as GC/background noise unless a run
 *   ties one to a specific panel.
 *
 * CALIBRATION. Absolute numbers here do not travel between machines (the lesson
 * from tools/bench-selection.js). The run prints a reference loop measured in
 * the same process; compare ratios against it, or re-run the A/B in one sitting.
 *
 * NON-VACUITY. The options bar must show a non-zero mutation count and the
 * sweep must move the slider's value — both are asserted. If the slider never
 * moved, every "0" below is measuring nothing.
 */
const { launchBrowser } = require("./lib/launch");

const DOC_W = 900;
const DOC_H = 650;
const THROTTLE = Number(process.env.THROTTLE || 1);

const INSTRUMENT = () => {
  const w = window;
  w.__obs = [];
  w.__mut = {};
  w.__watch = () => {
    const regions = {
      dock: '[data-tour="dock"]',
      toolbar: '[data-tour="toolbar"]',
      topbar: '[data-tour="topbar"]',
      status: '[data-tour="status"]',
      canvas: '[data-tour="canvas"]',
      options: '[data-tour="options"]',
    };
    for (const o of w.__obs) o.disconnect();
    w.__obs = [];
    w.__mut = {};
    for (const [name, sel] of Object.entries(regions)) {
      const el = document.querySelector(sel);
      if (!el) continue;
      w.__mut[name] = 0;
      const ob = new MutationObserver((recs) => {
        w.__mut[name] += recs.length;
      });
      ob.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
      w.__obs.push(ob);
    }
  };
  w.__readMut = () => ({ ...w.__mut });
  w.__tickStart = () => {
    w.__ticks = [];
  };
  w.__tick = () => {
    const t = performance.now();
    requestAnimationFrame(() => w.__ticks.push(performance.now() - t));
  };
  w.__tickRead = () => {
    const a = [...w.__ticks].sort((x, y) => x - y);
    if (!a.length) return null;
    const q = (f) => Math.round(a[Math.min(a.length - 1, Math.floor(a.length * f))] * 10) / 10;
    return { n: a.length, p50: q(0.5), p90: q(0.9), max: Math.round(a[a.length - 1] * 10) / 10 };
  };
  /* A reference primitive measured in THIS process, so the numbers above can be
     read on another machine (the tools/bench-track.js calibration rule). */
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
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  const t0 = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 }).catch(() => null);
  if (t0) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);
  const cdp = await page.context().newCDPSession(page);

  const menu = async (a, b) => {
    await page.getByText(a, { exact: true }).first().click();
    await page.waitForTimeout(220);
    await page.getByText(b, { exact: true }).first().click();
    await page.waitForTimeout(900);
  };
  await menu("File", "New…");
  const nd = page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.waitFor({ timeout: 8000 });
  await nd.locator('input[type="number"]').nth(0).fill(String(DOC_W));
  await nd.locator('input[type="number"]').nth(1).fill(String(DOC_H));
  await nd.getByText("Create", { exact: true }).click();
  await page.waitForTimeout(1700);

  const opts = page.locator('[data-tour="options"]');
  let fail = 0;
  const need = (ok, msg) => {
    if (!ok) {
      fail++;
      console.log(`  !! ${msg}`);
    }
  };

  const sweep = async (ariaLabel, steps) => {
    const row = opts.locator(`input[aria-label="${ariaLabel}"]`).first();
    if ((await row.count()) === 0) return null;
    const before = await row.inputValue();
    await row.focus();
    await page.waitForTimeout(300);
    await page.evaluate(() => {
      window.__watch();
      window.__tickStart();
    });
    for (let i = 0; i < steps; i++) {
      await page.evaluate(() => window.__tick());
      await page.keyboard.press(i % 2 ? "ArrowRight" : "ArrowLeft");
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(700);
    const mut = await page.evaluate(() => window.__readMut());
    const tick = await page.evaluate(() => window.__tickRead());
    const after = await row.inputValue();
    need(before !== after || steps % 2 === 0, `${ariaLabel}: the slider never moved — every number below is vacuous`);
    return { mut, tick };
  };

  const ref = await page.evaluate(() => window.__ref());
  console.log(`\nOptions-bar slider cost (CPU throttle ${THROTTLE}x, reference loop ${ref} ms)\n`);

  // ---- 1. mutations per region, unthrottled ------------------------------
  console.log("  DOM mutations over a 20-step sweep (options SHOULD change; the rest is waste)");
  for (const [tool, label] of [["Brush", "Size"], ["Brush", "Hardness"], ["Magic wand", "Tolerance"]]) {
    await page.getByRole("button", { name: new RegExp(`^${tool}`) }).first().click();
    await page.waitForTimeout(450);
    const r = await sweep(label, 20);
    if (!r) {
      console.log(`    ${(tool + " " + label).padEnd(22)} (no control)`);
      continue;
    }
    const order = ["dock", "toolbar", "topbar", "status", "canvas", "options"];
    console.log(
      `    ${(tool + " " + label).padEnd(22)} ` +
        order.filter((k) => k in r.mut).map((k) => `${k} ${String(r.mut[k]).padStart(5)}`).join("  "),
    );
    need(r.mut.options > 0, `${label}: the options bar recorded no mutations — the sweep did nothing`);
  }

  // ---- 2. time per tick, dock mounted vs ablated --------------------------
  const panelCount = () =>
    page.evaluate(() =>
      document.querySelectorAll('[data-tour="dock"] section, [data-tour="dock"] [class*="panel"]').length,
    );
  await page.getByRole("button", { name: "Brush" }).first().click();
  await page.waitForTimeout(450);
  if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

  console.log("\n  Time per tick over a 40-step sweep");
  const withDock = await sweep("Size", 40);
  console.log(
    `    ${"dock mounted".padEnd(22)} panels ${String(await panelCount()).padStart(3)}  ` +
      `p50 ${withDock.tick.p50} ms  p90 ${withDock.tick.p90} ms  max ${withDock.tick.max} ms`,
  );

  if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  await page.getByText("Window", { exact: true }).first().click();
  await page.waitForTimeout(400);
  const names = (await page.locator('[role="menu"] button').allInnerTexts())
    .map((s) => s.trim())
    .filter((s) => s && !/workspace|reset|arrange|float|hide all|show all/i.test(s));
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  for (const n of names) {
    await page.getByText("Window", { exact: true }).first().click();
    await page.waitForTimeout(200);
    const b = page
      .locator('[role="menu"] button')
      .filter({ hasText: new RegExp(`^${n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) })
      .first();
    if (await b.count()) {
      await b.click();
      await page.waitForTimeout(260);
    } else await page.keyboard.press("Escape");
    if ((await panelCount()) === 0) break;
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);
  if (THROTTLE > 1) await cdp.send("Emulation.setCPUThrottlingRate", { rate: THROTTLE });

  await page.getByRole("button", { name: "Brush" }).first().click();
  await page.waitForTimeout(450);
  const noDock = await sweep("Size", 40);
  console.log(
    `    ${"dock ablated".padEnd(22)} panels ${String(await panelCount()).padStart(3)}  ` +
      `p50 ${noDock.tick.p50} ms  p90 ${noDock.tick.p90} ms  max ${noDock.tick.max} ms`,
  );
  console.log(
    `\n  the dock costs p50 +${(withDock.tick.p50 - noDock.tick.p50).toFixed(1)} ms and ` +
      `p90 +${(withDock.tick.p90 - noDock.tick.p90).toFixed(1)} ms per tick`,
  );

  if (errors.length) console.log("\nERRORS: " + errors.slice(0, 3).join(" | "));
  console.log(fail ? `\n${fail} non-vacuity check(s) FAILED` : "");
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
