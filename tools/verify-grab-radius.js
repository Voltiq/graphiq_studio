/* On-canvas handles a finger can actually catch.
 *
 * Every hit test on the canvas was written against a mouse: 8–12 CSS px, which
 * is about right for a hotspot the user can see. A fingertip is neither small
 * nor visible — the contact patch is around 8–10mm, the reported point is its
 * centroid rather than anywhere the user aimed, and the finger covers the
 * target on the way down. Measured here before the fix: a touch 12px from a
 * crop handle missed it, and the miss did not merely fail. It landed outside
 * the box, which the crop tool reads as "rubber-band a new one" — so a slightly
 * off grab DESTROYED the box being adjusted.
 *
 * The check is therefore not "can a perfectly-aimed tap hit a handle": a
 * synthetic touch is infinitely precise, so that passes at any radius at all
 * and says nothing. Every attempt here is deliberately dispatched OFF the
 * handle by a realistic aiming error, which is the thing the radius has to
 * absorb, and off it OUTWARD, which is the direction where a miss is
 * destructive rather than merely useless.
 *
 * Three things are asserted separately, because each catches a different way
 * for this to be wrong:
 *
 *   - every one of the eight handles is caught, on the first attempt;
 *   - no attempt started a new crop, checked by name rather than inferred from
 *     "the box changed somehow";
 *   - the same offsets with a MOUSE still miss. That is the control: it proves
 *     the offsets are genuinely outside the mouse-sized radius, so the touch
 *     column is measuring the scaling and not a target that was always big
 *     enough.
 *
 * Run: node tools/verify-grab-radius.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

/** How far off each attempt lands — outside the mouse's 9px, inside a finger's. */
const OFFSET = 14;

/* The crop shield dims everything outside the box (alpha 166) and everything
   inside it far less (58), so the box is the bounding box of the lighter
   pixels on the overlay canvas. Read from the pixels rather than from React
   state on purpose: this is the box the user can see. */
