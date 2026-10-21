"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
} from "react";
import styles from "./TourOverlay.module.scss";
import TourArt from "./TourArt";
import { passesThrough, tourSteps, type TourStep, type TourTip, type TourWatch } from "../lib/tour";
import { isShown, placeCard, spotlight, type Box } from "../lib/tour-layout";
import { uiZoom } from "../lib/ui-scale";
import { safeInsets, visibleBand } from "../lib/safeArea";
import { motionOff } from "../lib/use-presence";

/** How long the tour takes to leave: the dim lifting, the card sinking away. */
const LEAVE_MS = 220;
/** How long the outgoing stop lingers while the next one slides in. */
const SWAP_MS = 190;

/** What the tour knows about the page, in client px. */
interface Geo {
  /** The visible area: the viewport less the safe-area insets and a keyboard. */
  view: Box;
  /** The stop's target — null for a centred stop, or when it is not on screen. */
  rect: Box | null;
  /** The target's corner radius. */
  radius: number;
  /** Where a try-it lets you through to the app. */
  hit: Box | null;
}

const viewNow = (): Box => {
  const band = visibleBand();
  const ins = safeInsets();
  return { x: ins.left, y: band.top, w: window.innerWidth - ins.left - ins.right, h: band.bottom - band.top };
};

const boxOf = (r: DOMRect): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });

const union = (boxes: Box[]): Box | null => {
  if (!boxes.length) return null;
  const x0 = Math.min(...boxes.map((b) => b.x));
  const y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w));
  const y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};

const targetOf = (s: TourStep) =>
  s.target ? document.querySelector<HTMLElement>(`[data-tour="${s.target}"]`) : null;

/** Can this stop be shown — is its chrome on screen (or does it need none)? */
const available = (s: TourStep, view: Box) => {
  if (!s.target) return true;
  const el = targetOf(s);
  return !!el && isShown(boxOf(el.getBoundingClientRect()), view);
};

/** The lap for this shell, less the stops with nothing on screen to point at. */
const lapFor = (mobile: boolean) => {
  const view = viewNow();
  return tourSteps(mobile).filter((s) => available(s, view));
};

/**
 * The page as the current stop sees it. A target can mark the part of itself
 * worth outlining with `data-tour-spot` — the phone's bottom bar is the whole
 * foot of the screen, its dock the pill floating in it — and the spotlight is
 * drawn round that instead.
 */
function measure(s: TourStep): Geo {
  const view = viewNow();
  const el = targetOf(s);
  const shape = el?.querySelector<HTMLElement>("[data-tour-spot]") ?? el;
  const rect = shape ? boxOf(shape.getBoundingClientRect()) : null;
  if (!el || !shape || !rect || !isShown(rect, view)) return { view, rect: null, radius: 0, hit: null };
  const radius = parseFloat(getComputedStyle(shape).borderTopLeftRadius) || 0;
  let hit: Box | null = null;
  if (s.try) {
    const parts = s.try.hit ? [...el.querySelectorAll(s.try.hit)] : [shape];
    hit = union(parts.map((p) => boxOf(p.getBoundingClientRect())));
  }
  return { view, rect, radius, hit };
}

const near = (a: number, b: number) => Math.abs(a - b) < 0.5;
const sameBox = (a: Box | null, b: Box | null) =>
  a === b || (!!a && !!b && near(a.x, b.x) && near(a.y, b.y) && near(a.w, b.w) && near(a.h, b.h));
const sameGeo = (a: Geo, b: Geo) =>
  sameBox(a.view, b.view) && sameBox(a.rect, b.rect) && near(a.radius, b.radius) && sameBox(a.hit, b.hit);

const inside = (b: Box, x: number, y: number) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h;

/** A tip: its keys as key caps ("Ctrl+K" a chord, entries alternatives), then what they do. */
function Tip({ tip }: { tip: TourTip }) {
  return (
    <li className={styles.tip}>
      {tip.keys ? (
        <span className={styles.keys}>
          {tip.keys.map((k, i) => (
            <Fragment key={k}>
              {i > 0 && (
                <span className={styles.or} aria-label="or">
                  /
                </span>
              )}
              {k.split("+").map((part, j) => (
                <Fragment key={j}>
                  {j > 0 && <span className={styles.plus}>+</span>}
                  <kbd className={styles.kbd}>{part}</kbd>
                </Fragment>
              ))}
            </Fragment>
          ))}
        </span>
      ) : (
        <span className={styles.bullet} aria-hidden />
      )}
      <span className={styles.tipText}>{tip.text}</span>
    </li>
  );
}

