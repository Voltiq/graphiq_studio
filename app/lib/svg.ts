// SVG import (as vector shape layers) + SVG export of vector/text layers.
//
// IMPORT strategy: parse with the browser's own SVG machinery — DOMParser plus
// a hidden live mount (inside a closed shadow root, so the file's <style> can't
// leak into the app), so getScreenCTM resolves every transform/viewBox nesting
// and getComputedStyle resolves the full CSS cascade. Graphic elements walk
// into styled path recipes (VectorPath); the layer's PIXELS are rendered from
// the RECIPE, so pixels and recipe can never disagree. Files that use features
// the recipe can't hold (text, gradients/patterns, filters, masks, clip-paths,
// markers, <use>, translucent groups over two paints…) import as plain raster
// instead — faithful pixels, no pretending they're editable vectors.
//
// EXPORT walks the layer tree bottom→top and serializes every vector-bearing
// layer: imported vector graphics as <path> elements, shape layers through the
// SAME ring geometry renderShape rasterizes (shapes.ts helpers), and text
// layers through the same line layout renderText uses (measured on a canvas).

import { clamp, parseColor, toHex8 } from "./color";
import type { LayerNode } from "./layers";
import {
  baseRunStyle,
  cssFontString,
  effectiveWeight,
  fontFeatureCSS,
  layoutRuns,
  stretchKeyword,
} from "./richtext";
import { insetPoly, polyInradius, trapPoints, triPoints } from "./shapes";
import type {
  VectorData,
  VectorPath,
  VectorPathElement,
  VectorShape,
  VectorText,
} from "./tools";

/** Is this file an SVG (by MIME type or extension)? */
export function looksLikeSVG(file: File): boolean {
  return file.type === "image/svg+xml" || /\.svg$/i.test(file.name);
}

/** Format a coordinate for path data / attributes (≤3 decimals, no junk). */
const f = (n: number): string => String(Math.round(n * 1000) / 1000);

// ---------------------------------------------------------------------------
// Pure geometry → SVG path data (used by import conversion AND export).
// ---------------------------------------------------------------------------

/** A (possibly rounded) rectangle as path data. */
export function rectPathD(x: number, y: number, w: number, h: number, rx: number, ry: number): string {
  rx = Math.max(0, Math.min(rx, w / 2));
  ry = Math.max(0, Math.min(ry, h / 2));
  if (rx <= 0 || ry <= 0) return `M${f(x)} ${f(y)}H${f(x + w)}V${f(y + h)}H${f(x)}Z`;
  return (
    `M${f(x + rx)} ${f(y)}` +
    `H${f(x + w - rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w)} ${f(y + ry)}` +
    `V${f(y + h - ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + w - rx)} ${f(y + h)}` +
    `H${f(x + rx)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x)} ${f(y + h - ry)}` +
    `V${f(y + ry)}A${f(rx)} ${f(ry)} 0 0 1 ${f(x + rx)} ${f(y)}Z`
  );
}

