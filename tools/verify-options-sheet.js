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

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
