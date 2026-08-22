/* Which shell does a given device get?
 *
 * The breakpoint used to be `(max-width: 767px)`, which is wrong in three
 * directions at once: a phone in landscape is 844px wide and got the DESKTOP
 * shell on a 390px-tall screen; an iPad mini in portrait is 744px wide and got
 * the PHONE shell; and a desktop window dragged narrow got touch sizing with a
 * mouse attached. It now asks about the device (`pointer: coarse` and
 * `hover: none`) as well as either dimension being small.
 *
 * Each profile below is asserted on `document.documentElement.dataset.mobile`,
 * which is what actually drives the layout — not on the media query in
 * isolation, which could agree while the attribute never got set.
 *
 * Run: node tools/verify-breakpoint.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

/* touch: a finger — `pointer: coarse` with no hover, which is what Playwright's
   hasTouch produces (verified: without it a 390px-wide context still reports
   `pointer: fine`, so width-only tests would have been testing nothing). */
const PROFILES = [
  ["a phone held upright", { width: 390, height: 844 }, true, "mobile"],
  ["…and the same phone turned sideways", { width: 844, height: 390 }, true, "mobile"],
  ["a small phone sideways", { width: 667, height: 375 }, true, "mobile"],
  ["a tablet held upright", { width: 744, height: 1133 }, true, "desktop"],
  ["…and the same tablet sideways", { width: 1133, height: 744 }, true, "desktop"],
  ["a desktop window dragged narrow", { width: 700, height: 950 }, false, "desktop"],
  ["an ordinary desktop window", { width: 1500, height: 950 }, false, "desktop"],
  ["a large screen that happens to have a touchscreen", { width: 1500, height: 950 }, true, "desktop"],
];

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const boot = async (page) => {
    await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
    const tour = await page
      .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
      .catch(() => null);
    if (tour) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(700);
    }
    await page.waitForTimeout(600);
  };

  /** The attribute the whole mobile layout hangs off, plus how it was decided. */
  const shellOf = (page) =>
    page.evaluate(() => ({
      shell: document.documentElement.dataset.mobile === "true" ? "mobile" : "desktop",
      coarse: matchMedia("(pointer: coarse)").matches,
      hoverNone: matchMedia("(hover: none)").matches,
      w: window.innerWidth,
      h: window.innerHeight,
      /* A malformed media query is not an error: matchMedia parses it to
         "not all" and then never matches, which would silently pin every
         device to the desktop shell. */
      parsed: matchMedia(
        "(pointer: coarse) and (hover: none) and ((max-width: 600px) or (max-height: 500px))",
      ).media,
    }));

  /* One context per pointer type — hasTouch cannot be changed on a live one —
     and the viewport resized within it, which also exercises the matchMedia
     listener rather than only the value read at first render. */
  const pages = {};
  for (const touch of [true, false]) {
    const context = await browser.newContext({
      viewport: { width: 1000, height: 800 },
      hasTouch: touch,
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
    await boot(page);
    pages[String(touch)] = { context, page };
  }

  const first = await shellOf(pages.true.page);
  check("the query is well-formed, not silently parsed away",
    first.parsed !== "not all", `matchMedia reports: ${first.parsed}`);

  for (const [name, viewport, touch, want] of PROFILES) {
    const { page } = pages[String(touch)];
    await page.setViewportSize(viewport);
    await page.waitForTimeout(500);
    const s = await shellOf(page);
    check(`${name} gets the ${want} shell`, s.shell === want,
      `${s.w}×${s.h}, pointer ${s.coarse ? "coarse" : "fine"}, hover ${s.hoverNone ? "none" : "yes"} ` +
        `→ ${s.shell}`);
  }

  /* Everything above changed viewport on a page that was already open. This one
     is decided at load, which is the other way it has to be right. */
  {
    const context = await browser.newContext({
      viewport: { width: 844, height: 390 },
      hasTouch: true,
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
    await boot(page);
    const s = await shellOf(page);
    check("a phone loading sideways from cold gets the mobile shell too",
      s.shell === "mobile", `${s.w}×${s.h} → ${s.shell}`);
    await context.close();
  }

  // ---------- decided BEFORE the first paint, not a frame later ----------
  /* The shell used to be chosen in an effect, so a phone painted the desktop
     layout first — toolbar and dock in flow, canvas measured against what was
     left — and then reflowed. An inline script in <head> settles it first.
     Watched from an init script, which runs before the page's own scripts, and
     under 6x CPU throttling so any gap between paint and effect is wide enough
     to catch rather than something that slipped between two frames. */
  {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      hasTouch: true,
    });
    await context.addInitScript(() => {
      window.__frames = [];
      const tick = () => {
        const toolbar = document.querySelector('[data-tour="toolbar"]');
        const canvas = document.querySelector('[data-tour="canvas"]');
        window.__frames.push({
          mobile: document.documentElement.dataset.mobile ?? "",
          /* "static" is the desktop flow; the mobile shell lifts it out to
             "fixed". This is the frame-by-frame record of which layout the
             browser was actually painting. */
          toolbar: toolbar ? getComputedStyle(toolbar).position : null,
          canvasW: canvas ? canvas.clientWidth : null,
        });
        if (window.__frames.length < 900) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
    await boot(page);
    await page.waitForTimeout(1500);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

    const seen = await page.evaluate(() => {
      const f = window.__frames ?? [];
      const withToolbar = f.filter((x) => x.toolbar);
      const widths = [...new Set(f.map((x) => x.canvasW).filter((w) => w))];
      return {
        frames: f.length,
        firstMobile: f.length ? f[0].mobile : "(no frames)",
        everDesktopFlow: withToolbar.filter((x) => x.toolbar !== "fixed").length,
        firstToolbar: withToolbar.length ? withToolbar[0].toolbar : "(never rendered)",
        toolbarFrames: withToolbar.length,
        widths,
        fits: window.__gqFits ?? null,
      };
    });

    check("the shell is settled before the first frame runs",
      seen.firstMobile === "true", `first recorded frame had data-mobile="${seen.firstMobile}"`);
    check("no frame ever paints the toolbar in the desktop flow",
      seen.toolbarFrames > 0 && seen.everDesktopFlow === 0,
      `${seen.toolbarFrames} frames with a toolbar, ${seen.everDesktopFlow} of them in flow ` +
        `(first was "${seen.firstToolbar}")`);
    check("…so the canvas is never measured against a layout that then reflows",
      seen.widths.length === 1, `canvas width took ${seen.widths.length} value(s): ${seen.widths.join(", ")}`);
    check("…and the view is fitted once, not fitted and then re-fitted",
      seen.fits === 1, `fit() ran ${seen.fits} time(s)`);

    /* Where all of that has to end up: the picture centred in the stage. The
       checks above are about WHEN the layout is decided; this is about the
       result, and it is the one that caught a real bug — the stage is
       momentarily 0px wide during the cold load, and a pan clamped against a
       viewport with no width came back as -80 instead of 11, parking the
       picture off to the left while every other reading looked correct. */
    const centred = await page.evaluate(() => {
      const stage = document.querySelector('[data-tour="canvas"] [class*="viewport"]');
      if (!stage) return null;
      const v = stage.getBoundingClientRect();
      /* The artwork is the transformed pan/zoom wrapper, not the overlay canvas
         (which is exactly the stage's size and would always look centred). */
      const art = [...stage.querySelectorAll("*")]
        .filter((e) => getComputedStyle(e).transform !== "none")
        .map((e) => e.getBoundingClientRect())
        .filter((b) => b.width > 20 && b.width < stage.clientWidth)[0];
      if (!art) return null;
      return {
        left: Math.round(art.left - v.left), right: Math.round(v.right - art.right),
        top: Math.round(art.top - v.top), bottom: Math.round(v.bottom - art.bottom),
      };
    });
    check("the picture lands centred in the stage",
      !!centred && Math.abs(centred.left - centred.right) <= 1 && Math.abs(centred.top - centred.bottom) <= 1,
      centred
        ? `gaps left ${centred.left} / right ${centred.right}, top ${centred.top} / bottom ${centred.bottom}`
        : "no artwork found");

    /* The other half of that change: the callback that no longer fires on the
       starting size must still fire on a real one, or rotating the phone would
       leave an untouched view off-centre. */
    await page.setViewportSize({ width: 844, height: 390 });
    await page.waitForTimeout(800);
    const afterRotate = await page.evaluate(() => window.__gqFits ?? null);
    check("…while actually rotating the phone does re-fit it",
      afterRotate === seen.fits + 1, `fit() ran ${afterRotate} time(s) after the rotation`);
    await context.close();
  }

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  for (const k of Object.keys(pages)) await pages[k].context.close();
  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
