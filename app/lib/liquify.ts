// Liquify — pure warp-mesh math (no DOM types beyond the structural image
// shape, so the whole module runs under Node for the verify suite).
//
// Model: a regular grid of BACKWARD displacement vectors in document space.
// D(p) is "where to sample from, relative to p": the rendered pixel at p shows
// the source at p + D(p). Backward mapping means the render is a simple, hole-
// free bilinear resample regardless of how wild the field gets. Brushes edit
// the node vectors inside their radius with a smooth cosine falloff; strokes
// ACCUMULATE additively (the classic single-field liquify approximation — see
// the honest notes in TODO.md).

export type LiquifyTool = "warp" | "pucker" | "bloat" | "twirl" | "reconstruct";

export interface LiquifyMesh {
  /** Document dimensions the mesh belongs to. */
  w: number;
  h: number;
  /** Node spacing in doc px (nodes sit at i*spacing, clamped grid covers the doc). */
  spacing: number;
  cols: number;
  rows: number;
  /** Per-node backward offset (doc px), row-major cols×rows. */
  dx: Float32Array;
  dy: Float32Array;
}

/** Structural stand-in for ImageData so the module stays Node-testable. */
export interface LiquifyImage {
  width: number;
  height: number;
  data: Uint8ClampedArray<ArrayBuffer>;
}

/** Spacing that keeps node counts sane at any doc size (≈240 nodes across). */
export function defaultSpacing(w: number, h: number): number {
  return Math.max(4, Math.round(Math.max(w, h) / 240));
}

export function createMesh(w: number, h: number, spacing = defaultSpacing(w, h)): LiquifyMesh {
  const cols = Math.ceil(w / spacing) + 1;
  const rows = Math.ceil(h / spacing) + 1;
  return { w, h, spacing, cols, rows, dx: new Float32Array(cols * rows), dy: new Float32Array(cols * rows) };
}

export function meshIsIdentity(mesh: LiquifyMesh): boolean {
  for (let i = 0; i < mesh.dx.length; i++) if (mesh.dx[i] !== 0 || mesh.dy[i] !== 0) return false;
  return true;
}

/** Smooth brush falloff: 1 at the centre → 0 at the radius (cosine bell). */
const falloff = (d: number, r: number): number => (d >= r ? 0 : 0.5 + 0.5 * Math.cos((Math.PI * d) / r));

/** Per-tick rates so brush feel is consistent across tools (strength is 0–1). */
const PUCKER_RATE = 0.06; // fraction of centre-distance per tick
const TWIRL_RATE = 0.1; // radians per tick at full strength
const RECON_RATE = 0.4; // fraction of displacement removed per tick

/**
 * Apply one brush tick to the mesh, in place.
 * - `warp` needs `delta` (the cursor motion since the last event, doc px):
 *   pixels under the brush now sample from BEHIND the motion (content follows
 *   the drag). The delta is capped at the brush radius so a fast stroke can't
 *   tear the field.
 * - `pucker`/`bloat` contract/expand around the centre; `twirl` rotates around
 *   it (`dir` +1 = clockwise, −1 = counter-clockwise); `reconstruct` fades the
 *   field back toward identity. These four are per-TICK ops — hold to keep going.
 */
export function applyBrush(
  mesh: LiquifyMesh,
  tool: LiquifyTool,
  cx: number,
  cy: number,
  radius: number,
  strength: number,
  delta?: { x: number; y: number },
  dir: 1 | -1 = 1,
): void {
  const r = Math.max(1, radius);
  const s = Math.max(0, Math.min(1, strength));
  if (s === 0) return;
  let wdx = 0;
  let wdy = 0;
  if (tool === "warp") {
    if (!delta || (delta.x === 0 && delta.y === 0)) return;
    const len = Math.hypot(delta.x, delta.y);
    const cap = len > r ? r / len : 1; // fast strokes can't tear the field
    wdx = delta.x * cap;
    wdy = delta.y * cap;
  }
  const { spacing, cols, rows, dx, dy } = mesh;
  const i0 = Math.max(0, Math.floor((cx - r) / spacing));
  const i1 = Math.min(cols - 1, Math.ceil((cx + r) / spacing));
  const j0 = Math.max(0, Math.floor((cy - r) / spacing));
  const j1 = Math.min(rows - 1, Math.ceil((cy + r) / spacing));
  const ang = TWIRL_RATE * s * dir;
  for (let j = j0; j <= j1; j++) {
    const ny = j * spacing;
    for (let i = i0; i <= i1; i++) {
      const nx = i * spacing;
      const d = Math.hypot(nx - cx, ny - cy);
      const w = falloff(d, r);
      if (w === 0) continue;
      const k = j * cols + i;
      switch (tool) {
        case "warp":
          // src = p − delta ⇒ content moves WITH the drag.
          dx[k] -= wdx * s * w;
          dy[k] -= wdy * s * w;
          break;
        case "pucker":
          // Content contracts toward the centre ⇒ sample farther out.
          dx[k] += (nx - cx) * PUCKER_RATE * s * w;
          dy[k] += (ny - cy) * PUCKER_RATE * s * w;
          break;
        case "bloat":
          // Content expands from the centre ⇒ sample nearer the centre.
          dx[k] -= (nx - cx) * PUCKER_RATE * s * w;
          dy[k] -= (ny - cy) * PUCKER_RATE * s * w;
          break;
        case "twirl": {
          // Sample from the position rotated about the centre by w-scaled angle.
          // (Per-node partial rotation — the field stays smooth across the brush.)
          const vx = nx - cx;
          const vy = ny - cy;
          const aw = ang * w;
          const c = Math.cos(aw);
          const sn = Math.sin(aw);
          dx[k] += vx * c - vy * sn - vx;
          dy[k] += vx * sn + vy * c - vy;
          break;
        }
        case "reconstruct":
          dx[k] *= 1 - RECON_RATE * s * w;
          dy[k] *= 1 - RECON_RATE * s * w;
          break;
      }
    }
  }
}

