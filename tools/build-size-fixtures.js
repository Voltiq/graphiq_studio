/* Images that are enormous on paper and tiny on disk.
 *
 * `verify-canvas-ceiling.js` needs pictures whose declared size straddles the
 * browser's canvas limit — one exactly at it, one exactly one pixel over. Those
 * two are the item's check: "a document one pixel over the probed limit".
 *
 * The trick is to exceed the SIDE limit rather than the area limit. A canvas is
 * refused for being longer than 65535 on a side just as surely as for having too
 * many pixels, but 65536×1 is 64K pixels — a quarter of a megabyte — where an
 * area-busting image would be a gigabyte of fixture nobody wants in a repo.
 *
 * PNG is hand-written because encoding is four chunks and a CRC, and a solid
 * colour deflates to nothing: the 70000×100 file is 20 KB. Pulling in an encoder
 * to lay out an IHDR would have been the larger cost — the same reasoning as the
 * hand-packed favicon in `build-pwa-icons.js`.
 *
 * Run: node tools/build-size-fixtures.js   (npm run fixtures)
 */
const zlib = require("zlib");
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "fixtures");

const CRC = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

const crc32 = (buf) => {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) c = CRC[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return ~c >>> 0;
};

const chunk = (type, data) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
};

/** A solid-colour 8-bit RGB PNG of the given size. */
function makePng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  /* 10..12 stay zero: deflate, adaptive filtering, no interlace. */

  /* One scanline, reused: filter byte 0 then the pixels. */
  const row = Buffer.alloc(1 + w * 3);
  for (let x = 0; x < w; x++) {
    row[1 + x * 3] = r;
    row[2 + x * 3] = g;
    row[3 + x * 3] = b;
  }
  const raw = Buffer.concat(Array.from({ length: h }, () => row));

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* 65535 is Chromium's side limit and has been for years. The fixtures are named
   for their size rather than their role, so a different browser's limit does not
   make the names lie — the rail probes the real limit and picks. */
const FIXTURES = [
  { name: "size-65535x1.png", w: 65535, h: 1, rgb: [0x33, 0x88, 0xcc] },
  { name: "size-65536x1.png", w: 65536, h: 1, rgb: [0xcc, 0x44, 0x33] },
  { name: "size-70000x100.png", w: 70000, h: 100, rgb: [0x33, 0x88, 0xcc] },
  /* A 12 MP photograph — the size the allocation-floor item is written about,
     and the size at which a document-sized buffer is 45.8 MB. Solid colour, so
     36 MB of pixels deflate to 41 KB: the fixture is about what the app is asked
     to HOLD, never about what it has to decode. */
  { name: "photo-4000x3000.png", w: 4000, h: 3000, rgb: [0x44, 0x88, 0xbb] },
];

fs.mkdirSync(OUT, { recursive: true });
for (const f of FIXTURES) {
  const png = makePng(f.w, f.h, f.rgb);
  fs.writeFileSync(path.join(OUT, f.name), png);
  console.log(
    `${f.name.padEnd(22)} ${String(f.w).padStart(6)}×${String(f.h).padEnd(4)} ` +
      `${((f.w * f.h) / 1e6).toFixed(2).padStart(6)} Mpx  ${String(png.length).padStart(7)} bytes`,
  );
}
