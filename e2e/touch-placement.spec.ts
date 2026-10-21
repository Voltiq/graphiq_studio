/**
 * Placing a point with a finger: the loupe, and the two-stage tap.
 * (Ported from tools/verify-loupe.js and tools/verify-two-stage.js, TODO 2.1.)
 *
 * THE LOUPE — a magnified view of the pixels a fingertip is covering.
 * A bigger grab radius helps catch a handle that already exists; it does
 * nothing for the opposite problem — the finger covers the pixels it is aimed
 * at, so for the tools where placement IS the result (the Eyedropper's sample,
 * a pen anchor, the clone source) you aim at something you cannot see.
 *
 * The check is a hit rate against a no-loupe baseline, and its trap is the one
 * that made the first grab-radius harness useless: a scripted touch has no
 * aiming error, so "tap the pixel, sample the pixel" passes 10/10 with no
 * loupe at all. So every attempt lands deliberately OFF the target, and the
 * two runs differ only in what happens next: the baseline commits where it
 * landed (all a user without a loupe can do); the loupe run reads the LOUPE —
 * never the document — to work out which way to move, moves and commits. That
 * makes the loupe's correctness the thing measured: a loupe showing the wrong
 * region fails the run rather than merely looking odd.
 *
 * THE TWO-STAGE TAP — a tap you can take back. The sampled point stays on
 * screen as a marker, and a press NEAR it picks it up instead of sampling
 * afresh. The marker is held by the offset the grab started with (dragged from
 * 18px away it moves by 18px-worth of travel, not under the hand, which would
 * cover the thing being aimed), and the Info panel follows the MARKER, not the
 * finger. A press well away still samples afresh, or the marker would hijack
 * the canvas; and a mouse gets no marker at all.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const MAG = 5; // LOUPE_MAG in CanvasArea
const AIM_ERROR = 6; // screen px each attempt lands off target: a modest finger

/** Ten deterministic misses around the target, so both runs face the same task. */
const OFFSETS = Array.from({ length: 10 }, (_, i) => {
  const a = (i * 2 * Math.PI) / 10;
  return { dx: Math.round(Math.cos(a) * AIM_ERROR), dy: Math.round(Math.sin(a) * AIM_ERROR) };
});

const loupeShown = (app: App) =>
  app.page.evaluate(() => getComputedStyle(document.querySelector("[data-loupe]")!).display !== "none");

/**
 * A single white pixel on a black patch, at 100%, with the Eyedropper chosen.
 * Painted with the PENCIL (hard-edged, one colour per stroke) through the
 * app's own exact controls; a setup whose result nobody can predict is not a
 * setup. Returns the white pixel in document and screen coordinates.
 */
