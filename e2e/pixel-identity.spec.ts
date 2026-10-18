/**
 * Pixel identity — the Spec 06 oracle. (Ported from tools/pixel-identity.js, TODO 2.1.)
 *
 * THE ORACLE. The render cache is an optimization, never truth: compositing a
 * document with warm caches must produce EXACTLY the same pixels as compositing
 * it from scratch. That one invariant covers the whole of Spec 06 — the
 * dependency hashing in `nodeKey`, the intrinsic/extrinsic split, clip-group
 * and group buffers, tiled adjustment products, and LRU eviction. Anything the
 * key forgets to depend on shows up here as a stale composite.
 *
 * HOW. A document is built up in stages through the paths the UI uses (command
 * dispatch + real brush strokes). After each stage it is exported twice — once
 * with the caches as the interaction left them, once with
 * `__gqRenderCache.disable()` forcing a full recompute — and the two PNGs are
 * compared byte for byte. Both go through `exportComposite`, so the ONLY
 * difference between them is the cache. Each stage leaves its feature in
 * place, so later stages composite an increasingly tangled document.
 *
 * WHY IT ISN'T VACUOUS. Byte-identity also holds when the cache was empty, when
 * both runs bypassed it (a node under live edit bypasses by design), or when a
 * stage's setup silently changed nothing — earlier drafts hit all three. So a
 * stage passes only when the engine's counters and the composite show that:
 *   - the cache held entries before the first export;
 *   - the first export REUSED it — a counted hit, or (on a big document, whose
 *     products are tiled and reused off the counted branch) resident tiles;
 *   - the second did not: hits flat, entries and tiles at 0. The counters only
 *     move on the branch that consults the cache, so a disabled run raises
 *     neither hits nor misses — absence of entries is what proves it ran cold;
 *   - the composite is not blank, and CHANGED from the previous stage.
 *
 * PROVEN TO FAIL. Five dependencies were removed from the cache key one at a
 * time (in the script this was ported from); each was caught by the stage
 * written for it:
 *   nodeKey drops pixelVersion          -> stage 11, 9,082 px differ
 *   nodeKey drops the effects hash      -> stage  2, 1,429 px
 *   nodeKey drops the filter-stack hash -> stages 13 & 14, 7,195 / 7,548 px
 *   nodeKey drops the mask version      -> stage 14, 802 px
 *   effectiveKey drops opacity + blend  -> stage  9, 235,833 px
 * The last three only fell to stages 13 and 14, which CHANGE a dependency that
 * is already present. Stages 7 and 8 merely add a layer's first filter and
 * first mask, which flips `hasEnabledFilters` / `mask.enabled` and so changes
 * the key whatever it hashes them to.
 */
import { test, expect, type App } from "./fixtures";
import type { ScriptLayerNode } from "../app/lib/scripting";

// Stroke offsets below are view pixels; this viewport shows the document at 100%.
test.use({ viewport: { width: 1500, height: 950 } });

const DOC_W = 600;
const DOC_H = 400;

interface AB {
  error?: string;
  hashCached: string;
  hashPlain: string;
  same: boolean;
  entriesBefore: number;
  cachedHits: number;
  plainHits: number;
  entriesAfterPlain: number;
  tilesBefore: number;
  tilesAfterPlain: number;
  nonEmpty: number;
  diff: { pixels: number; maxDelta: number; firstAt: { x: number; y: number }; of: number } | null;
}

class Fixture {
  private box = { x: 0, y: 0, width: 0, height: 0 };
  private prevHash: string | null = null;

  constructor(private readonly app: App) {}

  async newDoc(w: number, h: number): Promise<void> {
    await this.app.menu("File", "New…");
    const dlg = this.app.page.locator('div[role="dialog"][aria-label="New document"]');
    await dlg.waitFor({ timeout: 8_000 });
    await dlg.locator('input[type="number"]').nth(0).fill(String(w));
    await dlg.locator('input[type="number"]').nth(1).fill(String(h));
    await dlg.getByText("Create", { exact: true }).click();
    await this.app.settle(1_600);
    this.box = await this.app.canvasBox();
  }

  /** Dispatch a command and close any MODAL dialog it opened — a node under
   *  live edit is in `liveBypass`, which would make the A/B compare two
   *  uncached composites and prove nothing. */
  run(id: string): Promise<void> {
    return this.app.run(id);
  }

