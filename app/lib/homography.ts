/**
 * Projective (homography) mapping between two quadrilaterals — the math behind
 * the Perspective Crop tool. Pure and dependency-free (Node-testable): no DOM.
 *
 * A homography H is a 3×3 matrix (stored row-major as 9 numbers, H[8] fixed to 1)
 * mapping a point (x,y) → (u,v) in homogeneous coordinates:
 *   w = H6·x + H7·y + H8
 *   u = (H0·x + H1·y + H2) / w
 *   v = (H3·x + H4·y + H5) / w
 */

export interface Pt {
  x: number;
  y: number;
}

/** Solve the 8×8 linear system A·h = b (Gaussian elimination, partial pivot). */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  // Augmented matrix.
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // Partial pivot: swap in the row with the largest |value| in this column.
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) continue; // singular column — leave it
    [M[col], M[piv]] = [M[piv], M[col]];
    const pivVal = M[col][col];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col] / pivVal;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= f * M[col][c];
    }
  }
  const h = new Array<number>(n);
  for (let i = 0; i < n; i++) h[i] = Math.abs(M[i][i]) < 1e-12 ? 0 : M[i][n] / M[i][i];
  return h;
}

/**
 * Homography mapping the four `src` points to the four `dst` points (same order).
 * Returns the 9 row-major matrix entries (last is 1). For the Perspective Crop
 * resample pass `src` is the OUTPUT rectangle's corners and `dst` is the picked
 * quad, so applying H to each output pixel yields its source location.
 */
export function solveHomography(src: Pt[], dst: Pt[]): number[] {
  const A: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const { x, y } = src[i];
    const u = dst[i].x;
    const v = dst[i].y;
    A.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    A.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  const h = solveLinear(A, b);
  return [...h, 1];
}

/** Apply a homography to a point. */
export function applyHomography(H: number[], x: number, y: number): Pt {
  const w = H[6] * x + H[7] * y + H[8];
  const iw = w === 0 ? 0 : 1 / w;
  return {
    x: (H[0] * x + H[1] * y + H[2]) * iw,
    y: (H[3] * x + H[4] * y + H[5]) * iw,
  };
}

/** Estimate the output rectangle size for a picked quad (tl, tr, br, bl order):
 *  the average of opposite edge lengths — so the correction neither stretches
 *  nor squashes the average scale. */
export function estimateQuadSize(quad: Pt[]): { w: number; h: number } {
  const dist = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y);
  const [tl, tr, br, bl] = quad;
  const w = (dist(tl, tr) + dist(bl, br)) / 2;
  const h = (dist(tl, bl) + dist(tr, br)) / 2;
  return { w: Math.max(1, Math.round(w)), h: Math.max(1, Math.round(h)) };
}
