// Non-destructive layer effects (layer styles), rendered from a layer's alpha
// silhouette at composite time. Pure module: no tree / React / history knowledge.
// Reuses the shared separable blur (blur.ts), the gradient builder (gradient.ts),
// and colour parsing (color.ts). Buffers are document-sized (the view clips to the
// document, so a doc-sized styled buffer holds every visible effect pixel).
import { gaussianChannel } from "./blur";
import { buildCanvasGradient } from "./gradient";
import type { GradientStop, GradientType } from "./tools";

export type FxBlend = string; // one of layers.ts BLEND_MODES
export type StrokePosition = "outside" | "inside" | "center";

export interface ShadowFX {
  enabled: boolean;
  blendMode: FxBlend;
  opacity: number; // 0–100
  color: string;
  angle: number; // degrees
  distance: number; // px
  spread: number; // %
  size: number; // px (blur)
}
export interface GlowFX {
  enabled: boolean;
  blendMode: FxBlend;
  opacity: number;
  color: string;
  spread: number; // %
  size: number; // px
  source?: "edge" | "center"; // inner glow only
}
export interface StrokeFX {
  enabled: boolean;
  blendMode: FxBlend;
  opacity: number;
  size: number; // px
  position: StrokePosition;
  fillType: "color" | "gradient";
  color?: string;
  gradient?: GradientStop[];
  /** Gradient fill: linear angle in degrees (same centred geometry as the
   *  gradient overlay). ABSENT = the legacy top-left → bottom-right diagonal,
   *  kept so documents saved before the angle existed render identically. */
  angle?: number;
  reverse?: boolean;
}
export interface OverlayColorFX {
  enabled: boolean;
  blendMode: FxBlend;
  opacity: number;
  color: string;
}
export interface OverlayGradientFX {
  enabled: boolean;
  blendMode: FxBlend;
  opacity: number;
  gradient: GradientStop[];
  angle: number; // degrees
  scale: number; // %
  /** Full Gradient-tool style set: linear | radial | angle (conic) | reflected. */
  style: GradientType;
  reverse?: boolean;
  /** Angle style only: blend across the wrap seam (default true). */
  smooth?: boolean;
}
export interface BevelFX {
  enabled: boolean;
  style: "innerBevel" | "outerBevel" | "emboss" | "pillowEmboss";
  depth: number; // %
  size: number; // px
  soften: number; // px
  angle: number; // degrees
  altitude: number; // degrees
  highlightMode: FxBlend;
  highlightColor: string;
  highlightOpacity: number;
  shadowMode: FxBlend;
  shadowColor: string;
  shadowOpacity: number;
}

export interface LayerEffects {
  scale?: number; // %
  dropShadow?: ShadowFX;
  innerShadow?: ShadowFX;
  outerGlow?: GlowFX;
  innerGlow?: GlowFX;
  stroke?: StrokeFX;
  colorOverlay?: OverlayColorFX;
  gradientOverlay?: OverlayGradientFX;
  bevel?: BevelFX;
}

export interface StyledResult {
  canvas: HTMLCanvasElement;
  offset: { x: number; y: number };
}

/** The eight toggleable effect keys (everything in LayerEffects except `scale`). */
export type FxKey =
  | "dropShadow"
  | "innerShadow"
  | "outerGlow"
  | "innerGlow"
  | "stroke"
  | "colorOverlay"
  | "gradientOverlay"
  | "bevel";

/** Display labels for the effect keys (Layers-panel sub-list + dialog). */
export const FX_LABELS: Record<FxKey, string> = {
  dropShadow: "Drop Shadow",
  innerShadow: "Inner Shadow",
  outerGlow: "Outer Glow",
  innerGlow: "Inner Glow",
  bevel: "Bevel & Emboss",
  colorOverlay: "Color Overlay",
  gradientOverlay: "Gradient Overlay",
  stroke: "Stroke",
};
/** Order shown in the dialog / sub-list (matches the render stack, top→bottom). */
export const FX_ORDER: FxKey[] = [
  "bevel",
  "stroke",
  "innerShadow",
  "innerGlow",
  "gradientOverlay",
  "colorOverlay",
  "outerGlow",
  "dropShadow",
];

