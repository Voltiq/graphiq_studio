/* Switching tabs finishes what is open in the tab you leave — in THAT tab.
 *
 * MEASURED BEFORE: type "Hello from A" with the Text tool, switch to tab B and
 * back — no text layer anywhere. The text session was dropped on the document
 * change (`setTextSession(null)`), where leaving the Text TOOL commits it. A
 * floating paste had no handling at all: the float lives in the engine, which
 * every tab shares, so it stayed pending across the switch.
 *
 * Now the editor's one tab-switch gate (`setActiveId`) commits the text edit
 * before the active document changes — the commit targets whichever document
 * is active, so after the switch it would land in the wrong one — and the
 * engine commits a float when it swaps histories, before parking the old one.
 *
 * Checks:
 *   1  text typed in A and left open lands in A, as a text layer
 *   2  …and not in B
 *   3  …as one undoable step in A's history
 *   4  a float nudged in A and left pending is committed in A by the switch alone
 *   5  B's VIEW is untouched by A's float (the export would hide a leak)
 *   6  that commit is the last step of A's own history (Ctrl+Z in A undoes it)
 *
 * MUTATION: drop the gate's commitPendingEdits() call and 1 and 3 fail; drop the
 * float commit from endLiveSessions and 4 and 6 fail (5 is a guard: today a
 * pending float is not drawn over another tab even without the fix).
 *
 * Run: node tools/verify-tab-switch-commit.js [--url ...] [--channel ...]
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

    const settle = (ms = 800) => page.waitForTimeout(ms);
    const run = async (id) => {
      await page.evaluate((a) => window.graphiq.run(a), id);
      await settle();
    };
    const docs = () => page.evaluate(() => window.graphiq.docs());
    const layerNames = () => page.evaluate(() => window.graphiq.layers().map((l) => l.name));
    const activate = async (id) => {
      await page.evaluate((i) => window.graphiq.activate(i), id);
      await settle();
    };
    /** Ink count + hash of the exported composite. */
    const shot = () =>
      page.evaluate(async () => {
        const blob = await window.graphiq.exportPNG();
        const bmp = await createImageBitmap(blob);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const x = c.getContext("2d");
        x.drawImage(bmp, 0, 0);
        const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
        let ink = 0;
        let h = 0x811c9dc5;
        for (let i = 0; i < d.length; i++) {
          h = Math.imul(h ^ d[i], 0x01000193);
          if (i % 4 === 3 && d[i]) ink++;
        }
        return { ink, hash: (h >>> 0).toString(36) };
      });

    /** Painted pixels on the on-screen view canvas (an empty document reads 0). */
    const viewInk = () =>
      page.evaluate(() => {
        const c = document.querySelector('[data-tour="canvas"] canvas');
        const d = c.getContext("2d").getImageData(0, 0, c.width, c.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
        return n;
      });

    const a = (await docs())[0].id;
    await run("new-doc");
    const nd = page.locator('div[role="dialog"][aria-label="New document"]');
    if (await nd.count()) {
      await nd.getByText("Create", { exact: true }).click();
      await settle();
    }
    const b = (await docs()).find((d) => d.id !== a).id;
    await activate(a);

    // ---- 1–3: an open text edit -----------------------------------------------
    await page.keyboard.press("t");
    await settle(300);
    const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
    await settle(600);
    await page.keyboard.type("Hello from A", { delay: 15 });
    await settle(400);
    const typed = await page.evaluate(() => document.querySelector("[role=textbox]")?.textContent ?? null);
    if (typed !== "Hello from A") check("the text session opened and took the typing", false, String(typed));
    await activate(b);
    const bNames = await layerNames();
    await activate(a);
    const aNames = await layerNames();
    check("1  an open text edit lands in its own tab", aNames.includes("Hello from A"), aNames.join(", ") || "no layers");
    check("2  …and not in the tab switched to", bNames.length === 0, bNames.join(", ") || "no layers");
    await page.mouse.move(box.x + 2, box.y + 2);
    await page.keyboard.press("Control+z");
    await settle();
    const afterUndo = await layerNames();
    check("3  …as one undoable step in its own history", aNames.includes("Hello from A") && !afterUndo.includes("Hello from A"), afterUndo.join(", ") || "no layers");

    // ---- 4–6: a pending float ---------------------------------------------------
    await page.keyboard.press("v"); // Move tool: arrows nudge the float
    await settle(300);
    await run("layer-new");
    await page.evaluate(() => window.graphiq.setForeground("#e0402a"));
    await page.evaluate(() => window.graphiq.select([{ x: 100, y: 100, w: 300, h: 200 }]));
    await settle(300);
    await page.keyboard.press("Backspace"); // a red block to copy
    await settle();
    await run("edit-copy");
    await run("edit-paste"); // in-app copy → pasted in place, floating
    for (let i = 0; i < 5; i++) await page.keyboard.press("Shift+ArrowRight"); // nudge the float
    await settle();
    /* exportPNG leaves a pending float out — it is not part of the document
       yet — so A still reads as the bare 300×200 block here. */
    const aFloating = await shot();
    await activate(b);
    // The VIEW, not the export: a float leaking across would be drawn on screen.
    const bView = await viewInk();
    check("5  the other tab's view is untouched by the float", bView === 0, `${bView} px drawn over B`);
    await activate(a); // no Enter anywhere: the switch alone must have committed it
    const aAfter = await shot();
    /* Committed where it was put: the block plus its nudge, i.e. more than the
       60,000 px it started as, in whole 200px columns. */
    check("4  a pending float is committed in its own tab, where it was put",
      aFloating.ink === 60000 && aAfter.ink > 60000 && aAfter.ink % 200 === 0,
      `A ${aFloating.ink} px before the switch → ${aAfter.ink} px after`);
    await page.mouse.move(box.x + 2, box.y + 2);
    await page.keyboard.press("Control+z");
    await settle();
    const aUndone = await shot();
    check("6  …and that commit is the last step of its own history", aAfter.ink > 60000 && aUndone.ink === 60000,
      `${aAfter.ink} → ${aUndone.ink} px after Ctrl+Z in A`);

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
