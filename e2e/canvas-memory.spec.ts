/**
 * Running out of canvas memory is reported, not composited as a blank photo.
 * (Ported from tools/verify-canvas-memory.js, TODO 2.1.)
 *
 * WebKit enforces a per-page canvas memory budget and, past it, hands back a
 * canvas that draws, composites and reads perfectly — as transparent black,
 * for ever. No throw, no null context, no warning: the user sees their photo
 * turn into nothing. It cannot be produced on desktop Chromium (48 canvases of
 * 4096², 3 GB, without a failure), so — as the item says — it is faked:
 * `getImageData` returns zeros for canvases created while "armed", which is
 * exactly what a dead backing store serves.
 *
 * The sentinel has to WRITE: an empty canvas and a dead one read identically.
 * And its threshold is tested both ways — under a megapixel a failure is
 * knowingly not reported (the readback costs 0.7ms whatever the size, and most
 * allocations are small), said out loud rather than discovered later.
 */
import type { Page } from "@playwright/test";
import { test, expect, bootApp, type App } from "./fixtures";

type W = {
  __gqFailNew: boolean;
  __gqDeadMin: number;
  __gqDeadMax: number;
  __gqSpareBig: number;
  __gqCanvasFailures?: number;
  __gqReadAsDead: (c: HTMLCanvasElement) => number[];
  __gqCheckSize: (w: number, h: number) => { verdict: string; message: string };
};

/** Canvases created while ARMED read as zeros once in the dead band. */
const STUB = () => {
  const w = window as unknown as W;
  /* Marked at creation, not judged by size at read time: a real failure kills
     the canvas that just failed and leaves the buffers already held working. A
     size rule retroactively killed the open document's buffers, and the app
     never got far enough to allocate anything. */
  w.__gqFailNew = false;
  const DEAD = Symbol("dead");
  /* A BAND, not a floor: a floor of 1 kills the structural probe's trial
     canvases too, the document is refused before the engine runs, and the
     below-threshold check went vacuous (a mutation passed). */
  w.__gqDeadMin = 1048576;
  w.__gqDeadMax = Infinity;
  /* The first big canvas after arming is the pre-check's own probe of the
     size: spare it, or the document is refused as structurally impossible.
     That reproduces the real case — a size just proven possible, whose real
     allocation then fails. */
  w.__gqSpareBig = 1;
  const orig = document.createElement.bind(document);
  document.createElement = function (tag: string, ...rest: unknown[]) {
    const el = orig(tag, ...(rest as []));
    if (w.__gqFailNew && String(tag).toLowerCase() === "canvas") (el as unknown as Record<symbol, boolean>)[DEAD] = true;
    return el;
  } as typeof document.createElement;
  const proto = CanvasRenderingContext2D.prototype;
  const realGet = proto.getImageData;
  proto.getImageData = function (this: CanvasRenderingContext2D, x: number, y: number, sw: number, sh: number, ...rest: unknown[]) {
    const c = this.canvas as unknown as HTMLCanvasElement & Record<symbol, boolean>;
    const area = c ? c.width * c.height : 0;
    if (c && c[DEAD] && area >= w.__gqDeadMin && area <= w.__gqDeadMax) {
      if (w.__gqSpareBig > 0) {
        c[DEAD] = false; // spared, both of the sentinel's reads
        w.__gqSpareBig--;
      } else return new ImageData(Math.max(1, sw | 0), Math.max(1, sh | 0));
    }
    return realGet.call(this, x, y, sw, sh, ...(rest as []));
  } as typeof proto.getImageData;
  w.__gqReadAsDead = (c) => {
    (c as unknown as Record<symbol, boolean>)[DEAD] = true;
    const spare = w.__gqSpareBig;
    w.__gqSpareBig = 0;
    const d = Array.from(c.getContext("2d", { willReadFrequently: true })!.getImageData(c.width - 1, c.height - 1, 1, 1).data);
    w.__gqSpareBig = spare;
    return d;
  };
};

const toast = (app: App) => app.page.evaluate(() => document.body.innerText.match(/Your device ran out of memory[^\n]*/)?.[0] ?? null);

async function stubbed(page: Page) {
  await page.addInitScript(STUB);
  return bootApp(page);
}
async function newDoc(app: App, w: number, h: number) {
  const { page } = app;
  await page.keyboard.press("Control+n");
  const fields = page.locator('[role="dialog"] input[type="number"]');
  await fields.nth(0).fill(String(w));
  await fields.nth(1).fill(String(h));
  await page.locator('[role="dialog"] button', { hasText: /^Create$/ }).first().click();
  await app.settle(2500);
}

