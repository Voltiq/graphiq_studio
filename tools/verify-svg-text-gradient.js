/* Gradient-filled text exports as a gradient, not as a flat colour.
 *
 * MEASURED BEFORE: `emitText` in app/lib/svg.ts read `splitPaint(v.color)` — the
 * block's SOLID colour — and never looked at `v.fill`, the gradient that the
 * raster had been drawing since text gradients shipped. So a gradient heading
 * rasterized correctly, exported to SVG as one flat colour, and said nothing
 * about it. The file claimed to be the same artwork.
 *
 * WHY THE FIX CAN BE EXACT RATHER THAN CLOSE. `buildCanvasGradient` has never
 * handed the author's stops to canvas directly: the midpoint power curve, the
 * reflected fold and the conic seam blend are not things `addColorStop` can
 * express, so it flattens every gradient to 65 evenly-spaced samples. That
 * resampling is now `gradientRamp`, and the placement is `gradientGeometry`, and
 * BOTH the canvas renderer and the SVG emitter consume them — so the export is a
 * transcription of what the pixels do rather than a second opinion about it.
 * `tests/gradient.test.ts` pins that the two agree sample for sample.
 *
 * WHAT THIS RAIL ADDS over those unit tests: `exportSVG` cannot run in Node at
 * all — `textLayout` needs a real canvas to measure with, and returns null
 * without one, which makes every text layer export as an empty string. The
 * whole path from "a gradient is applied in the UI" to "the file contains a
 * paint server" is only observable in a browser.
 *
 * THE ONE TYPE SVG CANNOT EXPRESS, asserted rather than hidden: an ANGLE
 * (conic) gradient has no SVG equivalent — not in 1.1, not in 2, and CSS's
 * conic-gradient cannot fill an SVG <text>. It keeps the flat colour, which is
 * the honest option; a linear stand-in would look nothing like the raster.
 *
 * Run: node tools/verify-svg-text-gradient.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg, dismissStartCard } = require("./lib/launch");

const VIEWPORT = { width: 1500, height: 950 };

/**
 * Open the Text fill popover.
 *
 * Split from the setting below on purpose: clicking and then reading the
 * popover back in ONE synchronous `evaluate` reports "popover did not open"
 * every time, because React has not rendered it yet when the same tick asks.
 * The first version of this rail did exactly that and blamed the app.
 */
const OPEN_FILL = () => {
  const bar = document.querySelector('[data-tour="options"]');
  if (!bar) return "no options bar";
  if (document.querySelector('[role="dialog"][aria-label="Text fill"]')) return "already open";
  const btn = [...bar.querySelectorAll("button")].find((b) =>
    /text fill/i.test(b.getAttribute("aria-label") || b.getAttribute("title") || ""),
  );
  if (!btn) return "no Text fill button";
  btn.click();
  return "clicked";
};

/**
 * Choose Solid or Gradient in the open popover.
 *
 * A THIRD step is needed after this one, for the same reason the open is its
 * own step: the popover shows only the two mode buttons and a sentence of
 * explanation until Gradient is picked, and the type control renders after
 * that. Reading it back in this tick finds nothing and reports "no select",
 * which is what the rail did until it was measured.
 */
const SET_MODE = (mode) => {
  const pop = document.querySelector('[role="dialog"][aria-label="Text fill"]');
  if (!pop) return "popover did not open";
  const seg = [...pop.querySelectorAll("button")].find(
    (b) => (b.textContent || "").trim().toLowerCase() === mode,
  );
  if (!seg) return `no "${mode}" button in the popover`;
  seg.click();
  return "ok";
};