  /** A brush stroke in view coordinates. The tool is chosen by CLICKING it, not
   *  by its shortcut: a keypress lands wherever focus happens to be after a
   *  dialog closes, and a stage that silently painted nothing still compares
   *  two identical composites and "passes".
   *
   *  Always at 24 px, set explicitly. The script this came from pressed `]`
   *  per stroke for a size, but the Brush had no `]` until v2.6.10, so every
   *  stroke was at the 24 px default — which is what the mutation counts in the
   *  header were measured on. Once `]` worked, the presses accumulated across
   *  stages to the 500 px cap and stage 11 painted over the whole document. */
  async stroke(x0: number, y0: number, x1: number, y1: number): Promise<void> {
    const { page } = this.app;
    // A short timeout: a dialog left open blocks this click, and the default
    // retries it until the whole test times out, nine minutes later.
    await page.getByRole("button", { name: "Brush", exact: true }).click({ timeout: 10_000 });
    await this.app.settle(300);
    await this.app.setRange("Size", 24);
    await page.mouse.move(this.box.x + x0, this.box.y + y0);
    await page.mouse.down();
    await page.mouse.move(this.box.x + x1, this.box.y + y1, { steps: 18 });
    await page.mouse.up();
    await this.app.settle(800);
  }

  private tree(): Promise<ScriptLayerNode[]> {
    return this.app.page.evaluate(() => {
      const walk = (ns: ScriptLayerNode[]): ScriptLayerNode[] =>
        ns.flatMap((n) => [n, ...(n.children ? walk(n.children) : [])]);
      return walk(window.graphiq!.layers());
    });
  }

  async byName(label: string): Promise<string> {
    const hit = (await this.tree()).find((n) => n.name === label);
    if (!hit) throw new Error(`fixture error: no layer named "${label}"`);
    return hit.id;
  }

  /** Run `make`, then name whichever node it added. Found by diffing the id
   *  set, not by taking `layers()[0]`: new layers are inserted relative to the
   *  active one, and "the top node" was twice the enclosing GROUP — which
   *  renamed the wrong thing and left a later stage aiming at nothing. */
  async nameNew(label: string, make: () => Promise<void>): Promise<void> {
    const before = new Set((await this.tree()).map((n) => n.id));
    await make();
    let fresh: string | null = null;
    for (let i = 0; i < 10 && !fresh; i++) {
      fresh = (await this.tree()).find((n) => !before.has(n.id))?.id ?? null;
      if (!fresh) await this.app.settle(400);
    }
    if (!fresh) throw new Error(`fixture error: nothing was created to name "${label}"`);
    await this.app.page.evaluate(([i, n]) => window.graphiq!.setLayer(i, { name: n }), [fresh, label] as const);
    await this.app.settle(400);
    if ((await this.byName(label)) !== fresh) throw new Error(`fixture error: naming "${label}" did not stick`);
  }

  async activate(label: string): Promise<void> {
    const id = await this.byName(label);
    await this.app.page.evaluate((i) => window.graphiq!.selectLayer(i), id);
    await this.app.settle(500);
  }

  /** Patch a layer found by name — `fill-solid` does NOT insert on top, so
   *  patching `layers()[0]` silently patched the GROUP instead of the fill. */
  async patch(label: string, patch: { blend?: string; opacity?: number }): Promise<void> {
    const id = await this.byName(label);
    await this.app.page.evaluate(([i, p]) => window.graphiq!.setLayer(i, p), [id, patch] as const);
    await this.app.settle(700);
  }

  private shape(): Promise<string> {
    return this.app.page.evaluate(() => {
      const walk = (ns: ScriptLayerNode[]): string =>
        ns.map((n) => (n.children ? `group:${n.name}(${walk(n.children)})` : `${n.type}:${n.name}`)).join(", ");
      return walk(window.graphiq!.layers());
    });
  }

