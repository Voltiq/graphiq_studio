/**
 * Decoders must not trust the sizes a file claims (TODO 0.4).
 *
 * Measured before the guards (app/lib/decode-limits.ts): a GIF header claiming
 * 65535×65535 decoded into 32 GB in 4.3 s; a 4096×4096 GIF of 1×1 frames cost
 * 64 MB per ~15-byte frame; a 150-byte TIFF claiming 16384² RGBA16 allocated
 * ~1.3–2 GB before finding it had no pixel data. Each case below is that file,
 * or its scaled-down twin, and must now be refused quickly and cheaply — while
 * the CONTROL beside it, a legitimate file of the same kind, still decodes.
 */
import { describe, expect, it } from "vitest";
import { DecodeBudget, MAX_DECODE_PIXELS, fitsDecode } from "../app/lib/decode-limits";
import { decodeGif } from "../app/lib/gif";
import { buildPSD, parsePSD, type PsdOutNode } from "../app/lib/psd";
import { decodeTiff } from "../app/lib/tiff";
import { parseRawDNG } from "../app/lib/dng";

/** A GIF with a w×h logical screen and `frames` image descriptors of fw×fh. */
function gif(w: number, h: number, frames: number, fw = 1, fh = 1): Uint8Array {
  const out: number[] = [...Buffer.from("GIF89a"), w & 255, w >> 8, h & 255, h >> 8, 0x80, 0, 0];
  out.push(0, 0, 0, 255, 255, 255); // 2-entry global colour table
  for (let i = 0; i < frames; i++) {
    out.push(0x2c, 0, 0, 0, 0, fw & 255, fw >> 8, fh & 255, fh >> 8, 0);
    out.push(2, 2, 0x44, 0x01, 0); // LZW min code 2: clear, index 0, end
  }
  out.push(0x3b);
  return new Uint8Array(out);
}

/** A PSD header claiming w×h, with empty sections after it. */
function psdHeader(w: number, h: number): ArrayBuffer {
  const b = Buffer.alloc(26 + 4 * 4 + 2);
  b.write("8BPS", 0);
  b.writeUInt16BE(1, 4);
  b.writeUInt16BE(3, 12);
  b.writeUInt32BE(h, 14);
  b.writeUInt32BE(w, 18);
  b.writeUInt16BE(8, 22);
  b.writeUInt16BE(3, 24);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.length);
}

/** A little-endian TIFF/DNG: one IFD of SHORT(3)/LONG(4)/BYTE(1) tags, no pixels. */
function tiff(tags: [number, number, number[]][]): ArrayBuffer {
  const size = (t: number) => (t === 3 ? 2 : t === 1 ? 1 : 4);
  let heap = 8 + 2 + tags.length * 12 + 4;
  const buf = Buffer.alloc(heap + 64 * tags.length);
  buf.write("II", 0);
  buf.writeUInt16LE(42, 2);
  buf.writeUInt32LE(8, 4);
  buf.writeUInt16LE(tags.length, 8);
  tags.forEach(([tag, type, values], i) => {
    const at = 10 + i * 12;
    buf.writeUInt16LE(tag, at);
    buf.writeUInt16LE(type, at + 2);
    buf.writeUInt32LE(values.length, at + 4);
    const bytes = size(type) * values.length;
    let p = at + 8;
    if (bytes > 4) {
      buf.writeUInt32LE(heap, p);
      p = heap;
      heap += bytes;
    }
    for (const v of values) {
      if (type === 3) buf.writeUInt16LE(v, p);
      else if (type === 1) buf.writeUInt8(v, p);
      else buf.writeUInt32LE(v, p);
      p += size(type);
    }
  });
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + heap);
}

/** Run `fn`; require it to finish under `ms` without retaining more than `mb`. */
async function cheap<T>(fn: () => T | Promise<T>, ms = 500, mb = 64): Promise<T> {
  const before = process.memoryUsage().arrayBuffers;
  const t0 = performance.now();
  const r = await fn();
  expect(performance.now() - t0, "took too long").toBeLessThan(ms);
  expect((process.memoryUsage().arrayBuffers - before) / 2 ** 20, "allocated too much").toBeLessThan(mb);
  return r;
}

describe("the decode limits", () => {
  it("accept real sizes and refuse impossible claims", () => {
    expect(fitsDecode(6000, 4000)).toBe(true);
    expect(fitsDecode(16384, 16384)).toBe(true); // the largest browser canvas
    expect(fitsDecode(16385, 16384)).toBe(false);
    for (const bad of [0, -1, 1.5, NaN, Infinity]) expect(fitsDecode(bad, 10), String(bad)).toBe(false);
    expect(fitsDecode(16384, 16384, 9)).toBe(false); // pixels fit, bytes do not
    expect(MAX_DECODE_PIXELS).toBe(16384 * 16384);
  });

  it("budgets cumulatively, and claims nothing it cannot cover", () => {
    const b = new DecodeBudget(100);
    expect(b.take(60)).toBe(true);
    expect(b.take(50)).toBe(false);
    expect(b.take(40)).toBe(true); // the refused 50 was not counted
    expect(b.take(NaN)).toBe(false);
  });
});