async function whitePixelOnBlack(app: App) {
  const { page } = app;
  await app.run("layer-new");
  await app.setForeground("#000000");
  await app.key("n");
  expect(await app.setRange("Size", 400), "the pencil size can be set exactly").toBe(true);
  await app.settle(300);
  const cv = await app.canvasBox();
  await page.mouse.click(Math.round(cv.x + cv.width / 2), Math.round(cv.y + cv.height / 2));
  await app.settle(800);

  await app.setForeground("#ffffff");
  expect(await app.setRange("Size", 1)).toBe(true);
  await app.settle(300);
  await page.keyboard.press("Control+1"); // 100%: one document pixel is one screen pixel
  await app.settle(900);
  /* At 100% a 1920px document hangs far outside a 390px screen; its centre —
     the black patch — stays where the fitted picture's was, in the middle of
     what is visible (lib/stage-area). */
  const vp = (await page.locator('[data-tour="canvas"] [class*="viewport"]').first().boundingBox())!;
  const art = await app.canvasBox();
  const mid = { x: Math.round(art.x + art.width / 2), y: Math.round(art.y + art.height / 2) };
  expect(mid.y > vp.y && mid.y < vp.y + vp.height, `100% keeps the picture's middle on screen: ${JSON.stringify({ mid, vp })}`).toBe(true);
  await page.mouse.click(mid.x, mid.y);
  await app.settle(800);

  const feature = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
    const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    let sx = 0;
    let sy = 0;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200 && d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40) dark++;
      if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200 || d[i + 3] < 200) continue;
      n++;
      sx += (i / 4) % c.width;
      sy += Math.floor(i / 4 / c.width);
    }
    return { n, dark, x: n ? sx / n : -1, y: n ? sy / n : -1 };
  });
  expect(feature.n, "a 1px white feature...").toBe(1);
  expect(feature.dark, "...on a black patch").toBeGreaterThan(10_000);

  /* The app floors the document coordinate and the touch is a whole client
     pixel, so aim at the smallest whole client coordinate that still floors
     INTO the target: aiming at the pixel's centre (+0.5) rounds off its end. */
  const t = await page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
    const b = c.getBoundingClientRect();
    return { left: b.left, top: b.top, sx: b.width / c.width, sy: b.height / c.height };
  });
  expect(Math.abs(t.sx - 1), "the view is at 100%").toBeLessThan(0.01);
  const target = { x: Math.ceil(t.left + feature.x * t.sx), y: Math.ceil(t.top + feature.y * t.sy) };

  await app.key("i"); // the Eyedropper
  return { feature, target, vp };
}

test("the loupe shows the pixel under the finger, stands clear of it, and flips at the top", async ({ app }) => {
  const { feature, target, vp } = await whitePixelOnBlack(app);
  await app.touchDown(target.x, target.y);
  await app.settle(500);
  const shown = await app.page.evaluate(() => {
    const el = document.querySelector<HTMLCanvasElement>("[data-loupe]")!;
    const r = el.getBoundingClientRect();
    const d = el.getContext("2d")!.getImageData(el.width / 2, el.height / 2, 1, 1).data;
    return {
      visible: getComputedStyle(el).display !== "none",
      at: el.getAttribute("data-at"),
      rect: { l: r.left, t: r.top, r: r.right, b: r.bottom },
      centre: [d[0], d[1], d[2]],
    };
  });
  expect(shown.visible, "the loupe appears for a finger on the Eyedropper").toBe(true);
  expect(shown.at, "...centred on the document pixel under the contact").toBe(
    `${Math.floor(feature.x)},${Math.floor(feature.y)}`,
  );
  expect(Math.min(...shown.centre), "...and showing THAT pixel (white on black)").toBeGreaterThanOrEqual(240);
  const clear =
    target.y < shown.rect.t - 8 ||
    target.y > shown.rect.b + 8 ||
    target.x < shown.rect.l - 8 ||
    target.x > shown.rect.r + 8;
  expect(clear, `...standing clear of the contact: ${JSON.stringify({ target, rect: shown.rect })}`).toBe(true);
  await app.touchUp();
  await app.settle(400);
  expect(await loupeShown(app), "...and gone on release").toBe(false);

  /* Near the top edge "above the finger" has no room: it flips below. (Off
     centre: the readout chip sits at the top middle of the phone's stage.) */
  const high = { x: Math.round(vp.x + 60), y: Math.round(vp.y + 24) };
  await app.touchDown(high.x, high.y);
  await app.settle(450);
  const flipped = await app.page.evaluate(() => {
    const el = document.querySelector("[data-loupe]")!;
    const r = el.getBoundingClientRect();
    return { t: r.top, b: r.bottom, l: r.left, r: r.right, vis: getComputedStyle(el).display !== "none" };
  });
  await app.touchUp();
  expect(flipped.vis, "near the top it still shows").toBe(true);
  expect(flipped.t, `...below the finger (contact y=${high.y})`).toBeGreaterThan(high.y);
  expect(flipped.t >= 0 && flipped.b <= 844 && flipped.l >= 0 && flipped.r <= 390, `...on screen: ${JSON.stringify(flipped)}`).toBe(
    true,
  );
});

