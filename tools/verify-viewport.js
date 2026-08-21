/* The shell's size: does it fill exactly the part of the screen you can see?
 *
 * `.app` was `height: 100vh; width: 100vw`. On a phone `vh` is the LARGE
 * viewport — the height the page would have if the URL bar were retracted — so
 * with the bar showing, the shell was taller than the visible area. It is now
 * `100svh` (the small viewport, the one a page that never scrolls is always in)
 * and `100%` (which, unlike `100vw`, excludes a classic scrollbar).
 *
 * WHAT THIS RAIL CAN AND CANNOT SHOW. Measured here first, rather than assumed:
 * in a desktop Chromium `vh`, `svh`, `lvh` and `dvh` all resolve to the SAME
 * number, and nothing in the protocol makes them diverge — `Emulation
 * .setVisibleSize` and a clipped `setDeviceMetricsOverride` viewport both leave
 * all four identical. There is no collapsing toolbar to emulate. So no
 * geometric check here can tell `100vh` from `100svh`; reverting the unit would
 * leave every measurement below unchanged, and the rail prints that fact rather
 * than implying otherwise.
 *
 * What the geometry DOES catch is the unit failing to apply at all — a typo, or
 * a browser without `svh` — which would collapse the shell to its content
 * height. That is the regression this change can actually cause, and it is
 * mutation-tested. The source check covers the part the geometry cannot.
 *
 * Run: node tools/verify-viewport.js [--url ...] [--channel ...]
 */
const fs = require("fs");
const path = require("path");
const { launchBrowser, urlArg } = require("./lib/launch");

