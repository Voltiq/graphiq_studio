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