test("steering by the loupe lands a 1px target that the bare finger misses", async ({ app }) => {
  test.slow(); // twenty touch attempts
  const { page } = app;
  const { target } = await whitePixelOnBlack(app);

  /** Where the loupe says the white pixel is, as a screen-space correction —
   *  read from the LOUPE's pixels, never the document. The centre is skipped:
   *  the marker drawn there is light too. */
  const correctionFromLoupe = () =>
    page.evaluate((mag) => {
      const el = document.querySelector<HTMLCanvasElement>("[data-loupe]");
      if (!el || getComputedStyle(el).display === "none") return null;
      const d = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
      const cx = el.width / 2;
      const cy = el.height / 2;
      let best: { x: number; y: number } | null = null;
      let bestLum = 600;
      for (let y = 0; y < el.height; y++)
        for (let x = 0; x < el.width; x++) {
          if (Math.hypot(x - cx, y - cy) < 10) continue;
          const i = (y * el.width + x) * 4;
          const lum = d[i] + d[i + 1] + d[i + 2];
          if (lum > bestLum) {
            bestLum = lum;
            best = { x, y };
          }
        }
      return best ? { dx: (best.x - cx) / mag, dy: (best.y - cy) / mag } : null;
    }, MAG);

  /** One attempt: land `off` from the target, optionally steer by the loupe. */
  const attempt = async (off: { dx: number; dy: number }, useLoupe: boolean) => {
    /* Reset to a colour that is neither the feature nor the background, so an
       attempt that sampled NOTHING is not counted as an honest miss. */
    await app.setForeground("#ff0000");
    /* And drop the placement marker the last attempt left: within the grab
       radius it turns the next press into "pick that up" (two-stage
       placement), which once took the baseline from 0/10 to 10/10 —
       measuring the marker instead of the loupe. */
    await page.keyboard.press("Escape");
    await app.settle(240);
    let x = target.x + off.dx;
    let y = target.y + off.dy;
    await app.touchDown(x, y);
    await app.settle(300);
    if (useLoupe)
      // Twice: the first move lands on the pixel, the second confirms it — as a hand does.
      for (let i = 0; i < 2; i++) {
        const fix = await correctionFromLoupe();
        if (!fix) break;
        x += fix.dx;
        y += fix.dy;
        await app.touchMove(x, y, 1);
        await app.settle(260);
      }
    await app.touchUp();
    await app.settle(320);
    const got = (await page.evaluate(() => window.graphiq!.foreground())).toLowerCase();
    if (got.startsWith("#ffffff")) return "hit";
    return got.startsWith("#ff0000") ? "nothing" : "miss";
  };
  const tally = async (useLoupe: boolean) => {
    const out = { hit: 0, miss: 0, nothing: 0 };
    for (const off of OFFSETS) out[await attempt(off, useLoupe)]++;
    return out;
  };
  const blind = await tally(false);
  const guided = await tally(true);
  expect(blind.nothing + guided.nothing, "every attempt sampled something").toBe(0);
  expect(blind.hit, `without the loupe a ${AIM_ERROR}px aiming error mostly misses: ${blind.hit}/10`).toBeLessThanOrEqual(2);
  expect(guided.hit, `with it, the same attempts land: ${guided.hit}/10`).toBeGreaterThanOrEqual(9);
});

test("no loupe for a tool that places no point, nor for a mouse", async ({ app }) => {
  const { page } = app;
  const { target } = await whitePixelOnBlack(app);
  await app.key("b"); // a brush places a stroke, not a point
  await app.touchDown(target.x, target.y);
  await app.settle(400);
  const onBrush = await loupeShown(app);
  await app.touchUp();
  await app.settle(400);
  expect(onBrush, "none on the brush").toBe(false);

  await app.key("i");
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await app.settle(400);
  const onMouse = await loupeShown(app);
  await page.mouse.up();
  expect(onMouse, "none for a mouse, which occludes nothing").toBe(false);
});

