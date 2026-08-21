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
