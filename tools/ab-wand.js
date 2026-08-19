/* A/B rail for the wand: the SELECTION must not change.
 *
 * The boundary trace and the rect decomposition are covered exhaustively in
 * Node against the implementation they replaced (tests/mask-trace.test.ts), but
 * the flood fill is not — it lives inside magicWand with the colour match
 * inlined. So this drives the real app and fingerprints what the flood actually
 * selected, by FILLING the selection and measuring the filled pixels.
 *
 * Fingerprint per scenario: the exact count of filled pixels plus the filled
 * bounding box. A flood that changed by even one pixel moves the count.
 *
 * Run it once on the old implementation and once on the new; the numbers must
 * match to the pixel.
 *
 *   EXPECTED (measured identical before and after the run-based trace and the
 *   scanline flood, 2026-08-19):
 *     large flood      1959528 px  bbox 0,0 1920x1080
 *     blob flood         38024 px  bbox 290,190 220x220
 *     tolerance 80     2035576 px  bbox 0,0 1920x1080
 *     non-contiguous   2073600 px  bbox 0,0 1920x1080
 *
 * Non-vacuity: every scenario must select a DIFFERENT number of pixels, and the
 * blob must not select the background. If two rows ever print the same count the
 * fixture has collapsed and the rail is comparing nothing.
 */
const { chromium } = require("playwright-core");

const DOC_W = 1920;
const DOC_H = 1080;

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 }).catch(() => null);
  if (t) { await page.keyboard.press("Escape"); await page.waitForTimeout(700); }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);

  const menu = async (a, b) => {
    await page.getByText(a, { exact: true }).first().click();
    await page.waitForTimeout(220);
    await page.getByText(b, { exact: true }).first().click();
    await page.waitForTimeout(900);
  };
  const newDoc = async () => {
    await menu("File", "New…");
    const nd = page.locator('div[role="dialog"][aria-label="New document"]');
    await nd.waitFor({ timeout: 8000 });
    await nd.locator('input[type="number"]').nth(0).fill(String(DOC_W));
    await nd.locator('input[type="number"]').nth(1).fill(String(DOC_H));
    await nd.getByText("Create", { exact: true }).click();
    await page.waitForTimeout(1800);
  };
  const at = async (dx, dy) => {
    const b = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    return { x: b.x + (dx / DOC_W) * b.width, y: b.y + (dy / DOC_H) * b.height };
  };
  const opts = page.locator('[data-tour="options"]');
  const setVal = async (label, n) => {
    const row = opts.locator(`input[aria-label="${label}"]`).first();
    if ((await row.count()) === 0 || (await row.inputValue()) === String(n)) return;
    await row.locator("xpath=..").locator('[role="button"]').first().click();
    await page.waitForTimeout(180);
    await opts.locator(`input[aria-label="${label} value"]`).first().fill(String(n));
    await page.keyboard.press("Enter");
    await page.waitForTimeout(280);
  };

  await newDoc();
  // Deterministic artwork: three hard-edged blobs on the flat background.
  await page.getByRole("button", { name: "Brush" }).first().click();
  await page.waitForTimeout(400);
  await setVal("Size", 220);
  await setVal("Hardness", 100);
  await setVal("Flow", 100);
  await setVal("Opacity", 100);
  for (const [x, y] of [[400, 300], [1100, 700], [1500, 300]]) {
    const p = await at(x, y);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(500);
  }
  await page.waitForTimeout(900);

  await page.getByRole("button", { name: /^Magic wand/ }).first().click();
  await page.waitForTimeout(500);
  const setContig = async (on) => {
    const tog = opts.locator('button[role="switch"]').filter({ hasText: "Contiguous" }).first();
    if ((await tog.count()) === 0) return;
    if (((await tog.getAttribute("aria-checked")) === "true") !== on) {
      await tog.click();
      await page.waitForTimeout(400);
    }
  };

  /* Fill the selection with pure black on a NEW layer, then count exactly the
     pixels that became black. The fill honours the selection mask, so the count
     and bbox are a direct fingerprint of what the flood selected. */
  const fingerprint = async () => {
    await menu("Layer", "New layer");
    await page.waitForTimeout(700);
    await page.evaluate(() => window.graphiq.setForeground("#000000ff"));
    await page.waitForTimeout(300);
    await page.keyboard.press("Backspace"); // fill with the foreground
    await page.waitForTimeout(1400);
    const r = await page.evaluate(() => {
      const cv = document.querySelector('[data-tour="canvas"] canvas');
      const d = cv.getContext("2d").getImageData(0, 0, cv.width, cv.height).data;
      let n = 0, x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < cv.height; y++)
        for (let x = 0; x < cv.width; x++) {
          const i = (y * cv.width + x) * 4;
          if (d[i] < 12 && d[i + 1] < 12 && d[i + 2] < 12 && d[i + 3] > 240) {
            n++;
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
        }
      return n ? { n, x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null;
    });
    // Undo the fill and the layer so the next scenario starts clean.
    for (let i = 0; i < 3; i++) { await page.keyboard.press("Control+z"); await page.waitForTimeout(500); }
    await page.waitForTimeout(400);
    return r;
  };

  const run = async (label, docX, docY, tol, contiguous) => {
    await setContig(contiguous);
    await setVal("Tolerance", tol);
    const p = await at(docX, docY);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.up();
    await page.waitForTimeout(900);
    const f = await fingerprint();
    console.log(`  ${label.padEnd(18)} ${f ? `${String(f.n).padStart(8)} px  bbox ${f.x},${f.y} ${f.w}x${f.h}` : "NOTHING SELECTED"}`);
  };

  console.log("");
  await run("large flood", 900, 950, 32, true);
  await run("blob flood", 400, 300, 32, true);
  await run("tolerance 80", 900, 950, 80, true);
  await run("non-contiguous", 900, 950, 32, false);

  if (errors.length) console.log("\nERRORS: " + errors.slice(0, 3).join(" | "));
  await browser.close();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
