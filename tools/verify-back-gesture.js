/* Back closes what is in front of you; it does not throw the document away.
 *
 * On a phone the back gesture is how everything is dismissed, and nothing in
 * the app consumed it: back left the editor outright, with no prompt and no
 * warning. A guard entry is now pushed for it to land on, the layer in front is
 * closed when it does, and only with nothing left to close is the navigation
 * allowed — at which point `beforeunload` asks about unsaved work.
 *
 * The order matters as much as the behaviour: a dialog opened on top of a
 * drawer has to close FIRST, or back would dismantle the app from underneath.
 *
 * Note on beforeunload: it does nothing at all on iOS, so it is the weaker half
 * of this item — autosaving when the page is hidden is what actually protects
 * an iPhone. Here it is driven through `page.close({ runBeforeUnload: true })`,
 * which is the one way an automated browser will raise it.
 *
 * Run: node tools/verify-back-gesture.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

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
    await page.waitForTimeout(700);
    return { context, page };
  };

  /** Press back the way the gesture does, without Playwright's navigation waits. */
  const back = async (page) => {
    await page.evaluate(() => window.history.back());
    await page.waitForTimeout(700);
  };
  const stillHere = (page) =>
    page.evaluate(() => !!document.querySelector('[data-tour="canvas"]'));

  // ---------- the phone: drawers and the menu sheet ----------
  {
    const { context, page } = await open({ width: 390, height: 844 }, true);
    const drawerOpen = () => page.evaluate(() => document.documentElement.dataset.drawer ?? "");
    const sheetOpen = () =>
      page.evaluate(() => !!document.querySelector('[data-menubar][data-sheet="true"]'));

    await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().click();
    await page.waitForTimeout(600);
    check("a drawer opens", (await drawerOpen()) === "tools", `data-drawer="${await drawerOpen()}"`);
    await back(page);
    check("back closes the drawer instead of leaving",
      (await drawerOpen()) === "" && (await stillHere(page)),
      `data-drawer="${await drawerOpen()}", still in the editor: ${await stillHere(page)}`);

    await page.locator('button[aria-label="Menu"]').first().click();
    await page.waitForTimeout(600);
    check("the menu sheet opens", await sheetOpen());
    await back(page);
    check("back closes the sheet instead of leaving",
      !(await sheetOpen()) && (await stillHere(page)),
      `sheet open: ${await sheetOpen()}, still in the editor: ${await stillHere(page)}`);

    /* LIFO: a dialog on top of a drawer closes first, and the drawer survives. */
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().click();
    await page.waitForTimeout(600);
    await page.evaluate(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", ctrlKey: true, bubbles: true })));
    await page.waitForTimeout(500);
    const paletteUp = await page.evaluate(() => !!document.querySelector('[role="dialog"]'));
    if (paletteUp) {
      await back(page);
      const dialogGone = await page.evaluate(() => !document.querySelector('[role="dialog"]'));
      check("a dialog above a drawer closes first, and the drawer stays",
        dialogGone && (await drawerOpen()) === "tools",
        `dialog gone: ${dialogGone}, data-drawer="${await drawerOpen()}"`);
    } else {
      check("a dialog above a drawer closes first, and the drawer stays", false,
        "no dialog could be opened to stack");
    }
    await context.close();
  }

  // ---------- leaving with, and without, unsaved work ----------
  /** Close the page with beforeunload live, and report whether it spoke. */
  const closeAndWatch = async (page, context) => {
    let asked = false;
    page.on("dialog", async (d) => {
      asked = d.type() === "beforeunload";
      await d.dismiss().catch(() => {});
    });
    await page.close({ runBeforeUnload: true });
    await new Promise((r) => setTimeout(r, 1200));
    await context.close();
    return asked;
  };

  {
    const { context, page } = await open({ width: 1400, height: 900 }, false);
    const asked = await closeAndWatch(page, context);
    check("leaving an untouched document asks nothing", asked === false,
      `beforeunload prompted: ${asked}`);
  }
  {
    const { context, page } = await open({ width: 1400, height: 900 }, false);
    const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await page.mouse.move(box.x + box.width * 0.4, box.y + box.height * 0.5);
    await page.mouse.down();
    for (let i = 1; i <= 8; i++)
      await page.mouse.move(box.x + box.width * (0.4 + i * 0.02), box.y + box.height * (0.5 + i * 0.02));
    await page.mouse.up();
    await page.waitForTimeout(900);
    const edited = await page.evaluate(() =>
      (document.querySelector('[data-tour="status"]')?.textContent ?? "").includes("Unsaved changes"));
    check("an edit registers as unsaved work", edited, `status says "Unsaved changes": ${edited}`);
    const asked = await closeAndWatch(page, context);
    check("leaving with an edit pending asks first", asked === true,
      `beforeunload prompted: ${asked}`);
  }

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
