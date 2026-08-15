/**
 * Mixer brush — wet paint that blends with what is already on the canvas.
 *
 * The model, in one sentence: the brush carries a reservoir of paint, drags a
 * tip-sized buffer of colour picked up from the canvas, and lays down a mixture
 * of the two.
 *
 *   Wet   how much canvas colour the tip picks up as it travels. 0 = a dry
 *         brush that never absorbs anything (an ordinary brush); 100 = the tip
 *         takes on whatever it is passing over.
 *   Mix   the ratio, in the paint being laid down, between what was picked up
 *         and the reservoir. 0 = pure reservoir paint, 100 = pure canvas paint.
 *         Only meaningful once Wet is above zero — with nothing picked up there
 *         is nothing to mix in, which is why the UI dims it.
 *   Load  how full the reservoir is. It empties as paint is spent and is topped
 *         up by whatever the tip picks up, so a dry brush fades out over a
 *         stroke while a wet one keeps going indefinitely.
 *   Flow  paint deposited per dab, exactly as for the ordinary brush.
 *
 * This is a strict generalization of the Smudge tool: smudge is a mixer with
 * Mix at 100 (lay down only what was picked up), Load at 0, and Wet standing in
 * for its Strength slider as `wet = 100 - strength`. The engine shares one
 * kernel between them for that reason.
 *
 * Pure and DOM-free — the per-dab arithmetic is the part worth testing, and it
 * is all here.
 */

export interface MixerSettings {
  /** Brush diameter, px. */
  size: number;
  /** Edge softness, 0–100. */
  hardness: number;
  /** How much canvas colour the tip absorbs per dab, 0–100. */
  wet: number;
  /** Reservoir fullness at the start of a stroke, 0–100. */
  load: number;
  /** Picked-up colour vs reservoir paint in what is deposited, 0–100. */
  mix: number;
  /** Paint deposited per dab, 0–100. */
  flow: number;
  /** Spacing between dabs as a fraction of the brush size, 1–100%. */
  spacing: number;
  /** Stroke stabilisation, 0–100. */
  smoothing: number;
  /** Pick up colour from the merged composite (still paints the active layer). */
  sampleAll: boolean;
  /** Empty the reservoir when the stroke ends (next stroke starts with nothing). */
  cleanAfter: boolean;
  /** Refill the reservoir from the foreground colour when the stroke ends. */
  loadAfter: boolean;
}

export const DEFAULT_MIXER: MixerSettings = {
  size: 40,
  hardness: 50,
  wet: 50,
  load: 50,
  mix: 50,
  flow: 60,
  spacing: 12,
  smoothing: 20,
  sampleAll: false,
  cleanAfter: false,
  loadAfter: true,
};

/**
 * The named combinations Photoshop ships, which are how most people actually
 * drive this tool — nobody sets Wet/Load/Mix by hand until they know what the
 * four do, and the presets are what teaches them.
 */
export const MIXER_PRESETS: { id: string; name: string; wet: number; load: number; mix: number }[] = [
  { id: "dry", name: "Dry", wet: 0, load: 50, mix: 0 },
  { id: "moist", name: "Moist", wet: 20, load: 50, mix: 50 },
  { id: "wet", name: "Wet", wet: 50, load: 50, mix: 50 },
  { id: "very-wet", name: "Very wet", wet: 80, load: 50, mix: 75 },
  { id: "heavy-mix", name: "Very wet, heavy mix", wet: 90, load: 30, mix: 90 },
];

