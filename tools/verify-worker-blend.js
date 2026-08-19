/* Correctness rail: the smart-filter WORKER and the inline path must produce the
 * same product, for every blend mode and opacity.
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/verify-worker-blend.js
 *
 * WHY IT EXISTS. Handing the settled filter pass to a worker is only sound if the
 * two paths are interchangeable, and nothing checked that until a live region
 * frame seeded from a cached product and inherited a discrepancy. They were not:
 * both blended through a canvas at `globalAlpha`, and Chromium's
 * HTMLCanvasElement and OffscreenCanvas round that differently — measured on the
 * degenerate case of blending a colour over ITSELF at 70%, which must return that
 * colour:
 *
 *     HTMLCanvasElement    8 of 256 values wrong, rounded DOWN
 *     OffscreenCanvas     48 of 256 values wrong, rounded UP
 *
 * Both are now computed by app/lib/blend.ts instead, in exact arithmetic, so they
 * agree by construction and the result is correct rather than merely consistent.
 *
 * HOW IT MEASURES. Through `__gqRenderCache.filterAB()`, which diffs the cached
 * product against a fresh inline render of the same stack, and nothing else — the
 * earlier version diffed whole COMPOSITES, which drags in every group merge,
 * adjustment and layer blend on the way to the canvas and cannot localise a
 * disagreement to the filter at all.
 *
 * NON-VACUITY. "Zero difference" is also what you get from comparing two renders
 * of a configuration that never took effect. So every leg additionally asserts
 * that the product's digest MOVED when the blend mode changed — if setting the
 * mode did nothing, the run fails rather than passing quietly.
 */
const { chromium } = require("playwright-core");

const DOC_W = 800;
const DOC_H = 600;

/* One representative per shape of blend function, plus the two that are not
   blend functions at all: Normal (source-over) and Add (Porter-Duff plus). */
const MODES = [
  "Normal",
  "Multiply",
  "Screen",
  "Overlay",
  "Soft Light",
  "Color Dodge",
  "Difference",
  "Add",
  "Hue",
  "Luminosity",
];

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 }).catch(() => null);
  if (t) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
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
  await page.waitForTimeout(1600);

  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  await menu("Layer", "New layer");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1000);

  /* VARIED content. A flat fill would exercise exactly one colour value, and a
     blend is a per-value function — one value passing says very little. Paint a
     few strokes in the contrasting colour so the product spans a range. */
  await page.keyboard.press("b");
  await page.waitForTimeout(250);
  await page.locator('button[aria-label="Swap foreground and background colors"]').first().click();
  await page.waitForTimeout(300);
  await page
    .locator('[data-tour="options"] input[aria-label="Size"]')
    .first()
    .evaluate((el) => {
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      setter.call(el, "120");
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    });
  await page.waitForTimeout(400);
  for (const fy of [0.25, 0.5, 0.75]) {
    await page.mouse.move(box.x + box.width * 0.15, box.y + box.height * fy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(box.x + box.width * (0.15 + 0.08 * i), box.y + box.height * fy, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(800);

  await menu("Effects", "Blur (smart filter)");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1800);

  const sfd = page.locator('div[role="dialog"]').filter({ hasText: "Filter Mask" }).first();
  /** Wait for the in-flight worker job to land: filterAB reports null while the
   *  cached product's key is stale, which is exactly "not ready". */
  const settledAB = async () => {
    for (let i = 0; i < 25; i++) {
      const r = await page.evaluate(() => window.__gqRenderCache.filterAB());
      if (r) return r;
      await page.waitForTimeout(400);
    }
    return null;
  };
  /* The dialog holds TWO listbox Selects — the filter's own kind ("Gaussian")
     comes first, Blend second — so `.first()` drives the wrong control. Locate it
     by its label, and then VERIFY the trigger really is the blend one by checking
     its current value against the mode list: if the markup ever moves, this fails
     loudly instead of quietly setting a blur kind for the rest of the run. */
  const blendTrigger = () =>
    sfd
      .locator("div")
      .filter({ has: page.locator("span", { hasText: /^Blend$/ }) })
      .last()
      .locator('button[aria-haspopup="listbox"]')
      .first();
  const setMode = async (mode, opacityPresses) => {
    await menu("Effects", "Smart filters…");
    await sfd.waitFor({ timeout: 8000 });
    const trigger = blendTrigger();
    const shown = (await trigger.innerText()).trim();
    if (!MODES.includes(shown) && shown !== "Normal")
      check(`the Blend control was found (showing "${shown}")`, false, "selector drifted");
    await trigger.click();
    await page.waitForTimeout(300);
    await page.locator(`[role="option"]`).filter({ hasText: new RegExp(`^${mode}$`) }).first().click();
    await page.waitForTimeout(400);
    if (opacityPresses) {
      const op = sfd.locator('input[aria-label="Opacity"]').first();
      await op.focus();
      for (let i = 0; i < opacityPresses; i++) {
        await page.keyboard.press("ArrowLeft");
        await page.waitForTimeout(25);
      }
    }
    const opacity = await sfd.locator('input[aria-label="Opacity"]').first().inputValue();
    await page.keyboard.press("Escape");
    await page.waitForTimeout(1400);
    return opacity;
  };

  // Baseline: Normal at 100% never touches the blend path at all.
  const first = await settledAB();
  check("the cached product can be compared against an inline render", !!first,
    first ? `quality ${first.quality}` : "filterAB returned null");
  check("Normal @100 (no blend) agrees exactly", first && first.differing === 0,
    first ? `${first.differing} of ${first.total} bytes differ` : "");

  const seen = new Map();
  if (first) seen.set("Normal@100", first.digest);
  let opacity = await setMode("Normal", 30); // 100 -> 70
  let prevDigest = first ? first.digest : null;
  for (const mode of MODES) {
    const opv = await setMode(mode, 0);
    const r = await settledAB();
    if (!r) {
      check(`${mode} @${opv}: the product settled in time`, false, "filterAB still null after 10s");
      continue;
    }
    check(`${mode} @${opv}: worker and inline agree exactly`, r.differing === 0,
      `${r.differing} of ${r.total} bytes differ (worst Δ ${r.worst}` +
        (r.sample ? `, first at px ${r.sample.at}: ${r.sample.cached} vs ${r.sample.inline}` : "") + ")");
    // The mode must actually have reached the pixels, or "they agree" is empty.
    check(`…and switching to ${mode} changed the product`, r.digest !== prevDigest,
      `digest ${prevDigest} -> ${r.digest}`);
    prevDigest = r.digest;
    seen.set(`${mode}@${opv}`, r.digest);
    opacity = opv;
  }
  void opacity;

  // Every mode should also have produced a DISTINCT product from the others; two
  // modes collapsing onto one digest would mean the dialog never switched.
  const digests = [...seen.values()];
  check("every blend mode produced a distinct product", new Set(digests).size === digests.length,
    `${new Set(digests).size} distinct of ${digests.length}`);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  if (errors.length) console.log("\nCONSOLE ERRORS:\n" + errors.slice(0, 5).join("\n"));
  await browser.close();
  process.exit(failed.length || errors.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS FAIL:", e.message);
  process.exit(1);
});
