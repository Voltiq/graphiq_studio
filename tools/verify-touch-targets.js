/* Sliders and colour strips a finger can actually hit.
 *
 * A range input IS the hit target — not its thumb — and it is 4px tall, which
 * is about a tenth of what a fingertip can reliably land on. The hue and alpha
 * strips are 10px. Both are used everywhere (the slider alone has around 220
 * call sites), so the fix is one rule each rather than 220 edits: padding grows
 * the reachable box while the background, clipped to the content box, keeps the
 * visible track exactly where it was.
 *
 * The check that matters is not the height but whether a touch LANDS: a box
 * that measures 24px while something else sits on top of it is no use, so the
 * hit test is done with elementFromPoint at the extremes of the new box, and
 * then by actually dragging and reading the value back.
 *
 * Desktop is asserted unchanged, because the padding is deliberately touch-only
 * — the same rule there would make every row holding a slider 20px taller.
 *
 * Run: node tools/verify-touch-targets.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const open = async (viewport, touch) => {
    const context = await browser.newContext({ viewport, hasTouch: touch });
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
    return { context, page };
  };

  /** The first range input that is actually on screen. */
  const visibleSlider = (page) =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('input[type="range"]')].find((i) => {
        const r = i.getBoundingClientRect();
        /* Fully on screen HORIZONTALLY too: the options bar scrolls sideways,
           and the first range input in the DOM sat at x=613 on a 390px phone —
           every hit test against it missed, which reads as "the target is
           covered" when it is simply off the side of the screen. */
        return (
          r.width > 20 && r.height > 0 &&
          r.top >= 0 && r.bottom <= window.innerHeight &&
          r.left >= 0 && r.right <= window.innerWidth
        );
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      el.setAttribute("data-probe", "1");
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2),
               w: Math.round(r.width), h: Math.round(r.height) };
    });

  // ---------- touch ----------
  const { context, page } = await open({ width: 390, height: 844 }, true);
  await page.keyboard.press("Control+Shift+N"); // a layer, so the panels have something to show
  await page.waitForTimeout(1100);
  /* Measured in the PANELS, not the options bar: on a 390px phone the brush's
     option sliders sit past the right edge of a bar that does not scroll, so
     none of them is reachable to begin with — which is the subject of its own
     item (the per-tool sheet), not this one. */
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
  await page.waitForTimeout(900);

  const slider = await visibleSlider(page);
  check("a slider is on screen to measure", !!slider,
    slider ? `${slider.w}×${slider.h} at ${slider.x},${slider.y}` : "none found");
  check("the slider's box is at least 24px tall", !!slider && slider.h >= 24,
    `${slider?.h}px tall`);

  /* The item's own test: the point at the centre and 10px either side must all
     reach the input itself. */
  const hits = await page.evaluate(({ x, y }) => {
    const probe = document.querySelector('input[data-probe="1"]');
    return [-10, 0, 10].map((dy) => {
      const el = document.elementFromPoint(x, y + dy);
      return el === probe;
    });
  }, slider ?? { x: 0, y: 0 });
  check("a touch 10px above, on, and below the centre all reach it",
    hits.every(Boolean), `hits: ${hits.map((h) => (h ? "yes" : "no")).join(" / ")}`);

  const valueBefore = await page.evaluate(
    () => document.querySelector('input[data-probe="1"]')?.value ?? "",
  );
  await page.mouse.move(slider.x, slider.y);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++) await page.mouse.move(slider.x - 40 + i * 10, slider.y);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const valueAfter = await page.evaluate(
    () => document.querySelector('input[data-probe="1"]')?.value ?? "",
  );
  check("dragging it 40px changes the value", valueBefore !== valueAfter,
    `${valueBefore} → ${valueAfter}`);

  /* The colour strips, in the same drawer. */
  const strips = await page.evaluate(() => {
    /* The strips themselves, not what is painted inside them: `.alphaTrack` and
       the handles also match a loose "hue|alpha" search and are not hit
       targets, so measuring those reported a 10px strip that does not exist. */
    return [...document.querySelectorAll('[class*="hue"], [class*="alpha"]')]
      .filter((el) => !/track|handle|checker/i.test(el.className.toString()))
      .map((el) => ({ h: Math.round(el.getBoundingClientRect().height) }))
      .filter((s) => s.h > 0);
  });
  check("the picker's strips are on screen", strips.length > 0, `${strips.length} strip(s)`);
  check("every strip is at least 24px tall",
    strips.length > 0 && strips.every((s) => s.h >= 24),
    strips.map((s) => `${s.h}px`).join(", ") || "none");
  await context.close();

  // ---------- desktop is deliberately untouched ----------
  const desk = await open({ width: 1400, height: 900 }, false);
  await desk.page.keyboard.press("Control+Shift+N");
  await desk.page.waitForTimeout(1100);
  const deskSlider = await visibleSlider(desk.page);
  check("on desktop the slider keeps its original 4px box",
    !!deskSlider && deskSlider.h < 24, `${deskSlider?.h}px tall`);
  await desk.context.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