// ---- defaults (used by the UI when toggling an effect on) ------------------
const SHADOW = (over: Partial<ShadowFX> = {}): ShadowFX => ({
  enabled: true,
  blendMode: "Multiply",
  opacity: 50,
  color: "#000000",
  angle: 120,
  distance: 8,
  spread: 0,
  size: 10,
  ...over,
});
const GLOW = (over: Partial<GlowFX> = {}): GlowFX => ({
  enabled: true,
  blendMode: "Screen",
  opacity: 60,
  color: "#ffe08a",
  spread: 0,
  size: 12,
  ...over,
});
export const DEFAULT_FX: Record<FxKey, () => NonNullable<LayerEffects[FxKey]>> = {
  dropShadow: () => SHADOW(),
  innerShadow: () => SHADOW({ blendMode: "Multiply", opacity: 50, distance: 6, size: 8 }),
  outerGlow: () => GLOW(),
  innerGlow: () => GLOW({ source: "edge", color: "#fff3b0" }),
  stroke: () => ({ enabled: true, blendMode: "Normal", opacity: 100, size: 3, position: "outside", fillType: "color", color: "#ffffff" }),
  colorOverlay: () => ({ enabled: true, blendMode: "Normal", opacity: 100, color: "#ff3b3b" }),
  gradientOverlay: () => ({
    enabled: true,
    blendMode: "Normal",
    opacity: 100,
    gradient: [
      { pos: 0, color: "#000000" },
      { pos: 1, color: "#ffffff" },
    ],
    angle: 90,
    scale: 100,
    style: "linear",
  }),
  bevel: () => ({
    enabled: true,
    style: "innerBevel",
    depth: 100,
    size: 8,
    soften: 0,
    angle: 120,
    altitude: 30,
    highlightMode: "Screen",
    highlightColor: "#ffffff",
    highlightOpacity: 75,
    shadowMode: "Multiply",
    shadowColor: "#000000",
    shadowOpacity: 75,
  }),
};

// ---- blend-mode → canvas globalCompositeOperation (the 19 modes) ------------
const BLEND_GCO: Record<string, GlobalCompositeOperation> = {
  Normal: "source-over",
  Dissolve: "source-over",
  Darken: "darken",
  Multiply: "multiply",
  "Color Burn": "color-burn",
  "Linear Burn": "multiply",
  Lighten: "lighten",
  Screen: "screen",
  "Color Dodge": "color-dodge",
  Add: "lighter",
  Overlay: "overlay",
  "Soft Light": "soft-light",
  "Hard Light": "hard-light",
  Difference: "difference",
  Exclusion: "exclusion",
  Hue: "hue",
  Saturation: "saturation",
  Color: "color",
  Luminosity: "luminosity",
};
const gco = (b: string): GlobalCompositeOperation => BLEND_GCO[b] ?? "source-over";
const clamp = (v: number, lo: number, hi: number) => (v < lo ? lo : v > hi ? hi : v);

interface Buf {
  c: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
}
function mk(w: number, h: number, space: PredefinedColorSpace): Buf {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true, colorSpace: space })!;
  return { c, ctx };
}
/** A colour-agnostic (sRGB) RGB=0, A=`a` mask canvas (only its alpha is consumed). */
function alphaMask(a: Float32Array, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  // Two tempting micro-optimisations here are both WRONG, measured 2026-08-12:
  //  - Dropping `willReadFrequently` makes put+draw 24 ms -> 14 ms at 4000x3000,
  //    but the composite changes (445 of 21,788 non-empty pixels vanished in an
  //    A/B): a GPU-backed store does not round-trip this mask unchanged.
  //  - Writing whole pixels via a Uint32Array view (RGB is 0, so the pixel is
  //    just alpha<<24) is ~25% faster but TRUNCATES, where the byte store below
  //    rounds half-to-even. Blur output is fractional, so that disagreed on 498k
  //    of 1M samples and would shift every soft edge.
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const id = new ImageData(w, h);
  const d = id.data;
  for (let i = 0; i < a.length; i++) d[i * 4 + 3] = a[i] < 0 ? 0 : a[i] > 255 ? 255 : a[i];
  ctx.putImageData(id, 0, 0);
  return c;
}
/** Tint a silhouette: fill `color` (browser converts sRGB hex → `space`), then keep
 *  only where `a` is opaque. Returns a buffer whose colour is correct in `space`. */
