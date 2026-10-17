/* A soft selection stays soft.
 *
 * MEASURED BEFORE: paint a 120px, 0%-hardness stroke in Quick Mask, leave Quick
 * Mask, Layer ▸ Mask from selection — the mask came out with exactly TWO alpha
 * levels (0 and 255) and zero partial pixels. The engine turned every grayscale
 * selection source (Quick Mask, saved channels, mask → selection) into 1px rects
 * thresholded at 50%, so the soft edge was gone before anything could use it.
 * After: 256 levels, ~120k partial pixels.
 *
 * The rects are still the ≥50% outline (ants, bounds, tools); the engine keeps
 * the 8-bit coverage beside them, keyed by the selection's identity, and every
 * place a selection becomes pixels uses it (PaintEngine.coverageOf).
 *
 * Checks — each from a fresh page, each measured on the exported composite:
 *   A  mask from selection is soft
 *   B  Backspace (fill) is soft
 *   C  Delete (erase) is soft
 *   D  a HARD brush painted through the selection comes out soft
 *   E  Quick Mask → selection → Quick Mask → selection does not drift (byte-equal)
 *   F  CONTROL: a marquee selection still fills hard — zero partial pixels. Without
 *      it "soft" could be passing on something that is merely blurry everywhere.
 *
 * MUTATION: stop maskSelectionRects registering coverage and A–E fail; F passes.
 *
 * Run: node tools/verify-soft-selection.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

/** Partial pixels a soft edge must produce at least (the stroke alone is ~120k). */
const SOFT = 5000;

async function fresh(browser) {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  const tour = await page
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForSelector('div[aria-label="Interactive tour"]', { state: "detached", timeout: 5000 });
  }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);
  return { page, errors };
}

function helpers(page) {
  const settle = (ms = 800) => page.waitForTimeout(ms);
  const run = async (id) => {
    await page.evaluate((a) => window.graphiq.run(a), id);
    await settle();
    /* MODAL dialogs only. A colour popover is a role="dialog" too, and Escape
       there also clears the selection — which is what this rail is measuring. */
    for (let i = 0; i < 3 && (await page.locator('div[role="dialog"][aria-modal="true"]').count()); i++) {
      await page.keyboard.press("Escape");
      await settle(300);
    }
  };
  const setRange = (label, v) =>
    page.evaluate(
      ([label, v]) => {
        const el = document.querySelector(`input[type="range"][aria-label="${label}"]`);
        if (!el) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, String(v));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      [label, v],
    );
  /** Alpha census + hash of the exported composite (transparency intact). */
  const census = () =>
    page.evaluate(async () => {
      const blob = await window.graphiq.exportPNG();
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext("2d");
      x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
      const levels = new Set();
      let partial = 0;
      let h = 0x811c9dc5;
      for (let i = 3; i < d.length; i += 4) {
        levels.add(d[i]);
        if (d[i] > 0 && d[i] < 255) partial++;
        h = Math.imul(h ^ d[i], 0x01000193);
      }
      return { levels: levels.size, partial, hash: (h >>> 0).toString(36) };
    });
  const box = () => page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const drag = async (fy, x0 = 0.2, x1 = 0.8) => {
    const b = await box();
    await page.mouse.move(b.x + b.width * x0, b.y + b.height * fy);
    await page.mouse.down();
    await page.mouse.move(b.x + b.width * x1, b.y + b.height * fy, { steps: 30 });
    await page.mouse.up();
    await settle();
    await page.mouse.move(b.x + 2, b.y + 2);
  };
  const brush = async (size, hardness) => {
    await page.getByRole("button", { name: "Brush" }).first().click();
    await settle(300);
    await setRange("Size", size);
    await setRange("Hardness", hardness);
  };
  /** Quick Mask → a soft BLACK stroke → the selection. With nothing selected,
   *  Quick Mask starts fully revealed, so the result is everything except a
   *  soft-edged band: soft along both of its edges. */
  const softSelection = async () => {
    await run("select-quickmask");
    await brush(200, 0);
    await page.evaluate(() => window.graphiq.setForeground("#000000"));
    await settle(300);
    await drag(0.5);
    await run("select-quickmask");
  };
  const opaqueLayer = async () => {
    await page.evaluate(() => window.graphiq.setForeground("#3aa0ff"));
    await run("fill-solid");
    await run("layer-flatten");
  };
  return { settle, run, census, drag, brush, softSelection, opaqueLayer };
}