/** An ellipse (or circle) as two-arc path data. */
export function ellipsePathD(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M${f(cx - rx)} ${f(cy)}` +
    `A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}` +
    `A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}Z`
  );
}

export function linePathD(x1: number, y1: number, x2: number, y2: number): string {
  return `M${f(x1)} ${f(y1)}L${f(x2)} ${f(y2)}`;
}

export function polyPathD(pts: { x: number; y: number }[], close: boolean): string {
  if (!pts.length) return "";
  let d = `M${f(pts[0].x)} ${f(pts[0].y)}`;
  for (let i = 1; i < pts.length; i++) d += `L${f(pts[i].x)} ${f(pts[i].y)}`;
  return close ? d + "Z" : d;
}

/** A polygon with arcTo-rounded corners as path data — mirrors shapes.ts
 *  roundedPolyInto exactly (starts mid-edge; radius 0 = sharp). */
export function roundedPolyD(pts: { x: number; y: number }[], radius: number): string {
  const n = pts.length;
  if (radius <= 0.01) return polyPathD(pts, true);
  const start = { x: (pts[n - 1].x + pts[0].x) / 2, y: (pts[n - 1].y + pts[0].y) / 2 };
  let d = `M${f(start.x)} ${f(start.y)}`;
  let cur = start;
  for (let i = 0; i < n; i++) {
    const c = pts[i];
    const next = i === n - 1 ? start : pts[i + 1];
    // arcTo(c, next, r): tangent points sit t = r / tan(θ/2) from the corner
    // along each edge; the join is a circular arc of radius r between them.
    const v1x = cur.x - c.x;
    const v1y = cur.y - c.y;
    const v2x = next.x - c.x;
    const v2y = next.y - c.y;
    const l1 = Math.hypot(v1x, v1y);
    const l2 = Math.hypot(v2x, v2y);
    if (l1 < 1e-6 || l2 < 1e-6) continue;
    const cos = clamp((v1x * v2x + v1y * v2y) / (l1 * l2), -1, 1);
    const theta = Math.acos(cos);
    if (theta > Math.PI - 1e-4) {
      // Straight through the "corner" — no arc.
      d += `L${f(c.x)} ${f(c.y)}`;
      cur = c;
      continue;
    }
    const t = Math.min(radius / Math.tan(theta / 2), l1, l2);
    const p1 = { x: c.x + (v1x / l1) * t, y: c.y + (v1y / l1) * t };
    const p2 = { x: c.x + (v2x / l2) * t, y: c.y + (v2y / l2) * t };
    // Sweep flag from the turn direction (cross product of in→corner→out).
    const cross = v1x * v2y - v1y * v2x;
    const sweep = cross < 0 ? 1 : 0;
    const r = t * Math.tan(theta / 2); // = radius unless t was clamped by an edge
    d += `L${f(p1.x)} ${f(p1.y)}A${f(r)} ${f(r)} 0 0 ${sweep} ${f(p2.x)} ${f(p2.y)}`;
    cur = p2;
  }
  return d + "Z";
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export interface SVGImportResult {
  /** Intrinsic pixel size the SVG rasterizes at. */
  width: number;
  height: number;
  /** The pixels to place (recipe-rendered when `vector` is set). */
  bitmap: ImageBitmap;
  /** The re-renderable recipe, or null when the file needs features beyond it
   *  (then `bitmap` is the browser's own faithful rasterization). */
  vector: VectorPath | null;
}

/** Computed paint ("rgb(…)", "#…", "none", "color(srgb …)") → #rrggbbaa ("" = none). */
export function paintToHex8(raw: string, alpha: number): string {
  const s = (raw || "").trim();
  if (!s || s === "none" || s === "transparent") return "";
  let c;
  if (s.startsWith("#") || /^rgba?\(/i.test(s)) {
    c = parseColor(s);
  } else {
    const m = s.match(/^color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)$/i);
    if (!m) return ""; // url(#…) or exotic spaces — caller already marked the file inexact
    c = { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] };
  }
  const a = clamp(c.a * alpha, 0, 1);
  return a <= 0 ? "" : toHex8({ ...c, a });
}

const GRAPHIC_TAGS = new Set(["path", "rect", "circle", "ellipse", "line", "polyline", "polygon"]);
const CONTAINER_TAGS = new Set(["svg", "g", "a", "switch"]);
/** Renders content the recipe can't hold → the whole file falls back to raster. */
const INEXACT_TAGS = new Set(["use", "text", "tspan", "textpath", "image", "foreignobject"]);

/** Convert a mounted graphic element's geometry to path data (element units). */
function elementPathD(el: Element, tag: string): string | null {
  switch (tag) {
    case "path":
      return el.getAttribute("d") || null;
    case "rect": {
      const r = el as SVGRectElement;
      const w = r.width.baseVal.value;
      const h = r.height.baseVal.value;
      if (w <= 0 || h <= 0) return null;
      let rx = r.rx.baseVal.value;
      let ry = r.ry.baseVal.value;
      // Auto radii: a missing rx borrows ry and vice versa (SVG semantics).
      if (!r.hasAttribute("rx") && r.hasAttribute("ry")) rx = ry;
      else if (!r.hasAttribute("ry") && r.hasAttribute("rx")) ry = rx;
      return rectPathD(r.x.baseVal.value, r.y.baseVal.value, w, h, rx, ry);
    }
    case "circle": {
      const c = el as SVGCircleElement;
      const r = c.r.baseVal.value;
      return r > 0 ? ellipsePathD(c.cx.baseVal.value, c.cy.baseVal.value, r, r) : null;
    }
    case "ellipse": {
      const e = el as SVGEllipseElement;
      const rx = e.rx.baseVal.value;
      const ry = e.ry.baseVal.value;
      return rx > 0 && ry > 0 ? ellipsePathD(e.cx.baseVal.value, e.cy.baseVal.value, rx, ry) : null;
    }
    case "line": {
      const l = el as SVGLineElement;
      return linePathD(l.x1.baseVal.value, l.y1.baseVal.value, l.x2.baseVal.value, l.y2.baseVal.value);
    }
    case "polyline":
    case "polygon": {
      const pts = (el as SVGPolygonElement).points;
      if (pts.numberOfItems < 2) return null;
      const arr: { x: number; y: number }[] = [];
      for (let i = 0; i < pts.numberOfItems; i++) {
        const p = pts.getItem(i);
        arr.push({ x: p.x, y: p.y });
      }
      return polyPathD(arr, tag === "polygon");
    }
  }
  return null;
}

/** Intrinsic pixel size from width/height attributes (px), else the viewBox,
 *  else the CSS default 300×150 — mirroring how browsers size an SVG image. */
function intrinsicSize(root: Element): { w: number; h: number } | null {
  const dim = (attr: string): number | null => {
    const v = root.getAttribute(attr);
    if (!v) return null;
    const m = v.trim().match(/^([0-9.]+)(px)?$/i);
    return m ? parseFloat(m[1]) : null; // %, pt, em… → defer to the viewBox
  };
  let w = dim("width");
  let h = dim("height");
  const vb = (root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
  const vbW = vb.length === 4 && vb[2] > 0 ? vb[2] : null;
  const vbH = vb.length === 4 && vb[3] > 0 ? vb[3] : null;
  if (w == null && h != null && vbW && vbH) w = (h * vbW) / vbH;
  if (h == null && w != null && vbW && vbH) h = (w * vbH) / vbW;
  if (w == null || h == null) {
    w = vbW ?? 300;
    h = vbH ?? 150;
  }
  w = Math.round(w);
  h = Math.round(h);
  if (!(w > 0 && h > 0)) return null;
  return { w: Math.min(w, 16384), h: Math.min(h, 16384) };
}

interface WalkResult {
  paths: VectorPathElement[];
  exact: boolean;
  bbox: { x0: number; y0: number; x1: number; y1: number } | null;
}

/** Walk the mounted SVG into styled path recipes, tracking whether the file is
 *  fully representable (`exact`) and the doc-space bounds of what was captured. */
function walkSVG(svg: SVGSVGElement): WalkResult {
  const out: WalkResult = { paths: [], exact: true, bbox: null };
  const rootCTM = svg.getScreenCTM();
  if (!rootCTM) return { ...out, exact: false };
  const rootInv = rootCTM.inverse();
  const prop = (cs: CSSStyleDeclaration, name: string) => cs.getPropertyValue(name).trim();

  const visit = (el: Element, ancestorOpacity: number) => {
    const tag = el.tagName.toLowerCase();
    if (INEXACT_TAGS.has(tag)) {
      out.exact = false;
      return;
    }
    if (!GRAPHIC_TAGS.has(tag) && !CONTAINER_TAGS.has(tag)) return; // defs/metadata/… never render
    const cs = getComputedStyle(el);
    if (cs.display === "none") return;

    if (CONTAINER_TAGS.has(tag)) {
      const op = clamp(parseFloat(cs.opacity || "1"), 0, 1);
      // A translucent container blends its children as one isolated group —
      // per-element opacity baking would show overlaps through each other.
      if (op < 0.999 && el.children.length > 1) out.exact = false;
      for (const child of Array.from(el.children)) visit(child, ancestorOpacity * op);
      return;
    }

    // Graphic element.
    if (cs.visibility === "hidden" || cs.visibility === "collapse") return;
    for (const name of ["clip-path", "mask", "filter", "marker-start", "marker-mid", "marker-end"]) {
      const v = prop(cs, name);
      if (v && v !== "none") out.exact = false;
    }
    const d = elementPathD(el, tag);
    if (!d) return;
    const fillRaw = prop(cs, "fill") || "none";
    const strokeRaw = prop(cs, "stroke") || "none";
    if (fillRaw.includes("url(") || strokeRaw.includes("url(")) out.exact = false;
    const ownOp = clamp(parseFloat(cs.opacity || "1"), 0, 1) * ancestorOpacity;
    const fill = paintToHex8(fillRaw, clamp(parseFloat(prop(cs, "fill-opacity") || "1"), 0, 1) * ownOp);
    const strokeW = parseFloat(prop(cs, "stroke-width") || "1") || 0;
    const stroke =
      strokeW > 0
        ? paintToHex8(strokeRaw, clamp(parseFloat(prop(cs, "stroke-opacity") || "1"), 0, 1) * ownOp)
        : "";
    if (!fill && !stroke) return; // paints nothing
    // Element opacity applies to fill+stroke as one isolated unit; baking it
    // into each paint diverges where the stroke overlaps the fill.
    if (ownOp < 0.999 && fill && stroke) out.exact = false;

    const ctm = (el as SVGGraphicsElement).getScreenCTM();
    const m = ctm ? rootInv.multiply(ctm) : new DOMMatrix();
    const dashRaw = prop(cs, "stroke-dasharray");
    const dash =
      dashRaw && dashRaw !== "none"
        ? dashRaw
            .split(/[\s,]+/)
            .map((s) => parseFloat(s))
            .filter((n) => Number.isFinite(n) && n >= 0)
        : [];
    const capRaw = prop(cs, "stroke-linecap");
    const joinRaw = prop(cs, "stroke-linejoin");
    out.paths.push({
      d,
      matrix: [m.a, m.b, m.c, m.d, m.e, m.f],
      fill,
      fillRule: prop(cs, "fill-rule") === "evenodd" ? "evenodd" : "nonzero",
      stroke,
      strokeWidth: stroke ? strokeW : 0,
      cap: capRaw === "round" || capRaw === "square" ? capRaw : "butt",
      join: joinRaw === "round" || joinRaw === "bevel" ? joinRaw : "miter",
      miter: parseFloat(prop(cs, "stroke-miterlimit") || "4") || 4,
      dash,
    });
    // Doc-space bounds: the fill box's corners through the matrix, padded by
    // the stroke's transformed half-width.
    try {
      const bb = (el as SVGGraphicsElement).getBBox();
      const pad = (stroke ? strokeW / 2 : 0) * Math.max(Math.hypot(m.a, m.b), Math.hypot(m.c, m.d));
      for (const [px, py] of [
        [bb.x, bb.y],
        [bb.x + bb.width, bb.y],
        [bb.x, bb.y + bb.height],
        [bb.x + bb.width, bb.y + bb.height],
      ]) {
        const x = m.a * px + m.c * py + m.e;
        const y = m.b * px + m.d * py + m.f;
        if (!out.bbox) out.bbox = { x0: x - pad, y0: y - pad, x1: x + pad, y1: y + pad };
        else {
          out.bbox.x0 = Math.min(out.bbox.x0, x - pad);
          out.bbox.y0 = Math.min(out.bbox.y0, y - pad);
          out.bbox.x1 = Math.max(out.bbox.x1, x + pad);
          out.bbox.y1 = Math.max(out.bbox.y1, y + pad);
        }
      }
    } catch {
      /* getBBox can throw on degenerate geometry — bounds stay best-effort */
    }
  };

  for (const child of Array.from(svg.children)) visit(child, 1);
  return out;
}

/** Rasterize the whole SVG through the browser (<img> decode) — the faithful
 *  fallback for files beyond the recipe subset. */
function rasterizeWholeSVG(svg: SVGSVGElement, w: number, h: number): Promise<ImageBitmap | null> {
  return new Promise((resolve) => {
    let xml: string;
    try {
      xml = new XMLSerializer().serializeToString(svg);
    } catch {
      resolve(null);
      return;
    }
    const url = URL.createObjectURL(new Blob([xml], { type: "image/svg+xml" }));
    const img = new Image();
    const done = (bmp: ImageBitmap | null) => {
      URL.revokeObjectURL(url);
      resolve(bmp);
    };
    img.onload = () => {
      try {
        const c = document.createElement("canvas");
        c.width = w;
        c.height = h;
        const ctx = c.getContext("2d");
        if (!ctx) {
          done(null);
          return;
        }
        ctx.drawImage(img, 0, 0, w, h);
        createImageBitmap(c).then(done, () => done(null));
      } catch {
        done(null);
      }
    };
    img.onerror = () => done(null);
    img.src = url;
  });
}

/**
 * Parse an SVG file for import. Returns the intrinsic size, the pixels to
 * place, and — when the file stays inside the path/shape subset — the
 * re-renderable VectorPath recipe (then the pixels ARE the recipe, rendered).
 * Null = not a usable SVG.
 */
export async function parseSVGFile(file: File): Promise<SVGImportResult | null> {
  let doc: Document;
  try {
    doc = new DOMParser().parseFromString(await file.text(), "image/svg+xml");
  } catch {
    return null;
  }
  const root = doc.documentElement;
  if (!root || root.nodeName.toLowerCase() !== "svg" || doc.querySelector("parsererror")) return null;
  const size = intrinsicSize(root);
  if (!size) return null;
  const { w, h } = size;

  // Live mount inside a CLOSED shadow root: the browser resolves transforms and
  // the file's own CSS, and the file's <style> rules can't reach the app.
  const svg = document.importNode(root, true) as unknown as SVGSVGElement;
  svg.setAttribute("width", String(w));
  svg.setAttribute("height", String(h));
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.style.cssText = "position:fixed;left:-100000px;top:0;pointer-events:none;";
  const shadow = host.attachShadow({ mode: "closed" });
  shadow.appendChild(svg);
  document.body.appendChild(host);
  let walked: WalkResult;
  try {
    walked = walkSVG(svg);
  } finally {
    host.remove();
  }

  let vector: VectorPath | null = null;
  if (walked.exact && walked.paths.length) {
    const bb = walked.bbox;
    const x0 = clamp(bb ? bb.x0 : 0, 0, w);
    const y0 = clamp(bb ? bb.y0 : 0, 0, h);
    const x1 = clamp(bb ? bb.x1 : w, 0, w);
    const y1 = clamp(bb ? bb.y1 : h, 0, h);
    vector = {
      type: "path",
      paths: walked.paths,
      bbox: { x: x0, y: y0, w: Math.max(1, x1 - x0), h: Math.max(1, y1 - y0) },
    };
  }

  let bitmap: ImageBitmap | null = null;
  try {
    if (vector) bitmap = await createImageBitmap(renderVectorPath(vector, w, h));
    else bitmap = await rasterizeWholeSVG(svg, w, h);
  } catch {
    bitmap = null;
  }
  if (!bitmap) return null;
  return { width: w, height: h, bitmap, vector };
}

// ---------------------------------------------------------------------------
// Recipe rendering + placement
// ---------------------------------------------------------------------------

/** Draw a VectorPath recipe into a context (document coordinates). */
export function drawVectorPath(ctx: CanvasRenderingContext2D, vec: VectorPath) {
  ctx.save();
  for (const p of vec.paths) {
    let path: Path2D;
    try {
      path = new Path2D(p.d);
    } catch {
      continue;
    }
    ctx.setTransform(p.matrix[0], p.matrix[1], p.matrix[2], p.matrix[3], p.matrix[4], p.matrix[5]);
    if (p.fill) {
      ctx.fillStyle = p.fill;
      ctx.fill(path, p.fillRule);
    }
    if (p.stroke && p.strokeWidth > 0) {
      ctx.strokeStyle = p.stroke;
      ctx.lineWidth = p.strokeWidth;
      ctx.lineCap = p.cap;
      ctx.lineJoin = p.join;
      ctx.miterLimit = p.miter;
      ctx.setLineDash(p.dash);
      ctx.stroke(path);
      ctx.setLineDash([]);
    }
  }
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.restore();
}

/** Rasterize a VectorPath recipe onto a fresh w×h canvas. */
export function renderVectorPath(vec: VectorPath, w: number, h: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  drawVectorPath(c.getContext("2d")!, vec);
  return c;
}

/** Shift a recipe in document space (import placement folds into the matrices). */
export function translateVectorPath(vec: VectorPath, dx: number, dy: number): VectorPath {
  if (!dx && !dy) return vec;
  return {
    ...vec,
    paths: vec.paths.map((p) => ({
      ...p,
      matrix: [p.matrix[0], p.matrix[1], p.matrix[2], p.matrix[3], p.matrix[4] + dx, p.matrix[5] + dy] as VectorPathElement["matrix"],
    })),
    bbox: { ...vec.bbox, x: vec.bbox.x + dx, y: vec.bbox.y + dy },
  };
}

// ---------------------------------------------------------------------------
// Export (vector/text layers → SVG document)
// ---------------------------------------------------------------------------

export interface SVGExportResult {
  svg: string;
  /** Vector-bearing layers serialized. */
  vectorLayers: number;
  /** Visible layers that could NOT be exported (raster pixels, adjustments). */
  skipped: number;
}

const XML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
const escapeXml = (s: string): string => s.replace(/[&<>"']/g, (c) => XML_ESCAPES[c]);

/** App blend name → CSS mix-blend-mode ("" = normal / unsupported). */
const CSS_BLEND: Record<string, string> = {
  Darken: "darken",
  Multiply: "multiply",
  "Color Burn": "color-burn",
  "Linear Burn": "multiply", // rasterizer maps it to multiply too
  Lighten: "lighten",
  Screen: "screen",
  "Color Dodge": "color-dodge",
  Add: "plus-lighter",
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

/** #rrggbb(aa)? → { color, opacity } attribute pair (SVG 1.1-safe). */
function splitPaint(hex: string): { color: string; opacity: number } | null {
  if (!hex) return null;
  const c = parseColor(hex);
  return { color: `#${[c.r, c.g, c.b].map((v) => clamp(Math.round(v), 0, 255).toString(16).padStart(2, "0")).join("")}`, opacity: c.a };
}

