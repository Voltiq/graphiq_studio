/* The performance budgets follow the device instead of the machine they were tuned on.
 *
 * Four numbers were desktop constants: a 256 MB render cache, a 512 MB history,
 * a 0.5 MP live-filter frame, and overlays drawn at whatever `devicePixelRatio`
 * the screen reports.
 *
 * WHY THE DEVICE CLASS LEADS AND `deviceMemory` ONLY REFINES — measured, because
 * the obvious reading of the item cannot work:
 *
 *   An emulated phone profile (390×844, dpr 3, coarse pointer) reports
 *   `deviceMemory: 32` and `hardwareConcurrency: 32` — THIS MACHINE'S. Playwright
 *   does not emulate either. A budget derived only from those would be
 *   desktop-sized on every phone a harness can produce, and so could never be
 *   checked here at all. It would also be wrong in the world: `deviceMemory` is
 *   Chromium-only, so on an iPhone it is `undefined` — and iOS is the platform
 *   with the tightest budget of all.
 *
 *   A coarse pointer on a small screen, on the other hand, is emulated exactly,
 *   and is a true statement about the device. So that decides the class, and the
 *   hardware hints — where a browser supplies them — only ever shrink it
 *   further. `tests/budgets.test.ts` drives the hints, which no browser here can
 *   fake; this file drives the classes, which it can.
 *
 * Run: node tools/verify-budgets.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg, dismissStartCard } = require("./lib/launch");

const DESKTOP = { viewport: { width: 1400, height: 900 } };
const PHONE = {
  viewport: { width: 390, height: 844 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 3,
};
const TABLET = {
  viewport: { width: 820, height: 1180 },
  hasTouch: true,
  isMobile: true,
  deviceScaleFactor: 2,
};

/** The derived numbers, plus what the engine is actually enforcing. */
const READ = () => {
  const derived = window.__gqBudgets ? window.__gqBudgets() : null;
  const stats = window.__gqRenderCache ? window.__gqRenderCache.stats() : null;
  const vp = document.querySelector('[data-tour="canvas"]');
  const overlays = [...document.querySelectorAll("canvas")]
    .filter((c) => /overlay/i.test(c.className))
    .map((c) => ({
      w: c.width,
      h: c.height,
      /* Backing pixels per CSS pixel — the ratio each canvas actually chose. */
      ratio: vp && vp.clientWidth ? +(c.width / vp.clientWidth).toFixed(2) : null,
    }));
  return {
    derived,
    /* MB the engine will evict beyond. The number the item calls "reported". */
    reportedCacheMB: stats ? Math.round(stats.budget / 1048576) : null,
    dpr: window.devicePixelRatio,
    overlays,
    /* Total overlay pixels against the viewport's own — the cost that goes as
       the square of the ratio. */
    overlayMPx: +(overlays.reduce((n, o) => n + o.w * o.h, 0) / 1e6).toFixed(2),
    viewportMPx: vp ? +((vp.clientWidth * vp.clientHeight) / 1e6).toFixed(2) : null,
  };
};

