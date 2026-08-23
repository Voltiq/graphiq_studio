/* Twenty-nine tools a phone can actually read.
 *
 * The mobile tools drawer was the desktop rail with a transform on it: a 76px
 * column of 29 unlabelled icons, 1522px of scroll against a 528px window — 2.9
 * screens — and the only text on any of them was a keyboard shortcut badge,
 * which on a phone names a key that does not exist.
 *
 * It is now a sheet as wide as the panels drawer, with six core tools up front
 * and the rest in a labelled grid below. What the checks are actually about:
 *
 *   - every tool carries its NAME, not its shortcut. "Labelled" is easy to fake
 *     by leaving the `kbd` in place, so the labels are read back and matched
 *     against the tool names the app itself declares.
 *   - the whole thing fits. The measurement is scrollHeight against the
 *     window's, which is the number that was 2.9 before.
 *   - a labelled cell still switches tools. A grid that reads beautifully and
 *     does nothing would pass every other check here.
 *
 * Desktop is asserted unchanged: still the narrow rail, still the shortcut
 * badges, no labels. The two layouts are separate branches in one component,
 * and the point of the branch is that only one of them moved.
 *
 * Run: node tools/verify-tool-sheet.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

/** The six the sheet puts first — must match PRIMARY_TOOL_IDS in lib/tools.ts. */
const PRIMARY = ["Move", "Rectangular marquee", "Crop", "Brush", "Eraser", "Spot heal"];

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
    return { context, page };
  };

  // ==================================================================== phone
  const phone = await open({ width: 390, height: 844 }, true, "phone");
  const page = phone.page;
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().click();
  await page.waitForTimeout(1100);

  const sheet = await page.evaluate(() => {
    const tb = document.querySelector('[data-tour="toolbar"]');
    if (!tb) return null;
    const scroller = tb.querySelector('[class*="tools"]');
    const buttons = [...tb.querySelectorAll("button[data-tool]")];
    const sections = [...tb.querySelectorAll("[data-tool-section]")].map((s) => ({
      kind: s.getAttribute("data-tool-section"),
      tools: [...s.querySelectorAll("button[data-tool]")].map((b) => ({
        id: b.getAttribute("data-tool"),
        label: b.querySelector("span")?.textContent?.trim() ?? "",
        aria: b.getAttribute("aria-label"),
      })),
    }));
    return {
      width: Math.round(tb.getBoundingClientRect().width),
      count: buttons.length,
      client: scroller?.clientHeight ?? 0,
      scroll: scroller?.scrollHeight ?? 0,
      kbds: tb.querySelectorAll("kbd").length,
      sections,
    };
  });
  check("the tools drawer opens as a sheet, not a 76px rail",
    !!sheet && sheet.width >= 260, sheet ? `${sheet.width}px wide` : "no toolbar");
  check("…holding all 29 tools", sheet?.count === 29, `${sheet?.count} tool buttons`);

  const screens = sheet ? sheet.scroll / Math.max(1, sheet.client) : 99;
  check("…and fitting in 1.2 screens or fewer",
    screens <= 1.2,
    `${sheet?.scroll}px of content in a ${sheet?.client}px window — ${screens.toFixed(1)} screens`);

  /* Names, not shortcuts. Every label is matched against the aria-label the
     app derives from the tool's own name, so a grid captioned "V", "M", "L"
     would fail even though it is, technically, labelled. */
  const all = sheet ? sheet.sections.flatMap((s) => s.tools) : [];
  const named = all.filter((t) => t.label && t.label === t.aria);
  check("every tool shows its name",
    named.length === 29, `${named.length} of ${all.length} captioned with their own name`);
  check("…and no keyboard-shortcut badge, on a device with no keyboard",
    sheet?.kbds === 0, `${sheet?.kbds} kbd badges in the sheet`);

  const primary = sheet?.sections.find((s) => s.kind === "primary");
  const overflow = sheet?.sections.find((s) => s.kind === "overflow");
  check("six core tools come first, in order",
    primary?.tools.map((t) => t.label).join(",") === PRIMARY.join(","),
    primary?.tools.map((t) => t.label).join(", ") ?? "no primary section");
  check("…and the remaining 23 follow in a second group",
    overflow?.tools.length === 23, `${overflow?.tools.length} in the overflow`);

  /* The item's own check, phrased its way. */
  const spotHeal = page.locator('[data-tour="toolbar"]').getByText("Spot heal", { exact: true });
  check('"Spot heal" resolves as visible text inside the drawer',
    (await spotHeal.count()) > 0 && (await spotHeal.first().isVisible()),
    `${await spotHeal.count()} match(es)`);

  // ------------------------------------------------ a labelled cell still works
  const activeTool = () =>
    page.evaluate(
      () =>
        document
          .querySelector('[data-tour="toolbar"] button[aria-pressed="true"]')
          ?.getAttribute("aria-label") ?? "?",
    );
  const before = await activeTool();
  await page.locator('[data-tour="toolbar"] button[data-tool="smudge"]').click();
  await page.waitForTimeout(900);
  const after = await activeTool();
  check("tapping a labelled cell selects that tool",
    after === "Smudge" && after !== before, `${before} → ${after}`);
  check("…and closes the drawer, as picking a tool always did",
    (await page.evaluate(() => document.documentElement.dataset.drawer ?? "")) === "",
    `data-drawer="${await page.evaluate(() => document.documentElement.dataset.drawer ?? "")}"`);

  /* A tool from the overflow half has to be reachable without scrolling past
     the fold — that is the entire complaint the item started from. */
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().click();
  await page.waitForTimeout(1000);
  const onScreen = await page.evaluate(() => {
    const tb = document.querySelector('[data-tour="toolbar"]');
    const buttons = [...tb.querySelectorAll("button[data-tool]")];
    const visible = buttons.filter((b) => {
      const r = b.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight && r.width > 4;
    });
    return { visible: visible.length, total: buttons.length };
  });
  check("most of the sheet is on screen without scrolling at all",
    onScreen.visible >= 24, `${onScreen.visible} of ${onScreen.total} tools visible at rest`);
  await phone.context.close();

  // ================================================================== desktop
  const desk = await open({ width: 1400, height: 900 }, false, "desktop");
  const rail = await desk.page.evaluate(() => {
    const tb = document.querySelector('[data-tour="toolbar"]');
    return {
      width: Math.round(tb.getBoundingClientRect().width),
      sheet: tb.hasAttribute("data-mobile-rail"),
      kbds: tb.querySelectorAll("kbd").length,
      labels: tb.querySelectorAll('[class*="toolLabel"]').length,
      tools: tb.querySelectorAll("button[aria-pressed]").length,
    };
  });
  check("desktop keeps the narrow rail", !rail.sheet && rail.width <= 80, `${rail.width}px wide`);
  check("…with all 29 tools on it", rail.tools === 29, `${rail.tools} tools`);
  check("…still badged with their shortcuts, and not captioned",
    rail.kbds === 29 && rail.labels === 0,
    `${rail.kbds} kbd badges, ${rail.labels} labels`);
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