const Check = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
    <path
      d="M3.5 8.4 L6.6 11.4 L12.6 4.8"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

const Spark = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" aria-hidden>
    <path
      d="M8 1.5 C8.6 6 10 7.4 14.5 8 C10 8.6 8.6 10 8 14.5 C7.4 10 6 8.6 1.5 8 C6 7.4 7.4 6 8 1.5 Z"
      fill="currentColor"
    />
  </svg>
);

/**
 * The onboarding tour: a spotlight over the live chrome and a card that walks
 * you round it.
 *
 * THE SPOTLIGHT is a hole whose giant shadow dims everything else. It is
 * measured every frame — the chrome moves as panels open, the options bar
 * changes with the tool — and glides from stop to stop on the gentle spring,
 * closing to a point behind the card for a centred stop. A ring round it
 * breathes, and a ripple marks each arrival.
 *
 * THE CARD stands beside its target (see tour-layout), a caret pointing back at
 * it, and travels on the same spring. Its height follows the stop it shows;
 * the stops themselves slide past each other in the direction of travel, the
 * outgoing one lingering just long enough to be seen leaving.
 *
 * TRY-ITS: a stop can ask you to do something — change the tool, zoom. The
 * spotlight then lets you through (the pointer, or only the wheel where a click
 * would paint), the keys the task needs reach the editor, and the card notices
 * when it is done (`watch`, compared with what was true when the stop opened).
 *
 * The overlay sits in the zoomed chrome subtree, so every client-px position
 * is divided by `uiZoom()` on its way into a style — the popups' rule.
 */
