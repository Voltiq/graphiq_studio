// Undo memory accounting (TODO §10) — the pure half of "cap history by BYTES,
// not just by step count".
//
// A step count is a poor proxy for memory, and the error is not small: one
// full-canvas patch on a 6000×4000 document is ~46 MB before and ~46 MB after,
// so sixty of those is over 5 GB — while sixty small brush dabs might be two.
// The step cap stays (it is what people expect from "undo steps"), but a byte
// budget now sits alongside it and whichever binds first wins.
//
// What counts: the before/after pixel patches, which are the only large things
// in an entry. Structural steps hold two closures and are effectively free.
// Snapshots are NOT counted here — they are user-created, unbounded by design
// (like Photoshop's), and live outside the undo stack.

/** The pixel payload of one history entry, in bytes. */
export interface PatchSizes {
  before?: { data: { byteLength: number } } | null;
  after?: { data: { byteLength: number } } | null;
}

/** Bytes held by one entry — 0 for a structural (callback-only) step. */
export function entryBytes(e: PatchSizes): number {
  return (e.before?.data.byteLength ?? 0) + (e.after?.data.byteLength ?? 0);
}

/** Bytes held by a whole history. */
export function totalBytes(entries: PatchSizes[]): number {
  let n = 0;
  for (const e of entries) n += entryBytes(e);
  return n;
}

/** Bytes an RGBA patch of this size will cost (before + after). */
export const patchCost = (w: number, h: number): number =>
  Math.max(0, Math.round(w)) * Math.max(0, Math.round(h)) * 4 * 2;

export const MB = 1024 * 1024;

/** Allowed budget range, in MB. The floor is deliberately low enough to be
 *  useful on a small machine but high enough to always hold a few full-canvas
 *  patches on an ordinary document. */
export const MIN_BUDGET_MB = 32;
export const MAX_BUDGET_MB = 4096;

export const clampBudgetMB = (mb: number): number =>
  Number.isFinite(mb) ? Math.max(MIN_BUDGET_MB, Math.min(MAX_BUDGET_MB, Math.round(mb))) : 512;

/** Is the history over its byte budget? */
export const overBudget = (bytes: number, budgetMB: number): boolean =>
  bytes > clampBudgetMB(budgetMB) * MB;

/** Compact size for the readout: "0 B", "812 KB", "1.4 GB". Deliberately its
 *  own copy rather than shared with the storage panel's — this one never shows
 *  a decimal below MB, because sub-MB precision is noise for a memory budget. */
export function formatSize(bytes: number): string {
  const n = Math.max(0, bytes);
  if (n < 1024) return `${Math.round(n)} B`;
  if (n < MB) return `${Math.round(n / 1024)} KB`;
  if (n < 1024 * MB) {
    const mb = n / MB;
    return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
  }
  return `${(n / (1024 * MB)).toFixed(1)} GB`;
}

/** Everything the Preferences readout needs, computed in one place. */
export interface BudgetReport {
  bytes: number;
  budgetBytes: number;
  /** 0–1, clamped — the meter's fill. */
  fraction: number;
  over: boolean;
  label: string;
}

export function budgetReport(bytes: number, steps: number, budgetMB: number): BudgetReport {
  const budgetBytes = clampBudgetMB(budgetMB) * MB;
  const b = Math.max(0, bytes);
  return {
    bytes: b,
    budgetBytes,
    fraction: budgetBytes > 0 ? Math.min(1, b / budgetBytes) : 0,
    over: b > budgetBytes,
    label: `${steps} step${steps === 1 ? "" : "s"} · ${formatSize(b)} of ${formatSize(budgetBytes)}`,
  };
}
