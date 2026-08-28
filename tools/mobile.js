/* A device-emulation harness: what a phone IS, in one place, plus what only a
 * real device profile can measure.
 *
 * THE ITEM'S PREMISE HAS EXPIRED, and saying so is part of the job. It reads
 * "every driver in tools/ launches a fixed 1500×950 desktop viewport, so nothing
 * in the repo has ever exercised the mobile shell". Measured today: **21 of 54
 * rails** already drive a 390×844 phone context, and CPU throttling already
 * exists in `bench-slider.js`. The 1500×950 desktop survives only in the bench
 * and A/B tools, where it belongs.
 *
 * WHAT IS ACTUALLY MISSING is narrower and worse:
 *
 *   1. `page.mouse` IN A TOUCH CONTEXT IS STILL A MOUSE. Measured: a context
 *      with `hasTouch: true` driven by `page.mouse` delivers
 *      `pointerType: "mouse"`; only `page.touchscreen` delivers `"touch"`.
 *      Three of 54 rails use the touchscreen. NINE of the 21 touch rails drive
 *      entirely with the mouse — including `verify-edge-swipe`,
 *      `verify-pinch-abort`, `verify-pan-mode`, `verify-two-stage`,
 *      `verify-loupe` and `verify-grab-radius`, whose whole subject is touch.
 *      The app branches on `pointerType === "touch"` in several places, and
 *      those branches were not being taken.
 *
 *   2. `isMobile` IS SET IN 6 OF 21. Without it the context is a desktop
 *      browser that happens to accept touch: desktop UA, and the mobile
 *      viewport meta handled differently.
 *
 *   3. `deviceScaleFactor` IS SET IN 1 OF 54. Twenty mobile rails measure at
 *      dpr 1 — a ratio no phone has — so anything resolution-dependent has been
 *      measured on a device that does not exist.
 *
 *   4. NO RAIL THROTTLES THE CPU. Every "mobile" measurement so far was taken
 *      on a 32-core desktop at full speed, which is the definition of guessing.
 *
 * So this file is one description of a phone, real touch input, a CPU throttle,
 * and a set of checks that only a true device profile can make. It is a library
 * (`require` it) and a harness (`node tools/mobile.js`).
 *
 * NON-VACUITY: `node tools/mobile.js --self-test` runs the checks twice, the
 * second time with the mobile shell deliberately broken, and fails unless the
 * broken run reports failures. A harness that cannot fail is decoration.
 *
 * Run: node tools/mobile.js [--url ...] [--channel ...] [--throttle N] [--self-test]
 */
const { launchBrowser, urlArg, dismissStartCard } = require("./lib/launch");

/* ---------------------------------------------------------------- devices --
   One description of each device, so two rails measuring "a phone" are
   measuring the same phone. The user agents matter: `isMobile` alone does not
   change them, and the app's iOS branches read the UA. */
const DEVICES = {
  phone: {
    name: "phone",
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 3,
    isMobile: true,
    hasTouch: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
      "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  },
  /* The narrowest screen worth supporting — an iPhone SE. */
  phoneSmall: {
    name: "phoneSmall",
    viewport: { width: 320, height: 568 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  tablet: {
    name: "tablet",
    viewport: { width: 820, height: 1180 },
    deviceScaleFactor: 2,
    isMobile: true,
    hasTouch: true,
  },
  /* Kept here so an A/B against a desktop uses the same helpers. */
  desktop: {
    name: "desktop",
    viewport: { width: 1400, height: 900 },
    deviceScaleFactor: 1,
    isMobile: false,
    hasTouch: false,
  },
};

/** A context for one of the devices above. */
async function deviceContext(browser, device = DEVICES.phone, extra = {}) {
  const { name, ...opts } = device;
  void name;
  return browser.newContext({ ...opts, ...extra });
}

/**
 * Slow the renderer down by `rate`×.
 *
 * A desktop with 32 cores is not a phone, and a budget measured on one is a
 * guess wearing a number. Chromium's throttle is the only lever available here
 * — it does not model a slower GPU or slower memory, so it understates the gap
 * rather than overstating it, which is the safe direction.
 */
async function throttleCPU(page, rate) {
  if (!rate || rate <= 1) return null;
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate });
  return {
    async release() {
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 }).catch(() => {});
    },
  };
}

