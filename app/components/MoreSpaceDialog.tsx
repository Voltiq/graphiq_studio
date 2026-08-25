"use client";

import { useEffect, useState } from "react";
import { Maximize2, Minimize2, Share, SquareArrowDown, X } from "lucide-react";
import styles from "./PasteDialog.module.scss";
import { readSpaceEnv, spaceOffer, type SpaceAction } from "../lib/space";

/**
 * "More space" — the one control, showing only what this platform can do.
 *
 * The decision of what to show is `spaceOffer` in lib/space.ts, driven by
 * measured facts rather than by a user-agent string. This is only its face: it
 * renders the actions as buttons, the hints as sentences, and nothing at all
 * for a route the platform reserves to itself.
 *
 * Re-read on every relevant event, because all of it can change while the
 * dialog is open: entering fullscreen flips the button to its opposite, and the
 * display mode changes the moment an installed window is opened.
 */
export default function MoreSpaceDialog({
  installPrompt,
  onInstall,
  onClose,
}: {
  /** A captured `beforeinstallprompt`, if the browser has offered one. */
  installPrompt: boolean;
  /** Fire the captured prompt. Resolves when the user has answered it. */
  onInstall: () => void;
  onClose: () => void;
}) {
  const [env, setEnv] = useState(() => readSpaceEnv(installPrompt));
  useEffect(() => {
    const refresh = () => setEnv(readSpaceEnv(installPrompt));
    refresh();
    document.addEventListener("fullscreenchange", refresh);
    const mqls = ["standalone", "fullscreen", "minimal-ui"].map((m) =>
      window.matchMedia(`(display-mode: ${m})`),
    );
    mqls.forEach((q) => q.addEventListener("change", refresh));
    return () => {
      document.removeEventListener("fullscreenchange", refresh);
      mqls.forEach((q) => q.removeEventListener("change", refresh));
    };
  }, [installPrompt]);

  const { actions, hints } = spaceOffer(env);

  const run = (a: SpaceAction) => {
    if (a === "install") onInstall();
    else if (a === "fullscreen") void document.documentElement.requestFullscreen?.().catch(() => {});
    else void document.exitFullscreen?.().catch(() => {});
  };

  const LABEL: Record<SpaceAction, { text: string; hint: string; Icon: typeof Maximize2 }> = {
    install: {
      text: "Install Graphiq",
      hint: "Opens in a window of its own, with no address bar or toolbar.",
      Icon: SquareArrowDown,
    },
    fullscreen: {
      text: "Go fullscreen",
      hint: "Hides everything the browser draws around the page.",
      Icon: Maximize2,
    },
    "exit-fullscreen": {
      text: "Leave fullscreen",
      hint: "Puts the browser's own controls back.",
      Icon: Minimize2,
    },
  };

  return (
    <div className={styles.overlay} onMouseDown={onClose}>
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label="More space"
        data-more-space
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
        }}
      >
        <header className={styles.head}>
          <h2>More space</h2>
          <button type="button" className={styles.close} onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>
        </header>

        <div className={styles.body}>
          {actions.map((a) => {
            const { text, hint, Icon } = LABEL[a];
            return (
              <div key={a}>
                <button
                  type="button"
                  className={`${styles.btn} ${styles.primary}`}
                  data-space-action={a}
                  style={{ width: "100%", justifyContent: "flex-start", gap: 10 }}
                  onClick={() => run(a)}
                >
                  <Icon size={15} />
                  <span>{text}</span>
                </button>
                <p className={styles.note} style={{ margin: "6px 0 0" }}>
                  {hint}
                </p>
              </div>
            );
          })}

          {hints.includes("ios-add-to-home") && (
            <p className={styles.note} data-space-hint="ios-add-to-home" style={{ margin: 0 }}>
              <Share size={13} style={{ verticalAlign: "-2px", marginRight: 6 }} />
              On iPhone and iPad, tap <strong>Share</strong> in Safari&rsquo;s toolbar and choose{" "}
              <strong>Add to Home Screen</strong>. Safari keeps that control to itself, so no
              button here can open it for you.
            </p>
          )}
          {hints.includes("already-installed") && (
            <p className={styles.note} data-space-hint="already-installed" style={{ margin: 0 }}>
              Graphiq is already running in its own window — the browser&rsquo;s address bar and
              toolbar are gone.
            </p>
          )}
          {hints.includes("nothing-to-offer") && (
            <p className={styles.note} data-space-hint="nothing-to-offer" style={{ margin: 0 }}>
              This browser gives no way to reclaim more room from here. Nothing is being withheld:
              there is simply nothing a page is allowed to ask for.
            </p>
          )}
        </div>

        <footer className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            Close
          </button>
        </footer>
      </div>
    </div>
  );
}
