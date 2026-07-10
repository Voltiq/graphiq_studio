// LUT export: capture the app's colour adjustments as a 3D .cube LUT.
//
// The idea: build an identity colour lattice (every LUT grid colour as one
// pixel), run it through the SAME pixel math the compositor uses for
// adjustment layers (sliders / Curves / Levels / the extra kinds, honouring
// each layer's opacity and blend mode), and write the transformed lattice out
// as .cube rows. The result re-imports through the app's own Color Lookup
// adjustment — and into any other software that reads .cube.
//
// What cannot travel into a LUT (the collector reports these as notes):
// spatial slider ops (sharpen / noise — kernel-based), Equalize (whole-image
// histogram), layer masks and clipping (a LUT is global by definition), and
// adjustments nested inside groups (they only act on their group).

import { applyAdjustments, type AdjustmentSpec, type Adjustments } from "./adjust";
import { applyExtraAdjustment, isExtraSpec } from "./adjust-extra";
import { blendOp, type LayerNode } from "./layers";
import { applyToneLUTs, buildCurvesLUTs, buildLevelsLUTs } from "./tone";

/** One captured colour operation: an adjustment spec at a layer's opacity/blend. */
export interface LutOp {
  spec: AdjustmentSpec;
  /** Layer opacity 0..100. */
  opacity: number;
  /** App blend-mode name ("Normal", "Multiply", …). */
  blend: string;
}

export const LUT_SIZES = [17, 33, 65] as const;

/** The identity lattice as RGBA bytes: n³ pixels, red index fastest — the same
 *  linear order .cube rows use, so readback IS the table. 8-bit quantized,
 *  faithfully matching the app's own pixel pipeline. */
export function latticeBytes(n: number): Uint8ClampedArray {
  const d = new Uint8ClampedArray(n * n * n * 4);
  let i = 0;
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        d[i++] = Math.round((x / (n - 1)) * 255);
        d[i++] = Math.round((y / (n - 1)) * 255);
        d[i++] = Math.round((z / (n - 1)) * 255);
        d[i++] = 255;
      }
  return d;
}

/** The adjusted pixels for one spec (pure math — the compositor's functions).
 *  Sliders capture with the spatial tail (sharpen/noise) zeroed: kernels can't
 *  exist in a colour LUT, and on a lattice they'd corrupt neighbours. */
function adjustedFor(spec: AdjustmentSpec, src: ImageData): ImageData | null {
  if (spec.type === "sliders")
    return applyAdjustments(src, { ...spec.params, sharpen: 0, noise: 0 });
  if (spec.type === "levels") return applyToneLUTs(src, buildLevelsLUTs(spec));
  if (spec.type === "curves") return applyToneLUTs(src, buildCurvesLUTs(spec));
  if (isExtraSpec(spec) && spec.type !== "equalize") return applyExtraAdjustment(src, spec);
  return null; // equalize — image-dependent, the collectors never emit it
}

/**
 * Apply one op to the lattice bytes in place. Normal @ 100% is pure math; an
 * opacity/blend modulation runs through a canvas — the browser's own blend
 * implementation, which is exactly what the compositor uses (gco). Both
 * buffers are fully opaque, so the composite equals the engine's
 * tmp ⊗ opacity → blend draw on an opaque accumulator.
 */