describe("GIF", () => {
  it("refuses a 65535×65535 screen (was 32 GB)", async () => {
    expect(await cheap(() => decodeGif(gif(65535, 65535, 1)))).toBeNull();
  });

  it("skips a frame that claims more than any canvas, inside a small screen", async () => {
    // The LZW buffer is the frame's own size, allocated up front.
    expect(await cheap(() => decodeGif(gif(16, 16, 1, 65535, 65535)))).toBeNull();
  });

  it("stops at the budget, keeps the frames that fit, and says so", () => {
    const frameBytes = 256 * 256 * 4;
    // Two canvases reserved (running + disposal), then room for exactly 10 frames.
    const r = decodeGif(gif(256, 256, 100), new DecodeBudget(frameBytes * 12))!;
    expect(r.frames).toHaveLength(10);
    expect(r.truncated).toBe(true);
  });

  it("CONTROL: a long animation within budget decodes whole, unflagged", () => {
    const r = decodeGif(gif(256, 256, 100))!;
    expect(r.frames).toHaveLength(100);
    expect(r.truncated).toBeUndefined();
  });
});

describe("TIFF", () => {
  const header = (w: number, h: number) =>
    tiff([[256, 4, [w]], [257, 4, [h]], [258, 3, [16, 16, 16, 16]], [259, 3, [1]], [262, 3, [2]], [277, 3, [4]], [273, 4, [0]], [279, 4, [0]]]);

  it("refuses a 16384² RGBA16 claim before allocating it (was ~2 GB for 150 bytes)", async () => {
    expect(await cheap(() => decodeTiff(header(16384, 16384)))).toBeNull();
  });

  it("refuses more pixels than any canvas", async () => {
    expect(await cheap(() => decodeTiff(header(20000, 20000)))).toBeNull();
  });
});

describe("PSD", () => {
  it("refuses a document larger than any canvas", async () => {
    expect(await cheap(() => parsePSD(psdHeader(20000, 20000)))).toBeNull();
  });

  /* The layer bomb: each layer is composed onto a DOCUMENT-sized buffer however
     small its own rect, so N one-pixel layers cost N documents. */
  const layered = (n: number) => {
    const W = 512;
    const H = 512;
    const nodes: PsdOutNode[] = [];
    for (let i = 0; i < n; i++) {
      const data = new Uint8ClampedArray(W * H * 4);
      data.set([255, 0, 0, 255], (i % W) * 4); // one opaque pixel: a 1×1 record
      nodes.push({ kind: "layer", name: `L${i}`, visible: true, opacity: 100, blend: "Normal", clipped: false, image: { width: W, height: H, data }, mask: null, maskEnabled: false });
    }
    return buildPSD(W, H, 72, nodes, { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) });
  };

  it("refuses a file once its document-sized composites exceed the budget", () => {
    /* buildPSD writes full-document RLE records, so each layer here decodes to
       four 512² planes (≈1 MB) AND a 512² RGBA composite (1 MB). 60 layers:
       ~63 MB of planes, ~63 MB of composites. A 96 MB budget lets every plane
       through, so ONLY the composite budget can refuse this — the first version
       used 20 MB, was refused by the plane budget instead, and passed with the
       composite guard deleted. */
    expect(parsePSD(layered(60), new DecodeBudget(96 * 2 ** 20))).toBeNull();
  });

  it("CONTROL: the same layered file opens whole under the real budget", () => {
    const doc = parsePSD(layered(60));
    expect(doc).not.toBeNull();
    expect(doc!.nodes).toHaveLength(60);
  });
});

describe("DNG", () => {
  it("refuses a tile that claims 65535×65535 (8 GB) inside a small image", async () => {
    const dng = tiff([
      [50706, 1, [1, 4, 0, 0]], // DNGVersion
      [254, 4, [0]],
      [256, 4, [64]],
      [257, 4, [64]],
      [258, 3, [16]],
      [259, 3, [1]],
      [262, 3, [32803]],
      [277, 3, [1]],
      [322, 4, [65535]], // TileWidth
      [323, 4, [65535]], // TileLength
      [324, 4, [0]],
      [325, 4, [0]],
    ]);
    expect(await cheap(() => parseRawDNG(dng))).toBeNull();
  });
});