/** Bilinear displacement lookup at a doc-space point (edge-clamped). */
export function sampleDisp(mesh: LiquifyMesh, x: number, y: number): { x: number; y: number } {
  const { spacing, cols, rows, dx, dy } = mesh;
  const gx = Math.min(Math.max(x / spacing, 0), cols - 1);
  const gy = Math.min(Math.max(y / spacing, 0), rows - 1);
  const i = Math.min(Math.floor(gx), cols - 2);
  const j = Math.min(Math.floor(gy), rows - 2);
  const fx = gx - i;
  const fy = gy - j;
  const k = j * cols + i;
  const x0 = dx[k] + (dx[k + 1] - dx[k]) * fx;
  const x1 = dx[k + cols] + (dx[k + cols + 1] - dx[k + cols]) * fx;
  const y0 = dy[k] + (dy[k + 1] - dy[k]) * fx;
  const y1 = dy[k + cols] + (dy[k + cols + 1] - dy[k + cols]) * fx;
  return { x: x0 + (x1 - x0) * fy, y: y0 + (y1 - y0) * fy };
}

/**
 * Backward-warp `src` through the mesh into a new image of the same size.
 * `scale` maps doc space → src px (1 for full res; dw/docW for a downscaled
 * preview). Sampling is premultiplied bilinear with a transparent border, so
 * pulling from outside the layer brings in clean transparency and soft alpha
 * edges never halo.
 */
export function renderLiquify(src: LiquifyImage, mesh: LiquifyMesh, scale = 1): LiquifyImage {
  const { width: sw, height: sh, data: sd } = src;
  const out = new Uint8ClampedArray(sd.length);
  const identity = meshIsIdentity(mesh);
  if (identity) {
    out.set(sd);
    return { width: sw, height: sh, data: out };
  }
  const inv = 1 / scale;
  let o = 0;
  for (let py = 0; py < sh; py++) {
    const docY = (py + 0.5) * inv;
    for (let px = 0; px < sw; px++, o += 4) {
      const docX = (px + 0.5) * inv;
      const d = sampleDisp(mesh, docX, docY);
      const sx = (docX + d.x) * scale - 0.5;
      const sy = (docY + d.y) * scale - 0.5;
      // Premultiplied bilinear with zero-alpha outside the image.
      const x0 = Math.floor(sx);
      const y0 = Math.floor(sy);
      const fx = sx - x0;
      const fy = sy - y0;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let t = 0; t < 4; t++) {
        const xx = x0 + (t & 1);
        const yy = y0 + (t >> 1);
        if (xx < 0 || yy < 0 || xx >= sw || yy >= sh) continue;
        const wgt = (t & 1 ? fx : 1 - fx) * (t >> 1 ? fy : 1 - fy);
        if (wgt === 0) continue;
        const q = (yy * sw + xx) * 4;
        const aw = sd[q + 3] * wgt;
        r += sd[q] * aw;
        g += sd[q + 1] * aw;
        b += sd[q + 2] * aw;
        a += aw;
      }
      if (a > 0) {
        out[o] = r / a;
        out[o + 1] = g / a;
        out[o + 2] = b / a;
        out[o + 3] = a;
      }
      // else: fully transparent (buffer is zero-initialised)
    }
  }
  return { width: sw, height: sh, data: out };
}

