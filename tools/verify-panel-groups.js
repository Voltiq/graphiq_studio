/* Correctness rail for the dock's DRAG BEHAVIOUR: reordering, tabbed groups, the
 * drop indicator, and the two docks.
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/verify-panel-groups.js
 *
 * REAL DRAGS, and that is the whole point of this file's shape. An earlier
 * version dispatched DragEvents by hand and passed every check while dragging a
 * panel in the browser did nothing at all: a hand-dispatched drop is not a
 * discrete user gesture, so React batched its state updates instead of flushing
 * them mid-dispatch — and the bug lived entirely in that flush. Chromium's own
 * drag is driven here instead, via `Input.setInterceptDrags` plus real mouse
 * input, which is what Playwright's `dragTo` does internally but held open so
 * the indicator can be read while the pointer is still over a band.
 *
 * Two things about driving it that cost a cycle each and are easy to hit again:
 *   - Chromium COALESCES dragover. Moving somewhere in N steps can leave the
 *     last delivered dragover at an intermediate position, so every aim ends
 *     with a one-pixel nudge to force a fresh event at the final spot.
 *   - The left dock's drop zone only exists WHILE a drag is in progress, so it
 *     cannot be resolved as a target up front; it has to be measured mid-drag.
 */
const { launchBrowser, urlArg } = require("./lib/launch");

