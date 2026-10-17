/* Golden images for the LAYER EFFECTS (TODO §15).
 *
 *   npm i -D playwright-core  &&  npm run dev
 *   npm run test:fx                       (node tools/golden-effects.js)
 *   node tools/golden-effects.js --update    re-record after an intended change
 *
 * The filter and adjustment goldens live in `tests/golden.test.ts` and run in
 * Node, because those passes are pure ImageData maths. Layer effects cannot:
 * `renderStyled` composites through canvas shadows, blend modes and gradients,
 * so the browser IS the implementation. Hence a separate runner and a separate
 * baseline (tools/golden/effects.json).
 *
 * THE FIXTURE IS THE HARD PART. A golden is only worth having if the same input
 * really does come back run after run, and a brush stroke does not qualify:
 * brush size, hardness, opacity and colour all persist in localStorage, so the
 * silhouette would depend on whatever the last session left behind. Instead the
 * fixture is a solid FILL layer (its colour set explicitly through the scripting
 * hook) masked to two rectangles from a numeric selection — no tool settings, no
 * anti-aliasing, no persisted state. Effects render from that layer's alpha, so
 * every shadow, glow and bevel has crisp geometry to work from.
 *
 * Each effect is recorded ALONE, then all eight together. Alone is what
 * localizes a regression to one renderer; together is what catches the stacking
 * order between them.
 *
 * PROVEN TO FAIL, and to fail in the right place. Four renderers were perturbed
 * one at a time — the drop shadow's offset by one pixel, the outer glow's blur
 * by 40%, the inner shadow's blur by 40%, the gradient overlay's angle by half a
 * percent. Each moved EXACTLY its own golden plus `all-eight`, and nothing else;
 * a control rewrite that changed no behaviour moved nothing.
 *
 * The "!! IDENTICAL TO THE BARE LAYER" guard is not decoration: the first
 * fixture here was a fill layer merely MASKED to the rectangles, and six of the
 * eight effects recorded as no-ops. Effects render from a layer's own alpha and
 * the mask is applied to the result, so a full-canvas layer cast its shadow off
 * the edge of the canvas and then had it masked away. Without the guard those
 * six goldens would have been checked in as "working" and matched for ever.
 */
const { readFileSync, writeFileSync, mkdirSync, existsSync } = require("node:fs");
const { join, dirname } = require("node:path");
const { launchBrowser } = require("./lib/launch");

const argv = process.argv.slice(2);
const UPDATE = argv.includes("--update");
const URL = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "http://localhost:3000";
})();

/* GQ_GOLDEN_DIR exists for experiments (record a scratch baseline on one
   rasterizer, compare on another) without touching the committed one. */
