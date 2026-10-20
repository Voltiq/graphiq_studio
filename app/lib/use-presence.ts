"use client";

import { useEffect, useState, type ReactNode } from "react";

/** How long a closing surface stays mounted for its exit (globals: --dur-exit). */
export const EXIT_MS = 150;
/** How long a folding panel body stays mounted (globals: --dur-fold). */
export const FOLD_MS = 280;

/** The user (or the OS) asked for less motion: leave at once, nothing to watch. */
function motionOff(): boolean {
  if (typeof window === "undefined") return true;
  return (
    document.documentElement.dataset.motion === "off" ||
    (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches)
  );
}

/**
 * Keep something on screen long enough to animate OUT.
 *
 * React unmounts a popup the moment its state says closed, so an exit
 * animation never gets a frame. This keeps it `mounted` for `exitMs` after
 * `open` turns false, with `closing` true meanwhile — the caller marks it
 * `data-state="closed"` (the CSS exit), and `inert` + `aria-hidden` so a
 * leaving menu can neither be clicked nor read out. Opening again mid-exit
 * simply cancels the exit.
 */
export function usePresence(open: boolean, exitMs = EXIT_MS): { mounted: boolean; closing: boolean } {
  const [mounted, setMounted] = useState(open);
  // Mount on the same render that opens (state adjusted during render, so the
  // first frame of the entrance is not lost to an effect).
  const [prev, setPrev] = useState(open);
  if (open !== prev) {
    setPrev(open);
    if (open) setMounted(true);
  }
  useEffect(() => {
    if (open || !mounted) return;
    const t = window.setTimeout(() => setMounted(false), motionOff() ? 0 : exitMs);
    return () => window.clearTimeout(t);
  }, [open, mounted, exitMs]);
  return { mounted: open || mounted, closing: !open && mounted };
}

/**
 * `usePresence` for state that IS the popup — an anchor, a node, a menu name —
 * and goes `null` to close it. While it leaves, `shown` keeps the last value,
 * so a context menu animates out from where it was, with what it said.
 */
export function useLinger<T>(value: T | null, exitMs = EXIT_MS): { shown: T | null; closing: boolean } {
  const [last, setLast] = useState<T | null>(value);
  if (value !== null && value !== last) setLast(value);
  const { mounted, closing } = usePresence(value !== null, exitMs);
  return { shown: value ?? (mounted ? last : null), closing };
}

/** `usePresence` as a wrapper, for a popup rendered inline in JSX:
 *  `<Presence open={open}>{(closing) => …}</Presence>`. */
export function Presence({
  open,
  exitMs,
  children,
}: {
  open: boolean;
  exitMs?: number;
  children: (closing: boolean) => ReactNode;
}): ReactNode {
  const { mounted, closing } = usePresence(open, exitMs);
  return mounted ? children(closing) : null;
}

/** The attributes a leaving surface wears (spread onto its root element). */
export function exitProps(closing: boolean) {
  return closing
    ? ({ "data-state": "closed", inert: true, "aria-hidden": true } as const)
    : ({ "data-state": "open" } as const);
}
