/* A magnified view of the pixels a fingertip is covering.
 *
 * A bigger grab radius helps you catch a handle that already exists. It does
 * nothing for the opposite problem: the finger covers the pixels it is being
 * aimed at, so for the tools where placement IS the result — which pixel the
 * Eyedropper samples, where a pen anchor lands, where the clone source sits —
 * you are aiming at something you cannot see.
 *
 * The item's check is a hit rate against a no-loupe baseline, and the trap in
 * writing it is the same one that made the first grab-radius harness useless: a
 * scripted touch has no aiming error, so "tap the pixel, sample the pixel"
 * passes at 10/10 with no loupe at all. Every attempt here therefore lands
 * deliberately OFF the target, and the two runs differ only in what happens
 * next:
 *
 *   - the baseline commits where it landed, which is what a user without a
 *     loupe can do, since the pixel they wanted is under their fingertip;
 *   - the loupe run reads the LOUPE — not the document — to work out which way
 *     to move, drags there and commits. That is the script standing in for the
 *     eye, and it is only possible if the loupe is showing the right pixels.
 *
 * So the comparison is real, and it also makes the loupe's correctness the
 * thing being measured: a loupe showing the wrong region fails the run rather
 * than merely looking odd. That is checked directly as well, by reading its
 * centre pixel back against the document pixel under the contact.
 *
 * Run: node tools/verify-loupe.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

const MAG = 5; // must match LOUPE_MAG in CanvasArea
const AIM_ERROR = 6; // screen px each attempt lands off target — a modest finger

/** Ten deterministic misses around the target, so both runs face the same task. */
const OFFSETS = Array.from({ length: 10 }, (_, i) => {
  const a = (i * 2 * Math.PI) / 10;
  return { dx: Math.round(Math.cos(a) * AIM_ERROR), dy: Math.round(Math.sin(a) * AIM_ERROR) };
});

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
  const cdp = await context.newCDPSession(page);
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })),
    });

  // ---------------------------------------------------------------- setup --
  /* Driven through the app's own controls rather than keyboard shortcuts: the
     HEX field in the Colour panel and the Size slider in the options bar are
     both in the DOM whether or not their drawer is open, and both are exact.
     An earlier version pressed `d`, `x` and `[` x40 for the same effect and got
     a canvas painted entirely white - a setup whose result nobody can predict
     is not a setup. */
  const setValue = (selector, value) =>
    page.evaluate(
      ([sel, v]) => {
        const el =
          sel === "hex"
            ? [...document.querySelectorAll("input")].find((i) =>
                (i.getAttribute("aria-label") || "").toUpperCase().includes("HEX"),
              )
            : [...document.querySelectorAll('input[type="range"]')].find(
                (i) => i.getAttribute("aria-label") === sel,
              );
        if (!el) return false;
        /* React listens to the native input event, and assigning `.value`
           directly is invisible to it - the prototype's setter is the way in. */
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      [selector, value],
    );

  /* Painted with the PENCIL alone, never the paint bucket. A bucket fill on
     this build keeps tracking the foreground colour after the fact: fill black,
     then pick white for the pencil, and the fill turns white too — with no
     further action, and Undo does not put it back. That is a real defect and
     has its own item; here it simply makes the bucket unusable as a backdrop,
     because the setup needs two colours on one layer. A pencil stroke stays the
     colour it was painted. */
  await page.keyboard.press("Control+Shift+N");
  await page.waitForTimeout(1200);
  check("the foreground colour can be set exactly", await setValue("hex", "000000"));
  await page.waitForTimeout(500);
  await page.keyboard.press("n"); // pencil: hard-edged, no falloff
  await page.waitForTimeout(400);
  check("the pencil size can be set exactly", await setValue("Size", "400"));
  await page.waitForTimeout(400);
  const cv = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  await page.mouse.click(Math.round(cv.x + cv.width / 2), Math.round(cv.y + cv.height / 2));
  await page.waitForTimeout(1100);

  await setValue("hex", "FFFFFF");
  await page.waitForTimeout(500);
  await setValue("Size", "1");
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+1"); // 100% — the zoom the item names
  await page.waitForTimeout(900);
  /* Placed by the VIEWPORT, not the artwork: at 100% a 1920px document hangs
     far outside a 390px screen, so the canvas's own top-left sits at a negative
     client coordinate and anything measured from it lands off screen. The
     viewport's centre is the document's centre, which is where the black patch
     is — so the white pixel lands inside it. */
  const vpBox = await page.locator('[data-tour="canvas"] [class*="viewport"]').first().boundingBox();
  await page.mouse.click(
    Math.round(vpBox.x + vpBox.width / 2),
    Math.round(vpBox.y + vpBox.height / 2),
  );
  await page.waitForTimeout(1000);

  /** The white pixels, in DOCUMENT coordinates — and the black around them. */
  const feature = await page.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    const g = c.getContext("2d", { willReadFrequently: true });
    const d = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0, sx = 0, sy = 0, minX = 1e9, maxX = -1, minY = 1e9, maxY = -1, dark = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] > 200 && d[i] < 40 && d[i + 1] < 40 && d[i + 2] < 40) dark++;
      if (d[i] < 200 || d[i + 1] < 200 || d[i + 2] < 200 || d[i + 3] < 200) continue;
      const x = (i / 4) % c.width;
      const y = Math.floor(i / 4 / c.width);
      n++; sx += x; sy += y;
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    }
    return n ? { n, dark, x: sx / n, y: sy / n, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  });
  check("a 1px white feature sits on a black patch",
    !!feature && feature.n === 1 && feature.dark > 10000,
    feature ? `${feature.n}px white at ${feature.x},${feature.y}, on ${feature.dark}px of black` : "none");

  /** Document point -> client point, through the artwork canvas's own box. */
  const docToClient = async (dx, dy) => {
    const r = await page.evaluate(() => {
      const c = document.querySelector('[data-tour="canvas"] canvas');
      const b = c.getBoundingClientRect();
      return { left: b.left, top: b.top, sx: b.width / c.width, sy: b.height / c.height };
    });
    /* The app floors the document coordinate, and the touch dispatcher rounds
       the client one to an integer — so the point wanted is the smallest whole
       client coordinate that still floors INTO the target pixel. Aiming at the
       pixel centre (dx + 0.5) rounds up off the end of it, which put every
       attempt one pixel down and right of the feature. */
    return {
      x: Math.ceil(r.left + dx * r.sx),
      y: Math.ceil(r.top + dy * r.sy),
      scale: r.sx,
    };
  };
  const target = await docToClient(feature.x, feature.y);
  check("...and the view is at 100%, so one document pixel is one screen pixel",
    Math.abs(target.scale - 1) < 0.01, `scale ${target.scale.toFixed(3)}`);

  await page.keyboard.press("i"); // eyedropper
  await page.waitForTimeout(500);

  /** The foreground swatch, which is where a sample lands. */
  /* The swatch paints its colour as `linear-gradient(c, c)` over a checker, so
     `backgroundColor` is transparent and reads as nothing at all. */
  const sampled = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-tour="toolbar"] [class*="swatchWrapFg"] [class*="swatch"]');
      if (!el) return "none";
      const m = getComputedStyle(el).backgroundImage.match(/linear-gradient\((rgba?\([^)]*\))/);
      return m ? m[1] : "none";
    });
  const isWhite = (c) => /^rgba?\(\s*2[45]\d,\s*2[45]\d,\s*2[45]\d/.test(c);

  // ------------------------------------------------- the loupe's own truth --
  await touch("touchStart", [{ x: target.x, y: target.y }]);
  await page.waitForTimeout(500);
  const shown = await page.evaluate(() => {
    const el = document.querySelector("[data-loupe]");
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      visible: getComputedStyle(el).display !== "none",
      at: el.getAttribute("data-at"),
      rect: { l: r.left, t: r.top, r: r.right, b: r.bottom },
      centre: (() => {
        const g = el.getContext("2d");
        const d = g.getImageData(el.width / 2, el.height / 2, 1, 1).data;
        return `${d[0]},${d[1]},${d[2]}`;
      })(),
    };
  });
  check("the loupe appears for a finger on the Eyedropper", !!shown && shown.visible);
  check("…centred on the document pixel under the contact",
    shown && shown.at === `${Math.floor(feature.x)},${Math.floor(feature.y)}`,
    `data-at=${shown?.at}, feature at ${Math.floor(feature.x)},${Math.floor(feature.y)}`);
  check("…and showing that pixel, not some other part of the picture",
    shown && /^2[45]\d,2[45]\d,2[45]\d$/.test(shown.centre),
    `centre pixel rgb(${shown?.centre}) over a white feature on black`);
  /* The one position it must never take. */
  const clear = shown && (target.y < shown.rect.t - 8 || target.y > shown.rect.b + 8 ||
                          target.x < shown.rect.l - 8 || target.x > shown.rect.r + 8);
  check("…and standing clear of the contact point it is describing", clear,
    shown ? `contact ${Math.round(target.x)},${Math.round(target.y)} vs loupe ${Math.round(shown.rect.l)},${Math.round(shown.rect.t)}–${Math.round(shown.rect.r)},${Math.round(shown.rect.b)}` : "");
  await touch("touchEnd", []);
  await page.waitForTimeout(400);
  const afterRelease = await page.evaluate(
    () => getComputedStyle(document.querySelector("[data-loupe]")).display,
  );
  check("…and it goes away on release", afterRelease === "none", `display: ${afterRelease}`);

  // ------------------------------------------------------- the two runs -----
  /** Where the loupe says the white pixel is, as a screen-space correction.
   *  Read from the LOUPE's pixels, never from the document — that is the whole
   *  point. The centre is skipped because the marker drawn there is light too. */
  const correctionFromLoupe = () =>
    page.evaluate((mag) => {
      const el = document.querySelector("[data-loupe]");
      if (!el || getComputedStyle(el).display === "none") return null;
      const g = el.getContext("2d");
      const d = g.getImageData(0, 0, el.width, el.height).data;
      const cx = el.width / 2, cy = el.height / 2;
      let best = null, bestLum = 600;
      for (let y = 0; y < el.height; y++) {
        for (let x = 0; x < el.width; x++) {
          if (Math.hypot(x - cx, y - cy) < 10) continue; // the centre marker
          const i = (y * el.width + x) * 4;
          const lum = d[i] + d[i + 1] + d[i + 2];
          if (lum > bestLum) { bestLum = lum; best = { x, y }; }
        }
      }
      return best ? { dx: (best.x - cx) / mag, dy: (best.y - cy) / mag } : null;
    }, MAG);

  /** One attempt: land `off` from the target, optionally steer by the loupe. */
  const attempt = async (off, useLoupe) => {
    /* Reset to a colour that is NEITHER the feature nor the background, so an
       attempt that sampled nothing at all is distinguishable from one that
       sampled the background - otherwise a press that never reached the canvas
       would be counted as an honest miss. */
    await setValue("hex", "FF0000");
    await page.waitForTimeout(260);
    let x = target.x + off.dx;
    let y = target.y + off.dy;
    await touch("touchStart", [{ x, y }]);
    await page.waitForTimeout(300);
    if (useLoupe) {
      /* Twice: the first move lands the finger on the pixel, the second lets
         the loupe confirm it — which is exactly what a hand does. */
      for (let i = 0; i < 2; i++) {
        const fix = await correctionFromLoupe();
        if (!fix) break;
        x += fix.dx;
        y += fix.dy;
        await touch("touchMove", [{ x, y }]);
        await page.waitForTimeout(260);
      }
    }
    await touch("touchEnd", []);
    await page.waitForTimeout(320);
    const got = await sampled();
    if (isWhite(got)) return "hit";
    return /^rgba?\(\s*2[45]\d,\s*[0-9]+,\s*[0-9]+/.test(got) ? "nothing" : "miss";
  };

  const tally = async (useLoupe) => {
    const out = { hit: 0, miss: 0, nothing: 0 };
    for (const off of OFFSETS) out[await attempt(off, useLoupe)]++;
    return out;
  };
  const blindR = await tally(false);
  const guidedR = await tally(true);
  const blind = blindR.hit;
  const guided = guidedR.hit;
  check("every attempt actually sampled something, in both runs",
    blindR.nothing === 0 && guidedR.nothing === 0,
    `${blindR.nothing} + ${guidedR.nothing} of 20 attempts never reached the canvas`);

  check(`without the loupe, a ${AIM_ERROR}px aiming error mostly misses a 1px feature`,
    blind <= 2, `${blind}/10 attempts sampled the right pixel`);
  check("with the loupe, the same attempts land on it",
    guided >= 9, `${guided}/10 attempts sampled the right pixel`);
  check("…and that is an improvement, which is the comparison the item asks for",
    guided > blind, `${blind}/10 → ${guided}/10`);

  /* ---- near the top of the screen, where "above the finger" has no room ----
     The loupe defaults to sitting above the contact. Near the top edge that
     would put it off screen inside a viewport that clips, which is the same as
     not having one — so it flips below instead. Either position is fine; being
     ON the finger never is. */
  const highUp = { x: Math.round(vpBox.x + vpBox.width / 2), y: Math.round(vpBox.y + 24) };
  await touch("touchStart", [{ x: highUp.x, y: highUp.y }]);
  await page.waitForTimeout(450);
  const flipped = await page.evaluate(() => {
    const el = document.querySelector("[data-loupe]");
    const r = el.getBoundingClientRect();
    return { t: r.top, b: r.bottom, l: r.left, r: r.right, vis: getComputedStyle(el).display !== "none" };
  });
  await touch("touchEnd", []);
  await page.waitForTimeout(300);
  check("near the top of the screen the loupe flips below the finger",
    flipped.vis && flipped.t > highUp.y,
    `contact y=${highUp.y}, loupe spans y ${Math.round(flipped.t)}–${Math.round(flipped.b)}`);
  check("…and is still fully on screen there",
    flipped.t >= 0 && flipped.b <= 844 && flipped.l >= 0 && flipped.r <= 390,
    `${Math.round(flipped.l)},${Math.round(flipped.t)}–${Math.round(flipped.r)},${Math.round(flipped.b)} in 390×844`);

  // ----------------------------------------------- where it must NOT appear --
  await page.keyboard.press("b"); // brush: placement is a stroke, not a point
  await page.waitForTimeout(400);
  await touch("touchStart", [{ x: target.x, y: target.y }]);
  await page.waitForTimeout(400);
  const onBrush = await page.evaluate(
    () => getComputedStyle(document.querySelector("[data-loupe]")).display,
  );
  await touch("touchEnd", []);
  await page.waitForTimeout(400);
  check("no loupe for tools that do not place a point", onBrush === "none", `display: ${onBrush}`);

  await page.keyboard.press("i");
  await page.waitForTimeout(400);
  await page.mouse.move(target.x, target.y);
  await page.mouse.down();
  await page.waitForTimeout(400);
  const onMouse = await page.evaluate(
    () => getComputedStyle(document.querySelector("[data-loupe]")).display,
  );
  await page.mouse.up();
  check("and none for a mouse, which occludes nothing", onMouse === "none", `display: ${onMouse}`);

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