/** A real touch tap — `pointerType: "touch"`, unlike `page.mouse`. */
async function tap(page, x, y) {
  await page.touchscreen.tap(x, y);
}

/**
 * A real touch drag, in steps, so the app sees moves and not a teleport.
 *
 * Playwright's `touchscreen` has a tap and nothing else, so the drag goes
 * through CDP. The touch points carry `id`, `force` and a radius: a bare
 * `{x, y}` is accepted, but a real finger has all four, and code that reads
 * `touch.force` should see a plausible one.
 */
async function swipe(page, from, to, steps = 12) {
  const cdp = await page.context().newCDPSession(page);
  const at = (x, y) => [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
  const send = (type, x, y) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: type === "touchEnd" ? [] : at(x, y),
    });
  await send("touchStart", from.x, from.y);
  for (let i = 1; i <= steps; i++) {
    await send(
      "touchMove",
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
  await send("touchEnd", to.x, to.y);
  await cdp.detach().catch(() => {});
}

/**
 * Where the DOCUMENT is on screen, which is not where the viewport is.
 *
 * This cost a wrong answer to find. `[data-tour="canvas"]` is the viewport —
 * on a phone, 390×748 starting at y:96 — while a 1920×1080 document fitted
 * inside it occupies 326×184 at y:378. A drag aimed at the middle of the
 * viewport plus an offset lands on empty grey, paints nothing, and looks
 * exactly like a broken touch pipeline. Aim here instead.
 */
async function docRect(page) {
  return page.evaluate(() => {
    const vp = document.querySelector('[data-tour="canvas"]');
    if (!vp) return null;
    const doc = window.__gqMemory ? window.__gqMemory() : null;
    const canvases = [...vp.querySelectorAll("canvas")].filter(
      (c) => c.getBoundingClientRect().width > 0,
    );
    /* The document's backing store is the document's size; the overlays match
       the viewport. When the hook is unavailable, the smallest painted canvas
       is the document, because the overlays fill the viewport by definition. */
    const hit =
      (doc && canvases.find((c) => c.width === doc.w && c.height === doc.h)) ||
      canvases.sort(
        (a, b) =>
          a.getBoundingClientRect().width * a.getBoundingClientRect().height -
          b.getBoundingClientRect().width * b.getBoundingClientRect().height,
      )[0];
    if (!hit) return null;
    const r = hit.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
}

/**
 * Time a cold boot to an interactive canvas, at `rate`× CPU.
 *
 * Throttling has to be in place BEFORE the navigation or it measures nothing:
 * the expensive part of this app's boot is the first render, and it is over
 * before a post-goto throttle takes effect.
 */
async function bootCost(context, rate) {
  const page = await context.newPage();
  const t = await throttleCPU(page, rate);
  const started = Date.now();
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 180000 });
  const ms = Date.now() - started;
  if (t) await t.release();
  await page.close();
  return ms;
}

/**
 * A checksum of the DOCUMENT's own pixels.
 *
 * A screenshot of `[data-tour="canvas"]` was the obvious instrument and the
 * wrong one: it takes in the rulers, the overlays and whatever the drawer was
 * doing on its way closed, so it reports "changed" for reasons that have
 * nothing to do with the stroke. Mutation-tested — with the canvas made to drop
 * every touch pointer, so that painting genuinely stopped, the screenshot
 * comparison still passed. This reads the layer the brush writes to and nothing
 * else, and the same mutation fails it.
 *
 * Position-weighted, so a stroke that moves rather than grows cannot collide
 * with its own previous state.
 */
async function docPixels(page) {
  return page.evaluate(() => {
    const vp = document.querySelector('[data-tour="canvas"]');
    if (!vp) return null;
    const doc = window.__gqMemory ? window.__gqMemory() : null;
    const hit = [...vp.querySelectorAll("canvas")].find(
      (c) => doc && c.width === doc.w && c.height === doc.h,
    );
    if (!hit) return null;
    try {
      const d = hit.getContext("2d").getImageData(0, 0, hit.width, hit.height).data;
      let sum = 0;
      let painted = 0;
      /* Every 17th pixel: enough to catch a brush stroke, cheap enough not to
         stall the page for a second on a 1920×1080 document. */
      for (let px = 0; px * 4 < d.length; px += 17) {
        const i = px * 4;
        const v = d[i] + d[i + 1] + d[i + 2] + d[i + 3];
        if (v) {
          painted++;
          sum = (sum + px * 31 + v) % 2147483647;
        }
      }
      return { sum, painted };
    } catch {
      return null;
    }
  });
}

/** Boot the app and get past the tour and the start card. */
async function openApp(context, { url = urlArg(), breakLayout = false } = {}) {
  const page = await context.newPage();
  if (breakLayout) {
    /* The deliberate break for `--self-test`: the mobile bar is the shell's
       only route to the tools and the panels, and hiding it is a failure any
       honest mobile harness must notice. */
    await page.addInitScript(() => {
      const css = document.createElement("style");
      css.textContent =
        '[data-tour="mobilebar"]{display:none!important}' +
        "html{--gq-broken:1}";
      const put = () => document.head && document.head.appendChild(css);
      if (document.head) put();
      else document.addEventListener("DOMContentLoaded", put);
    });
  }
  await page.goto(url, { waitUntil: "domcontentloaded" });
  /* Generous: under a 4× throttle the first paint takes noticeably longer, and
     a timeout here would read as a layout failure rather than a slow boot. */
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 120000 });
  const tour = await page
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(800);
  }
  await dismissStartCard(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(700);
  return page;
}

