/* Every document tab has its own undo history.
 *
 * MEASURED BEFORE: one PaintEngine serves every open tab, and it held ONE undo
 * stack. Paint in tab A, open an untouched tab B, press Ctrl+Z — A's stroke was
 * undone, off-screen (A 28,096 px of ink → 0). The reverse too: with a stroke in
 * each tab, Ctrl+Z in A removed B's stroke and left A's alone. FEATURES.md has
 * promised "its own undo history" per tab all along.
 *
 * The engine now keeps one history slot per document and swaps them when the
 * active tab changes (PaintEngine.setHistoryDocument).
 *
 * Checks, each against the other tab as well as the one acted on — "undo did
 * nothing" alone would also pass on an undo that had simply stopped working:
 *   1. Ctrl+Z in an untouched tab leaves the other tab's stroke alone
 *   2. Ctrl+Z in A undoes A's stroke, not B's; redo in A brings back A's
 *   3. the History panel lists only the active tab's steps
 *   4. closing a tab leaves the remaining tab's history undoable
 *
 * MUTATION: drop the `setHistoryDocument` layout effect in CanvasArea and 1–3 fail.
 *
 * Run: node tools/verify-doc-history.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

(async () => {
  const browser = await launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  try {
    await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
    const tour = await page
      .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8000 })
      .catch(() => null);
    if (tour) {
      await page.keyboard.press("Escape");
      await page.waitForSelector('div[aria-label="Interactive tour"]', { state: "detached", timeout: 5000 });
    }
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    await page.waitForTimeout(600);
    // History starts collapsed; its rows only render while it is open.
    const history = page.locator('[data-panel-id="history"]');
    if ((await history.getAttribute("data-open")) !== "true") {
      await page.getByRole("button", { name: "Expand History" }).first().click();
      await page.waitForTimeout(400);
    }

    const settle = () => page.waitForTimeout(900);
    const ink = () =>
      page.evaluate(() => {
        const c = document.querySelector('[data-tour="canvas"] canvas');
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      });
    const historyRows = () =>
      page.evaluate(() =>
        [...document.querySelectorAll('[data-panel-id="history"] ol[class*="history"] > li')].map((li) =>
          li.textContent.trim(),
        ),
      );
    const activate = async (id) => {
      await page.evaluate((i) => window.graphiq.activate(i), id);
      await settle();
    };
    const stroke = async (fy) => {
      const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
      await page.getByRole("button", { name: "Brush" }).first().click();
      await page.waitForTimeout(200);
      for (let i = 0; i < 10; i++) await page.keyboard.press("]");
      await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * fy);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * fy, { steps: 20 });
      await page.mouse.up();
      await settle();
      await page.mouse.move(box.x + 5, box.y + 5); // keep the cursor ring out of the readings
    };
    const newDoc = async () => {
      await page.evaluate(() => window.graphiq.run("new-doc"));
      await settle();
      const nd = page.locator('div[role="dialog"][aria-label="New document"]');
      if (await nd.count()) {
        await nd.getByText("Create", { exact: true }).click();
        await settle();
      }
    };
    const key = async (k) => {
      await page.keyboard.press(k);
      await settle();
    };

    // A: one stroke. B: a new, untouched tab.
    await stroke(0.3);
    const a = (await page.evaluate(() => window.graphiq.docs()))[0].id;
    const aInk = await ink();
    const aRows = await historyRows();
    await newDoc();
    const b = (await page.evaluate(() => window.graphiq.docs())).find((d) => d.id !== a).id;

    // 3 (B side) — read before anything else happens in B.
    const bRows = await historyRows();
    check("the History panel is visible to read", aRows.length > 1, `${aRows.length} rows in A`);
    check("a new tab's History holds only its own origin", bRows.length === 1, bRows.join(" | "));

    // 1
    await key("Control+z");
    await activate(a);
    const aAfter = await ink();
    check("Ctrl+Z in an untouched tab leaves another tab's stroke alone", aInk > 500 && aAfter === aInk,
      `A ${aInk} → ${aAfter} px`);

    // 2
    await activate(b);
    // Two strokes, so B's history is longer than A's and a leak changes the count.
    await stroke(0.6);
    await stroke(0.8);
    const bInk = await ink();
    await activate(a);
    await key("Control+z");
    const aUndone = await ink();
    await activate(b);
    const bKept = await ink();
    check("Ctrl+Z in A undoes A's stroke", aUndone === 0, `${aUndone} px left in A`);
    check("...and not B's", bInk > 500 && bKept === bInk, `B ${bInk} → ${bKept} px`);
    await activate(a);
    await key("Control+Shift+z");
    check("redo in A brings A's stroke back", (await ink()) === aInk);

    // 3 (A side, after the switches) — A shows its stroke, not B's as well.
    const aRows2 = await historyRows();
    check("the History panel shows the active tab's steps after switching back",
      aRows2.length === aRows.length, `${aRows.length} → ${aRows2.length}`);

    // 4 — close B; A is still undoable.
    await activate(b);
    const bName = (await page.evaluate(() => window.graphiq.docs())).find((d) => d.id === b).name;
    await page.locator(`[aria-label="Close ${bName}"]`).first().click({ force: true });
    await settle();
    const left = await page.evaluate(() => window.graphiq.docs().map((d) => d.id));
    check("the second tab closed", left.length === 1 && left[0] === a, left.join(","));
    await key("Control+z");
    check("after closing a tab, the remaining tab still undoes its own step", (await ink()) === 0);

    check("nothing threw", errors.length === 0, errors.slice(0, 2).join(" | "));
  } catch (e) {
    check("harness ran to completion", false, String(e));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r).length;
  console.log(`\n${results.length - failed}/${results.length} passed`);
  process.exit(failed ? 1 : 0);
})();
