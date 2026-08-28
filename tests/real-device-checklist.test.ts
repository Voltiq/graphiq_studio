/**
 * The checklist's own criterion, enforced.
 *
 * REAL-DEVICE-CHECKLIST.md exists because a green CI run is not "mobile works":
 * it lists what emulation cannot see. A list like that rots in a specific way —
 * it keeps describing a codebase that has moved on, and then it is worse than
 * nothing, because it sends someone to check a file that no longer exists.
 *
 * So the criterion the item sets is the one asserted here: **every item names
 * the code path it covers**, and every path it names is real. A section without
 * a `Covers:` line fails. A file that has been renamed fails. A symbol that has
 * been deleted fails — which is the case that catches a refactor, since a stale
 * path is usually still a valid-looking string.
 *
 * Deliberately not a lint of the prose: this says nothing about whether the
 * advice is good, only that it points somewhere.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const DOC = "REAL-DEVICE-CHECKLIST.md";
const text = readFileSync(resolve(process.cwd(), DOC), "utf8");

/** Each numbered section, with the prose that follows it up to the next one. */
const sections = text
  .split(/^### /m)
  .slice(1)
  .map((chunk) => {
    const [heading, ...rest] = chunk.split("\n");
    return { heading: heading.trim(), body: rest.join("\n") };
  })
  /* The trailing "What emulation does cover" section is a `##`, not a `###`,
     so it is not swept up here — it makes no claims to check. */
  .filter((s) => /^\d+\./.test(s.heading));

/** The backticked tokens on a section's `Covers:` line, if it has one. */
function covers(body: string): string[] | null {
  const m = body.match(/\*\*Covers:\*\*([\s\S]*?)(?:\n\n|$)/);
  if (!m) return null;
  return [...m[1].matchAll(/`([^`]+)`/g)].map((x) => x[1]);
}

const looksLikePath = (t: string) => /^[\w./-]+\.(ts|tsx|js|scss|json|md)$/.test(t);

describe("the real-device checklist points at real code", () => {
  it("has sections at all, so a truncated file cannot pass", () => {
    expect(sections.length).toBeGreaterThanOrEqual(8);
  });

  it("gives every section a Covers: line", () => {
    const missing = sections.filter((s) => covers(s.body) === null).map((s) => s.heading);
    expect(missing).toEqual([]);
  });

  it("names at least one real file per section", () => {
    for (const s of sections) {
      const paths = (covers(s.body) ?? []).filter(looksLikePath);
      expect(paths.length, `${s.heading} names no file`).toBeGreaterThan(0);
      for (const p of paths)
        expect(existsSync(resolve(process.cwd(), p)), `${s.heading}: ${p} does not exist`).toBe(
          true,
        );
    }
  });

  /* The check that actually catches a refactor. A renamed file is obvious; a
     deleted function behind a still-valid filename is not. */
  it("finds every symbol it names inside the files it names", () => {
    for (const s of sections) {
      const tokens = covers(s.body) ?? [];
      const paths = tokens.filter(looksLikePath);
      const symbols = tokens.filter((t) => !looksLikePath(t));
      const haystack = paths
        .map((p) => readFileSync(resolve(process.cwd(), p), "utf8"))
        .join("\n");
      for (const sym of symbols) {
        /* `readDeviceHints()` in prose is `readDeviceHints` in code. */
        const needle = sym.replace(/\(\)$/, "");
        expect(haystack.includes(needle), `${s.heading}: "${needle}" is in none of ${paths.join(", ")}`).toBe(
          true,
        );
      }
    }
  });

  it("keeps every item actionable — an unchecked box per section", () => {
    for (const s of sections)
      expect(s.body.includes("- [ ]"), `${s.heading} has nothing to do`).toBe(true);
  });
});