// ---------------------------------------------------------- two-stage tap --

const TS_AIM = 5; // the item's own number
const GRAB_FROM = 18; // how far from the marker the grabbing finger lands

test.describe("the two-stage tap", () => {
  /** The foreground colour: where a sample lands. */
  const sampled = (app: App) => app.page.evaluate(() => window.graphiq!.foreground().toLowerCase().slice(0, 7));
  /** What the Info panel reports right now. */
  const info = (app: App) =>
    app.page.evaluate(() => {
      const rows = [...document.querySelectorAll('[class*="infoRow"]')];
      const read = (label: string) =>
        rows
          .find((r) => r.querySelector('[class*="infoLabel"]')?.textContent === label)
          ?.querySelector('[class*="infoValue"]')
          ?.textContent?.trim() ?? null;
      return { x: read("X"), y: read("Y"), rgb: read("RGB") };
    });
  /** Ink the overlay canvas draws within `r` px of a client point. */
  const overlayInkNear = (app: App, x: number, y: number, r: number) =>
    app.page.evaluate(
      ([x, y, rad]) => {
        const ov = [...document.querySelectorAll<HTMLCanvasElement>('[data-tour="canvas"] canvas')]
          .filter((c) => !c.hasAttribute("data-loupe"))
          .pop()!;
        const b = ov.getBoundingClientRect();
        const px = Math.round(x - b.left);
        const py = Math.round(y - b.top);
        const x0 = Math.max(0, px - rad);
        const y0 = Math.max(0, py - rad);
        const w = Math.min(ov.width - x0, rad * 2);
        const h = Math.min(ov.height - y0, rad * 2);
        if (w <= 0 || h <= 0) return 0;
        const d = ov.getContext("2d", { willReadFrequently: true })!.getImageData(x0, y0, w, h).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
        return n;
      },
      [x, y, r] as const,
    );
  const tap = async (app: App, x: number, y: number) => {
    await app.touchDown(x, y);
    await app.touchUp();
    await app.settle(600);
  };

  test("a missed tap leaves a marker that can be dragged onto the target, with Info following it", async ({ app }) => {
    const { feature, target } = await whitePixelOnBlack(app);
    /* Info renders nothing while it is not the panel shown, so it is picked in
       the panels sheet first; the sheet then closes and the panel stays
       mounted, updating, while the canvas is reachable. */
    await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
    await app.settle(700);
    expect(await app.openPanelById("info"), "the Info panel opens").toBe(true);
    await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
    await app.settle(700);
    await expect
      .poll(() => app.page.evaluate(() => document.querySelectorAll('[class*="infoRow"]').length), {
        message: "its readout is there to be watched",
      })
      .toBeGreaterThanOrEqual(4);

    await app.setForeground("#ff0000");
    const before = await overlayInkNear(app, target.x, target.y, 30);
    await tap(app, target.x + TS_AIM, target.y - TS_AIM);
    expect(await sampled(app), `a tap ${TS_AIM}px off samples the black around the target`).toBe("#000000");
    expect(await overlayInkNear(app, target.x, target.y, 30), "...and leaves a marker where it landed").toBeGreaterThan(
      before + 100,
    );

    /* Grabbed from GRAB_FROM px away and walked back onto the target one pixel
       at a time, the readout checked mid-drag, before anything commits. */
    const gx = target.x + TS_AIM + GRAB_FROM;
    const gy = target.y - TS_AIM + GRAB_FROM;
    await app.touchDown(gx, gy);
    await app.settle(350);
    expect(await info(app), "pressing near the marker grabs it: Info reads the MARKER, not the finger").toMatchObject({
      x: String(feature.x + TS_AIM),
      y: String(feature.y - TS_AIM),
    });
    for (let i = 1; i <= TS_AIM; i++) await app.touchMove(gx - i, gy + i, 1);
    await app.settle(450);
    expect(await info(app), "Info follows the marker onto the target, before release").toEqual({
      x: String(feature.x),
      y: String(feature.y),
      rgb: expect.stringMatching(/^255,\s*255,\s*255$/),
    });
    await app.touchUp();
    await app.settle(600);
    expect(await sampled(app), "the committed sample is the pixel the marker was dragged onto").toBe("#ffffff");
  });

  test("a press far from the marker samples afresh, Escape drops it, and a mouse gets none", async ({ app }) => {
    const { target } = await whitePixelOnBlack(app);
    await tap(app, target.x + TS_AIM, target.y - TS_AIM);
    await app.setForeground("#ff0000");
    const far = { x: target.x + 90, y: target.y + 60 };
    await tap(app, far.x, far.y);
    expect(await sampled(app), "a press well away takes a fresh sample there").toBe("#000000");
    const inkFar = await overlayInkNear(app, far.x, far.y, 30);
    expect(inkFar, "...and the marker moves to it").toBeGreaterThan(100);

    await app.page.keyboard.press("Escape");
    await app.settle(600);
    expect(await overlayInkNear(app, far.x, far.y, 30), "Escape drops the marker").toBeLessThan(100);
    expect(await sampled(app), "...and keeps the colour it sampled").toBe("#000000");

    await app.setForeground("#ff0000");
    await app.page.mouse.click(target.x + TS_AIM, target.y - TS_AIM);
    await app.settle(600);
    expect(await overlayInkNear(app, target.x, target.y, 30), "a mouse click leaves no marker").toBeLessThan(100);
  });
});

