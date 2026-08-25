/* Generate the PWA launcher icons from the one source glyph.
 *
 * `app/icon.png` is 865×865 RGBA with the butterfly running **99.8% of the
 * width** — wingtip to wingtip, transparent corners. That is right for a
 * favicon and wrong for a launcher in two different ways, so two families come
 * out of it:
 *
 *   ANY (icon-192, icon-512) — the glyph as it is, transparent. This is what a
 *   launcher shows when it does not apply a shape mask.
 *
 *   MASKABLE (maskable-192, maskable-512) — the OS crops these to its own
 *   shape (a circle on Pixel, a squircle on Samsung), keeping only the centre
 *   **80%**. An edge-to-edge glyph loses its wingtips to that crop, so the
 *   butterfly is scaled to 80% and centred, and the ground is filled — a
 *   maskable icon must have no transparency, or the mask cuts into nothing.
 *
 * Without a maskable icon Android does not crop the `any` one: it shrinks it
 * and drops it on a white rounded square, which is the letterboxing the item
 * asks to avoid.
 *
 * The outputs are COMMITTED — they are static assets, not a build step — and
 * this exists so regenerating them from a new glyph is one command rather than
 * a memory of what sizes were used.
 *
 * Run: node tools/build-pwa-icons.js
 */
const path = require("path");
const fs = require("fs");

const SRC = path.join(__dirname, "..", "app", "icon.png");
const OUT = path.join(__dirname, "..", "public", "icons");
/* The dark surface the app itself uses (`--bg` in the dark theme), so the
   launcher glyph sits on the same ground as the editor behind it. */
const GROUND = { r: 0x18, g: 0x19, b: 0x1a, alpha: 1 };
/* The maskable safe zone is the centre 80% of the icon; anything outside may be
   cropped by the platform's shape. */
const SAFE = 0.8;
const SIZES = [192, 512];

(async () => {
  let sharp;
  try {
    sharp = require("sharp");
  } catch {
    console.error(
      "sharp is not available. It ships as a Next.js dependency; run `npm install` first.",
    );
    process.exit(1);
  }

  fs.mkdirSync(OUT, { recursive: true });
  const src = fs.readFileSync(SRC);
  const meta = await sharp(src).metadata();
  console.log(`source ${meta.width}×${meta.height}, alpha: ${meta.hasAlpha}`);

  for (const size of SIZES) {
    // ---- any: the glyph, edge to edge, transparent ------------------------
    const anyPath = path.join(OUT, `icon-${size}.png`);
    await sharp(src).resize(size, size, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png({ compressionLevel: 9 })
      .toFile(anyPath);

    // ---- maskable: 80% glyph, centred, opaque ground ----------------------
    const inner = Math.round(size * SAFE);
    const pad = Math.round((size - inner) / 2);
    const glyph = await sharp(src)
      .resize(inner, inner, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toBuffer();
    const maskPath = path.join(OUT, `maskable-${size}.png`);
    await sharp({
      create: { width: size, height: size, channels: 4, background: GROUND },
    })
      .composite([{ input: glyph, top: pad, left: pad }])
      .png({ compressionLevel: 9 })
      .toFile(maskPath);

    for (const p of [anyPath, maskPath])
      console.log(`  ${path.basename(p)}  ${(fs.statSync(p).size / 1024).toFixed(1)} KB`);
  }

  /* Apple's home-screen icon is neither of the above: iOS ignores the manifest,
     applies its own rounded-rect mask with no safe-zone allowance, and shows
     transparency as BLACK. So it is the full glyph on the opaque ground. */
  const apple = path.join(OUT, "apple-touch-icon.png");
  const glyph180 = await sharp(src)
    .resize(180, 180, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  await sharp({ create: { width: 180, height: 180, channels: 4, background: GROUND } })
    .composite([{ input: glyph180, top: 0, left: 0 }])
    .png({ compressionLevel: 9 })
    .toFile(apple);
  console.log(`  apple-touch-icon.png  ${(fs.statSync(apple).size / 1024).toFixed(1)} KB`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
