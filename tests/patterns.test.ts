/**
 * The pattern library's pure half.
 *
 * Storage needs IndexedDB and the built-in tiles need a canvas, so neither is
 * here. What is here is everything that decides whether a file is safe to
 * import, what a name becomes, and which tiles survive the byte budget — the
 * parts where a mistake is a security hole or a lost preset rather than a
 * drawing bug.
 */
import { describe, expect, it } from "vitest";
import {
  BUILTIN_PATTERNS,
  PATTERN_MAX_EDGE,
  builtinPatternMetas,
  freshPatternId,
  isBuiltinPattern,
  mergePatterns,
  parsePatternFile,
  patternNameFromFile,
  sanitizePattern,
  serializePatterns,
  trimPatterns,
  type PatternEntry,
  type PatternMeta,
} from "../app/lib/patterns";

const PNG = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg==";

const entry = (over: Partial<PatternEntry> = {}): PatternEntry => ({
  name: "Tile",
  width: 32,
  height: 32,
  src: PNG,
  ...over,
});

const meta = (over: Partial<PatternMeta> = {}): PatternMeta => ({
  id: "pat-a-0001",
  name: "Tile",
  width: 32,
  height: 32,
  bytes: 1000,
  savedAt: 1,
  ...over,
});

describe("ids", () => {
  it("marks built-ins apart from saved ones", () => {
    expect(isBuiltinPattern("b-checker")).toBe(true);
    expect(isBuiltinPattern("pat-x-0001")).toBe(false);
  });

  /* Distinct, and never a built-in. NOT sortable — base36 of a timestamp
     changes length as the clock passes a power of 36, so the strings do not
     compare by value. The listing sorts on `savedAt` instead, and this test
     exists in this shape because the first one asserted the ordering and
     found it was not true. */
  it("mints ids that are distinct and never claim to be built-in", () => {
    const a = freshPatternId(1_000_000, 0.1);
    const b = freshPatternId(2_000_000, 0.1);
    const c = freshPatternId(1_000_000, 0.9);
    expect(new Set([a, b, c]).size).toBe(3);
    for (const id of [a, b, c]) expect(isBuiltinPattern(id)).toBe(false);
  });

  /* An id is MINTED, never taken from a file — see the note on `PatternEntry`.
     The shape library takes its ids from the file, which lets a hand-edited one
     claim a built-in prefix and become undeletable. There is no field here for
     that to arrive in. */
  it("gives an imported entry no way to name itself a built-in", () => {
    const p = sanitizePattern({ ...entry(), id: "b-checker" });
    expect(p).not.toBeNull();
    expect(p as unknown as Record<string, unknown>).not.toHaveProperty("id");
  });
});

describe("patternNameFromFile", () => {
  it("drops the extension and opens up separators", () => {
    expect(patternNameFromFile("brick_wall.png")).toBe("brick wall");
    expect(patternNameFromFile("blue-tile.webp")).toBe("blue tile");
  });

  it("never returns an empty label", () => {
    expect(patternNameFromFile(".png")).toBe("Pattern");
    expect(patternNameFromFile("")).toBe("Pattern");
  });
});

describe("sanitizePattern", () => {
  it("accepts a well-formed entry", () => {
    expect(sanitizePattern(entry())).toEqual(entry());
  });

  it.each([
    ["not an object", 42],
    ["no name", { ...entry(), name: "  " }],
    ["no size", { ...entry(), width: 0 }],
    ["a negative size", { ...entry(), height: -8 }],
    ["a tile larger than the cap", { ...entry(), width: PATTERN_MAX_EDGE + 1 }],
    ["a missing source", { ...entry(), src: "" }],
  ])("rejects %s", (_what, raw) => {
    expect(sanitizePattern(raw)).toBeNull();
  });

  /* THE ONE THAT MATTERS. A pattern file is JSON someone may have been sent, and
     a `src` it can choose is a `src` the app would fetch or evaluate. Only a
     base64 data URL of an image is allowed, so importing a pattern can never be
     a network request the user did not make. */
  it.each([
    ["a remote URL", "https://example.com/tile.png"],
    ["a protocol-relative URL", "//example.com/tile.png"],
    ["a javascript: URL", "javascript:alert(1)"],
    ["an SVG data URL, which can carry script", "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4="],
    ["a data URL that is not an image", "data:text/html;base64,PGh0bWw+"],
    ["a data URL that is not base64", "data:image/png,raw-bytes-here"],
  ])("refuses %s as a source", (_what, src) => {
    expect(sanitizePattern({ ...entry(), src })).toBeNull();
  });

  it("trims an over-long name rather than refusing it", () => {
    const p = sanitizePattern({ ...entry(), name: "x".repeat(200) });
    expect(p?.name.length).toBeLessThanOrEqual(60);
  });
});