test("a read cannot tell dead from empty, and a healthy document reports nothing", async ({ page }) => {
  const app = await stubbed(page);
  const reads = await page.evaluate(() => {
    const make = (draw: boolean) => {
      const c = document.createElement("canvas");
      c.width = c.height = 1200;
      const g = c.getContext("2d", { willReadFrequently: true })!;
      if (draw) {
        g.fillStyle = "#ff0000";
        g.fillRect(0, 0, 1200, 1200); // drawn, and still dead
      }
      return c;
    };
    const empty = Array.from(make(false).getContext("2d")!.getImageData(1199, 1199, 1, 1).data);
    return { empty, dead: (window as unknown as W).__gqReadAsDead(make(true)) };
  });
  expect(reads.dead, "an empty canvas and a dead one read identically — so the sentinel must write").toEqual(reads.empty);
  await newDoc(app, 2000, 1500);
  expect(await toast(app), "a healthy document reports nothing").toBeNull();
  expect(app.consoleErrors).toEqual([]);
});

test("a dead allocation is reported once, as memory, naming the size and what to do", async ({ page }) => {
  /* A fresh engine: it REUSES document-sized buffers, so a second document on
     the same page resizes rather than allocates and nothing is guarded. */
  const app = await stubbed(page);
  await page.evaluate(() => ((window as unknown as W).__gqFailNew = true));
  await newDoc(app, 2400, 1800);
  const msg = await toast(app);
  expect(msg, "a failed allocation is reported").toBeTruthy();
  expect(msg, "...as memory, not the picture").toMatch(/ran out of memory/i);
  expect(msg, "...naming the size").toMatch(/2,400 × 1,800/);
  expect(msg, "...and what to do").toMatch(/save/i);
  /* Counted at the source: the toast is one slot, so five reports overwrite
     one another — a screen check passed with de-duplication removed. */
  expect(await page.evaluate(() => (window as unknown as W).__gqCanvasFailures ?? 0), "reported once").toBe(1);

  /* The pre-check and the sentinel are the SAME operation, so a device merely
     out of room failed the pre-check too and was told "this browser cannot
     hold a canvas that big" — false, and permanent-sounding. */
  const area = await page.evaluate(() => {
    const w = window as unknown as W;
    w.__gqSpareBig = 0;
    w.__gqFailNew = true;
    const r = w.__gqCheckSize(3000, 3000);
    w.__gqFailNew = false;
    return r;
  });
  expect(area.verdict).toBe("too-many-pixels");
  expect(area.message, "a failed allocation is not blamed on the browser").not.toMatch(/this browser (cannot|will not)/i);
  expect(area.message, "...and offers what might help").toMatch(/closing other documents|tabs may help/i);
  /* The side limit needs no allocation, so it can stay definite. */
  const side = await page.evaluate(() => (window as unknown as W).__gqCheckSize(70000, 1));
  expect(side.verdict).toBe("too-wide");
  expect(side.message).toMatch(/cannot hold a canvas longer/i);
});

test("below the threshold a failure is knowingly not reported", async ({ page }) => {
  const app = await stubbed(page);
  await page.evaluate(() => {
    const w = window as unknown as W;
    /* Dead only where the sentinel deliberately does not look: big enough to
       be a document buffer, too small to be checked. */
    w.__gqDeadMin = 100_000;
    w.__gqDeadMax = 1_000_000;
    w.__gqSpareBig = 1;
    w.__gqFailNew = true;
  });
  await newDoc(app, 800, 600);
  expect(await toast(app), "nothing reported: the accepted limit").toBeNull();
  expect(await page.evaluate(() => (window as unknown as W).__gqCanvasFailures ?? 0)).toBe(0);
});

test("the sentinel leaves no mark on the document it checked", async ({ page }) => {
  /* It writes a pixel to test the canvas; not put back, every document would
     carry a red dot in its corner. */
  const app = await stubbed(page);
  await newDoc(app, 1600, 1200);
  const corner = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].find((x) => x.width === 1600 && x.height === 1200)!;
    return Array.from(c.getContext("2d", { willReadFrequently: true })!.getImageData(1599, 1199, 1, 1).data);
  });
  expect(corner[3], "the far corner is untouched").toBe(0);
});
