/**
 * The DNG decoder's contract, which is mostly about what it does when it fails.
 *
 * `decodeDNG` is 760 lines of TIFF/IFD parsing, lossless-JPEG decoding and a
 * develop pass, and it had **no tests at all**. A full round-trip needs a real
 * DNG, which is not something to check into a repository that ships no binary
 * assets beyond its own icons — so this file pins the part that can be checked
 * without one, and says plainly what it does not reach.
 *
 * WHAT IT COVERS: the promise the module's own header makes — "everything is
 * bounds-checked and wrapped — decodeDNG never throws". That promise is what
 * lets `imageio` call it speculatively on any file and fall back to the embedded
 * JPEG preview, so a decoder that threw on a truncated file would take the
 * import down with it. Malformed input is therefore the interesting input.
 *
 * WHAT IT DOES NOT COVER: a real mosaic developed end to end. The demosaic that
 * pass now uses is tested directly and thoroughly in `tests/demosaic.test.ts`,
 * against a mosaiced image with known ground truth; what is untested is the
 * wiring between the two, and a DNG fixture is the only thing that would close
 * that. Stated here rather than left for someone to discover.
 */
import { describe, expect, it } from "vitest";
import { decodeDNG } from "../app/lib/dng";

/** A little-endian TIFF header with no usable IFD behind it. */
function tiffHeader(entries = 0): ArrayBuffer {
  const buf = new ArrayBuffer(64);
  const v = new DataView(buf);
  v.setUint16(0, 0x4949, true); // "II"
  v.setUint16(2, 42, true);
  v.setUint32(4, 8, true); // first IFD at offset 8
  v.setUint16(8, entries, true);
  return buf;
}

describe("decodeDNG never throws", () => {
  it.each([
    ["an empty buffer", new ArrayBuffer(0)],
    ["a single byte", new ArrayBuffer(1)],
    ["a buffer of zeros", new ArrayBuffer(4096)],
    ["something that is not a TIFF at all", new TextEncoder().encode("not a dng, sorry").buffer],
    ["a TIFF header with an empty IFD", tiffHeader(0)],
    ["a TIFF header claiming entries that are not there", tiffHeader(9999)],
  ])("on %s", (_what, buf) => {
    expect(() => decodeDNG(buf as ArrayBuffer)).not.toThrow();
  });

  /* The fallback contract: anything outside the supported subset returns null
     so the caller can use the embedded preview. Returning a half-decoded image
     would be worse than returning nothing. */
  it("returns null rather than a partial image when it cannot decode", () => {
    for (const buf of [new ArrayBuffer(0), new ArrayBuffer(4096), tiffHeader(0)])
      expect(decodeDNG(buf)).toBeNull();
  });

  it("survives a JPEG, which is what it is speculatively handed most often", () => {
    // SOI + APP0/JFIF + EOI — a valid JPEG shell, and not a DNG.
    const bytes = new Uint8Array([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00,
      0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xd9,
    ]);
    expect(() => decodeDNG(bytes.buffer)).not.toThrow();
    expect(decodeDNG(bytes.buffer)).toBeNull();
  });
});

/**
 * The develop half, on a synthetic RAW.
 *
 * `parseRawDNG` needs a real file; `developRaw` does not — it takes a plain
 * object, which is exactly why the decoder was split in two. So everything the
 * develop dialog will drive is checkable here as arithmetic: the neutral case
 * has to reproduce the file as the camera meant it, and each control has to do
 * what it says and nothing else.
 */
import { developRaw, type RawImage } from "../app/lib/dng";

/** A 8×8 RGGB sensor of a uniform grey, with known white balance and matrix. */
function synthetic(over: Partial<RawImage> = {}): RawImage {
  const w = 8;
  const h = 8;
  const plane = new Float32Array(w * h).fill(0.25);
  return {
    plane,
    width: w,
    height: h,
    isCFA: true,
    pattern: [0, 1, 1, 2],
    patW: 2,
    patH: 2,
    cropX: 0,
    cropY: 0,
    cropW: w,
    cropH: h,
    rot: 0,
    // Identity camera→sRGB, so what comes out is what the develop pass did.
    matrix: [1, 0, 0, 0, 1, 0, 0, 0, 1],
    exposure: 1,
    asShot: [2, 1, 1.5],
    ...over,
  };
}

/** The centre pixel, away from the clamped border. */
const centre = (r: { width: number; height: number; data: Uint8ClampedArray }) => {
  const i = ((r.height >> 1) * r.width + (r.width >> 1)) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]];
};

