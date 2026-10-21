"use client";

import { useId, type CSSProperties, type ReactNode } from "react";
import s from "./TourArt.module.scss";
import type { TourArtId } from "../lib/tour";

/**
 * The tour's illustrations: one small animated scene per stop, drawn in SVG on
 * a 320×120 board and coloured from the theme's tokens, so they sit in light
 * and dark alike. Each one loops quietly — a few seconds of action, then a
 * rest — and its STATIC frame (what reduced motion shows, every animation cut
 * to nothing) is the scene at rest, complete: the stroke drawn, the menu open,
 * the selection made. The keyframes leave from that frame and come back to it.
 */
export default function TourArt({ id, mobile = false }: { id: TourArtId; mobile?: boolean }) {
  // Gradient and clip ids must be unique per instance: two panes are on screen
  // together while one gives way to the next.
  const uid = "ta" + useId().replace(/[^a-zA-Z0-9_-]/g, "");
  return (
    <svg className={s.art} viewBox="0 0 320 120" aria-hidden="true" focusable="false">
      {ART[id](uid, mobile)}
    </svg>
  );
}

type Draw = (uid: string, mobile: boolean) => ReactNode;

const v = (vars: Record<string, string | number>) => vars as CSSProperties;

/** A small landscape photograph on a 100×64 board: the picture the scenes edit. */
function Landscape({ uid, warm = false }: { uid: string; warm?: boolean }) {
  const sky = warm ? ["#ffb27d", "#f2709c"] : ["#9fd0ff", "#b8a6ff"];
  const g = `${uid}${warm ? "w" : "c"}sky`;
  return (
    <>
      <defs>
        <linearGradient id={g} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={sky[0]} />
          <stop offset="1" stopColor={sky[1]} />
        </linearGradient>
      </defs>
      <rect width="100" height="64" fill={`url(#${g})`} />
      <circle cx="71" cy="21" r="8.5" fill={warm ? "#fff2a8" : "#ffe08a"} />
      <path d="M0 45 L20 30 L35 41 L55 24 L79 43 L100 33 V64 H0 Z" fill={warm ? "#c55f7d" : "#6d80f0"} />
      <path d="M0 53 Q24 43 50 51 T100 49 V64 H0 Z" fill={warm ? "#7f3459" : "#3c4cb5"} />
    </>
  );
}

/** The landscape fitted into a rounded frame at (x, y, w, h). */
function Photo({
  uid,
  x,
  y,
  w,
  h,
  r = 6,
  warm,
  tag = "p",
}: {
  uid: string;
  x: number;
  y: number;
  w: number;
  h: number;
  r?: number;
  warm?: boolean;
  tag?: string;
}) {
  const clip = `${uid}${tag}clip`;
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect x={x} y={y} width={w} height={h} rx={r} />
        </clipPath>
      </defs>
      <g clipPath={`url(#${clip})`}>
        <svg x={x} y={y} width={w} height={h} viewBox="0 0 100 64" preserveAspectRatio="xMidYMid slice">
          <Landscape uid={uid + tag} warm={warm} />
        </svg>
      </g>
    </>
  );
}

/** A key cap with its label, centred at (x, y). */
function Key({
  x,
  y,
  label,
  w = 18,
  className,
}: {
  x: number;
  y: number;
  label: string;
  w?: number;
  className?: string;
}) {
  return (
    <g className={className}>
      <rect className={s.key} x={x - w / 2} y={y - 9} width={w} height={18} rx={5} />
      <text className={s.keyText} x={x} y={y + 3.2} textAnchor="middle">
        {label}
      </text>
    </g>
  );
}

/** A four-pointed sparkle, centred at (x, y). */
function Sparkle({ x, y, k = 1, delay = 0 }: { x: number; y: number; k?: number; delay?: number }) {
  return (
    <g transform={`translate(${x} ${y}) scale(${k})`}>
      <path
        className={s.sparkle}
        style={{ animationDelay: `${delay}s` }}
        d="M0 -7 C1 -1.5 1.5 -1 7 0 C1.5 1 1 1.5 0 7 C-1 1.5 -1.5 1 -7 0 C-1.5 -1 -1 -1.5 0 -7 Z"
      />
    </g>
  );
}

