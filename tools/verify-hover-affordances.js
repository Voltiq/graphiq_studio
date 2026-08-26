/* The things you could only reach by hovering.
 *
 * Two separate disappearances, both invisible in the ordinary sense of the word.
 *
 *   - The delete button on every saved thing — filter presets, history
 *     snapshots, colour samplers, saved brushes, gradient presets, layer styles,
 *     custom shapes — is `opacity: 0` until its row is hovered. That keeps a
 *     dense list readable with a mouse and makes the button literally
 *     unreachable with a finger, because no gesture hovers.
 *   - `Tooltip.tsx` returns immediately for `pointerType === "touch"`, which is
 *     correct as far as it goes — a finger has no hover to track — but it left
 *     every icon-only control on a phone with no visible label at all.
 *
 * The gate for the first is `hover: none`, not the mobile shell's `data-mobile`.
 * The question is whether the device can hover, not how wide it is: a tablet
 * gets the DESKTOP shell today and still cannot hover, so `data-mobile` would
 * have left it exactly as broken. The harness checks a tablet profile for
 * exactly that reason.
 *
 * Coverage is deliberately two-layered, because the seven kinds live in four
 * stylesheets and six different creation flows:
 *
 *   - every one of the seven classes is checked by COMPUTED STYLE, on a real
 *     element built from the hashed class the stylesheet actually shipped and
 *     nested inside its real parent. That catches a rule written against a
 *     class name that does not exist, which is the way this change fails.
 *   - two kinds are then driven end to end — create the thing, see the button,
 *     press it, watch the thing go — because "opacity is 1" is not the same
 *     claim as "a finger can delete this".
 *
 * Run: node tools/verify-hover-affordances.js [--url ...] [--channel ...]
 */
const { launchBrowser, openPanel, setSheetDetent, urlArg } = require("./lib/launch");

/** Each reveal button, and the row it lives in — the base rule is often nested
 *  inside the parent, so a bare probe element would not inherit it. */
const KINDS = [
  ["presetDelete", "filterChip", "filter presets"],
  ["snapDel", "historyRow", "history snapshots"],
  ["samplerDel", "samplerRow", "colour samplers"],
  ["brushDel", "brushItem", "saved brushes"],
  ["presetDel", "presetCell", "gradient presets"],
  ["shapeDel", "shapeCell", "custom shapes"],
  ["styleDel", "styleCell", "layer styles"],
];

/* Built inside the page: for each class, find the hashed name the stylesheets
   actually carry, build the element inside its real parent, and read back what
   the browser computes. Not a reading of the source — a reading of the CSSOM as
   shipped, on this device, with this viewport's media queries resolved. */
