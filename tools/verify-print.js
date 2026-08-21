/* Correctness rail for PRINT SETUP.
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/verify-print.js
 *
 * Printing ends in a native dialog no harness can dismiss, so `print()` is
 * stubbed on the hidden iframe the app builds and the CSS it wrote is read back
 * instead. That is the right thing to assert anyway: the whole feature is "where
 * does the image land on the sheet", and the answer lives entirely in the
 * generated `@page` rule and image rect.
 *
 * The expected numbers are derived HERE from first principles rather than from
 * the app's own layout function, so this cannot agree with a bug:
 *   A4 is 210x297 mm = 595.28 x 841.89 pt (1 pt = 1/72 in)
 *   image mode at N ppi puts a W px image on a (W/N)*72 pt page
 *   fitting a WxH image into a margin box scales by the smaller ratio
 */
const { launchBrowser, urlArg } = require("./lib/launch");

const DOC_W = 600;
const DOC_H = 300;

/* Catch the print iframe as it is appended and neuter print(), keeping the CSS.
 *
 * Hooked on appendChild rather than through a MutationObserver, and the reason
 * is worth writing down: the observer's callback is a MICROTASK, and on the
 * second print the image data URL is already decoded, so `img.complete` is true
 * the moment src is set and the app calls print() synchronously — before the
 * observer ever runs. The first print looked fine and every one after it
 * silently escaped to the real print(). appendChild runs in the same tick as the
 * insertion, which is early enough for both.
 */
const HOOK = () => {
  window.__print = { calls: 0, css: "", size: "", hooked: 0 };
  const capture = (frame) => {
    const w = frame.contentWindow;
    if (!w) return;
    window.__print.hooked++;
    w.print = () => {
      window.__print.calls++;
      const d = frame.contentDocument;
      const style = d && d.querySelector("style");
      window.__print.css = style ? style.textContent || "" : "";
      const img = d && d.querySelector("img");
      window.__print.size = img ? `${img.style.width} x ${img.style.height}` : "";
      /* A digest of the PIXELS being sent, so "the proof was applied" can be
         checked by the image changing rather than by the toggle's own say-so. */
      const src = (img && img.getAttribute("src")) || "";
      let h = 0;
      for (let i = 0; i < src.length; i++) h = (Math.imul(h, 31) + src.charCodeAt(i)) >>> 0;
      window.__print.srcHash = `${h.toString(36)}.${src.length}`;
    };
  };
  const orig = Node.prototype.appendChild;
  Node.prototype.appendChild = function patched(node) {
    const out = orig.call(this, node);
    if (node instanceof HTMLIFrameElement) {
      try {
        capture(node);
      } catch {
        /* never let the page's own appendChild throw because of the harness */
      }
    }
    return out;
  };
};