/** The arrow of a mouse pointer, its tip at (0, 0). */
const POINTER = "M0 0 L0 13 L3.6 9.6 L6.2 15 L8.4 14 L5.9 8.8 L10.6 8.6 Z";

/** An open hand, the dock's Pan button, centred on (0, 0). */
const HAND =
  "M-3 6 C-6 3 -7 0 -6 -1 C-5 -2 -4 -1 -3 1 V-6 C-3 -7.5 -1 -7.5 -1 -6 V-1 V-7 C-1 -8.5 1 -8.5 1 -7 V-1 " +
  "V-6 C1 -7.5 3 -7.5 3 -6 V-1 V-4 C3 -5.5 5 -5.5 5 -4 V2 C5 5 3 6 1 6 Z";

/* ---- The scenes ------------------------------------------------------------ */

/** Layers of a picture, fanned like cards, a brush stroke drawn across the top. */
const welcome: Draw = (uid) => {
  // Each layer is the 100×64 board laid flat: the unit square mapped onto a
  // diamond 128 wide and 48 tall, centred on (160, cy).
  const flat = (cy: number) => `matrix(0.64 -0.24 1 0.375 96 ${cy})`;
  return (
    <>
      <g className={s.fan} style={v({ "--lift": "0px" })}>
        <g transform={flat(82)}>
          <rect className={s.sheet} width="100" height="64" vectorEffect="non-scaling-stroke" />
        </g>
      </g>
      <g className={s.fan} style={v({ "--lift": "-5px", animationDelay: "0.12s" })}>
        <g transform={flat(66)}>
          <rect className={s.sheetAccent} width="100" height="64" vectorEffect="non-scaling-stroke" />
        </g>
      </g>
      <g className={s.fan} style={v({ "--lift": "-10px", animationDelay: "0.24s" })}>
        <g transform={flat(48)}>
          <Landscape uid={uid} />
          <rect className={s.sheetEdge} width="100" height="64" vectorEffect="non-scaling-stroke" />
        </g>
        <path className={s.stroke} pathLength={1} d="M124 54 C138 40 150 62 164 48 S188 34 198 42" />
      </g>
      <Sparkle x={248} y={30} />
      <Sparkle x={74} y={42} k={0.7} delay={0.7} />
      <Sparkle x={236} y={92} k={0.55} delay={1.3} />
    </>
  );
};

/** The command palette: "curves" typed, the matches cascading in. */
const palette: Draw = (uid, mobile) => {
  const clip = `${uid}type`;
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect className={s.typeClip} x="86" y="14" width="40" height="26" />
        </clipPath>
      </defs>
      <rect className={s.panel} x="60" y="12" width="200" height="28" rx="9" />
      <circle className={s.glyph} cx="75" cy="25.5" r="4.6" />
      <path className={s.glyph} d="M78.4 29 L81.6 32.2" />
      <g className={s.typed}>
        <text className={s.typedText} x="86" y="29.6" clipPath={`url(#${clip})`}>
          curves
        </text>
      </g>
      <rect className={s.caret} x="121" y="19" width="1.4" height="13" rx="0.7" />
      {mobile ? (
        <text className={s.dim} x="250" y="29.6" textAnchor="end">
          ☰ Search
        </text>
      ) : (
        <Key x={237} y={26} w={34} label="Ctrl K" />
      )}
      <g className={s.row1}>
        <rect className={s.hit} x="60" y="46" width="200" height="20" rx="7" />
        <rect className={s.icon} x="68" y="51" width="10" height="10" rx="3" />
        <text className={s.label} x="86" y="59.4">
          Curves…
        </text>
        {!mobile && (
          <text className={s.dim} x="250" y="59.4" textAnchor="end">
            Ctrl M
          </text>
        )}
      </g>
      <g className={s.row2}>
        <rect className={s.iconDim} x="68" y="73" width="10" height="10" rx="3" />
        <text className={s.label2} x="86" y="81.4">
          Curves adjustment layer
        </text>
      </g>
      <g className={s.row3}>
        <rect className={s.iconDim} x="68" y="95" width="10" height="10" rx="3" />
        <rect className={s.bar} x="86" y="97.5" width="84" height="5" rx="2.5" />
      </g>
    </>
  );
};