const MOBILE = { width: 390, height: 844 };
const DESKTOP = { width: 1500, height: 950 };

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
    return { context, page };
  };

  const shell = (page) =>
    page.evaluate(() => {
      /* The shell is the flex column holding the whole editor: the only element
         that is a direct child of body and contains the canvas. */
      const canvas = document.querySelector('[data-tour="canvas"]');
      let el = canvas;
      while (el && el.parentElement !== document.body) el = el.parentElement;
      if (!el) return null;
      const r = el.getBoundingClientRect();
      const probe = (unit) => {
        const d = document.createElement("div");
        d.style.cssText = `position:fixed;left:-9999px;top:0;visibility:hidden;height:100${unit}`;
        document.body.appendChild(d);
        const h = d.getBoundingClientRect().height;
        d.remove();
        return Math.round(h);
      };
      const se = document.scrollingElement ?? document.documentElement;
      return {
        top: Math.round(r.top),
        height: Math.round(r.height),
        width: Math.round(r.width),
        inner: window.innerHeight,
        innerW: window.innerWidth,
        visual: Math.round(window.visualViewport.height),
        supportsSvh: CSS.supports("height", "100svh"),
        units: { vh: probe("vh"), svh: probe("svh"), lvh: probe("lvh"), dvh: probe("dvh") },
        scrollH: se.scrollHeight,
        scrollW: se.scrollWidth,
        bar: (() => {
          const b = document.querySelector('[data-tour="mobilebar"]');
          return b ? Math.round(b.getBoundingClientRect().bottom) : null;
        })(),
      };
    });

  // ---------- 1. the phone profile ----------
  {
    const { context, page } = await open(MOBILE);
    const s = await shell(page);
    check("the browser understands the small-viewport unit", s.supportsSvh,
      `CSS.supports("height","100svh") = ${s.supportsSvh}`);
    /* The item's own check: the shell fills exactly what is visible. */
    check("the shell is exactly as tall as the visible viewport",
      s.height === s.visual && s.height === s.inner && s.top === 0,
      `shell ${s.height}px from y=${s.top}, visualViewport ${s.visual}, innerHeight ${s.inner}`);
    check("…and exactly as wide, without a scrollbar's worth of overflow",
      s.width === s.innerW, `shell ${s.width}px, innerWidth ${s.innerW}`);
    check("nothing scrolls in either direction",
      s.scrollH <= s.inner && s.scrollW <= s.innerW,
      `scrollHeight ${s.scrollH} (limit ${s.inner}), scrollWidth ${s.scrollW} (limit ${s.innerW})`);
    check("the bottom bar's last row is on screen",
      s.bar !== null && s.bar <= s.inner, `bar ends at ${s.bar}, viewport is ${s.inner}`);
    console.log(
      `  NOTE  this browser resolves vh=${s.units.vh} svh=${s.units.svh} lvh=${s.units.lvh} ` +
        `dvh=${s.units.dvh} — identical, so the checks above cannot tell the units apart.`,
    );
    await context.close();
  }

  // ---------- 2. the desktop shell is unaffected ----------
  {
    const { context, page } = await open(DESKTOP);
    const s = await shell(page);
    check("the desktop shell still fills its window exactly",
      s.height === s.inner && s.width === s.innerW && s.top === 0,
      `${s.width}×${s.height} against ${s.innerW}×${s.inner}`);
    check("…and still does not scroll",
      s.scrollH <= s.inner && s.scrollW <= s.innerW,
      `scrollHeight ${s.scrollH}, scrollWidth ${s.scrollW}`);
    await context.close();
  }

  // ---------- 3. when the visible area shrinks under the layout viewport ----------
  /* A virtual keyboard cannot be emulated. Page scale can, and it produces the
     SAME condition and the same reading: visualViewport.height drops below
     innerHeight while the layout viewport is unchanged, which is exactly what a
     keyboard does and exactly what the overlays now subtract. Driven with DOM
     clicks rather than the mouse, so nothing depends on how input coordinates
     map while the page is scaled. */
  {
    const { context, page } = await open(DESKTOP);
    const cdp = await context.newCDPSession(page);

    const band = () =>
      page.evaluate(() => {
        const vv = window.visualViewport;
        const cs = getComputedStyle(document.documentElement);
        const dialog = document.querySelector('[role="dialog"]');
        const listbox = document.querySelector('[role="listbox"]');
        const box = (el) => {
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) };
        };
        /* Is the dialog's last button actually pressable where it now sits? */
        const btns = dialog ? [...dialog.querySelectorAll("button")] : [];
        const primary = btns.length ? btns[btns.length - 1] : null;
        let reachable = null;
        if (primary) {
          const r = primary.getBoundingClientRect();
          const hit = document.elementFromPoint(
            Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
          reachable = !!hit && (hit === primary || primary.contains(hit));
        }
        return {
          anchor: window.__anchor ?? null,
          inner: window.innerHeight,
          vvH: Math.round(vv.height),
          vvTop: Math.round(vv.offsetTop),
          bandBottom: Math.round(vv.offsetTop + vv.height),
          kbInset: cs.getPropertyValue("--kb-inset").trim(),
          vvVar: cs.getPropertyValue("--vv-h").trim(),
          dialog: box(dialog),
          listbox: box(listbox),
          primaryReachable: reachable,
        };
      });

    const rest = await band();
    check("at rest nothing is hidden below the fold", rest.kbInset === "0px",
      `--kb-inset ${rest.kbInset}, --vv-h ${rest.vvVar}`);

    // Open a real dialog: the command palette, then Preferences from it.
    await page.click('button[aria-label="Open the command palette"]');
    await page.waitForTimeout(400);
    await page.keyboard.type("preferences");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
    await page.waitForTimeout(500);
    const opened = await band();
    check("a dialog opens inside the viewport", !!opened.dialog && opened.dialog.bottom <= opened.bandBottom,
      opened.dialog ? `dialog ends at ${opened.dialog.bottom}, visible to ${opened.bandBottom}` : "no dialog");

    // Now shrink what is visible, as a keyboard would.
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 2 });
    await page.waitForTimeout(500);
    const shrunk = await band();
    const expected = shrunk.inner - shrunk.vvH - shrunk.vvTop;
    check("the hook reports what the keyboard would be covering",
      shrunk.kbInset === `${expected}px` && expected > 0,
      `--kb-inset ${shrunk.kbInset}, expected ${expected}px (innerHeight ${shrunk.inner} - visible ${shrunk.vvH})`);
    check("…and the dialog shrinks back inside what is visible",
      !!shrunk.dialog && shrunk.dialog.bottom <= shrunk.bandBottom && shrunk.dialog.top >= shrunk.vvTop,
      shrunk.dialog
        ? `dialog ${shrunk.dialog.top}…${shrunk.dialog.bottom} (was ${opened.dialog.height}px tall, now ` +
          `${shrunk.dialog.height}px), visible band ends at ${shrunk.bandBottom}`
        : "no dialog");
    check("…and its last button can still be pressed", shrunk.primaryReachable === true,
      `elementFromPoint at the button's centre ${shrunk.primaryReachable ? "returns it" : "returns something else"}`);

    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await page.waitForTimeout(500);
    const back = await band();
    check("restoring the viewport puts it all back",
      back.kbInset === "0px" && back.dialog.height === opened.dialog.height,
      `--kb-inset ${back.kbInset}, dialog ${back.dialog.height}px (was ${opened.dialog.height}px)`);

    /* The item's own case, in the dialog that actually matches it: Canvas Size
       focuses a text field on open — the thing that raises a keyboard — and
       carries a dropdown. Opened AFTER the shrink, since what is being checked
       is where a menu is placed while the area is already short. */
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    await page.click('button[aria-label="Open the command palette"]');
    await page.waitForTimeout(400);
    await page.keyboard.type("canvas size");
    await page.waitForTimeout(500);
    await page.keyboard.press("Enter");
    await page.waitForSelector('[role="dialog"]', { timeout: 5000 });
    await page.waitForTimeout(500);
    /* Squeezed harder than the dialog checks above: the point here is a menu
       that CANNOT fit below its trigger inside the visible band, so placement
       has to react. At a gentler scale it fits either way and the check passes
       whatever the code does — which a mutation proved, staying green with the
       menu placed against the layout viewport. */
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 3 });
    await page.waitForTimeout(500);
    const opens = await page.evaluate(() => {
      const t = [...document.querySelectorAll('[role="dialog"] button[aria-haspopup="listbox"]')]
        .find((b) => b.getBoundingClientRect().width > 0);
      if (!t) return false;
      const r = t.getBoundingClientRect();
      window.__anchor = { top: Math.round(r.top), bottom: Math.round(r.bottom) };
      t.click();
      return true;
    });
    await page.waitForTimeout(450);
    const withMenu = await band();
    check("a dropdown opened while it is short stays inside it",
      opens && !!withMenu.listbox && withMenu.listbox.bottom <= withMenu.bandBottom &&
        withMenu.listbox.top >= withMenu.vvTop,
      withMenu.listbox
        ? `trigger ends at ${withMenu.anchor?.bottom}, a ${withMenu.listbox.height}px menu below it would ` +
          `reach ${(withMenu.anchor?.bottom ?? 0) + 4 + withMenu.listbox.height}; it lands at ` +
          `${withMenu.listbox.top}…${withMenu.listbox.bottom}, band ${withMenu.vvTop}…${withMenu.bandBottom}`
        : opens ? "no menu opened" : "no dropdown inside the dialog");
    await cdp.send("Emulation.setPageScaleFactor", { pageScaleFactor: 1 });
    await page.waitForTimeout(300);
    console.log(
      "  NOTE  a virtual keyboard cannot be emulated; page scale stands in for it, " +
        "producing the same visualViewport reading the overlays react to.",
    );
    await context.close();
  }

  // ---------- 4. the source, which is the half the geometry cannot see ----------
  const shellCss = fs.readFileSync(
    path.join(process.cwd(), "app", "components", "Editor.module.scss"), "utf8");
  const rule = shellCss.slice(shellCss.indexOf(".app {"), shellCss.indexOf("}", shellCss.indexOf(".app {")));
  check("the shell asks for the small viewport, not the large one",
    /height:\s*100svh/.test(rule) && !/height:\s*100(d|l)?vh/.test(rule),
    rule.match(/height:[^;]+;/)?.[0] ?? "no height found");
  check("…and sizes its width without counting a scrollbar",
    /width:\s*100%/.test(rule) && !/width:\s*100vw/.test(rule),
    rule.match(/width:[^;]+;/)?.[0] ?? "no width found");

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
