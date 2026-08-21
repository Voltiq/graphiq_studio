"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowLeftRight,
  ClipboardPaste,
  Code,
  Copy,
  MoreHorizontal,
  Plus,
  RotateCcw,
} from "lucide-react";
import styles from "../RightDock.module.scss";
import { parseColor, toHex6, toHex8, toRgbaCss } from "../../lib/color";
import { addSwatch } from "../../lib/swatches";
import { clampX } from "../../lib/safeArea";

/** Exactly the syntaxes parseColor understands — used to reject clipboard text
 *  BEFORE parsing, since parseColor falls back to black for anything it can't
 *  read (which would silently look like "pasted black"). */
const COLOR_TEXT = /^\s*(#?(?:[0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})|rgba?\([^)]*\))\s*$/i;

/**
 * The Color panel's header "⋯" menu: clipboard interchange for the active
 * colour (the panel itself has no other route in or out of the app), plus the
 * swatch/swap/reset verbs that belong to the colour pair as a whole.
 */
export default function ColorPanelMenu({
  foreground,
  background,
  onForeground,
  onBackground,
  active,
  onToast,
}: {
  foreground: string;
  background: string;
  onForeground: (c: string) => void;
  onBackground: (c: string) => void;
  active: "primary" | "secondary";
  onToast: (message: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ left: 0, top: 0 });
  const btnRef = useRef<HTMLButtonElement>(null);

  const color = active === "primary" ? foreground : background;
  const setColor = active === "primary" ? onForeground : onBackground;
  const slot = active === "primary" ? "Primary" : "Secondary";

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const toggle = () => {
    if (!open && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect();
      // Right-align the menu to the button; keep it on screen.
      setPos({
        left: clampX(r.right - 200, 200),
        top: r.bottom + 4,
      });
    }
    setOpen((o) => !o);
  };
  /** Every item closes the menu, mirroring the Layers panel's context menu. */
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      onToast(`Copied ${text}`);
    } catch {
      onToast("Clipboard write was blocked by the browser.");
    }
  };

  const paste = async () => {
    try {
      const text = await navigator.clipboard.readText();
      if (!COLOR_TEXT.test(text)) {
        onToast("Clipboard has no colour — copy a hex or rgb() value first.");
        return;
      }
      const c = parseColor(text.trim());
      setColor(toHex8(c));
      onToast(`Pasted ${toHex6(c).toUpperCase()} into ${slot}`);
    } catch {
      onToast("Clipboard read was blocked by the browser.");
    }
  };

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={styles.headBtn}
        title="More colour actions"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={toggle}
      >
        <MoreHorizontal size={14} />
      </button>
      {open &&
        typeof document !== "undefined" &&
        createPortal(
          <>
            <div className={styles.menuScrim} onClick={() => setOpen(false)} />
            <div
              className={styles.layerMenu}
              style={{ left: pos.left, top: pos.top }}
              role="menu"
              aria-label="Colour actions"
            >
              <button type="button" onClick={() => run(() => copy(toHex6(parseColor(color)).toUpperCase()))}>
                <Copy size={13} /> Copy hex
              </button>
              <button type="button" onClick={() => run(() => copy(toRgbaCss(parseColor(color))))}>
                <Code size={13} /> Copy CSS rgba()
              </button>
              <button type="button" onClick={() => run(paste)}>
                <ClipboardPaste size={13} /> Paste colour
              </button>
              <div className={styles.menuSep} />
              <button
                type="button"
                onClick={() =>
                  run(() => {
                    addSwatch(toHex8(parseColor(color)));
                    onToast(`Added ${toHex6(parseColor(color)).toUpperCase()} to swatches`);
                  })
                }
              >
                <Plus size={13} /> Add {slot.toLowerCase()} to swatches
              </button>
              <button
                type="button"
                onClick={() =>
                  run(() => {
                    const f = foreground;
                    onForeground(background);
                    onBackground(f);
                  })
                }
              >
                <ArrowLeftRight size={13} /> Swap primary & secondary
              </button>
              <div className={styles.menuSep} />
              <button
                type="button"
                onClick={() =>
                  run(() => {
                    onForeground("#000000ff");
                    onBackground("#ffffffff");
                  })
                }
              >
                <RotateCcw size={13} /> Reset to black & white
              </button>
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
