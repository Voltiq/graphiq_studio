/* A/B rail for renderStyled: the composite must not change.
 *
 *   npm i -D playwright-core   &&   npm run dev   &&   node tools/ab-effects.js
 *
 * Builds a deterministic five-effect composite on a 600x400 document (small
 * enough that the view canvas is 1:1, so nothing averages a difference away) and
 * prints an FNV-1a hash of the pixels. Change effects.ts, re-run, compare.
 *
 *   EXPECTED: nonEmptyPx 21788  HASH 5fae3d5
 *
 * The five effects are exactly those that consumed the old `layerMask`: drop
 * shadow and outer glow through the knockout, gradient overlay / inner shadow /
 * inner glow through destination-in.
 *
 * It earned its keep immediately. Of two changes that both looked obviously
 * safe, it passed one and failed the other:
 *   - replacing layerMask with `src` (alpha-only ops)      -> identical
 *   - dropping willReadFrequently on the mask canvas       -> 445 of 21,788
 *     non-empty pixels disappeared, despite being 10 ms faster
 * Reasoning alone had called both of them safe.
 *
 * Non-vacuity: the run prints how many of the five effects it actually managed
 * to enable, and the non-empty pixel count. If either collapses, the hash is
 * comparing the wrong thing.
 */
const { chromium } = require("playwright-core");
(async () => {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 }).catch(() => null);
  if (t) { await page.keyboard.press("Escape"); await page.waitForTimeout(700); }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);
  const menu = async (a, b) => {
    await page.getByText(a, { exact: true }).first().click();
    await page.waitForTimeout(200);
    await page.getByText(b, { exact: true }).first().click();
    await page.waitForTimeout(700);
  };
  await menu("File", "New…");
  const dlg = page.locator('div[role="dialog"][aria-label="New document"]');
  await dlg.waitFor({ timeout: 8000 });
  const nums = dlg.locator('input[type="number"]');
  await nums.nth(0).fill("600");
  await nums.nth(1).fill("400");
  await dlg.getByText("Create", { exact: true }).click();
  await page.waitForTimeout(2000);

  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  await menu("Layer", "New layer");
  await page.mouse.move(box.x + 30, box.y + 30);
  await page.keyboard.press("b");
  await page.waitForTimeout(200);
  for (let i = 0; i < 18; i++) await page.keyboard.press("]");
  await page.waitForTimeout(200);
  // A deterministic silhouette with real edges.
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.35);
  await page.mouse.down();
  for (let i = 1; i <= 16; i++)
    await page.mouse.move(box.x + box.width * (0.3 + 0.025 * i), box.y + box.height * (0.35 + (i % 2 ? 0.05 : -0.03)));
  await page.mouse.up();
  await page.waitForTimeout(800);

  await menu("Layer", "Layer style…");
  await page.waitForTimeout(1000);
  const wanted = ["Drop Shadow", "Outer Glow", "Inner Shadow", "Inner Glow", "Gradient Overlay"];
  const on = [];
  for (const name of wanted) {
    const b = page.locator(`button[aria-label="${name} off"]`).first();
    if (await b.count()) { await b.click(); await page.waitForTimeout(500); on.push(name); }
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(1500);

  const res = await page.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    const ctx = c.getContext("2d");
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    // FNV-1a over the pixels
    let hash = 2166136261 >>> 0;
    let nonEmpty = 0;
    for (let i = 0; i < d.length; i++) { hash ^= d[i]; hash = Math.imul(hash, 16777619) >>> 0; }
    for (let i = 3; i < d.length; i += 4) if (d[i] > 0) nonEmpty++;
    return { size: `${c.width}x${c.height}`, hash: hash.toString(16), nonEmpty };
  });
  console.log(`effects enabled: ${on.join(", ")} (${on.length}/5)`);
  console.log(`view ${res.size}  nonEmptyPx ${res.nonEmpty}  HASH ${res.hash}`);
  if (errors.length) console.log("ERRORS: " + errors.join("; "));
  await browser.close();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
