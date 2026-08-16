/**
 * Colour samplers — the pinned readout points behind the Info panel.
 *
 * The panel's live readout answers "what is under the pointer right now", which
 * is useless for the job people actually use it for: watching two or three
 * specific pixels while they drag a curve. A sampler is a pixel the document
 * remembers, whose value is re-read whenever the image changes, so you can pin
 * a highlight, a midtone and a shadow and watch all three move together.
 *
 * The values are deliberately NOT stored here. A sampler is a coordinate; its
 * colour is whatever the composite says at that coordinate at the moment it is
 * read. Caching a colour would mean inventing an invalidation rule for every
 * edit in the app, and getting it wrong would show a stale number — which is
 * precisely the failure the panel exists to prevent.
 *
 * Pure and DOM-free.
 */

export interface ColorSampler {
  id: string;
  /** Document pixel, integral. */
  x: number;
  y: number;
}

/** Photoshop's ceiling, and a sensible one: the readout list has to stay
 *  glanceable, and ten pinned points is already more than anyone compares. */
export const MAX_SAMPLERS = 10;

let seq = 0;
export const freshSamplerId = (): string => `smp-${Date.now().toString(36)}-${(seq += 1)}`;

const clampInt = (v: number, lo: number, hi: number) =>
  Math.max(lo, Math.min(hi, Math.round(v)));

/** Snap a point onto the document's pixel grid. A sampler outside the canvas
 *  would read nothing for ever, so it is pulled to the nearest real pixel
 *  rather than rejected — the click was still a request to sample something. */
export function clampToDoc(x: number, y: number, w: number, h: number): { x: number; y: number } {
  return { x: clampInt(x, 0, Math.max(0, w - 1)), y: clampInt(y, 0, Math.max(0, h - 1)) };
}

/**
 * Add a sampler, returning the SAME array when nothing changed — at the cap, or
 * on a pixel that already has one. Callers put this straight into React state
 * and into an undo step; a new array that means nothing costs a re-render and a
 * history entry for a click that did nothing.
 */
export function addSampler(
  list: ColorSampler[],
  x: number,
  y: number,
  w: number,
  h: number,
  id = freshSamplerId(),
): ColorSampler[] {
  const p = clampToDoc(x, y, w, h);
  if (list.some((s) => s.x === p.x && s.y === p.y)) return list;
  if (list.length >= MAX_SAMPLERS) return list;
  return [...list, { id, x: p.x, y: p.y }];
}

/** The topmost sampler within `tol` document pixels of (x, y), or null.
 *  Searched newest-first so a sampler dropped on top of another is the one you
 *  grab, matching what you just did rather than what you did first. */
export function samplerAt(
  list: ColorSampler[],
  x: number,
  y: number,
  tol: number,
): ColorSampler | null {
  let best: ColorSampler | null = null;
  let bestD = Infinity;
  for (let i = list.length - 1; i >= 0; i--) {
    const s = list[i];
    const d = Math.hypot(s.x - x, s.y - y);
    if (d <= tol && d < bestD) {
      best = s;
      bestD = d;
    }
  }
  return best;
}

export function removeSampler(list: ColorSampler[], id: string): ColorSampler[] {
  const out = list.filter((s) => s.id !== id);
  return out.length === list.length ? list : out;
}

/** Move a sampler, keeping it on the canvas. Same array if it did not move. */
export function moveSampler(
  list: ColorSampler[],
  id: string,
  x: number,
  y: number,
  w: number,
  h: number,
): ColorSampler[] {
  const p = clampToDoc(x, y, w, h);
  const cur = list.find((s) => s.id === id);
  if (!cur || (cur.x === p.x && cur.y === p.y)) return list;
  return list.map((s) => (s.id === id ? { ...s, x: p.x, y: p.y } : s));
}

/**
 * Coerce whatever a project file holds into usable samplers.
 *
 * Documents get resized, cropped and rotated between saves, so a stored point
 * can easily be outside the canvas it comes back to. Those are DROPPED rather
 * than clamped: a clamped one would sit on the edge pretending to be the
 * measurement you left there, and a sampler that quietly moved is worse than a
 * sampler that is gone.
 */
export function sanitizeSamplers(raw: unknown, w: number, h: number): ColorSampler[] {
  if (!Array.isArray(raw)) return [];
  const out: ColorSampler[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Partial<ColorSampler>;
    if (typeof o.x !== "number" || typeof o.y !== "number") continue;
    if (!Number.isFinite(o.x) || !Number.isFinite(o.y)) continue;
    const x = Math.round(o.x);
    const y = Math.round(o.y);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    if (out.some((s) => s.x === x && s.y === y)) continue;
    out.push({ id: typeof o.id === "string" && o.id ? o.id : freshSamplerId(), x, y });
    if (out.length >= MAX_SAMPLERS) break;
  }
  return out;
}

/** Keep samplers meaningful across a canvas resize: shift by the crop/extend
 *  offset and drop whatever no longer lands on the canvas. */
export function offsetSamplers(
  list: ColorSampler[],
  dx: number,
  dy: number,
  w: number,
  h: number,
): ColorSampler[] {
  if (!list.length) return list;
  const out: ColorSampler[] = [];
  for (const s of list) {
    const x = s.x + Math.round(dx);
    const y = s.y + Math.round(dy);
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    out.push({ ...s, x, y });
  }
  return out.length === list.length && out.every((s, i) => s.x === list[i].x && s.y === list[i].y)
    ? list
    : out;
}

/** "#1" … "#10" — the label shown on canvas and in the panel. */
export const samplerLabel = (index: number): string => `#${index + 1}`;

/**
 * What a gesture is currently measuring, for the Info panel.
 *
 * Named for the gesture rather than "measurement" because the app already has
 * a Measure tool with its own MeasureLine; these are different things.
 *
 * Photoshop shows the marquee's size while you drag it out and the offset while
 * you move a selection; both vanish the moment the gesture ends, which is why
 * this is a transient report rather than document state.
 */
export type GestureReadout =
  | { kind: 'size'; w: number; h: number }
  | { kind: 'delta'; dx: number; dy: number }
  | null;
