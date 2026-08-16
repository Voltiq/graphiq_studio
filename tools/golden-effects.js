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
const { chromium } = require("playwright-core");

const argv = process.argv.slice(2);
const UPDATE = argv.includes("--update");
const URL = (() => {
  const i = argv.indexOf("--url");
  return i >= 0 && argv[i + 1] ? argv[i + 1] : "http://localhost:3000";
})();

const BASELINE = join(__dirname, "golden", "effects.json");
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
  const browser = await chromium.launch({ channel: "msedge", headless: true });
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
      return {
        hash: (a >>> 0).toString(36) + "." + (b >>> 0).toString(36),
        mean: sum.map((s) => Math.round((s / n) * 100) / 100),
        ink,
      };
    });

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
  const check = (key, got, note) => {
    produced[key] = got;
    if (UPDATE) {
      console.log(`rec   ${key}  ${got.hash}  ${note}`);
      return;
    }
    const want = recorded[key];
    if (!want) {
      fail++;
      console.log(`FAIL  ${key} — no golden recorded (re-run with --update)`);
      return;
    }
    const ok = want.hash === got.hash;
    ok ? pass++ : fail++;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${key}  ${got.hash}  ${note}` +
        (ok
          ? ""
          : `\n        was  ${want.hash}  mean ${want.mean.join(", ")}  ink ${want.ink}` +
            `\n        now  ${got.hash}  mean ${got.mean.join(", ")}  ink ${got.ink}`),
    );
  };

  check("fixture/bare", bare, `${bare.ink}px`);

  for (const label of EFFECTS) {
    await run("fx-open");
    await toggle(label, true);
    await closeDialogs();
    const got = await shoot();
    // An effect that rendered nothing would match its own golden for ever.
    const moved = got.hash !== bare.hash;
    check(`fx/${label}`, got, moved ? `${got.ink}px` : "!! IDENTICAL TO THE BARE LAYER — not applied");
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
  check("fx/all-eight", all, `${all.ink}px`);

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
