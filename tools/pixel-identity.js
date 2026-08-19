/* Pixel-identity harness — the Spec 06 oracle, automated (TODO §15).
 *
 *   npm i -D playwright-core  &&  npm run dev
 *   npm run test:pixel                       (node tools/pixel-identity.js)
 *   node tools/pixel-identity.js --url http://localhost:3001 --big
 *
 * THE ORACLE. The render cache is an optimization, never truth: compositing a
 * document with warm caches must produce EXACTLY the same pixels as compositing
 * it from scratch. That single invariant covers the whole of Spec 06 — the
 * dependency hashing in `nodeKey`, the intrinsic/extrinsic split, clip-group
 * and group buffers, tiled adjustment products, and LRU eviction. Anything the
 * key forgets to depend on shows up here as a stale composite.
 *
 * HOW. A document is built up in stages through the same paths the UI uses
 * (`window.graphiq` command dispatch + real brush strokes), and after each
 * stage it is exported twice — once with the caches as the interaction left
 * them, once with `__gqRenderCache.disable()` forcing a full recompute — and
 * the two PNGs are compared byte for byte. Both exports go through
 * `exportComposite`, so the ONLY difference between them is the cache.
 *
 * WHY IT ISN'T VACUOUS. Byte-identity also holds when the cache was empty, when
 * both runs bypassed it (a node under live edit bypasses by design), or when
 * the stage's setup silently failed to change anything — and earlier drafts of
 * this file hit all three. So a stage only counts as a pass when it can show,
 * from the engine's own counters and from the composite itself, that:
 *
 *   - the cache held entries before the first export;
 *   - the first export REUSED it — a counted hit, or (on a big document, whose
 *     products are tiled and reused off the counted branch) resident tiles;
 *   - the second export did not: hits flat, and both the entry and tile counts
 *     at 0. The counters only move on the branch that consults the cache, so a
 *     disabled run raises neither hits nor misses — absence of entries, not a
 *     rise in misses, is what proves it ran cold;
 *   - the composite is not blank;
 *   - the composite CHANGED from the previous stage, i.e. the fixture built.
 *
 * Short of that it is reported as INCONCLUSIVE or NOT BUILT, never as a pass.
 *
 * PROVEN TO FAIL. Five dependencies were removed from the cache key one at a
 * time; all five were caught, each by the stage written for it:
 *
 *   nodeKey drops pixelVersion         -> stage 11, 9,082 px differ
 *   nodeKey drops the effects hash     -> stage  2, 1,429 px
 *   nodeKey drops the filter-stack hash-> stages 13 & 14, 7,195 / 7,548 px
 *   nodeKey drops the mask version     -> stage 14, 802 px
 *   effectiveKey drops opacity + blend -> stage  9, 235,833 px
 *
 * The last three only fell to stages 13 and 14, which CHANGE a dependency that
 * is already present. Stages 7 and 8, which merely add a layer's first filter
 * and first mask, missed all of them — adding one flips `hasEnabledFilters` /
 * `mask.enabled`, so the key changes whatever it hashes them to.
 *
 * Exit code 0 = every stage identical and conclusive.
 */
const { launchBrowser } = require("./lib/launch");

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const URL = arg("--url", "http://localhost:3000");
// The tiled-product path only exists above 64 MB of RGBA, so its fixture needs
// a 4096² document. That is slow and memory-hungry, hence opt-in.
const BIG = argv.includes("--big");

const DOC_W = 600;
const DOC_H = 400;