async function open(browser, opts, seedPrefs) {
  const context = await browser.newContext(opts);
  if (seedPrefs) {
    await context.addInitScript((p) => {
      try {
        localStorage.setItem("graphiq:preferences", JSON.stringify(p));
      } catch {
        /* private mode: the check that needs this will report it */
      }
    }, seedPrefs);
  }
  const page = await context.newPage();
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const tour = await page
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await dismissStartCard(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(900);
  return { context, page };
}

/**
 * Make a 2 000 000-pixel document, which is the size that tells the two filter
 * budgets apart. `draftScale` is `sqrt(budget / pixels)` clamped at 0.25, so at
 * 12 MP both a 500k and a 250k budget clamp to the same 0.25 and prove nothing.
 * At 2 MP they are 0.50 and 0.35.
 */
async function makeDoc(page, w = 2000, h = 1000) {
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(900);
  await page.locator('[role="dialog"] input[type="number"]').nth(0).fill(String(w));
  await page.locator('[role="dialog"] input[type="number"]').nth(1).fill(String(h));
  await page.waitForTimeout(250);
  await page
    .locator('[role="dialog"] button', { hasText: /^Create$/ })
    .first()
    .click({ timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(2200);
}

/** Drag a marquee so the ants overlay sizes itself. */
async function select(page) {
  await page.keyboard.press("Control+Shift+N");
  await page.waitForTimeout(1000);
  await page.keyboard.press("m");
  await page.waitForTimeout(400);
  const box = await page.locator('[data-tour="canvas"]').boundingBox();
  await page.mouse.move(box.x + 50, box.y + 50);
  await page.mouse.down();
  await page.mouse.move(box.x + 180, box.y + 140);
  await page.mouse.up();
  await page.waitForTimeout(1200);
}

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];
  const watch = (page, tag) => {
    page.on("pageerror", (e) => errors.push(`pageerror(${tag}): ` + String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(`console(${tag}): ` + m.text()));
  };

  const browser = await launchBrowser();

  // ================================================== the desktop is untouched ==
  const d = await open(browser, DESKTOP);
  watch(d.page, "desktop");
  await select(d.page);
  await makeDoc(d.page);
  const desk = await d.page.evaluate(READ);
  check("a desktop still gets the 256 MB it always had",
    desk.reportedCacheMB === 256,
    `reported ${desk.reportedCacheMB} MB`);
  check("…and the same history and filter budgets",
    desk.derived && desk.derived.historyMB === 512 && desk.derived.draftPixels === 500000,
    desk.derived ? `${desk.derived.historyMB} MB history, ${desk.derived.draftPixels} px draft` : "");
  /* A cap, not a constant: a 1× display must not be scaled up to 2. */
  check("…and its overlays are not scaled up to meet the cap",
    desk.overlays.length >= 2 && desk.overlays.every((o) => o.ratio <= 1.01),
    desk.overlays.map((o) => `${o.w}×${o.h} @${o.ratio}`).join(", "));
  await d.context.close();

  // ========================================================= the phone shrinks ==
  const p = await open(browser, PHONE);
  watch(p.page, "phone");
  await select(p.page);
  await makeDoc(p.page);
  const phone = await p.page.evaluate(READ);

  check("a phone is given no more than 64 MB of render cache",
    phone.reportedCacheMB !== null && phone.reportedCacheMB <= 64,
    `reported ${phone.reportedCacheMB} MB, against the desktop's 256`);
  check("…a smaller history than a desktop",
    phone.derived && phone.derived.historyMB < 512,
    phone.derived ? `${phone.derived.historyMB} MB` : "");
  check("…and a smaller live-filter frame",
    phone.derived && phone.derived.draftPixels < 500000,
    phone.derived ? `${phone.derived.draftPixels} px` : "");
  /* …which the ENGINE actually works at. The line above reads the model; this
     one reads what the engine computed from it, on the same document. Without
     it, reverting the engine to its desktop constant went undetected. */
  check("…and the engine really works at that smaller scale",
    phone.derived && desk.derived &&
      phone.derived.draftScale !== null &&
      phone.derived.draftScale < desk.derived.draftScale,
    `filter frames render at ${phone.derived?.draftScale?.toFixed(3)} of full size on a phone, ` +
      `${desk.derived?.draftScale?.toFixed(3)} on a desktop, for the same 2 MP document`);

  /* The item's words: both overlay canvases agree on a dpr of 2. They used to
     disagree — ants at the full device ratio, grid at CSS pixels flat. */
  check("both overlay canvases agree, at a ratio of 2",
    phone.overlays.length >= 2 &&
      phone.overlays.every((o) => Math.abs(o.ratio - 2) < 0.02),
    `dpr ${phone.dpr}, overlays at ${phone.overlays.map((o) => o.ratio).join(" and ")}`);
  check("…so neither is drawn at the screen's full 3×",
    phone.overlays.every((o) => o.ratio < phone.dpr),
    phone.overlays.map((o) => `${o.w}×${o.h}`).join(", "));

  /* The cost goes as the square of the ratio, so the cap's saving is
     (2/dpr)² — 44% of the uncapped area at dpr 3. Asserted as that ratio rather
     than as a round threshold, because a threshold can be met by an overlay
     that barely improved.

     Stated honestly: the PAIR only improves from 10× the viewport to 8×, because
     bringing the grid UP from 1× to 2× spends most of what capping the ants
     saved. That is the item's instruction — the two must agree — and it buys a
     crisp grid on a hidpi screen. The win is per-overlay, not in the total. */
  const capped = (2 / phone.dpr) ** 2;
  const each = phone.overlays.map((o) => (o.w * o.h) / 1e6 / phone.viewportMPx);
  check("…so each overlay costs 4× the viewport rather than the screen's 9×",
    each.every((r) => r < 4.2),
    `each overlay ${each.map((r) => r.toFixed(1)).join("× and ")}× the viewport; ` +
      `capping is ${(capped * 100).toFixed(0)}% of the uncapped area at dpr ${phone.dpr}. ` +
      `The pair is ${(phone.overlayMPx / phone.viewportMPx).toFixed(1)}×, down from 10× — ` +
      `the grid rose from 1× to 2× to match, which is the point of them agreeing`);
  await p.context.close();

  // ===================================================== a tablet sits between ==
  const t = await open(browser, TABLET);
  watch(t.page, "tablet");
  await t.page.waitForTimeout(400);
  const tab = await t.page.evaluate(READ);
  check("a tablet lands between a phone and a desktop",
    tab.reportedCacheMB > phone.reportedCacheMB && tab.reportedCacheMB < desk.reportedCacheMB,
    `${phone.reportedCacheMB} → ${tab.reportedCacheMB} → ${desk.reportedCacheMB} MB`);
  await t.context.close();

  // ============================= a stored choice outranks the derivation =======
  /* Deriving a default is not the same as overruling a person. Someone who has
     set 512 MB on their phone has said something the device cannot. */
  const chosen = await open(browser, PHONE, { cacheBudgetMB: 512, historyBudgetMB: 512 });
  watch(chosen.page, "chosen");
  await chosen.page.waitForTimeout(600);
  const kept = await chosen.page.evaluate(READ);
  check("a budget the user set themselves is not overridden by the device",
    kept.reportedCacheMB === 512,
    `stored 512 MB, engine enforcing ${kept.reportedCacheMB} MB`);
  await chosen.context.close();

  check("no console errors throughout", errors.length === 0,
    errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