(async () => {
  const browser = await launchBrowser();
  try {
    // A — mask from selection
    {
      const { page, errors } = await fresh(browser);
      const h = helpers(page);
      await h.opaqueLayer();
      await h.softSelection();
      await h.run("mask-from-sel");
      const c = await h.census();
      check("A  mask from a soft selection is soft", c.partial > SOFT, `${c.levels} alpha levels, ${c.partial} partial px`);
      if (errors.length) check("A  no page errors", false, errors[0]);
      await page.context().close();
    }
    // B — fill
    {
      const { page, errors } = await fresh(browser);
      const h = helpers(page);
      await h.softSelection();
      await page.evaluate(() => window.graphiq.setForeground("#e0402a"));
      await page.keyboard.press("Backspace");
      await h.settle();
      const c = await h.census();
      check("B  Backspace fills a soft selection softly", c.partial > SOFT, `${c.levels} levels, ${c.partial} partial px`);
      if (errors.length) check("B  no page errors", false, errors[0]);
      await page.context().close();
    }
    // C — erase
    {
      const { page, errors } = await fresh(browser);
      const h = helpers(page);
      await h.opaqueLayer();
      await h.softSelection();
      await page.keyboard.press("Delete");
      await h.settle();
      const c = await h.census();
      check("C  Delete erases a soft selection softly", c.partial > SOFT, `${c.levels} levels, ${c.partial} partial px`);
      if (errors.length) check("C  no page errors", false, errors[0]);
      await page.context().close();
    }
    // D — a hard brush through a soft selection
    {
      const { page, errors } = await fresh(browser);
      const h = helpers(page);
      await h.softSelection();
      await h.run("layer-new");
      await h.brush(500, 100);
      await page.evaluate(() => window.graphiq.setForeground("#20a050"));
      await h.settle(300);
      await h.drag(0.5, 0.1, 0.9);
      const c = await h.census();
      check("D  a hard brush inside a soft selection paints softly", c.partial > SOFT, `${c.levels} levels, ${c.partial} partial px`);
      if (errors.length) check("D  no page errors", false, errors[0]);
      await page.context().close();
    }
    // E — Quick Mask round trip does not drift
    {
      const { page, errors } = await fresh(browser);
      const h = helpers(page);
      await h.opaqueLayer();
      await h.softSelection();
      await h.run("mask-from-sel");
      const once = await h.census();
      await h.run("undo");
      await h.run("select-quickmask"); // back into Quick Mask FROM the soft selection…
      await h.run("select-quickmask"); // …and straight out again
      await h.run("mask-from-sel");
      const twice = await h.census();
      check("E  a Quick Mask round trip is lossless", once.partial > SOFT && once.hash === twice.hash,
        `${once.hash}/${once.partial} vs ${twice.hash}/${twice.partial}`);
      if (errors.length) check("E  no page errors", false, errors[0]);
      await page.context().close();
    }
    // F — control: a marquee selection is still hard
    {
      const { page, errors } = await fresh(browser);
      const h = helpers(page);
      await page.evaluate(() => window.graphiq.select([{ x: 300, y: 200, w: 700, h: 400 }]));
      await h.settle();
      await page.evaluate(() => window.graphiq.setForeground("#e0402a"));
      await page.keyboard.press("Backspace");
      await h.settle();
      const c = await h.census();
      check("F  control: a marquee selection fills hard", c.levels === 2 && c.partial === 0,
        `${c.levels} levels, ${c.partial} partial px`);
      if (errors.length) check("F  no page errors", false, errors[0]);
      await page.context().close();
    }
  } catch (e) {
    check("harness ran to completion", false, String(e));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
