import { describe, expect, it } from "vitest";
import { workspaceOps } from "../app/commands/workspace";
import type { ViewApi } from "../app/components/CanvasArea";
import type { DockApi } from "../app/components/RightDock";
import type { CompareAxis } from "../app/lib/compare";
import { createDialogs } from "../app/state/dialogs";
import { ALL_PANELS, createView } from "../app/state/view";

/**
 * The workspace family (TODO 1.10, app/commands/workspace.ts): what the command
 * table did itself — dialogs and the tour, zoom, the view flags, compare, proof,
 * gamut, the HUD, the panels — against the dialog and view stores, and state
 * held the way Editor holds it.
 */

function editor(mounted = true) {
  const dialogs = createDialogs();
  const view = createView();
  const calls: string[] = [];
  let tour = "off";
  let split: number | null = null;
  let axis: CompareAxis = "vertical";
  let proof = false;
  let gamut = false;
  let hud = false;
  const viewApiRef = {
    current: mounted
      ? ({
          zoomIn: () => calls.push("in"),
          zoomOut: () => calls.push("out"),
          fit: () => calls.push("fit"),
          zoom100: () => calls.push("100"),
        } as unknown as ViewApi)
      : null,
  };
  const dockRef = {
    current: mounted ? ({ apply: (l: unknown) => calls.push(`dock ${l}`) } as unknown as DockApi) : null,
  };
  const ops = workspaceOps({
    dialogs,
    view,
    viewApiRef,
    dockRef,
    setTour: (t) => (tour = t),
    setCompareSplit: (f) => (split = f(split)),
    setCompareAxis: (f) => (axis = f(axis)),
    setProofColors: (f) => (proof = f(proof)),
    setGamutWarn: (f) => (gamut = f(gamut)),
    setPerfHud: (f) => (hud = f(hud)),
  });
  const read = () => ({ tour, split, axis, proof, gamut, hud });
  return { dialogs, view, calls, ops, read };
}

describe("the workspace operations", () => {
  it("open a dialog in the dialog store, and the tour as the tour", () => {
    const e = editor();
    e.ops.open("new-guide");
    e.ops.open("save-as");
    expect([e.dialogs.get().newGuide, e.dialogs.get().saveAs, e.read().tour]).toEqual([true, true, "off"]);
    e.ops.open("tour");
    expect(e.read().tour).toBe("open");
  });

  it("zoom by the step asked, and do nothing before the canvas mounts", () => {
    const e = editor();
    for (const s of ["in", "out", "fit", "100"] as const) e.ops.zoom(s);
    expect(e.calls).toEqual(["in", "out", "fit", "100"]);
    const early = editor(false);
    early.ops.zoom("in");
    early.ops.resetWorkspace();
    expect(early.calls).toEqual([]);
  });

  it("flip one view flag each, leaving the others", () => {
    const e = editor();
    const before = e.view.get();
    e.ops.toggleView("rulers");
    e.ops.toggleView("grid");
    expect({ ...e.view.get(), rulers: before.rulers, grid: before.grid }).toEqual(before);
    expect([e.view.get().rulers, e.view.get().grid]).toEqual([!before.rulers, !before.grid]);
    e.ops.toggleView("rulers");
    expect(e.view.get().rulers).toBe(before.rulers);
  });

  it("compare splits at the middle and back; its axis, proof, gamut and the HUD flip", () => {
    const e = editor();
    e.ops.toggleCompare();
    e.ops.toggleCompareAxis();
    e.ops.toggleProof();
    e.ops.toggleGamut();
    e.ops.togglePerfHud();
    expect(e.read()).toEqual({ tour: "off", split: 50, axis: "horizontal", proof: true, gamut: true, hud: true });
    e.ops.toggleCompare();
    e.ops.toggleCompareAxis();
    e.ops.toggleProof();
    e.ops.toggleGamut();
    e.ops.togglePerfHud();
    expect(e.read()).toEqual({ tour: "off", split: null, axis: "vertical", proof: false, gamut: false, hud: false });
  });

  it("show or hide one panel; the reset shows them all, in the factory layout", () => {
    const e = editor();
    e.ops.togglePanel("layers");
    e.ops.togglePanel("history");
    expect(e.view.get().panels).toEqual({ ...ALL_PANELS, layers: false, history: false });
    e.ops.togglePanel("layers");
    expect(e.view.get().panels).toEqual({ ...ALL_PANELS, history: false });
    e.ops.resetWorkspace();
    expect([e.view.get().panels, e.calls]).toEqual([ALL_PANELS, ["dock null"]]);
  });
});