/** Shared node attributes: name, layer opacity, blend. */
function layerAttrs(name: string, opacity: number, blend: string): string {
  let s = ` data-name="${escapeXml(name)}"`;
  if (opacity < 100) s += ` opacity="${f(clamp(opacity, 0, 100) / 100)}"`;
  const css = CSS_BLEND[blend];
  if (css) s += ` style="mix-blend-mode:${css}"`;
  return s;
}

/** One imported vector graphic → <path> elements. */
function emitVectorPaths(v: VectorPath, indent: string): string {
  let out = "";
  for (const p of v.paths) {
    const fill = splitPaint(p.fill);
    const stroke = splitPaint(p.stroke);
    let attrs = ` d="${escapeXml(p.d)}"`;
    const [a, b, c, d2, e, ff] = p.matrix;
    if (a !== 1 || b !== 0 || c !== 0 || d2 !== 1 || e !== 0 || ff !== 0)
      attrs += ` transform="matrix(${f(a)} ${f(b)} ${f(c)} ${f(d2)} ${f(e)} ${f(ff)})"`;
    attrs += fill ? ` fill="${fill.color}"` : ` fill="none"`;
    if (fill && fill.opacity < 1) attrs += ` fill-opacity="${f(fill.opacity)}"`;
    if (p.fillRule === "evenodd") attrs += ` fill-rule="evenodd"`;
    if (stroke && p.strokeWidth > 0) {
      attrs += ` stroke="${stroke.color}" stroke-width="${f(p.strokeWidth)}"`;
      if (stroke.opacity < 1) attrs += ` stroke-opacity="${f(stroke.opacity)}"`;
      if (p.cap !== "butt") attrs += ` stroke-linecap="${p.cap}"`;
      if (p.join !== "miter") attrs += ` stroke-linejoin="${p.join}"`;
      if (p.join === "miter" && p.miter !== 4) attrs += ` stroke-miterlimit="${f(p.miter)}"`;
      if (p.dash.length) attrs += ` stroke-dasharray="${p.dash.map(f).join(" ")}"`;
    }
    out += `${indent}<path${attrs}/>\n`;
  }
  return out;
}