const GOLDEN_DIR = process.env.GQ_GOLDEN_DIR || join(__dirname, "golden");
const BASELINE = join(GOLDEN_DIR, "effects.json");
const PNG_DIR = join(GOLDEN_DIR, "effects");
const pngPath = (key) => join(PNG_DIR, key.replace(/^fx\//, "").replace(/[^\w-]+/g, "-") + ".png");

/* WHY THE SOFTWARE RASTERIZER, AND NOT A TOLERANCE.
 *
 * Effects composite through canvas (tint, destination-in, blend modes) with
 * fractional alpha, and the GPU and software rasterizers round premultiplied
 * values differently. The goldens were recorded on a GPU; CI is headless with
 * no GPU. So on the first CI run in seven weeks (the workflow file had not
 * parsed since 2026-08-25) Bevel, Inner Shadow, Inner Glow and all-eight failed
 * on rounding alone. Measured, GPU vs software, same machine:
 *
 *   single inner effects   max Δ1, on ~6% of pixels
 *   all-eight              max Δ5 (Δ1 5569 · Δ2 783 · Δ3-4 12 · Δ5-8 2 px)
 *
 * A tolerance was the obvious fix and measuring the mutations killed it: the
 * gradient-angle +0.5% mutation (one of the four below) is ONLY Δ1, on 12% of
 * pixels — the same signature as the noise, so any threshold that forgives
 * the rasterizer forgives that regression too. The other three are loud
 * (shadow +1px: max Δ9 / Δ127 in all-eight; blurs ×1.4: max Δ20 and Δ255).
 *
 * So the noise is removed at its source instead: this harness always renders
 * on the software rasterizer (--disable-gpu), which is what CI has anyway. It
 * is deterministic run to run and identical between Chrome and Edge, and the
 * goldens stop depending on whichever GPU and driver recorded them. Hashes
 * stay exact, so the Δ1 mutation is still caught. On a failure the stored PNG
 * is diffed per pixel to say how far it moved. */
const LAUNCH = { args: ["--disable-gpu"] };
const DOC_W = 320;
const DOC_H = 200;
/** Order matches FX_ORDER in effects.ts (render stack, top → bottom). */
const EFFECTS = [
  "Bevel & Emboss",
  "Stroke",
  "Inner Shadow",
  "Inner Glow",
  "Gradient Overlay",
  "Color Overlay",
  "Outer Glow",
  "Drop Shadow",
];

(async () => {
  const browser = await launchBrowser(LAUNCH);
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

  await page.goto(URL, { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  const tour = await page
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForSelector('div[aria-label="Interactive tour"]', { state: "detached", timeout: 5000 });
  }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(700);

  if ((await page.evaluate(() => typeof window.graphiq)) !== "object") {
    console.error("window.graphiq is missing — is the dev server running?");
    await browser.close();
    process.exit(1);
  }

  const menu = async (a, b) => {
    await page.getByText(a, { exact: true }).first().click();
    await page.waitForTimeout(220);
    await page.getByText(b, { exact: true }).first().click();
    await page.waitForTimeout(900);
  };
  const run = async (id) => {
    await page.evaluate((a) => window.graphiq.run(a), id);
    await page.waitForTimeout(700);
  };
  const closeDialogs = async () => {
    for (let i = 0; i < 3 && (await page.locator('div[role="dialog"]').count()); i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(400);
    }
  };
  /** FNV-1a (doubled) over the exported PNG plus a pixel census, so a failure
   *  report says how the image moved, not merely that it did. */
  const shoot = () =>
    page.evaluate(async () => {
      const blob = await window.graphiq.exportPNG();
      if (!blob) return null;
      const u8 = new Uint8Array(await blob.arrayBuffer());
      let a = 0x811c9dc5;
      let b = 0x9dc5811c;
      for (let i = 0; i < u8.length; i++) {
        a = Math.imul(a ^ u8[i], 0x01000193);
        b = Math.imul(b ^ u8[i], 0x01000197);
      }
      const bmp = await createImageBitmap(new Blob([u8], { type: "image/png" }));
      const c = document.createElement("canvas");
      c.width = bmp.width;
      c.height = bmp.height;
      const ctx = c.getContext("2d");
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
      const sum = [0, 0, 0, 0];
      let ink = 0;
      for (let i = 0; i < d.length; i += 4) {
        sum[0] += d[i];
        sum[1] += d[i + 1];
        sum[2] += d[i + 2];
        sum[3] += d[i + 3];
        if (d[i + 3] > 0) ink++;
      }
      const n = d.length / 4;
      let bin = "";
      for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
      return {
        hash: (a >>> 0).toString(36) + "." + (b >>> 0).toString(36),
        mean: sum.map((s) => Math.round((s / n) * 100) / 100),
        ink,
        png: btoa(bin),
      };
    });
  /** Per-pixel distance between two PNGs (base64), decoded the same way. */
  const diff = (gotB64, wantB64) =>
    page.evaluate(async ([g, w]) => {
      const decode = async (b64) => {
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d");
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      };
      const [A, B] = await Promise.all([decode(g), decode(w)]);
      if (A.width !== B.width || A.height !== B.height) return { size: false };
      let max = 0;
      let off = 0;
      // Pixels by their worst channel's distance: 1, 2, 3–4, 5–8, 9–16, 17+.
      const hist = [0, 0, 0, 0, 0, 0];
      const bucket = (m) => (m === 1 ? 0 : m === 2 ? 1 : m <= 4 ? 2 : m <= 8 ? 3 : m <= 16 ? 4 : 5);
      for (let i = 0; i < A.data.length; i += 4) {
        let m = 0;
        for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(A.data[i + k] - B.data[i + k]));
        if (m) {
          off++;
          hist[bucket(m)]++;
        }
        if (m > max) max = m;
      }
      return { size: true, max, off, hist, total: A.data.length / 4 };
    }, [gotB64, wantB64]);

  // ---- the fixture ----------------------------------------------------------
  await menu("File", "New…");
  const dlg = page.locator('div[role="dialog"][aria-label="New document"]');
  await dlg.waitFor({ timeout: 8000 });
  await dlg.locator('input[type="number"]').nth(0).fill(String(DOC_W));
  await dlg.locator('input[type="number"]').nth(1).fill(String(DOC_H));
  await dlg.getByText("Create", { exact: true }).click();
  await page.waitForTimeout(1800);

  await page.evaluate(() => window.graphiq.setForeground("#3aa0ff"));
  await page.waitForTimeout(400);
  await run("fill-solid");
  await closeDialogs();
  await run("layer-flatten"); // parametric fill -> real pixels
  // Two rectangles with a gap: an outer effect has to wrap both and fill the
  // channel between them, an inner one has to hug four corners each.
  await page.evaluate(() =>
    window.graphiq.select([
      { x: 40, y: 40, w: 100, h: 120 },
      { x: 180, y: 70, w: 100, h: 60 },
    ]),
  );
  await page.waitForTimeout(500);
  await run("mask-from-sel");
  await closeDialogs();
  // APPLYING the mask is the point, not adding it. Effects are rendered from the
  // layer's own alpha and the mask is applied to the RESULT, so a full-canvas
  // layer merely masked to these rectangles casts its shadow off the edge of the
  // canvas and then has it masked away — six of the eight effects recorded as
  // "changed nothing at all". Baking the mask into the pixels puts the shape in
  // the alpha, where the effects can see it.
  await run("mask-apply");
  await closeDialogs();
  await page.evaluate(() => window.graphiq.select(null));
  await page.waitForTimeout(600);

  const bare = await shoot();
  if (!bare || bare.ink === 0) {
    console.error("fixture failed to build — the composite is empty");
    console.error(JSON.stringify(bare));
    await browser.close();
    process.exit(1);
  }
  console.log(`fixture: ${bare.ink}px of ink, mean rgba ${bare.mean.join(", ")}\n`);

  // ---- record / verify ------------------------------------------------------
  const recorded = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, "utf8")) : {};
  const produced = {};
  let pass = 0;
  let fail = 0;

  const toggle = async (label, on) => {
    const btn = page.getByRole("button", { name: `${label} ${on ? "off" : "on"}` });
    if (await btn.count()) {
      await btn.first().click();
      await page.waitForTimeout(500);
    }
  };
  const check = async (key, got, note) => {
    const { png, ...summary } = got;
    produced[key] = summary;
    if (UPDATE) {
      mkdirSync(PNG_DIR, { recursive: true });
      writeFileSync(pngPath(key), Buffer.from(png, "base64"));
      console.log(`rec   ${key}  ${got.hash}  ${note}`);
      return;
    }
    const want = recorded[key];
    if (!want || !existsSync(pngPath(key))) {
      fail++;
      console.log(`FAIL  ${key} — no golden recorded (re-run with --update)`);
      return;
    }
    if (want.hash === got.hash) {
      pass++;
      console.log(`PASS  ${key}  ${got.hash}  ${note}`);
      return;
    }
    fail++;
    const d = await diff(png, readFileSync(pngPath(key)).toString("base64"));
    const dist = d.size
      ? `max Δ ${d.max}, ${d.off} of ${d.total} px differ (${((100 * d.off) / d.total).toFixed(2)}%)` +
        ` [Δ1 ${d.hist[0]} · Δ2 ${d.hist[1]} · Δ3-4 ${d.hist[2]} · Δ5-8 ${d.hist[3]} · Δ9-16 ${d.hist[4]} · Δ17+ ${d.hist[5]}]`
      : "SIZE CHANGED";
    console.log(
      `FAIL  ${key}  ${got.hash}  ${note}` +
        `\n        was  ${want.hash}  mean ${want.mean.join(", ")}  ink ${want.ink}` +
        `\n        now  ${got.hash}  mean ${got.mean.join(", ")}  ink ${got.ink}` +
        `\n        ${dist}`,
    );
  };

  await check("fixture/bare", bare, `${bare.ink}px`);

  for (const label of EFFECTS) {
    await run("fx-open");
    await toggle(label, true);
    await closeDialogs();
    const got = await shoot();
    // An effect that rendered nothing would match its own golden for ever.
    const moved = got.hash !== bare.hash;
    await check(`fx/${label}`, got, moved ? `${got.ink}px` : "!! IDENTICAL TO THE BARE LAYER — not applied");
    if (!moved && !UPDATE) fail++;
    if (!moved) console.log(`        (${label} changed nothing — the toggle did not take)`);
    await run("fx-open");
    await toggle(label, false);
    await closeDialogs();
  }

  await run("fx-open");
  for (const label of EFFECTS) await toggle(label, true);
  await closeDialogs();
  const all = await shoot();
  await check("fx/all-eight", all, `${all.ink}px`);

  if (UPDATE) {
    mkdirSync(dirname(BASELINE), { recursive: true });
    const sorted = Object.fromEntries(Object.keys(produced).sort().map((k) => [k, produced[k]]));
    writeFileSync(BASELINE, JSON.stringify(sorted, null, 1) + "\n");
    console.log(`\ngoldens written: ${Object.keys(sorted).length} entries -> ${BASELINE}`);
  } else {
    const stale = Object.keys(recorded).filter((k) => !(k in produced));
    if (stale.length) {
      fail++;
      console.log(`FAIL  stale goldens with no case left: ${stale.join(", ")}`);
    }
    console.log(`\n${pass} passed, ${fail} failed`);
  }
  if (errors.length) console.log("\nPAGE ERRORS:\n" + errors.slice(0, 5).join("\n"));
  await browser.close();
  process.exit(!UPDATE && fail ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS FAILURE:", e.message);
  process.exit(1);
});
