/* The iOS home-screen tags, and the one consequence of them that can be measured.
 *
 * Safari ignores the manifest's `display` entirely, so an installed copy on an
 * iPhone is a browser tab with a URL bar unless these tags say otherwise. They
 * are the iOS half of the job `app/manifest.ts` does everywhere else.
 *
 * `black-translucent` is doing more than picking a colour. The three status-bar
 * styles differ in LAYOUT: `default` and `black` leave the page below the
 * status bar, while `black-translucent` puts the page UNDER it — and is the
 * only one of the three that makes `safe-area-inset-top` non-zero. That is the
 * dependency the item names: without the M0 top inset, this tag slides the top
 * bar under the clock.
 *
 * The item's check is "Add to Home Screen on iOS and confirm…", which no
 * harness can do. Two of its three clauses are about what Safari does with the
 * tags and can only be verified by reading the tags. The THIRD — "no TopBar
 * control intersects the status-bar region" — is the consequence, and Chromium
 * can be handed real notch insets over CDP, so it is measured for real: every
 * control on the bar, against a 47px inset, twice, asserted as the difference.
 *
 * Run: node tools/verify-ios-webapp.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

const PHONE = { width: 390, height: 844 };
/* An iPhone 14 Pro: 59px of notch is the tall one, 47 the common case. */
const NOTCH = { top: 47, left: 0, bottom: 34, right: 0 };

const METAS = () => {
  const meta = (n) => document.querySelector(`meta[name="${n}"]`)?.getAttribute("content") ?? null;
  const apple = document.querySelector('link[rel="apple-touch-icon"]');
  return {
    appleCapable: meta("apple-mobile-web-app-capable"),
    stdCapable: meta("mobile-web-app-capable"),
    statusBar: meta("apple-mobile-web-app-status-bar-style"),
    title: meta("apple-mobile-web-app-title"),
    docTitle: document.title,
    appleIcon: apple
      ? {
          href: new URL(apple.getAttribute("href"), location.href).href,
          sizes: apple.getAttribute("sizes"),
          type: apple.getAttribute("type"),
        }
      : null,
  };
};

/** Decode a PNG in the page: size, and whether anything is see-through. */
const INSPECT = async (url) => {
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: res.status };
  const bmp = await createImageBitmap(await res.blob());
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
  let clear = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] < 250) clear++;
  return { ok: true, w: bmp.width, h: bmp.height, transparentPx: clear };
};

/** Where the top bar is, and what sits inside the status-bar strip. */
const TOPBAR = (inset) => {
  const bar = document.querySelector('[data-tour="topbar"]');
  if (!bar) return null;
  const r = bar.getBoundingClientRect();
  const controls = [...bar.querySelectorAll("button, a, input, select")]
    .map((e) => ({ e, r: e.getBoundingClientRect() }))
    .filter(({ r: b }) => b.width > 0 && b.height > 0);
  const px = (v) => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(v)) || 0;
  return {
    safeTop: px("--safe-t"),
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    height: Math.round(r.height),
    controls: controls.length,
    /* Anything whose box starts above the inset is under the clock. */
    intruding: controls
      .filter(({ r: b }) => b.top < inset - 0.5)
      .map(({ e, r: b }) => {
        const name =
          e.getAttribute("aria-label") ||
          (e.className || "").toString().replace(/\S*module__\w+__/g, "").split(/\s+/)[0] ||
          e.tagName.toLowerCase();
        return `${name} at y=${Math.round(b.top)}`;
      }),
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

  const context = await browser.newContext({ viewport: PHONE, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  page.on("response", (r) => { if (r.status() >= 400) errors.push("HTTP " + r.status() + " " + r.url()); });
  const cdp = await context.newCDPSession(page);
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
  await page.waitForTimeout(900);

  // ============================================== what the document declares ==
  const m = await page.evaluate(METAS);

  /* Both spellings. Next renders `appleWebApp.capable` as the STANDARDISED
     `mobile-web-app-capable`, which is what Chrome asks for; iOS has only ever
     been documented as honouring the Apple one. Emitting both costs a line. */
  check("it declares itself web-app capable to iOS", m.appleCapable === "yes",
    `apple-mobile-web-app-capable="${m.appleCapable}"`);
  check("…and in the standardised spelling as well", m.stdCapable === "yes",
    `mobile-web-app-capable="${m.stdCapable}"`);

  /* The style that puts the page under the status bar, which is the only one
     that makes `safe-area-inset-top` non-zero. */
  check("the status bar is translucent, not opaque", m.statusBar === "black-translucent",
    `apple-mobile-web-app-status-bar-style="${m.statusBar}"`);

  /* iOS truncates the home-screen label rather than wrapping it, and the
     document title is far too long to be one. */
  check("it gives a short home-screen label",
    !!m.title && m.title.length <= 12 && m.title !== m.docTitle,
    `"${m.title}" (${m.title?.length} chars) vs document title "${m.docTitle}"`);

  // ------------------------------------------------------- the touch icon
  check("it links an apple-touch-icon at 180×180",
    !!m.appleIcon && m.appleIcon.sizes === "180x180",
    m.appleIcon ? `${m.appleIcon.href.split("/").pop()} ${m.appleIcon.sizes}` : "no link");
  const icon = m.appleIcon ? await page.evaluate(INSPECT, m.appleIcon.href) : { ok: false };
  check("…which loads and really is that size",
    icon.ok && icon.w === 180 && icon.h === 180,
    icon.ok ? `${icon.w}×${icon.h}` : `status ${icon.status}`);
  /* iOS renders transparency as BLACK and applies its own mask, so an icon with
     a see-through ground shows a black square behind the glyph. */
  check("…and is fully opaque, because iOS paints transparency black",
    icon.ok && icon.transparentPx === 0,
    icon.ok ? `${icon.transparentPx} transparent px` : "not decoded");

  // ============================ the consequence, measured against a real notch ==
  const before = await page.evaluate(TOPBAR, 0);
  check("the top bar starts at the top of the screen with no inset",
    before && before.top === 0 && before.safeTop === 0,
    before ? `top ${before.top}, --safe-t ${before.safeTop}` : "no top bar");
  check("…and has controls on it to be covered", before && before.controls >= 4,
    `${before?.controls} controls`);

  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: NOTCH });
  } catch (e) {
    console.error(
      "\nCANNOT RUN: this browser has no Emulation.setSafeAreaInsetsOverride " +
        `(${e.message.split("\n")[0]}).` +
        "\nThe status-bar check needs it — upgrade the browser rather than skipping it.",
    );
    process.exit(1);
  }
  await page.waitForTimeout(600);
  const after = await page.evaluate(TOPBAR, NOTCH.top);

  /* The difference is the point. A bar with a hard-coded height passes the
     no-inset reading and fails this one. */
  check("a notch makes the inset real", after.safeTop === NOTCH.top,
    `--safe-t ${before.safeTop} → ${after.safeTop}`);
  check("…and the top bar grows by exactly it",
    after.height === before.height + NOTCH.top && after.top === 0,
    `${before.height}px → ${after.height}px, still flush at y=${after.top}`);
  check("no control on the top bar sits in the status-bar strip",
    after.intruding.length === 0,
    after.intruding.length
      ? after.intruding.join(", ")
      : `all ${after.controls} controls start below y=${NOTCH.top}`);

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
