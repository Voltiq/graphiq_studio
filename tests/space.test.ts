import { describe, expect, it } from "vitest";
import { isInstalled, spaceOffer, type SpaceEnv } from "../app/lib/space";

/**
 * The rule under test is one sentence: **never offer something that would do
 * nothing.** Every combination below is a platform that really exists, and the
 * failure mode in each case is the same — a button the user presses and nothing
 * happens, which teaches them the app is broken rather than that the platform
 * is limited.
 *
 * Driven here rather than in a browser because the interesting cases are the
 * ones a harness cannot produce: iPhone Safari, an installed home-screen app, a
 * Chrome that has decided the app is installable.
 */

const env = (over: Partial<SpaceEnv> = {}): SpaceEnv => ({
  displayMode: "browser",
  fullscreenEnabled: true,
  inFullscreen: false,
  installPrompt: false,
  ios: false,
  ...over,
});

describe("what to offer", () => {
  it("offers fullscreen on a desktop browser", () => {
    const o = spaceOffer(env());
    expect(o.actions).toEqual(["fullscreen"]);
    expect(o.hints).toEqual([]);
  });

  it("offers to install only once the browser has handed over a prompt", () => {
    expect(spaceOffer(env()).actions).not.toContain("install");
    expect(spaceOffer(env({ installPrompt: true })).actions).toContain("install");
  });

  /* iPhone Safari: installing exists, and no page can ask for it. Fullscreen
     does not exist at all. So there is no action to offer — only a hint. */
  it("offers iPhone Safari nothing to press, and says where to look", () => {
    const o = spaceOffer(env({ ios: true, fullscreenEnabled: false }));
    expect(o.actions).toEqual([]);
    expect(o.hints).toEqual(["ios-add-to-home"]);
  });

  /* An iPad still runs Safari but does support fullscreen, so it gets both. */
  it("…while an iPad gets fullscreen as well as the hint", () => {
    const o = spaceOffer(env({ ios: true, fullscreenEnabled: true }));
    expect(o.actions).toEqual(["fullscreen"]);
    expect(o.hints).toEqual(["ios-add-to-home"]);
  });

  it("never offers to install what is already installed", () => {
    for (const displayMode of ["standalone", "fullscreen"] as const) {
      const o = spaceOffer(env({ displayMode, installPrompt: true }));
      expect(o.actions).not.toContain("install");
      expect(o.hints).toContain("already-installed");
    }
  });

  it("…and drops the iOS hint once it is installed", () => {
    const o = spaceOffer(env({ ios: true, displayMode: "standalone", fullscreenEnabled: false }));
    expect(o.hints).not.toContain("ios-add-to-home");
    expect(o.hints).toContain("already-installed");
  });

  /* A real Install button makes the "find it in the Share menu" hint noise. */
  it("…and drops it when a real Install button is available", () => {
    const o = spaceOffer(env({ ios: true, installPrompt: true }));
    expect(o.actions).toContain("install");
    expect(o.hints).not.toContain("ios-add-to-home");
  });

  it("flips fullscreen to exit while in it", () => {
    const o = spaceOffer(env({ inFullscreen: true }));
    expect(o.actions).toEqual(["exit-fullscreen"]);
    expect(o.actions).not.toContain("fullscreen");
  });

  /* An iframe without `allow="fullscreen"` reports exactly what iPhone Safari
     does, and gets the same answer for the same reason. */
  it("offers no fullscreen where the platform says it is unavailable", () => {
    const o = spaceOffer(env({ fullscreenEnabled: false }));
    expect(o.actions).toEqual([]);
    expect(o.hints).toEqual(["nothing-to-offer"]);
  });

  /* The panel must never be empty: there is always something to say. */
  it("always says something", () => {
    const combos: SpaceEnv[] = [];
    for (const displayMode of ["browser", "minimal-ui", "standalone", "fullscreen"] as const)
      for (const fullscreenEnabled of [true, false])
        for (const inFullscreen of [true, false])
          for (const installPrompt of [true, false])
            for (const ios of [true, false])
              combos.push({ displayMode, fullscreenEnabled, inFullscreen, installPrompt, ios });
    expect(combos).toHaveLength(64);
    const silent = combos.filter((c) => {
      const o = spaceOffer(c);
      return o.actions.length === 0 && o.hints.length === 0;
    });
    expect(silent).toEqual([]);
  });

  it("never offers both directions of fullscreen at once", () => {
    for (const inFullscreen of [true, false]) {
      const a = spaceOffer(env({ inFullscreen })).actions;
      expect(a.includes("fullscreen") && a.includes("exit-fullscreen")).toBe(false);
    }
  });

  it("knows an installed window when it sees one", () => {
    expect(isInstalled({ displayMode: "standalone" })).toBe(true);
    expect(isInstalled({ displayMode: "fullscreen" })).toBe(true);
    expect(isInstalled({ displayMode: "minimal-ui" })).toBe(false);
    expect(isInstalled({ displayMode: "browser" })).toBe(false);
  });
});
