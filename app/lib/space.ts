/**
 * What "more space" can actually mean, on the platform you are actually on.
 *
 * The browser's chrome is ~110px of a phone screen, and every route to getting
 * it back is available somewhere and not somewhere else:
 *
 *   INSTALLING gives a standalone window on Android and on iOS — but Android
 *   only lets a page ask (`beforeinstallprompt`) when the browser has decided
 *   the app is installable, and Chrome will not fire that event at all without
 *   a service worker. iOS never fires it: Add to Home Screen lives in Safari's
 *   own Share menu and no page can open it.
 *
 *   FULLSCREEN works on Android and on desktop. It does not work on iPhone
 *   Safari, which supports no element fullscreen at all — and says so, through
 *   `document.fullscreenEnabled`, so no user-agent sniffing is needed to know
 *   it. An iframe without `allow="fullscreen"` reports the same thing, which is
 *   the same answer for the same reason.
 *
 *   ORIENTATION LOCK is only permitted while already fullscreen, and is
 *   unsupported on the device where a locked orientation would matter most, so
 *   it is not offered at all.
 *
 *   SCROLLING TO HIDE THE URL BAR cannot work here whatever the platform: the
 *   shell is `height: 100svh; overflow: hidden` and never scrolls, so there is
 *   no scroll for the browser to react to. Offering it would be offering a
 *   no-op.
 *
 * The rule this file exists to enforce is the item's: **never show an option
 * that would do nothing**. Guidance is separate from an action — telling an
 * iPhone user where Add to Home Screen lives is useful, and a button that
 * cannot open it is not.
 *
 * Pure, so `tests/space.test.ts` can drive every combination without a browser.
 */

/** Something the app can DO when you press it. */
export type SpaceAction = "install" | "fullscreen" | "exit-fullscreen";

/** Something the app can only TELL you, because the platform reserves it. */
export type SpaceHint = "ios-add-to-home" | "already-installed" | "nothing-to-offer";

export interface SpaceEnv {
  /** The first matching `(display-mode: …)`. */
  displayMode: "browser" | "minimal-ui" | "standalone" | "fullscreen";
  /** `document.fullscreenEnabled` — false on iPhone Safari and in a sandboxed frame. */
  fullscreenEnabled: boolean;
  /** Currently in element fullscreen. */
  inFullscreen: boolean;
  /** A `beforeinstallprompt` was captured and has not been used. */
  installPrompt: boolean;
  /** Safari on an iOS device: the platform where installing exists but cannot be asked for. */
  ios: boolean;
}

export interface SpaceOffer {
  actions: SpaceAction[];
  hints: SpaceHint[];
}

/** Is the app already in a window of its own? */
export function isInstalled(env: Pick<SpaceEnv, "displayMode">): boolean {
  return env.displayMode === "standalone" || env.displayMode === "fullscreen";
}

/**
 * What to offer, given what is true.
 *
 * Actions are things that will happen; hints are things the user must do
 * themselves. An empty `actions` with a hint is a legitimate answer — it is the
 * honest one on iPhone Safari — and an empty everything is not: there is always
 * something to say, even if it is "you already have all of it".
 */
export function spaceOffer(env: SpaceEnv): SpaceOffer {
  const actions: SpaceAction[] = [];
  const hints: SpaceHint[] = [];
  const installed = isInstalled(env);

  /* Installing. Only when the browser has actually handed over a prompt — the
     event is the permission, not a hint that one might be granted. Never when
     already installed: there is nothing left to install into. */
  if (!installed && env.installPrompt) actions.push("install");

  /* Fullscreen, in whichever direction applies. `fullscreenEnabled` is the
     platform's own answer; on iPhone Safari it is false and nothing is added. */
  if (env.fullscreenEnabled) actions.push(env.inFullscreen ? "exit-fullscreen" : "fullscreen");

  /* iOS can be installed but never asked. Say where the control is instead —
     and only while it would help: not once installed, and not on a platform
     that has already offered a real Install button. */
  if (env.ios && !installed && !env.installPrompt) hints.push("ios-add-to-home");

  if (installed) hints.push("already-installed");
  /* Nothing to do and nothing to suggest: still say so rather than showing an
     empty panel. */
  if (!actions.length && !hints.length) hints.push("nothing-to-offer");

  return { actions, hints };
}

/**
 * The event Chrome fires when it has decided the app is installable. Not part
 * of lib.dom because it is Chromium's own, which is also the shape of the
 * problem: it is the ONLY way a page can open the install flow, it must be
 * caught before its default runs, and it fires once or never.
 */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<unknown>;
}

/** Read the live environment. Kept beside the model so both change together. */
export function readSpaceEnv(installPrompt: boolean): SpaceEnv {
  const modes = ["fullscreen", "standalone", "minimal-ui", "browser"] as const;
  const displayMode =
    modes.find((m) => window.matchMedia(`(display-mode: ${m})`).matches) ?? "browser";
  /* `navigator.standalone` is Safari's own, older answer to the same question,
     and the only one iOS gives for a home-screen launch. */
  const iosStandalone =
    "standalone" in navigator && (navigator as unknown as { standalone?: boolean }).standalone === true;
  return {
    displayMode: iosStandalone ? "standalone" : displayMode,
    fullscreenEnabled: !!document.fullscreenEnabled,
    inFullscreen: !!document.fullscreenElement,
    installPrompt,
    /* iPadOS reports itself as a Mac, so the touch count is what separates a
       modern iPad from a desktop Safari. */
    ios:
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1),
  };
}
