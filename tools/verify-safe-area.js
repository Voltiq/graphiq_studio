/* Safe-area tokens: do the display's unusable edges actually reach the layout?
 *
 * The app used to write `env(safe-area-inset-bottom)` out at five call sites
 * and never mentioned top, left or right at all. Those five are now one set of
 * tokens — `--safe-t/r/b/l` — plus two derived offsets, `--chrome-top` and
 * `--chrome-bottom`, that everything between the bars anchors to.
 *
 * The checks below are worth more than "the token exists", because a token
 * that nothing consumes would satisfy that. Chromium can be handed real notch
 * insets over CDP (`Emulation.setSafeAreaInsetsOverride`), which makes `env()`
 * resolve for real — so every geometric claim here is measured twice, once
 * with no insets and once with a notch and a home indicator, and asserted as
 * the DIFFERENCE between them. A hard-coded 56px bar passes the first reading
 * and fails the second.
 *
 * Run: node tools/verify-safe-area.js [--url ...] [--channel ...]
 */
const fs = require("fs");
const path = require("path");
const { launchBrowser, urlArg } = require("./lib/launch");

/* An iPhone-ish profile: a notch at the top, the home indicator at the foot. */
const NOTCH = { top: 47, right: 0, bottom: 34, left: 0 };
/* Rotated, where the cutout moves to one side and the indicator with it. */
const LANDSCAPE = { top: 0, right: 34, bottom: 21, left: 47 };

