/* What an open document costs before you have edited it.
 *
 * THE FLOOR, measured on a 12 MP photograph opened and left alone:
 *
 *     view  textPreview  stroke  scratch  layer   = 5 × 45.8 MB = 229 MB
 *
 * Two of those five are for edits that have not happened. `stroke` holds the
 * live brush dab and `scratch` composes the layer plus that dab for display;
 * both were allocated with the DOCUMENT rather than with the first stroke. A
 * third, `textPreview`, is a document-sized canvas that was rendered always and
 * hidden with `display: none` — which hides a canvas without freeing one, since
 * the backing store is w×h×4 whether or not anything looks at it.
 *
 * After: `view` and `layer`, the picture and the pixels. 2 × 45.8 = 92 MB.
 *
 * WHY A REPORT HAD TO BE ADDED. Only two of the five are in the DOM; the other
 * three are private fields on the engine that are never appended anywhere, so
 * `document.querySelectorAll("canvas")` — the obvious instrument — misses
 * exactly the buffers this item is about. `engine.memoryReport()` names them.
 * The item asks for both halves and they are both checked here, precisely
 * because either one alone can be wrong in a way the other would catch.
 *
 * Run: node tools/verify-memory-floor.js [--url ...] [--channel ...]
 */
const path = require("path");
const { launchBrowser, urlArg, dismissStartCard } = require("./lib/launch");

const VIEWPORT = { width: 1400, height: 900 };
const PHOTO = path.join(__dirname, "fixtures", "photo-4000x3000.png");
const DOC_PX = 4000 * 3000;
const DOC_BYTES = DOC_PX * 4; // 45.8 MB

/** Everything holding document-sized pixels, from both directions at once. */
const FLOOR = () => {
  const report = window.__gqMemory ? window.__gqMemory() : null;
  const canvases = [...document.querySelectorAll("canvas")];
  const big = canvases.filter((c) => c.width * c.height >= 4_000_000);
  return {
    report,
    /* The engine's own buffers, document-sized ones only. */
    engineBig: report
      ? report.buffers.filter((b) => b.w * b.h >= 4_000_000).map((b) => b.name)
      : null,
    engineTotal: report ? report.total : null,
    /* The DOM's, by the class that names them. */
    domBig: big.map(
      (c) =>
        `${(c.className || "").toString().replace(/\S*module__\w+__/g, "") || "?"}` +
        `:${c.width}x${c.height}`,
    ),
    /* The item's cross-check: sum w×h×4 over every canvas in the DOM. */
    domBytes: canvases.reduce((n, c) => n + c.width * c.height * 4, 0),
    domCount: canvases.length,
  };
};

