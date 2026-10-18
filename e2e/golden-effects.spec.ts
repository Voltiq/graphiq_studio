/**
 * Golden images for the LAYER EFFECTS. (Ported from tools/golden-effects.js, TODO 2.1.)
 *
 *   npx playwright test e2e/golden-effects.spec.ts
 *   GQ_UPDATE_GOLDENS=1 npx playwright test e2e/golden-effects.spec.ts   re-record after an intended change
 *
 * The filter and adjustment goldens live in `tests/golden.test.ts` and run in
 * Node, because those passes are pure ImageData maths. Layer effects cannot:
 * `renderStyled` composites through canvas shadows, blend modes and gradients,
 * so the browser IS the implementation.
 *
 * THE GOLDEN IS THE PNG FILE ITSELF (e2e/golden/effects/*.png), compared byte
 * for byte with the export. The script this came from stored a hash of those
 * same bytes in a JSON beside them; the two were checked equal for all ten
 * cases before the JSON was dropped. One file per case is also what lets the
 * cases run as parallel tests, and re-record, without sharing a file.
 *
 * THE FIXTURE IS THE HARD PART. A golden is only worth having if the same
 * input really does come back run after run, and a brush stroke does not
 * qualify: brush size, hardness, opacity and colour persist in localStorage.
 * Instead the fixture is a solid FILL layer (colour set through the scripting
 * hook), flattened, masked to two rectangles from a numeric selection, and the
 * mask APPLIED — no tool settings, no anti-aliasing, no persisted state.
 *
 * Each effect is recorded ALONE, then all eight together. Alone localizes a
 * regression to one renderer; together catches the stacking order.
 *
 * PROVEN TO FAIL, in the right place (in the script, and re-run on this port —
 * see TODO 2.1). Four renderers were perturbed one at a time — the drop
 * shadow's offset by one pixel, the outer glow's blur by 40%, the inner
 * shadow's blur by 40%, the gradient overlay's angle by half a percent. Each
 * moved EXACTLY its own golden plus `all-eight`, and nothing else.
 *
 * The "identical to the bare layer" check is not decoration: the first fixture
 * was a fill layer merely MASKED to the rectangles, and six of the eight
 * effects recorded as no-ops. Effects render from a layer's own alpha and the
 * mask is applied to the result, so a full-canvas layer cast its shadow off the
 * canvas and then had it masked away. Without the check those six goldens would
 * have been checked in as "working" and matched for ever.
 *
 * WHY THE SOFTWARE RASTERIZER, AND NOT A TOLERANCE. Effects composite with
 * fractional alpha, and GPU and software rasterizers round premultiplied values
 * differently: measured on one machine, single inner effects differ by max Δ1 on
 * ~6% of pixels, all-eight by max Δ5. A tolerance was the obvious fix and the
 * mutations killed it: the gradient-angle +0.5% mutation is ONLY Δ1, on 12% of
 * pixels — the same signature as the noise. So the noise is removed at its
 * source: these tests always render with --disable-gpu, which is what CI has
 * anyway. That is deterministic run to run and identical between Chrome and
 * Edge, so the comparison stays exact and the Δ1 mutation is still caught.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, expect, type App } from "./fixtures";

test.use({ launchOptions: { args: ["--disable-gpu"] } });

const UPDATE = !!process.env.GQ_UPDATE_GOLDENS;
const GOLDEN_DIR = join(__dirname, "golden", "effects");
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
const fileOf = (name: string) => name.replace(/[^\w-]+/g, "-") + ".png";
const CASES = ["fixture-bare", ...EFFECTS, "all-eight"];

/** Build the fixture: two crisp rectangles of solid colour in the layer's own alpha. */
async function fixture(app: App): Promise<void> {
  const { page } = app;
  await app.menu("File", "New…");
  const dlg = page.locator('div[role="dialog"][aria-label="New document"]');
  await dlg.waitFor({ timeout: 8_000 });
  await dlg.locator('input[type="number"]').nth(0).fill(String(DOC_W));
  await dlg.locator('input[type="number"]').nth(1).fill(String(DOC_H));
  await dlg.getByText("Create", { exact: true }).click();
  await app.settle(1_800);

  await app.setForeground("#3aa0ff");
  await app.run("fill-solid");
  await app.run("layer-flatten"); // parametric fill -> real pixels
  // Two rectangles with a gap: an outer effect has to wrap both and fill the
  // channel between them, an inner one has to hug four corners each.
  await page.evaluate(() =>
    window.graphiq!.select([
      { x: 40, y: 40, w: 100, h: 120 },
      { x: 180, y: 70, w: 100, h: 60 },
    ]),
  );
  await app.settle(500);
  await app.run("mask-from-sel");
  // APPLYING the mask is the point, not adding it (see the header).
  await app.run("mask-apply");
  await page.evaluate(() => window.graphiq!.select(null));
  await app.settle(600);
}

/** Open Layer ▸ Layer style, switch the named effects on, close it. */
async function withEffects(app: App, labels: string[]): Promise<void> {
  const { page } = app;
  await page.evaluate(() => window.graphiq!.run("fx-open"));
  const dlg = page.locator('div[role="dialog"][aria-label="Layer style"]');
  await dlg.waitFor({ timeout: 8_000 });
  for (const label of labels) {
    // The label names the CURRENT state: "Drop Shadow off" is the one to press.
    await dlg.getByRole("button", { name: `${label} off`, exact: true }).click({ timeout: 5_000 });
    await app.settle(500);
  }
  await app.key("Escape");
  await expect(dlg).toHaveCount(0);
}