const MOBILE = { width: 390, height: 844 };

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const open = async (viewport) => {
    const context = await browser.newContext({ viewport });
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
    await page.waitForTimeout(600);
    return { context, page, cdp: await context.newCDPSession(page) };
  };

  /** The tokens as the browser has actually computed them, plus the geometry
   *  they are supposed to be driving. */
  const readout = (page) =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      const v = (n) => cs.getPropertyValue(n).trim();
      const px = (s) => (s.endsWith("px") ? parseFloat(s) : NaN);
      /* A custom property holding a calc() of other properties computes to the
         SUBSTITUTED TOKEN STREAM — "calc(48px + 48px)" — not to a length, so it
         cannot simply be parsed. Measuring an element sized by it is what the
         layout itself does, and gives the used value. */
      const resolve = (expr) => {
        const probe = document.createElement("div");
        probe.style.cssText = `position:fixed;left:-9999px;top:0;visibility:hidden;height:${expr}`;
        document.body.appendChild(probe);
        const h = probe.getBoundingClientRect().height;
        probe.remove();
        return Math.round(h);
      };
      const box = (sel) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: Math.round(r.left),
                 right: Math.round(r.right), height: Math.round(r.height) };
      };
      const bar = document.querySelector('[data-tour="mobilebar"]');
      return {
        mobile: document.documentElement.dataset.mobile ?? "(absent)",
        safe: { t: px(v("--safe-t")), r: px(v("--safe-r")), b: px(v("--safe-b")), l: px(v("--safe-l")) },
        chromeTop: resolve("var(--chrome-top)"),
        chromeBottom: resolve("var(--chrome-bottom)"),
        toolbar: box('[data-tour="toolbar"]'),
        dock: box('[data-tour="dock"]'),
        edge: box(".gq-m-edge"),
        bar: box('[data-tour="mobilebar"]'),
        barPadBottom: bar ? Math.round(parseFloat(getComputedStyle(bar).paddingBottom)) : null,
        /* The lowest edge of anything the user has to be able to press. */
        barContentBottom: bar
          ? Math.round(Math.max(...[...bar.querySelectorAll("button")].map((b) => b.getBoundingClientRect().bottom)))
          : null,
        innerHeight: window.innerHeight,
      };
    });

  // ---------- 1. desktop: the tokens exist and are inert ----------
  {
    const { context, page } = await open({ width: 1500, height: 950 });
    const d = await readout(page);
    check("on a desktop browser every safe-area token resolves to 0",
      d.safe.t === 0 && d.safe.r === 0 && d.safe.b === 0 && d.safe.l === 0,
      `t${d.safe.t} r${d.safe.r} b${d.safe.b} l${d.safe.l}`);
    check("…so the derived offsets are just the chrome's own heights",
      d.chromeTop === 96 && d.chromeBottom === 28,
      `--chrome-top ${d.chromeTop}px, --chrome-bottom ${d.chromeBottom}px (48+48, 28)`);
    check("the desktop shell is untouched by any of it", d.mobile === "(absent)", `data-mobile=${d.mobile}`);
    await context.close();
  }

  // ---------- 2. mobile, no insets: the baseline every later number moves from ----------
  const { context, page, cdp } = await open(MOBILE);
  const flat = await readout(page);
  check("the phone profile gets the mobile shell", flat.mobile === "true", `data-mobile=${flat.mobile}`);
  check("with no insets the bottom chrome is exactly the bar", flat.chromeBottom === 56,
    `--chrome-bottom ${flat.chromeBottom}px`);
  check("…and the bar's box matches it", flat.bar?.height === 56 && flat.bar?.bottom === MOBILE.height,
    `${flat.bar?.height}px tall, bottom at ${flat.bar?.bottom}`);
  check("the drawers span from under the chrome to above the bar",
    flat.toolbar?.top === 96 && flat.toolbar?.bottom === MOBILE.height - 56 &&
    flat.dock?.top === 96 && flat.dock?.bottom === MOBILE.height - 56,
    `toolbar ${flat.toolbar?.top}–${flat.toolbar?.bottom}, dock ${flat.dock?.top}–${flat.dock?.bottom}`);

  // ---------- 3. mobile WITH a notch and a home indicator ----------
  /* Everything below depends on the browser being able to emulate insets. If it
     cannot, say so in those words: a silent skip here would leave the rail
     green while proving nothing at all about the half that matters. */
  try {
    await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: NOTCH });
  } catch (e) {
    console.error(
      "\nCANNOT RUN: this browser has no Emulation.setSafeAreaInsetsOverride " +
        `(${e.message.split("\n")[0]}).` +
        "\nEvery inset check needs it — upgrade the browser rather than skipping them.",
    );
    process.exit(1);
  }
  await page.waitForTimeout(300);
  const notched = await readout(page);

  check("a notch reaches the top token", notched.safe.t === NOTCH.top, `--safe-t ${notched.safe.t}px`);
  check("the home indicator reaches the bottom token", notched.safe.b === NOTCH.bottom,
    `--safe-b ${notched.safe.b}px`);
  check("the bottom chrome grows by exactly the indicator, not by a guess",
    notched.chromeBottom - flat.chromeBottom === NOTCH.bottom,
    `--chrome-bottom ${flat.chromeBottom} -> ${notched.chromeBottom} (+${notched.chromeBottom - flat.chromeBottom})`);
  check("…and the bar's box grows with it",
    notched.bar.height - flat.bar.height === NOTCH.bottom && notched.bar.bottom === MOBILE.height,
    `${flat.bar.height} -> ${notched.bar.height}px, still flush at ${notched.bar.bottom}`);
  /* The point of the exercise: the bar's BACKGROUND still reaches the bottom of
     the display, but nothing pressable is under the home indicator. */
  check("the bar's buttons clear the home indicator",
    notched.barPadBottom === NOTCH.bottom && notched.barContentBottom <= MOBILE.height - NOTCH.bottom,
    `padding-bottom ${notched.barPadBottom}px, lowest button ends at ${notched.barContentBottom} (limit ${MOBILE.height - NOTCH.bottom})`);
  check("both drawers stop above the indicator, by the same amount",
    flat.toolbar.bottom - notched.toolbar.bottom === NOTCH.bottom &&
    flat.dock.bottom - notched.dock.bottom === NOTCH.bottom,
    `toolbar ${flat.toolbar.bottom} -> ${notched.toolbar.bottom}, dock ${flat.dock.bottom} -> ${notched.dock.bottom}`);

  /* A SEAM, deliberately: --chrome-top does not include --safe-t yet, because
     the top bar does not reserve it either. Folding it in before that happens
     would leave a strip of bare canvas under the options bar. When the top bar
     is inset, this check is the one that should fail and be updated. */
  check("the top offset is deliberately NOT inset yet (the top bar isn't either)",
    notched.chromeTop === flat.chromeTop && notched.toolbar.top === flat.toolbar.top,
    `--chrome-top still ${notched.chromeTop}px — folding --safe-t in belongs with insetting the top bar`);

  // ---------- 4. rotated: the side insets exist, ready for the item that uses them ----------
  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: LANDSCAPE });
  await page.waitForTimeout(300);
  const rotated = await readout(page);
  check("a side cutout reaches the left and right tokens",
    rotated.safe.l === LANDSCAPE.left && rotated.safe.r === LANDSCAPE.right,
    `--safe-l ${rotated.safe.l}px, --safe-r ${rotated.safe.r}px`);
  check("…and the bottom follows the rotation too",
    rotated.safe.b === LANDSCAPE.bottom && rotated.chromeBottom === 56 + LANDSCAPE.bottom,
    `--safe-b ${rotated.safe.b}px, --chrome-bottom ${rotated.chromeBottom}px`);

  await cdp.send("Emulation.setSafeAreaInsetsOverride", { insets: { top: 0, right: 0, bottom: 0, left: 0 } });
  await page.waitForTimeout(200);
  const cleared = await readout(page);
  check("clearing the insets puts everything back", cleared.chromeBottom === 56 && cleared.bar.height === 56,
    `--chrome-bottom ${cleared.chromeBottom}px, bar ${cleared.bar.height}px`);

  // ---------- 5. the source itself: nothing hand-rolls env() any more ----------
  const scss = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (e.name.endsWith(".scss")) scss.push(f);
    }
  };
  walk(path.join(process.cwd(), "app"));
  const envUses = [];
  const strayOffsets = [];
  for (const f of scss) {
    const text = fs.readFileSync(f, "utf8");
    for (const line of text.split("\n")) {
      if (line.includes("env(safe-area-inset")) envUses.push(`${path.basename(f)}: ${line.trim()}`);
      /* The two sums the tokens replaced, written out longhand again —
         excluding the token definitions, which are the one place they belong. */
      if (/^\s*--(chrome|safe)-/.test(line)) continue;
      if (/var\(--topbar-h\)\s*\+\s*var\(--optionsbar-h\)/.test(line) ||
          /var\(--mobilebar-h\)\s*\+/.test(line))
        strayOffsets.push(`${path.basename(f)}: ${line.trim()}`);
    }
  }
  const defsOnly = envUses.every((u) => u.startsWith("globals.scss: --safe-"));
  check("env(safe-area-inset) survives only in the four token definitions",
    envUses.length === 4 && defsOnly, `${envUses.length} use(s)${defsOnly ? "" : " — " + envUses.join(" | ")}`);
  check("no offset re-adds the chrome heights by hand", strayOffsets.length === 0,
    strayOffsets.length ? strayOffsets.join(" | ") : "none");

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