export default function TourOverlay({
  mobile = false,
  watch,
  onClose,
  onOpenSample,
}: {
  /** Picks the lap: the phone walks its own (see lib/tour). */
  mobile?: boolean;
  /** What the try-its watch, read from the editor as it changes. */
  watch: TourWatch;
  /** The tour has gone (finished or skipped — the caller marks it seen either way). */
  onClose: () => void;
  /** Create and open the sample document (offered on the last stop). */
  onOpenSample: () => void;
}) {
  // The lap, taken as the tour opens: a stop whose chrome is not on screen
  // then — a hidden panel, a tablet's closed dock — is left out, not shown
  // pointing at nothing. Taken again if the shell changes under it.
  const [lap, setLap] = useState<TourStep[]>(() => lapFor(mobile));
  const [lapMobile, setLapMobile] = useState(mobile);
  const [index, setIndex] = useState(0);
  if (lapMobile !== mobile) {
    const next = lapFor(mobile);
    const id = lap[index]?.id;
    setLapMobile(mobile);
    setLap(next);
    setIndex(Math.max(0, next.findIndex((s) => s.id === id)));
  }
  const step = lap[Math.min(index, lap.length - 1)];
  const last = index >= lap.length - 1;

  const [dir, setDir] = useState<1 | -1>(1);
  /** The stop sliding out, while it does. */
  const [leaving, setLeaving] = useState<{ index: number; dir: 1 | -1 } | null>(null);
  /** Has the tour moved yet? The first stop arrives with the card, not after it. */
  const [moved, setMoved] = useState(false);
  /** What was true when this stop opened — what a try-it measures against. */
  const [start, setStart] = useState<TourWatch>(watch);
  /** Try-its done, by stop: done stays done if you go back. */
  const [doneIds, setDoneIds] = useState<ReadonlySet<string>>(() => new Set());
  const [closing, setClosing] = useState(false);
  const [geo, setGeo] = useState<Geo>(() => measure(step));
  const [paneH, setPaneH] = useState<number | null>(null);
  const [chromeH, setChromeH] = useState(0);
  const [cardW, setCardW] = useState(0);
  /** Off for the first frame, so nothing glides in from the corner. */
  const [ready, setReady] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const paneRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const closingRef = useRef(false);
  const swipeRef = useRef<{ x: number; y: number; id: number } | null>(null);
  // For the native listeners, which outlive a render.
  const watchRef = useRef(watch);
  const geoRef = useRef(geo);
  const stepRef = useRef(step);
  useEffect(() => {
    watchRef.current = watch;
    geoRef.current = geo;
    stepRef.current = step;
  });

  const tryDone = !!step.try && (doneIds.has(step.id) || step.try.done(watch, start));
  if (tryDone && !doneIds.has(step.id)) setDoneIds(new Set(doneIds).add(step.id));

  // The target, followed every frame: setGeo bails out unless it moved. The
  // first measure is before paint, so a new stop never shows a frame of the
  // last one's geometry (with motion reduced, that frame would be all of it).
  useLayoutEffect(() => {
    let raf = 0;
    const tick = () => {
      const g = measure(step);
      setGeo((old) => (sameGeo(old, g) ? old : g));
      raf = requestAnimationFrame(tick);
    };
    tick();
    return () => cancelAnimationFrame(raf);
  }, [step]);

  // The stop's own height, which the stage grows or shrinks to.
  useLayoutEffect(() => {
    const pane = paneRef.current;
    if (!pane) return;
    const read = () => setPaneH(pane.offsetHeight);
    read();
    const ro = new ResizeObserver(read);
    ro.observe(pane);
    return () => ro.disconnect();
  }, [index, lap]);

  // The card's width and everything in it but the stage: with the stage's
  // TARGET height, that is the card's size once it has settled — what it is
  // placed by, rather than the size it has mid-animation.
  useLayoutEffect(() => {
    const card = cardRef.current;
    const stage = stageRef.current;
    if (!card || !stage) return;
    const read = () => {
      setChromeH(card.offsetHeight - stage.offsetHeight);
      setCardW(card.offsetWidth);
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(card);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const r = requestAnimationFrame(() => setReady(true));
    return () => cancelAnimationFrame(r);
  }, []);

  useEffect(() => {
    if (!leaving) return;
    const t = window.setTimeout(() => setLeaving(null), SWAP_MS);
    return () => window.clearTimeout(t);
  }, [leaving]);

  const go = useCallback(
    (to: number) => {
      if (to < 0 || to >= lap.length || to === index || closingRef.current) return;
      const d = to > index ? 1 : -1;
      setDir(d);
      setLeaving(motionOff() ? null : { index, dir: d });
      setIndex(to);
      setMoved(true);
      setStart(watchRef.current);
    },
    [index, lap.length],
  );

  const leaveTimer = useRef(0);
  const leave = useCallback(
    (then?: () => void) => {
      if (closingRef.current) return;
      closingRef.current = true;
      setClosing(true);
      then?.();
      leaveTimer.current = window.setTimeout(onClose, motionOff() ? 0 : LEAVE_MS);
    },
    [onClose],
  );
  useEffect(() => () => window.clearTimeout(leaveTimer.current), []);

  // The keyboard. ← → step, Enter goes on, Esc leaves, Tab stays in the card.
  // Everything else is the tour's too — except, on a try-it, the keys it asks
  // for, which go on to the editor.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (step.try && passesThrough(e)) return;
      e.stopImmediatePropagation();
      const card = cardRef.current;
      if (e.key === "Escape") {
        e.preventDefault();
        leave();
      } else if (e.key === "ArrowRight" || e.key === "Enter") {
        // A focused button in the card takes its own Enter (Back, Skip…).
        if (e.key === "Enter" && e.target instanceof HTMLButtonElement && card?.contains(e.target)) return;
        e.preventDefault();
        if (last) leave();
        else go(index + 1);
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(index - 1);
      } else if (e.key === "Tab" && card) {
        const items = [...card.querySelectorAll<HTMLElement>("button:not(:disabled)")].filter((b) => b.tabIndex >= 0);
        if (!items.length) return;
        e.preventDefault();
        const at = items.indexOf(document.activeElement as HTMLElement);
        const n = items.length;
        items[e.shiftKey ? (at <= 0 ? n - 1 : at - 1) : (at + 1) % n].focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [step, last, index, go, leave]);

  // The wheel never reaches the page behind (Ctrl+wheel would zoom the whole
  // browser) — except over a "wheel" try-it's spotlight, where it is handed on
  // to whatever is underneath: the canvas zooms, and a click still cannot paint.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const g = geoRef.current;
      if (stepRef.current.try?.reach !== "wheel" || !g.hit || !inside(g.hit, e.clientX, e.clientY)) return;
      if (cardRef.current?.contains(e.target as Node)) return;
      const under = document.elementsFromPoint(e.clientX, e.clientY).find((el) => !root.contains(el));
      under?.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: e.clientX,
          clientY: e.clientY,
          screenX: e.screenX,
          screenY: e.screenY,
          deltaX: e.deltaX,
          deltaY: e.deltaY,
          deltaZ: e.deltaZ,
          deltaMode: e.deltaMode,
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          altKey: e.altKey,
          metaKey: e.metaKey,
        }),
      );
    };
    root.addEventListener("wheel", onWheel, { passive: false });
    return () => root.removeEventListener("wheel", onWheel);
  }, []);

  // Focus: given back when the tour goes (so taken note of first, before the
  // card has it), and on the way forward at every stop.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    return () => {
      if (before?.isConnected) before.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => {
    primaryRef.current?.focus({ preventScroll: true });
  }, [index]);

  // A swipe across the card, on a touch screen, turns the page.
  const onSwipeStart = (e: ReactPointerEvent) => {
    if (e.pointerType !== "mouse") swipeRef.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
  };
  const onSwipeEnd = (e: ReactPointerEvent) => {
    const s0 = swipeRef.current;
    swipeRef.current = null;
    if (!s0 || s0.id !== e.pointerId) return;
    const dx = e.clientX - s0.x;
    const dy = e.clientY - s0.y;
    if (Math.abs(dx) < 48 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
    if (dx < 0 && !last) go(index + 1);
    else if (dx > 0) go(index - 1);
  };

  // ---- Geometry: client px in, local px (÷ zoom) out ----------------------
  const z = uiZoom();
  const card = { w: cardW * z, h: (chromeH + (paneH ?? 0)) * z };
  const place = placeCard(geo.rect, card, geo.view);
  const hole = geo.rect
    ? spotlight(geo.rect, geo.radius, geo.view)
    : // A centred stop: the spotlight closes to a point behind the card.
      { x: place.x + card.w / 2, y: place.y + card.h / 2, w: 0, h: 0, r: 0 };
  const holeStyle: CSSProperties = {
    transform: `translate(${hole.x / z}px, ${hole.y / z}px)`,
    width: hole.w / z,
    height: hole.h / z,
    borderRadius: hole.r / z,
  };
  const reach = step.try && geo.hit ? (step.try.reach ?? "pointer") : null;
  const hit = reach === "pointer" ? geo.hit : null;

  const pane = (i: number, phase: "in" | "out", d: 1 | -1) => {
    const s = lap[i];
    const done = !!s.try && (doneIds.has(s.id) || (i === index && tryDone));
    return (
      <div
        key={s.id}
        ref={phase === "in" ? paneRef : undefined}
        className={styles.pane}
        data-phase={phase}
        data-dir={d > 0 ? "fwd" : "back"}
        data-step={s.id}
        aria-hidden={phase === "out" || undefined}
      >
        <div className={styles.artBox}>
          <TourArt id={s.art} mobile={mobile} />
        </div>
        <div className={styles.text}>
          <p className={styles.eyebrow}>
            {s.eyebrow}
            <span className={styles.count}>
              {" "}
              · {i + 1} of {lap.length}
            </span>
          </p>
          <h2 className={styles.title} data-part="title">
            {s.title}
          </h2>
          <p className={styles.body}>{s.body}</p>
        </div>
        {s.tips && (
          <ul className={styles.tips} data-sheet={s.sheet || undefined}>
            {s.tips.map((t) => (
              <Tip key={t.text} tip={t} />
            ))}
          </ul>
        )}
        {s.try && (
          <div className={styles.try} data-part="try" data-done={done}>
            <span className={styles.tryIcon} aria-hidden>
              {done ? <Check /> : <Spark />}
            </span>
            <span className={styles.tryText} role={phase === "in" ? "status" : undefined}>
              <span className={styles.tryPrompt} aria-hidden={done || undefined}>
                {s.try.prompt}
              </span>
              <span className={styles.tryPraise} aria-hidden={!done || undefined}>
                {s.try.praise}
              </span>
            </span>
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className={styles.tour}
      role="dialog"
      aria-modal="true"
      aria-label="Interactive tour"
      data-state={closing ? "closed" : "open"}
      // The glides are switched on only once the first frame is down — and not
      // at all with motion reduced: the global rule cuts a transition to
      // 0.01ms, but that still lands a frame late, and here it can just land.
      data-ready={ready && !motionOff()}
      data-reach={hit ? "pointer" : undefined}
    >
      <div className={styles.hole} data-part="spotlight" data-on={!!geo.rect} style={holeStyle} />
      <div className={styles.ring} data-on={!!geo.rect} style={holeStyle} />
      {geo.rect && <div key={`ping-${step.id}`} className={styles.ping} style={holeStyle} />}

      {/* On a pointer try-it, the dim around the spotlight still blocks; the
          spotlight itself is a window onto the app. */}
      {hit && (
        <>
          <div className={styles.shield} style={{ left: 0, right: 0, top: 0, height: Math.max(0, hit.y / z) }} />
          <div className={styles.shield} style={{ left: 0, right: 0, top: (hit.y + hit.h) / z, bottom: 0 }} />
          <div
            className={styles.shield}
            style={{ left: 0, width: Math.max(0, hit.x / z), top: hit.y / z, height: hit.h / z }}
          />
          <div
            className={styles.shield}
            style={{ left: (hit.x + hit.w) / z, right: 0, top: hit.y / z, height: hit.h / z }}
          />
        </>
      )}

      <div
        className={styles.place}
        data-side={place.side}
        style={{ transform: `translate(${place.x / z}px, ${place.y / z}px)` }}
      >
        <div
          ref={cardRef}
          className={styles.card}
          data-part="card"
          onPointerDown={onSwipeStart}
          onPointerUp={onSwipeEnd}
          onPointerCancel={() => (swipeRef.current = null)}
        >
          <div
            ref={stageRef}
            className={styles.stage}
            data-moved={moved}
            style={{ height: paneH ?? undefined }}
          >
            {leaving && lap[leaving.index] && leaving.index !== index && pane(leaving.index, "out", leaving.dir)}
            {pane(index, "in", dir)}
          </div>

          <div className={styles.progress} data-part="progress" role="group" aria-label="Tour progress">
            {lap.map((s, i) => (
              <button
                key={s.id}
                type="button"
                tabIndex={-1}
                className={styles.seg}
                data-state={i < index ? "past" : i === index ? "now" : "next"}
                aria-label={`Stop ${i + 1}: ${s.title}`}
                aria-current={i === index ? "step" : undefined}
                onClick={() => go(i)}
              >
                <span className={styles.segFill} />
              </button>
            ))}
          </div>

          <div className={styles.foot}>
            <button
              type="button"
              className={`${styles.btn} ${styles.ghost} ${styles.lead}`}
              onClick={() => (last ? go(index - 1) : leave())}
            >
              {last ? "Back" : "Skip"}
            </button>
            {index > 0 && !last && (
              <button type="button" className={styles.btn} onClick={() => go(index - 1)}>
                Back
              </button>
            )}
            {last && (
              <button type="button" className={styles.btn} onClick={() => leave(onOpenSample)}>
                Open the sample
              </button>
            )}
            <button
              ref={primaryRef}
              type="button"
              className={`${styles.btn} ${styles.primary}`}
              data-nudge={tryDone || undefined}
              onClick={() => (last ? leave() : go(index + 1))}
            >
              {last ? "Start creating" : index === 0 ? "Take the tour" : "Next"}
            </button>
          </div>
        </div>
        {place.arrow !== null && (
          <span
            className={styles.caret}
            data-part="caret"
            data-side={place.side}
            style={{ "--arrow": `${place.arrow / z}px` } as CSSProperties}
          />
        )}
      </div>

      <p className={styles.sr} aria-live="polite">
        {`Stop ${index + 1} of ${lap.length}: ${step.title}`}
      </p>
    </div>
  );
}