/** Straight (NOT premultiplied) colour, alpha 0–255 like the rest of the engine. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** What the brush is carrying between dabs. */
export interface MixerState {
  /** Reservoir paint — the colour the brush was loaded with. */
  paint: Rgba;
  /** Reservoir fullness, 0–1. */
  load: number;
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const clamp255 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * How fast the reservoir empties as paint is spent.
 *
 * Tuned so a dry brush at full flow fades out over roughly a brush-width of
 * travel — long enough to read as "running out of paint", short enough that you
 * do not have to drag half the canvas to see it happen.
 */
export const DEPLETE_RATE = 0.09;

export function initialMixerState(fg: Rgba, m: MixerSettings): MixerState {
  return { paint: { ...fg }, load: clamp01(m.load / 100) };
}

/**
 * How far the deposited paint is pulled from the reservoir toward what the tip
 * picked up. Exported because the engine blends PER PIXEL (the carried colour
 * varies across the tip) while `mixerDab` blends the scalar case — sharing the
 * one factor is what stops the two drifting apart.
 */
export const mixerBlend = (m: MixerSettings): number =>
  m.wet > 0 ? clamp01(m.mix / 100) : 0;

/**
 * One dab's worth of arithmetic.
 *
 * `canvas` is the tip-weighted average colour under the tip; `carried` is what
 * the tip picked up on previous dabs. Returns the colour to lay down, how
 * strongly to lay it, and the reservoir afterwards.
 */
export function mixerDab(
  state: MixerState,
  canvas: Rgba,
  carried: Rgba,
  m: MixerSettings,
): { color: Rgba; alpha: number; next: MixerState } {
  const wet = clamp01(m.wet / 100);
  const flow = clamp01(m.flow / 100);

  // What goes down: the reservoir, pulled toward the picked-up colour by Mix.
  // With nothing picked up yet (a dry brush) there is nothing to mix in, which
  // is the honest behaviour rather than a special case.
  const blend = mixerBlend(m);
  const color: Rgba = {
    r: clamp255(state.paint.r + (carried.r - state.paint.r) * blend),
    g: clamp255(state.paint.g + (carried.g - state.paint.g) * blend),
    b: clamp255(state.paint.b + (carried.b - state.paint.b) * blend),
    a: clamp255(state.paint.a + (carried.a - state.paint.a) * blend),
  };

  // Strength of the dab. An empty reservoir lays down nothing — that IS running
  // out of paint — unless the brush is wet, in which case what it picked up is
  // what it paints with.
  const supply = Math.max(state.load, wet);
  const alpha = clamp01(flow * supply);

  // The reservoir tends toward what the tip is dragging through, at Wet's rate,
  // and is spent by depositing.
  const next: MixerState = {
    paint: {
      r: state.paint.r + (carried.r - state.paint.r) * wet,
      g: state.paint.g + (carried.g - state.paint.g) * wet,
      b: state.paint.b + (carried.b - state.paint.b) * wet,
      a: state.paint.a + (carried.a - state.paint.a) * wet,
    },
    load: clamp01(state.load - DEPLETE_RATE * flow * (1 - wet) + DEPLETE_RATE * wet),
  };
  return { color, alpha, next };
}

/**
 * The reservoir the next stroke starts with (Clean / Load after each stroke).
 *
 * Applied when the NEXT stroke begins rather than when the last one ends, so
 * `fg` is the foreground as it is now. Resolving it at lift-off meant a brush
 * reloaded with whatever colour happened to be selected then, and choosing a
 * new colour before painting again had no effect — the least defensible kind of
 * surprise, since the swatch plainly said otherwise.
 */
export function afterStroke(state: MixerState, fg: Rgba, m: MixerSettings): MixerState {
  // Clean wins: emptying the brush and refilling it are contradictory, and an
  // empty brush is the more surprising of the two to have silently overridden.
  if (m.cleanAfter) return { paint: { ...state.paint }, load: 0 };
  if (m.loadAfter) return { paint: { ...fg }, load: clamp01(m.load / 100) };
  return { paint: { ...state.paint }, load: state.load };
}

/**
 * Tip-weighted average of a region, computed on PREMULTIPLIED colour.
 *
 * Averaging straight RGB would let fully transparent pixels — whose stored RGB
 * is usually black — vote on the colour, so picking up next to an edge would
 * drag a dark fringe into the brush. Weighting by alpha and dividing by the
 * total alpha is the difference between picking up "the paint that is there"
 * and "the paint that is there, mixed with the void around it".
 *
 * `weights` is the tip's coverage profile, `stride` the row length in pixels.
 */
export function averageColor(
  pixels: Uint8ClampedArray,
  weights: Float32Array,
  size: number,
  stride: number,
  left: number,
  top: number,
  w: number,
  h: number,
): Rgba {
  let sr = 0;
  let sg = 0;
  let sb = 0;
  let sa = 0;
  let wa = 0; // Σ weight·alpha — the divisor for the colour channels
  let ww = 0; // Σ weight — the divisor for alpha itself
  for (let py = 0; py < size; py++) {
    const gy = top + py;
    if (gy < 0 || gy >= h) continue;
    for (let px = 0; px < size; px++) {
      const gx = left + px;
      if (gx < 0 || gx >= w) continue;
      const f = weights[py * size + px];
      if (f <= 0) continue;
      const i = (gy * stride + gx) * 4;
      const a = pixels[i + 3];
      const fa = f * a;
      sr += pixels[i] * fa;
      sg += pixels[i + 1] * fa;
      sb += pixels[i + 2] * fa;
      sa += a * f;
      wa += fa;
      ww += f;
    }
  }
  if (ww <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  // No alpha anywhere under the tip: there is no colour to report, and dividing
  // by zero to invent one would hand the caller black.
  if (wa <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  return { r: sr / wa, g: sg / wa, b: sb / wa, a: sa / ww };
}

export function sanitizeMixer(raw: unknown): MixerSettings {
  if (!raw || typeof raw !== "object") return { ...DEFAULT_MIXER };
  const o = raw as Partial<MixerSettings>;
  const num = (v: unknown, d: number, lo: number, hi: number) =>
    typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : d;
  const bool = (v: unknown, d: boolean) => (typeof v === "boolean" ? v : d);
  return {
    size: num(o.size, DEFAULT_MIXER.size, 1, 5000),
    hardness: num(o.hardness, DEFAULT_MIXER.hardness, 0, 100),
    wet: num(o.wet, DEFAULT_MIXER.wet, 0, 100),
    load: num(o.load, DEFAULT_MIXER.load, 0, 100),
    mix: num(o.mix, DEFAULT_MIXER.mix, 0, 100),
    flow: num(o.flow, DEFAULT_MIXER.flow, 0, 100),
    spacing: num(o.spacing, DEFAULT_MIXER.spacing, 1, 100),
    smoothing: num(o.smoothing, DEFAULT_MIXER.smoothing, 0, 100),
    sampleAll: bool(o.sampleAll, DEFAULT_MIXER.sampleAll),
    cleanAfter: bool(o.cleanAfter, DEFAULT_MIXER.cleanAfter),
    loadAfter: bool(o.loadAfter, DEFAULT_MIXER.loadAfter),
  };
}

/** Apply a named preset, leaving the mechanical settings (size, spacing…) alone. */
export function applyMixerPreset(m: MixerSettings, id: string): MixerSettings {
  const p = MIXER_PRESETS.find((x) => x.id === id);
  return p ? { ...m, wet: p.wet, load: p.load, mix: p.mix } : m;
}

/** Which preset (if any) the current settings correspond to — for the UI. */
export function activeMixerPreset(m: MixerSettings): string | null {
  return MIXER_PRESETS.find((p) => p.wet === m.wet && p.load === m.load && p.mix === m.mix)?.id ?? null;
}