// ----------------------------------------------------------- clone source --
/* Alt-tap sets the clone source under the fingertip, and on a touchscreen that
   went wrong twice over: the source could not be adjusted, and could not even
   be SEEN once the finger lifted (measured before the fix: 372px of marker ink
   while pressed, 0 after release). Nothing on screen says whether a source is
   right, so the check is the clone itself: one dab far from the source, white
   only if the source is the one white pixel. Alt is the rule: with it a press
   near the source picks it up, without it a press paints, right next to the
   source included. A clone dab is a brush dab, so "carries the source" means
   bright (the hard 3px stamp lays down ~64), against the pure black a source
   5px off produces. (Ported from tools/verify-clone-source.js.) */

const CS_AIM = 5;

/** The colour of one DOCUMENT pixel (the view canvas is the document at 100%). */
const docPixel = (app: App, x: number, y: number) =>
  app.page.evaluate(
    ([x, y]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
      return [...c.getContext("2d", { willReadFrequently: true })!.getImageData(x, y, 1, 1).data];
    },
    [x, y] as const,
  );
const carriesSource = (rgba: number[]) => rgba[0] >= 32;

/** The white pixel on black, with a hard 3px Clone stamp that is NOT aligned:
 *  every press re-anchors to the source, so each dab samples the source itself
 *  rather than wherever the previous stroke's offset points. */
async function cloneSetup(app: App) {
  const placed = await whitePixelOnBlack(app);
  await app.key("s");
  expect(await app.setRange("Size", 3)).toBe(true);
  expect(await app.setRange("Hardness", 100)).toBe(true);
  const aligned = app.page.locator('[data-tour="options"] button[role="switch"]', { hasText: "Aligned" }).first();
  await expect(aligned, "the Aligned switch is in the options").toHaveCount(1);
  if ((await aligned.getAttribute("aria-checked")) === "true") await aligned.click();
  await expect(aligned, "the stamp is unaligned").toHaveAttribute("aria-checked", "false");
  return placed;
}