/** Choose the gradient's type, once the editor has rendered. */
const SET_TYPE = (type) => {
  const pop = document.querySelector('[role="dialog"][aria-label="Text fill"]');
  if (!pop) return "popover closed";
  /* The type control is a `Segmented` — a row of BUTTONS — not a `<select>`.
     Looking for a select found nothing and the rail said so, twice, which is
     the behaviour wanted from a rail that cannot reach its subject. */
  const hit = [...pop.querySelectorAll("button")].find(
    (b) => new RegExp(`^${type}$`, "i").test((b.textContent || "").trim()),
  );
  if (!hit) {
    const seen = [...pop.querySelectorAll("button")]
      .map((b) => (b.textContent || "").trim())
      .filter(Boolean)
      .join("/");
    return `no "${type}" button — the popover offers: ${seen || "none"}`;
  }
  hit.click();
  return "ok";
};

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

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
  await page.keyboard.press("Control+Shift+N");
  await page.waitForTimeout(1600);

  /** Type a text layer, with the fill chosen BEFORE it is committed. */
  const makeText = async (mode, type, words) => {
    await page.keyboard.press("t");
    await page.waitForTimeout(700);
    await page.evaluate(OPEN_FILL);
    await page.waitForTimeout(700);            // React renders the popover
    let set = await page.evaluate(SET_MODE, mode);
    await page.waitForTimeout(800);            // …and renders the gradient editor
    if (set === "ok" && type) set = await page.evaluate(SET_TYPE, type);
    await page.waitForTimeout(700);
    await page.keyboard.press("Escape").catch(() => {}); // close the popover
    await page.waitForTimeout(400);
    const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await page.mouse.click(Math.round(box.x + box.width * 0.25), Math.round(box.y + box.height * 0.5));
    await page.waitForTimeout(1100);
    await page.keyboard.type(words);
    await page.waitForTimeout(700);
    await page.keyboard.press("Control+Enter"); // the desktop commit
    await page.waitForTimeout(1600);
    return set;
  };

  /** Run File ▸ Export SVG and return the file's text. */
  const exportSvg = async () => {
    const wait = page.waitForEvent("download", { timeout: 20000 }).catch(() => null);
    await page.evaluate(() => window.graphiq.run("export-svg"));
    const dl = await wait;
    if (!dl) return null;
    const path = await dl.path();
    if (!path) return null;
    return require("node:fs").readFileSync(path, "utf8");
  };

  // ================================== a linear gradient, the reported case ===
  const set = await makeText("gradient", "linear", "Gradient");
  check("a gradient text fill could be applied", set === "ok", String(set));

  const svg = await exportSvg();
  check("File ▸ Export SVG produced a file", !!svg && svg.includes("<svg"),
    svg ? `${svg.length} bytes` : "no download");

  if (svg) {
    check("the text layer is in it at all — so the checks below mean something",
      /<text[\s>]/.test(svg), `${(svg.match(/<text[\s>]/g) || []).length} <text> elements`);
    check("…carrying a gradient paint server rather than a flat colour",
      /<linearGradient\b/.test(svg) && /fill="url\(#/.test(svg),
      /<linearGradient\b/.test(svg)
        ? "a <linearGradient> is defined and referenced"
        : "no <linearGradient> — the export is still emitting the solid colour");
    check("…placed in the document's own coordinates, not a unit box",
      /gradientUnits="userSpaceOnUse"/.test(svg),
      "userSpaceOnUse is what lets the ramp land where the raster ramps");
    /* The ramp is 65 samples by construction; a handful of stops would mean
       something re-derived it rather than using the shared one. */
    const stops = (svg.match(/<stop\b/g) || []).length;
    check("…with the full 65-sample ramp the canvas uses",
      stops >= 65, `${stops} <stop> elements`);
    check("…and no fill-opacity beside it, which would apply the alpha twice",
      !/fill="url\(#[^"]*"\s+fill-opacity=/.test(svg), "the stops carry their own alpha");
  }

  // ============== the type SVG has no way to express, stated honestly ========
  const setAngle = await makeText("gradient", "angle", "Angle");
  check("an angle (conic) gradient could be applied", setAngle === "ok", String(setAngle));
  const svg2 = await exportSvg();
  if (svg2) {
    /* The first block is still on the canvas and still linear, so the file has
       one paint server. What must NOT appear is a second one pretending the
       conic block is expressible. */
    const defs = (svg2.match(/<linearGradient\b|<radialGradient\b/g) || []).length;
    check("a conic gradient is not faked as a linear one",
      defs <= 1, `${defs} paint servers for two gradient blocks — the conic keeps its flat colour`);
    check("…and the file is still valid, with both blocks present",
      (svg2.match(/<text[\s>]/g) || []).length >= 2,
      `${(svg2.match(/<text[\s>]/g) || []).length} <text> elements`);
  }

  check("no console errors throughout", errors.length === 0,
    errors.slice(0, 3).join(" | ") || "clean");

  await context.close();
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
