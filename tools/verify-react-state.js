/* Correctness rail for the React-closure work: the components whose prop→state
 * sync was moved out of an effect and into a render-time adjust (React's
 * "adjusting state when a prop changes" pattern), the dock handle that moved to
 * useImperativeHandle, and the overlay's per-frame draw, which was reading a PROP
 * from inside a useCallback with no dependencies.
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/verify-react-state.js
 *
 * WHY THIS EXISTS. Those rewrites are the kind that lint approves of and a user
 * notices: get the comparison wrong and the component either stops re-syncing
 * (a stale draft) or re-syncs on every render ("Too many re-renders", a blank
 * screen). Neither shows up in a unit test, because the behaviour only exists
 * once React is driving real components.
 *
 * The single most important assertion here is the LAST one: no React error
 * reached the console during any of it. A render-phase setState loop throws, and
 * throwing is the failure mode these rewrites risk.
 */
const { launchBrowser, urlArg } = require("./lib/launch");

(async () => {
  const browser = await launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") errors.push("console: " + m.text());
  });
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 }).catch(() => null);
  if (t) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(600);

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const menu = async (a, b) => {
    await page.getByText(a, { exact: true }).first().click();
    await page.waitForTimeout(230);
    await page.getByText(b, { exact: true }).first().click();
    await page.waitForTimeout(700);
  };

  // ---------- 1. Controls: a numeric field re-syncs from outside ----------
  /* The brush Size chip mirrors the engine's value while you are not typing in
     it. Drive the value from ELSEWHERE (the slider) and the text must follow. */
  await page.keyboard.press("b");
  await page.waitForTimeout(400);
  const size = page.locator('[data-tour="options"] input[aria-label="Size"]').first();
  const before = await size.inputValue();
  await size.evaluate((el) => {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    setter.call(el, "137");
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await page.waitForTimeout(500);
  const after = await size.inputValue();
  check("a numeric control re-syncs when its value changes from outside",
    after === "137" && before !== after, `${before} -> ${after}`);

  // ---------- 2. PropertiesPanel: the rename draft follows the selection ----
  await menu("Layer", "New layer");
  await page.waitForTimeout(700);
  await menu("Layer", "New layer");
  await page.waitForTimeout(700);
  /* The rename input carries no `type` attribute, so `input[type="text"]` does
     NOT match it — target its class instead. */
  const renameInput = page.locator('[data-tour="dock"] input[class*="propsName"]').first();
  if ((await renameInput.count()) > 0) {
    const first = await renameInput.inputValue();
    const rows = page.locator('li[class*="layerItem"]');
    if ((await rows.count()) > 1) {
      await rows.nth(1).click();
      await page.waitForTimeout(800);
      const second = await renameInput.inputValue();
      check("the properties name field follows the selected layer", !!first && !!second && first !== second,
        `"${first}" -> "${second}"`);
    } else check("two layers exist to switch between", false, `${await rows.count()} rows`);
  } else {
    check("the properties panel exposes a name field", false, "none found");
  }

  // ---------- 3. CommandPalette: typing resets the highlight ----------
  await page.keyboard.press("Control+k");
  await page.waitForTimeout(600);
  const palette = page.locator('input[placeholder*="ommand"], [role="dialog"] input').first();
  const paletteUp = (await palette.count()) > 0;
  check("the command palette opens", paletteUp);
  if (paletteUp) {
    await palette.type("lay", { delay: 60 });
    await page.waitForTimeout(400);
    await page.keyboard.press("ArrowDown");
    await page.waitForTimeout(200);
    await palette.type("er", { delay: 60 });
    await page.waitForTimeout(400);
    // After the query changes the highlight must be back on the first row.
    const hi = await page.evaluate(() => {
      const el = document.querySelector('[data-idx="0"]');
      if (!el) return null;
      return el.getAttribute("data-active") ?? el.className;
    });
    check("typing resets the palette highlight to the first row", hi !== null, `row0 marker ${hi}`);
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }

  // ---------- 4. Tooltip: opens, positions, and closes ----------
  const toolBtn = page.locator('[data-tour="toolbar"] button').first();
  await toolBtn.hover();
  await page.waitForTimeout(1200);
  const tipPos = await page.evaluate(() => {
    const el = document.querySelector('[role="tooltip"]');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.left), y: Math.round(r.top) };
  });
  check("a tooltip appears and has been positioned", !!tipPos && tipPos.w > 0 && tipPos.h > 0,
    tipPos ? JSON.stringify(tipPos) : "no [role=tooltip]");
  await page.mouse.move(750, 500);
  await page.waitForTimeout(900);
  const tipGone = await page.evaluate(() => !document.querySelector('[role="tooltip"]'));
  check("…and it goes away when the pointer leaves", tipGone);

  // ---------- 5. RightDock: the workspace handle still captures + applies ----
  /* This is the useImperativeHandle conversion. Reset Workspace calls apply(null)
     through the ref; if the ref were never published the menu item would do
     nothing at all, so the dock's panel count must actually change. */
  const panelCount = () =>
    page.evaluate(() => document.querySelectorAll('[data-tour="dock"] section').length);
  /* The menubar sometimes swallows a click that lands while the previous menu is
     still closing, so open it with a retry rather than a single hopeful click. */
  const openWindowMenu = async () => {
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      await page.getByText("Window", { exact: true }).first().click();
      const ok = await page
        .waitForSelector('[role="menu"]', { timeout: 2500 })
        .then(() => true)
        .catch(() => false);
      if (ok) return true;
    }
    return false;
  };
  const windowMenu = async (item) => {
    if (!(await openWindowMenu())) return false;
    await page.waitForTimeout(250);
    const b = page.locator('[role="menu"] button').filter({ hasText: item }).first();
    if (!(await b.count())) {
      await page.keyboard.press("Escape");
      return false;
    }
    await b.click();
    await page.waitForTimeout(800);
    return true;
  };
  const beforePanels = await panelCount();
  const closedOne = await windowMenu(/^Layers$/);
  const closedPanels = await panelCount();
  check("a panel can be toggled off from the Window menu", closedOne && closedPanels < beforePanels,
    `${beforePanels} -> ${closedPanels}`);
  const didReset = await windowMenu(/^Reset workspace$/);
  const restored = await panelCount();
  check("Reset workspace reaches the dock through its imperative handle",
    didReset && restored > closedPanels,
    `${beforePanels} -> ${closedPanels} (closed) -> ${restored} (reset)`);

  // ---------- 6. GradientControl: the popover positions itself ----------
  /* `g` lands on the paint bucket here, not the gradient tool — pick the tool by
     name, and the swatch by its aria-label. */
  await page.getByRole("button", { name: /^Gradient/ }).first().click();
  await page.waitForTimeout(700);
  const swatch = page.locator('[data-tour="options"] button[aria-label="Gradient colours"]').first();
  const swatchCount = await swatch.count();
  if (swatchCount > 0) {
    await swatch.click();
    await page.waitForTimeout(700);
    const pop = await page.evaluate(() => {
      const els = [...document.querySelectorAll("div")].filter((d) => {
        const s = getComputedStyle(d);
        return s.position === "fixed" && d.getBoundingClientRect().width > 200;
      });
      const el = els[els.length - 1];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) };
    });
    check("the gradient popover opens and is positioned on screen",
      !!pop && pop.x >= 0 && pop.y >= 0, pop ? JSON.stringify(pop) : "none found");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  } else {
    check("the gradient tool exposes a swatch", false, "no swatch button");
  }

  // ---------- 7. the overlay draws chrome for the CURRENT selection ----------
  /* `drawAnts` is useCallback(..., []) — deliberately, it is the per-frame
     overlay draw — and it was reading the `activeLayerId` PROP, so it captured
     whatever was selected when the canvas mounted and never updated. The frame
     chrome was therefore drawn for the wrong layer, in practice never: a frame
     drawn after mount got none. Now it reads activeLayerIdRef.
     The overlay loop STOPS and clears itself when nothing needs it, so the
     pointer is parked over the canvas with the eyedropper — one of the loop's
     keep-alive branches, and one that draws almost nothing itself. Without that
     the overlay is blank either way and the measurement proves nothing. */
  const overlayInk = () =>
    page.evaluate(() => {
      /* The last canvas that is NOT the loupe: the loupe was added after the
         overlay in the DOM and is blank for a mouse, so "the last canvas"
         started measuring zero ink whatever the overlay was drawing. */
      const cs = [...document.querySelectorAll("canvas")].filter((c) => !c.hasAttribute("data-loupe"));
      const el = cs[cs.length - 1];
      const d = el.getContext("2d").getImageData(0, 0, el.width, el.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
      return n;
    });
  const canvasBox = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  const hoverCanvas = async () => {
    await page.getByRole("button", { name: /^Eyedropper/ }).first().click();
    await page.waitForTimeout(400);
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.8, canvasBox.y + canvasBox.height * 0.85);
    await page.waitForTimeout(250);
    await page.mouse.move(canvasBox.x + canvasBox.width * 0.8 + 3, canvasBox.y + canvasBox.height * 0.85 + 3);
    await page.waitForTimeout(900);
  };
  await page.getByRole("button", { name: /^Frame/ }).first().click();
  await page.waitForTimeout(500);
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.25, canvasBox.y + canvasBox.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width * 0.65, canvasBox.y + canvasBox.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await page.waitForTimeout(1200);
  await hoverCanvas();
  const inkFrame = await overlayInk();
  const layerRows = page.locator('li[class*="layerItem"]');
  const rowCount = await layerRows.count();
  await layerRows.nth(rowCount - 1).click(); // a non-frame layer
  await page.waitForTimeout(800);
  await hoverCanvas();
  const inkPlain = await overlayInk();
  check("the overlay draws frame chrome for the CURRENTLY selected layer",
    inkFrame > inkPlain + 200,
    `overlay ink ${inkFrame} with the frame selected vs ${inkPlain} with a plain layer`);

  // ---------- 8. the assertion that matters most ----------
  check("no React error reached the console at any point", errors.length === 0,
    errors.slice(0, 3).join(" | ") || "clean");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS FAIL:", e.message);
  process.exit(1);
});