test("an Alt-tap leaves a clone source a finger can see, drag onto the target and clone from", async ({ app }) => {
  const { page } = app;
  const { feature, target } = await cloneSetup(app);
  const altChip = page.locator('[aria-label="Keyboard modifiers"] button', { hasText: /^Alt/ }).first();
  const armAlt = async () => {
    if ((await altChip.getAttribute("data-mode")) === "off") await altChip.tap();
    await expect(altChip, "the Alt chip arms").toHaveAttribute("data-mode", "armed");
  };
  const inkNear = (x: number, y: number, r: number) =>
    page.evaluate(
      ([x, y, rad]) => {
        const ov = [...document.querySelectorAll<HTMLCanvasElement>('[data-tour="canvas"] canvas')]
          .filter((c) => !c.hasAttribute("data-loupe"))
          .pop()!;
        const b = ov.getBoundingClientRect();
        const x0 = Math.max(0, Math.round(x - b.left) - rad);
        const y0 = Math.max(0, Math.round(y - b.top) - rad);
        const d = ov.getContext("2d", { willReadFrequently: true })!.getImageData(x0, y0, rad * 2, rad * 2).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
        return n;
      },
      [x, y, r] as const,
    );
  const tap = async (x: number, y: number) => {
    await app.touchDown(x, y);
    await app.touchUp();
    await app.settle(800);
  };
  const loupeAt = () => page.evaluate(() => document.querySelector("[data-loupe]")?.getAttribute("data-at") ?? null);

  await armAlt();
  await tap(target.x + CS_AIM, target.y - CS_AIM);
  expect(await inkNear(target.x, target.y, 26), "an Alt-tap leaves a source marker that survives the release").toBeGreaterThan(50);

  const dest = { x: feature.x + 60, y: feature.y + 40 };
  await tap(target.x + 60, target.y + 40);
  const wrong = await docPixel(app, dest.x, dest.y);
  expect(carriesSource(wrong), `a source ${CS_AIM}px off clones the wrong pixel: ${wrong}`).toBe(false);
  await page.keyboard.press("Control+z");
  await app.settle(1000);

  await armAlt();
  const gx = target.x + CS_AIM + 18;
  const gy = target.y - CS_AIM + 18;
  await app.touchDown(gx, gy);
  await app.settle(350);
  expect(await loupeAt(), "pressing near the source grabs it rather than re-setting it under the finger").toBe(
    `${feature.x + CS_AIM},${feature.y - CS_AIM}`,
  );
  for (let i = 1; i <= CS_AIM; i++) await app.touchMove(gx - i, gy + i, 1);
  await app.settle(450);
  expect(await loupeAt(), "...and the loupe follows the SOURCE onto the target").toBe(`${feature.x},${feature.y}`);
  await app.touchUp();
  await app.settle(700);

  await tap(target.x + 60, target.y + 40);
  const right = await docPixel(app, dest.x, dest.y);
  expect(carriesSource(right), `the clone now comes from the intended source: ${wrong} → ${right}`).toBe(true);

  await expect(altChip, "Alt is spent, so the next press is an ordinary one").toHaveAttribute("data-mode", "off");
  await tap(target.x + 3, target.y + 3);
  const near = await docPixel(app, feature.x + 3, feature.y + 3);
  expect(carriesSource(near), `a press NEAR the source without Alt paints instead of moving it: ${near}`).toBe(true);
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 }, hasTouch: false });

  test("a mouse Alt-drag still leaves the clone source where it was pressed", async ({ app }) => {
    const { page } = app;
    const { feature, target } = await cloneSetup(app);
    await page.keyboard.down("Alt");
    await page.mouse.move(target.x, target.y);
    await page.mouse.down();
    for (let i = 1; i <= 6; i++) await page.mouse.move(target.x + i * 5, target.y + i * 5);
    await page.mouse.up();
    await page.keyboard.up("Alt");
    await app.settle(600);
    await page.mouse.click(target.x + 60, target.y + 40);
    await app.settle(1000);
    const clone = await docPixel(app, feature.x + 60, feature.y + 40);
    expect(carriesSource(clone), `cloned ${clone}: the source stayed on the feature`).toBe(true);
  });
});
