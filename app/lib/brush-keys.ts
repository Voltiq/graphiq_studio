/**
 * The brush-style keyboard shortcuts, as the Shortcuts dialog lists them:
 * `[` / `]` size, `{` / `}` hardness, a digit sets a percentage (1 → 10%,
 * 0 → 100%) — Photoshop's mapping.
 */

export type BrushKey =
  | { kind: "size"; dir: 1 | -1 }
  | { kind: "hardness"; dir: 1 | -1 }
  | { kind: "percent"; value: number };

/** What `key` (a KeyboardEvent.key) does to a brush-style tool, if anything. */
export function brushKey(key: string): BrushKey | null {
  if (key === "[" || key === "]") return { kind: "size", dir: key === "]" ? 1 : -1 };
  if (key === "{" || key === "}") return { kind: "hardness", dir: key === "}" ? 1 : -1 };
  if (/^[0-9]$/.test(key)) {
    const n = Number(key);
    return { kind: "percent", value: n === 0 ? 100 : n * 10 };
  }
  return null;
}

/** One `[` / `]` press: about a tenth of the current size, never less than
 *  1 px, kept inside the tool's own slider range. */
export function stepSize(size: number, dir: 1 | -1, min = 1, max = 500): number {
  const step = Math.max(1, Math.round(size * 0.1));
  return Math.max(min, Math.min(max, size + dir * step));
}

/** One `{` / `}` press: 10 points of hardness, within 0–100. */
export function stepHardness(hardness: number, dir: 1 | -1): number {
  return Math.max(0, Math.min(100, hardness + dir * 10));
}