/**
 * Grid polylines for the mesh overlay, in doc space. Vertices are drawn at
 * p − D(p): the first-order FORWARD image of each node (content originally at
 * a node lands ≈ there), so a bloat visibly bulges the grid outward instead of
 * showing the inverse pinch. `step` skips nodes to keep the overlay light.
 */
export function meshLines(mesh: LiquifyMesh, step = 2): { x: number; y: number }[][] {
  const { spacing, cols, rows } = mesh;
  const lines: { x: number; y: number }[][] = [];
  const vertex = (i: number, j: number) => {
    const x = i * spacing;
    const y = j * spacing;
    const k = j * cols + i;
    return { x: x - mesh.dx[k], y: y - mesh.dy[k] };
  };
  for (let j = 0; j < rows; j += step) {
    const line: { x: number; y: number }[] = [];
    for (let i = 0; i < cols; i++) line.push(vertex(i, j));
    lines.push(line);
  }
  for (let i = 0; i < cols; i += step) {
    const line: { x: number; y: number }[] = [];
    for (let j = 0; j < rows; j++) line.push(vertex(i, j));
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Mesh files (.gmesh) — JSON envelope with base64 Float32 planes, so a saved
// mesh round-trips bit-exact and stays a diffable text file.
// ---------------------------------------------------------------------------

const MESH_MAGIC = "graphiq-liquify-mesh";

function f32ToB64(a: Float32Array): string {
  const bytes = new Uint8Array(a.buffer, a.byteOffset, a.byteLength);
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  // btoa is browser-only; Buffer is Node-only — support both for the tests.
  return typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64");
}

function b64ToF32(s: string, expect: number): Float32Array {
  let bytes: Uint8Array;
  if (typeof atob === "function") {
    const bin = atob(s);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new Uint8Array(Buffer.from(s, "base64"));
  }
  if (bytes.length !== expect * 4) throw new Error("mesh data length does not match its grid");
  return new Float32Array(bytes.buffer, bytes.byteOffset, expect);
}

export function serializeMesh(mesh: LiquifyMesh): string {
  return JSON.stringify({
    format: MESH_MAGIC,
    version: 1,
    w: mesh.w,
    h: mesh.h,
    spacing: mesh.spacing,
    cols: mesh.cols,
    rows: mesh.rows,
    dx: f32ToB64(mesh.dx),
    dy: f32ToB64(mesh.dy),
  });
}

export function deserializeMesh(text: string): LiquifyMesh {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error("Not a mesh file (invalid JSON).");
  }
  const m = raw as Record<string, unknown>;
  if (!m || m.format !== MESH_MAGIC) throw new Error("Not a Graphiq liquify mesh file.");
  if (m.version !== 1) throw new Error(`Unsupported mesh version ${String(m.version)}.`);
  const w = m.w;
  const h = m.h;
  const spacing = m.spacing;
  const cols = m.cols;
  const rows = m.rows;
  if (
    typeof w !== "number" || typeof h !== "number" || typeof spacing !== "number" ||
    typeof cols !== "number" || typeof rows !== "number" ||
    w < 1 || h < 1 || spacing < 1 || cols < 2 || rows < 2 ||
    cols !== Math.ceil(w / spacing) + 1 || rows !== Math.ceil(h / spacing) + 1
  ) {
    throw new Error("Mesh dimensions are malformed.");
  }
  if (typeof m.dx !== "string" || typeof m.dy !== "string") throw new Error("Mesh data is missing.");
  return { w, h, spacing, cols, rows, dx: b64ToF32(m.dx, cols * rows), dy: b64ToF32(m.dy, cols * rows) };
}

/**
 * Fit a mesh onto a (possibly different) document size: the field is resampled
 * bilinearly over normalized coordinates and the vectors scale with the axis
 * ratios, so a saved warp applies proportionally — same as re-recording it on
 * the resized image. Same-size meshes pass through untouched.
 */
export function resampleMesh(mesh: LiquifyMesh, w: number, h: number): LiquifyMesh {
  if (mesh.w === w && mesh.h === h) return mesh;
  const out = createMesh(w, h);
  const kx = w / mesh.w;
  const ky = h / mesh.h;
  for (let j = 0; j < out.rows; j++) {
    const srcY = (j * out.spacing) / ky;
    for (let i = 0; i < out.cols; i++) {
      const srcX = (i * out.spacing) / kx;
      const d = sampleDisp(mesh, srcX, srcY);
      const k = j * out.cols + i;
      out.dx[k] = d.x * kx;
      out.dy[k] = d.y * ky;
    }
  }
  return out;
}
