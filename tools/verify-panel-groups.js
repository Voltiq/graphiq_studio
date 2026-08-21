/* Correctness rail for TABBED PANEL GROUPS.
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/verify-panel-groups.js
 *
 * A group is several panels sharing one frame, drawn as a tab strip. It is a
 * membership map (`groups`: panel -> group key) layered over the dock's single
 * `order`, so everything else — reordering, left/right docks, the Window menu,
 * workspaces — keeps working untouched. The things that can go wrong are all
 * about that layering, so this drives the whole lifecycle rather than checking
 * that a strip appears:
 *
 *   join -> the two frames become one, with both tabs
 *   switch -> the body follows the tab
 *   hide a member from the Window menu -> the group survives, minus that tab
 *   hide the rest -> the frame degrades to a plain panel, not a one-tab group
 *   reload -> the grouping persists
 *   Reset workspace -> the grouping is gone
 *   drag a tab out -> back to two panels
 *
 * HTML5 drag and drop cannot be driven with mouse events, so the drag is
 * dispatched directly. The phases are spaced a frame apart on purpose: fired
 * back to back, the dock's handlers still read `dragId === null`, because React
 * has not committed the dragstart's setState yet. That is an artefact of driving
 * it synthetically, not something a real drag can hit.
 */
const { launchBrowser, urlArg } = require("./lib/launch");

const DND = () => {
  window.__dnd = async (fromSel, toSel) => {
    const from = document.querySelector(fromSel);
    const to = document.querySelector(toSel);
    if (!from || !to) return `missing ${!from ? fromSel : toSel}`;
    const dt = new DataTransfer();
    const fire = (el, type) => {
      const r = el.getBoundingClientRect();
      el.dispatchEvent(
        new DragEvent(type, {
          bubbles: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: r.left + r.width / 2,
          clientY: r.top + r.height / 2,
        }),
      );
    };
    const tick = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 30)));
    fire(from, "dragstart");
    await tick();
    fire(to, "dragover");
    await tick();
    fire(to, "dragover");
    await tick();
    fire(to, "drop");
    fire(from, "dragend");
    await tick();
    return "ok";
  };
};

