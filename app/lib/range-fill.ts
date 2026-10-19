import type { CSSProperties } from "react";

/** The `--pct` a range input's track fill reads (`range` in app/styles/_ds.scss):
 *  how far along [min, max] the value sits, as a percentage. A lib module rather
 *  than a Controls export so the colour/gradient components can use it without
 *  an import cycle through Controls → ColorPopover. */
export const rangeFill = (value: number, min: number, max: number): CSSProperties =>
  ({ "--pct": `${max > min ? ((value - min) / (max - min)) * 100 : 0}%` }) as CSSProperties;