(async () => {
  const browser = await launchBrowser();
  const page = await (await browser.newContext({ viewport: { width: 1500, height: 950 } })).newPage();
  await page.addInitScript(HOOK);
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  /* Escape first and retry: a menu left open from a previous step swallows the
     click that should open the next one, which cost a run to find. */
  const menu = async (a, b) => {
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(250);
      await page.getByText(a, { exact: true }).first().click();
      const up = await page.waitForSelector('[role="menu"]', { timeout: 2500 }).then(() => true).catch(() => false);
      if (!up) continue;
      await page.waitForTimeout(200);
      // A plain string is a substring match, which every label here is safe for
      // and avoids escaping a regex for menu items that contain "…".
      const item = page.locator('[role="menu"] button').filter({ hasText: b }).first();
      if (!(await item.count())) {
        await page.keyboard.press("Escape");
        continue;
      }
      await item.click();
      await page.waitForTimeout(800);
      return true;
    }
    return false;
  };

  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const t = await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 }).catch(() => null);
  if (t) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(700);

  // A document with a known, non-square size so a swapped axis cannot hide.
  await menu("File", "New…");
  const nd = page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.waitFor({ timeout: 8000 });
  await nd.locator('input[type="number"]').nth(0).fill(String(DOC_W));
  await nd.locator('input[type="number"]').nth(1).fill(String(DOC_H));
  await nd.getByText("Create", { exact: true }).click();
  await page.waitForTimeout(1500);

  /* Real colour on the page. Every geometry check works on a blank document,
     but the proof leg does not: transforming fully transparent pixels changes
     nothing, so a blank canvas makes "the proof was applied" unfalsifiable. */
  const fillDoc = async () => {
    const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await menu("Layer", "New layer");
    await page.getByRole("button", { name: /^Gradient/ }).first().click();
    await page.waitForTimeout(500);
    await page.mouse.move(box.x + 6, box.y + 6);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width - 6, box.y + box.height - 6, { steps: 10 });
    await page.mouse.up();
    await page.waitForTimeout(1100);
  };
  await fillDoc();

  const dlg = page.locator('div[role="dialog"][aria-label="Print"]');
  const openPrint = async () => {
    await menu("File", "Print…");
    await dlg.waitFor({ timeout: 8000 });
  };
  const doPrint = async () => {
    await page.evaluate(() => {
      window.__print.calls = 0;
      window.__print.css = "";
    });
    await dlg.getByText("Print…", { exact: true }).click();
    for (let i = 0; i < 40; i++) {
      const n = await page.evaluate(() => window.__print.calls);
      if (n > 0) break;
      await page.waitForTimeout(250);
    }
    return page.evaluate(() => ({ ...window.__print }));
  };
  const pageSize = (css) => {
    const m = /@page\{size:([\d.]+)pt ([\d.]+)pt/.exec(css);
    return m ? [Number(m[1]), Number(m[2])] : null;
  };
  const imgRect = (css) => {
    const m = /left:([\d.]+)pt;top:([\d.]+)pt;width:([\d.]+)pt;height:([\d.]+)pt/.exec(css);
    return m ? m.slice(1).map(Number) : null;
  };
  const near = (a, b, tol = 1) => Math.abs(a - b) <= tol;

  // ---------- 1. the dialog exists and replaces the silent print ----------
  await openPrint();
  check("File ▸ Print… opens a setup dialog rather than printing immediately",
    (await dlg.count()) === 1 && (await page.evaluate(() => window.__print.calls)) === 0);

  // ---------- 2. A4 portrait, fitted ----------
  const a4 = await doPrint();
  check("printing reaches the browser once", a4.calls === 1, `${a4.calls} call(s)`);
  const p1 = pageSize(a4.css);
  check("…on an A4 sheet, in points", p1 && near(p1[0], 595.28) && near(p1[1], 841.89), JSON.stringify(p1));
  const r1 = imgRect(a4.css);
  /* 600x300 into A4 portrait minus 10 mm margins: the width is the binding
     constraint, so the image spans the margin box and is centred vertically. */
  const boxW = 595.28 - 2 * 10 * (72 / 25.4);
  check("…with the image fitted to the margin box and centred",
    r1 && near(r1[2], boxW) && near(r1[3], boxW / 2) && near(r1[0], (595.28 - boxW) / 2),
    r1 ? `x${r1[0].toFixed(1)} y${r1[1].toFixed(1)} ${r1[2].toFixed(1)}x${r1[3].toFixed(1)}pt, box ${boxW.toFixed(1)}pt` : "no rect",
  );
  check("…and the page carries no browser margin of its own, since placement is absolute",
    /@page\{[^}]*margin:0/.test(a4.css), a4.css.slice(0, 90));

  // ---------- 3. landscape swaps the sheet ----------
  await openPrint();
  await dlg.getByText("Landscape", { exact: true }).click();
  await page.waitForTimeout(400);
  const land = await doPrint();
  const p2 = pageSize(land.css);
  check("Landscape swaps the sheet's axes", p2 && near(p2[0], 841.89) && near(p2[1], 595.28),
    `${JSON.stringify(p2)} (calls ${land.calls}, iframes hooked ${land.hooked})`);

  // ---------- 4. image-size mode prints at a true size ----------
  await openPrint();
  await dlg.getByText("Image size", { exact: true }).click();
  await page.waitForTimeout(500);
  const shown = await dlg.locator("p").last().innerText();
  const imgMode = await doPrint();
  const p3 = pageSize(imgMode.css);
  /* The document is created at 300 ppi, so 600 px is exactly 2 in = 144 pt. */
  check("Image size makes the sheet the image's true size at its resolution",
    p3 && near(p3[0], (DOC_W / 300) * 72) && near(p3[1], (DOC_H / 300) * 72),
    `${JSON.stringify(p3)} for ${DOC_W}x${DOC_H} px at 300 ppi`);
  check("…and the dialog says what resolution that lands at", /\d+ ppi/.test(shown),
    shown.replace(/\s+/g, " ").slice(0, 110));

  // ---------- 5. the margin actually moves the image ----------
  await openPrint();
  await dlg.getByText("Paper size", { exact: true }).click();
  await page.waitForTimeout(400);
  const margin = dlg.locator('input[aria-label="Margin"]').first();
  await margin.focus();
  for (let i = 0; i < 10; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(25);
  }
  const mmNow = await margin.inputValue();
  const wide = await doPrint();
  const r3 = imgRect(wide.css);
  check(`a ${mmNow} mm margin shrinks the image against the 10 mm one`,
    r1 && r3 && r3[2] < r1[2] - 1, r1 && r3 ? `${r1[2].toFixed(1)}pt -> ${r3[2].toFixed(1)}pt` : "no rects");

  // ---------- 6. the soft proof reaches the printed pixels ----------
  /* A proof is a VIEW transform: the browser's print pipeline cannot apply one,
     so if it is to appear on paper the pixels have to carry it. Proofing sRGB
     against sRGB is the identity, so the document is put into Display P3 first —
     otherwise the toggle would legitimately have nothing to do. */
  await openPrint();
  const noProofYet = await dlg.locator("text=soft proof").count();
  check("no proof toggle is offered while none is configured", noProofYet === 0, `${noProofYet} found`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);

  await page.evaluate(() => localStorage.setItem("pe-colorspace", "display-p3"));
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60000 });
  await page.waitForTimeout(1500);
  for (let i = 0; i < 3 && (await page.locator('div[role="dialog"]').count()); i++) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
  }
  await menu("View", "Proof colors");
  await page.waitForTimeout(700);
  // A fresh document with content: the reload may or may not restore the old
  // one, and a blank page would make the comparison below meaningless.
  await menu("File", "New…");
  await nd.waitFor({ timeout: 8000 });
  await nd.locator('input[type="number"]').nth(0).fill(String(DOC_W));
  await nd.locator('input[type="number"]').nth(1).fill(String(DOC_H));
  await nd.getByText("Create", { exact: true }).click();
  await page.waitForTimeout(1500);
  await fillDoc();
  await openPrint();
  const offered = (await dlg.locator("text=soft proof").count()) > 0;
  check("with a proof configured, printing offers to bake it in", offered,
    offered ? "offered" : "no toggle");
  /* Both prints are of the SAME document in the SAME session, differing only in
     the toggle. Comparing against a print taken before the reload would have
     compared two different documents and proved nothing. */
  const proofOff = await doPrint();
  await openPrint();
  if (offered) {
    await dlg.locator('button[role="switch"]').last().click();
    await page.waitForTimeout(300);
  }
  const proofOn = await doPrint();
  check("…and turning it on changes the pixels that go to the printer",
    !!proofOn.srcHash && !!proofOff.srcHash && proofOn.srcHash !== proofOff.srcHash,
    `off ${proofOff.srcHash} vs on ${proofOn.srcHash}`);

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS FAIL:", e.message);
  process.exit(1);
});
