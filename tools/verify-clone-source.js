/* Placing a clone source with a finger.
 *
 * Alt-tap sets the clone source at whatever pixel the fingertip covered, and on
 * a touchscreen that went wrong twice over. The source could not be adjusted —
 * the same gap two-stage placement closed for the Eyedropper — and worse, it
 * could not even be SEEN: the marker was drawn only while a pointer hovered the
 * canvas, which on a mouse is always and on a finger is never once the tap is
 * over. Measured before the fix: 372 pixels of overlay ink while pressed, 0
 * after release.
 *
 * The source is harder to place than an Eyedropper sample, because nothing on
 * screen tells you whether you got it right: the sample at least changes the
 * foreground colour. So the check is the clone itself. A single dab is laid
 * down far from the source and its colour read back — white only if the source
 * really is the one white pixel in the picture.
 *
 * The rule this item needed was how a press near the source differs from one
 * that starts painting, and the answer is Alt: with it, a press near the source
 * picks the source up; without it, a press paints, including right next to the
 * source, which is what cloning usually looks like.
 *
 * Desktop is asserted unchanged by the same oracle from the other direction: a
 * mouse Alt-drag must LEAVE the source where it was pressed, because that is
 * what it has always done.
 *
 * Run: node tools/verify-clone-source.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg, withOptionsSheet } = require("./lib/launch");

const AIM_ERROR = 5; // how far off the Alt-tap lands
const GRAB_FROM = 18; // how far from the marker the grabbing finger lands

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const setValueIn = (page, selector, value) =>
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
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      [selector, value],
    );

  /** A black patch with exactly one white pixel on it, viewed at 100%. */
  const build = async (page) => {
    await page.keyboard.press("Control+Shift+N");
    await page.waitForTimeout(1200);
    await setValueIn(page, "hex", "000000");
    await page.waitForTimeout(400);
    await page.keyboard.press("n"); // pencil
    await page.waitForTimeout(400);
    await withOptionsSheet(page, () => setValueIn(page, "Size", "400"));
    await page.waitForTimeout(400);
    const cv = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await page.mouse.click(Math.round(cv.x + cv.width / 2), Math.round(cv.y + cv.height / 2));
    await page.waitForTimeout(1100);
    await setValueIn(page, "hex", "FFFFFF");
    await page.waitForTimeout(400);
    await withOptionsSheet(page, () => setValueIn(page, "Size", "1"));
    await page.waitForTimeout(400);
    await page.keyboard.press("Control+1");
    await page.waitForTimeout(900);
    const vp = await page.locator('[data-tour="canvas"] [class*="viewport"]').first().boundingBox();
    await page.mouse.click(Math.round(vp.x + vp.width / 2), Math.round(vp.y + vp.height / 2));
    await page.waitForTimeout(1000);
    const geom = await page.evaluate(() => {
      const c = document.querySelector('[data-tour="canvas"] canvas');
      const bb = c.getBoundingClientRect();
      const d = c.getContext("2d", { willReadFrequently: true })
        .getImageData(0, 0, c.width, c.height).data;
      let found = null, n = 0;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] > 200 && d[i + 1] > 200 && d[i + 2] > 200 && d[i + 3] > 200) {
          n++;
          if (!found) found = { fx: (i / 4) % c.width, fy: Math.floor(i / 4 / c.width) };
        }
      }
      return found && { ...found, n, left: bb.left, top: bb.top, sx: bb.width / c.width };
    });
    await page.keyboard.press("s"); // clone stamp
    await page.waitForTimeout(500);
    /* A hard 3px stamp, and Aligned turned OFF.
       - Hardness 100 for as crisp a tip as the tool offers. It does NOT make
         the dab fully opaque — a single tap of this stamp over the white pixel
         measures rgb(64,64,64), not rgb(255,255,255), because flow and dab
         coverage still apply. That is fine and the checks say so: the contrast
         being asserted is 64 against the pure 0 a source 5px off produces.
       - Aligned OFF so every press re-anchors the offset to `source - press`,
         which makes a dab at P sample exactly the source. With it ON (the
         default) the offset from the PREVIOUS stroke persists, and a second dab
         samples somewhere else entirely — correct behaviour that would make
         each check here depend on every check before it. */
    await withOptionsSheet(page, () => setValueIn(page, "Size", "3"));
    await page.waitForTimeout(300);
    await withOptionsSheet(page, () => setValueIn(page, "Hardness", "100"));
    await page.waitForTimeout(300);
    /* On a phone the toggle lives in the options SHEET, which is not rendered
       until it is opened — so this used to find nothing and silently leave
       Aligned on, which then broke the checks that depend on it. */
    const alignedState = await withOptionsSheet(page, async () => {
      const aligned = page
        .locator('[data-tour="options"] button[role="switch"]', { hasText: "Aligned" })
        .first();
      if (!(await aligned.count())) return null;
      if ((await aligned.getAttribute("aria-checked")) === "true") {
        await aligned.click();
        await page.waitForTimeout(400);
      }
      return aligned.getAttribute("aria-checked");
    });
    return { ...geom, aligned: alignedState };
  };

  /** The colour of one DOCUMENT pixel. */
  const docPixel = (page, dx, dy) =>
    page.evaluate(([x, y]) => {
      const c = document.querySelector('[data-tour="canvas"] canvas');
      const d = c.getContext("2d", { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
      return `rgba(${d[0]},${d[1]},${d[2]},${d[3]})`;
    }, [dx, dy]);
  /* "Carries the source" rather than "is pure white": a clone dab is a brush
     dab, so its value depends on tip and flow. What matters is that it is not
     the pure black it would be from a source 5px off — the two outcomes are
     0 and 200-plus, which is not a close call. */
  const carriesSource = (c) => {
    const m = c.match(/^rgba\((\d+),(\d+),(\d+),/);
    return !!m && Number(m[1]) >= 32;
  };
  /** Overlay ink within `r` px of a client point — the source marker, if drawn. */
  const inkNear = (page, cx, cy, r) =>
    page.evaluate(
      ([x, y, rad]) => {
        const ov = [...document.querySelectorAll('[data-tour="canvas"] canvas')]
          .filter((c) => !c.hasAttribute("data-loupe"))
          .pop();
        const b = ov.getBoundingClientRect();
        const g = ov.getContext("2d", { willReadFrequently: true });
        const x0 = Math.max(0, Math.round(x - b.left) - rad);
        const y0 = Math.max(0, Math.round(y - b.top) - rad);
        const d = g.getImageData(x0, y0, rad * 2, rad * 2).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
        return n;
      },
      [cx, cy, r],
    );

  // ================================================================= touch ==
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

  const geom = await build(page);
  check("a 1px white feature on a black patch, at 100%, with the Clone stamp",
    geom && geom.n === 1 && Math.abs(geom.sx - 1) < 0.01,
    geom ? `${geom.n}px at ${geom.fx},${geom.fy}, scale ${geom.sx.toFixed(3)}` : "none");
  check("…and the stamp is unaligned, so each dab samples the source itself",
    geom && geom.aligned === "false", `Aligned is ${geom?.aligned}`);

  const target = {
    x: Math.ceil(geom.left + geom.fx * geom.sx),
    y: Math.ceil(geom.top + geom.fy * geom.sx),
  };
  /* Alt is the rule: with it a press near the source moves the source, without
     it a press paints. On a phone that is the options-bar chip, which is the
     path a finger actually has — so the harness taps the chip rather than
     synthesising a key nobody can press. */
  const altChip = page
    .locator('[aria-label="Keyboard modifiers"] button', { hasText: /^Alt/ })
    .first();
  const armAlt = async () => {
    if ((await altChip.getAttribute("data-mode")) === "off") await altChip.click();
    await page.waitForTimeout(350);
  };

  // ---- the tap that misses, and the marker it now leaves --------------------
  await armAlt();
  check("the Alt chip arms", (await altChip.getAttribute("data-mode")) === "armed",
    `data-mode="${await altChip.getAttribute("data-mode")}"`);
  await touch("touchStart", [{ x: target.x + AIM_ERROR, y: target.y - AIM_ERROR }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(700);
  const inkAfterTap = await inkNear(page, target.x, target.y, 26);
  check("an Alt-tap leaves a source marker that survives the release",
    inkAfterTap > 50, `overlay ink near the tap after release: ${inkAfterTap}`);

  // ---- what that source would clone: the reproduction ----------------------
  const dest = { dx: geom.fx + 60, dy: geom.fy + 40 };
  await touch("touchStart", [{ x: target.x + 60, y: target.y + 40 }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(900);
  const wrongClone = await docPixel(page, dest.dx, dest.dy);
  check(`a source ${AIM_ERROR}px off clones the wrong pixel`,
    !carriesSource(wrongClone), `cloned ${wrongClone} — the black around the feature`);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1000);

  // ---- the item's own sequence: grab the marker and walk it onto the pixel --
  await armAlt();
  const gx = target.x + AIM_ERROR + GRAB_FROM;
  const gy = target.y - AIM_ERROR + GRAB_FROM;
  await touch("touchStart", [{ x: gx, y: gy }]);
  await page.waitForTimeout(350);
  const grabbedAt = await page.evaluate(
    () => document.querySelector("[data-loupe]")?.getAttribute("data-at") ?? null,
  );
  check("pressing near the source grabs it rather than re-setting it under the finger",
    grabbedAt === `${geom.fx + AIM_ERROR},${geom.fy - AIM_ERROR}`,
    `the loupe is centred on ${grabbedAt}; the source was set at ` +
      `${geom.fx + AIM_ERROR},${geom.fy - AIM_ERROR} and the finger is at ` +
      `${geom.fx + AIM_ERROR + GRAB_FROM},${geom.fy - AIM_ERROR + GRAB_FROM}`);

  for (let i = 1; i <= AIM_ERROR; i++) await touch("touchMove", [{ x: gx - i, y: gy + i }]);
  await page.waitForTimeout(450);
  const draggedAt = await page.evaluate(
    () => document.querySelector("[data-loupe]")?.getAttribute("data-at") ?? null,
  );
  check("…and the loupe follows the SOURCE onto the target while it is dragged",
    draggedAt === `${geom.fx},${geom.fy}`,
    `loupe centred on ${draggedAt}; the feature is at ${geom.fx},${geom.fy}`);
  await touch("touchEnd", []);
  await page.waitForTimeout(700);

  // ---- the check that matters: what does it clone now? ---------------------
  await touch("touchStart", [{ x: target.x + 60, y: target.y + 40 }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(1000);
  const rightClone = await docPixel(page, dest.dx, dest.dy);
  check("the cloned pixel now comes from the intended source",
    carriesSource(rightClone), `${wrongClone} → ${rightClone}`);

  // ---- without Alt, a press near the source still paints -------------------
  const modeBefore = await altChip.getAttribute("data-mode");
  check("Alt is spent, so the next press is an ordinary one", modeBefore === "off",
    `data-mode="${modeBefore}"`);
  const near = { dx: geom.fx + 3, dy: geom.fy + 3 };
  await touch("touchStart", [{ x: target.x + 3, y: target.y + 3 }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(900);
  const paintedNear = await docPixel(page, near.dx, near.dy);
  check("a press NEAR the source without Alt paints instead of moving it",
    carriesSource(paintedNear),
    `the pixel 3px from the source came out ${paintedNear} — it took the source's ` +
      `colour, which only happens if the press painted rather than picked the source up`);
  await context.close();

  // =============================================================== desktop ==
  /* The same oracle from the other direction: a mouse Alt-drag must leave the
     source where it was PRESSED. Pressed on the feature and dragged 30px into
     the black, a clone that comes out white proves the source did not travel. */
  const deskContext = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const desk = await deskContext.newPage();
  desk.on("pageerror", (e) => errors.push("pageerror(desktop): " + String(e)));
  await desk.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await desk.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const deskTour = await desk
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
    .catch(() => null);
  if (deskTour) {
    await desk.keyboard.press("Escape");
    await desk.waitForTimeout(700);
  }
  await desk.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await desk.waitForTimeout(800);
  const dgeom = await build(desk);
  check("the same picture on desktop", dgeom && dgeom.n === 1,
    dgeom ? `${dgeom.n}px at ${dgeom.fx},${dgeom.fy}` : "none");
  const dtarget = {
    x: Math.ceil(dgeom.left + dgeom.fx * dgeom.sx),
    y: Math.ceil(dgeom.top + dgeom.fy * dgeom.sx),
  };
  await desk.keyboard.down("Alt");
  await desk.mouse.move(dtarget.x, dtarget.y);
  await desk.mouse.down();
  for (let i = 1; i <= 6; i++) await desk.mouse.move(dtarget.x + i * 5, dtarget.y + i * 5);
  await desk.mouse.up();
  await desk.keyboard.up("Alt");
  await desk.waitForTimeout(600);
  await desk.mouse.click(dtarget.x + 60, dtarget.y + 40);
  await desk.waitForTimeout(1000);
  const deskClone = await docPixel(desk, dgeom.fx + 60, dgeom.fy + 40);
  check("a mouse Alt-drag still leaves the source where it was pressed",
    carriesSource(deskClone),
    `cloned ${deskClone} — white means the source stayed on the feature, as it always has`);
  await deskContext.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