/** The tools rail: the highlight walks along it and a slot opens its flyout. */
const tools: Draw = () => {
  const xs = [73, 103, 133, 163, 193, 223, 253];
  const glyphs = [
    <path key="move" d={POINTER} transform="translate(-4.5 -7.5)" className={s.glyphFill} />,
    <rect key="marquee" x="-6" y="-5" width="12" height="10" rx="1" className={s.dash} />,
    <path key="lasso" d="M-1 5 C-8 4 -8 -5 0 -5 C7 -5 8 3 1 4 C-1 4.3 -2 6 -3 7" className={s.glyph} />,
    <path key="brush" d="M5 -6 L-1 1 M-1 1 C-4 1 -5 3 -5 6 C-2 6 0 5 0 2 Z" className={s.glyph} />,
    <path key="eraser" d="M-6 2 L1 -5 L6 0 L-1 7 Z M-3.5 -0.5 L3.5 4.5" className={s.glyph} />,
    <path key="type" d="M-5 -5 H5 M0 -5 V6" className={s.glyph} />,
    <path key="pen" d="M0 -6 L5 2 L0 6 L-5 2 Z M0 -6 V1" className={s.glyph} />,
  ];
  return (
    <>
      <rect className={s.panel} x="52" y="30" width="216" height="36" rx="11" />
      <rect className={s.slide} x="150" y="35" width="26" height="26" rx="8" />
      {xs.map((x, i) => (
        <g key={i} transform={`translate(${x} 48)`}>
          {glyphs[i]}
        </g>
      ))}
      {/* The brush slot holds two tools: its corner mark. */}
      <path className={s.mark} d="M173 58 L173 54 L169 58 Z" />
      <g className={s.flyout}>
        <rect className={s.menu} x="150" y="72" width="104" height="42" rx="9" />
        <rect className={s.hit} x="154" y="76" width="96" height="16" rx="5" />
        <text className={s.label} x="162" y="87.2">
          Brush
        </text>
        <text className={s.dim} x="244" y="87.2" textAnchor="end">
          B
        </text>
        <text className={s.label2} x="162" y="105.2">
          Mixer brush
        </text>
        <text className={s.dim} x="244" y="105.2" textAnchor="end">
          B
        </text>
      </g>
      <g transform="translate(171 52)">
        <path className={`${s.pointer} ${s.walk}`} d={POINTER} />
      </g>
    </>
  );
};

/** The size slider and the brush it sizes, with [ and ] pressed in turn. */
const options: Draw = (uid) => {
  const dab = `${uid}dab`;
  return (
    <>
      <defs>
        <radialGradient id={dab}>
          <stop offset="0" stopColor="var(--accent-solid)" stopOpacity="0.95" />
          <stop offset="0.55" stopColor="var(--accent-solid)" stopOpacity="0.75" />
          <stop offset="1" stopColor="var(--accent-solid)" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect className={s.panel} x="30" y="24" width="260" height="38" rx="10" />
      <text className={s.label2} x="44" y="46.4">
        Size
      </text>
      <rect className={s.track} x="74" y="41" width="120" height="4" rx="2" />
      <rect className={s.fill} x="74" y="41" width="120" height="4" rx="2" />
      <g className={s.knob}>
        <circle className={s.thumb} cx="146" cy="43" r="6" />
      </g>
      <line className={s.divider} x1="212" y1="32" x2="212" y2="54" />
      <circle className={s.dab} cx="250" cy="43" r="13" fill={`url(#${dab})`} />
      <Key x={142} y={88} label="[" className={s.keyL} />
      <Key x={170} y={88} label="]" className={s.keyR} />
    </>
  );
};

