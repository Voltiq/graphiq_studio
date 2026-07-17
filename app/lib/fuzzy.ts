// Fuzzy matching for the command palette (Ctrl+K). Dependency-free and pure
// (Node-testable). fzf-style semantics: the query splits on whitespace and
// EVERY token must match as a case-insensitive subsequence; ranking prefers
// word-start hits, consecutive runs, early matches and short targets.

export interface FuzzyHit {
  score: number;
  /** Character indices of `text` that matched (sorted, unique) — for highlighting. */
  indices: number[];
}

/** Is text[i] the start of a word (string start, or preceded by a separator)? */
function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  return prev === " " || prev === "-" || prev === "_" || prev === "/" || prev === "(" || prev === ":" || prev === ".";
}

const WORD_START_BONUS = 12;
const CONSECUTIVE_BONUS = 8;
const MATCH_SCORE = 10;
const GAP_PENALTY = 1;

/**
 * Match one token as a subsequence of `text`. Tries a greedy match anchored at
 * every occurrence of the token's first character and keeps the best-scoring
 * one — targets are short UI labels, so this stays trivially cheap while
 * avoiding the classic greedy failure ("ab" in "a…a b" anchoring on the first a).
 */
function matchToken(token: string, text: string, lower: string): FuzzyHit | null {
  const t = token.toLowerCase();
  let best: FuzzyHit | null = null;
  for (let start = lower.indexOf(t[0]); start !== -1; start = lower.indexOf(t[0], start + 1)) {
    const indices: number[] = [start];
    let score = MATCH_SCORE + (isWordStart(text, start) ? WORD_START_BONUS : 0);
    let prev = start;
    let ok = true;
    for (let qi = 1; qi < t.length; qi++) {
      const at = lower.indexOf(t[qi], prev + 1);
      if (at === -1) {
        ok = false;
        break;
      }
      score += MATCH_SCORE;
      if (at === prev + 1) score += CONSECUTIVE_BONUS;
      else {
        score -= Math.min(10, (at - prev - 1) * GAP_PENALTY);
        if (isWordStart(text, at)) score += WORD_START_BONUS;
      }
      indices.push(at);
      prev = at;
    }
    if (!ok) continue;
    // Earlier anchors and shorter targets read as better matches.
    score -= start * 0.5;
    score -= text.length * 0.05;
    if (!best || score > best.score) best = { score, indices };
  }
  return best;
}

/**
 * Match a whole query (whitespace-separated tokens, ALL must hit) against
 * `text`. Returns the combined score + union of matched indices, or null.
 * An empty/blank query returns null — callers decide what "no query" shows.
 */
export function fuzzyMatch(query: string, text: string): FuzzyHit | null {
  const tokens = query.trim().split(/\s+/).filter(Boolean);
  if (!tokens.length || !text) return null;
  const lower = text.toLowerCase();
  let score = 0;
  const all = new Set<number>();
  for (const tok of tokens) {
    const hit = matchToken(tok, text, lower);
    if (!hit) return null;
    score += hit.score;
    for (const i of hit.indices) all.add(i);
  }
  return { score, indices: [...all].sort((a, b) => a - b) };
}

/** Split `text` into alternating plain/highlighted runs from match indices —
 *  ready for rendering ("Exp" in "Export" → [["Exp", true], ["ort", false]]). */
export function highlightRuns(text: string, indices: number[]): [string, boolean][] {
  const runs: [string, boolean][] = [];
  const idx = new Set(indices);
  let cur = "";
  let curHl = false;
  for (let i = 0; i < text.length; i++) {
    const hl = idx.has(i);
    if (i === 0 || hl === curHl) {
      cur += text[i];
      curHl = hl;
    } else {
      runs.push([cur, curHl]);
      cur = text[i];
      curHl = hl;
    }
  }
  if (cur) runs.push([cur, curHl]);
  return runs;
}
