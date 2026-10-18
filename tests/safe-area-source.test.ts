/**
 * The safe-area tokens are the ONLY way the layout reaches the display's
 * unusable edges. (The source half of the safe-area rail; the geometry half is
 * e2e/safe-area.spec.ts.)
 *
 * `env(safe-area-inset-*)` once appeared at five call sites and covered only
 * the bottom. It now lives in four token definitions, `--safe-t/r/b/l`, and
 * everything else reads those — or the derived `--chrome-top/bottom` offsets.
 * A new hand-rolled use would work on the device it was written on and drift
 * from every other surface, so it is caught here instead.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const APP = join(__dirname, "..", "app");
const files = (dir: string, ext: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(dir, e.name), ext) : e.name.endsWith(ext) ? [join(dir, e.name)] : [],
  );
const lines = (ext: string) =>
  files(APP, ext).flatMap((f) =>
    readFileSync(f, "utf8")
      .split("\n")
      .map((line) => ({ at: relative(APP, f).split("\\").join("/"), line: line.trim() })),
  );

describe("safe-area tokens", () => {
  const scss = lines(".scss");

  it("env(safe-area-inset) survives only in the four token definitions", () => {
    const uses = scss.filter((l) => l.line.includes("env(safe-area-inset"));
    expect(uses.map((u) => `${u.at}: ${u.line}`)).toHaveLength(4);
    for (const u of uses) {
      expect(u.at).toBe("globals.scss");
      expect(u.line).toMatch(/^--safe-[trbl]:/);
    }
  });

  it("no offset re-adds the chrome heights by hand", () => {
    const stray = scss.filter(
      (l) =>
        !/^--(chrome|safe)-/.test(l.line) && // the token definitions are where they belong
        (/var\(--topbar-h\)\s*\+\s*var\(--optionsbar-h\)/.test(l.line) || /var\(--mobilebar-h\)\s*\+/.test(l.line)),
    );
    expect(stray.map((u) => `${u.at}: ${u.line}`)).toEqual([]);
  });

  it("every popup clamps to the safe box, not to the whole display", () => {
    // Popups place from JS, so their hand-rolled env() is a clamp against
    // window.innerWidth — the whole display, cutouts included.
    const stray = lines(".tsx").filter((l) => l.line.includes("window.innerWidth") && l.line.includes("Math.min"));
    expect(stray.map((u) => `${u.at}: ${u.line}`)).toEqual([]);
  });
});
