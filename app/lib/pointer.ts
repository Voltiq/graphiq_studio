// Touch & pen (TODO §11) — the pure logic behind pen-pressure dynamics and
// palm rejection. DOM-free and Node-testable: it takes plain descriptions of a
// pointer event, never a real one.
//
// The guiding rule for pressure: a MOUSE must behave exactly as it always has.
// Browsers report `pressure === 0.5` for a pressed mouse button, so feeding raw
// pressure into the brush would silently halve every mouse stroke. Pressure is
// therefore only honoured for pointer types that actually measure it.

/** How hard you have to press to reach full size/flow. */
export type PressureCurve = "soft" | "linear" | "firm";

export const PRESSURE_CURVES: { id: PressureCurve; label: string; hint: string }[] = [
  { id: "soft", label: "Soft", hint: "Full strength with a light touch" },
  { id: "linear", label: "Linear", hint: "Raw pressure, straight through" },
  { id: "firm", label: "Firm", hint: "Press harder for full strength" },
];

const EXP: Record<PressureCurve, number> = { soft: 0.6, linear: 1, firm: 1.7 };

export const clamp01 = (v: number): number => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Apply the response curve to a raw 0–1 pressure. */
export function shapePressure(raw: number, curve: PressureCurve = "linear"): number {
  const p = clamp01(Number.isFinite(raw) ? raw : 1);
  const e = EXP[curve] ?? 1;
  return e === 1 ? p : Math.pow(p, e);
}

/**
 * The pressure a stroke should actually use.
 *
 * Returns 1 (full) unless the device really measures pressure: a mouse reports
 * a constant 0.5 while held, and a pen that reports exactly 0 is either hovering
 * or hardware that doesn't measure — in both cases pretending it's a light touch
 * would make the tool feel broken.
 */
export function effectivePressure(
  pointerType: string,
  raw: number,
  opts: { enabled?: boolean; curve?: PressureCurve } = {},
): number {
  const { enabled = true, curve = "linear" } = opts;
  if (!enabled) return 1;
  if (pointerType !== "pen" && pointerType !== "touch") return 1;
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  return shapePressure(raw, curve);
}

/** Scale a value by pressure, never below `min` (0–1) of the full value. */
export function pressureScale(p: number, min01: number): number {
  const m = clamp01(min01);
  return m + (1 - m) * clamp01(p);
}

/* ------------------------------ palm rejection ----------------------------- */

/** What the app knows about the input devices it has seen. */
export interface PalmState {
  /** A pen has been used on this canvas at some point in the session. */
  penSeen: boolean;
  /** Number of pen pointers currently down. */
  penDown: number;
}

export const newPalmState = (): PalmState => ({ penSeen: false, penDown: 0 });

/**
 * Should this pointer be ignored by the tools?
 *
 * Palm rejection is the standard heuristic, not contact-area guesswork (browser
 * `width`/`height` are wildly inconsistent across devices): once a stylus has
 * been used, touch stops drawing. Touch is only ever rejected for TOOL input —
 * two-finger pan/zoom keeps working, which is the whole point of resting your
 * hand on the glass while you draw.
 */
export function rejectsPointer(
  state: PalmState,
  pointerType: string,
  enabled: boolean,
): boolean {
  if (!enabled || pointerType !== "touch") return false;
  return state.penDown > 0 || state.penSeen;
}

/** Fold a pointerdown into the palm state (returns a NEW state). */
export function palmDown(state: PalmState, pointerType: string): PalmState {
  if (pointerType !== "pen") return state;
  return { penSeen: true, penDown: state.penDown + 1 };
}

/** Fold a pointerup / pointercancel into the palm state. */
export function palmUp(state: PalmState, pointerType: string): PalmState {
  if (pointerType !== "pen") return state;
  return { penSeen: true, penDown: Math.max(0, state.penDown - 1) };
}

/* ------------------------------ brush dynamics ----------------------------- */

/** Pressure dynamics for one brush (stored on BrushSettings). */
export interface PressureDynamics {
  /** Pressure drives the tip diameter. */
  size: boolean;
  /** Pressure drives flow (per-dab paint deposited). */
  flow: boolean;
  /** Floor, as a percentage of the full value, at zero pressure. */
  min: number;
}

export const DEFAULT_DYNAMICS: PressureDynamics = { size: true, flow: false, min: 20 };

/** True when this brush would look any different under pressure. */
export const dynamicsActive = (d: PressureDynamics): boolean => d.size || d.flow;

/**
 * Quantize pressure into a tip-cache bucket. The engine bakes one tip canvas per
 * bucket and reuses it, which is what keeps a pressure stroke as cheap and as
 * grain-free as a flat one — re-deriving the tip per dab would both cost more
 * and re-introduce the dithering the baked-tip design exists to avoid.
 */
export const PRESSURE_BUCKETS = 24;

export function pressureBucket(p: number, buckets = PRESSURE_BUCKETS): number {
  return Math.max(1, Math.min(buckets, Math.ceil(clamp01(p) * buckets)));
}

/** The pressure a bucket represents (its upper edge). */
export function bucketPressure(bucket: number, buckets = PRESSURE_BUCKETS): number {
  return Math.max(1, Math.min(buckets, Math.round(bucket))) / buckets;
}

/* ------------------------------- grab radii -------------------------------- */

/**
 * How much larger an on-canvas grab radius should be for a given pointer type.
 *
 * Every hit test on the canvas — transform handles, crop corners, shape nodes,
 * pen anchors, gradient stops — was written against a mouse, whose hotspot is a
 * single pixel the user can see. A fingertip is neither: its contact patch is
 * around 8–10mm, the reported point is the centroid of that patch rather than
 * anywhere the user aimed, and the finger hides the target while it approaches.
 * Measured on a phone, the crop handles could be missed by 5px and the miss did
 * not merely fail — it started a NEW crop, destroying the box being adjusted.
 *
 * A pen sits between the two: it has a real tip and a visible contact point, so
 * it needs far less help than a finger, but it is still held at an angle by a
 * hand that covers the target.
 *
 * A MOUSE MUST BE EXACTLY 1. Growing radii for a mouse would make handles start
 * stealing clicks that are plainly not on them, and every existing radius was
 * chosen against that device.
 */
export function grabScale(pointerType: string): number {
  if (pointerType === "touch") return 2.5;
  if (pointerType === "pen") return 1.5;
  return 1;
}

/**
 * A grab radius scaled for the pointer in use, in the same units as `base`.
 *
 * `limit` caps the result — pass the largest radius the target can carry
 * without swallowing its neighbours (half the distance to the next handle, say).
 * The cap never shrinks the radius below `base`, so a scaled-up pointer can
 * never end up with a SMALLER target than a mouse gets, which is what a naive
 * `Math.min` would produce on a small shape.
 */
export function grabRadius(base: number, pointerType: string, limit = Infinity): number {
  const want = base * grabScale(pointerType);
  return Math.max(base, Math.min(want, limit));
}