(async () => {
  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
  const errors = [];
  /* Rebindable, because the persistence leg continues in a SECOND page rather
     than reloading this one — every helper below closes over these names. */
  let page;
  const openPage = async () => {
    page = await context.newPage();
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
    await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
    await boot();
  };

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

  await openPage();

  const sectionOf = (name) =>
    page
      .locator('[data-tour="dock"] section')
      .filter({ has: page.locator(`button[aria-label$="${name}"]`) })
      .first();
  const headerOf = (name) => sectionOf(name).locator("header").first();
  const panelNames = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('[data-tour="dock"] section')].map((s) =>
        (s.querySelector('button[class*="panelCaret"]')?.getAttribute("aria-label") || "?").replace(
          /^(Collapse|Expand)\s+/,
          "",
        ),
      ),
    );
  const state = () =>
    page.evaluate(() => ({
      sections: document.querySelectorAll('[data-tour="dock"] section').length,
      grouped: document.querySelectorAll('[data-tour="dock"] section[data-grouped]').length,
      tabs: [...document.querySelectorAll('[data-tour="dock"] [role="tablist"]')].map((tl) =>
        [...tl.querySelectorAll('[role="tab"]')].map(
          (b) => (b.textContent || "").trim() + (b.getAttribute("aria-selected") === "true" ? "*" : ""),
        ),
      ),
      hints: [...document.querySelectorAll("[data-drop]")].map((s) => s.getAttribute("data-drop")),
      dragging: document.querySelectorAll('section[data-dragging="true"]').length,
      stored: (() => {
        try {
          return JSON.parse(localStorage.getItem("graphiq:panel-layout") || "{}");
        } catch {
          return null;
        }
      })(),
      bodyText: (() => {
        const s = document.querySelector('[data-tour="dock"] section[data-grouped]');
        const b = s && s.querySelector('[class*="panelBody"]');
        return b ? (b.textContent || "").trim().slice(0, 40) : "";
      })(),
    }));
  /** "Panel:kind" so a failure says WHICH panel was marked, not just how. */
  const readHint = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-drop]")]
        .map((s) => {
          const n = (s.querySelector('button[class*="panelCaret"]')?.getAttribute("aria-label") || "?").replace(
            /^(Collapse|Expand)\s+/,
            "",
          );
          return `${n}:${s.getAttribute("data-drop")}`;
        })
        .join(","),
    );

  /**
   * Drag one panel onto a band of another, returning what the dock PROMISED
   * while the pointer was there. `where` is "top"/"bottom" (the edge bands that
   * place the panel on its own either side) or "middle" (make it a tab).
   * `hold` leaves the drag in progress instead of dropping.
   */
  /** A grouped panel is a TAB, not a section of its own — that is what it has to
   *  be dragged by once it has joined a group. */
  const tabOf = (name) =>
    page.locator('[data-tour="dock"] [role="tab"]').filter({ hasText: new RegExp(`^${name}$`) }).first();
  const VIEW_H = 950;
  const onScreen = (b) => !!b && b.y > 4 && b.y + b.height < VIEW_H - 4;
  /** Box of `loc`, scrolling it into view first if it is off the fold. */
  const reachableBox = async (loc) => {
    let b = await loc.boundingBox().catch(() => null);
    if (onScreen(b)) return b;
    await loc.evaluate((el) => el.scrollIntoView({ block: "nearest" })).catch(() => {});
    await page.waitForTimeout(250);
    b = await loc.boundingBox().catch(() => null);
    return onScreen(b) ? b : null;
  };

  const dragPanel = async (fromName, toName, where, hold = false) => {
    /* Centre the target first. Chromium AUTO-SCROLLS a scrollable dock while a
       drag hovers near its edge, and a panel sitting at the bottom of the
       viewport then slides out from under a pointer that never moved: the last
       thing it sees is a dragleave, and a drop is only delivered over an
       element whose most recent dragover was accepted. That cost three false
       failures here — the drop silently not happening, on a feature that works. */
    await sectionOf(toName).evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    await page.waitForTimeout(250);
    const fromLoc = (await tabOf(fromName).count()) ? tabOf(fromName) : headerOf(fromName);
    /* Centring the target can push the panel we mean to PICK UP off the fold,
       and boundingBox() answers for those too — the drag would start at a point
       the pointer cannot reach and simply do nothing. */
    const src = await reachableBox(fromLoc);
    if (!src) return { hint: `"${fromName}" is off screen`, ok: false };
    const aim = async () => {
      const d = await sectionOf(toName).boundingBox();
      if (!d) return null;
      return {
        x: d.x + d.width / 2,
        y: where === "top" ? d.y + 4 : where === "bottom" ? d.y + d.height - 4 : d.y + d.height / 2,
      };
    };
    let first = await aim();
    if (first && !(first.y > 4 && first.y < VIEW_H - 4)) {
      /* Bringing the source into view can push the target off the other end.
         Nudge the target back and re-measure both; both have to be reachable
         at once or the drag lands somewhere nobody asked for. */
      await sectionOf(toName).evaluate((el) => el.scrollIntoView({ block: "nearest" }));
      await page.waitForTimeout(250);
      first = await aim();
    }
    if (!first) return { hint: `"${toName}" has no box`, ok: false };
    if (!(first.y > 4 && first.y < VIEW_H - 4))
      return { hint: `"${toName}" ${where} edge is off screen at y=${Math.round(first.y)}`, ok: false };
    if (process.env.GQ_DIAG)
      console.log("    dragPanel %s->%s src.y=%d h=%d aim=%d", fromName, toName,
        Math.round(src.y), Math.round(src.height), Math.round(first.y));
    await page.mouse.move(src.x + src.width / 2, src.y + src.height / 2);
    await page.mouse.down();
    await page.mouse.move(src.x + src.width / 2, src.y - 25, { steps: 4 });
    await page.mouse.move(first.x, first.y, { steps: 8 });
    /* Re-aim once the drag is live, in case it scrolled anyway, and only then
       nudge — the nudge is what forces a fresh dragover at the final spot,
       because Chromium coalesces them and can leave the last one mid-path. */
    let at = (await aim()) ?? first;
    await page.mouse.move(at.x, at.y, { steps: 2 });
    await page.mouse.move(at.x + 1, at.y, { steps: 2 });
    await page.mouse.move(at.x, at.y, { steps: 2 });
    await page.waitForTimeout(220);
    const hint = await readHint();
    if (hold) return { hint, ok: true };
    await page.mouse.up();
    await page.waitForTimeout(700);
    return { hint, ok: true };
  };

  const windowMenu = async (item) => {
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      await page.getByText("Window", { exact: true }).first().click();
      const up = await page.waitForSelector('[role="menu"]', { timeout: 2500 }).then(() => true).catch(() => false);
      if (!up) continue;
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

  const start = await state();
  check("the dock starts with no groups", start.grouped === 0 && start.tabs.length === 0,
    `${start.sections} panels, ${start.grouped} grouped`);

  // ---------- 1. an EDGE drop actually reorders ----------
  /* The check this file did not have, and the only one that could have caught a
     regression where every drop silently did nothing at all. */
  /* Both panels are near the top of the dock on purpose: the dock scrolls, and a
     target below the fold has an off-screen box that the pointer never reaches. */
  const order0 = await panelNames();
  const mover = order0[2];
  const moveRes = await dragPanel(mover, order0[0], "top");
  check(`dragging "${mover}" onto "${order0[0]}"'s top edge announces "before"`,
    moveRes.hint.includes("before"), `announced "${moveRes.hint}"`);
  const order1 = await panelNames();
  check("…and the drop actually moves it there", order1[0] === mover,
    `${order0.slice(0, 3).join(" > ")}  ->  ${order1.slice(0, 3).join(" > ")}`);

  // ---------- 2. a MIDDLE drop makes a tab ----------
  const mid = await dragPanel("Swatches", "Color", "middle");
  check('dragging Swatches onto the middle of Color announces "group"', mid.hint.includes("group"),
    `announced "${mid.hint}"`);
  const joined = await state();
  check("…and the drop merges them into one frame",
    joined.grouped === 1 && joined.tabs[0]?.length === 2, JSON.stringify(joined.tabs));
  const key = joined.stored?.groups?.color;
  check("…persisted under one key", !!key && joined.stored.groups.swatches === key,
    JSON.stringify(joined.stored?.groups));

  // ---------- 4. switching tabs ----------
  const tabs = page.locator('[data-tour="dock"] [role="tab"]');
  const idx = (await tabs.nth(0).getAttribute("aria-selected")) === "true" ? 1 : 0;
  const wanted = (await tabs.nth(idx).innerText()).trim();
  const bodyBefore = (await state()).bodyText;
  await tabs.nth(idx).click();
  await page.waitForTimeout(700);
  const switched = await state();
  check(`clicking the "${wanted}" tab selects it`, switched.tabs[0]?.includes(`${wanted}*`),
    JSON.stringify(switched.tabs));
  check("…and the body changes with it", switched.bodyText !== bodyBefore,
    `"${bodyBefore.slice(0, 18)}" -> "${switched.bodyText.slice(0, 18)}"`);

  // ---------- 5. hiding a member from the Window menu ----------
  /* The frame renders its ACTIVE member, so hiding that one must not take the
     whole group with it. */
  const activeName = switched.tabs[0].find((t) => t.endsWith("*")).replace("*", "");
  check(`hiding "${activeName}" from the Window menu`, await windowMenu(new RegExp(`^${activeName}$`)));
  const hidden = await state();
  check("…leaves the other panel on screen", hidden.sections === switched.sections,
    `${hidden.sections} panels (was ${switched.sections})`);
  check("…as a plain panel, not a one-tab group", hidden.grouped === 0 && hidden.tabs.length === 0,
    `${hidden.grouped} grouped`);
  check(`putting "${activeName}" back`, await windowMenu(new RegExp(`^${activeName}$`)));
  const restored = await state();
  check("…restores the tab strip", restored.grouped === 1 && restored.tabs[0]?.length === 2,
    JSON.stringify(restored.tabs));

  // ---------- 6. persistence ----------
  /* A second page rather than page.reload(): the same storage read, plus it
     shows the layout being rebuilt on a cold mount instead of merely surviving
     one. Either would do — the drag trouble that followed this point turned out
     to be autoscroll, not the navigation. */
  const previous = page;
  await openPage();
  await previous.close();
  const reloaded = await state();
  check("the grouping survives a reload", reloaded.grouped === 1 && reloaded.tabs[0]?.length === 2,
    JSON.stringify(reloaded.tabs));

  // ---------- 7. a tab leaves the group by an EDGE drop ----------
  const outRes = await dragPanel("Swatches", "Brushes", "top");
  check('dragging a grouped panel to another panel\'s edge announces "before"',
    outRes.hint.includes("before"), `announced "${outRes.hint}"`);
  const ungrouped = await state();
  check("…and takes it out of the group",
    ungrouped.grouped === 0 && !Object.keys(ungrouped.stored?.groups ?? {}).length,
    `${ungrouped.grouped} grouped, stored ${JSON.stringify(ungrouped.stored?.groups)}`);

  // ---------- 8. the other dock ----------
  /* Moving a panel across destroys the node the drag started on, so its own
     `dragend` never arrives; whatever the drag state drives has to be cleaned up
     regardless, or the panel stays greyed out with the dashed zones showing. */
  const plain = (await panelNames()).find((n) => n !== "?") || "Navigator";
  const src8 = await reachableBox(headerOf(plain));
  if (!src8) throw new Error(`"${plain}" is off screen — nothing to drag`);
  await page.mouse.move(src8.x + src8.width / 2, src8.y + src8.height / 2);
  await page.mouse.down();
  await page.mouse.move(src8.x + src8.width / 2, src8.y - 25, { steps: 4 });
  await page.mouse.move(400, 400, { steps: 6 });
  const zone = await page.locator('[aria-label="Left dock"] > div').first().boundingBox().catch(() => null);
  check("a drop zone appears in the left dock while dragging", !!zone,
    zone ? `${Math.round(zone.width)}x${Math.round(zone.height)}` : "none");
  if (zone) {
    await page.mouse.move(zone.x + zone.width / 2, zone.y + zone.height / 2, { steps: 6 });
    await page.mouse.move(zone.x + zone.width / 2 + 1, zone.y + zone.height / 2, { steps: 2 });
    await page.waitForTimeout(200);
  }
  await page.mouse.up();
  await page.waitForTimeout(800);
  const dockAfter = await page.evaluate(() => ({
    dragging: document.querySelectorAll('section[data-dragging="true"]').length,
    zones: document.querySelectorAll('[aria-label="Left dock"] > div, [data-tour="dock"] > div').length,
    left: document.querySelectorAll('[aria-label="Left dock"] section').length,
  }));
  check(`"${plain}" can be dragged into the left dock`, dockAfter.left > 0, `${dockAfter.left} left-docked`);
  check("…and the drop leaves nothing greyed out or showing a drop zone",
    dockAfter.dragging === 0 && dockAfter.zones === 0,
    `${dockAfter.dragging} still greyed, ${dockAfter.zones} drop zone(s)`);

  // ---------- 9. workspaces ----------
  check("Reset workspace is available", await windowMenu(/^Reset workspace$/));
  await page.waitForTimeout(900);
  const reset = await state();
  check("…and it clears the grouping", reset.grouped === 0 && !Object.keys(reset.stored?.groups ?? {}).length,
    `${reset.grouped} grouped, stored ${JSON.stringify(reset.stored?.groups)}`);

  // ---------- the bottom band, and cancelling a drag ----------
  /* LAST on purpose. Cancelling with Escape leaves Chromium's drag machinery in
     a state that quietly breaks the next drag in the same page — the drop stops
     being delivered and the one after that never starts. That is an artefact of
     driving input over CDP, not something the app does, and it is avoided by
     having nothing follow it rather than by sprinkling resets. */
  const held = await dragPanel("Color", "Info", "bottom", true);
  check('hovering a panel\'s bottom edge announces "after"', held.hint.includes("after"),
    `announced "${held.hint}"`);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  await page.waitForTimeout(700);
  const cancelled = await state();
  check("…and cancelling leaves nothing marked or greyed out",
    cancelled.hints.length === 0 && cancelled.dragging === 0,
    `${cancelled.hints.length} marked, ${cancelled.dragging} greyed`);


  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS FAIL:", e.message);
  process.exit(1);
});