/** Fill/ring paths for a shape layer — the SAME geometry renderShape paints
 *  (outer outline + interior inset by the stroke, stroke = the ring between). */
function shapeOuterInner(v: VectorShape): { outer: string; inner: string | null; innerFillable: boolean } {
  const box = { x: v.x, y: v.y, w: v.w, h: v.h };
  const sw = Math.max(0, v.strokeWidth);
  const hasStroke = sw > 0 && !!v.stroke;
  if (v.shape === "rect") {
    const r = Math.max(0, Math.min(v.radius, Math.min(box.w, box.h) / 2));
    const outer = rectPathD(box.x, box.y, box.w, box.h, r, r);
    if (!hasStroke) return { outer, inner: null, innerFillable: false };
    const iw = box.w - 2 * sw;
    const ih = box.h - 2 * sw;
    if (iw <= 0 || ih <= 0) return { outer, inner: null, innerFillable: false };
    const ir = Math.max(0, r - sw);
    return { outer, inner: rectPathD(box.x + sw, box.y + sw, iw, ih, ir, ir), innerFillable: true };
  }
  // Triangle / trapezoid — corner rounding via the same arcTo construction.
  const pts = v.shape === "tri" ? triPoints(box, v.apex) : trapPoints(box, v.trap ?? { l: 0.25, r: 0.25 });
  const r = Math.max(0, Math.min(v.radius, polyInradius(pts)));
  const outer = roundedPolyD(pts, r);
  if (!hasStroke) return { outer, inner: null, innerFillable: false };
  const inner = sw < polyInradius(pts) ? insetPoly(pts, sw) : null;
  if (!inner) return { outer, inner: null, innerFillable: false };
  const ir = Math.max(0, Math.min(r - sw, polyInradius(inner)));
  return { outer, inner: roundedPolyD(inner, ir), innerFillable: true };
}

