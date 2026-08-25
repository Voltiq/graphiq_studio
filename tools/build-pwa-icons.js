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

  /* ---- favicon.ico ----
     `app/icon.png` gives Next a `<link rel="icon">`, and browsers STILL probe
     `/favicon.ico` — measured: a 404 on every load, which is console noise for
     anyone with the tools open and a wasted request for everyone else. It was
     found by a rail that fails on console errors rather than by looking for it.

     An .ico is a tiny container: a 6-byte ICONDIR, one 16-byte ICONDIRENTRY
     per image, then the images. Since Vista the payload may be a PNG rather
     than a DIB, which is what this writes — no encoder needed beyond the PNGs
     already being made. Hand-packed because the app hand-writes its own
     encoders, and because pulling in a dependency to lay out 22 bytes of
     header would be the larger cost. */
  const ICO_SIZES = [16, 32, 48];
  const pngs = [];
  for (const s of ICO_SIZES) {
    pngs.push(
      await sharp({ create: { width: s, height: s, channels: 4, background: GROUND } })
        .composite([
          {
            input: await sharp(src)
              .resize(s, s, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
              .toBuffer(),
          },
        ])
        .png({ compressionLevel: 9 })
        .toBuffer(),
    );
  }
  const dir = Buffer.alloc(6 + 16 * pngs.length);
  dir.writeUInt16LE(0, 0); // reserved
  dir.writeUInt16LE(1, 2); // 1 = icon
  dir.writeUInt16LE(pngs.length, 4);
  let offset = dir.length;
  pngs.forEach((png, i) => {
    const at = 6 + 16 * i;
    const size = ICO_SIZES[i];
    dir.writeUInt8(size === 256 ? 0 : size, at); // 0 means 256
    dir.writeUInt8(size === 256 ? 0 : size, at + 1);
    dir.writeUInt8(0, at + 2); // palette entries: 0 for true colour
    dir.writeUInt8(0, at + 3); // reserved
    dir.writeUInt16LE(1, at + 4); // colour planes
    dir.writeUInt16LE(32, at + 6); // bits per pixel
    dir.writeUInt32LE(png.length, at + 8);
    dir.writeUInt32LE(offset, at + 12);
    offset += png.length;
  });
  const icoPath = path.join(__dirname, "..", "public", "favicon.ico");
  fs.writeFileSync(icoPath, Buffer.concat([dir, ...pngs]));
  console.log(
    `  favicon.ico  ${(fs.statSync(icoPath).size / 1024).toFixed(1)} KB  (${ICO_SIZES.join(", ")}px)`,
  );
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