/** Ctrl and the wheel: the picture zooms in toward the pointer and moves. */
const zoom: Draw = (uid) => {
  const clip = `${uid}well`;
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect x="70" y="10" width="180" height="100" rx="11" />
        </clipPath>
      </defs>
      <rect className={s.well} x="70" y="10" width="180" height="100" rx="11" />
      <g clipPath={`url(#${clip})`}>
        <g className={s.zoomIn}>
          <Photo uid={uid} x={92} y={20} w={136} h={80} r={4} />
        </g>
      </g>
      <g className={s.chip}>
        <rect className={s.pill} x="78" y="92" width="38" height="13" rx="6.5" />
        <text className={`${s.mono} ${s.zoomA}`} x="97" y="101.2" textAnchor="middle">
          67%
        </text>
        <text className={`${s.mono} ${s.zoomB}`} x="97" y="101.2" textAnchor="middle">
          200%
        </text>
      </g>
      <path className={s.pointer} d={POINTER} transform="translate(196 46)" />
      <Key x={226} y={34} w={30} label="Ctrl" className={s.hold} />
      <g transform="translate(262 62)" className={s.mouse}>
        <rect className={s.panel} x="-9" y="-13" width="18" height="26" rx="9" />
        <rect className={s.wheel} x="-1.5" y="-8" width="3" height="7" rx="1.5" />
      </g>
    </>
  );
};

/** The layers panel: the active layer moves down a row, an eye blinks shut. */
const layers: Draw = (uid) => {
  const eye = (y: number, cls?: string) => (
    <g transform={`translate(96 ${y})`} className={cls}>
      <path className={s.glyph} d="M-5 0 C-2 -4 2 -4 5 0 C2 4 -2 4 -5 0 Z" />
      <circle className={s.glyphFill} r="1.6" />
    </g>
  );
  return (
    <>
      <rect className={s.panel} x="78" y="6" width="164" height="108" rx="11" />
      <text className={s.eyebrow} x="90" y="21">
        LAYERS
      </text>
      <rect className={s.active} x="84" y="28" width="152" height="24" rx="7" />
      {/* Hue / Saturation: an adjustment, with its mask. */}
      {eye(40)}
      <circle className={s.adjust} cx="116" cy="40" r="6" />
      <path className={s.adjustHalf} d="M116 34 A6 6 0 0 1 116 46 Z" />
      <rect className={s.mask} x="126" y="33" width="16" height="14" rx="2.5" />
      <ellipse className={s.maskHole} cx="134" cy="40" rx="4.5" ry="4" />
      <text className={s.label} x="148" y="43.2">
        Hue / Sat
      </text>
      <text className={s.fx} x="228" y="43.2" textAnchor="end">
        fx
      </text>
      {/* Sky: a photo. */}
      {eye(66)}
      <Photo uid={uid} x={108} y={59} w={22} h={14} r={2.5} tag="sky" />
      <text className={s.label} x="138" y="69.2">
        Sky
      </text>
      {/* Background: blinks off and on. */}
      <g className={s.blink}>
        {eye(92)}
        <path className={`${s.glyph} ${s.slash}`} d="M90 98 L102 86" />
      </g>
      <rect className={`${s.solid} ${s.fade}`} x="108" y="85" width="22" height="14" rx="2.5" />
      <text className={`${s.label} ${s.fade}`} x="138" y="95.2">
        Background
      </text>
    </>
  );
};

/** An adjustment layer wiped across the picture: the colours change, the
 *  picture underneath does not. */
