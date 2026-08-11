// Font picking (TODO §2 Text) — search ranking + the recent-fonts list.
//
// Pure and Node-testable: no DOM, no storage access in the ranking functions.
// The picker component owns the popover; everything that decides WHICH fonts
// appear, and in what order, lives here so it can be asserted numerically.

export const RECENT_FONTS_KEY = "graphiq:recent-fonts";

/** How many recents to keep. Small on purpose: the list sits above the full
 *  font list, and a long one pushes the thing you're searching for off-screen. */
export const MAX_RECENT = 5;

/**
 * Match `query` against a font name, higher is better; -1 means no match.
 *
 * The tiers matter more than the numbers: an exact name beats a prefix, a
 * prefix beats the start of any word ("nar" → "Arial **Nar**row"), a word start
 * beats a bare substring, and a subsequence ("tnr" → "**T**imes **N**ew
 * **R**oman") is the last resort. Without that last tier a font picker feels
 * broken the moment you type initials; with it as a PEER of the others, "arial"
 * would rank a font that merely contains a-r-i-a-l in order above Arial itself.
 */
export function fontScore(family: string, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const name = family.toLowerCase();
  if (name === q) return 1000;
  if (name.startsWith(q)) return 900 - name.length; // shorter name = tighter match
  // Word start: "new" matches "Times New Roman".
  const words = name.split(/[\s-]+/);
  if (words.some((w) => w.startsWith(q))) return 700 - name.length;
  const at = name.indexOf(q);
  if (at >= 0) return 500 - at;
  // Subsequence: every query character appears in order.
  let i = 0;
  for (const ch of name) {
    if (ch === q[i]) i++;
    if (i === q.length) return 200 - name.length;
  }
  return -1;
}

/** Families matching `query`, best first; an empty query keeps the given order. */
export function searchFonts(families: string[], query: string): string[] {
  if (!query.trim()) return [...families];
  return families
    .map((f, i) => ({ f, i, s: fontScore(f, query) }))
    .filter((x) => x.s >= 0)
    // Ties keep the incoming order (stable), so equal-scoring fonts don't shuffle.
    .sort((a, b) => b.s - a.s || a.i - b.i)
    .map((x) => x.f);
}

/** `family` to the front of the recents, deduped, capped. */
export function pushRecent(list: string[], family: string, max = MAX_RECENT): string[] {
  if (!family) return [...list];
  return [family, ...list.filter((f) => f !== family)].slice(0, Math.max(0, max));
}

/** Built-ins plus whatever the system reported, deduped case-insensitively and
 *  sorted — the built-ins are already the common ones, so a merged list that
 *  kept them pinned on top would bury everything the user actually installed. */
export function mergeFontLists(builtin: string[], local: string[]): string[] {
  const seen = new Map<string, string>();
  for (const f of [...builtin, ...local]) {
    const k = f.trim().toLowerCase();
    if (k && !seen.has(k)) seen.set(k, f.trim());
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/** Recents that still exist in `available` (a font can vanish between sessions
 *  — a different machine, or system fonts that were never granted this time). */
export function validRecents(recents: string[], available: string[]): string[] {
  const have = new Set(available.map((f) => f.toLowerCase()));
  return recents.filter((f) => have.has(f.toLowerCase()));
}

export function loadRecentFonts(): string[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(RECENT_FONTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((f): f is string => typeof f === "string").slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

export function saveRecentFonts(list: string[]): void {
  try {
    window.localStorage.setItem(RECENT_FONTS_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  } catch {
    /* ignore (private mode / quota) */
  }
}

/** Chrome's Local Font Access API, when the user grants it. Returns [] rather
 *  than throwing anywhere it isn't available or is declined, so the caller can
 *  treat "no system fonts" as the ordinary case it is on most browsers. */
export async function querySystemFonts(): Promise<string[]> {
  const q = (window as unknown as { queryLocalFonts?: () => Promise<{ family: string }[]> })
    .queryLocalFonts;
  if (typeof q !== "function") return [];
  try {
    const faces = await q();
    return [...new Set(faces.map((f) => f.family))];
  } catch {
    return []; // permission denied, or dismissed
  }
}

/** Is the Local Font Access API present at all (for showing the button)? */
export const canQuerySystemFonts = (): boolean =>
  typeof window !== "undefined" &&
  typeof (window as unknown as { queryLocalFonts?: unknown }).queryLocalFonts === "function";
