/* End-to-end smoke test (TODO §15).
 *
 *   npm i -D playwright-core  &&  npm run dev
 *   npm run smoke                       (node tools/smoke.js)
 *   node tools/smoke.js --url http://localhost:3001 --keep
 *
 * The one journey that has to work or nothing else matters: boot the app, paint
 * something, undo and redo it, save the project, open it back, and export a
 * PNG. Everything else in tools/ checks one subsystem in depth; this checks that
 * the subsystems are still joined together.
 *
 * IT ASSERTS OUTCOMES, NOT STEPS. "Clicked Save and no exception" is worth
 * nothing — the interesting failures are a project that saves but restores a
 * blank canvas, or an export that writes a valid PNG of the wrong thing. So the
 * document's pixels are hashed before saving and again after re-opening, and the
 * exported PNG is decoded and compared with the canvas it came from. A step that
 * cannot be checked that way is checked against something it must have changed.
 *
 * THE FILE PICKERS ARE REMOVED ON PURPOSE. With the File System Access API
 * present the app opens a native dialog no automation can reach. Deleting
 * `showSaveFilePicker`/`showOpenFilePicker` before the app boots sends it down
 * its download and `<input type=file>` fallback — which is not a workaround for
 * the test's benefit but the path every browser without that API actually uses,
 * so it is the one worth smoke-testing.
 *
 * PROVEN TO FAIL, in the right place. Three legs of the journey were broken one
 * at a time, and each tripped exactly the checks that cover it:
 *
 *   export at half scale      -> "at the document's size", "of the right picture"
 *   save drops layer pixels   -> the PNG-payload check, the round-trip hash,
 *                                and the export picture (the reopened doc is blank)
 *   the undo action removed   -> "undo takes the stroke back off"
 *
 * A control rewrite that changed nothing broke nothing. Note the undo mutant was
 * applied to the MENU action while the test presses Ctrl+Z — it still failed,
 * because both routes go through the one shortcut registry.
 *
 * ONE HARNESS TRAP WORTH KEEPING. A `selectOption` that cannot match its option
 * blocks for the full default timeout. With `.catch(() => {})` around it and a
 * download waiter already ticking, that read as "export is broken" for 30
 * seconds while export was working perfectly. Locators that might not match now
 * carry short, explicit timeouts and nothing swallows their errors.
 */
const { mkdtempSync, readFileSync, rmSync, statSync } = require("node:fs");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { chromium } = require("playwright-core");

const argv = process.argv.slice(2);
const KEEP = argv.includes("--keep");
const URL_ARG = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "http://localhost:3000";
})();

const DOC_W = 400;
const DOC_H = 300;

