import type { CSSProperties } from "react";

/** r,g,b in 0–255; a in 0–1. */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** h in 0–360; s,v in 0–100; a in 0–1. */
export interface Hsva {
  h: number;
  s: number;
  v: number;
  a: number;
}

export const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

const hex2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");

/** Parse #rgb / #rrggbb / #rrggbbaa / rgb()/rgba() into an Rgba. */
export function parseColor(input: string): Rgba {
  let s = (input || "").trim();
  if (s.startsWith("#")) s = s.slice(1);

  if (/^[0-9a-f]{3}$/i.test(s)) {
    return {
      r: parseInt(s[0] + s[0], 16),
      g: parseInt(s[1] + s[1], 16),
      b: parseInt(s[2] + s[2], 16),
      a: 1,
    };
  }
  if (/^[0-9a-f]{6}$/i.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
      a: 1,
    };
  }
  if (/^[0-9a-f]{8}$/i.test(s)) {
    return {
      r: parseInt(s.slice(0, 2), 16),
      g: parseInt(s.slice(2, 4), 16),
      b: parseInt(s.slice(4, 6), 16),
      a: parseInt(s.slice(6, 8), 16) / 255,
    };
  }
  const m = input.match(/rgba?\(([^)]+)\)/i);
  if (m) {
    const p = m[1].split(",").map((x) => parseFloat(x));
    return { r: p[0] || 0, g: p[1] || 0, b: p[2] || 0, a: p[3] === undefined ? 1 : p[3] };
  }
  return { r: 0, g: 0, b: 0, a: 1 };
}

export const toHex6 = (c: Rgba) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}`;
export const toHex8 = (c: Rgba) => `#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}${hex2(c.a * 255)}`;
export const toRgbaCss = (c: Rgba) =>
  `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${Number(c.a.toFixed(3))})`;

export function rgbToHsv(r: number, g: number, b: number): { h: number; s: number; v: number } {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let h = 0;
  if (d !== 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const s = max === 0 ? 0 : d / max;
  return { h, s: s * 100, v: max * 100 };
}

export function hsvToRgb(h: number, s: number, v: number): { r: number; g: number; b: number } {
  h = ((h % 360) + 360) % 360;
  s /= 100;
  v /= 100;
  const c = v * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = v - c;
  let r = 0;
  let g = 0;
  let b = 0;
  if (h < 60) [r, g] = [c, x];
  else if (h < 120) [r, g] = [x, c];
  else if (h < 180) [g, b] = [c, x];
  else if (h < 240) [g, b] = [x, c];
  else if (h < 300) [r, b] = [x, c];
  else [r, b] = [c, x];
  return { r: Math.round((r + m) * 255), g: Math.round((g + m) * 255), b: Math.round((b + m) * 255) };
}

export const rgbaToHsva = (c: Rgba): Hsva => ({ ...rgbToHsv(c.r, c.g, c.b), a: c.a });
export const hsvaToRgba = (c: Hsva): Rgba => ({ ...hsvToRgb(c.h, c.s, c.v), a: c.a });

/** HSV ↔ HSL share the same hue; convert saturation/value <-> saturation/lightness. */
export function hsvToHsl(h: number, s: number, v: number): { h: number; s: number; l: number } {
  s /= 100;
  v /= 100;
  const l = v * (1 - s / 2);
  const sl = l === 0 || l === 1 ? 0 : (v - l) / Math.min(l, 1 - l);
  return { h, s: sl * 100, l: l * 100 };
}

export function hslToHsv(h: number, s: number, l: number): { h: number; s: number; v: number } {
  s /= 100;
  l /= 100;
  const v = l + s * Math.min(l, 1 - l);
  const sv = v === 0 ? 0 : 2 * (1 - l / v);
  return { h, s: sv * 100, v: v * 100 };
}

/** A small neutral checkerboard used behind translucent swatches. */
const CHECKER =
  "repeating-conic-gradient(#bdbdbd 0% 25%, #ffffff 0% 50%)";

/** Inline style that shows a colour (incl. its alpha) over a checkerboard. */
export function swatchBg(color: string, tile = 8): CSSProperties {
  return {
    backgroundImage: `linear-gradient(${color}, ${color}), ${CHECKER}`,
    backgroundSize: `100% 100%, ${tile}px ${tile}px`,
  };
}
