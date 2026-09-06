/**
 * A DNG built byte by byte, so parse and develop are finally tested TOGETHER.
 *
 * `tests/dng.test.ts` tests one half or the other: `developRaw` on a hand-made
 * `RawImage`, and `decodeDNG` on rubbish. The join between them — does the
 * parser actually produce the plane, pattern, crop, matrix and white balance
 * that develop expects — was the gap, and closing it needed a real file.
 *
 * Rather than check a camera RAW into a repository that ships no binary assets
 * beyond its own icons, this writes the smallest DNG the decoder will accept:
 * little-endian TIFF, one uncompressed 16-bit CFA strip, RGGB, carrying the
 * tags the develop pass reads. The pixel values are chosen so the answer is
 * predictable — a flat field, so demosaicing cannot change it, and an identity
 * colour matrix, so what comes out is what the develop pass did.
 */
import { describe, expect, it } from "vitest";
import { developRaw, parseRawDNG } from "../app/lib/dng";

const T = { BYTE: 1, SHORT: 3, LONG: 4, RATIONAL: 5, SRATIONAL: 10 } as const;
const SIZE: Record<number, number> = { 1: 1, 3: 2, 4: 4, 5: 8, 10: 8 };

interface Entry {
  tag: number;
  type: number;
  values: number[];
}

/**
 * Assemble a TIFF/DNG.
 *
 * Values too big for the four-byte inline slot are appended after the IFD and
 * referenced by offset. That rule is the whole of TIFF's layout, and the part a
 * hand-written file gets wrong first.
 */
function buildDNG(entries: Entry[], pixels: Uint16Array): ArrayBuffer {
  const ifdStart = 8;
  let heapAt = ifdStart + 2 + entries.length * 12 + 4;
  const heap = new Map<Entry, number>();
  for (const e of entries) {
    const bytes = SIZE[e.type] * e.values.length;
    if (bytes > 4) {
      heap.set(e, heapAt);
      heapAt += bytes + (bytes % 2);
    }
  }
  const pixelsAt = heapAt;
  const buf = new ArrayBuffer(pixelsAt + pixels.byteLength);
  const v = new DataView(buf);

  v.setUint16(0, 0x4949, true); // "II"
  v.setUint16(2, 42, true);
  v.setUint32(4, ifdStart, true);
  v.setUint16(ifdStart, entries.length, true);

  const writeValues = (at: number, e: Entry) => {
    let p = at;
    for (const n of e.values) {
      if (e.type === T.BYTE) v.setUint8(p, n);
      else if (e.type === T.SHORT) v.setUint16(p, n, true);
      else if (e.type === T.LONG) v.setUint32(p, n, true);
      else if (e.type === T.RATIONAL) {
        // Thousandths: enough for white balance, and the denominator is exact.
        v.setUint32(p, Math.round(n * 10000), true);
        v.setUint32(p + 4, 10000, true);
      } else {
        v.setInt32(p, Math.round(n * 10000), true);
        v.setInt32(p + 4, 10000, true);
      }
      p += SIZE[e.type];
    }
  };

  entries.forEach((e, i) => {
    const at = ifdStart + 2 + i * 12;
    v.setUint16(at, e.tag, true);
    v.setUint16(at + 2, e.type, true);
    v.setUint32(at + 4, e.values.length, true);
    const off = heap.get(e);
    if (off !== undefined) {
      v.setUint32(at + 8, off, true);
      writeValues(off, e);
    } else {
      writeValues(at + 8, e);
    }
  });
  v.setUint32(ifdStart + 2 + entries.length * 12, 0, true); // no next IFD

  new Uint8Array(buf, pixelsAt).set(new Uint8Array(pixels.buffer));
  return buf;
}

const W = 16;
const H = 16;

/** A flat RGGB frame with a known matrix and white balance. */
function flatDNG(extra: Entry[] = []): ArrayBuffer {
  /* A quarter of the way up rather than half: at half, the as-shot gains take
     the brightest channel to 1.0 and the pixel clips, so a test that pushes
     exposure UP has nothing to show. Headroom is the point of developing a RAW
     and the fixture has to have some. */
  const px = new Uint16Array(W * H).fill(2048);
  const entries: Entry[] = [
    { tag: 254, type: T.LONG, values: [0] }, // NewSubfileType: the main image
    { tag: 256, type: T.LONG, values: [W] },
    { tag: 257, type: T.LONG, values: [H] },
    { tag: 258, type: T.SHORT, values: [16] }, // BitsPerSample
    { tag: 259, type: T.SHORT, values: [1] }, // Compression: none
    { tag: 262, type: T.SHORT, values: [32803] }, // PhotometricInterpretation: CFA
    { tag: 273, type: T.LONG, values: [0] }, // StripOffsets — patched below
    { tag: 277, type: T.SHORT, values: [1] }, // SamplesPerPixel
    { tag: 278, type: T.LONG, values: [H] }, // RowsPerStrip
    { tag: 279, type: T.LONG, values: [px.byteLength] },
    { tag: 33421, type: T.SHORT, values: [2, 2] }, // CFARepeatPatternDim
    { tag: 33422, type: T.BYTE, values: [0, 1, 1, 2] }, // CFAPattern: RGGB
    { tag: 50706, type: T.BYTE, values: [1, 4, 0, 0] }, // DNGVersion
    { tag: 50714, type: T.SHORT, values: [0] }, // BlackLevel
    { tag: 50717, type: T.LONG, values: [16383] }, // WhiteLevel, 14-bit
    { tag: 50721, type: T.SRATIONAL, values: [1, 0, 0, 0, 1, 0, 0, 0, 1] }, // ColorMatrix1
    { tag: 50728, type: T.RATIONAL, values: [0.5, 1, 0.75] }, // AsShotNeutral
    ...extra,
  ].sort((a, b) => a.tag - b.tag);

  /* The strip offset is only known once the layout is fixed, so the file is
     built once to find where the pixels landed and then rebuilt with the real
     value — cheaper, and much clearer, than a two-pass writer. */
  const probe = buildDNG(entries, px);
  const stripAt = probe.byteLength - px.byteLength;
  return buildDNG(
    entries.map((e) => (e.tag === 273 ? { ...e, values: [stripAt] } : e)),
    px,
  );
}

