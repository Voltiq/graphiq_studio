/* Correctness rail: a .gproj must reopen byte-identically, whatever working
 * colour space the session that opens it happens to be in.
 *
 *   npm i -D playwright-core && npm run dev
 *   node tools/verify-colorspace-roundtrip.js
 *
 * WHY IT EXISTS. Layer pixels are stored as PNG data URLs, and a canvas in a
 * wide-gamut space writes them with that profile attached. Until v24 the file
 * recorded no space at all, so reopening in a different one let the browser
 * colour-manage every layer on decode: measured at 27,550 of 120,000 bytes on a
 * small Display-P3 document opened as sRGB — RGB shifted, alpha untouched, which
 * is what made it read as a rendering quirk rather than a lossy reopen. The file
 * now carries `workingSpace` and the loader adopts it before anything decodes.
 *
 * HOW IT IS SET UP. Each leg saves in one space and opens in a BRAND-NEW browser
 * context whose persisted preference is a DIFFERENT one — no shared localStorage
 * or IndexedDB, so what comes back can only have come from the file. Opening in
 * the same session was never broken and is a poor test; the mismatch is the
 * whole point.
 *
 * NON-VACUITY. Byte-identity would also hold if the two spaces were secretly the
 * same, so every leg asserts that the opening session really was in the other
 * space BEFORE the file was opened, and that it ended up in the file's space
 * after. A leg where those are equal fails rather than passes quietly.
 */
const { launchBrowser, urlArg } = require("./lib/launch");
const fs = require("fs");
const path = require("path");
const os = require("os");

const DOC_W = 200;
const DOC_H = 150;
const OUT = fs.mkdtempSync(path.join(os.tmpdir(), "gq-cs-"));

/* saved-in -> opened-in. Every pair must round-trip exactly. adobe-rgb is the
   emulated space (its bytes stay on an sRGB canvas and only the adjustment maths
   changes), so it belongs here too: the file still has to say which it was. */
const LEGS = [
  { save: "display-p3", open: "srgb" },
  { save: "srgb", open: "display-p3" },
  { save: "adobe-rgb", open: "display-p3" },
];

const settle = async (p) => {
  await p.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const t = await p.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 }).catch(() => null);
  if (t) {
    await p.keyboard.press("Escape");
    await p.waitForTimeout(700);
  }
  await p.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await p.waitForTimeout(1200);
};
const menu = async (p, a, c) => {
  await p.getByText(a, { exact: true }).first().click();
  await p.waitForTimeout(250);
  await p.getByText(c, { exact: true }).first().click();
  await p.waitForTimeout(800);
};
const readDoc = (p, w) =>
  p.evaluate((width) => {
    const all = [...document.querySelectorAll(`canvas[width="${width}"]`)];
    if (!all.length) return null;
    const g = all[0].getContext("2d");
    return {
      space: g.getContextAttributes().colorSpace,
      px: Array.from(g.getImageData(0, 0, all[0].width, all[0].height).data),
    };
  }, w);
const canvasSpace = (p) =>
  p.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    return c ? c.getContext("2d").getContextAttributes().colorSpace : null;
  });