  /** Both exports in one page call, so no pixels cross the bridge: the PNGs are
   *  hashed in-page, and only a mismatch pays for a decode + diff. */
  private ab(): Promise<AB> {
    return this.app.page.evaluate(async () => {
      const rc = window.__gqRenderCache!;
      const g = window.graphiq!;
      // A worker job in flight means a draft product may still be on screen.
      for (let i = 0; i < 200 && rc.stats().workerJobs > 0; i++) await new Promise((r) => setTimeout(r, 50));
      const bytes = async (b: Blob | null) => (b ? new Uint8Array(await b.arrayBuffer()) : null);
      const fnv = (u8: Uint8Array) => {
        let a = 0x811c9dc5;
        let b = 0x9dc5811c;
        for (let i = 0; i < u8.length; i++) {
          a = Math.imul(a ^ u8[i], 0x01000193);
          b = Math.imul(b ^ u8[i], 0x01000197);
        }
        return (a >>> 0).toString(36) + "." + (b >>> 0).toString(36);
      };
      const decode = async (u8: Uint8Array) => {
        const bmp = await createImageBitmap(new Blob([u8 as BlobPart], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const x = c.getContext("2d")!;
        x.drawImage(bmp, 0, 0);
        return x.getImageData(0, 0, bmp.width, bmp.height);
      };

      const s0 = rc.stats();
      const A = await bytes(await g.exportPNG());
      const s1 = rc.stats();
      rc.disable(); // clears every entry; every node now fully recomputes
      const B = await bytes(await g.exportPNG());
      const s2 = rc.stats();
      rc.enable();
      if (!A || !B) return { error: "exportPNG returned null" } as AB;

      const same = A.length === B.length && A.every((v, i) => v === B[i]);
      const imgA = await decode(A);
      let nonEmpty = 0;
      for (let i = 3; i < imgA.data.length; i += 4) if (imgA.data[i] > 0) nonEmpty++;
      let diff: AB["diff"] = null;
      if (!same) {
        const imgB = await decode(B);
        let pixels = 0;
        let maxDelta = 0;
        let firstAt: { x: number; y: number } | null = null;
        for (let i = 0; i < imgA.data.length; i += 4) {
          let d = 0;
          for (let k = 0; k < 4; k++) d = Math.max(d, Math.abs(imgA.data[i + k] - imgB.data[i + k]));
          if (d > 0) {
            pixels++;
            maxDelta = Math.max(maxDelta, d);
            if (!firstAt) firstAt = { x: (i / 4) % imgA.width, y: Math.floor(i / 4 / imgA.width) };
          }
        }
        diff = { pixels, maxDelta, firstAt: firstAt!, of: imgA.width * imgA.height };
      }
      return {
        hashCached: fnv(A),
        hashPlain: fnv(B),
        same,
        entriesBefore: s0.entries,
        cachedHits: s1.hits - s0.hits,
        plainHits: s2.hits - s1.hits,
        entriesAfterPlain: s2.entries,
        // Tiled products live in their own map and are reused off the counted
        // branch, so a big document needs its own evidence.
        tilesBefore: s0.tiles,
        tilesAfterPlain: s2.tiles,
        nonEmpty,
        diff,
      };
    });
  }

  /** Build a stage, then hold it to the oracle. Soft: a failing stage reports
   *  and the next one still runs, as later stages test different keys.
   *  `expectStatic` marks a stage that legitimately changes no pixels. */
  async stage(name: string, setup: () => Promise<void>, opts: { expectStatic?: boolean } = {}): Promise<AB> {
    return test.step(name, async () => {
      await setup();
      const tree = await this.shape();
      const r = await this.ab();
      expect(r.error, name).toBeUndefined();
      const evidence =
        `tree [${tree}]; entries ${r.entriesBefore} -> ${r.entriesAfterPlain}, ` +
        `hits ${r.cachedHits} cached / ${r.plainHits} plain, ` +
        `tiles ${r.tilesBefore} -> ${r.tilesAfterPlain}, ink ${r.nonEmpty}px`;
      const d = r.diff;
      expect
        .soft(
          r.hashPlain,
          `${name}: cached == uncached` +
            (d ? ` — ${d.pixels}/${d.of} px differ, max delta ${d.maxDelta}, first at (${d.firstAt.x},${d.firstAt.y})` : "") +
            `; ${evidence}`,
        )
        .toBe(r.hashCached);
      // Conclusive = the cache was really there, really used by the first
      // export, and really absent from the second.
      const reused = r.cachedHits > 0 || (r.tilesBefore > 0 && r.tilesAfterPlain === 0);
      expect
        .soft(
          {
            entriesBefore: r.entriesBefore > 0,
            reused,
            plainHits: r.plainHits,
            entriesAfterPlain: r.entriesAfterPlain,
            inked: r.nonEmpty > 0,
          },
          `${name}: the cache was exercised (else identity proves nothing); ${evidence}`,
        )
        .toEqual({ entriesBefore: true, reused: true, plainHits: 0, entriesAfterPlain: 0, inked: true });
      // A stage whose setup left the composite untouched is testing the
      // previous stage over again — how two stages here once "passed".
      if (!opts.expectStatic && this.prevHash !== null)
        expect.soft(r.hashCached, `${name}: the stage changed the composite (the fixture built)`).not.toBe(this.prevHash);
      this.prevHash = r.hashCached;
      return r;
    });
  }
}

test("a cached composite is byte-identical to a full recompute, stage by stage", async ({ app }) => {
  test.slow();
  const hook = await app.page.evaluate(() => typeof window.__gqRenderCache);
  expect(hook, "__gqRenderCache is dev-only — run against `npm run dev`").toBe("object");
  const f = new Fixture(app);
  await f.newDoc(DOC_W, DOC_H);

  // A BARE painted layer is deliberately not a stage: `renderNode` returns the
  // layer's own canvas before it ever consults the cache. A mask makes it the
  // smallest node that has a product.
  await f.stage(
    "1. painted layer + mask (smallest cached product)",
    async () => {
      // A new document starts with NO layers — the first stroke creates one,
      // so naming comes after painting.
      await f.nameNew("base", () => f.stroke(80, 90, 420, 250));
      await f.run("mask-add"); // reveal-all: a product without changing pixels
    },
    { expectStatic: true },
  );
  await f.stage("2. layer effects (drop shadow + stroke)", async () => {
    await f.run("fx-add-dropShadow");
    await f.run("fx-add-stroke");
  });
  await f.stage("3. second layer, non-Normal blend at partial opacity", async () => {
    await f.nameNew("multiply", () => f.run("layer-new"));
    await f.stroke(300, 80, 120, 300);
    await f.patch("multiply", { blend: "Multiply", opacity: 70 });
  });
  await f.stage("4. adjustment layer over the stack", () => f.run("adj-x-invert"));
  await f.stage("5. clipping mask", async () => {
    await f.nameNew("clipped", () => f.run("layer-new"));
    await f.stroke(200, 150, 500, 320);
    await f.run("layer-clip");
  });
  await f.stage("6. group", () => f.run("layer-group"));
  await f.stage("7. smart filter", async () => {
    await f.activate("multiply");
    await f.run("filter-add-blur");
  });
  await f.stage("8. layer mask from a selection", async () => {
    // A PIXEL layer (on a group, adjustment or fill the command is a no-op),
    // and a selection that CUTS the artwork — one containing the whole stroke
    // masks nothing away, and the stage then compares an unchanged document.
    await f.nameNew("masked", () => f.run("layer-new"));
    await f.stroke(60, 200, 540, 200);
    await app.page.evaluate(() => window.graphiq!.select([{ x: 0, y: 0, w: 260, h: 400 }]));
    await app.settle(500);
    await f.run("mask-from-sel");
    await app.page.evaluate(() => window.graphiq!.select(null));
    await app.settle(500);
  });
  await f.stage("9. parametric fill layer", async () => {
    await f.run("fill-solid");
    // A solid fill would flatten every later stage into one colour. Multiply at
    // 30% keeps the stack visible. Found by name: fills are inserted relative
    // to the active layer, not at the top.
    await f.patch("Color Fill", { blend: "Multiply", opacity: 30 });
  });
  await f.stage("10. second adjustment above everything", () => f.run("adj-photo-filter-warm"));

  // The sharpest cases: a node whose cached product is resident, then edited —
  // exactly what `pixelVersion` in `nodeKey` exists to catch. Its active surface
  // must be its PIXELS (after `mask-add` the brush aims at the mask, and white
  // on a reveal-all mask changes nothing). "multiply" has no mask, and carries a
  // smart filter, so this also re-runs the filter stack over changed pixels.
  await f.stage("11. repaint a layer that already has a cached product", async () => {
    await f.activate("multiply");
    await f.stroke(120, 300, 480, 120);
  });
  await f.stage("12. undo that repaint", async () => {
    await app.page.evaluate(() => window.graphiq!.undo());
    await app.settle(1_200);
  });
  // ADDING a dependency and CHANGING one are different tests; only the second
  // catches a key that ignores the dependency's contents.
  await f.stage("13. second smart filter on a layer that already has one", async () => {
    await f.activate("multiply");
    await f.run("filter-add-pixelate");
  });
  await f.stage("14. paint on a mask that already has a cached product", async () => {
    await f.activate("masked");
    await app.page
      .locator('li[class*="layerItem"]')
      .filter({ hasText: "masked" })
      .locator('button[class*="maskThumb"]')
      .first()
      .click(); // switch the brush to the mask surface
    await app.settle(600);
    await f.stroke(80, 120, 240, 300);
  });
});

/* Products at/above 64 MB are stored as a grid of tiles, a wholly separate code
   path from the whole-product cache above. Its fixture needs a 4096² document.
   The script this came from made it opt-in as "slow and memory-hungry", so CI
   never ran it; measured here at 7 s, it runs with everything else. */
test("a tiled product is byte-identical to a full recompute", async ({ app }) => {
  test.slow();
  const f = new Fixture(app);
  await f.newDoc(4096, 4096);
  const r = await f.stage("15. tiled adjustment product", async () => {
    await f.nameNew("big", () => f.stroke(100, 100, 600, 500));
    await f.run("adj-x-invert");
  });
  // Without this, a whole-product hit would satisfy "reused" and the stage
  // would pass without the tiled path ever running.
  expect(r.tilesBefore, "the product really was tiled").toBeGreaterThan(0);
  // A resident tiled product whose input then changes: what the tiled path's
  // key check (and its dirty-tile repair) exists for. Stage 15 alone builds the
  // product once and never makes it stale.
  await f.stage("16. repaint beneath a tiled product", async () => {
    await f.activate("big");
    await f.stroke(500, 120, 150, 450);
  });
});