const midPixel = (r: { width: number; height: number; data: Uint8ClampedArray }) => {
  const i = ((r.height >> 1) * r.width + (r.width >> 1)) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2]];
};

describe("a synthetic DNG, parsed and developed", () => {
  it("is recognised and parsed into the shape develop expects", () => {
    const img = parseRawDNG(flatDNG());
    expect(img).not.toBeNull();
    expect(img!.width).toBe(W);
    expect(img!.height).toBe(H);
    expect(img!.isCFA).toBe(true);
    expect(img!.pattern).toEqual([0, 1, 1, 2]);
    expect(img!.cropW).toBe(W);
    expect(img!.cropH).toBe(H);
  });

  /* AsShotNeutral is the colour of white AS THE CAMERA SEES IT, so the gains
     that neutralise it are its reciprocals. Getting that backwards is the
     classic RAW bug — the cast comes out doubled instead of removed — so it is
     asserted as a direction rather than as a number. */
  it("turns AsShotNeutral into gains that neutralise the cast, not double it", () => {
    const img = parseRawDNG(flatDNG())!;
    // Neutral [0.5, 1, 0.75]: the smallest reading needs the largest gain.
    expect(img.asShot[0]).toBeGreaterThan(img.asShot[2]);
    expect(img.asShot[2]).toBeGreaterThan(img.asShot[1]);
  });

  it("develops a flat mosaic into a flat picture", () => {
    const r = developRaw(parseRawDNG(flatDNG())!);
    expect(r.width).toBe(W);
    expect(r.height).toBe(H);
    const at = (x: number, y: number) => [
      r.data[(y * r.width + x) * 4],
      r.data[(y * r.width + x) * 4 + 1],
      r.data[(y * r.width + x) * 4 + 2],
    ];
    // Away from the clamped border, every pixel is the same colour.
    expect(at(8, 8)).toEqual(at(6, 6));
    expect(at(8, 8)).toEqual(at(9, 9));
    expect(at(8, 8)).toEqual(at(7, 10));
  });

  it("is opaque, since a RAW has no alpha to carry", () => {
    const r = developRaw(parseRawDNG(flatDNG())!);
    for (let i = 3; i < r.data.length; i += 4) expect(r.data[i]).toBe(255);
  });

  /* The end-to-end claim: settings chosen in a dialog reach the pixels, through
     the parse, the white balance, the demosaic, the matrix and the gamma. */
  it("carries develop options through the whole pipeline", () => {
    const img = parseRawDNG(flatDNG())!;
    const base = midPixel(developRaw(img));
    expect(midPixel(developRaw(img, { exposureEV: -2 }))[1]).toBeLessThan(base[1]);
    expect(midPixel(developRaw(img, { exposureEV: 2 }))[1]).toBeGreaterThan(base[1]);
    expect(midPixel(developRaw(img, { wb: [1.4, 1, 1] }))[0]).toBeGreaterThan(base[0]);
    expect(midPixel(developRaw(img, { wb: [1, 1, 1], exposureEV: 0 }))).toEqual(base);
  });

  it("previews at a smaller size without changing the colour", () => {
    const img = parseRawDNG(flatDNG())!;
    const small = developRaw(img, { maxEdge: 8 });
    expect(Math.max(small.width, small.height)).toBeLessThanOrEqual(8);
    expect(midPixel(small)).toEqual(midPixel(developRaw(img)));
  });

  it("honours the camera's requested crop", () => {
    const img = parseRawDNG(
      flatDNG([
        { tag: 50719, type: T.RATIONAL, values: [4, 4] }, // DefaultCropOrigin
        { tag: 50720, type: T.RATIONAL, values: [8, 8] }, // DefaultCropSize
      ]),
    )!;
    expect(img.cropX).toBe(4);
    expect(img.cropY).toBe(4);
    expect(developRaw(img).width).toBe(8);
    expect(developRaw(img).height).toBe(8);
  });

  it("rotates when the file says to, swapping the axes", () => {
    const img = parseRawDNG(
      flatDNG([
        { tag: 274, type: T.SHORT, values: [6] }, // Orientation: 90° CW
        { tag: 50719, type: T.RATIONAL, values: [0, 0] },
        { tag: 50720, type: T.RATIONAL, values: [12, 8] },
      ]),
    )!;
    expect(img.rot).toBe(1);
    const r = developRaw(img);
    expect(r.width).toBe(8);
    expect(r.height).toBe(12);
  });

  /* The fallback contract, on a file that is otherwise perfectly good: without
     DNGVersion it is a plain TIFF, and a plain TIFF is not this decoder's. */
  it("refuses a file that has stopped identifying itself as a DNG", () => {
    const entries = flatDNG();
    const v = new DataView(entries);
    const count = v.getUint16(8, true);
    for (let i = 0; i < count; i++) {
      const at = 8 + 2 + i * 12;
      if (v.getUint16(at, true) === 50706) v.setUint16(at, 0, true); // blank the tag id
    }
    expect(parseRawDNG(entries)).toBeNull();
  });
});
