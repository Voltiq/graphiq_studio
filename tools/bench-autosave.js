/* How long does an autosave block the main thread?
 *
 * It matters more than it looks. The snapshot now also runs when the page is
 * hidden — which on a phone is exactly when the OS is deciding whether to keep
 * the tab — so a freeze there is a freeze at the worst possible moment.
 *
 * BASELINE, 4000x3000 photographic layer, encoding on the main thread with
 * `canvas.toDataURL()`:
 *
 *     AUTOSAVE: 1 long task, 1066 ms blocked, worst 1066 ms
 *
 * AFTER moving the encode into app/workers/png.worker.ts:
 *
 *     AUTOSAVE: 0-1 long tasks, 0-99 ms blocked
 *
 * What is left is JSON.stringify over the base64 and the IndexedDB write, both
 * of which scale with how many documents are open rather than with the encode.
 *
 * WHY NOT toBlob, since it is the obvious answer: it is async in shape but
 * still encodes on the caller's thread — measured at 409 ms blocked for a
 * single 12-megapixel layer, worse than toDataURL's 333 ms. An ImageBitmap is
 * transferable and costs the main thread nothing to make (0 ms for three such
 * layers), which is what makes the worker route work.
 *
 * The picture has to be INCOMPRESSIBLE to mean anything: an empty 4000x3000
 * layer encodes in 143 ms and stores as 0.3 MB, and a first attempt at this
 * measurement drew strokes on blank layers and reported a comfortable 77 ms
 * while the real case was 14x worse.
 *
 * Run: node tools/bench-autosave.js [--url ...] [--channel ...]
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const { launchBrowser, urlArg } = require("./lib/launch");

const W = 4000;
const H = 3000;

/** A 4000x3000 PNG of pure noise — nothing for the encoder to compress. */
function writeNoisePng() {
  const raw = Buffer.alloc(H * (1 + W * 4));
  let seed = 12345;
  let o = 0;
  for (let y = 0; y < H; y++) {
    raw[o++] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      raw[o++] = seed & 255;
      raw[o++] = (seed >> 8) & 255;
      raw[o++] = (seed >> 16) & 255;
      raw[o++] = 255;
    }
  }
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  const png = Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 1 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
  const file = path.join(os.tmpdir(), `graphiq-bench-noise-${W}x${H}.png`);
  fs.writeFileSync(file, png);
  return { file, mb: (png.length / 1048576).toFixed(1) };
}

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
  const { file, mb } = writeNoisePng();
  console.log(`noise source: ${W}x${H}, ${mb} MB -> ${file}`);

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  await context.addInitScript(INSTRUMENT);
  const page = await context.newPage();
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const tour = await page
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.waitForTimeout(800);

  await page.locator('input[type="file"][accept*="image/*"]').first().setInputFiles(file);
  await page.waitForTimeout(5000);
  const dialog = page.locator('div[role="dialog"]').first();
  if (await dialog.count()) {
    const footer = dialog.locator("footer button");
    if (await footer.count()) await footer.last().click();
    else await page.keyboard.press("Enter");
  }
  await page.waitForTimeout(12000);
  console.log(
    "document:",
    await page.evaluate(() => {
      const c = document.querySelector('[data-tour="canvas"] canvas');
      return c ? `${c.width}x${c.height}` : "?";
    }),
  );

  // A stroke, so the snapshot has something new to write.
  await page.keyboard.press("b");
  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.55);
  await page.mouse.up();
  await page.waitForTimeout(1500);

  await page.evaluate(() => window.__perfStart());
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(20000);
  const perf = await page.evaluate(() => window.__perfStop());
  console.log(
    `AUTOSAVE: ${perf.n} long task(s), ${perf.total} ms blocked, worst ${perf.worst} ms` +
      `   ${perf.total < 100 ? "(under the 100 ms budget)" : "(OVER the 100 ms budget)"}`,
  );

  await browser.close();
  fs.unlinkSync(file);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
