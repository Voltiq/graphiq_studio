import { describe, expect, it } from "vitest";
import { brushKey, stepHardness, stepSize } from "../app/lib/brush-keys";

describe("brushKey", () => {
  it("maps brackets to size and braces to hardness", () => {
    expect(brushKey("]")).toEqual({ kind: "size", dir: 1 });
    expect(brushKey("[")).toEqual({ kind: "size", dir: -1 });
    expect(brushKey("}")).toEqual({ kind: "hardness", dir: 1 });
    expect(brushKey("{")).toEqual({ kind: "hardness", dir: -1 });
  });

  it("maps digits to a percentage, with 0 meaning 100%", () => {
    expect(brushKey("1")).toEqual({ kind: "percent", value: 10 });
    expect(brushKey("5")).toEqual({ kind: "percent", value: 50 });
    expect(brushKey("0")).toEqual({ kind: "percent", value: 100 });
  });

  it("ignores everything else", () => {
    for (const k of ["b", "Enter", "10", "", "F1", "]]"]) expect(brushKey(k)).toBeNull();
  });
});

describe("stepSize", () => {
  it("moves by about a tenth of the size", () => {
    expect(stepSize(100, 1)).toBe(110);
    expect(stepSize(100, -1)).toBe(90);
    expect(stepSize(24, 1)).toBe(26);
  });

  it("never moves by less than one pixel", () => {
    expect(stepSize(3, 1)).toBe(4);
    expect(stepSize(3, -1)).toBe(2);
  });

  it("stays inside the tool's range", () => {
    expect(stepSize(1, -1)).toBe(1);
    expect(stepSize(495, 1)).toBe(500);
    expect(stepSize(5, -1, 4, 300)).toBe(4);
    expect(stepSize(195, 1, 6, 200)).toBe(200);
  });
});

describe("stepHardness", () => {
  it("moves by 10 within 0–100", () => {
    expect(stepHardness(80, 1)).toBe(90);
    expect(stepHardness(95, 1)).toBe(100);
    expect(stepHardness(5, -1)).toBe(0);
  });
});
