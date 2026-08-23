/* Shift / Alt / Ctrl on a device that has none.
 *
 * Roughly thirty canvas behaviours are gated on a held modifier, across 83 call
 * sites, and a finger could reach none of them. Rather than thirty bespoke
 * gestures, the modifier is latched by a chip and injected into the event
 * before anything reads it — so every one of those sites keeps the `e.altKey`
 * test it already had.
 *
 * That injection is the load-bearing claim, and it is checked through REAL
 * behaviour rather than by reading a flag back: with Alt armed the Zoom tool
 * zooms out instead of in, and a marquee dragged across a selection subtracts
 * from it instead of replacing it. A flag that is set but that nothing acts on
 * would pass a weaker check and mean nothing.
 *
 * Run: node tools/verify-modifiers.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, openPanel, setSheetDetent, urlArg } = require("./lib/launch");

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
    // A fresh phone opens on the launch card, which covers the canvas this
    // harness taps. A user chooses to start blank; so does this.
    await dismissStartCard(page);
    return { context, page };
  };

  // ---------- 1. desktop keeps its keyboard, and its bar ----------
  {
    const { context, page } = await open({ width: 1400, height: 900 }, false);
    const visible = await page
      .locator('[role="group"][aria-label="Keyboard modifiers"]')
      .isVisible()
      .catch(() => false);
    check("the chips stay out of the way where there is a keyboard", visible === false,
      `chips visible on desktop: ${visible}`);
    await context.close();
  }

  const { context, page } = await open({ width: 390, height: 844 }, true);
  const chip = (name) => page.locator(`[aria-label="Keyboard modifiers"] button`, { hasText: new RegExp(`^${name}`) }).first();
  const mode = (name) => chip(name).getAttribute("data-mode");
  const zoom = () =>
    page.evaluate(() => {
      const el = [...document.querySelectorAll('[data-tour="canvas"] span')].find((s) =>
        /^\d+%$/.test(s.textContent.trim()),
      );
      return el ? parseInt(el.textContent, 10) : null;
    });

  check("the chips are there when there is no keyboard",
    await chip("Shift").isVisible(), "Shift / Alt / Ctrl in the options bar");

  // ---------- 2. the three states ----------
  check("a chip starts off", (await mode("Alt")) === "off", `data-mode="${await mode("Alt")}"`);
  await chip("Alt").click();
  check("one tap arms it", (await mode("Alt")) === "armed", `data-mode="${await mode("Alt")}"`);
  await chip("Alt").click();
  check("a second tap locks it", (await mode("Alt")) === "locked", `data-mode="${await mode("Alt")}"`);
  await chip("Alt").click();
  check("a third turns it off", (await mode("Alt")) === "off", `data-mode="${await mode("Alt")}"`);

  // ---------- 3. it reaches a real behaviour ----------
  await page.keyboard.press("z"); // zoom tool
  await page.waitForTimeout(400);
  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const cx = Math.round(box.x + box.width / 2);
  const cy = Math.round(box.y + box.height / 2);

  const z0 = await zoom();
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(500);
  const z1 = await zoom();
  check("without a modifier the zoom tool zooms in", z1 > z0, `${z0}% → ${z1}%`);

  await chip("Alt").click(); // armed
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(500);
  const z2 = await zoom();
  check("with Alt armed the same tap zooms OUT", z2 < z1, `${z1}% → ${z2}%`);

  // ---------- 4. one-shot, and locked ----------
  check("…and the arming was spent by that gesture", (await mode("Alt")) === "off",
    `data-mode="${await mode("Alt")}"`);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(500);
  const z3 = await zoom();
  check("…so the next tap zooms in again", z3 > z2, `${z2}% → ${z3}%`);

  /* Climb away from the floor first: the zoom clamps at its minimum, and two
     steps out from near it look identical whether or not the lock held. */
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(cx, cy);
    await page.waitForTimeout(350);
  }
  const zHigh = await zoom();
  await chip("Alt").click();
  await chip("Alt").click(); // locked
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(500);
  const z4 = await zoom();
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(500);
  const z5 = await zoom();
  check("a locked modifier survives more than one gesture",
    z4 < zHigh && z5 < z4 && (await mode("Alt")) === "locked",
    `${zHigh}% → ${z4}% → ${z5}%, still ${await mode("Alt")}`);
  await chip("Alt").click(); // off

  // ---------- 5. it does NOT leak outside the canvas ----------
  /* A latched Alt has no business changing what a tap on a panel or a button
     does. Recorded from a listener on the bottom bar, which is not the canvas. */
  await chip("Alt").click();
  const leaked = await page.evaluate(async () => {
    const bar = document.querySelector('[data-tour="mobilebar"] button');
    return await new Promise((resolve) => {
      const seen = (e) => {
        bar.removeEventListener("pointerdown", seen, true);
        resolve(e.altKey);
      };
      bar.addEventListener("pointerdown", seen, true);
      const r = bar.getBoundingClientRect();
      bar.dispatchEvent(
        new PointerEvent("pointerdown", {
          bubbles: true,
          clientX: Math.round(r.left + r.width / 2),
          clientY: Math.round(r.top + r.height / 2),
        }),
      );
    });
  });
  check("an armed modifier does not leak onto the rest of the interface", leaked === false,
    `altKey seen on a bottom-bar tap: ${leaked}`);

  /* Put it back to off before moving on. The leak test armed Alt and nothing
     spent it — a synthetic tap on the bottom bar is not a canvas gesture — so
     the first marquee below subtracted from an empty selection and made none,
     which read as "the marquee is broken" rather than "the rail left a latch
     on". */
  const disarm = async (name) => {
    for (let i = 0; i < 3 && (await mode(name)) !== "off"; i++) {
      await chip(name).click();
      await page.waitForTimeout(150);
    }
  };
  await disarm("Alt");
  check("the latch can be put back to off", (await mode("Alt")) === "off",
    `data-mode="${await mode("Alt")}"`);

  // ---------- 6. the item's own example: subtract from a selection ----------
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("m"); // rectangular marquee
  await page.waitForTimeout(400);
  const drag = async (x1, y1, x2, y2) => {
    await page.mouse.move(x1, y1);
    await page.mouse.down();
    await page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, { steps: 4 });
    await page.mouse.move(x2, y2, { steps: 4 });
    await page.mouse.up();
    await page.waitForTimeout(700);
  };
  /** The Info panel's Selection row, read from inside the panels drawer. */
  const selectionSize = async () => {
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
    await page.waitForTimeout(700);
    /* The Info panel ships collapsed, so its rows are not in the DOM at all
       until it is opened — the first version of this read an empty string and
       looked like a missing selection. */
    const expand = page.locator('[data-tour="dock"] button[aria-label="Expand Info"]');
    if (await expand.count()) {
      await expand.first().click();
      await page.waitForTimeout(500);
    }
    /* The PIXEL COUNT, not the bounds. Bounds cannot tell a subtract from a
       replace — dragging across the top half of a square leaves a remainder the
       same size as the rectangle just dragged, so both readings are identical.
       A mutation that disabled the injection entirely still passed that version
       of this check. The count separates them: subtracting removes area, and
       replacing sets it to the new rectangle's. */
    const text = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('[data-tour="dock"] *')];
      const label = rows.find((el) => el.children.length === 0 && el.textContent?.trim() === "Pixels");
      const value = label?.parentElement?.textContent?.replace(/[^0-9]/g, "") ?? "";
      return value ? parseInt(value, 10) : 0;
    });
    await page.evaluate(() => window.history.back());
    await page.waitForTimeout(700);
    return text;
  };

  await drag(cx - 90, cy - 90, cx + 90, cy + 90);
  const whole = await selectionSize();
  check("a marquee makes a selection", whole > 0, `${whole} px selected`);

  /* The top-LEFT quadrant. Subtracting it leaves an L of three quarters;
     replacing with it leaves one quarter. Two clearly different numbers. */
  await chip("Alt").click(); // armed: this drag should SUBTRACT
  await drag(cx - 90, cy - 90, cx, cy);
  const cut = await selectionSize();
  const quarter = whole / 4;
  check("with Alt armed, dragging across it subtracts instead of replacing",
    cut > whole * 0.6 && cut < whole * 0.9,
    `${whole} px → ${cut} px (three quarters would be ~${Math.round(whole * 0.75)}, ` +
      `a replace would be ~${Math.round(quarter)})`);

  // ---------- 7. the same chips, on the PANELS ----------
  /* Five behaviours live only behind a modifier in the panels — clip a layer to
     the one below, disable a mask, view a mask on the canvas, combine a channel
     into the selection, delete a swatch. The chips reach those too: the panels
     are the document's structure, as much the user's work as the pixels. */
  const openDrawer = async () => {
    if ((await page.evaluate(() => document.documentElement.dataset.drawer ?? "")) !== "panels")
      await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().click();
    await page.waitForTimeout(700);
  };
  const closeDrawer = async () => {
    if ((await page.evaluate(() => document.documentElement.dataset.drawer ?? "")) === "panels") {
      await page.evaluate(() => window.history.back());
      await page.waitForTimeout(700);
    }
  };

  await closeDrawer();
  /* TWO layers: the document starts with none at all ("No layers yet"), and
     clipping needs something underneath to clip to. */
  for (let i = 0; i < 2; i++) {
    await page.keyboard.press("Control+Shift+N");
    await page.waitForTimeout(1200);
  }
  await openDrawer();

  /* The enabling fix: with a drawer open the scrim covered the options bar, so
     the chips were unreachable at exactly the moment the panel behaviours they
     exist for were on screen. */
  const chipReachable = await page.evaluate(() => {
    const chip = document.querySelector('[aria-label="Keyboard modifiers"] button');
    if (!chip) return false;
    const r = chip.getBoundingClientRect();
    const hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
    return !!hit && (hit === chip || chip.contains(hit));
  });
  check("the chips are still reachable with a panel drawer open", chipReachable,
    chipReachable ? "the tap lands on the chip" : "something is covering them");

  /* A clip group underlines the base layer's name. Verified as the observable
     directly — the `title="Clip-group base"` on the same element did not show
     up in a query, and an indicator that cannot be read is not one. */
  const clipBases = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('[data-tour="dock"] [class*="layerName"]')].filter(
          (e) => e.style.textDecoration === "underline",
        ).length,
    );
  /* The sheet is an accordion and starts with everything shut, so the Layers
     rows are not in the DOM until it is asked for. */
  await setSheetDetent(page, "full");
  await openPanel(page, "layers");
  const layerRows = page.locator('[data-tour="dock"] [class*="layerItem"]');
  const rowCount = await layerRows.count();
  check("there are two layers to clip together", rowCount >= 2, `${rowCount} layer row(s)`);
  check("nothing is clipped to start with", (await clipBases()) === 0, `${await clipBases()} clip base(s)`);

  await chip("Alt").click(); // armed
  await layerRows.first().click();
  await page.waitForTimeout(900);
  check("Alt-tapping a layer row clips it to the one below", (await clipBases()) > 0,
    `${await clipBases()} clip base(s) after the tap`);

  // A mask to disable — added from the menu, which needs the drawer out of the way.
  await closeDrawer();
  await page.locator('button[aria-label="Menu"]').first().click();
  await page.waitForTimeout(800);
  check("the menu sheet opens for the mask setup",
    (await page.locator('[data-menubar][data-sheet="true"]').count()) === 1,
    `drawer is "${await page.evaluate(() => document.documentElement.dataset.drawer ?? "")}"`);
  /* Scoped to the sheet: "Layer" also appears as a layer's own type label in
     the panel behind it, and a loose match picks whichever comes first. */
  const sheet = page.locator('[data-menubar][data-sheet="true"]');
  await sheet.locator("button", { hasText: /^Layer$/ }).first().click();
  await page.waitForTimeout(500);
  const menuItems = await sheet.locator('[role="menu"] button').count();
  const addMask = sheet.locator('[role="menu"] button', { hasText: /Add layer mask/ }).first();
  const hasMaskItem = (await addMask.count()) > 0;
  check("the Layer menu lists its mask commands", hasMaskItem,
    `${menuItems} item(s) under Layer, "Add layer mask" found: ${hasMaskItem}`);
  if (hasMaskItem) {
    await addMask.click();
    await page.waitForTimeout(1500);
  }
  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  await openDrawer();

  /* `data-tip`, not `title`: a MutationObserver in Tooltip.tsx permanently
     relocates every title attribute so the app can draw its own tooltip. The
     first version of this looked for `title` and concluded the mask had never
     been added, when it was there all along. */
  const maskThumb = page.locator('[data-tour="dock"] [data-tip*="Layer mask"]').first();
  const maskFound = (await maskThumb.count()) > 0;
  check("a layer mask can be added and appears in the panel", maskFound && hasMaskItem,
    maskFound ? "the mask thumbnail is there" : "no mask thumbnail found");
  if (maskFound) {
    const titleBefore = (await maskThumb.getAttribute("data-tip")) ?? "";
    await chip("Shift").click(); // armed
    await maskThumb.click();
    await page.waitForTimeout(900);
    const titleAfter =
      (await page
        .locator('[data-tour="dock"] [data-tip*="Layer mask"]')
        .first()
        .getAttribute("data-tip")) ?? "";
    check("Shift-tapping the mask disables it",
      !/disabled/i.test(titleBefore) && /disabled/i.test(titleAfter),
      `"${titleBefore.slice(0, 34)}…" → "${titleAfter.slice(0, 40)}…"`);
  } else {
    check("Shift-tapping the mask disables it", false, "no mask to tap");
  }

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
