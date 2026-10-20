/**
 * The shell sizes itself to the SMALL viewport and the containing block —
 * the half of the viewport rail that geometry cannot see. (The geometry half
 * is e2e/viewport.spec.ts.)
 *
 * In a desktop Chromium `vh`, `svh`, `lvh` and `dvh` all resolve to the same
 * number and nothing emulates a collapsing URL bar, so reverting `100svh` to
 * `100vh` changes no measurement anywhere. On a phone it makes the shell
 * taller than what is visible whenever the bar is showing.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "..", "app", "components", "Editor.module.scss"), "utf8");
const start = css.indexOf(".app {");
const rule = css.slice(start, css.indexOf("}", start));

describe("the shell's .app rule", () => {
  it("exists", () => {
    expect(start).toBeGreaterThanOrEqual(0);
  });

  it("asks for the small viewport, not the large one", () => {
    expect(rule).toMatch(/height:\s*100svh/);
    expect(rule).not.toMatch(/height:\s*100(d|l)?vh/);
  });

  it("sizes its width without counting a scrollbar", () => {
    expect(rule).toMatch(/width:\s*100%/);
    expect(rule).not.toMatch(/width:\s*100vw/);
  });
});

/* The phone's panels sheet is anchored to the bottom and sized in viewport
   units, so a LARGE-viewport height is taller than what Safari shows: the
   excess went off the top of the screen, taking the grip and the panel chips
   with it (reported on an iPhone 13 mini, where the gap is ~100px). */
const globals = readFileSync(join(__dirname, "..", "app", "globals.scss"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
const phone = globals.slice(globals.indexOf('html[data-mobile="true"] {'));
const sheetDecls = [...phone.matchAll(/^\s*(--sheet-h|max-height):[^;{]*;/gm)]
  .map((m) => m[0].trim())
  .filter((d) => d.startsWith("--sheet-h") || d.includes("--m-drawer-bottom"));

describe("the phone's panels sheet", () => {
  it("has its detents and its cap", () => {
    // default, peek, half and full, plus the cap on the dock itself
    expect(sheetDecls.length).toBeGreaterThanOrEqual(5);
  });

  it("measures every one of them against the small viewport", () => {
    for (const d of sheetDecls) {
      expect(d, d).toMatch(/svh/);
      expect(d, d).not.toMatch(/\d(d|l)?vh\b/);
    }
  });
});