(async () => {
  const browser = await launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.addInitScript(DND);
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const boot = async () => {
    await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
    const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 }).catch(() => null);
    if (t) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(700);
    }
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
    await page.waitForTimeout(900);
  };
  const state = () =>
    page.evaluate(() => ({
      sections: document.querySelectorAll('[data-tour="dock"] section').length,
      grouped: document.querySelectorAll('[data-tour="dock"] section[data-grouped]').length,
      tabs: [...document.querySelectorAll('[data-tour="dock"] [role="tablist"]')].map((tl) =>
        [...tl.querySelectorAll('[role="tab"]')].map(
          (b) => (b.textContent || "").trim() + (b.getAttribute("aria-selected") === "true" ? "*" : ""),
        ),
      ),
      stored: (() => {
        try {
          return JSON.parse(localStorage.getItem("graphiq:panel-layout") || "{}");
        } catch {
          return null;
        }
      })(),
      /* Which panel body is on screen, so "the tab switched" can be checked by
         CONTENT rather than by the strip agreeing with itself. */
      bodyText: (() => {
        const s = document.querySelector('[data-tour="dock"] section[data-grouped]');
        const b = s && s.querySelector('[class*="panelBody"]');
        return b ? (b.textContent || "").trim().slice(0, 40) : "";
      })(),
    }));
  /** Tag a panel's header so the synthetic drag can address it. */
  const tagHeader = (name) =>
    page.evaluate((n) => {
      const btn = [...document.querySelectorAll('[data-tour="dock"] button')].find(
        (b) => (b.getAttribute("aria-label") || "").endsWith(n) && b.className.includes("panelCaret"),
      );
      if (!btn) return false;
      btn.closest("header").setAttribute("data-probe", n.toLowerCase());
      return true;
    }, name);
  const windowMenu = async (item) => {
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      await page.getByText("Window", { exact: true }).first().click();
      const ok = await page.waitForSelector('[role="menu"]', { timeout: 2500 }).then(() => true).catch(() => false);
      if (!ok) continue;
      await page.waitForTimeout(200);
      const b = page.locator('[role="menu"] button').filter({ hasText: item }).first();
      if (!(await b.count())) {
        await page.keyboard.press("Escape");
        return false;
      }
      await b.click();
      await page.waitForTimeout(800);
      return true;
    }
    return false;
  };

  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await boot();

  const before = await state();
  check("the dock starts with no groups", before.grouped === 0 && before.tabs.length === 0,
    `${before.sections} panels, ${before.grouped} grouped`);

  // ---------- join ----------
  check("both panel headers were found", (await tagHeader("Color")) && (await tagHeader("Swatches")));
  await page.evaluate(() => window.__dnd('header[data-probe="swatches"]', 'header[data-probe="color"]'));
  await page.waitForTimeout(800);
  const joined = await state();
  check("dropping a header on a header merges the two into one frame",
    joined.grouped === 1 && joined.sections === before.sections - 1,
    `${joined.sections} panels (was ${before.sections}), ${joined.grouped} grouped`);
  check("…showing both panels as tabs", joined.tabs.length === 1 && joined.tabs[0].length === 2,
    JSON.stringify(joined.tabs));
  const key = joined.stored?.groups?.color;
  check("…and the membership is persisted under one key",
    !!key && joined.stored.groups.swatches === key, JSON.stringify(joined.stored?.groups));

  // ---------- switch ----------
  const tabs = page.locator('[data-tour="dock"] [role="tab"]');
  const idx = (await tabs.nth(0).getAttribute("aria-selected")) === "true" ? 1 : 0;
  const wanted = (await tabs.nth(idx).innerText()).trim();
  const bodyBefore = joined.bodyText;
  await tabs.nth(idx).click();
  await page.waitForTimeout(700);
  const switched = await state();
  check(`clicking the "${wanted}" tab selects it`,
    switched.tabs[0]?.includes(`${wanted}*`), JSON.stringify(switched.tabs));
  check("…and the body actually changes with it", switched.bodyText !== bodyBefore,
    `"${bodyBefore.slice(0, 20)}" -> "${switched.bodyText.slice(0, 20)}"`);

  // ---------- a member hidden from the Window menu ----------
  /* The frame renders its ACTIVE member, so hiding that one must not take the
     whole group with it — the bug this check exists for. */
  const activeName = switched.tabs[0].find((t) => t.endsWith("*")).replace("*", "");
  check(`hiding "${activeName}" from the Window menu`, await windowMenu(new RegExp(`^${activeName}$`)));
  const hidden = await state();
  check("…leaves the other panel on screen rather than emptying the frame",
    hidden.sections === joined.sections, `${hidden.sections} panels (was ${joined.sections})`);
  check("…as a plain panel, not a one-tab group", hidden.grouped === 0 && hidden.tabs.length === 0,
    `${hidden.grouped} grouped, tabs ${JSON.stringify(hidden.tabs)}`);
  check(`putting "${activeName}" back`, await windowMenu(new RegExp(`^${activeName}$`)));
  const restored = await state();
  check("…restores the tab strip", restored.grouped === 1 && restored.tabs[0]?.length === 2,
    JSON.stringify(restored.tabs));

  // ---------- persistence ----------
  await page.reload({ waitUntil: "domcontentloaded" });
  await boot();
  const reloaded = await state();
  check("the grouping survives a reload", reloaded.grouped === 1 && reloaded.tabs[0]?.length === 2,
    JSON.stringify(reloaded.tabs));

  // ---------- workspaces ----------
  check("Reset workspace is available", await windowMenu(/^Reset workspace$/));
  await page.waitForTimeout(900);
  const reset = await state();
  check("…and it clears the grouping", reset.grouped === 0 && !Object.keys(reset.stored?.groups ?? {}).length,
    `${reset.grouped} grouped, stored ${JSON.stringify(reset.stored?.groups)}`);

  // ---------- drag a tab back out ----------
  await tagHeader("Color");
  await tagHeader("Swatches");
  await page.evaluate(() => window.__dnd('header[data-probe="swatches"]', 'header[data-probe="color"]'));
  await page.waitForTimeout(800);
  const regrouped = await state();
  check("regrouped for the ungroup leg", regrouped.grouped === 1, JSON.stringify(regrouped.tabs));
  await page.evaluate(() => {
    const s = [...document.querySelectorAll('[data-tour="dock"] section')].find((x) => !x.hasAttribute("data-grouped"));
    if (s) s.setAttribute("data-probe-body", "1");
    const tab = document.querySelector('[data-tour="dock"] [role="tab"]');
    if (tab) tab.setAttribute("data-probe-tab", "1");
  });
  await page.evaluate(() => window.__dnd("[data-probe-tab]", "section[data-probe-body]"));
  await page.waitForTimeout(800);
  const ungrouped = await state();
  check("dragging a tab onto another panel takes it out of the group",
    ungrouped.grouped === 0 && !Object.keys(ungrouped.stored?.groups ?? {}).length,
    `${ungrouped.sections} panels, ${ungrouped.grouped} grouped`);

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS FAIL:", e.message);
  process.exit(1);
});