const adjust: Draw = (uid) => {
  const clip = `${uid}wipe`;
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect className={s.wipe} x="70" y="8" width="180" height="100" />
        </clipPath>
      </defs>
      <Photo uid={uid} x={70} y={8} w={180} h={100} r={10} tag="cool" />
      <g clipPath={`url(#${clip})`}>
        <Photo uid={uid} x={70} y={8} w={180} h={100} r={10} warm tag="warm" />
      </g>
      <g className={s.wipeLine}>
        <line x1="250" y1="8" x2="250" y2="108" className={s.seam} />
        <circle cx="250" cy="58" r="6" className={s.seamKnob} />
        <path d="M247.6 58 h4.8 M248.8 56.2 l-1.6 1.8 1.6 1.8 M251.2 56.2 l1.6 1.8 -1.6 1.8" className={s.seamGrip} />
      </g>
      <g transform="translate(160 106)">
        <rect className={s.badge} x="-44" y="-8" width="88" height="16" rx="8" />
        <circle className={s.dot} cx="-34" cy="0" r="3" />
        <text className={s.small} x="4" y="2.8" textAnchor="middle">
          Adjustment layer
        </text>
      </g>
    </>
  );
};

/** An elliptical marquee drawn round a subject; the ants march, the edge
 *  softens with a feather. */
const select: Draw = (uid) => {
  const blur = `${uid}blur`;
  const body = `${uid}body`;
  return (
    <>
      <defs>
        <filter id={blur} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="6" />
        </filter>
        <radialGradient id={body} cx="0.4" cy="0.35">
          <stop offset="0" stopColor="#ffd98a" />
          <stop offset="1" stopColor="#f08a5d" />
        </radialGradient>
      </defs>
      <rect className={s.well} x="70" y="8" width="180" height="104" rx="11" />
      <path d="M118 96 C 124 72, 138 64, 160 64 C 182 64, 196 72, 202 96 Z" className={s.subjectShade} />
      <circle cx="160" cy="50" r="22" fill={`url(#${body})`} />
      <ellipse className={s.feather} cx="160" cy="60" rx="46" ry="40" filter={`url(#${blur})`} />
      <g className={s.marquee}>
        <ellipse className={s.antsUnder} cx="160" cy="60" rx="46" ry="40" />
        <ellipse className={s.ants} cx="160" cy="60" rx="46" ry="40" />
      </g>
      <g className={s.cross}>
        <path className={s.crossLine} d="M206 100 m-6 0 h12 m-6 -6 v12" />
      </g>
    </>
  );
};

/** The status bar under a canvas: as the pointer moves, its readout follows. */
const readout: Draw = (uid, mobile) => {
  if (mobile) {
    // The phone's readout: a pill at the top of the stage, the zoom following
    // a pinch.
    return (
      <>
        <rect className={s.phone} x="104" y="2" width="112" height="128" rx="16" />
        <Photo uid={uid} x={112} y={34} w={96} h={60} r={4} />
        <rect className={s.pill} x="122" y="12" width="76" height="16" rx="8" />
        <text className={s.mono} x="140" y="23" textAnchor="middle">
          1600×1000
        </text>
        <text className={`${s.mono} ${s.tickA}`} x="186" y="23" textAnchor="middle">
          67%
        </text>
        <text className={`${s.mono} ${s.tickB}`} x="186" y="23" textAnchor="middle">
          120%
        </text>
        <text className={`${s.mono} ${s.tickC}`} x="186" y="23" textAnchor="middle">
          200%
        </text>
      </>
    );
  }
  return (
    <>
      <rect className={s.well} x="40" y="6" width="240" height="68" rx="9" />
      <Photo uid={uid} x={112} y={14} w={96} h={52} r={4} />
      <g className={s.roam}>
        <path className={s.crossLine} d="M0 0 m-6 0 h12 m-6 -6 v12" />
      </g>
      <rect className={s.panel} x="40" y="82" width="240" height="26" rx="9" />
      <text className={s.mono} x="52" y="98.2">
        1600×1000 px
      </text>
      <text className={s.monoDim} x="118" y="98.2">
        sRGB
      </text>
      <text className={`${s.mono} ${s.tickA}`} x="146" y="98.2">
        X 412 Y 236
      </text>
      <text className={`${s.mono} ${s.tickB}`} x="146" y="98.2">
        X 985 Y 610
      </text>
      <text className={`${s.mono} ${s.tickC}`} x="146" y="98.2">
        X 1290 Y 180
      </text>
      <text className={s.mono} x="210" y="98.2">
        67%
      </text>
      <circle className={s.ok} cx="236" cy="95.4" r="2.6" />
      <text className={s.monoDim} x="242" y="98.2">
        Saved
      </text>
    </>
  );
};

