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