/** The exported PNG's bytes. */
async function exportPng(app: App): Promise<Buffer> {
  const b64 = await app.page.evaluate(async () => {
    const blob = await window.graphiq!.exportPNG();
    if (!blob) return null;
    const u8 = new Uint8Array(await blob.arrayBuffer());
    let bin = "";
    for (let i = 0; i < u8.length; i += 0x8000) bin += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(bin);
  });
  if (!b64) throw new Error("exportPNG returned nothing");
  return Buffer.from(b64, "base64");
}

interface Census {
  ink: number;
  mean: number[];
}
/** How two PNGs differ, decoded the same way: worst channel per pixel, bucketed. */
function compare(app: App, got: Buffer, want: Buffer) {
  return app.page.evaluate(
    async ([g, w]) => {
      const decode = async (b64: string) => {
        const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
        const bmp = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        return ctx.getImageData(0, 0, bmp.width, bmp.height);
      };
      const census = (img: ImageData): Census => {
        const sum = [0, 0, 0, 0];
        let ink = 0;
        for (let i = 0; i < img.data.length; i += 4) {
          for (let k = 0; k < 4; k++) sum[k] += img.data[i + k];
          if (img.data[i + 3] > 0) ink++;
        }
        const n = img.data.length / 4;
        return { ink, mean: sum.map((s) => Math.round((s / n) * 100) / 100) };
      };
      const [A, B] = await Promise.all([decode(g), decode(w)]);
      const now = census(A);
      const was = census(B);
      if (A.width !== B.width || A.height !== B.height)
        return `SIZE CHANGED ${B.width}x${B.height} -> ${A.width}x${A.height}`;
      let max = 0;
      let off = 0;
      // Pixels by their worst channel's distance: 1, 2, 3–4, 5–8, 9–16, 17+.
      const hist = [0, 0, 0, 0, 0, 0];
      const bucket = (m: number) => (m === 1 ? 0 : m === 2 ? 1 : m <= 4 ? 2 : m <= 8 ? 3 : m <= 16 ? 4 : 5);
      for (let i = 0; i < A.data.length; i += 4) {
        let m = 0;
        for (let k = 0; k < 4; k++) m = Math.max(m, Math.abs(A.data[i + k] - B.data[i + k]));
        if (m) {
          off++;
          hist[bucket(m)]++;
        }
        if (m > max) max = m;
      }
      const total = A.data.length / 4;
      return (
        `max Δ ${max}, ${off} of ${total} px differ (${((100 * off) / total).toFixed(2)}%)` +
        ` [Δ1 ${hist[0]} · Δ2 ${hist[1]} · Δ3-4 ${hist[2]} · Δ5-8 ${hist[3]} · Δ9-16 ${hist[4]} · Δ17+ ${hist[5]}]` +
        `; was mean ${was.mean.join(", ")} ink ${was.ink}, now mean ${now.mean.join(", ")} ink ${now.ink}`
      );
    },
    [got.toString("base64"), want.toString("base64")] as const,
  );
}

/** Compare with (or, under GQ_UPDATE_GOLDENS, record) one case's golden. */
async function golden(app: App, name: string, got: Buffer): Promise<void> {
  const path = join(GOLDEN_DIR, fileOf(name));
  if (UPDATE) {
    mkdirSync(GOLDEN_DIR, { recursive: true });
    writeFileSync(path, got);
    return;
  }
  expect(existsSync(path), `${name}: no golden recorded (re-run with GQ_UPDATE_GOLDENS=1)`).toBe(true);
  const want = readFileSync(path);
  if (got.equals(want)) return;
  // What this machine produced travels with the report, so a CI-only mismatch
  // can be inspected (and committed, if it is only rasterizer rounding)
  // without a machine of that kind.
  await test.info().attach(`${fileOf(name)} (produced)`, { body: got, contentType: "image/png" });
  await test.info().attach(`${fileOf(name)} (golden)`, { body: want, contentType: "image/png" });
  expect.soft(got.equals(want), `${name} matches its golden — ${await compare(app, got, want)}`).toBe(true);
}

test("the fixture builds, and matches its golden", async ({ app }) => {
  await fixture(app);
  expect(await app.viewInk(), "the fixture composite is not empty").toBeGreaterThan(0);
  await golden(app, "fixture-bare", await exportPng(app));
});

for (const label of EFFECTS) {
  test(`${label}, alone`, async ({ app }) => {
    await fixture(app);
    const bare = await exportPng(app);
    await withEffects(app, [label]);
    const got = await exportPng(app);
    // An effect that rendered nothing would match its own golden for ever.
    expect(got.equals(bare), `${label} changed the picture (else the toggle did not take)`).toBe(false);
    await golden(app, label, got);
  });
}

test("all eight together", async ({ app }) => {
  await fixture(app);
  await withEffects(app, EFFECTS);
  await golden(app, "all-eight", await exportPng(app));
});

test("every golden on disk still has a case", () => {
  const onDisk = readdirSync(GOLDEN_DIR).filter((f) => f.endsWith(".png")).sort();
  expect(onDisk, "stale or missing goldens").toEqual(CASES.map(fileOf).sort());
});