/** A picture, the formats it can leave in, and the autosave's tick. */
const exportArt: Draw = (uid) => {
  const chips: [string, number, number][] = [
    ["PNG", 96, 32],
    ["JPEG", 224, 30],
    ["WebP", 90, 74],
    ["PSD", 230, 72],
    ["PDF", 160, 108],
  ];
  return (
    <>
      <g className={s.doc}>
        <path className={s.paper} d="M138 12 H172 L184 24 V92 H138 Z" />
        <path className={s.dogEar} d="M172 12 V24 H184" />
        <Photo uid={uid} x={144} y={30} w={34} h={26} r={2} />
        <rect className={s.bar} x="144" y="62" width="30" height="4" rx="2" />
        <rect className={s.bar} x="144" y="70" width="22" height="4" rx="2" />
      </g>
      {chips.map(([label, x, y], i) => (
        <g key={label} transform={`translate(${x} ${y})`}>
          <g className={s[`chip${i + 1}`]}>
            <rect className={s.format} x="-19" y="-8" width="38" height="16" rx="8" />
            <text className={s.small} y="2.8" textAnchor="middle">
              {label}
            </text>
          </g>
        </g>
      ))}
      <g transform="translate(184 90)">
        <g className={s.saved}>
          <circle className={s.okDisc} r="9" />
          <path className={s.okTick} d="M-4 0.2 L-1.2 3 L4.2 -2.6" />
        </g>
      </g>
    </>
  );
};

/** The finish: a tick drawn in a ring, and a burst of confetti. */
const done: Draw = () => {
  const colours = ["var(--accent-solid)", "#ffcf5c", "#ff7aa2", "#4fd1a5", "#7aa8ff"];
  // Where each piece comes to rest (dx, dy from the centre) and how it turns.
  const bits: [number, number, number, "r" | "c"][] = [
    [-92, -30, 40, "r"],
    [-70, 14, -25, "c"],
    [-104, 30, 70, "r"],
    [-56, -46, 15, "c"],
    [-40, 44, -60, "r"],
    [-122, -6, 20, "c"],
    [58, -44, -35, "r"],
    [86, -16, 60, "c"],
    [104, 26, -15, "r"],
    [66, 40, 30, "c"],
    [124, -36, 80, "r"],
    [40, -50, -70, "c"],
    [-12, -54, 25, "r"],
    [16, 52, -40, "c"],
  ];
  return (
    <>
      <g transform="translate(160 60)">
        {bits.map(([dx, dy, rot, shape], i) => (
          <g
            key={i}
            className={s.confetti}
            style={v({
              "--dx": `${dx}px`,
              "--dy": `${dy}px`,
              "--rot": `${rot}deg`,
              animationDelay: `${0.42 + (i % 4) * 0.03}s, ${1.5 + (i % 5) * 0.37}s`,
            })}
          >
            {shape === "r" ? (
              <rect x="-3.5" y="-2" width="7" height="4" rx="1" fill={colours[i % colours.length]} />
            ) : (
              <circle r="2.6" fill={colours[i % colours.length]} />
            )}
          </g>
        ))}
        <circle className={s.halo} r="30" />
        <circle className={s.ring} r="30" pathLength={1} transform="rotate(-90)" />
        <path className={s.tick} pathLength={1} d="M-13 1 L-4 10 L14 -9" />
      </g>
    </>
  );
};