export function applyLutOp(d: Uint8ClampedArray, w: number, h: number, op: LutOp): void {
  const src = new ImageData(new Uint8ClampedArray(d), w, h);
  const adjusted = adjustedFor(op.spec, src);
  if (!adjusted) return;
  const opacity = Math.max(0, Math.min(1, op.opacity / 100));
  if (opacity <= 0) return;
  const gco = blendOp(op.blend);
  if (opacity >= 1 && gco === "source-over") {
    d.set(adjusted.data);
    return;
  }
  const base = document.createElement("canvas");
  base.width = w;
  base.height = h;
  const ctx = base.getContext("2d", { willReadFrequently: true });
  if (!ctx) {
    d.set(adjusted.data); // canvas unavailable — fall back to the full effect
    return;
  }
  ctx.putImageData(new ImageData(new Uint8ClampedArray(d), w, h), 0, 0);
  const top = document.createElement("canvas");
  top.width = w;
  top.height = h;
  const tctx = top.getContext("2d");
  if (!tctx) {
    d.set(adjusted.data);
    return;
  }
  tctx.putImageData(adjusted, 0, 0);
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = gco;
  ctx.drawImage(top, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
  d.set(ctx.getImageData(0, 0, w, h).data);
}

/** Run the ops (bottom→top) over an identity lattice; returns the RGBA table. */
export function captureLut(ops: LutOp[], n: number): Uint8ClampedArray {
  const d = latticeBytes(n);
  const w = n * n; // lattice laid out n²×n so canvases stay within size limits
  const h = n;
  for (const op of ops) applyLutOp(d, w, h, op);
  return d;
}

/** Serialize a captured lattice to .cube text (red index fastest — the order
 *  latticeBytes generated, so rows read straight off the buffer). */
export function cubeText(d: Uint8ClampedArray, n: number, title: string): string {
  const f = (v: number) => (v / 255).toFixed(6);
  const head = `TITLE "${title.replace(/"/g, "'").trim() || "Graphiq LUT"}"\nLUT_3D_SIZE ${n}\n`;
  const rows = new Array<string>(n * n * n);
  for (let k = 0, i = 0; k < rows.length; k++, i += 4) rows[k] = `${f(d[i])} ${f(d[i + 1])} ${f(d[i + 2])}`;
  return head + rows.join("\n") + "\n";
}

export interface LutCollectResult {
  ops: LutOp[];
  /** What could NOT travel into the LUT (shown in the export dialog). */
  notes: string[];
}

const hasAdjustmentInside = (n: LayerNode): boolean =>
  n.type === "adjustment" ||
  (n.type === "group" && n.children.some(hasAdjustmentInside));

/** Collect the document's capturable adjustment layers, bottom→top (the order
 *  they act in the composite). */
export function collectLayerLutOps(nodes: LayerNode[]): LutCollectResult {
  const ops: LutOp[] = [];
  const notes: string[] = [];
  for (let i = nodes.length - 1; i >= 0; i--) {
    const nd = nodes[i];
    if (nd.type === "group") {
      if (nd.visible && nd.children.some(hasAdjustmentInside))
        notes.push(`"${nd.name}": adjustments inside a group act on that group only — skipped.`);
      continue;
    }
    if (nd.type !== "adjustment" || !nd.visible) continue;
    if (nd.clipped) {
      notes.push(`"${nd.name}": clipped to the layer below — skipped (a LUT is global).`);
      continue;
    }
    if (nd.adjustment.type === "equalize") {
      notes.push(`"${nd.name}": Equalize depends on the image's histogram — skipped.`);
      continue;
    }
    if (nd.mask?.enabled) notes.push(`"${nd.name}": its layer mask is ignored (a LUT applies everywhere).`);
    if (nd.adjustment.type === "sliders" && (nd.adjustment.params.sharpen > 0 || nd.adjustment.params.noise > 0))
      notes.push(`"${nd.name}": sharpen/noise are spatial ops — not captured.`);
    ops.push({ spec: nd.adjustment, opacity: nd.opacity, blend: nd.blend });
  }
  return { ops, notes };
}

/** The Adjustments panel's current sliders as capturable ops. */
export function sliderLutOps(params: Adjustments): LutCollectResult {
  const notes: string[] = [];
  if (params.sharpen > 0 || params.noise > 0)
    notes.push("Sharpen/noise are spatial ops — not captured in the LUT.");
  return {
    ops: [{ spec: { type: "sliders", params }, opacity: 100, blend: "Normal" }],
    notes,
  };
}