const OPACITIES = (kinds) => {
  const hashed = {};
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch {
      continue; // a cross-origin sheet: nothing of ours is in one
    }
    const walk = (list) => {
      for (const r of list) {
        if (r.cssRules) walk(r.cssRules);
        if (!r.selectorText) continue;
        for (const m of r.selectorText.matchAll(/\.([A-Za-z0-9_-]+)/g)) {
          const cls = m[1];
          /* Parents as well as the buttons: several of the base `opacity: 0`
             rules are NESTED inside their row (`.samplerRow .samplerDel`), so a
             probe built without the parent class silently misses them — and
             reports the desktop as already fixed. */
          for (const pair of kinds)
            for (const name of pair.slice(0, 2))
              if (cls.endsWith("__" + name) || cls === name) (hashed[name] ||= new Set()).add(cls);
        }
      }
    };
    walk(rules);
  }
  const out = {};
  for (const [name, parent] of kinds) {
    const own = [...(hashed[name] ?? [])];
    if (!own.length) {
      out[name] = null; // no rule mentions it at all
      continue;
    }
    const host = document.createElement("div");
    host.className = [...(hashed[parent] ?? [])].join(" ");
    const el = document.createElement("div");
    el.className = own.join(" ");
    host.appendChild(el);
    document.body.appendChild(host);
    out[name] = Number(getComputedStyle(el).opacity);
    host.remove();
  }
  return out;
};

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const open = async (viewport, touch, label) => {
    const context = await browser.newContext({ viewport, hasTouch: touch });
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
    await page.waitForTimeout(900);
    return { context, page };
  };

  // ---------------------------------------------- every kind, by computed style
  const phone = await open({ width: 390, height: 844 }, true, "phone");
  const onPhone = await phone.page.evaluate(OPACITIES, KINDS);
  const missing = KINDS.filter(([n]) => onPhone[n] === null).map(([n]) => n);
  check("every reveal button's class is one the stylesheets actually carry",
    missing.length === 0, missing.length ? `no rule mentions ${missing.join(", ")}` : "all seven found");
  const hidden = KINDS.filter(([n]) => onPhone[n] !== null && onPhone[n] < 1);
  check("…and on a phone all seven are fully visible",
    hidden.length === 0,
    hidden.length
      ? hidden.map(([n, , what]) => `${what} (${n}) at ${onPhone[n]}`).join(", ")
      : KINDS.map(([n]) => `${n}=${onPhone[n]}`).join(" "),
  );

  /* A tablet: touch, so it cannot hover, but WIDE — it gets the desktop shell
     and `data-mobile` is unset on it. This is the case a `data-mobile` gate
     would have missed entirely. */
  const tablet = await open({ width: 900, height: 1200 }, true, "tablet");
  const shell = await tablet.page.evaluate(() => document.documentElement.dataset.mobile ?? "(unset)");
  const onTablet = await tablet.page.evaluate(OPACITIES, KINDS);
  const tabletHidden = KINDS.filter(([n]) => onTablet[n] !== null && onTablet[n] < 1);
  check("a wide touch device gets them too, though it is not the mobile shell",
    tabletHidden.length === 0 && shell === "(unset)",
    `data-mobile is ${shell}; ` +
      (tabletHidden.length ? `still hidden: ${tabletHidden.map(([n]) => n).join(", ")}` : "all seven visible"));
  await tablet.context.close();

  // ---------------------------------------------------- two kinds, end to end
  /* Because "opacity is 1" and "a finger can delete this" are different claims.
     These two are the ones a single tap can create; the others need a name, a
     dialog or a dirty adjustment first, and are covered by the style check
     above rather than by a flow this harness would have to invent. */
  const page = phone.page;
  await page.keyboard.press("Control+Shift+N");
  await page.waitForTimeout(1200);
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
  await page.waitForTimeout(1000);
  /* The sheet is an accordion on a phone, so "expand everything" leaves only
     the last one open — each journey asks for the panel it needs instead. */
  await setSheetDetent(page, "full");

  const countOf = (cls) =>
    page.evaluate((k) => document.querySelectorAll(`[class*="${k}"]`).length, cls);
  const visibleCountOf = (cls) =>
    page.evaluate(
      (k) =>
        [...document.querySelectorAll(`[class*="${k}"]`)].filter(
          (e) => Number(getComputedStyle(e).opacity) > 0.5 && e.getBoundingClientRect().width > 4,
        ).length,
      cls,
    );
  /* Titles are relocated to `data-tip` by the tooltip host, so `[title=...]`
     matches nothing — a trap this repo has fallen into twice. */
  const tapTip = async (tip) => {
    const el = page.locator(`[data-tip="${tip}"]`).first();
    if (!(await el.count())) return false;
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(900);
    return true;
  };

  const journey = async (what, createTip, cls, panelId) => {
    if (panelId) await openPanel(page, panelId);
    const before = await countOf(cls);
    const made = await tapTip(createTip);
    const after = await countOf(cls);
    check(`a ${what} can be created`, made && after > before, `${before} → ${after} rows`);
    if (after <= before) return;
    check(`…and its delete button is visible without hovering`,
      (await visibleCountOf(cls)) > 0,
      `${await visibleCountOf(cls)} of ${after} visible`);
    /* Pressed the way a finger would, not by dispatching to a hidden node. */
    const del = page.locator(`[class*="${cls}"]`).first();
    await del.scrollIntoViewIfNeeded().catch(() => {});
    await del.click({ timeout: 6000 }).catch(() => {});
    await page.waitForTimeout(900);
    const gone = await countOf(cls);
    check(`…and pressing it deletes the ${what}`, gone < after, `${after} → ${gone} rows`);
  };

  await journey("history snapshot", "Take a snapshot of the current state", "snapDel", "history");
  await journey("saved brush", "Save the current brush settings as a preset", "brushDel", "brushes");

  // ------------------------------------------------ long-press for a tooltip
  await page.evaluate(() => window.history.back()); // close the drawer: its scrim eats presses
  await page.waitForTimeout(900);
  const cdp = await phone.context.newCDPSession(page);
  const touch = (type, points) =>
    cdp.send("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((q) => ({ x: Math.round(q.x), y: Math.round(q.y) })),
    });
  /* An icon-only control that is genuinely on top: the drawer's scrim covered
     the top bar in an earlier version of this and every press missed. */
  const iconControl = await page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-tip]")].find((e) => {
      const r = e.getBoundingClientRect();
      if (r.width < 8 || r.top < 0 || r.bottom > innerHeight) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && (e.contains(hit) || hit.contains(e));
    });
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return {
      tip: el.getAttribute("data-tip"),
      text: (el.textContent || "").trim(),
      x: Math.round(r.left + r.width / 2),
      y: Math.round(r.top + r.height / 2),
    };
  });
  check("an icon-only control with a tip is reachable to press",
    !!iconControl && iconControl.tip.length > 0 && iconControl.text.length === 0,
    iconControl ? `"${iconControl.tip}" with no visible text of its own` : "none found");

  const tipText = () =>
    page.evaluate(() => document.querySelector('[role="tooltip"]')?.textContent ?? null);
  check("no tooltip before the press", (await tipText()) === null);

  await touch("touchStart", [{ x: iconControl.x, y: iconControl.y }]);
  await page.waitForTimeout(220);
  check("…nor while it is still a tap rather than a hold", (await tipText()) === null,
    `after 220ms: ${JSON.stringify(await tipText())}`);
  await page.waitForTimeout(500);
  const held = await tipText();
  check("a long press produces a [role=\"tooltip\"] carrying the full text",
    held === iconControl.tip, `showed ${JSON.stringify(held)}, expected ${JSON.stringify(iconControl.tip)}`);
  await touch("touchEnd", []);
  await page.waitForTimeout(400);

  /* A press that MOVES is a drag, and must not leave a label behind.
     Run with `touch-action: none` forced onto the target, which is the case the
     slop guard exists for. WITHOUT that, the browser takes the moving touch for
     a scroll and fires `pointercancel`, which ends the press for free — so the
     scenario passes whether or not the guard is there, and mutating the guard
     out leaves the check green. The app has surfaces that suppress
     pointercancel exactly this way (the canvas, the drawers), and the guard is
     what covers a labelled control living on one. */
  await page.addStyleTag({ content: "[data-tip]{touch-action:none!important}" });
  await page.waitForTimeout(200);
  await touch("touchStart", [{ x: iconControl.x, y: iconControl.y }]);
  for (let i = 1; i <= 5; i++)
    await touch("touchMove", [{ x: iconControl.x + i * 6, y: iconControl.y + i * 2 }]);
  await page.waitForTimeout(700);
  const afterDrag = await tipText();
  await touch("touchEnd", []);
  await page.waitForTimeout(300);
  check("a press that turns into a drag shows nothing, even where nothing cancels it",
    afterDrag === null, `after moving 30px and holding: ${JSON.stringify(afterDrag)}`);

  /* And the tap that ends a long press is swallowed: asking what a button does
     should not also press it. Proved on the Alt modifier chip rather than on
     Undo — the chip's whole state is one attribute, it is always available, and
     it changes nothing about the document, so the check cannot be knocked out
     by whatever the rest of the harness did before it. An earlier version used
     Undo and reported "Undo was unavailable to test against" under two
     different mutations: a check that cannot run is not a check that failed. */
  const chip = page.locator('[aria-label="Keyboard modifiers"] button', { hasText: /^Alt/ }).first();
  const chipBox = (await chip.count()) ? await chip.boundingBox() : null;
  const modeBefore = chipBox ? await chip.getAttribute("data-mode") : null;
  check("a modifier chip is available to test the swallowed tap on",
    !!chipBox && modeBefore === "off", `data-mode="${modeBefore}"`);
  if (chipBox) {
    const cx = Math.round(chipBox.x + chipBox.width / 2);
    const cy = Math.round(chipBox.y + chipBox.height / 2);
    await touch("touchStart", [{ x: cx, y: cy }]);
    await page.waitForTimeout(750);
    const chipTip = await tipText();
    await touch("touchEnd", []);
    await page.waitForTimeout(700);
    const modeAfter = await chip.getAttribute("data-mode");
    check("long-pressing it labels it", typeof chipTip === "string" && chipTip.length > 0,
      `tooltip: ${JSON.stringify(chipTip)}`);
    check("…and the tap that ended the press did NOT arm it",
      modeAfter === "off", `data-mode "${modeBefore}" → "${modeAfter}"`);
    /* And an ordinary tap still works, or the swallow would have broken the
       chip for everyone. */
    await touch("touchStart", [{ x: cx, y: cy }]);
    await touch("touchEnd", []);
    await page.waitForTimeout(600);
    check("…while an ordinary tap still arms it",
      (await chip.getAttribute("data-mode")) === "armed",
      `data-mode="${await chip.getAttribute("data-mode")}"`);
  }
  await phone.context.close();

  // ------------------------------------------------------- desktop unchanged
  const desk = await open({ width: 1400, height: 900 }, false, "desktop");
  const onDesk = await desk.page.evaluate(OPACITIES, KINDS);
  const shown = KINDS.filter(([n]) => onDesk[n] !== null && onDesk[n] > 0);
  check("on a mouse they are all still hidden until hovered",
    shown.length === 0,
    shown.length ? shown.map(([n]) => `${n}=${onDesk[n]}`).join(", ") : KINDS.map(([n]) => `${n}=${onDesk[n]}`).join(" "));

  /* The hover path itself has to survive the touch path being added. */
  const deskTip = await desk.page.evaluate(() => {
    const el = [...document.querySelectorAll("[data-tip]")].find((e) => e.getBoundingClientRect().width > 8);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { tip: el.getAttribute("data-tip"), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
  });
  await desk.page.mouse.move(deskTip.x, deskTip.y);
  await desk.page.waitForTimeout(900);
  const hovered = await desk.page.evaluate(
    () => document.querySelector('[role="tooltip"]')?.textContent ?? null);
  check("and hovering with a mouse still shows a tooltip as it always did",
    hovered === deskTip.tip, `showed ${JSON.stringify(hovered)}, expected ${JSON.stringify(deskTip.tip)}`);
  await desk.context.close();

  // ================= the eighth kind, which this rail was not looking at ======
  /* The document tab's close button is the same fault as the seven above —
     `opacity: 0` until its row is hovered — and this rail walked straight past
     it for one reason: the tab strip HIDES ITSELF at one document, and nothing
     here had ever opened a second. A list of seven classes cannot find the
     eighth; only visiting the screen can.

     The strip has a second, unrelated fault worth measuring in the same place:
     it is 36px tall and the tab inside it is 27px until the 44px touch floor
     raises the tab, at which point the tab is taller than the strip holding
     it. */
  const two = await open({ width: 390, height: 844 }, true, "phone+2docs");
  await two.page.keyboard.press("Control+n");
  await two.page.waitForTimeout(900);
  await two.page
    .locator('[role="dialog"] button', { hasText: /^Create$/ })
    .first()
    .click()
    .catch(() => {});
  await two.page.waitForTimeout(2000);

  const strip = await two.page.evaluate(() => {
    const el = document.querySelector("[data-tabs]");
    if (!el) return null;
    const sr = el.getBoundingClientRect();
    const tab = el.querySelector("button");
    const tr = tab.getBoundingClientRect();
    const close = el.querySelector('[role="button"][aria-label^="Close"]');
    if (!close) return { noClose: true };
    const cr = close.getBoundingClientRect();
    const cx = Math.round(cr.x + cr.width / 2);
    const cy = Math.round(cr.y + cr.height / 2);
    const hit = (x, y) => {
      const e = document.elementFromPoint(x, y);
      if (!e) return "none";
      if (e.closest('[role="button"][aria-label^="Close"]')) return "close";
      return e.closest("[data-tabs] button") ? "tab" : "other";
    };
    return {
      stripH: Math.round(sr.height),
      tab: { w: Math.round(tr.width), h: Math.round(tr.height) },
      /* The tab must sit INSIDE the strip: the fault was the reverse. */
      fits: tr.top >= sr.top - 0.5 && tr.bottom <= sr.bottom + 0.5,
      close: { w: Math.round(cr.width), h: Math.round(cr.height) },
      visible: close.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
      /* It must not reach past its own tab into the neighbouring one. */
      contained: cr.right <= tr.right + 0.5,
      hits: { close: hit(cx, cy), tab: hit(Math.round(tr.x + 20), cy) },
    };
  });

  check("the tab strip is tall enough for the tab inside it",
    strip && strip.fits && strip.stripH >= strip.tab.h,
    strip ? `${strip.tab.w}×${strip.tab.h} tab in a ${strip.stripH}px strip` : "no strip");
  check("a document's close button is visible without hovering",
    strip && strip.visible === true,
    strip ? `visible: ${strip.visible}` : "");
  check("…and is a target rather than a 16px mark",
    strip && strip.close.w >= 28 && strip.close.h >= 40,
    strip ? `${strip.close.w}×${strip.close.h}` : "");
  check("…without reaching past its own tab into the next one",
    strip && strip.contained && strip.hits.tab === "tab",
    strip ? `contained: ${strip.contained}, tab still answers at its left edge: ${strip.hits.tab}` : "");

  /* And it closes a document, which is the only claim that matters. */
  const wasOpen = await two.page.evaluate(() => document.querySelectorAll("[data-tabs] button[class*='tab']").length);
  await two.page.locator('[data-tabs] [role="button"][aria-label^="Close"]').first().click();
  await two.page.waitForTimeout(1200);
  const nowOpen = await two.page.evaluate(() => document.querySelectorAll("[data-tabs] button[class*='tab']").length);
  check("…and pressing it closes that document", nowOpen === wasOpen - 1,
    `${wasOpen} tabs → ${nowOpen}`);
  await two.context.close();

  /* Desktop keeps the quiet strip it always had. */
  const deskTabs = await open({ width: 1400, height: 900 }, false, "desktop+2docs");
  await deskTabs.page.keyboard.press("Control+n");
  await deskTabs.page.waitForTimeout(900);
  await deskTabs.page
    .locator('[role="dialog"] button', { hasText: /^Create$/ })
    .first()
    .click()
    .catch(() => {});
  await deskTabs.page.waitForTimeout(2000);
  const deskStrip = await deskTabs.page.evaluate(() => {
    const el = document.querySelector("[data-tabs]");
    const close = el.querySelector('[role="button"][aria-label^="Close"]');
    return {
      stripH: Math.round(el.getBoundingClientRect().height),
      opacity: getComputedStyle(close).opacity,
    };
  });
  check("…while a mouse still gets the 36px strip and the cross on hover",
    deskStrip.stripH === 36 && deskStrip.opacity === "0",
    `${deskStrip.stripH}px strip, close opacity ${deskStrip.opacity}`);
  await deskTabs.context.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