/** One shape layer → SVG elements matching the rasterized pixels. */
function emitShape(v: VectorShape, indent: string): string {
  const sw = Math.max(0, v.strokeWidth);
  const hasStroke = sw > 0 && !!v.stroke;
  const fill = splitPaint(v.fill);
  const stroke = splitPaint(v.stroke);
  const rotate = v.angle
    ? ` transform="rotate(${f((v.angle * 180) / Math.PI)} ${f(v.x + v.w / 2)} ${f(v.y + v.h / 2)})"`
    : "";
  const paint = (p: { color: string; opacity: number } | null, rule?: "evenodd") =>
    p
      ? ` fill="${p.color}"${p.opacity < 1 ? ` fill-opacity="${f(p.opacity)}"` : ""}${rule ? ` fill-rule="${rule}"` : ""}`
      : ` fill="none"`;

  if (v.shape === "ellipse") {
    // renderShape strokes the ellipse on a centre line inset by sw/2 — exactly
    // SVG's native centred stroke.
    const inset = sw / 2;
    const rx = Math.max(0, (v.w - sw) / 2);
    const ry = Math.max(0, (v.h - sw) / 2);
    let attrs = ` cx="${f(v.x + inset + rx)}" cy="${f(v.y + inset + ry)}" rx="${f(rx)}" ry="${f(ry)}"`;
    attrs += paint(fill);
    if (hasStroke && stroke)
      attrs += ` stroke="${stroke.color}" stroke-width="${f(sw)}"${stroke.opacity < 1 ? ` stroke-opacity="${f(stroke.opacity)}"` : ""}`;
    return `${indent}<ellipse${attrs}${rotate}/>\n`;
  }

  const { outer, inner, innerFillable } = shapeOuterInner(v);
  let out = "";
  if (hasStroke && stroke) {
    if (innerFillable && inner) {
      // Stroke ring (outer minus inner), then the interior fill — same order
      // and coverage as renderShape (no fill hiding under the stroke).
      out += `${indent}<path d="${outer} ${inner}"${paint(stroke, "evenodd")}${rotate}/>\n`;
      if (fill) out += `${indent}<path d="${inner}"${paint(fill)}${rotate}/>\n`;
    } else {
      // Stroke thicker than the shape — one solid outline in the stroke colour.
      out += `${indent}<path d="${outer}"${paint(stroke)}${rotate}/>\n`;
    }
  } else if (fill) {
    out += `${indent}<path d="${outer}"${paint(fill)}${rotate}/>\n`;
  }
  return out;
}