module.exports = {
  DEVICES,
  deviceContext,
  throttleCPU,
  tap,
  swipe,
  docRect,
  docPixels,
  openApp,
  bootCost,
};

/* ------------------------------------------------------------- the harness --
   Only runs when invoked directly, so requiring this file costs nothing. */
if (require.main === module) {
  const argv = process.argv.slice(2);
  const flag = (n, d) => {
    const i = argv.indexOf(n);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
  };
  const THROTTLE = Number(flag("--throttle", "4"));
  const SELF_TEST = argv.includes("--self-test");

  /** One run of the checks. Returns what passed, so the self-test can compare. */
  const run = async (browser, { breakLayout }) => {
    const results = [];
    const check = (name, ok, detail = "") => {
      results.push({ name, ok: !!ok });
      console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
    };

    const context = await deviceContext(browser, DEVICES.phone);
    const page = await openApp(context, { breakLayout });

    // ===================== the profile is real, not half-applied =============
    const profile = await page.evaluate(() => ({
      dpr: window.devicePixelRatio,
      coarse: matchMedia("(pointer: coarse) and (hover: none)").matches,
      mobileUA: /iPhone|Android/i.test(navigator.userAgent),
      dataMobile: document.documentElement.dataset.mobile === "true",
      width: window.innerWidth,
    }));
    check("the device profile is fully applied, not half of one",
      profile.dpr === 3 && profile.coarse && profile.mobileUA && profile.dataMobile,
      `dpr ${profile.dpr}, coarse ${profile.coarse}, mobile UA ${profile.mobileUA}, ` +
        `data-mobile ${profile.dataMobile} — 20 of 54 rails run at dpr 1, and 15 of 21 without isMobile`);

    // ============ the finding: a mouse in a touch context is still a mouse ===
    await page.evaluate(() => {
      window.__ptr = [];
      addEventListener("pointerdown", (e) => window.__ptr.push(e.pointerType), true);
    });
    const canvas = await page.locator('[data-tour="canvas"]').boundingBox();
    await page.mouse.move(canvas.x + 60, canvas.y + 60);
    await page.mouse.down();
    await page.mouse.up();
    await tap(page, canvas.x + 120, canvas.y + 120);
    await page.waitForTimeout(500);
    const seen = await page.evaluate(() => window.__ptr);
    check("page.touchscreen delivers a real touch",
      seen.includes("touch"), `pointer types seen: ${JSON.stringify(seen)}`);
    check("…and page.mouse does not, even here",
      seen.includes("mouse"),
      "which is why nine touch rails driving with the mouse never took the app's touch branches");

    // ======================= real touch drives the shell =====================
    /* Assert the TRANSITION, not the presence. The first version of this check
       asked whether `[data-tour="toolbar"][data-mobile-rail]` existed, and the
       self-test caught it out: the rail is in the DOM at all times, parked at
       x:-320 when closed, so the check passed in a run where there was no bar
       left to tap. Off-screen IS the closed state, and only the position tells
       the two apart. */
    const railX = () =>
      page.evaluate(() => {
        const r = document.querySelector('[data-tour="toolbar"][data-mobile-rail]');
        return r ? Math.round(r.getBoundingClientRect().x) : null;
      });
    const closedX = await railX();

    const toolsBtn = await page
      .locator('[data-tour="mobilebar"] button', { hasText: "Tools" })
      .first()
      .boundingBox()
      .catch(() => null);
    check("the mobile bar is there to be tapped",
      !!toolsBtn, toolsBtn ? `Tools at ${Math.round(toolsBtn.x)},${Math.round(toolsBtn.y)}` : "no mobile bar");
    if (toolsBtn) {
      await tap(page, toolsBtn.x + toolsBtn.width / 2, toolsBtn.y + toolsBtn.height / 2);
      await page.waitForTimeout(900);
    }
    const openX = await railX();
    const drawerOpen = closedX !== null && closedX < 0 && openX === 0;
    check("…and a real touch opens the tools drawer",
      drawerOpen, `the rail moved from x:${closedX} to x:${openX}`);
    if (drawerOpen) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(500);
    }

    // ============== a real touch actually paints, not just lands ============
    /* The end of the chain the mouse never reaches: pointerdown → the app's
       touch branch → a committed stroke. A tap that merely registers proves the
       event arrived; only pixels prove it was understood.

       Aimed with `docRect`, and the first version of this check is the reason
       that helper exists: aimed at the viewport it drew on empty grey outside
       the document, changed nothing, and PASSED anyway, because the screenshot
       it compared was taken while the new document was still settling. The
       comparison now brackets the drag and nothing else. */
    await page.keyboard.press("Control+Shift+N").catch(() => {});
    await page.waitForTimeout(1800);
    await page.keyboard.press("b").catch(() => {});
    await page.waitForTimeout(600);
    const doc = await docRect(page);
    const beforePaint = await docPixels(page);
    if (doc) {
      await swipe(
        page,
        { x: doc.x + doc.width * 0.25, y: doc.y + doc.height * 0.3 },
        { x: doc.x + doc.width * 0.75, y: doc.y + doc.height * 0.7 },
        16,
      );
      await page.waitForTimeout(900);
    }
    const afterPaint = await docPixels(page);
    check("a touch drag paints a stroke",
      !!(beforePaint && afterPaint && afterPaint.sum !== beforePaint.sum),
      doc && beforePaint && afterPaint
        ? `a 16-step touch drag across the document at ${Math.round(doc.x)},${Math.round(doc.y)} ` +
          `${Math.round(doc.width)}×${Math.round(doc.height)} took its painted pixels from ` +
          `${beforePaint.painted} to ${afterPaint.painted}`
        : "no document pixels to read");

    // ================= what it costs on a throttled processor ================
    /* MEASURED, not guessed — the item's actual complaint. These are reported
       and only loosely asserted: the numbers are the deliverable, but a hard
       threshold on a shared CI machine is a flake generator, and a rail that
       fails on a busy afternoon teaches people to ignore it. */
    const t = await throttleCPU(page, THROTTLE);
    const started = Date.now();
    await tap(page, canvas.x + 200, canvas.y + 200);
    await page.waitForTimeout(400);
    const tapCost = Date.now() - started - 400;
    if (t) await t.release();

    const fast = await bootCost(context, 1);
    const slow = await bootCost(context, THROTTLE);
    check(`a cold boot survives ${THROTTLE}× CPU throttling`,
      slow < 60000,
      `${fast}ms unthrottled → ${slow}ms at ${THROTTLE}× (${(slow / fast).toFixed(1)}× slower); ` +
        `tap round trip ${tapCost}ms. No verify rail throttles at all, so every ` +
        `"mobile" number in this repo is the unthrottled one`);

    const budget = await page.evaluate(() =>
      window.__gqBudgets ? window.__gqBudgets() : null,
    );
    check("the phone profile really gets the phone budgets",
      budget && budget.cacheMB <= 64 && budget.overlayDpr <= 2,
      budget
        ? `${budget.cacheMB} MB cache, ${budget.historyMB} MB history, ` +
          `${budget.draftPixels} px draft, overlays at ${budget.overlayDpr}× of a dpr-3 screen`
        : "no __gqBudgets hook");

    await context.close();

    // ================== the narrowest screen worth supporting ================
    /* A 320×568 iPhone SE, which no driver in tools/ had ever launched. The
       FIRST RUN OF THIS CHECK FOUND A REAL BUG: the top bar's actions row ran
       98..335 inside a 320px viewport with `overflow-x: visible` and no wrap,
       so "Switch to light mode" was clipped off the screen entirely, with no
       scroll to reach it. Fixed by collapsing the palette button's word label
       under 360px; this is the check that keeps it fixed.

       Only rows that must FIT are examined. The tools rail sits at x:-320 when
       closed — off-screen on purpose — and a check that flagged every negative
       coordinate would call that a bug and be ignored for it. */
    const small = await deviceContext(browser, DEVICES.phoneSmall);
    const sp = await openApp(small, { breakLayout });
    const clipped = await sp.evaluate(() => {
      const rows = [
        ...document.querySelectorAll('[class*="TopBar"][class*="actions"]'),
        ...document.querySelectorAll('[data-tour="mobilebar"]'),
      ];
      const out = [];
      for (const row of rows)
        for (const el of row.querySelectorAll("button")) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && (r.right > window.innerWidth + 1 || r.left < -1))
            out.push(
              (el.getAttribute("aria-label") || el.textContent.trim() || "?").slice(0, 30) +
                ` @${Math.round(r.left)}..${Math.round(r.right)}`,
            );
        }
      return { out, w: window.innerWidth };
    });
    check("on a 320px phone nothing in the bars is clipped off the screen",
      clipped.out.length === 0,
      clipped.out.length
        ? `unreachable in ${clipped.w}px: ${clipped.out.join(", ")}`
        : `every control in the top bar and the mobile bar fits inside ${clipped.w}px`);
    await small.close();

    const passed = results.filter((r) => r.ok).length;
    return { passed, total: results.length, failed: results.filter((r) => !r.ok).map((r) => r.name) };
  };

  (async () => {
    const browser = await launchBrowser();
    try {
      console.log(`— mobile harness on ${DEVICES.phone.viewport.width}×${DEVICES.phone.viewport.height} ` +
        `@${DEVICES.phone.deviceScaleFactor}x, ${THROTTLE}× CPU throttle —\n`);
      const healthy = await run(browser, { breakLayout: false });
      console.log(`\n${healthy.passed}/${healthy.total} checks passed`);

      if (!SELF_TEST) {
        process.exit(healthy.passed === healthy.total ? 0 : 1);
      }

      /* Non-vacuity, the way the item asks for it: break the mobile layout on
         purpose and require the harness to notice. */
      console.log("\n— self-test: the same checks with the mobile bar removed —\n");
      const broken = await run(browser, { breakLayout: true });
      console.log(`\n${broken.passed}/${broken.total} checks passed with the shell broken`);
      const noticed = broken.failed.length > 0;
      console.log(
        noticed
          ? `\nPASS  the harness fails when the mobile shell is broken — ${broken.failed.join(", ")}`
          : "\nFAIL  the harness passed a broken mobile shell, so it proves nothing",
      );
      process.exit(healthy.passed === healthy.total && noticed ? 0 : 1);
    } finally {
      await browser.close();
    }
  })().catch((e) => {
    console.error("FAIL", e.stack || e.message);
    process.exit(1);
  });
}