(async () => {
  const work = mkdtempSync(join(tmpdir(), "graphiq-smoke-"));
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  let pass = 0;
  let fail = 0;
  const failures = [];
  const check = (name, ok, note = "") => {
    ok ? pass++ : fail++;
    if (!ok) failures.push(name);
    console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${note ? " — " + note : ""}`);
  };

  try {
    const ctx = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    const page = await ctx.newPage();
    // Before any app code runs, so the app never sees the API.
    await page.addInitScript(() => {
      delete window.showSaveFilePicker;
      delete window.showOpenFilePicker;
    });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

    // ---- 1. boot ------------------------------------------------------------
    const t0 = Date.now();
    await page.goto(URL_ARG, { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
    const bootMs = Date.now() - t0;
    const tour = await page
      .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 })
      .catch(() => null);
    if (tour) {
      await page.keyboard.press("Escape");
      await page.waitForSelector('div[aria-label="Interactive tour"]', { state: "detached", timeout: 5000 });
    }
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await page.waitForTimeout(600);

    console.log(`\nboot: ${bootMs} ms\n`);
    check("the app boots with its shell intact",
      (await page.locator('aside[aria-label="Tools"]').count()) > 0 &&
        (await page.locator('[data-tour="canvas"]').count()) > 0 &&
        (await page.locator('[data-tour="options"]').count()) > 0);
    check("the scripting hook is installed",
      (await page.evaluate(() => typeof window.graphiq)) === "object");
    check("nothing threw during boot", errors.length === 0, errors.slice(0, 2).join(" | "));

    const menu = async (a, b) => {
      await page.getByText(a, { exact: true }).first().click();
      await page.waitForTimeout(220);
      await page.getByText(b, { exact: true }).first().click();
      await page.waitForTimeout(900);
    };
    /** Ink count + a hash of the composited canvas. */
    const shot = () =>
      page.evaluate(() => {
        const c = document.querySelector('[data-tour="canvas"] canvas');
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let a = 0x811c9dc5;
        let b = 0x9dc5811c;
        let ink = 0;
        for (let i = 0; i < d.length; i++) {
          a = Math.imul(a ^ d[i], 0x01000193);
          b = Math.imul(b ^ d[i], 0x01000197);
          if (i % 4 === 3 && d[i] > 0) ink++;
        }
        return { hash: (a >>> 0).toString(36) + "." + (b >>> 0).toString(36), ink, w: c.width, h: c.height };
      });

    // ---- 2. a new document --------------------------------------------------
    await menu("File", "New…");
    const nd = page.locator('div[role="dialog"][aria-label="New document"]');
    await nd.waitFor({ timeout: 8000 });
    await nd.locator('input[type="number"]').nth(0).fill(String(DOC_W));
    await nd.locator('input[type="number"]').nth(1).fill(String(DOC_H));
    await nd.getByText("Create", { exact: true }).click();
    await page.waitForTimeout(1600);
    const blank = await shot();
    check("a new document is the size asked for", blank.w === DOC_W && blank.h === DOC_H,
      `${blank.w}x${blank.h}`);
    check("...and starts empty", blank.ink === 0, `${blank.ink} px of ink`);

    // ---- 3. paint -----------------------------------------------------------
    const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await page.getByRole("button", { name: "Brush" }).first().click();
    await page.waitForTimeout(300);
    for (let i = 0; i < 12; i++) await page.keyboard.press("]");
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.3);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.7, { steps: 24 });
    await page.mouse.up();
    await page.waitForTimeout(900);
    const painted = await shot();
    check("painting puts pixels on the canvas", painted.ink > 500, `${painted.ink} px`);
    check("...on a layer the panel shows",
      (await page.locator('li[class*="layerItem"]').count()) === 1,
      `${await page.locator('li[class*="layerItem"]').count()} rows`);

    // ---- 4. undo / redo -----------------------------------------------------
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.keyboard.press("Control+z");
    await page.waitForTimeout(900);
    const undone = await shot();
    check("undo takes the stroke back off", undone.ink === 0, `${undone.ink} px left`);
    await page.keyboard.press("Control+Shift+z");
    await page.waitForTimeout(900);
    const redone = await shot();
    // Byte-identical, not merely "ink is back": a redo that re-rasterized the
    // stroke slightly differently would pass the weaker check.
    check("redo restores it exactly", redone.hash === painted.hash,
      `${painted.hash} vs ${redone.hash}`);

    // ---- 5. save ------------------------------------------------------------
    const saveWait = page.waitForEvent("download", { timeout: 20000 });
    await menu("File", "Save as…");
    const sa = page.locator('div[role="dialog"][aria-label="Save project as"]');
    await sa.waitFor({ timeout: 8000 });
    await sa.locator('input[aria-label="File name"]').fill("smoke-doc");
    await sa.getByText("Save", { exact: true }).click();
    const dl = await saveWait;
    const projPath = join(work, dl.suggestedFilename() || "smoke.gproj");
    await dl.saveAs(projPath);
    const projBytes = statSync(projPath).size;
    check("saving writes a project file", projBytes > 1000, `${projBytes} bytes`);
    let parsed = null;
    try {
      parsed = JSON.parse(readFileSync(projPath, "utf8"));
    } catch (e) {
      check("...that is valid JSON", false, e.message);
    }
    if (parsed) {
      check("...that is valid JSON with the document in it",
        !!parsed.layers && parsed.width === DOC_W && parsed.height === DOC_H,
        `keys: ${Object.keys(parsed).slice(0, 8).join(", ")}`);
      const payloads = (JSON.stringify(parsed).match(/data:image\/png/g) ?? []).length;
      check("...carrying the layer's pixels, not just its metadata", payloads > 0,
        `${payloads} PNG payload${payloads === 1 ? "" : "s"} embedded`);
    }

    // ---- 6. open it back ----------------------------------------------------
    // Into a DIFFERENT document, so a pass cannot come from the file never
    // having been read: the restored one has to arrive as a new tab.
    await menu("File", "New…");
    await nd.waitFor({ timeout: 8000 });
    await nd.locator('input[type="number"]').nth(0).fill("120");
    await nd.locator('input[type="number"]').nth(1).fill("90");
    await nd.getByText("Create", { exact: true }).click();
    await page.waitForTimeout(1400);
    const decoy = await shot();
    check("a second, different document is active", decoy.w === 120 && decoy.h === 90,
      `${decoy.w}x${decoy.h}`);

    await page.locator('input[type="file"][accept*="gproj"]').setInputFiles(projPath);
    await page.waitForTimeout(2500);
    const reopened = await shot();
    check("opening the project restores the document", reopened.w === DOC_W && reopened.h === DOC_H,
      `${reopened.w}x${reopened.h}`);
    check("...with the very same pixels", reopened.hash === painted.hash,
      `${painted.hash} vs ${reopened.hash} (ink ${painted.ink} vs ${reopened.ink})`);
    check("...and its layer", (await page.locator('li[class*="layerItem"]').count()) === 1);

    // ---- 7. export ----------------------------------------------------------
    await menu("File", "Export as…");
    const ex = page.locator('div[role="dialog"][aria-label="Export image"]');
    await ex.waitFor({ timeout: 8000 });
    // Set the format only if it is not already PNG, and with a SHORT timeout.
    // A `selectOption` that cannot match blocks for the full default timeout,
    // which once burned the download's 30 s wait before the click even happened
    // — the export was working the whole time.
    const fmt = ex.locator('select[aria-label="Format"]');
    if ((await fmt.inputValue()) !== "png") await fmt.selectOption("png", { timeout: 5000 });
    await ex.locator('input[aria-label="File name"]').fill("smoke-export", { timeout: 5000 });
    const expWait = page.waitForEvent("download", { timeout: 30000 });
    await ex.getByText("Export", { exact: true }).click();
    const exDl = await expWait;
    const pngPath = join(work, exDl.suggestedFilename() || "smoke.png");
    await exDl.saveAs(pngPath);
    const png = readFileSync(pngPath);
    check("exporting writes a PNG", png.length > 500 &&
      png[0] === 0x89 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47,
      `${png.length} bytes, magic ${[...png.subarray(0, 4)].map((b) => b.toString(16)).join(" ")}`);
    // The IHDR width/height live at bytes 16..23 — enough to prove the export is
    // of THIS document and not, say, the 120x90 decoy.
    const pw = png.readUInt32BE(16);
    const ph = png.readUInt32BE(20);
    check("...at the document's size", pw === DOC_W && ph === DOC_H, `${pw}x${ph}`);
    // ...and of the right picture: decode it in the page and compare ink.
    const exported = await page.evaluate(async (bytes) => {
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      c.getContext("2d").drawImage(bmp, 0, 0);
      const d = c.getContext("2d").getImageData(0, 0, bmp.width, bmp.height).data;
      let ink = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) ink++;
      return ink;
    }, [...png]);
    check("...and of the right picture", Math.abs(exported - painted.ink) <= painted.ink * 0.02,
      `exported ${exported} px vs canvas ${painted.ink} px`);

    check("no page errors across the whole journey", errors.length === 0,
      errors.slice(0, 3).join(" | "));

    console.log(`\n${pass} passed, ${fail} failed`);
    if (failures.length) console.log("failed: " + failures.join("; "));
    if (KEEP) console.log(`artifacts kept in ${work}`);
  } finally {
    await browser.close();
    if (!KEEP) rmSync(work, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("SMOKE FAILURE:", e.message);
  process.exit(1);
});