// Text layout mirror (same math as PaintEngine.textLines/renderText).
let measureCtx: CanvasRenderingContext2D | null = null;
let measureHost: HTMLDivElement | null = null;

function ensureMeasureCtx(): CanvasRenderingContext2D | null {
  if (!measureCtx) {
    const c = document.createElement("canvas");
    c.width = c.height = 8;
    measureCtx = c.getContext("2d");
  }
  return measureCtx;
}

/** Measure with the block's OpenType features active: canvas honours
 *  font-feature-settings only while the canvas is CONNECTED, so the measure
 *  canvas mounts into a hidden host for the call (default features skip it),
 *  keeping export layout identical to the raster's. */
function withMeasureFeatures<T>(features: VectorText["features"], fn: () => T): T {
  const css = fontFeatureCSS(features);
  const canvas = ensureMeasureCtx()?.canvas;
  if (!css || !canvas) return fn();
  if (!measureHost) {
    measureHost = document.createElement("div");
    measureHost.style.display = "none";
    document.body.appendChild(measureHost);
  }
  canvas.style.fontFeatureSettings = css;
  measureHost.appendChild(canvas);
  try {
    return fn();
  } finally {
    measureHost.removeChild(canvas);
    canvas.style.fontFeatureSettings = "";
  }
}