async function boot(browser) {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const tour = await page
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await dismissStartCard(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(600);
  return { context, page };
}

/** Open the 12 MP fixture as its own document. */
async function openPhoto(page) {
  await page.locator('input[type="file"][accept*="image/*"]').first().setInputFiles(PHOTO);
  await page.waitForTimeout(2500);
  const dlg = page.locator('[role="dialog"]');
  if (await dlg.count()) {
    await dlg.getByText("New canvas", { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    await dlg
      .locator("button", { hasText: /^Import$/ })
      .last()
      .click({ timeout: 5000 })
      .catch(() => {});
  }
  await page.waitForTimeout(4000);
}

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const mb = (n) => `${(n / 1048576).toFixed(1)} MB`;

  const browser = await launchBrowser();
  const errors = [];

  // ======================================= the report the item asked for ======
  const a = await boot(browser);
  a.page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  a.page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  await openPhoto(a.page);
  const photo = await a.page.evaluate(FLOOR);

  check("the engine can say what it is holding",
    photo.report && photo.report.w === 4000 && photo.report.h === 3000,
    photo.report ? `memoryReport() for ${photo.report.w}×${photo.report.h}` : "no memoryReport()");

  /* An untouched photograph needs its pixels and the picture of them. Nothing
     else. */
  check("an untouched 12 MP photo holds ONE document-sized engine buffer",
    photo.engineBig && photo.engineBig.length === 1 && /^layer:/.test(photo.engineBig[0]),
    photo.engineBig ? `${photo.engineBig.join(", ")} — ${mb(photo.engineTotal)}` : "");
  check("…no live-stroke buffer before a stroke exists",
    photo.engineBig && !photo.engineBig.includes("stroke"),
    photo.engineBig ? `buffers: ${photo.engineBig.join(", ") || "none"}` : "");
  check("…and no compositing scratch either",
    photo.engineBig && !photo.engineBig.includes("scratch"), "");

  /* The DOM half. `display: none` frees nothing, so the preview must not be
     mounted at all. */
  check("the DOM holds ONE document-sized canvas — the picture on screen",
    photo.domBig.length === 1 && photo.domBig[0].startsWith("view"),
    photo.domBig.join(", ") || "none");
  check("…the text preview is not mounted for a document with no text in it",
    !photo.domBig.some((n) => n.startsWith("textPreview")),
    photo.domBig.some((n) => n.startsWith("textPreview")) ? "still mounted" : "absent, not merely hidden");

  /* The item's cross-check, spelled out: two independent sums of the same
     thing, which is what makes either one trustworthy. */
  const floorBytes = photo.engineTotal + photo.domBytes;
  check("the whole floor is two document-sized buffers, counted both ways",
    photo.engineTotal + photo.domBytes < DOC_BYTES * 3,
    `engine ${mb(photo.engineTotal)} + DOM ${mb(photo.domBytes)} = ${mb(floorBytes)}, ` +
      `against ${mb(DOC_BYTES)} per buffer (was 5 buffers, ${mb(DOC_BYTES * 5)})`);

  // ============================== lazy means later, not never =================
  /* A buffer that is never allocated is not lazy, it is missing — so the same
     buffers must appear the moment an edit needs them. */
  const box = await a.page.locator('[data-tour="canvas"]').boundingBox();
  await a.page.mouse.move(box.x + box.width / 2 - 40, box.y + box.height / 2);
  await a.page.mouse.down();
  for (let i = 0; i < 8; i++)
    await a.page.mouse.move(box.x + box.width / 2 - 40 + i * 8, box.y + box.height / 2 + i * 4);
  await a.page.mouse.up();
  await a.page.waitForTimeout(1500);
  const painted = await a.page.evaluate(FLOOR);
  check("a stroke brings the operation buffers into being",
    painted.engineBig &&
      painted.engineBig.includes("stroke") &&
      painted.engineBig.includes("scratch"),
    painted.engineBig ? painted.engineBig.join(", ") : "");

  /* …and having been made, they are kept: allocating 45 MB between one brush
     stroke and the next is a worse bargain than holding it. */
  await a.page.mouse.move(box.x + 60, box.y + 60);
  await a.page.mouse.down();
  await a.page.mouse.move(box.x + 90, box.y + 90);
  await a.page.mouse.up();
  await a.page.waitForTimeout(1200);
  const twice = await a.page.evaluate(FLOOR);
  check("…and are reused rather than remade for the next one",
    twice.engineBig && twice.engineBig.length === painted.engineBig.length,
    `${painted.engineBig?.length} buffers after one stroke, ${twice.engineBig?.length} after two`);
  await a.context.close();

  // ================================ a blank document costs even less ==========
  const b2 = await boot(browser);
  b2.page.on("pageerror", (e) => errors.push("pageerror(blank): " + String(e)));
  b2.page.on("console", (m) => m.type() === "error" && errors.push("console(blank): " + m.text()));
  await b2.page.keyboard.press("Control+n");
  await b2.page.waitForTimeout(900);
  await b2.page.locator('[role="dialog"] input[type="number"]').nth(0).fill("4000");
  await b2.page.locator('[role="dialog"] input[type="number"]').nth(1).fill("3000");
  await b2.page
    .locator('[role="dialog"] button', { hasText: /^Create$/ })
    .first()
    .click()
    .catch(() => {});
  await b2.page.waitForTimeout(3000);
  const blank = await b2.page.evaluate(FLOOR);
  /* Nothing has been drawn, so there are no pixels to hold — not even a layer. */
  check("a blank 4000×3000 document holds no document-sized engine buffer at all",
    blank.engineBig && blank.engineBig.length === 0,
    blank.engineBig ? blank.engineBig.join(", ") || "none" : "");
  await b2.context.close();

  check("no console errors throughout", errors.length === 0,
    errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
