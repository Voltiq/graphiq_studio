/* A tap you can take back.
 *
 * The loupe lets you see where you are; this is what lets you be wrong about
 * it. A tap with the Eyedropper commits a sample at whatever pixel the
 * fingertip happened to cover, and the only recourse was to tap again and hope
 * — measured at 0/10 against a 1px feature with a 6px aiming error.
 *
 * The sampled point now stays on screen as a marker, and a press NEAR it picks
 * it up instead of sampling afresh. Two properties make that useful rather than
 * merely present, and both are asserted here:
 *
 *   - the marker is held by the offset the grab started with, not snapped to
 *     the finger. Dragging it from 18px away has to move it by 18px-worth of
 *     travel, not teleport it under the hand — otherwise the finger covers the
 *     thing being aimed, which is the problem this exists to solve.
 *   - the Info panel follows the MARKER, not the pointer. The item's flow is
 *     "drag the marker while watching the Info readout", and a readout
 *     describing the finger instead would be telling you about the wrong pixel
 *     at precisely the moment it matters.
 *
 * The negative cases matter as much: a press well away from the marker must
 * still take a fresh sample, or the marker would hijack the whole canvas; and a
 * mouse must get no marker at all, since it can hit a pixel first time and
 * would only find one in the way of its next click.
 *
 * Run: node tools/verify-two-stage.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg, withOptionsSheet } = require("./lib/launch");

const AIM_ERROR = 5; // the item's own number
const GRAB_FROM = 18; // how far from the marker the grabbing finger lands

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

  /* React listens to the native input event; assigning `.value` is invisible to
     it, so the prototype's setter is the way in. Same reasoning as the loupe
     harness — and the paint bucket is avoided here for the same reason: a
     committed fill keeps tracking the foreground colour while the bucket is
     still selected, which has its own item. */
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
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set.call(el, v);
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      [selector, value],
    );

  // ---------------------------------------------------------------- setup --
  await page.keyboard.press("Control+Shift+N");
  await page.waitForTimeout(1200);
  await setValue("hex", "000000");
  await page.waitForTimeout(400);
  await page.keyboard.press("n"); // pencil
  await page.waitForTimeout(400);
  await withOptionsSheet(page, () => setValue("Size", "400"));
  await page.waitForTimeout(400);
  const cv = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  await page.mouse.click(Math.round(cv.x + cv.width / 2), Math.round(cv.y + cv.height / 2));
  await page.waitForTimeout(1100);
  await setValue("hex", "FFFFFF");
  await page.waitForTimeout(400);
  await withOptionsSheet(page, () => setValue("Size", "1"));
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+1"); // 100%: one document pixel, one screen pixel
  await page.waitForTimeout(900);
  const vpBox = await page.locator('[data-tour="canvas"] [class*="viewport"]').first().boundingBox();
  await page.mouse.click(
    Math.round(vpBox.x + vpBox.width / 2),
    Math.round(vpBox.y + vpBox.height / 2),
  );
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
  check("a 1px white feature on a black patch, at 100%",
    geom && geom.n === 1 && Math.abs(geom.sx - 1) < 0.01,
    geom ? `${geom.n}px at ${geom.fx},${geom.fy}, scale ${geom.sx.toFixed(3)}` : "none");

  /* The app floors the document coordinate and the dispatcher rounds the client
     one, so aim at the smallest whole client coordinate inside the pixel. */
  const target = {
    x: Math.ceil(geom.left + geom.fx * geom.sx),
    y: Math.ceil(geom.top + geom.fy * geom.sx),
  };

  /* The Info panel renders nothing while collapsed, so its readout has to be
     opened before it can be watched. The drawer is then closed again — the dock
     stays mounted off-screen, so the rows keep updating while the canvas is
     reachable. */
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
  await page.waitForTimeout(1000);
  const expandInfo = page.locator('[data-tour="dock"] button[aria-label="Expand Info"]');
  const opened = await expandInfo.count();
  if (opened) {
    await expandInfo.first().click();
    await page.waitForTimeout(800);
  }
  await page.evaluate(() => window.history.back());
  await page.waitForTimeout(900);
  check("the Info panel is open, so its readout can be watched",
    (await page.evaluate(() => document.querySelectorAll('[class*="infoRow"]').length)) >= 4,
    `${await page.evaluate(() => document.querySelectorAll('[class*="infoRow"]').length)} rows rendered`);

  await page.keyboard.press("i"); // eyedropper
  await page.waitForTimeout(500);

  const sampled = () =>
    page.evaluate(() => {
      const el = document.querySelector('[data-tour="toolbar"] [class*="swatchWrapFg"] [class*="swatch"]');
      if (!el) return "none";
      const m = getComputedStyle(el).backgroundImage.match(/linear-gradient\((rgba?\([^)]*\))/);
      return m ? m[1] : "none";
    });
  const isWhite = (c) => /^rgba?\(\s*2[45]\d,\s*2[45]\d,\s*2[45]\d/.test(c);
  const isBlack = (c) => /^rgba?\(\s*[0-9],\s*[0-9],\s*[0-9][,)]/.test(c);
  /** What the Info panel is reporting right now. */
  const info = () =>
    page.evaluate(() => {
      const rows = [...document.querySelectorAll('[class*="infoRow"]')];
      const read = (label) => {
        const row = rows.find((r) => r.querySelector('[class*="infoLabel"]')?.textContent === label);
        return row?.querySelector('[class*="infoValue"]')?.textContent?.trim() ?? null;
      };
      return { x: read("X"), y: read("Y"), rgb: read("RGB") };
    });
  /** Ink the overlay is drawing within `r` px of a client point. */
  const overlayInkNear = (cx, cy, r) =>
    page.evaluate(
      ([x, y, rad]) => {
        const ov = [...document.querySelectorAll('[data-tour="canvas"] canvas')]
          .filter((c) => !c.hasAttribute("data-loupe"))
          .pop();
        const b = ov.getBoundingClientRect();
        const g = ov.getContext("2d", { willReadFrequently: true });
        const px = Math.round(x - b.left), py = Math.round(y - b.top);
        const x0 = Math.max(0, px - rad), y0 = Math.max(0, py - rad);
        const w = Math.min(ov.width - x0, rad * 2), h = Math.min(ov.height - y0, rad * 2);
        if (w <= 0 || h <= 0) return 0;
        const d = g.getImageData(x0, y0, w, h).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
        return n;
      },
      [cx, cy, r],
    );

  const reset = async () => {
    await setValue("hex", "FF0000");
    await page.waitForTimeout(280);
  };

  // ------------------------------------------- the miss, and what it leaves --
  await reset();
  const inkBefore = await overlayInkNear(target.x, target.y, 30);
  await touch("touchStart", [{ x: target.x + AIM_ERROR, y: target.y - AIM_ERROR }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(700);
  const afterTap = await sampled();
  check(`a tap ${AIM_ERROR}px off the target samples the wrong pixel`,
    isBlack(afterTap), `sampled ${afterTap}, the black around the feature`);

  const inkAfter = await overlayInkNear(target.x, target.y, 30);
  check("…and leaves a marker on the canvas where it landed",
    inkAfter > inkBefore + 100, `overlay ink near the tap: ${inkBefore} → ${inkAfter}`);

  // ------------------------------------------------ the item's own sequence --
  /* Grabbed from GRAB_FROM px away — a finger parked clear of the marker — and
     walked back onto the target one pixel at a time, with the readout checked
     mid-drag, before anything is committed. */
  const gx = target.x + AIM_ERROR + GRAB_FROM;
  const gy = target.y - AIM_ERROR + GRAB_FROM;
  await touch("touchStart", [{ x: gx, y: gy }]);
  await page.waitForTimeout(350);
  const grabbedInfo = await info();
  check("pressing near the marker grabs it rather than sampling under the finger",
    grabbedInfo.x === String(geom.fx + AIM_ERROR) && grabbedInfo.y === String(geom.fy - AIM_ERROR),
    `Info reads ${grabbedInfo.x},${grabbedInfo.y}; the marker is at ` +
      `${geom.fx + AIM_ERROR},${geom.fy - AIM_ERROR} and the finger at ` +
      `${geom.fx + AIM_ERROR + GRAB_FROM},${geom.fy - AIM_ERROR + GRAB_FROM}`);

  for (let i = 1; i <= AIM_ERROR; i++)
    await touch("touchMove", [{ x: gx - i, y: gy + i }]);
  await page.waitForTimeout(450);
  const midInfo = await info();
  check("the Info readout follows the marker onto the target, before release",
    midInfo.x === String(geom.fx) && midInfo.y === String(geom.fy),
    `Info reads ${midInfo.x},${midInfo.y}; the feature is at ${geom.fx},${geom.fy}`);
  check("…and reports the colour the marker is over",
    /^255,\s*255,\s*255$/.test(midInfo.rgb ?? ""), `RGB ${midInfo.rgb}`);

  await touch("touchEnd", []);
  await page.waitForTimeout(600);
  const committed = await sampled();
  check("the committed sample is the pixel the marker was dragged onto",
    isWhite(committed), `${afterTap} → ${committed}`);

  // ------------------------------------------------------ the negative cases --
  await reset();
  const far = { x: target.x + 90, y: target.y + 60 };
  await touch("touchStart", [{ x: far.x, y: far.y }]);
  await touch("touchEnd", []);
  await page.waitForTimeout(600);
  const farSample = await sampled();
  check("a press well away from the marker still takes a fresh sample there",
    isBlack(farSample), `sampled ${farSample} at +90,+60 — black, not the marker's white`);
  const inkFar = await overlayInkNear(far.x, far.y, 30);
  check("…and the marker moves to the new sample", inkFar > 100, `overlay ink there: ${inkFar}`);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(600);
  const inkAfterEsc = await overlayInkNear(far.x, far.y, 30);
  const keptColour = await sampled();
  check("Escape drops the marker", inkAfterEsc < 100, `overlay ink there: ${inkFar} → ${inkAfterEsc}`);
  check("…and keeps the colour it sampled", isBlack(keptColour), `still ${keptColour}`);

  // ------------------------------------------------------ a mouse gets none --
  await reset();
  await page.mouse.click(target.x + AIM_ERROR, target.y - AIM_ERROR);
  await page.waitForTimeout(600);
  const mouseInk = await overlayInkNear(target.x, target.y, 30);
  check("a mouse click leaves no marker behind", mouseInk < 100, `overlay ink near it: ${mouseInk}`);

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
