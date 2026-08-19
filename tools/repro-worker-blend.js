/* Reproducer for an OPEN defect: the smart-filter worker and the inline path
 * disagree by 1 whenever a filter carries a blend mode or a partial opacity.
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/repro-worker-blend.js
 *
 * This is not a rail — it demonstrates a known-bad behaviour, so it exits 0 while
 * the defect is present and prints what it measured. It exits non-zero only if
 * the harness itself failed, or if the CONTROL leg breaks: a filter at 100% /
 * Normal takes the straight-replace path and must always agree exactly. If that
 * one starts differing, something new is wrong.
 *
 * WHAT IT SHOWS. No live session is involved. A settled composite computed by
 * app/workers/filters.worker.ts is compared against the same composite computed
 * inline by renderFiltered (forced by __gqRenderCache.disable(), which makes
 * filteredProduct compute in-line and skip the product cache).
 *
 *   blur at 100% / Normal    0 of 1,920,000 bytes differ
 *   blur at 70% opacity      480,000 of 1,920,000 bytes differ, worst delta 1
 *
 * 480,000 is exactly the pixel count: one byte per pixel, the RED channel, and
 * every one of them -1. The blend branch is the only difference between the two
 * legs — both paths do putImageData -> drawImage at globalAlpha -> getImageData,
 * but the worker's canvas is an OffscreenCanvas and the engine's is an
 * HTMLCanvasElement, and the two rasterisers do not round the composite the same
 * way. The clean fix is to stop routing the common case through a canvas at all:
 * source-over at partial alpha is exact Porter-Duff arithmetic, cheap in JS, and
 * would remove a full-canvas round trip from both paths. Real blend modes would
 * still need the canvas (there is no JS blend-mode implementation in the tree).
 */
const { chromium } = require("playwright-core");

const DOC_W = 800;
const DOC_H = 600;

(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
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
  await page.waitForTimeout(1600);

  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  await menu("Layer", "New layer");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("g");
  await page.waitForTimeout(250);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(1200);
  await page.keyboard.press("b");
  await page.waitForTimeout(250);

  /** Cached (worker) composite vs the same one forced through the inline path. */
  const diffAgainstInline = async () => {
    await page.evaluate((w) => {
      const cv = document.querySelector(`canvas[width="${w}"]`);
      window.__was = cv
        .getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, cv.width, cv.height)
        .data.slice();
    }, DOC_W);
    await page.evaluate(() => window.__gqRenderCache.disable());
    await page.waitForTimeout(300);
    await page.keyboard.press("Control+z"); // any journalled change forces a recomposite
    await page.waitForTimeout(700);
    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(1400);
    const d = await page.evaluate((w) => {
      const cv = document.querySelector(`canvas[width="${w}"]`);
      const now = cv.getContext("2d", { willReadFrequently: true }).getImageData(0, 0, cv.width, cv.height).data;
      const was = window.__was;
      const chan = [0, 0, 0, 0];
      const sign = [0, 0, 0, 0];
      let n = 0;
      let worst = 0;
      for (let i = 0; i < now.length; i++) {
        const delta = now[i] - was[i];
        if (!delta) continue;
        n++;
        chan[i & 3]++;
        sign[i & 3] += Math.sign(delta);
        if (Math.abs(delta) > worst) worst = Math.abs(delta);
      }
      return { n, worst, chan, sign, total: now.length };
    }, DOC_W);
    await page.evaluate(() => window.__gqRenderCache.enable());
    await page.waitForTimeout(400);
    return d;
  };
  const stroke = async (fy) => {
    await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * fy);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(box.x + box.width * (0.25 + 0.05 * i), box.y + box.height * fy, { steps: 2 });
    await page.mouse.up();
    await page.waitForTimeout(2000);
  };
  const report = (label, d) =>
    console.log(
      `  ${label.padEnd(26)} ${String(d.n).padStart(7)} of ${d.total} bytes differ` +
        `  worst Δ ${d.worst}  by channel [R,G,B,A] ${JSON.stringify(d.chan)}` +
        `  signed ${JSON.stringify(d.sign)}`,
    );

  console.log("\nSmart-filter worker vs inline renderFiltered (no live session)\n");
  await menu("Effects", "Blur (smart filter)");
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1800);
  await stroke(0.3);
  const control = await diffAgainstInline();
  report("blur at 100% / Normal", control);

  await menu("Effects", "Smart filters…");
  const sfd = page.locator('div[role="dialog"]').filter({ hasText: "Filter Mask" }).first();
  await sfd.waitFor({ timeout: 8000 });
  const op = sfd.locator('input[aria-label="Opacity"]').first();
  await op.focus();
  for (let i = 0; i < 30; i++) {
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(35);
  }
  const val = await op.inputValue();
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1800);
  await stroke(0.5);
  const blended = await diffAgainstInline();
  report(`blur at ${val}% opacity`, blended);

  console.log(
    blended.n > 0
      ? `\n  the defect is PRESENT (${blended.n} bytes, worst Δ ${blended.worst})`
      : "\n  the defect appears to be FIXED — retire this reproducer and its TODO item",
  );
  let fail = 0;
  if (control.n !== 0) {
    fail = 1;
    console.log("  !! the CONTROL leg differs too — a filter at 100% / Normal must agree exactly");
  }
  if (errors.length) console.log("\nERRORS: " + errors.slice(0, 4).join(" | "));
  await browser.close();
  process.exit(fail || errors.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS FAIL:", e.message);
  process.exit(1);
});