function tinted(a: Float32Array, w: number, h: number, color: string, space: PredefinedColorSpace): HTMLCanvasElement {
  const t = mk(w, h, space);
  t.ctx.fillStyle = color;
  t.ctx.fillRect(0, 0, w, h);
  t.ctx.globalCompositeOperation = "destination-in";
  t.ctx.drawImage(alphaMask(a, w, h), 0, 0);
  t.ctx.globalCompositeOperation = "source-over";
  return t.c;
}
const blurred = (a: Float32Array, w: number, h: number, r: number): Float32Array => {
  const b = a.slice();
  gaussianChannel(b, w, h, r);
  return b;
};
/** Choke/grow a blurred edge toward solid by `spread` (%) — used by shadows/glows. */
function applySpread(a: Float32Array, spread: number) {
  const t = clamp(spread, 0, 100) / 100;
  if (t <= 0) return;
  const lo = t * 200; // raise the floor → grows the solid core
  const inv = 255 / Math.max(1, 255 - lo);
  for (let i = 0; i < a.length; i++) a[i] = clamp((a[i] - lo) * inv, 0, 255);
}
/** Morphological dilate/erode of an alpha field via blur + soft threshold at 50%. */
function morph(a: Float32Array, w: number, h: number, r: number, dilate: boolean): Float32Array {
  if (r < 0.5) return a.slice();
  const b = blurred(a, w, h, r);
  // threshold ~50% with a soft ramp for anti-aliasing
  const c = dilate ? 96 : 160;
  for (let i = 0; i < b.length; i++) b[i] = clamp(((b[i] - c) / 40 + 0.5) * 255, 0, 255);
  return b;
}

/** Render a layer's display canvas with its effects into a (doc-sized) styled
 *  buffer, in the document's colour space. Returns the buffer + a (0,0) offset. */