describe("files", () => {
  it("round-trips through serialize and parse", () => {
    const list = [entry({ name: "One" }), entry({ name: "Two" })];
    expect(parsePatternFile(serializePatterns(list))).toEqual(list);
  });

  it("reads a bare array as well as the wrapped form", () => {
    expect(parsePatternFile(JSON.stringify([entry()]))).toHaveLength(1);
  });

  it("returns nothing rather than throwing on rubbish", () => {
    expect(parsePatternFile("{oh no")).toEqual([]);
    expect(parsePatternFile("null")).toEqual([]);
    expect(parsePatternFile('{"patterns": 5}')).toEqual([]);
  });

  /* One bad entry in a file of good ones loses that entry, not the import. */
  it("keeps the good entries and drops the bad", () => {
    const mixed = JSON.stringify({
      patterns: [entry({ name: "Good" }), { name: "Bad", src: "https://x/y.png" }],
    });
    const got = parsePatternFile(mixed);
    expect(got).toHaveLength(1);
    expect(got[0].name).toBe("Good");
  });
});

describe("mergePatterns", () => {
  it("renames rather than replacing what is already there", () => {
    const merged = mergePatterns([{ name: "Tile" }], [entry({ name: "Tile" })]);
    expect(merged[0].name).toBe("Tile 2");
  });

  it("keeps counting when the rename also collides", () => {
    const merged = mergePatterns(
      [{ name: "Tile" }, { name: "Tile 2" }],
      [entry({ name: "Tile" })],
    );
    expect(merged[0].name).toBe("Tile 3");
  });

  it("de-duplicates within one import too", () => {
    const merged = mergePatterns([], [entry({ name: "Tile" }), entry({ name: "Tile" })]);
    expect(merged.map((p) => p.name)).toEqual(["Tile", "Tile 2"]);
  });

  it("compares names case-insensitively, as a person would", () => {
    expect(mergePatterns([{ name: "tile" }], [entry({ name: "Tile" })])[0].name).toBe("Tile 2");
  });
});

describe("trimPatterns", () => {
  it("keeps everything under the budget", () => {
    const list = [meta({ id: "a", bytes: 10 }), meta({ id: "b", bytes: 10 })];
    expect(trimPatterns(list, 100)).toHaveLength(2);
  });

  it("evicts the oldest first", () => {
    const list = [
      meta({ id: "old", bytes: 60, savedAt: 1 }),
      meta({ id: "new", bytes: 60, savedAt: 2 }),
    ];
    expect(trimPatterns(list, 100).map((m) => m.id)).toEqual(["new"]);
  });

  /* Adding a tile that immediately evicts itself is a confusing way to hit a
     limit, so the one just added is never the one thrown out. */
  it("never evicts the tile just added, even if it alone exceeds the budget", () => {
    const list = [
      meta({ id: "old", bytes: 50, savedAt: 1 }),
      meta({ id: "huge", bytes: 500, savedAt: 2 }),
    ];
    const kept = trimPatterns(list, 100, "huge").map((m) => m.id);
    expect(kept).toContain("huge");
  });

  it("does not count built-ins, which store nothing", () => {
    const list = [
      ...builtinPatternMetas(),
      meta({ id: "pat-1", bytes: 90, savedAt: 5 }),
    ];
    expect(trimPatterns(list, 100).some((m) => m.id === "pat-1")).toBe(true);
  });

  it("leaves the input alone", () => {
    const list = [meta({ id: "a", bytes: 500, savedAt: 1 })];
    const before = [...list];
    trimPatterns(list, 10);
    expect(list).toEqual(before);
  });
});

describe("the built-in tiles", () => {
  it("ships a starter set, drawn rather than bundled", () => {
    expect(BUILTIN_PATTERNS.length).toBeGreaterThanOrEqual(4);
    for (const b of BUILTIN_PATTERNS) {
      expect(isBuiltinPattern(b.id)).toBe(true);
      expect(typeof b.draw).toBe("function");
      expect(b.size).toBeGreaterThan(0);
      expect(b.size).toBeLessThanOrEqual(PATTERN_MAX_EDGE);
    }
  });

  it("gives each a distinct id and a readable name", () => {
    const ids = BUILTIN_PATTERNS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of BUILTIN_PATTERNS) expect(b.name.trim().length).toBeGreaterThan(0);
  });

  it("reports them as weightless metas, so the budget ignores them", () => {
    for (const m of builtinPatternMetas()) expect(m.bytes).toBe(0);
  });
});