/** The phone's tool dock: a finger taps one tool, then another. */
const dockbar: Draw = () => {
  const slot = (x: number, glyph: ReactNode) => (
    <g key={x} transform={`translate(${x} 60)`}>
      {glyph}
    </g>
  );
  return (
    <>
      <rect className={s.dockPill} x="34" y="40" width="252" height="40" rx="20" />
      <rect className={s.slideDock} x="108" y="45" width="30" height="30" rx="10" />
      {slot(63, <path d={POINTER} transform="translate(-4.5 -7.5)" className={s.glyphFill} />)}
      {slot(93, <rect x="-6" y="-5" width="12" height="10" rx="1" className={s.dash} />)}
      {slot(123, <path d="M5 -6 L-1 1 M-1 1 C-4 1 -5 3 -5 6 C-2 6 0 5 0 2 Z" className={s.glyph} />)}
      {slot(153, <path d="M-6 2 L1 -5 L6 0 L-1 7 Z M-3.5 -0.5 L3.5 4.5" className={s.glyph} />)}
      {slot(187, <path d={HAND} className={s.glyph} />)}
      <line className={s.divider} x1="207" y1="50" x2="207" y2="70" />
      {slot(
        228,
        <g className={s.glyph}>
          <rect x="-6" y="-6" width="5" height="5" rx="1.2" />
          <rect x="1" y="-6" width="5" height="5" rx="1.2" />
          <rect x="-6" y="1" width="5" height="5" rx="1.2" />
          <rect x="1" y="1" width="5" height="5" rx="1.2" />
        </g>,
      )}
      {slot(259, <path d="M0 -6 L7 -2.5 L0 1 L-7 -2.5 Z M-7 1.5 L0 5 L7 1.5" className={s.glyph} />)}
      <circle className={s.ripple1} cx="93" cy="60" r="16" />
      <circle className={s.ripple2} cx="123" cy="60" r="16" />
      <circle className={s.finger} cx="0" cy="0" r="11" />
    </>
  );
};

/** The phone's options card: dragged down by its grip to fold, and back. */
const card: Draw = (uid) => {
  const clip = `${uid}screen`;
  const row = (y: number, w: number) => (
    <g key={y}>
      <rect className={s.bar} x="122" y={y - 2} width="18" height="4" rx="2" />
      <rect className={s.track} x="146" y={y - 1.5} width="52" height="3" rx="1.5" />
      <rect className={s.fillStatic} x="146" y={y - 1.5} width={w} height="3" rx="1.5" />
      <circle className={s.thumb} cx={146 + w} cy={y} r="3.6" />
    </g>
  );
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect x="106" y="4" width="108" height="124" rx="14" />
        </clipPath>
      </defs>
      <rect className={s.phone} x="104" y="2" width="112" height="128" rx="16" />
      <g clipPath={`url(#${clip})`}>
        <Photo uid={uid} x={112} y={12} w={96} h={54} r={5} />
        <g className={s.cardFold}>
          <rect className={s.sheetCard} x="110" y="62" width="100" height="70" rx="10" />
          <rect className={s.grip} x="152" y="66" width="16" height="3" rx="1.5" />
          {row(80, 30)}
          {row(91, 18)}
          {row(102, 40)}
        </g>
      </g>
      <circle className={s.fingerDrag} cx="160" cy="67.5" r="10" />
    </>
  );
};

/** Two fingers pinch the picture open, then closed. */
const pinch: Draw = (uid) => {
  const clip = `${uid}screen`;
  return (
    <>
      <defs>
        <clipPath id={clip}>
          <rect x="106" y="4" width="108" height="124" rx="14" />
        </clipPath>
      </defs>
      <rect className={s.phone} x="104" y="2" width="112" height="128" rx="16" />
      <g clipPath={`url(#${clip})`}>
        <g className={s.pinchPic}>
          <Photo uid={uid} x={112} y={30} w={96} h={60} r={4} />
        </g>
      </g>
      <circle className={`${s.fingerSoft} ${s.pinchA}`} cx="150" cy="66" r="10" />
      <circle className={`${s.fingerSoft} ${s.pinchB}`} cx="170" cy="54" r="10" />
    </>
  );
};

const ART: Record<TourArtId, Draw> = {
  welcome,
  palette,
  tools,
  options,
  zoom,
  layers,
  adjust,
  select,
  readout,
  export: exportArt,
  done,
  dockbar,
  card,
  pinch,
};