describe("developRaw", () => {
  it("produces the cropped, oriented size the image asks for", () => {
    const r = developRaw(synthetic());
    expect(r.width).toBe(8);
    expect(r.height).toBe(8);
    expect(r.data.length).toBe(8 * 8 * 4);
  });

  it("is fully opaque — a RAW has no alpha to carry", () => {
    const r = developRaw(synthetic());
    for (let i = 3; i < r.data.length; i += 4) expect(r.data[i]).toBe(255);
  });

  /* THE CASE THAT PROVES THE SPLIT DID NOT CHANGE ANYTHING. White balance used
     to be folded into the normalize pass; it is now applied in develop's
     sampler. Neutral options must therefore give exactly what the file says. */
  it("applies as-shot white balance when the options are neutral", () => {
    const r = developRaw(synthetic());
    const [R, G, B] = centre(r);
    // Grey 0.25 x as-shot [2, 1, 1.5] = 0.5 / 0.25 / 0.375 linear, then sRGB.
    expect(R).toBeGreaterThan(G);
    expect(B).toBeGreaterThan(G);
    expect(R).toBeGreaterThan(B);
    const neutral = developRaw(synthetic(), { wb: [1, 1, 1], exposureEV: 0 });
    expect([...neutral.data]).toEqual([...r.data]);
  });

  it("takes white balance RELATIVE to as-shot, so [1,1,1] is the file", () => {
    const asShot = developRaw(synthetic());
    const warmer = developRaw(synthetic(), { wb: [1.5, 1, 1] });
    expect(centre(warmer)[0]).toBeGreaterThan(centre(asShot)[0]);
    expect(centre(warmer)[1]).toBe(centre(asShot)[1]);
    expect(centre(warmer)[2]).toBe(centre(asShot)[2]);
  });

  /* Exposure is stops, and stops are a doubling. Checked in LINEAR terms by
     comparing against a file whose baseline exposure is doubled instead — the
     two routes must agree, which they only do if EV is really log2. */
  it("moves exposure in stops, not in arbitrary units", () => {
    const up = developRaw(synthetic(), { exposureEV: 1 });
    const baked = developRaw(synthetic({ exposure: 2 }));
    expect([...up.data]).toEqual([...baked.data]);
    const down = developRaw(synthetic(), { exposureEV: -1 });
    expect(centre(down)[1]).toBeLessThan(centre(developRaw(synthetic()))[1]);
  });

  it("clips rather than wrapping when exposure is pushed far up", () => {
    const blown = developRaw(synthetic(), { exposureEV: 8 });
    const [R, G, B] = centre(blown);
    expect(R).toBe(255);
    expect(G).toBe(255);
    expect(B).toBe(255);
  });

  it("crops to the camera's requested area", () => {
    const r = developRaw(synthetic({ cropX: 2, cropY: 2, cropW: 4, cropH: 4 }));
    expect(r.width).toBe(4);
    expect(r.height).toBe(4);
  });

  it("swaps the axes on a quarter turn", () => {
    const r = developRaw(synthetic({ cropW: 8, cropH: 4, rot: 1 }));
    expect(r.width).toBe(4);
    expect(r.height).toBe(8);
  });

  /* A preview skips output pixels; the demosaic still reads the true
     neighbourhood, so a preview of a uniform field is the same colour as the
     full develop of it — which is the property that makes it usable for
     judging exposure and white balance. */
  describe("preview scaling", () => {
    it("shrinks to the requested longest edge", () => {
      const big = synthetic({
        plane: new Float32Array(64 * 64).fill(0.25),
        width: 64,
        height: 64,
        cropW: 64,
        cropH: 64,
      });
      const r = developRaw(big, { maxEdge: 16 });
      expect(Math.max(r.width, r.height)).toBeLessThanOrEqual(16);
      expect(r.width).toBeGreaterThan(0);
    });

    it("gives the same colour as the full develop", () => {
      const big = synthetic({
        plane: new Float32Array(64 * 64).fill(0.25),
        width: 64,
        height: 64,
        cropW: 64,
        cropH: 64,
      });
      expect(centre(developRaw(big, { maxEdge: 16 }))).toEqual(centre(developRaw(big)));
    });

    it("is a no-op when the image already fits", () => {
      const full = developRaw(synthetic());
      const asked = developRaw(synthetic(), { maxEdge: 999 });
      expect(asked.width).toBe(full.width);
      expect([...asked.data]).toEqual([...full.data]);
    });
  });

  it("develops a LinearRaw image too, where there is nothing to demosaic", () => {
    const lin = synthetic({
      isCFA: false,
      plane: new Float32Array(8 * 8 * 3).fill(0.25),
    });
    const r = developRaw(lin);
    const [R, G, B] = centre(r);
    expect(R).toBeGreaterThan(G); // as-shot [2, 1, 1.5] still applies
    expect(B).toBeGreaterThan(G);
  });
});
