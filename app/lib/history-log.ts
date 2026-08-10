// Persisted history log (TODO §10) — the pure half.
//
// What CAN and CANNOT survive a reload, and why:
//
// The undo stack is a list of reversible pixel DELTAS plus live callbacks. A
// `.gproj` stores the document's CURRENT pixels, so even if the deltas were
// serialized there is nothing to apply them to — reconstructing an earlier
// state needs the original pixels as well, i.e. a second copy of the document
// per step. Replaying "param-only" steps has the same problem from the other
// side: replaying forward from the saved state is meaningless, because the
// saved state already includes those steps.
//
// So what persists is the LOG: what was done, in order. That is genuinely
// useful (it is Photoshop's History Log, and it answers "what did I do to this
// file?" after reopening it), and it is honest about not being navigable. The
// file has carried these labels since v1 — nothing ever read them back.

/** How many entries a file keeps. Enough to be a real record of a session,
 *  small enough that the log can never meaningfully grow a project file. */
export const MAX_LOG = 50;

/** The synthetic first row of the live history — the original state, not a step. */
export const ORIGIN_LABEL = "New";

/** Validate + normalize a log read from an untrusted file. */
export function sanitizeLog(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") continue;
    const s = v.trim().slice(0, 80);
    if (s) out.push(s);
  }
  return out.slice(-MAX_LOG);
}

/**
 * The log to write into a file: what the document already carried, followed by
 * what this session did, capped to the most recent `MAX_LOG`.
 *
 * The live list's leading "New" row is dropped — it marks the original state
 * rather than an edit, and keeping it would insert another one on every
 * save/reload cycle until the log was nothing but origins.
 */
export function mergeLog(prior: string[], live: string[], max = MAX_LOG): string[] {
  const steps = live.length && live[0] === ORIGIN_LABEL ? live.slice(1) : live;
  const all = [...sanitizeLog(prior), ...sanitizeLog(steps)];
  return all.slice(-max);
}

/** Collapse consecutive identical labels for display: ten brush strokes read
 *  better as one "Brush ×10" row than as ten identical lines. */
export interface LogRow {
  label: string;
  count: number;
}

export function groupLog(log: string[]): LogRow[] {
  const out: LogRow[] = [];
  for (const label of log) {
    const last = out[out.length - 1];
    if (last && last.label === label) last.count++;
    else out.push({ label, count: 1 });
  }
  return out;
}

/** "12 earlier steps" / "1 earlier step" — the section's summary line. */
export const logSummary = (n: number): string =>
  `${n} earlier step${n === 1 ? "" : "s"}`;