export function renderStyled(src: HTMLCanvasElement, fx: LayerEffects, space: PredefinedColorSpace): StyledResult {
  const w = src.width;
  const h = src.height;
  const out = mk(w, h, space);
  if (w < 1 || h < 1) return { canvas: out.c, offset: { x: 0, y: 0 } };
  const scale = clamp(fx.scale ?? 100, 1, 1000) / 100;

  // Layer alpha silhouette.
  const sctx = src.getContext("2d", { willReadFrequently: true });
  if (!sctx) return { canvas: out.c, offset: { x: 0, y: 0 } };
  const sd = sctx.getImageData(0, 0, w, h).data;
  const n = w * h;
  const alpha = new Float32Array(n);
  let maxA = 0;
  for (let i = 0; i < n; i++) {
    const v = sd[i * 4 + 3];
    alpha[i] = v;
    if (v > maxA) maxA = v;
  }
  if (maxA === 0) return { canvas: out.c, offset: { x: 0, y: 0 } }; // fully transparent
  // `src` IS the layer silhouette for every use below: they are all
  // destination-in/-out, which read the source ALPHA and nothing else, and
  // src's alpha is exactly what `alpha` was just read from. Building a
  // separate mask canvas cost ~31 ms per call at 4000x3000 and was paid
  // unconditionally, even when no enabled effect used it. Verified
  // identical by A/B over a five-effect composite (tools/ab-effects.js).
  const octx = out.ctx;
  const drawWith = (canvas: HTMLCanvasElement, blend: string, opacity: number, dx = 0, dy = 0) => {
     octx.globalAlpha = clamp(opacity, 0, 100) / 100;
     octx.globalCompositeOperation = gco(blend);
     octx.drawImage(canvas, dx, dy);
     octx.globalAlpha = 1;
     octx.globalCompositeOperation = "source-over";
  };

  // ---- 1–2. behind: drop shadow + outer glow, then knock out under the layer ----
  const ds = fx.dropShadow;
  if (ds?.enabled) {
    const a = alpha.slice();
    applySpread(a, ds.spread);
    gaussianChannel(a, w, h, ds.size * scale);
    const rad = (ds.angle * Math.PI) / 180;
    const dx = Math.round(-Math.cos(rad) * ds.distance * scale);
    const dy = Math.round(Math.sin(rad) * ds.distance * scale);
    drawWith(tinted(a, w, h, ds.color, space), ds.blendMode, ds.opacity, dx, dy);
  }
  const og = fx.outerGlow;
  if (og?.enabled) {
    const a = alpha.slice();
    applySpread(a, og.spread);
    gaussianChannel(a, w, h, og.size * scale);
    drawWith(tinted(a, w, h, og.color, space), og.blendMode, og.opacity);
  }
  if (ds?.enabled || og?.enabled) {
    // "Layer knocks out drop shadow": remove behind-effects under the layer.
    octx.globalCompositeOperation = "destination-out";
    octx.drawImage(src, 0, 0);
    octx.globalCompositeOperation = "source-over";
  }

  // ---- 3. the layer fill ----
  octx.drawImage(src, 0, 0);

  // overlays (clipped to alpha by tinting / destination-in)
  const co = fx.colorOverlay;
  if (co?.enabled) drawWith(tinted(alpha, w, h, co.color, space), co.blendMode, co.opacity);
  const go = fx.gradientOverlay;
  if (go?.enabled && go.gradient.length) {
    const g = mk(w, h, space);
    const stops = go.reverse ? go.gradient.map((s) => ({ pos: 1 - s.pos, color: s.color })) : go.gradient;
    const rad = (go.angle * Math.PI) / 180;
    const half = (Math.max(w, h) / 2) * (clamp(go.scale, 1, 1000) / 100);
    const cx = w / 2;
    const cy = h / 2;
    const start = { x: cx - Math.cos(rad) * half, y: cy - Math.sin(rad) * half };
    const end = { x: cx + Math.cos(rad) * half, y: cy + Math.sin(rad) * half };
    // Radial / angle / reflected all emanate from the centre; linear spans
    // edge-to-edge along the angle. (Same geometry model as the Gradient tool,
    // with the layer's centre + angle/scale standing in for the drag points.)
    const type: GradientType = go.style ?? "linear";
    const rstart = type === "linear" ? start : { x: cx, y: cy };
    g.ctx.fillStyle = buildCanvasGradient(g.ctx, type, rstart, end, 0.5, stops, go.smooth ?? true);
    g.ctx.fillRect(0, 0, w, h);
    g.ctx.globalCompositeOperation = "destination-in";
    g.ctx.drawImage(src, 0, 0);
    g.ctx.globalCompositeOperation = "source-over";
    drawWith(g.c, go.blendMode, go.opacity);
  }

  // ---- 4–5. inside: inner shadow + inner glow (clipped to alpha) ----
  const is = fx.innerShadow;
  if (is?.enabled) {
    const inv = new Float32Array(n);
    for (let i = 0; i < n; i++) inv[i] = 255 - alpha[i];
    gaussianChannel(inv, w, h, is.size * scale);
    applySpread(inv, is.spread);
    const rad = (is.angle * Math.PI) / 180;
    const dx = Math.round(-Math.cos(rad) * is.distance * scale);
    const dy = Math.round(Math.sin(rad) * is.distance * scale);
    const t = mk(w, h, space);
    t.ctx.drawImage(tinted(inv, w, h, is.color, space), dx, dy);
    t.ctx.globalCompositeOperation = "destination-in";
    t.ctx.drawImage(src, 0, 0); // confine to the shape
    t.ctx.globalCompositeOperation = "source-over";
    drawWith(t.c, is.blendMode, is.opacity);
  }
  const ig = fx.innerGlow;
  if (ig?.enabled) {
    const inv = new Float32Array(n);
    for (let i = 0; i < n; i++) inv[i] = 255 - alpha[i];
    gaussianChannel(inv, w, h, ig.size * scale);
    applySpread(inv, ig.spread);
    const t = mk(w, h, space);
    t.ctx.drawImage(tinted(inv, w, h, ig.color, space), 0, 0);
    t.ctx.globalCompositeOperation = "destination-in";
    t.ctx.drawImage(src, 0, 0);
    t.ctx.globalCompositeOperation = "source-over";
    drawWith(t.c, ig.blendMode, ig.opacity);
  }

  // ---- 7. bevel & emboss (emboss from the blurred-alpha height field) ----
  const bv = fx.bevel;
  if (bv?.enabled) {
    const hgt = blurred(alpha, w, h, Math.max(1, bv.size * scale));
    const rad = (bv.angle * Math.PI) / 180;
    const alt = (bv.altitude * Math.PI) / 180;
    const lx = Math.cos(rad) * Math.cos(alt);
    const ly = -Math.sin(rad) * Math.cos(alt);
    const k = (clamp(bv.depth, 0, 1000) / 100) * 2;
    const hi = new Float32Array(n);
    const sh = new Float32Array(n);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const gx = hgt[i + (x < w - 1 ? 1 : 0)] - hgt[i - (x > 0 ? 1 : 0)];
        const gy = hgt[i + (y < h - 1 ? w : 0)] - hgt[i - (y > 0 ? w : 0)];
        const d = ((gx * lx + gy * ly) / 255) * k;
        const cov = alpha[i] / 255;
        hi[i] = d > 0 ? clamp(d, 0, 1) * 255 * cov : 0;
        sh[i] = d < 0 ? clamp(-d, 0, 1) * 255 * cov : 0;
      }
    }
    if (bv.soften > 0) {
      gaussianChannel(hi, w, h, bv.soften * scale);
      gaussianChannel(sh, w, h, bv.soften * scale);
    }
    drawWith(tinted(hi, w, h, bv.highlightColor, space), bv.highlightMode, bv.highlightOpacity);
    drawWith(tinted(sh, w, h, bv.shadowColor, space), bv.shadowMode, bv.shadowOpacity);
  }

  // ---- 8. stroke (edge) ----
  const st = fx.stroke;
  if (st?.enabled && st.size > 0) {
    const s = st.size * scale;
    let ring: Float32Array;
    if (st.position === "outside") {
      const d = morph(alpha, w, h, s, true);
      ring = new Float32Array(n);
      for (let i = 0; i < n; i++) ring[i] = clamp(d[i] - alpha[i], 0, 255);
    } else if (st.position === "inside") {
      const e = morph(alpha, w, h, s, false);
      ring = new Float32Array(n);
      for (let i = 0; i < n; i++) ring[i] = clamp(alpha[i] - e[i], 0, 255);
    } else {
      const d = morph(alpha, w, h, s / 2, true);
      const e = morph(alpha, w, h, s / 2, false);
      ring = new Float32Array(n);
      for (let i = 0; i < n; i++) ring[i] = clamp(d[i] - e[i], 0, 255);
    }
    const ringMask = alphaMask(ring, w, h);
    const sbuf = mk(w, h, space);
    if (st.fillType === "gradient" && st.gradient && st.gradient.length) {
      const stops = st.reverse
        ? st.gradient.map((x) => ({ pos: 1 - x.pos, color: x.color }))
        : st.gradient;
      let from = { x: 0, y: 0 };
      let to = { x: w, y: h }; // legacy diagonal (no angle stored)
      if (typeof st.angle === "number") {
        // Same centred linear geometry as the gradient overlay.
        const rad = (st.angle * Math.PI) / 180;
        const half = Math.max(w, h) / 2;
        const cx = w / 2;
        const cy = h / 2;
        from = { x: cx - Math.cos(rad) * half, y: cy - Math.sin(rad) * half };
        to = { x: cx + Math.cos(rad) * half, y: cy + Math.sin(rad) * half };
      }
      sbuf.ctx.fillStyle = buildCanvasGradient(sbuf.ctx, "linear", from, to, 0.5, stops, true);
    } else {
      sbuf.ctx.fillStyle = st.color ?? "#ffffff";
    }
    sbuf.ctx.fillRect(0, 0, w, h);
    sbuf.ctx.globalCompositeOperation = "destination-in";
    sbuf.ctx.drawImage(ringMask, 0, 0);
    sbuf.ctx.globalCompositeOperation = "source-over";
    drawWith(sbuf.c, st.blendMode, st.opacity);
  }

  return { canvas: out.c, offset: { x: 0, y: 0 } };
}

/** True when any effect is enabled (compositor fast-path). */
export function hasEnabledFx(fx: LayerEffects | undefined): boolean {
  if (!fx) return false;
  return [fx.dropShadow, fx.innerShadow, fx.outerGlow, fx.innerGlow, fx.stroke, fx.colorOverlay, fx.gradientOverlay, fx.bevel].some(
    (e) => e?.enabled,
  );
}

/** Stable hash of the effect params (cache key). The tree is immutable, so the
 *  serialization is memoized per object — this runs every composite frame for
 *  every styled node and must not re-stringify each time. */
const fxHashMemo = new WeakMap<LayerEffects, string>();
export function fxHash(fx: LayerEffects | undefined): string {
  if (!fx) return "";
  let h = fxHashMemo.get(fx);
  if (h === undefined) {
    h = JSON.stringify(fx);
    fxHashMemo.set(fx, h);
  }
  return h;
}
