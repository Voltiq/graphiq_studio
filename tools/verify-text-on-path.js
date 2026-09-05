/* Type set along a curve, and taken off it again.
 *
 * The pure geometry is `tests/textpath.test.ts` — 26 checks over arc-length
 * lookup, tangents and glyph placement, all of it arithmetic with an injected
 * measurer. None of that can tell you whether the FEATURE works: the engine has
 * to reach the new draw path, the layer has to re-rasterize, the Work Path has
 * to be the curve on screen, and undo has to put the type back on its line.
 * That is what this rail is for.
 *
 * THE OBSERVABLE, chosen so it cannot pass by accident: a line of type occupies
 * a short horizontal band. The same string on an arc occupies a much taller
 * one, because the glyphs climb the curve. So the painted bounding box's HEIGHT
 * is the evidence — it grows when the text goes on the path and returns when it
 * comes off. Comparing "did any pixel change" would also pass if the text had
 * simply moved, or vanished.
 *
 * Run: node tools/verify-text-on-path.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg, dismissStartCard } = require("./lib/launch");

const VIEWPORT = { width: 1500, height: 950 };

/** Painted pixels of the document, with the box they occupy. */
const SAMPLE = () => {
  const vp = document.querySelector('[data-tour="canvas"]');
  const doc = window.__gqMemory ? window.__gqMemory() : null;
  const c = [...vp.querySelectorAll("canvas")].find(
    (x) => doc && x.width === doc.w && x.height === doc.h,
  );
  if (!c) return null;
  const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
  let n = 0;
  let minX = 1e9;
  let minY = 1e9;
  let maxX = -1;
  let maxY = -1;
  for (let px = 0; px * 4 < d.length; px++) {
    if (d[px * 4 + 3]) {
      n++;
      const x = px % c.width;
      const y = (px / c.width) | 0;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  return n
    ? { painted: n, w: maxX - minX, h: maxY - minY }
    : { painted: 0, w: 0, h: 0 };
};

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: VIEWPORT });
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

  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const at = (fx, fy) => ({
    x: Math.round(box.x + box.width * fx),
    y: Math.round(box.y + box.height * fy),
  });

  // ============================ a Work Path with a pronounced arc in it ======
  await page.keyboard.press("p");
  await page.waitForTimeout(700);
  const tool = await page.evaluate(
    () =>
      document
        .querySelector('[data-tour="toolbar"] [aria-pressed="true"]')
        ?.getAttribute("aria-label") ?? "?",
  );
  check("the pen is the selected tool", /pen/i.test(tool), tool);

  /* A deep V rather than a gentle curve: the whole point of the observable is
     that the glyphs have to climb, and a shallow arc would leave the height
     difference inside the noise of anti-aliasing. */
  for (const [fx, fy] of [
    [0.15, 0.35],
    [0.5, 0.8],
    [0.85, 0.35],
  ]) {
    const p = at(fx, fy);
    await page.mouse.click(p.x, p.y);
    await page.waitForTimeout(350);
  }
  await page.keyboard.press("Enter"); // commits the Work Path
  await page.waitForTimeout(900);
  /* THE PEN STROKES ITS PATH ONTO THE LAYER, which the first version of this
     rail did not account for: 15339 painted pixels in a 1353x493 box before a
     single character was typed, so the "box height" observable was measuring
     the V, not the type. The Work Path is stored on the DOCUMENT and is what
     `text-on-path` reads, so hiding the layer the pen drew on leaves the
     feature untouched and the measurement clean. */
  const penLayers = await page.evaluate(() => {
    try { return (window.graphiq.layers() || []).map((l) => l.id); } catch { return []; }
  });
  const penPainted = await page.evaluate(SAMPLE);
  check("the pen painted its path, so that layer has to be hidden to measure type",
    !!penPainted && penPainted.painted > 1000 && penLayers.length > 0,
    `${penPainted?.painted}px across ${penLayers.length} layer(s)`);

  // ================================================== a line of type =========
  await page.keyboard.press("t");
  await page.waitForTimeout(700);
  const start = at(0.2, 0.45);
  await page.mouse.click(start.x, start.y);
  await page.waitForTimeout(1100);
  await page.keyboard.type("Curving type");
  await page.waitForTimeout(700);
  await page.keyboard.press("Control+Enter");
  await page.waitForTimeout(1700);

  const hid = await page.evaluate((ids) => {
    try {
      for (const id of ids) window.graphiq.setLayer(id, { visible: false });
      return "ok";
    } catch (e) {
      return String(e);
    }
  }, penLayers);
  await page.waitForTimeout(1000);
  const flat = await page.evaluate(SAMPLE);
  check("…and hiding it leaves only the type on the canvas",
    hid === "ok" && !!flat && !!penPainted && flat.painted < penPainted.painted / 2,
    `${hid}: ${penPainted?.painted}px with the path, ${flat?.painted}px without it`);
  check("the type rasterized as a flat line first",
    !!flat && flat.painted > 200 && flat.h < flat.w,
    flat ? `${flat.painted}px in a ${flat.w}×${flat.h} box` : "nothing painted");

  // ================================================== put it on the path =====
  const ran = await page.evaluate(() => {
    try {
      window.graphiq.run("text-on-path");
      return "ok";
    } catch (e) {
      return String(e);
    }
  });
  await page.waitForTimeout(1800);
  const curved = await page.evaluate(SAMPLE);
  check("Layer ▸ Text on path ran", ran === "ok", ran);
  check("…and the type still exists afterwards",
    !!curved && curved.painted > 100,
    curved ? `${curved.painted}px` : "nothing painted");
  /* The evidence: a straight line of type is short; the same string climbing a
     V is tall. Half the flat line's width is a wide margin — the V spans most
     of the canvas — and it cannot be reached by the text merely moving. */
  check("…and it now climbs the curve instead of sitting on a line",
    !!flat && !!curved && curved.h > flat.h * 3,
    flat && curved ? `box height ${flat.h} → ${curved.h}, width ${flat.w} → ${curved.w}` : "");

  // ========================================== undo puts it back on its line ==
  await page.evaluate(() => window.graphiq.undo());
  await page.waitForTimeout(1500);
  const undone = await page.evaluate(SAMPLE);
  check("one Undo puts the type back on its line",
    !!undone && Math.abs(undone.h - flat.h) <= 2 && Math.abs(undone.painted - flat.painted) < flat.painted * 0.1,
    undone ? `${undone.painted}px in a ${undone.w}×${undone.h} box, against ${flat.w}×${flat.h}` : "");

  // ==================================== and it can be taken off deliberately ==
  await page.evaluate(() => window.graphiq.redo());
  await page.waitForTimeout(1400);
  const again = await page.evaluate(SAMPLE);
  check("…redo puts it back on the path", !!again && again.h > flat.h * 3, `height ${again?.h}`);
  const off = await page.evaluate(() => {
    try {
      window.graphiq.run("text-off-path");
      return "ok";
    } catch (e) {
      return String(e);
    }
  });
  await page.waitForTimeout(1600);
  const flattened = await page.evaluate(SAMPLE);
  check("Layer ▸ Take text off its path returns it to a line",
    off === "ok" && !!flattened && Math.abs(flattened.h - flat.h) <= 2,
    `${off}: box height ${again?.h} → ${flattened?.h}, against the original ${flat.h}`);

  /* THE CASE A MUTATION EXPOSED. Every step above renders from a spec built in
     the same breath, so none of them ever asks the app to rebuild a spec FROM a
     stored on-path vector — and dropping `onPath` from `specFromTextVector`
     passed all of them. Undoing the detach is the step that has to rebuild it:
     the vector it restores is the one carrying the path. */
  await page.evaluate(() => window.graphiq.undo());
  await page.waitForTimeout(1500);
  const reattached = await page.evaluate(SAMPLE);
  check("undoing the detach restores the type to its curve, rebuilt from the layer",
    !!reattached && !!again && Math.abs(reattached.h - again.h) <= 2,
    reattached ? `box height back to ${reattached.h}, against ${again?.h} before the detach` : "");

  // =================== the check that can see ROTATION, not just position ====
  /* A bounding box is rotation-BLIND on a V: take the turn away and the glyphs
     are still positioned along the path, so the box barely moves — a mutation
     removing `ctx.rotate` passed every check above. A VERTICAL path separates
     them, because there the two cases differ in the one dimension a box does
     report. Turned, each glyph lies on its side, so the ribbon of ink is as
     wide as the type is TALL; upright, it is only as wide as a single letter.
     Measured: 46px turned against 32px upright (an upright letter plus its
     anti-aliasing is wider than the letter alone), so the threshold is set
     midway between the two rather than close to either. */
  await page.evaluate(() => window.graphiq.run("text-off-path"));
  await page.waitForTimeout(1400);
  await page.keyboard.press("p");
  await page.waitForTimeout(700);
  for (const [fx, fy] of [
    [0.62, 0.12],
    [0.62, 0.5],
    [0.62, 0.88],
  ]) {
    const q = at(fx, fy);
    await page.mouse.click(q.x, q.y);
    await page.waitForTimeout(320);
  }
  await page.keyboard.press("Enter");
  await page.waitForTimeout(900);
  const allLayers = await page.evaluate(() => {
    try { return (window.graphiq.layers() || []).map((l) => l.id); } catch { return []; }
  });
  // Hide everything the pen drew; keep the text layer, whichever it is.
  const textId = await page.evaluate(() => {
    try {
      const ls = window.graphiq.layers() || [];
      const t = ls.find((l) => /curving/i.test(l.name || ""));
      return t ? t.id : null;
    } catch { return null; }
  });
  await page.evaluate(
    ([ids, keep]) => {
      for (const id of ids) if (id !== keep) window.graphiq.setLayer(id, { visible: false });
    },
    [allLayers, textId],
  );
  await page.waitForTimeout(900);
  await page.evaluate(() => window.graphiq.selectLayer && null);
  const onVertical = await page.evaluate(() => {
    try { window.graphiq.run("text-on-path"); return "ok"; } catch (e) { return String(e); }
  });
  await page.waitForTimeout(1700);
  const vert = await page.evaluate(SAMPLE);
  check("on a vertical path the type runs down it", onVertical === "ok" && !!vert && vert.h > vert.w * 2,
    vert ? `${vert.w}×${vert.h}` : String(onVertical));
  check("…and each glyph is TURNED onto its side, not left upright",
    !!vert && vert.w > 39,
    vert
      ? `the ink ribbon is ${vert.w}px wide — the type's full height turned; upright glyphs measure 32px here`
      : "");

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
