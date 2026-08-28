/* Tool options a phone can reach.
 *
 * Measured at 390px before this: every one of the 29 tools overflowed the
 * options bar. Once the modifier chips and the tool badge had taken their
 * share, the controls row was 25–127px wide and held up to 1982px of widgets —
 * scrolling a hundred-pixel window across two metres of controls. With Crop
 * active, Apply sat 1400px off the right, which made the only way to commit a
 * crop unreachable by any gesture.
 *
 * The controls now live in a sheet. The bar keeps three things: the modifier
 * chips, the way in, and any action that would lose work if it were buried.
 *
 * Two failure modes this harness is built around:
 *
 *   - the bar stops overflowing but the SHEET overflows instead, which is the
 *     same bug one layer down. It caught exactly that: the bar's slider variant
 *     is a single row with a 104px track, and in the sheet's column it ran 82px
 *     past the edge. Both containers are measured, for every tool.
 *   - the controls become decorative. A sheet that lays out beautifully and
 *     does not drive anything would pass every geometric check here, so a
 *     slider is dragged and its value read back, and the pinned Apply is used
 *     to commit a real crop.
 *
 * Run: node tools/verify-options-sheet.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

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
    await page.waitForTimeout(1000);
    await dismissStartCard(page);
    await page.keyboard.press("Control+Shift+N"); // a layer, so tools have something to act on
    await page.waitForTimeout(1200);
    return { context, page };
  };

  // ==================================================================== phone
  const phone = await open({ width: 390, height: 844 }, true, "phone");
  const page = phone.page;

  const tools = await page.evaluate(() =>
    [...document.querySelectorAll('[data-tour="toolbar"] button[data-tool]')].map((b) => ({
      id: b.getAttribute("data-tool"),
      name: b.getAttribute("aria-label"),
    })),
  );
  check("all 29 tools are there to check", tools.length === 29, `${tools.length} tools`);

  const pickTool = async (id) => {
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().click();
    await page.waitForTimeout(450);
    await page.locator(`[data-tour="toolbar"] button[data-tool="${id}"]`).click();
    await page.waitForTimeout(550);
  };
  const barFit = () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-tour="options"] [class*="controls"]');
      if (!c) return null;
      return { scroll: c.scrollWidth, client: c.clientWidth };
    });
  const sheetFit = () =>
    page.evaluate(() => {
      const b = document.querySelector('[class*="sheetBody"]');
      if (!b) return null;
      return { scroll: b.scrollWidth, client: b.clientWidth, controls: b.querySelectorAll("button, input, select, [role='switch']").length };
    });

  const barOver = [];
  const sheetOver = [];
  const empty = [];
  for (const t of tools) {
    await pickTool(t.id);
    const bar = await barFit();
    if (!bar || bar.scroll > bar.client + 1) barOver.push(`${t.name} (${bar?.scroll}/${bar?.client})`);
    await page.locator("[data-options-open]").click();
    await page.waitForTimeout(500);
    const sheet = await sheetFit();
    if (!sheet) empty.push(t.name);
    else if (sheet.scroll > sheet.client + 1) sheetOver.push(`${t.name} (${sheet.scroll}/${sheet.client})`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(300);
  }
  check("no tool overflows the options bar",
    barOver.length === 0, barOver.length ? barOver.slice(0, 4).join(", ") : "all 29 fit");
  check("…and none overflows the sheet either, which is the same bug one layer down",
    sheetOver.length === 0, sheetOver.length ? sheetOver.slice(0, 4).join(", ") : "all 29 fit");
  check("every tool's options actually open", empty.length === 0,
    empty.length ? `no sheet for: ${empty.join(", ")}` : "29 sheets opened");

  // ------------------------------------------------- the item's crop check --
  await pickTool("crop");
  const crop = await page.evaluate(() => {
    const c = document.querySelector('[data-tour="options"] [class*="controls"]');
    const apply = document.querySelector('[data-pin="commit"]');
    const r = apply?.getBoundingClientRect();
    return {
      scrollLeft: c.scrollLeft,
      scroll: c.scrollWidth,
      client: c.clientWidth,
      apply: r && { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width) },
      vw: window.innerWidth,
    };
  });
  check("with Crop active the controls row needs no scrolling at all",
    crop.scroll <= crop.client + 1 && crop.scrollLeft === 0,
    `${crop.scroll}px in ${crop.client}px, scrollLeft ${crop.scrollLeft}`);
  check("…and Apply is pinned to the bar, fully inside the viewport",
    !!crop.apply && crop.apply.left >= 0 && crop.apply.right <= crop.vw,
    crop.apply ? `Apply spans ${crop.apply.left}–${crop.apply.right} of ${crop.vw}` : "no pinned Apply");
  check("…at a size a finger can hit", !!crop.apply && crop.apply.w >= 44, `${crop.apply?.w}px wide`);

  /* Pinned is not the same as working. */
  const beforeCrop = await page.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    return `${c.width}×${c.height}`;
  });
  /* Selecting Crop lays a box over the WHOLE document, so a drag inside it
     MOVES it (clamped back to the canvas) rather than shrinking it — applying
     that changes nothing, which is how this check first read as a broken
     Apply. The corner is what resizes it. */
  const box = await page.evaluate(() => {
    const ov = [...document.querySelectorAll('[data-tour="canvas"] canvas')]
      .filter((c) => !c.hasAttribute("data-loupe"))
      .pop();
    const g = ov.getContext("2d", { willReadFrequently: true });
    const d = g.getImageData(0, 0, ov.width, ov.height).data;
    let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
    for (let y = 0; y < ov.height; y++)
      for (let x = 0; x < ov.width; x++) {
        if (d[(y * ov.width + x) * 4 + 3] > 100) continue;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    const r = ov.getBoundingClientRect();
    return x1 < 0 ? null : { x: r.left + x0, y: r.top + y0 };
  });
  check("a crop box is on screen to shrink", !!box);
  await page.mouse.move(box.x, box.y);
  await page.mouse.down();
  for (let i = 1; i <= 6; i++) await page.mouse.move(box.x + i * 6, box.y + i * 5);
  await page.mouse.up();
  await page.waitForTimeout(700);
  await page.locator('[data-pin="commit"]').click();
  await page.waitForTimeout(1400);
  const afterCrop = await page.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    return `${c.width}×${c.height}`;
  });
  check("the pinned Apply really commits the crop", afterCrop !== beforeCrop,
    `document ${beforeCrop} → ${afterCrop}`);
  await page.keyboard.press("Control+z");
  await page.waitForTimeout(1000);

  // ------------------------------------------- a control in the sheet works --
  await pickTool("brush");
  await page.locator("[data-options-open]").click();
  await page.waitForTimeout(600);
  const slider = await page.evaluate(() => {
    const el = [...document.querySelectorAll('[class*="sheetBody"] input[type="range"]')].find(
      (i) => (i.getAttribute("aria-label") || "") === "Size",
    );
    if (!el) return null;
    el.setAttribute("data-probe", "1");
    const r = el.getBoundingClientRect();
    return { value: el.value, x: Math.round(r.left + r.width * 0.5), y: Math.round(r.top + r.height / 2), w: Math.round(r.width) };
  });
  check("the brush's Size slider is in the sheet, full width",
    !!slider && slider.w > 200, slider ? `${slider.w}px wide, value ${slider.value}` : "not found");
  await page.mouse.move(slider.x, slider.y);
  await page.mouse.down();
  await page.mouse.move(slider.x + 60, slider.y);
  await page.mouse.up();
  await page.waitForTimeout(500);
  const after = await page.evaluate(
    () => document.querySelector('[data-probe="1"]')?.value ?? "",
  );
  check("…and dragging it changes the brush size", after !== slider.value,
    `${slider.value} → ${after}`);

  // --------------------------------------------------- opening and closing --
  const sheetShown = () => page.evaluate(() => !!document.querySelector("[data-options-sheet]"));
  check("the sheet is open", await sheetShown());
  await page.locator("[data-options-open]").click();
  await page.waitForTimeout(500);
  check("the toggle closes it again", !(await sheetShown()));
  await page.locator("[data-options-open]").click();
  await page.waitForTimeout(500);
  await page.evaluate(() => window.history.back()); // the phone's back gesture
  await page.waitForTimeout(700);
  check("back closes it before it closes anything else", !(await sheetShown()));
  await page.locator("[data-options-open]").click();
  await page.waitForTimeout(500);
  await pickTool("eraser");
  check("changing tool closes it, since the options are a different set now",
    !(await sheetShown()));
  await phone.context.close();

  // ================================================================== desktop
  const desk = await open({ width: 1400, height: 900 }, false, "desktop");
  const rail = await desk.page.evaluate(() => {
    const bar = document.querySelector('[data-tour="options"]');
    const c = bar.querySelector('[class*="controls"]');
    return {
      mobileBar: bar.hasAttribute("data-mobile-options"),
      toggle: !!document.querySelector("[data-options-open]"),
      sheet: !!document.querySelector("[data-options-sheet]"),
      badge: !!bar.querySelector('[class*="toolBadge"]'),
      controls: c.querySelectorAll("button, input, select, [role='switch']").length,
    };
  });
  check("desktop keeps the bar it always had",
    !rail.mobileBar && !rail.toggle && !rail.sheet,
    `mobile bar: ${rail.mobileBar}, toggle: ${rail.toggle}, sheet: ${rail.sheet}`);
  check("…with its tool badge and its controls inline",
    rail.badge && rail.controls > 3, `badge: ${rail.badge}, ${rail.controls} controls in the row`);
  await desk.context.close();

  // ================== the toggle names the tool it will open the options for ==
  /* It used to read "Options" while a chip on the BOTTOM bar named the tool —
     218px of a 390px bar to say one word. The name moved onto the control that
     opens that tool's settings, where it labels the button instead of standing
     on its own. So the button has to track the tool, and it has to keep an
     accessible name that still says what pressing it does. */
  const named = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const np = await named.newPage();
  np.on("pageerror", (e) => errors.push("pageerror(named): " + String(e)));
  np.on("console", (m) => m.type() === "error" && errors.push("console(named): " + m.text()));
  await np.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await np.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const nt = await np
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
    .catch(() => null);
  if (nt) {
    await np.keyboard.press("Escape");
    await np.waitForTimeout(700);
  }
  await dismissStartCard(np);
  await np.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await np.waitForTimeout(800);

  const READ = () => {
    const row = document.querySelector("[data-mobile-options]");
    const tg = document.querySelector("[data-options-open]");
    if (!row || !tg) return null;
    const rr = row.getBoundingClientRect();
    const tr = tg.getBoundingClientRect();
    const name = tg.querySelector("span");
    return {
      text: tg.textContent.trim(),
      label: tg.getAttribute("aria-label") || "",
      w: Math.round(tr.width),
      h: Math.round(tr.height),
      clipped: tr.right > rr.right + 0.5 || tr.left < rr.left - 0.5,
      ellipsised: name ? name.scrollWidth > name.clientWidth + 1 : false,
      rowOverflow: row.scrollWidth - row.clientWidth,
    };
  };

  await np.keyboard.press("b");
  await np.waitForTimeout(700);
  const brush = await np.evaluate(READ);
  check("the options button is named for the tool in hand", brush && brush.text === "Brush",
    brush ? `reads "${brush.text}"` : "no toggle");
  check("…and still says what it opens, for a screen reader",
    !!brush && /options/i.test(brush.label), `aria-label "${brush?.label}"`);

  await np.keyboard.press("m");
  await np.waitForTimeout(700);
  const marquee = await np.evaluate(READ);
  check("…and follows the tool when it changes",
    marquee && marquee.text !== brush.text && marquee.text.length > 0,
    `"${brush?.text}" → "${marquee?.text}"`);

  /* The longest name in the app, on the narrowest phone worth supporting. The
     name gives way; nothing else on the row does. */
  await np.setViewportSize({ width: 320, height: 568 });
  await np.waitForTimeout(700);
  const tight = await np.evaluate(READ);
  check("the longest tool name shrinks rather than pushing the row off-screen",
    tight && !tight.clipped && tight.rowOverflow <= 0,
    `${tight?.w}px wide, row overflow ${tight?.rowOverflow}, ellipsised: ${tight?.ellipsised}`);
  check("…and it is still a 44px target with the name cut down",
    tight && tight.h >= 44, `${tight?.h}px tall`);

  /* Behaviour unchanged: it is still the button that opens the sheet. */
  await np.locator("[data-options-open]").click();
  await np.waitForTimeout(600);
  check("…and it still opens the options sheet",
    await np.evaluate(() => !!document.querySelector("[data-options-sheet]")),
    "pressing the named button opens the sheet");
  await named.close();

  // ================================ the sheet is a column, laid out like one ==
  /* The controls in here were written for a horizontal bar, and the first pass
     at a sheet only changed the direction. What was left behind measured badly:
     dividers still standing up at 1×22px, 44px icon buttons each claiming a
     whole line, and every labelled control sizing its own label to its own word
     so nothing lined up with anything. */
  const LAYOUT = () => {
    const sh = document.querySelector("[data-options-sheet]");
    if (!sh) return null;
    const body = sh.children[1];
    const br = body.getBoundingClientRect();
    const kids = [...body.children];
    const at = (e) => Math.round(e.getBoundingClientRect().y);
    const dividers = kids
      .filter((c) => /divider/.test(c.className))
      .map((c) => {
        const r = c.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height) };
      });
    /* Where the control beside each label begins. One column = one number. */
    const starts = kids
      .map((c) => {
        const lbl = c.querySelector(":scope > [class*='label']");
        const next = lbl && lbl.nextElementSibling;
        return next ? Math.round(next.getBoundingClientRect().x) : null;
      })
      .filter((x) => x !== null && x > 0);
    const trackStarts = [...body.querySelectorAll("input[type=range]")].map((e) =>
      Math.round(e.getBoundingClientRect().x),
    );
    return {
      height: Math.round(body.scrollHeight),
      children: kids.length,
      rows: new Set(kids.map(at)).size,
      dividers,
      columns: [...new Set([...starts, ...trackStarts])],
      overflowX: body.scrollWidth - body.clientWidth,
      clipped: [...body.querySelectorAll("*")].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 0 && r.right > br.right + 1;
      }).length,
    };
  };

  const layout = await open({ width: 390, height: 844 }, true, "phone+layout");
  const layoutPage = layout.page;
  await layoutPage.keyboard.press("b");
  await layoutPage.waitForTimeout(700);
  await layoutPage.locator("[data-options-open]").click();
  await layoutPage.waitForTimeout(800);
  const brushLayout = await layoutPage.evaluate(LAYOUT);

  check("the dividers lie down instead of standing up",
    brushLayout && brushLayout.dividers.length > 0 &&
      brushLayout.dividers.every((d) => d.h <= 2 && d.w > 100),
    brushLayout ? brushLayout.dividers.map((d) => `${d.w}x${d.h}`).join(", ") : "no sheet");

  check("…and the small square buttons share a row rather than taking one each",
    brushLayout && brushLayout.rows < brushLayout.children,
    `${brushLayout?.children} controls in ${brushLayout?.rows} rows`);

  /* The whole point of a shared column: one x for every control on the sheet. */
  check("…every labelled control starts on the same column",
    brushLayout && brushLayout.columns.length === 1,
    `controls begin at x = ${brushLayout?.columns.join(", ")}`);

  check("…and nothing runs off the side of it",
    brushLayout && brushLayout.overflowX <= 0 && brushLayout.clipped === 0,
    `overflow ${brushLayout?.overflowX}px, ${brushLayout?.clipped} clipped`);

  /* A slider is the height of its track, not its track plus a line of label.
     The track keeps the 44px touch floor either way. */
  const sliders = await layoutPage.evaluate(() =>
    [...document.querySelectorAll("[data-options-sheet] [class*='slider']")]
      .filter((e) => e.querySelector("input[type=range]"))
      .map((e) => Math.round(e.getBoundingClientRect().height)),
  );
  check("…a slider costs one row, not two",
    sliders.length > 0 && sliders.every((h) => h <= 52),
    `slider rows: ${[...new Set(sliders)].join(", ")}px`);
  const trackH = await layoutPage.evaluate(() =>
    [...new Set(
      [...document.querySelectorAll("[data-options-sheet] input[type=range]")].map((e) =>
        Math.round(e.getBoundingClientRect().height),
      ),
    )],
  );
  check("…without giving up the 44px the finger needs",
    trackH.length > 0 && trackH.every((h) => h >= 44), `track heights: ${trackH.join(", ")}px`);

  // ============== the row itself: identity first, modifiers at the end =======
  /* MEASURED BEFORE this layout: Shift/Alt/Ctrl held x12–152 of a 390px row —
     38% of it — for every tool, then a 24px dead gap, then the tool button, and
     then a right margin that ran from 40px on the marquee to 146px on Text. The
     row opened on three keys borrowed from a keyboard the device does not have,
     and what shrank when space ran out was always the tool: at 320px the
     marquee's name was clipped 174→128px and Crop's vanished altogether.

     Asserted across several tools rather than one, because the whole point is
     that the two ends stay anchored whatever the tool is called. */
  await layoutPage.keyboard.press("Escape").catch(() => {});
  await layoutPage.waitForTimeout(500);
  const ROW = () => {
    const bar = document.querySelector("[data-mobile-options]");
    const br = bar.getBoundingClientRect();
    const toggle = bar.querySelector("[data-options-open]");
    const chips = [...bar.querySelectorAll("button[data-mode]")].map((c) =>
      c.getBoundingClientRect(),
    );
    if (!toggle || chips.length !== 3) return null;
    const t = toggle.getBoundingClientRect();
    const pad = parseFloat(getComputedStyle(bar).paddingRight);
    return {
      toolLeft: Math.round(t.left),
      toolRight: Math.round(t.right),
      chipsLeft: Math.round(chips[0].left),
      rightGap: Math.round(br.right - chips[2].right),
      pad: Math.round(pad),
      /* Gaps BETWEEN the chips: a segmented group has none. */
      seams: [
        Math.round(chips[1].left - chips[0].right),
        Math.round(chips[2].left - chips[1].right),
      ],
      minChip: Math.round(Math.min(...chips.map((c) => Math.min(c.width, c.height)))),
    };
  };
  const rows = [];
  for (const [name, key] of [["brush", "b"], ["marquee", "m"], ["crop", "c"], ["text", "t"]]) {
    await layoutPage.keyboard.press(key);
    await layoutPage.waitForTimeout(650);
    rows.push([name, await layoutPage.evaluate(ROW)]);
  }
  check("the tool and its options come before the modifier chips, on every tool",
    rows.every(([, r]) => r && r.toolRight <= r.chipsLeft),
    rows.map(([n, r]) => `${n} tool ends ${r?.toolRight}, chips start ${r?.chipsLeft}`).join("; "));
  check("…and the chips sit against the right edge whatever the tool is called",
    rows.every(([, r]) => r && r.rightGap === r.pad),
    `right gap ${[...new Set(rows.map(([, r]) => r?.rightGap))].join("/")}px against the bar's own ` +
      `${rows[0][1]?.pad}px padding — it used to run from 40px to 146px`);
  check("…the three chips read as one segmented control, not three loose keys",
    rows.every(([, r]) => r && r.seams.every((g) => g <= 0)),
    `seams between chips: ${rows[0][1]?.seams.join(" and ")}px`);
  check("…and each is still a 44px target",
    rows.every(([, r]) => r && r.minChip >= 44),
    `smallest chip side ${Math.min(...rows.map(([, r]) => r?.minChip ?? 0))}px`);

  await layout.context.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