function textLayout(v: VectorText): { lines: { text: string; x: number; y: number }[]; anchor: string } | null {
  const ctx = ensureMeasureCtx();
  if (!ctx) return null;
  ctx.font = cssFontString(v, v.axes);
  const ls = ctx as CanvasRenderingContext2D & { letterSpacing: string };
  if ("letterSpacing" in ctx) ls.letterSpacing = `${v.tracking}px`;
  const wrap = (para: string, maxW: number): string[] => {
    const out: string[] = [];
    let cur = "";
    for (const word of para.split(" ")) {
      const test = cur ? `${cur} ${word}` : word;
      if (!cur || ctx.measureText(test).width <= maxW) cur = test;
      else {
        out.push(cur);
        cur = word;
      }
    }
    out.push(cur);
    return out;
  };
  const paras = v.text.split("\n");
  const lines = v.boxW != null ? paras.flatMap((p) => wrap(p, v.boxW!)) : paras;
  const m = ctx.measureText("Mg");
  const ascent = m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || v.fontSize * 0.8;
  const descent = m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || v.fontSize * 0.2;
  const leading = v.fontSize * v.lineHeight;
  const baseline0 = v.y + (leading - (ascent + descent)) / 2 + ascent;
  const anchorX =
    v.boxW == null
      ? v.x
      : v.align === "left"
        ? v.x
        : v.align === "right"
          ? v.x + v.boxW
          : v.x + v.boxW / 2;
  return {
    lines: lines.map((text, i) => ({ text, x: anchorX, y: baseline0 + i * leading })),
    anchor: v.align === "left" ? "start" : v.align === "right" ? "end" : "middle",
  };
}

/** One text layer → <text> elements (same layout the raster used). */
function emitText(v: VectorText, indent: string): string {
  return withMeasureFeatures(v.features, () => emitTextInner(v, indent));
}

/** Extra style props shared by both text paths: width axis + feature tags
 *  (weight folds into each style's own font-weight via effectiveWeight). */
function otStyle(v: VectorText): string {
  let s = "";
  const stretch = stretchKeyword(v.axes?.wdth);
  if (stretch) s += `;font-stretch:${stretch}`;
  const feat = fontFeatureCSS(v.features);
  if (feat) s += `;font-feature-settings:${feat}`;
  return s;
}

