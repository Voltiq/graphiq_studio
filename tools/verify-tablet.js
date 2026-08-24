/* The tablet tier.
 *
 * A tablet is a touch device that is not a phone, and it used to get the mouse
 * shell whole: a 48px rail and a 320px dock both in flow, and every control at
 * the size a pointer needs. Measured before:
 *
 *   iPad mini 744   canvas 354px — 48% of the screen
 *   iPad      768   canvas 378px
 *   iPad Pro 1024   canvas 634px
 *   …and 23 distinct kinds of control under 44px, down to a 15×15 swap arrow.
 *
 * The tier splits two questions that had been answered together. How big a
 * control must be follows the POINTER (`data-touch`, phone and tablet alike);
 * how the shell is laid out follows the SCREEN (`data-mobile` / `data-tablet`).
 * The rail stays — a tablet has the width, and every tool is one tap rather
 * than two — while the dock becomes an overlay, because 320px is 42% of an
 * iPad mini and panels are what you consult, not what you work in.
 *
 * Run: node tools/verify-tablet.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

const LAYOUT_KEY = "graphiq:panel-layout";
const TABLETS = [
  ["iPad mini", 744, 1133],
  ["iPad", 768, 1024],
  ["iPad Pro", 1024, 1366],
];
const PHONE = [390, 844];
const DESKTOP = [1400, 900];

/** Which tier the shell picked, and what that produced. */
const READ = () => {
  const d = document.documentElement;
  const box = (sel) => {
    const e = document.querySelector(sel);
    if (!e) return null;
    const r = e.getBoundingClientRect();
    return { x: Math.round(r.x), w: Math.round(r.width), h: Math.round(r.height) };
  };
  const bar = document.querySelector('[data-tour="topbar"]');
  const dock = document.querySelector('[data-tour="dock"]');
  const dr = dock?.getBoundingClientRect();

  /* Everything pressable that is under the floor. Grouped by kind so the
     failure names a control rather than a count. */
  const small = new Map();
  for (const e of document.querySelectorAll("button, select, input, [role='menuitem']")) {
    const r = e.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    if (e.getAttribute("type") === "range") {
      /* A range's BOX is its track, so height is the hit area grown by padding
         — see Controls.module.scss. Width is the track and is never the
         problem. */
      if (r.height >= 44) continue;
    } else if (r.width >= 44 && r.height >= 44) continue;
    const kind =
      (e.className || "").toString().replace(/\S*module__\w+__/g, "").split(/\s+/)[0] ||
      e.tagName.toLowerCase() + (e.getAttribute("type") ? `[${e.getAttribute("type")}]` : "");
    if (!small.has(kind)) small.set(kind, `${Math.round(r.width)}×${Math.round(r.height)}`);
  }

  const ranges = [...document.querySelectorAll('input[type="range"]')].map((e) =>
    Math.round(e.getBoundingClientRect().height),
  );

  return {
    mobile: d.dataset.mobile ?? null,
    tablet: d.dataset.tablet ?? null,
    touch: d.dataset.touch ?? null,
    vw: window.innerWidth,
    stage: box('[data-tour="canvas"] [class*="viewport"]'),
    toolbar: box('[data-tour="toolbar"]'),
    dockX: dr ? Math.round(dr.x) : null,
    dockOnScreen: dr ? dr.left < window.innerWidth - 2 : null,
    /* Does the dock take room from the canvas, or lie over it? */
    dockInFlow: dock ? getComputedStyle(dock).position === "static" : null,
    barOverflow: bar ? bar.scrollWidth - bar.clientWidth : null,
    menubarVisible: (() => {
      const nav = document.querySelector("[data-menubar]");
      return nav ? nav.getBoundingClientRect().width > 0 : null;
    })(),
    hamburger: !!document.querySelector('header button[aria-label="Menu"]'),
    toggle: (() => {
      const b = document.querySelector("[data-panels-toggle]");
      if (!b) return null;
      const r = b.getBoundingClientRect();
      const hit = document.elementFromPoint(
        Math.round(r.x + r.width / 2),
        Math.round(r.y + r.height / 2),
      );
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        onScreen: r.left >= 0 && r.right <= window.innerWidth,
        reaches: hit && b.contains(hit) ? "itself" : hit ? hit.tagName.toLowerCase() : "nothing",
      };
    })(),
    under44: [...small.entries()].map(([k, v]) => `${k} ${v}`),
    under44Count: small.size,
    shortestRange: ranges.length ? Math.min(...ranges) : null,
    panels: [...document.querySelectorAll("[data-panel-id]")].length,
    inDock: [...(dock?.querySelectorAll("[data-panel-id]") ?? [])].length,
    /* The shell must not be a sideways scroll container. A drawer parked at
       translateX(100%) is scrollable overflow, and `overflow: hidden` still
       permits a programmatic scroll — `overflow: clip` records none at all. */
    appScrollW: (() => {
      const app = document.querySelector("[data-app]");
      return app ? app.scrollWidth - app.clientWidth : null;
    })(),
    /* A closed drawer is not part of the page: nothing in it may be tabbable.
       `checkVisibility` rather than a rect test — a `visibility: hidden`
       element still HAS a layout box, so measuring width and height reported
       all 142 controls as present with the drawer shut and the check passed on
       a drawer that was fully in the focus order. */
    focusableInDock: dock
      ? [...dock.querySelectorAll("button, select, input, [tabindex]")].filter((e) =>
          e.checkVisibility
            ? e.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true })
            : getComputedStyle(e).visibility !== "hidden",
        ).length
      : null,
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

  const open = async (w, h, touch, label, layout) => {
    const context = await browser.newContext({
      viewport: { width: w, height: h },
      hasTouch: touch,
      isMobile: touch,
    });
    if (layout)
      await context.addInitScript(
        ([k, v]) => window.localStorage.setItem(k, v),
        [LAYOUT_KEY, JSON.stringify(layout)],
      );
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror(${label}): ` + String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(`console(${label}): ` + m.text()));
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
    await page.waitForTimeout(1300);
    return { context, page };
  };

  // ============================================== every tier lands somewhere ==
  const tiers = [];
  for (const [label, w, h] of TABLETS) {
    const t = await open(w, h, true, label);
    tiers.push([label, await t.page.evaluate(READ)]);
    await t.context.close();
  }
  const ph = await open(PHONE[0], PHONE[1], true, "phone");
  const phone = await ph.page.evaluate(READ);
  await ph.context.close();
  const dk = await open(DESKTOP[0], DESKTOP[1], false, "desktop");
  const desktop = await dk.page.evaluate(READ);

  check("a phone is a phone, and is touch", phone.mobile === "true" && phone.touch === "true" && phone.tablet === null,
    `mobile=${phone.mobile} tablet=${phone.tablet} touch=${phone.touch}`);
  check("a desktop is neither, and is not touch",
    desktop.mobile === null && desktop.tablet === null && desktop.touch === null,
    `mobile=${desktop.mobile} tablet=${desktop.tablet} touch=${desktop.touch}`);
  const misTiered = tiers.filter(([, r]) => r.tablet !== "true" || r.touch !== "true" || r.mobile !== null);
  check("every tablet is a tablet, and is touch", misTiered.length === 0,
    misTiered.length
      ? misTiered.map(([l, r]) => `${l}: mobile=${r.mobile} tablet=${r.tablet}`).join(", ")
      : tiers.map(([l]) => l).join(", "));
  /* The two shells are the exact complement of each other within touch, so
     nothing can land in both — a device that did would get two layouts at once. */
  check("nothing is both a phone and a tablet",
    ![...tiers.map(([, r]) => r), phone, desktop].some((r) => r.mobile === "true" && r.tablet === "true"),
    "checked all five profiles");

  // ================================================== the item's own numbers ==
  const ipad = tiers.find(([l]) => l === "iPad")[1];
  check("at 768×1024 the canvas stage clears 700px", ipad.stage.w >= 700,
    `${ipad.stage.w}px of ${ipad.vw} — it was 378`);
  const anySmall = tiers.filter(([, r]) => r.under44Count > 0);
  check("…and nothing pressable is under 44px on any tablet", anySmall.length === 0,
    anySmall.length
      ? anySmall.map(([l, r]) => `${l}: ${r.under44.slice(0, 5).join(", ")}`).join(" | ")
      : "0 kinds under 44, from 23");
  const shortRange = tiers.filter(([, r]) => r.shortestRange !== null && r.shortestRange < 44);
  check("…including every slider's reachable area", shortRange.length === 0,
    shortRange.length
      ? shortRange.map(([l, r]) => `${l}: ${r.shortestRange}px`).join(", ")
      : `shortest range is ${ipad.shortestRange}px tall`);

  // ============================================ persistent rail, loose dock ==
  const railGone = tiers.filter(([, r]) => !r.toolbar || r.toolbar.w < 44 || r.toolbar.x < 0);
  check("the rail is persistent and on screen", railGone.length === 0,
    railGone.length
      ? railGone.map(([l, r]) => `${l}: ${r.toolbar ? `${r.toolbar.w}px at ${r.toolbar.x}` : "absent"}`).join(", ")
      : `${ipad.toolbar.w}px wide at x=${ipad.toolbar.x}, on all three`);
  const dockedIn = tiers.filter(([, r]) => r.dockInFlow || r.dockOnScreen);
  check("…and the dock starts closed, out of flow", dockedIn.length === 0,
    dockedIn.length
      ? dockedIn.map(([l, r]) => `${l}: inFlow=${r.dockInFlow} onScreen=${r.dockOnScreen}`).join(", ")
      : `off-screen at x=${ipad.dockX}, on all three`);
  const noToggle = tiers.filter(([, r]) => !r.toggle || r.toggle.reaches !== "itself" || r.toggle.h < 44);
  check("…with a toggle a finger can reach", noToggle.length === 0,
    noToggle.length
      ? noToggle.map(([l, r]) => `${l}: ${r.toggle ? `${r.toggle.w}×${r.toggle.h}, reaches ${r.toggle.reaches}` : "no toggle"}`).join(", ")
      : `${ipad.toggle.w}×${ipad.toggle.h}, on all three`);

  const barOver = tiers.filter(([, r]) => r.barOverflow > 1);
  check("the top bar fits at every tablet width", barOver.length === 0,
    barOver.length
      ? barOver.map(([l, r]) => `${l}: ${r.barOverflow}px past`).join(", ")
      : "no overflow at 744, 768 or 1024 — it wanted 1123 before");

  // ============================ opening panels does not take the canvas back ==
  /* An overlay, not a column: the whole point is that the canvas keeps its
     width whether the panels are up or not. Seeded with a panel docked LEFT and
     one FLOATING, because those hosts are dragged into place and a finger
     cannot — RightDock folds them into the one dock, and this is where a
     stranded panel would show up. */
  const seeded = await open(768, 1024, true, "tablet+layout", {
    order: [],
    left: ["layers"],
    floats: { info: { x: 40, y: 80 } },
    open: { layers: true, info: true },
  });
  const shut = await seeded.page.evaluate(READ);
  await seeded.page.locator("[data-panels-toggle]").click();
  await seeded.page.waitForTimeout(900);
  const opened = await seeded.page.evaluate(READ);
  await seeded.page.locator("[data-panels-toggle]").click();
  await seeded.page.waitForTimeout(900);
  const reshut = await seeded.page.evaluate(READ);

  check("the toggle opens the dock", opened.dockOnScreen && !shut.dockOnScreen,
    `dock x: ${shut.dockX} → ${opened.dockX}`);
  check("…and opening it leaves the canvas exactly as wide",
    opened.stage.w === shut.stage.w && opened.stage.x === shut.stage.x,
    `stage ${shut.stage.w}px at ${shut.stage.x} → ${opened.stage.w}px at ${opened.stage.x}`);
  /* A drawer parked at translateX(100%) is scrollable overflow, and
     `overflow: hidden` still permits a programmatic scroll: opening it scrolled
     `.app` to 355 and dragged the rail and the canvas off to x=-355, where they
     stayed after it shut. */
  check("…and the shell does not slide sideways when it opens or shuts",
    opened.toolbar.x === 0 && reshut.toolbar.x === 0 && reshut.stage.x === shut.stage.x,
    `rail x: ${shut.toolbar.x} → ${opened.toolbar.x} → ${reshut.toolbar.x}`);
  check("the toggle shuts it again", !reshut.dockOnScreen, `dock back to x=${reshut.dockX}`);
  /* Two separate guarantees that happen to prevent the same symptom, so each
     is asserted on its own terms — with only one of them checked, a mutation
     removing the other passed the whole harness. */
  check("the shell is not a sideways scroll container",
    shut.appScrollW === 0 && opened.appScrollW === 0,
    `.app overflows by ${shut.appScrollW}px shut, ${opened.appScrollW}px open — it was 355`);
  check("…and a closed drawer is not in the focus order",
    shut.focusableInDock === 0 && opened.focusableInDock > 0,
    `${shut.focusableInDock} focusable while shut, ${opened.focusableInDock} while open`);
  check("no panel is stranded outside the one dock",
    shut.panels > 0 && shut.inDock === shut.panels,
    `${shut.inDock} of ${shut.panels} in the dock, with one seeded left and one floating`);
  await seeded.context.close();

  // ======================= decided before the first paint, not a frame later ==
  /* The tier changes the rail's width and takes the dock out of flow, so
     settling it in an effect would paint the mouse layout first and reflow —
     and the cold-load fit measures the canvas immediately, against whatever is
     there at that moment. The inline script in layout.tsx stamps `data-tablet`
     before the first paint for exactly this reason.

     Watched from an init script, which runs before the page's own, and under
     6× CPU throttling so any gap between paint and effect is wide enough to
     see rather than something that slips between two frames. Without this the
     mutation that deletes the stamp passed the whole harness, because every
     other check waits a second and a half for React to catch up. */
  const cold = await browser.newContext({
    viewport: { width: 768, height: 1024 },
    hasTouch: true,
    isMobile: true,
  });
  await cold.addInitScript(() => {
    window.__frames = [];
    const tick = () => {
      const canvas = document.querySelector('[data-tour="canvas"]');
      const rail = document.querySelector('[data-tour="toolbar"]');
      if (canvas)
        window.__frames.push({
          tablet: document.documentElement.dataset.tablet ?? "",
          canvasW: canvas.clientWidth,
          railW: rail ? Math.round(rail.getBoundingClientRect().width) : null,
        });
      if (window.__frames.length < 90) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const coldPage = await cold.newPage();
  const cdp = await cold.newCDPSession(coldPage);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 6 });
  coldPage.on("pageerror", (e) => errors.push("pageerror(cold): " + String(e)));
  await coldPage.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await coldPage.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  await coldPage.waitForTimeout(2500);
  const frames = await coldPage.evaluate(() => window.__frames ?? []);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

  check("the tablet shell is settled before the first frame runs",
    frames.length > 0 && frames[0].tablet === "true",
    `${frames.length} frames recorded; the first had data-tablet="${frames[0]?.tablet}"`);
  const widths = [...new Set(frames.map((f) => f.canvasW))];
  check("…so the canvas is never measured against a layout that then reflows",
    widths.length === 1, `canvas width took ${widths.length} value(s): ${widths.join(", ")}`);
  const rails = [...new Set(frames.map((f) => f.railW))];
  check("…and the rail is its tablet width from the first frame",
    rails.length === 1 && rails[0] === 56, `rail width took: ${rails.join(", ")}`);
  await cold.close();

  // ===================================================== desktop untouched ==
  check("a desktop keeps its 48px rail", desktop.toolbar && desktop.toolbar.w === 48,
    `${desktop.toolbar?.w}px`);
  check("…its dock in flow beside the canvas", desktop.dockInFlow === true,
    `position: ${desktop.dockInFlow ? "static" : "not static"}`);
  check("…its inline menu bar", desktop.menubarVisible && !desktop.hamburger,
    `menubar visible: ${desktop.menubarVisible}, hamburger: ${desktop.hamburger}`);
  check("…and its mouse-sized controls", desktop.under44Count > 0,
    `${desktop.under44Count} kinds under 44px, as before — a mouse can hit them`);
  await dk.context.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
