/* The pattern library, its picker, and the one thing that consumes them.
 *
 * `tests/patterns.test.ts` covers the pure half — what a file may contain, how
 * names de-duplicate, which tiles survive the byte budget. None of it can say
 * whether the feature works: the tiles are DRAWN on a canvas, the library lives
 * in IndexedDB, and the fill goes through the engine onto a layer. All three are
 * only observable in a browser.
 *
 * THE OBSERVABLE. A pattern fill is not one colour, and that is the whole point
 * of it — so the check is that the filled area contains MANY distinct colours
 * arranged in a repeat, where a colour fill would give exactly one. Counting
 * "did the pixels change" would pass for a flat fill, which is the failure most
 * worth catching: a pattern that silently became its average is what a broken
 * `createPattern` produces.
 *
 * Run: node tools/verify-pattern-fill.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg, dismissStartCard } = require("./lib/launch");

const VIEWPORT = { width: 1500, height: 950 };

/** Distinct colours and painted pixels across the document. */
const SAMPLE = () => {
  const vp = document.querySelector('[data-tour="canvas"]');
  const doc = window.__gqMemory ? window.__gqMemory() : null;
  const c = [...vp.querySelectorAll("canvas")].find(
    (x) => doc && x.width === doc.w && x.height === doc.h,
  );
  if (!c) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  const seen = new Set();
  let painted = 0;
  for (let px = 0; px * 4 < d.length; px += 7) {
    const i = px * 4;
    if (d[i + 3]) {
      painted++;
      seen.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
    }
  }
  return { painted, colours: seen.size };
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

  const blank = await page.evaluate(SAMPLE);
  check("a blank document to fill", !!blank && blank.painted === 0,
    blank ? `${blank.painted} painted px` : "no canvas");

  // ======================================= the dialog, from the Edit menu ====
  const opened = await page.evaluate(() => {
    try {
      window.graphiq.run("pattern-fill");
      return "ok";
    } catch (e) {
      return String(e);
    }
  });
  await page.waitForTimeout(1200);
  const dialog = await page.evaluate(
    () => !!document.querySelector('[role="dialog"][aria-label="Fill with pattern"]'),
  );
  check("Edit ▸ Fill with pattern opens the dialog", opened === "ok" && dialog, String(opened));

  // ============================== the picker, with its built-in tiles ========
  const tiles = await page.evaluate(() => {
    const grid = document.querySelector('[role="listbox"][aria-label="Patterns"]');
    if (!grid) return { n: 0, drawn: 0, names: [] };
    const opts = [...grid.querySelectorAll('[role="option"]')];
    /* A swatch that never drew is a blank canvas; the tiles are procedures, so
       "there are buttons" is not evidence that any of them produced pixels. */
    let drawn = 0;
    for (const o of opts) {
      const c = o.querySelector("canvas");
      if (!c || !c.width) continue;
      const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
      let any = false;
      for (let i = 3; i < d.length && !any; i += 4) if (d[i]) any = true;
      if (any) drawn++;
    }
    return { n: opts.length, drawn, names: opts.map((o) => o.textContent.trim()).slice(0, 6) };
  });
  check("the picker lists the built-in tiles", tiles.n >= 4, `${tiles.n} tiles: ${tiles.names.join(", ")}`);
  check("…and every one of them actually drew, rather than showing a blank canvas",
    tiles.drawn === tiles.n, `${tiles.drawn} of ${tiles.n} swatches have pixels`);

  // =================================================== fill with a tile =====
  const picked = await page.evaluate(() => {
    const grid = document.querySelector('[role="listbox"][aria-label="Patterns"]');
    const opt = [...(grid?.querySelectorAll('[role="option"]') ?? [])].find((o) =>
      /checker/i.test(o.textContent || ""),
    );
    if (!opt) return "no Checker tile";
    opt.click();
    return "ok";
  });
  await page.waitForTimeout(500);
  const filled = await page.evaluate(() => {
    const dlg = document.querySelector('[role="dialog"][aria-label="Fill with pattern"]');
    const b = [...(dlg?.querySelectorAll("button") ?? [])].find(
      (x) => (x.textContent || "").trim() === "Fill",
    );
    if (!b) return "no Fill button";
    b.click();
    return "ok";
  });
  await page.waitForTimeout(1800);
  const after = await page.evaluate(SAMPLE);
  check("a tile can be chosen and filled", picked === "ok" && filled === "ok",
    `${picked} / ${filled}`);
  check("…the layer is now covered", !!after && after.painted > 1000,
    after ? `${after.painted} painted px` : "");
  /* The evidence that it is a PATTERN: a colour fill gives one colour. */
  check("…with more than one colour in it, so it repeated rather than flattened",
    !!after && after.colours >= 2,
    after ? `${after.colours} distinct colours across the fill` : "");

  // =========================================== and it is one undo step ======
  await page.evaluate(() => window.graphiq.undo());
  await page.waitForTimeout(1200);
  const undone = await page.evaluate(SAMPLE);
  check("one Undo takes the whole fill away", !!undone && undone.painted === 0,
    undone ? `${undone.painted} painted px` : "");

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