function emitTextInner(v: VectorText, indent: string): string {
  const layout = textLayout(v);
  if (!layout) return "";
  // Rich runs / justification: lay out with the shared engine and emit one
  // absolutely-positioned <text> per segment (per-run style).
  if ((v.runs?.length ?? 0) > 0 || v.align === "justify") {
    if (!measureCtx) return "";
    const ctx = measureCtx;
    const lsCtx = ctx as CanvasRenderingContext2D & { letterSpacing: string };
    const fontMetrics = new Map<string, { ascent: number; descent: number }>();
    const rich = layoutRuns(
      v.text,
      v.runs,
      baseRunStyle(v),
      v.boxW,
      v.lineHeight,
      v.align,
      (text, st) => {
        const font = cssFontString(st, v.axes);
        ctx.font = font;
        if ("letterSpacing" in ctx) lsCtx.letterSpacing = `${v.tracking}px`;
        let met = fontMetrics.get(font);
        if (!met) {
          const m = ctx.measureText("Mg");
          met = {
            ascent: m.fontBoundingBoxAscent || m.actualBoundingBoxAscent || st.fontSize * 0.8,
            descent: m.fontBoundingBoxDescent || m.actualBoundingBoxDescent || st.fontSize * 0.2,
          };
          fontMetrics.set(font, met);
        }
        return { width: ctx.measureText(text).width, ascent: met.ascent, descent: met.descent };
      },
    );
    let out = "";
    for (const line of rich.lines) {
      for (const seg of line.segs) {
        if (seg.space || !seg.text) continue;
        const st = seg.style;
        const fillP = splitPaint(st.color);
        let styleAttr = `font-family:${st.fontFamily.includes(" ") ? `'${st.fontFamily}'` : st.fontFamily};font-size:${f(st.fontSize)}px`;
        const segWeight = effectiveWeight(st.bold, v.axes);
        if (segWeight !== 400) styleAttr += `;font-weight:${segWeight}`;
        if (st.italic) styleAttr += ";font-style:italic";
        styleAttr += otStyle(v);
        if (v.tracking) styleAttr += `;letter-spacing:${f(v.tracking)}px`;
        const decoS = [st.underline ? "underline" : "", st.strike ? "line-through" : ""].filter(Boolean).join(" ");
        if (decoS) styleAttr += `;text-decoration:${decoS}`;
        let attrs = ` x="${f(v.x + seg.x)}" y="${f(v.y + line.baseline)}" style="${escapeXml(styleAttr)}"`;
        attrs += fillP ? ` fill="${fillP.color}"` : ` fill="none"`;
        if (fillP && fillP.opacity < 1) attrs += ` fill-opacity="${f(fillP.opacity)}"`;
        out += `${indent}<text${attrs}>${escapeXml(seg.text)}</text>\n`;
      }
    }
    return out;
  }
  const fill = splitPaint(v.color);
  let style = `font-family:${v.fontFamily.includes(" ") ? `'${v.fontFamily}'` : v.fontFamily};font-size:${f(v.fontSize)}px`;
  const weight = effectiveWeight(v.bold, v.axes);
  if (weight !== 400) style += `;font-weight:${weight}`;
  if (v.italic) style += ";font-style:italic";
  style += otStyle(v);
  if (v.tracking) style += `;letter-spacing:${f(v.tracking)}px`;
  const deco = [v.underline ? "underline" : "", v.strike ? "line-through" : ""].filter(Boolean).join(" ");
  if (deco) style += `;text-decoration:${deco}`;
  let out = "";
  for (const line of layout.lines) {
    if (!line.text) continue;
    let attrs = ` x="${f(line.x)}" y="${f(line.y)}" style="${escapeXml(style)}"`;
    if (layout.anchor !== "start") attrs += ` text-anchor="${layout.anchor}"`;
    attrs += fill ? ` fill="${fill.color}"` : ` fill="none"`;
    if (fill && fill.opacity < 1) attrs += ` fill-opacity="${f(fill.opacity)}"`;
    out += `${indent}<text${attrs}>${escapeXml(line.text)}</text>\n`;
  }
  return out;
}

function emitVectorLayer(name: string, opacity: number, blend: string, v: VectorData, indent: string): string {
  const inner =
    v.type === "path"
      ? emitVectorPaths(v, indent + "  ")
      : v.type === "shape"
        ? emitShape(v, indent + "  ")
        : emitText(v, indent + "  ");
  if (!inner) return "";
  return `${indent}<g${layerAttrs(name, opacity, blend)}>\n${inner}${indent}</g>\n`;
}

/**
 * Serialize the tree's vector-bearing layers (shape / text / imported vector)
 * to a standalone SVG document. Raster layers, adjustment layers, masks and
 * layer effects have no vector source and are skipped (counted).
 */
export function exportSVG(nodes: LayerNode[], w: number, h: number): SVGExportResult {
  let vectorLayers = 0;
  let skipped = 0;
  const emitNodes = (list: LayerNode[], indent: string): string => {
    let out = "";
    // list[0] is the TOP layer; SVG paints first-to-back → emit in reverse.
    for (let i = list.length - 1; i >= 0; i--) {
      const n = list[i];
      if (!n.visible) continue;
      if (n.type === "adjustment") {
        skipped++;
        continue;
      }
      if (n.type === "group") {
        const inner = emitNodes(n.children, indent + "  ");
        if (inner) out += `${indent}<g${layerAttrs(n.name, n.opacity, n.blend)}>\n${inner}${indent}</g>\n`;
        continue;
      }
      if (!n.vector) {
        skipped++;
        continue;
      }
      const emitted = emitVectorLayer(n.name, n.opacity, n.blend, n.vector, indent);
      if (emitted) {
        vectorLayers++;
        out += emitted;
      } else {
        skipped++;
      }
    }
    return out;
  };
  const body = emitNodes(nodes, "  ");
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">\n` +
    body +
    `</svg>\n`;
  return { svg, vectorLayers, skipped };
}
