import { describe, expect, it } from "vitest";
import { visibleStage } from "../app/lib/stage-area";

describe("visibleStage", () => {
  it("is the whole stage when nothing sits on it (desktop, tablet)", () => {
    expect(visibleStage(1200, 800, { top: 0, bottom: 0, side: 0 })).toEqual({
      usableW: 1200,
      usableH: 800,
      cx: 600,
      cy: 400,
    });
  });

  it("centres between the phone's readout chip and its options card", () => {
    // 370×690 stage, 50px chip band, a 299px card floating 16px above the dock.
    const v = visibleStage(370, 690, { top: 50, bottom: 315, side: 20 });
    expect(v.usableW).toBe(330);
    expect(v.usableH).toBe(325);
    expect(v.cx).toBe(185);
    expect(v.cy).toBe(50 + 325 / 2); // not 345, the middle of the whole stage
  });

  it("never reports an empty area, however tall the chrome", () => {
    const v = visibleStage(300, 200, { top: 150, bottom: 150, side: 200 });
    expect(v.usableW).toBe(1);
    expect(v.usableH).toBe(1);
  });
});