const diff = (a, b) => {
  let n = 0;
  let worst = 0;
  const chan = [0, 0, 0, 0];
  for (let i = 0; i < a.length; i++) {
    const d = Math.abs(a[i] - b[i]);
    if (!d) continue;
    n++;
    chan[i & 3]++;
    if (d > worst) worst = d;
  }
  return { n, worst, chan, total: a.length };
};

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const prime = (space) => {
    try {
      if (space) localStorage.setItem("pe-colorspace", space);
      else localStorage.removeItem("pe-colorspace");
      // The native save picker cannot be driven headless; force the download path.
      Object.defineProperty(window, "showSaveFilePicker", { value: undefined, configurable: true });
    } catch {
      /* ignore */
    }
  };

  for (const leg of LEGS) {
    const label = `${leg.save} -> opened in ${leg.open}`;

    // ---- author and save ----
    const c1 = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    const p1 = await c1.newPage();
    await p1.addInitScript(prime, leg.save);
    await p1.goto(urlArg(), { waitUntil: "domcontentloaded" });
    await settle(p1);

    await menu(p1, "File", "New…");
    const nd = p1.locator('div[role="dialog"][aria-label="New document"]');
    await nd.waitFor({ timeout: 8000 });
    await nd.locator('input[type="number"]').nth(0).fill(String(DOC_W));
    await nd.locator('input[type="number"]').nth(1).fill(String(DOC_H));
    await nd.getByText("Create", { exact: true }).click();
    await p1.waitForTimeout(1500);

    // Varied colour: a gradient ramp plus a stroke in the contrasting colour. A
    // flat fill would exercise one value, and a colour conversion is per-value.
    const box = await p1.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await menu(p1, "Layer", "New layer");
    await p1.getByRole("button", { name: /^Gradient/ }).first().click();
    await p1.waitForTimeout(500);
    await p1.mouse.move(box.x + 6, box.y + 6);
    await p1.mouse.down();
    await p1.mouse.move(box.x + box.width - 6, box.y + box.height - 6, { steps: 10 });
    await p1.mouse.up();
    await p1.waitForTimeout(1100);
    await p1.keyboard.press("b");
    await p1.waitForTimeout(300);
    await p1.locator('button[aria-label="Swap foreground and background colors"]').first().click();
    await p1.waitForTimeout(300);
    await p1.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.5);
    await p1.mouse.down();
    for (let i = 1; i <= 6; i++)
      await p1.mouse.move(box.x + box.width * (0.2 + 0.1 * i), box.y + box.height * 0.5, { steps: 2 });
    await p1.mouse.up();
    await p1.waitForTimeout(1200);

    const orig = await readDoc(p1, DOC_W);
    await p1.getByText("File", { exact: true }).first().click();
    await p1.waitForTimeout(400);
    const [dl] = await Promise.all([
      p1.waitForEvent("download", { timeout: 20000 }).catch(() => null),
      p1.locator('[role="menu"] button').filter({ hasText: /^Save/ }).first().click(),
    ]);
    if (!dl) {
      check(`${label}: the project saved`, false, "no download captured");
      await c1.close();
      continue;
    }
    const file = path.join(OUT, `${leg.save}.gproj`);
    await dl.saveAs(file);
    const stored = JSON.parse(fs.readFileSync(file, "utf8")).workingSpace;
    check(`${label}: the file records the space it was written in`, stored === leg.save,
      `workingSpace=${JSON.stringify(stored)}`);
    await c1.close();

    // ---- open it somewhere else entirely ----
    const c2 = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    const p2 = await c2.newPage();
    await p2.addInitScript(prime, leg.open);
    const errs = [];
    p2.on("pageerror", (e) => errs.push(String(e)));
    await p2.goto(urlArg(), { waitUntil: "domcontentloaded" });
    await settle(p2);

    // The opening session must genuinely be in the OTHER space, or this proves
    // nothing at all.
    const before = await canvasSpace(p2);
    const expectBefore = leg.open === "display-p3" ? "display-p3" : "srgb";
    check(`${label}: the opening session really starts in the other space`,
      before === expectBefore && before !== (leg.save === "adobe-rgb" ? "srgb" : leg.save),
      `canvas reports ${before}`);

    await p2.setInputFiles('input[accept*=".gproj"]', file);
    await p2.waitForTimeout(4000);
    const back = await readDoc(p2, DOC_W);
    if (!back) {
      check(`${label}: the document opened`, false, "no canvas at the document size");
      await c2.close();
      continue;
    }
    const d = diff(orig.px, back.px);
    check(`${label}: reopens byte-identically`, d.n === 0,
      `${d.n} of ${d.total} bytes differ (worst ${d.worst}, RGBA ${JSON.stringify(d.chan)})`);
    check(`${label}: …and adopted the file's space`, back.space === orig.space,
      `${before} -> ${back.space} (saved as ${orig.space})`);
    if (errs.length) check(`${label}: no console errors`, false, errs.slice(0, 2).join(" | "));
    await c2.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  fs.rmSync(OUT, { recursive: true, force: true });
  await browser.close();
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error("HARNESS FAIL:", e.message);
  process.exit(1);
});
