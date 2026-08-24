/* The onboarding tour, walked end to end on a phone and on a desktop.
 *
 * A first-run phone user was being shown empty rectangles. Measured at
 * 390×844, three of the desktop lap's six spotlights pointed at nothing:
 *
 *   toolbar  320×692 at x=-320 — a closed drawer, VISIBLE AREA ZERO
 *   dock     390×422 at y=788  — the panels sheet below the fold; its only
 *                                on-screen strip is 788–844, which is exactly
 *                                the MobileBar's rect, so the step said
 *                                "Panels" while highlighting the bottom bar
 *   status     0×0             — `display: none`, leaving the 12×12 dot the
 *                                spotlight's own padding draws in the corner
 *
 * The phone now walks its own lap (`MOBILE_TOUR_STEPS`), pointing only at
 * chrome that is on screen the whole time.
 *
 * The spotlight is checked against LIVE chrome rather than against a copy of
 * the step list: for each step this looks for a `[data-tour]` element whose
 * rect, padded, matches the hole. If none does, the tour is highlighting empty
 * space — which is the bug, stated without the harness having to know the
 * itinerary.
 *
 * Run: node tools/verify-tour.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1400, height: 900 };
const PAD = 6; // TourOverlay's spotlight padding
const TAP = 44; // the touch floor the rest of the shell is held to

/** One step: what is spotlit, which target it matches, and where the card is. */
const SHOT = (pad) => {
  const blanket = document.querySelector('div[aria-label="Interactive tour"]');
  if (!blanket) return { open: false };
  const hole = blanket.querySelector('[class*="hole"]');
  const card = blanket.querySelector('[class*="card"]');
  const hr = hole.getBoundingClientRect();
  const cr = card.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  /* Area actually inside the viewport — not `width * height`, which counts a
     drawer parked off the side as a perfectly healthy 320×692 spotlight. */
  const visible = (r) =>
    Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) *
    Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));

  /* Which `data-tour` element this hole is drawn around, if any. The overlay
     insets by `pad` on every side, so the target's rect plus that padding
     should be the hole. */
  const near = (a, b) => Math.abs(a - b) <= 1.5;
  const matched = [...document.querySelectorAll("[data-tour]")].find((e) => {
    const r = e.getBoundingClientRect();
    return (
      near(r.left - pad, hr.left) &&
      near(r.top - pad, hr.top) &&
      near(r.width + pad * 2, hr.width) &&
      near(r.height + pad * 2, hr.height)
    );
  });

  return {
    open: true,
    title: card.querySelector('[class*="title"]')?.textContent.trim() ?? "",
    /* The dots CONTAINER is `.dots`, so a loose `[class*="dot"]` counts it as
       one of its own children and reports 8 for a 7-step lap. Children of the
       container, not a substring match. */
    dots: blanket.querySelector('[class*="dots"]')?.childElementCount ?? -1,
    hole: { x: Math.round(hr.x), y: Math.round(hr.y), w: Math.round(hr.width), h: Math.round(hr.height) },
    holeVisible: Math.round(visible(hr)),
    /* How much of the spotlight is actually on screen. "Non-zero area" is not
       enough on its own: the overlay pads the hole by 6px a side, so a drawer
       parked at x=-320 still pokes six pixels in and reports a healthy-looking
       4224px² — 1.8% of itself. The fraction is what separates a spotlight
       from a sliver. */
    holeOnScreen: hr.width * hr.height > 0 ? +(visible(hr) / (hr.width * hr.height)).toFixed(3) : 0,
    /* A centred step deliberately has no target: the hole collapses to a point
       mid-screen. That is not an empty spotlight, it is the absence of one. */
    centred: hr.width === 0 && hr.height === 0,
    target: matched ? matched.getAttribute("data-tour") : null,
    card: { x: Math.round(cr.x), y: Math.round(cr.y), w: Math.round(cr.width), h: Math.round(cr.height) },
    cardFully: cr.left >= 0 && cr.top >= 0 && cr.right <= vw && cr.bottom <= vh,
    buttons: [...card.querySelectorAll("button")].map((b) => ({
      label: b.textContent.trim(),
      w: Math.round(b.getBoundingClientRect().width),
      h: Math.round(b.getBoundingClientRect().height),
    })),
    vw,
    vh,
  };
};

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  /* The tour greets a first run on its own, so nothing has to open it. */
  const openTour = async (viewport, touch, label) => {
    const context = await browser.newContext({ viewport, hasTouch: touch, isMobile: touch });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror(${label}): ` + String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(`console(${label}): ` + m.text()));
    await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
    await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 20000 });
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
    await page.waitForTimeout(900);
    return { context, page };
  };

  /** Walk the whole lap, collecting a reading per step. */
  const walk = async (page) => {
    const seen = [];
    for (let i = 0; i < 20; i++) {
      const s = await page.evaluate(SHOT, PAD);
      if (!s.open) break;
      seen.push(s);
      const next = page
        .locator('div[aria-label="Interactive tour"] button', { hasText: /^(Take the tour|Next|Done)$/ })
        .last();
      if (!(await next.count())) break;
      await next.click();
      await page.waitForTimeout(600);
    }
    return seen;
  };

  // ==================================================================== phone ==
  const { context, page } = await openTour(PHONE, true, "phone");
  const lap = await walk(page);

  check("the phone gets its own, shorter lap", lap.length >= 5 && lap.length <= 7,
    `${lap.length} steps: ${lap.map((s) => s.title).join(" → ")}`);

  const targeted = lap.filter((s) => !s.centred);
  check("…with more than a couple of spotlights in it", targeted.length >= 4,
    `${targeted.length} of ${lap.length} steps spotlight something`);

  const empty = targeted.filter((s) => s.holeVisible === 0 || s.holeOnScreen < 0.5);
  check("no spotlight is drawn over empty space", empty.length === 0,
    empty.length
      ? empty
          .map((s) => `"${s.title}" ${s.hole.w}×${s.hole.h} at ${s.hole.x},${s.hole.y} — ${Math.round(s.holeOnScreen * 100)}% on screen`)
          .join(", ")
      : `least-visible is ${Math.round(Math.min(...targeted.map((s) => s.holeOnScreen)) * 100)}% on screen`);

  const unmatched = targeted.filter((s) => !s.target);
  check("…and every one of them is drawn around real chrome", unmatched.length === 0,
    unmatched.length
      ? unmatched.map((s) => `"${s.title}" matches no [data-tour] element`).join(", ")
      : targeted.map((s) => s.target).join(", "));

  /* The three the mobile shell hides or parks. Named explicitly, because
     "non-zero visible area" alone would still pass on the panels sheet: its
     on-screen strip IS the MobileBar's rect, so the spotlight looks healthy
     while highlighting a different control than the one it names. */
  const forbidden = targeted.filter((s) => ["toolbar", "dock", "status"].includes(s.target));
  check("…and none of them is chrome the phone hides", forbidden.length === 0,
    forbidden.length
      ? forbidden.map((s) => `"${s.title}" → ${s.target}`).join(", ")
      : "no toolbar / dock / status bar on this lap");

  const offCard = lap.filter((s) => !s.cardFully);
  check("the card is fully on screen at every step", offCard.length === 0,
    offCard.length
      ? offCard.map((s) => `"${s.title}" at ${s.card.x},${s.card.y} (${s.card.w}×${s.card.h})`).join(", ")
      : `all ${lap.length} steps, widest card ${Math.max(...lap.map((s) => s.card.w))}px of ${lap[0].vw}`);

  const smallBtns = lap.flatMap((s) => s.buttons.filter((b) => b.h < TAP || b.w < TAP / 2));
  check("its buttons are sized for a finger", smallBtns.length === 0,
    smallBtns.length
      ? smallBtns.map((b) => `"${b.label}" ${b.w}×${b.h}`).join(", ")
      : `shortest ${Math.min(...lap.flatMap((s) => s.buttons.map((b) => b.h)))}px tall`);

  /* Opening and closing on a centred card is what makes the lap safe on any
     layout — neither end depends on an element existing. */
  check("it opens and closes on a centred card",
    lap.length > 1 && lap[0].centred && lap[lap.length - 1].centred,
    `first "${lap[0]?.title}", last "${lap[lap.length - 1]?.title}"`);

  /* …and nothing BETWEEN them is centred. This is the check that catches a
     target quietly going missing: when `document.querySelector` finds nothing,
     TourOverlay sets the rect to null and the step renders as a centred card —
     indistinguishable by geometry from an intentional one, so every check
     above skips it. Deleting `data-tour="mobilestatus"` from the status
     readout passed the whole harness until this was added. */
  const middleCentred = lap.slice(1, -1).filter((s) => s.centred);
  check("…and every step in between actually spotlights something",
    middleCentred.length === 0,
    middleCentred.length
      ? middleCentred.map((s) => `"${s.title}" has no spotlight — its target is missing`).join(", ")
      : `${lap.length - 2} steps between the covers, all with a target`);

  /* Two lists of different lengths is the hazard as well as the point: read the
     step from one and the length from the other and the dots lie, or the tour
     never reaches its last card. */
  const dotsWrong = lap.filter((s) => s.dots !== lap.length);
  check("the dots count this lap, not the other one", dotsWrong.length === 0,
    `${lap[0]?.dots} dots for ${lap.length} steps`);

  const closed = await page.evaluate(() => !document.querySelector('div[aria-label="Interactive tour"]'));
  check("…and pressing on through it ends the tour", closed, "Done closed the overlay");
  await context.close();

  // ================================================================== desktop ==
  const desk = await openTour(DESKTOP, false, "desktop");
  const deskLap = await walk(desk.page);
  check("the desktop lap is untouched", deskLap.length === 8,
    `${deskLap.length} steps: ${deskLap.map((s) => s.title).join(" → ")}`);
  const deskTargets = deskLap.filter((s) => !s.centred);
  const deskEmpty = deskTargets.filter((s) => s.holeOnScreen < 0.5 || !s.target);
  check("…and every spotlight on it still lands on chrome", deskEmpty.length === 0,
    deskEmpty.length
      ? deskEmpty.map((s) => `"${s.title}"`).join(", ")
      : deskTargets.map((s) => s.target).join(", "));
  check("…including the three the phone had to drop",
    ["toolbar", "dock", "status"].every((t) => deskTargets.some((s) => s.target === t)),
    `desktop spotlights: ${deskTargets.map((s) => s.target).join(", ")}`);
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
