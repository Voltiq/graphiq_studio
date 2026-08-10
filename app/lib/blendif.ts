// Blend-If (TODO §4) — Photoshop's Blending Options ▸ Blend If, as pure math.
//
// Two ranges decide, per pixel, how much of a layer survives:
//   · "This Layer"       — tested against the LAYER's own channel value
//   · "Underlying Layer" — tested against whatever is already composited beneath
// and the two coverages multiply. Each range has a black end and a white end,
// and each end can be SPLIT into two handles: with the halves together the cut
// is hard, with them apart it becomes a linear ramp, which is what stops a
// blend-if from looking like a chainsaw edge.
//
// DOM-free and Node-testable; the engine applies it through 256-entry LUTs, so
// the per-pixel cost is two lookups and a multiply.

export type BlendIfChannel = "gray" | "r" | "g" | "b";

export const BLEND_IF_CHANNELS: { id: BlendIfChannel; label: string }[] = [
  { id: "gray", label: "Gray" },
  { id: "r", label: "Red" },
  { id: "g", label: "Green" },
  { id: "b", label: "Blue" },
];

/** One end-pair of a range. `[a, b]` with a ≤ b; a === b is a hard cut. */
export type Handle = [number, number];

export interface BlendIfRange {
  /** Below `black[0]` nothing shows; between the two it ramps up. */
  black: Handle;
  /** Above `white[1]` nothing shows; between the two it ramps down. */
  white: Handle;
}

export interface BlendIf {
  channel: BlendIfChannel;
  this: BlendIfRange;
  under: BlendIfRange;
}

export const FULL_RANGE: BlendIfRange = { black: [0, 0], white: [255, 255] };

export const DEFAULT_BLEND_IF: BlendIf = {
  channel: "gray",
  this: FULL_RANGE,
  under: FULL_RANGE,
};

const clamp255 = (v: number): number =>
  !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 255 ? 255 : Math.round(v);

/** Force the four handles into a legal order: b0 ≤ b1 ≤ w0 ≤ w1. Dragging one
 *  handle past another is a normal thing to do, so this is a clamp, not an error. */
export function normalizeRange(r: BlendIfRange): BlendIfRange {
  const b0 = clamp255(r.black?.[0] ?? 0);
  const b1 = Math.max(b0, clamp255(r.black?.[1] ?? b0));
  // The white end is pushed up past the black end, not just clamped against it
  // — otherwise dragging white below black leaves white BELOW b1 and the range
  // silently inverts.
  const w1 = Math.max(b1, clamp255(r.white?.[1] ?? 255));
  const w0 = Math.min(w1, Math.max(b1, clamp255(r.white?.[0] ?? w1)));
  return { black: [b0, b1], white: [w0, w1] };
}

/** Does this range hide anything at all? A full range is the fast path. */
export const rangeActive = (r: BlendIfRange): boolean => {
  const n = normalizeRange(r);
  return n.black[0] > 0 || n.black[1] > 0 || n.white[0] < 255 || n.white[1] < 255;
};

/** Is this layer's blend-if doing anything? */
export const blendIfActive = (b?: BlendIf | null): boolean =>
  !!b && (rangeActive(b.this) || rangeActive(b.under));

/**
 * How much of the layer survives at channel value `v` (0–255) → 0…1.
 *
 * Outside the black/white ends nothing shows; between a split pair it ramps
 * linearly; between the two inner handles everything shows.
 */
export function coverage(v: number, range: BlendIfRange): number {
  const { black, white } = normalizeRange(range);
  const [b0, b1] = black;
  const [w0, w1] = white;
  if (v < b0) return 0;
  if (v > w1) return 0;
  let a = 1;
  if (v < b1) a = b1 > b0 ? (v - b0) / (b1 - b0) : 1;
  let c = 1;
  if (v > w0) c = w1 > w0 ? 1 - (v - w0) / (w1 - w0) : 0;
  return Math.max(0, Math.min(1, Math.min(a, c)));
}

/** 256-entry 0–255 lookup for one range — what the engine actually samples. */
export function buildLut(range: BlendIfRange): Uint8Array {
  const lut = new Uint8Array(256);
  for (let v = 0; v < 256; v++) lut[v] = Math.round(coverage(v, range) * 255);
  return lut;
}

/** The channel value a pixel is tested on. "gray" uses the Rec.601 luma
 *  Photoshop's Blend If uses, not Rec.709 — matching the host app matters more
 *  here than matching a newer standard. */
export function channelValue(r: number, g: number, b: number, ch: BlendIfChannel): number {
  switch (ch) {
    case "r":
      return r;
    case "g":
      return g;
    case "b":
      return b;
    default:
      return (r * 299 + g * 587 + b * 114) / 1000;
  }
}

/** Validate untrusted input (a project file, a hand-edited layer). */
export function sanitizeBlendIf(raw: unknown): BlendIf | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const o = raw as Partial<BlendIf>;
  const ch = BLEND_IF_CHANNELS.some((c) => c.id === o.channel)
    ? (o.channel as BlendIfChannel)
    : "gray";
  const range = (r: unknown): BlendIfRange => {
    if (!r || typeof r !== "object") return FULL_RANGE;
    const x = r as Partial<BlendIfRange>;
    return normalizeRange({
      black: [Number(x.black?.[0] ?? 0), Number(x.black?.[1] ?? 0)],
      white: [Number(x.white?.[0] ?? 255), Number(x.white?.[1] ?? 255)],
    });
  };
  const out: BlendIf = { channel: ch, this: range(o.this), under: range(o.under) };
  // A blend-if that hides nothing is the same as not having one — don't carry
  // it around in the file or pay for it at composite time.
  return blendIfActive(out) ? out : undefined;
}

/** Short description for the layer row / dialog summary ("Gray · this 24–255"). */
export function describeBlendIf(b: BlendIf): string {
  const part = (name: string, r: BlendIfRange) => {
    if (!rangeActive(r)) return "";
    const n = normalizeRange(r);
    const lo = n.black[0] === n.black[1] ? `${n.black[0]}` : `${n.black[0]}–${n.black[1]}`;
    const hi = n.white[0] === n.white[1] ? `${n.white[1]}` : `${n.white[0]}–${n.white[1]}`;
    return `${name} ${lo}…${hi}`;
  };
  const label = BLEND_IF_CHANNELS.find((c) => c.id === b.channel)?.label ?? "Gray";
  return [label, part("this", b.this), part("under", b.under)].filter(Boolean).join(" · ");
}