const BOX = () => {
  /* The overlay is the last canvas that is NOT the loupe. "The last canvas"
     alone was right until the loupe was added after it, at which point this
     started measuring a 132px circle and reporting every handle as missed. */
  const ov = [...document.querySelectorAll('[data-tour="canvas"] canvas')]
    .filter((c) => !c.hasAttribute("data-loupe"))
    .pop();
  const g = ov.getContext("2d", { willReadFrequently: true });
  const d = g.getImageData(0, 0, ov.width, ov.height).data;
  let x0 = 1e9,
    y0 = 1e9,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < ov.height; y++) {
    for (let x = 0; x < ov.width; x++) {
      if (d[(y * ov.width + x) * 4 + 3] > 100) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  const r = ov.getBoundingClientRect();
  return { x: Math.round(r.left + x0), y: Math.round(r.top + y0), w: x1 - x0, h: y1 - y0 };
};

/** The eight handles, as unit directions from the box centre. */
const DIRS = {
  nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0],
  se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0],
};

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const tour = await page
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(800);
  await dismissStartCard(page); // a fresh phone opens on the launch card
  const cdp = await context.newCDPSession(page);

  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })),
    });
  const drag = async (fx, fy, tx, ty, withMouse) => {
    if (withMouse) {
      await page.mouse.move(fx, fy);
      await page.mouse.down();
      for (let i = 1; i <= 8; i++)
        await page.mouse.move(fx + ((tx - fx) * i) / 8, fy + ((ty - fy) * i) / 8);
      await page.mouse.up();
    } else {
      await touch("touchStart", [{ x: fx, y: fy }]);
      for (let i = 1; i <= 8; i++)
        await touch("touchMove", [{ x: fx + ((tx - fx) * i) / 8, y: fy + ((ty - fy) * i) / 8 }]);
      await touch("touchEnd", []);
    }
    await page.waitForTimeout(520);
  };

  await page.keyboard.press("c");
  await page.waitForTimeout(800);
  /* Selecting Crop lays a box over the WHOLE document, and that box is useless
     here: every outward attempt would start off the artwork canvas, which is
     the element carrying the pointer handlers, so the press would not reach the
     crop tool at all — for a mouse either. The box is inset with the mouse
     first, which also re-establishes it between attempts. */
  /* Selecting Crop lays a box over the WHOLE document, Escape does not clear it,
     and a drag inside it only moves it — so the only way to get a box with room
     around it is to pull its corners in. Which is awkward for one reason: at the
     fit zoom the document's own right edge (x=377) already lies UNDER the 20px
     edge-swipe strip that starts at x=370, so the press that would grab the
     bottom-right corner is taken by the drawer gesture instead. It is done
     zoomed out, where every corner is in the clear, and the view returns to fit
     afterwards — the box is in document coordinates, so it comes back with it.

     Every number is load-bearing:
       - both insets must exceed OFFSET, or an attempt starts off the artwork
         canvas, which is the element carrying the pointer handlers, and never
         reaches the crop tool at all — for a mouse either;
       - the bottom-right inset is larger so that corner, plus its outward
         offset, clears the right-hand strip;
       - what is left must stay big enough that the RADIUS is what the check
         measures. The crop tool caps a handle at 40% of the box's smaller
         half-extent, so the corners cannot swallow the "move" region on a small
         box; inset too far and the cap, not the pointer type, decides. */
  const INSET_NW = 11;
  const INSET_SE = 20;
  const reset = async () => {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(350);
    await page.keyboard.press("c");
    await page.waitForTimeout(500);
    await page.keyboard.press("Control+Minus");
    await page.waitForTimeout(600);
    const f = await page.evaluate(BOX);
    await drag(f.x, f.y, f.x + INSET_NW, f.y + INSET_NW, true);
    await drag(f.x + f.w, f.y + f.h, f.x + f.w - INSET_SE, f.y + f.h - INSET_SE, true);
    await page.keyboard.press("Control+0"); // back to fit, box and all
    await page.waitForTimeout(700);
    return page.evaluate(BOX);
  };

  const start = await reset();

  check("a crop box is on screen to grab, inset from the document edges",
    !!start && start.w > 120 && start.h > 60,
    start ? `${start.w}×${start.h} at ${start.x},${start.y}` : "no box found");

  const clearOfStrips = start && start.x - OFFSET > 20 && start.x + start.w + OFFSET < 370;
  check("…and every attempt lands clear of the 20px edge-swipe strips",
    clearOfStrips,
    start ? `attempts span ${start.x - OFFSET}–${start.x + start.w + OFFSET} of 20–370` : "");
  /* The radius is capped at 40% of the smaller half-extent, so on a box this
     size the cap must not be what the touch column is measuring. */
  const capPx = start ? Math.min(start.w, start.h) * 0.2 : 0;
  check("…and big enough that the handle radius is not capped below the finger's",
    capPx >= 22.5, `cap ${capPx.toFixed(1)}px vs a finger's 22.5px`);


  const edge = (box, u, axis) =>
    axis === "x" ? (u < 0 ? box.x : box.x + box.w) : u < 0 ? box.y : box.y + box.h;

  /** One attempt at one handle: grabbed / new crop / neither. */
  const attempt = async (box, key, withMouse) => {
    const [ux, uy] = DIRS[key];
    const hx = box.x + box.w * (ux === 0 ? 0.5 : ux < 0 ? 0 : 1);
    const hy = box.y + box.h * (uy === 0 ? 0.5 : uy < 0 ? 0 : 1);
    // Off the handle, outward — where a miss starts a new crop.
    const ox = hx + ux * OFFSET;
    const oy = hy + uy * OFFSET;
    await drag(ox, oy, ox - ux * 34, oy - uy * 34, withMouse);
    const after = await page.evaluate(BOX);
    if (!after) return "gone";
    /* A new crop is a box that no longer shares ANY edge with the old one and
       is much smaller — named explicitly, because the item's requirement is
       not just "the handle worked" but "nothing started a new crop". */
    const sharesAnEdge =
      Math.abs(after.x - box.x) <= 4 ||
      Math.abs(after.y - box.y) <= 4 ||
      Math.abs(after.x + after.w - (box.x + box.w)) <= 4 ||
      Math.abs(after.y + after.h - (box.y + box.h)) <= 4;
    if (!sharesAnEdge && after.w < box.w * 0.6 && after.h < box.h * 0.6) return "new crop";
    /* Grabbed ⇔ the handle's own edge moved inward while the opposite edge
       stayed put, and an axis the handle does not own did not move at all.
       Not "the box shrank by the drag distance": the corner snaps to the
       pointer, so an attempt starting OFFSET px away shrinks it by
       34 - OFFSET, and reading that arithmetic as a miss is exactly how an
       earlier version of this measured every radius as 4px. */
    for (const [u, axis] of [[ux, "x"], [uy, "y"]]) {
      if (u === 0) {
        if (Math.abs(edge(after, -1, axis) - edge(box, -1, axis)) > 4) return "moved";
        if (Math.abs(edge(after, 1, axis) - edge(box, 1, axis)) > 4) return "moved";
        continue;
      }
      const inward = (edge(after, u, axis) - edge(box, u, axis)) * -u;
      const opposite = Math.abs(edge(after, -u, axis) - edge(box, -u, axis));
      if (inward < 10 || opposite > 4) return "missed";
    }
    return "grabbed";
  };

  const sweep = async (withMouse) => {
    const out = {};
    for (const key of Object.keys(DIRS)) {
      const box = await reset();
      out[key] = await attempt(box, key, withMouse);
    }
    return out;
  };

  // ------------------------------------------------------------------ touch --
  const byTouch = await sweep(false);
  const caught = Object.values(byTouch).filter((r) => r === "grabbed").length;
  check(
    `all eight handles are caught by a touch ${OFFSET}px off them`,
    caught === 8,
    Object.entries(byTouch).map(([k, v]) => `${k}:${v}`).join(" "),
  );
  const newCrops = Object.values(byTouch).filter((r) => r === "new crop").length;
  check("…and no attempt started a new crop over the box being adjusted",
    newCrops === 0, `${newCrops} of 8 attempts replaced the box`);

  // ---------------------------------------------- the mouse, as the control --
  const byMouse = await sweep(true);
  const mouseCaught = Object.values(byMouse).filter((r) => r === "grabbed").length;
  check(
    `the same offsets still MISS with a mouse, so ${OFFSET}px is a real miss`,
    mouseCaught === 0,
    Object.entries(byMouse).map(([k, v]) => `${k}:${v}`).join(" "),
  );

  // A mouse ON the handle must still work — the radius shrank for nobody.
  const box = await reset();
  const onTarget = await (async () => {
    const [ux, uy] = DIRS.se;
    const hx = box.x + box.w,
      hy = box.y + box.h;
    await drag(hx, hy, hx - 34, hy - 34, true);
    const after = await page.evaluate(BOX);
    return after && box.w - after.w >= 10 && box.h - after.h >= 10;
  })();
  check("a mouse ON a handle still grabs it exactly as before", onTarget);

  /* ---- the cap, which a bigger radius makes necessary ----
     A finger's radius is 2.5x a mouse's, and on a SMALL box that is wider than
     the box itself: every point would be within reach of both the top and the
     bottom handle, the corner tests would claim all of it, and "move" — the
     thing you get by pressing the middle — would have nowhere left to live.
     The radius is therefore capped at 40% of the smaller half-extent. Checked
     by pressing the middle of a small box and requiring it to MOVE: both edges
     shift together, which a resize can never do. */
  await page.keyboard.press("Escape");
  await page.waitForTimeout(350);
  await page.keyboard.press("c");
  await page.waitForTimeout(600);
  const fullBox = await page.evaluate(BOX);
  // Pull the top-left corner right in, leaving a small box at the far corner.
  await drag(fullBox.x, fullBox.y, fullBox.x + fullBox.w - 70, fullBox.y + fullBox.h - 30, true);
  const small = await page.evaluate(BOX);
  /* ~30px tall is the size that makes the cap decide. Half of that is 15px,
     which is INSIDE an uncapped finger radius of 22.5 — so without the cap the
     centre of this box is within reach of both the top and the bottom handle
     and the press resizes. With it the radius falls back to the mouse's 9px,
     which 15px clears. A 44px-tall box (the first version of this) sat on the
     wrong side of that line and the mutation survived it. */
  check("a small crop box can be made to test the cap against",
    small && small.h >= 20 && small.h <= 36 && small.w > 50,
    small ? `${small.w}×${small.h} — half-height ${(small.h / 2).toFixed(1)}px vs an uncapped 22.5px radius` : "none");

  const cx = small.x + small.w / 2;
  const cy = small.y + small.h / 2;
  await drag(cx, cy, cx - 30, cy - 30, false); // a finger, in the middle
  const moved = await page.evaluate(BOX);
  const shiftedL = small.x - moved.x;
  const shiftedR = small.x + small.w - (moved.x + moved.w);
  check(
    "pressing the middle of a small box still MOVES it rather than resizing it",
    moved && Math.abs(moved.w - small.w) <= 4 && Math.abs(moved.h - small.h) <= 4 && shiftedL > 10,
    `${small.w}×${small.h} → ${moved.w}×${moved.h}, edges shifted ${shiftedL}/${shiftedR}px`,
  );

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await context.close();
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