(async () => {
  const browser = await launchBrowser();
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

  const hooks = await page.evaluate(() => ({
    graphiq: typeof window.graphiq,
    cache: typeof window.__gqRenderCache,
  }));
  if (hooks.graphiq !== "object" || hooks.cache !== "object") {
    console.error(
      `Missing dev hooks (graphiq=${hooks.graphiq}, __gqRenderCache=${hooks.cache}).\n` +
        "__gqRenderCache is dev-only — run against `npm run dev`, not a production build.",
    );
    await browser.close();
    process.exit(1);
  }

  let pass = 0;
  let fail = 0;
  const failures = [];

  // ---- document setup -------------------------------------------------------
  const menu = async (a, b) => {
    await page.getByText(a, { exact: true }).first().click();
    await page.waitForTimeout(220);
    await page.getByText(b, { exact: true }).first().click();
    await page.waitForTimeout(900);
  };
  const newDoc = async (w, h) => {
    await menu("File", "New…");
    const dlg = page.locator('div[role="dialog"][aria-label="New document"]');
    await dlg.waitFor({ timeout: 8000 });
    await dlg.locator('input[type="number"]').nth(0).fill(String(w));
    await dlg.locator('input[type="number"]').nth(1).fill(String(h));
    await dlg.getByText("Create", { exact: true }).click();
    await page.waitForTimeout(1600);
    return page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  };
  /** Dispatch a command, then close whatever dialog it opened — a node under
   *  live edit is in `liveBypass`, which would make the A/B compare two
   *  uncached composites and prove nothing. */
  const run = async (id) => {
    const ok = await page.evaluate((a) => window.graphiq.run(a), id);
    await page.waitForTimeout(700);
    const open = await page.locator('div[role="dialog"]').count();
    if (open) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(500);
    }
    return ok;
  };
  const layerIds = () =>
    page.evaluate(() => {
      const walk = (ns) => ns.flatMap((n) => [n.id, ...(n.children ? walk(n.children) : [])]);
      return walk(window.graphiq.layers());
    });
  /** Run `make`, then name whichever node it added, so later stages can target
   *  it. Identified by diffing the id set rather than by taking `layers()[0]`:
   *  new layers are inserted relative to the active one, and "the top node" was
   *  twice the enclosing GROUP — which renamed the wrong thing and left a later
   *  stage aiming at a layer that did not exist. */
  const nameNew = async (label, make) => {
    const before = new Set(await layerIds());
    await make();
    let fresh = null;
    for (let attempt = 0; attempt < 10 && !fresh; attempt++) {
      fresh = (await layerIds()).find((id) => !before.has(id)) ?? null;
      if (!fresh) await page.waitForTimeout(400);
    }
    if (!fresh) throw new Error(`fixture error: nothing was created to name "${label}"`);
    await page.evaluate(([i, n]) => window.graphiq.setLayer(i, { name: n }), [fresh, label]);
    await page.waitForTimeout(400);
    const named = await byName(label);
    if (named !== fresh) throw new Error(`fixture error: naming "${label}" did not stick`);
    return fresh;
  };
  const byName = (label) =>
    page.evaluate((n) => {
      const walk = (ns) => ns.flatMap((x) => [x, ...(x.children ? walk(x.children) : [])]);
      const hit = walk(window.graphiq.layers()).find((x) => x.name === n);
      return hit ? hit.id : null;
    }, label);
  const activate = async (label) => {
    const id = await byName(label);
    if (!id) throw new Error(`fixture error: no layer named "${label}"`);
    await page.evaluate((i) => window.graphiq.selectLayer(i), id);
    await page.waitForTimeout(500);
    return id;
  };
  /** Patch a layer found by name — `fill-solid` does NOT insert on top, so
   *  patching `layers()[0]` silently patched the GROUP instead of the fill. */
  const patchByName = async (label, patch) => {
    const id = await byName(label);
    if (!id) throw new Error(`fixture error: no layer named "${label}"`);
    await page.evaluate(([i, p]) => window.graphiq.setLayer(i, p), [id, patch]);
    await page.waitForTimeout(700);
  };
  const treeShape = () =>
    page.evaluate(() => {
      const walk = (ns) =>
        ns
          .map((n) => (n.children ? `group:${n.name}(${walk(n.children)})` : `${n.type}:${n.name}`))
          .join(", ");
      return walk(window.graphiq.layers());
    });

  let box = await newDoc(DOC_W, DOC_H);
  /** A brush stroke in canvas-box coordinates. The tool is chosen by CLICKING
   *  it, not by its shortcut: a keypress lands wherever focus happens to be
   *  after a dialog closes, and a stage that silently painted nothing still
   *  compares two identical composites and "passes". */
  const stroke = async (x0, y0, x1, y1, size = 16) => {
    await page.getByRole("button", { name: "Brush" }).first().click();
    await page.waitForTimeout(300);
    await page.mouse.move(box.x + x0, box.y + y0);
    for (let i = 0; i < size; i++) await page.keyboard.press("]");
    await page.mouse.move(box.x + x0, box.y + y0);
    await page.mouse.down();
    await page.mouse.move(box.x + x1, box.y + y1, { steps: 18 });
    await page.mouse.up();
    await page.waitForTimeout(800);
  };

  // ---- the A/B itself -------------------------------------------------------
  // Everything happens in one page call so no pixels cross the bridge: both
  // PNGs are hashed in-page, and only a mismatch pays for a decode + diff.
  const ab = () =>
    page.evaluate(async () => {
      const rc = window.__gqRenderCache;
      const g = window.graphiq;
      const bytes = async (b) => (b ? new Uint8Array(await b.arrayBuffer()) : null);
      const fnv = (u8) => {
        let a = 0x811c9dc5;
        let b = 0x9dc5811c;
        for (let i = 0; i < u8.length; i++) {
          a = Math.imul(a ^ u8[i], 0x01000193);
          b = Math.imul(b ^ u8[i], 0x01000197);
        }
        return (a >>> 0).toString(36) + "." + (b >>> 0).toString(36);
      };
      const decode = async (u8) => {
        const bmp = await createImageBitmap(new Blob([u8], { type: "image/png" }));
        const c = document.createElement("canvas");
        c.width = bmp.width;
        c.height = bmp.height;
        c.getContext("2d").drawImage(bmp, 0, 0);
        return c.getContext("2d").getImageData(0, 0, bmp.width, bmp.height);
      };

      const s0 = rc.stats();
      const A = await bytes(await g.exportPNG());
      const s1 = rc.stats();
      rc.disable(); // clears every entry; every node now fully recomputes
      const B = await bytes(await g.exportPNG());
      const s2 = rc.stats();
      rc.enable();
      if (!A || !B) return { error: "exportPNG returned null" };
      // NOTE on the counters: hits/misses only move on the branch that actually
      // consults the cache, so a disabled run moves NEITHER. "It really ran
      // uncached" is therefore proved by the entry count staying at zero
      // through the second export, not by a rise in misses.

      const same = A.length === B.length && A.every((v, i) => v === B[i]);
      const out = {
        hashCached: fnv(A),
        hashPlain: fnv(B),
        same,
        // Non-vacuity evidence, straight from the engine's counters.
        entriesBefore: s0.entries,
        cachedHits: s1.hits - s0.hits,
        cachedMisses: s1.misses - s0.misses,
        plainHits: s2.hits - s1.hits,
        entriesAfterPlain: s2.entries,
        // Tiled products live in their own map and are reused without going
        // through the counted branch, so a big document needs its own evidence.
        tilesBefore: s0.tiles,
        tilesAfterPlain: s2.tiles,
        nonEmpty: 0,
        diff: null,
      };
      const imgA = await decode(A);
      let n = 0;
      for (let i = 3; i < imgA.data.length; i += 4) if (imgA.data[i] > 0) n++;
      out.nonEmpty = n;
      if (!same) {
        const imgB = await decode(B);
        let pixels = 0;
        let maxDelta = 0;
        let firstAt = null;
        for (let i = 0; i < imgA.data.length; i += 4) {
          let d = 0;
          for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(imgA.data[i + k] - imgB.data[i + k]));
          if (d > 0) {
            pixels++;
            maxDelta = Math.max(maxDelta, d);
            if (!firstAt) {
              const p = i / 4;
              firstAt = { x: p % imgA.width, y: Math.floor(p / imgA.width) };
            }
          }
        }
        out.diff = { pixels, maxDelta, firstAt, of: imgA.width * imgA.height };
      }
      return out;
    });

  let prevHash = null;
  const stage = async (name, setup, opts = {}) => {
    if (setup) await setup();
    const shape = await treeShape();
    const r = await ab();
    if (r.error) {
      fail++;
      failures.push(name);
      console.log(`FAIL  ${name} — ${r.error}`);
      return;
    }
    // Conclusive = the cache was really there, was really used by the first
    // export, and was really absent from the second.
    // Reuse shows up either as a counted hit on a whole product, or as resident
    // tiles on a tiled one — a big document may have no whole-product hits at
    // all, and demanding them would report a working tile cache as unproven.
    const reused = r.cachedHits > 0 || (r.tilesBefore > 0 && r.tilesAfterPlain === 0);
    const conclusive =
      r.entriesBefore > 0 && reused && r.plainHits === 0 && r.entriesAfterPlain === 0 && r.nonEmpty > 0;
    // A stage whose setup left the composite untouched is testing the previous
    // stage over again. `expectStatic` marks the few that legitimately do not
    // change pixels (a reveal-all mask); anywhere else it means the fixture
    // silently failed to build, which is how two stages here once "passed".
    const changed = prevHash === null || r.hashCached !== prevHash;
    const builtOk = changed || !!opts.expectStatic;
    prevHash = r.hashCached;

    const ok = r.same && conclusive && builtOk;
    ok ? pass++ : fail++;
    if (!ok) failures.push(name);
    const verdict = !r.same ? "FAIL" : !conclusive ? "INCONCLUSIVE" : !builtOk ? "NOT BUILT" : "PASS";
    const evidence =
      `entries ${r.entriesBefore} -> ${r.entriesAfterPlain}, ` +
      `hits ${r.cachedHits} cached / ${r.plainHits} plain, tiles ${r.tilesBefore} -> ${r.tilesAfterPlain}, ink ${r.nonEmpty}px`;
    console.log(
      `${verdict}  ${name}\n` +
        `        tree [${shape}]\n` +
        `        ${evidence}\n` +
        `        cached ${r.hashCached}   plain ${r.hashPlain}` +
        (r.diff
          ? `\n        DIFFERS: ${r.diff.pixels}/${r.diff.of} px, max channel delta ${r.diff.maxDelta}, first at (${r.diff.firstAt.x},${r.diff.firstAt.y})`
          : "") +
        (r.same && !conclusive ? "\n        (identical, but the cache was not exercised — proves nothing)" : "") +
        (!builtOk ? "\n        (composite unchanged from the previous stage — the fixture did not build)" : ""),
    );
  };

  console.log(`\nPixel identity: cached composite vs full recompute  —  ${DOC_W}x${DOC_H}\n`);

  // Each stage leaves its feature in place, so later stages composite an
  // increasingly tangled document rather than a series of trivial ones.
  // A BARE painted layer is deliberately not a stage: `renderNode` returns the
  // layer's own canvas before it ever consults the cache, because there is no
  // product to cache. Adding a mask makes it the smallest node that has one.
  await stage(
    "1. painted layer + mask (smallest cached product)",
    async () => {
      // A new document starts with NO layers — the first stroke creates one, so
      // naming has to come after painting, not before.
      await nameNew("base", () => stroke(80, 90, 420, 250));
      await run("mask-add"); // reveal-all: creates a product without changing pixels
    },
    { expectStatic: true },
  );
  await stage("2. layer effects (drop shadow + stroke)", async () => {
    await run("fx-add-dropShadow");
    await run("fx-add-stroke");
  });
  await stage("3. second layer, non-Normal blend at partial opacity", async () => {
    await nameNew("multiply", () => run("layer-new"));
    await stroke(300, 80, 120, 300, 4);
    await patchByName("multiply", { blend: "Multiply", opacity: 70 });
  });
  await stage("4. adjustment layer over the stack", () => run("adj-x-invert"));
  await stage("5. clipping mask", async () => {
    await nameNew("clipped", () => run("layer-new"));
    await stroke(200, 150, 500, 320, 6);
    await run("layer-clip");
  });
  await stage("6. group", () => run("layer-group"));
  await stage("7. smart filter", async () => {
    await activate("multiply");
    await run("filter-add-blur");
  });
  await stage("8. layer mask from a selection", async () => {
    // Must be a PIXEL layer (on a group, adjustment or parametric fill the
    // command is a no-op), and the selection must CUT the artwork — a rect that
    // happens to contain the whole stroke masks nothing away, and the stage
    // then compares a document it never changed.
    await nameNew("masked", () => run("layer-new"));
    await stroke(60, 200, 540, 200, 8);
    await page.evaluate(() => window.graphiq.select([{ x: 0, y: 0, w: 260, h: 400 }]));
    await page.waitForTimeout(500);
    await run("mask-from-sel");
    await page.evaluate(() => window.graphiq.select(null));
    await page.waitForTimeout(500);
  });
  await stage("9. parametric fill layer", async () => {
    await run("fill-solid");
    // A solid fill covers the canvas, which would flatten every later stage into
    // one colour and leave them proving almost nothing. Multiply at 30% keeps
    // the stack underneath visible. Found by name: fill layers are inserted
    // relative to the active layer, not at the top of the tree.
    await patchByName("Color Fill", { blend: "Multiply", opacity: 30 });
  });
  await stage("10. second adjustment above everything", () => run("adj-photo-filter-warm"));

  // The two sharpest cases: a node whose cached product is already resident,
  // then edited. This is exactly what `pixelVersion` in `nodeKey` exists to
  // catch — if the key forgets it, the stale product survives the edit.
  // It must be a layer whose active surface is its PIXELS: after `mask-add` the
  // brush is aimed at the mask, and painting white onto a reveal-all mask
  // changes nothing. "multiply" has no mask — and it does carry a smart filter,
  // so this also re-runs the filter stack over changed pixels.
  await stage("11. repaint a layer that already has a cached product", async () => {
    await activate("multiply");
    await stroke(120, 300, 480, 120, 3);
  });
  await stage("12. undo that repaint", async () => {
    await page.evaluate(() => window.graphiq.undo());
    await page.waitForTimeout(1200);
  });
  // ADDING a dependency and CHANGING one are different tests, and only the
  // second catches a key that ignores the dependency's contents: stages 7 and 8
  // gave a layer its first filter and its first mask, which flips
  // `hasEnabledFilters` / `mask.enabled` and so changes the key no matter what
  // the key hashes. These two change a dependency that is already there — and
  // without them, a `nodeKey` that hashed the filter stack and the mask version
  // to constants went undetected.
  await stage("13. second smart filter on a layer that already has one", async () => {
    await activate("multiply");
    await run("filter-add-pixelate");
  });
  await stage("14. paint on a mask that already has a cached product", async () => {
    await activate("masked");
    await page
      .locator('li[class*="layerItem"]')
      .filter({ hasText: "masked" })
      .locator('button[class*="maskThumb"]')
      .first()
      .click(); // switch the brush to the mask surface
    await page.waitForTimeout(600);
    await stroke(80, 120, 240, 300, 6);
  });

  if (BIG) {
    // Products at/above 64 MB are stored as a grid of tiles instead of one
    // canvas, so eviction can free them piecemeal. That is a wholly separate
    // code path from the whole-product cache every stage above exercises.
    console.log("\n--- tiled products (4096x4096) ---\n");
    box = await newDoc(4096, 4096);
    await stage("15. tiled adjustment product", async () => {
      await stroke(100, 100, 600, 500, 20);
      await run("adj-x-invert");
    });
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (failures.length) console.log("failed stages: " + failures.join("; "));
  if (errors.length) console.log("\nPAGE ERRORS:\n" + errors.slice(0, 5).join("\n"));
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS FAILURE:", e.message);
  process.exit(1);
});
