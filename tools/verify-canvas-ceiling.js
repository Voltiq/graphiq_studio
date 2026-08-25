/* Documents that cannot exist are refused, with a sentence, instead of opening blank.
 *
 * THE FAILURE THIS PREVENTS, reproduced in the rail itself so the reason cannot
 * rot away from the code: past the browser's canvas limits nothing throws.
 * `canvas.width` reports the size you asked for, `getContext` returns a working
 * context, `fillRect` is accepted, and `getImageData` SUCCEEDS — returning
 * zeros. Before this item a 20 KB file declaring itself 70000×100 opened as a
 * document with a tab, a name, two canvases and not one pixel in it, with an
 * empty console. There was no way for a user to read that as anything but the
 * app destroying their picture.
 *
 * THE CHECK the item names is "a document one pixel over the probed limit", and
 * that is exactly what the fixtures are: 65535×1 and 65536×1, one at Chromium's
 * side limit and one a single pixel past it, 275 bytes each. The pair is the
 * strongest form of the assertion — the same file, the same path, the same
 * everything, differing by one pixel and by whether the app lets it through.
 *
 * WHY THE PROBE IS SPLIT IN TWO is asserted here too, because it is the whole
 * design. Finding the side limit is cheap (binary search at a height of 1: 256 KB
 * a trial, 1.5ms in total) and happens at boot. Finding the area limit is not —
 * it needs one successful allocation the size of the ceiling, measured at 212ms
 * and a transient 1 GB — so it is never done at boot, and `provenArea === 0`
 * after start-up is how that is proven rather than promised.
 *
 * Run: node tools/verify-canvas-ceiling.js [--url ...] [--channel ...]
 */
const path = require("path");
const { launchBrowser, urlArg, dismissStartCard } = require("./lib/launch");

const VIEWPORT = { width: 1400, height: 900 };
const FIX = (n) => path.join(__dirname, "fixtures", n);

/** An independent search for the side limit, owing nothing to the app's own. */
const INDEPENDENT_SIDE = () => {
  const holds = (w, h) => {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    if (c.width !== w || c.height !== h) return false;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return false;
    g.fillStyle = "#ff0000";
    g.fillRect(w - 1, h - 1, 1, 1);
    const d = g.getImageData(w - 1, h - 1, 1, 1).data;
    const ok = d[0] === 255 && d[3] === 255;
    c.width = c.height = 0;
    return ok;
  };
  let lo = 1;
  let hi = 1 << 17;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (holds(mid, 1)) lo = mid;
    else hi = mid - 1;
  }
  return lo;
};

/** The silent failure, shown rather than described. */
const SILENT_FAILURE = (side) => {
  const w = side + 1;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = 1;
  let threw = null;
  let alpha = null;
  let ctxOk = false;
  try {
    const g = c.getContext("2d");
    ctxOk = !!g;
    g.fillStyle = "#ff0000";
    g.fillRect(0, 0, 1, 1);
    alpha = g.getImageData(0, 0, 1, 1).data[3];
  } catch (e) {
    threw = e.name;
  }
  return { reportedWidth: c.width, asked: w, ctxOk, threw, alpha };
};

/** Everything about the document state that a refusal must leave untouched. */
const STATE = () => ({
  tabs: [...document.querySelectorAll("[data-tabs] button")].map((b) => b.textContent.trim()).filter(Boolean),
  oversized: [...document.querySelectorAll("canvas")]
    .filter((c) => c.width > 65535 || c.height > 65535)
    .map((c) => `${c.width}x${c.height}`),
  canvases: [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height}`),
});

/** Drive one image file all the way through the import dialog as a new canvas. */
async function importAsCanvas(page, file) {
  await page.locator('input[type="file"][accept*="image/*"]').first().setInputFiles(file);
  await page.waitForTimeout(2000);
  const dlg = page.locator('[role="dialog"]');
  if (await dlg.count()) {
    await dlg.getByText("New canvas", { exact: false }).first().click().catch(() => {});
    await page.waitForTimeout(400);
    await dlg
      .locator("button", { hasText: /^Import$/ })
      .last()
      .click({ timeout: 4000 })
      .catch(() => {});
  }
  await page.waitForTimeout(2200);
}

/** Whatever refusal text is currently on screen. */
const MESSAGE = () => {
  const m = document.body.innerText.match(/This (?:image|document|canvas) is [^\n]*/);
  return m ? m[0] : null;
};

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e).slice(0, 160)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text().slice(0, 160)));

  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const tour = await page
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  await dismissStartCard(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(600);

  // ================================================= why this exists at all ==
  const side = await page.evaluate(INDEPENDENT_SIDE);
  const silent = await page.evaluate(SILENT_FAILURE, side);
  check("an over-limit canvas keeps the size it was asked for",
    silent.reportedWidth === silent.asked, `asked ${silent.asked}, reports ${silent.reportedWidth}`);
  check("…hands back a context and accepts drawing, without throwing",
    silent.ctxOk === true && silent.threw === null, `threw: ${silent.threw ?? "nothing"}`);
  check("…and reads back as fully transparent — the silent failure",
    silent.alpha === 0, `alpha at (0,0) after a red fillRect: ${silent.alpha}`);

  // ================================================= what the app probed ==
  const ceiling = await page.evaluate(() => window.__gqCeiling?.() ?? null);
  check("the app probed a side limit", !!ceiling && ceiling.maxSide > 0,
    ceiling ? `maxSide ${ceiling.maxSide}` : "no __gqCeiling hook");
  check("…and it agrees with an independent search",
    ceiling && ceiling.maxSide === side, `app ${ceiling?.maxSide} vs independent ${side}`);

  /* The expensive half deliberately not done. Proving an area requires
     allocating it, so a non-zero provenArea at boot IS the 1 GB allocation. */
  check("the boot probe allocated nothing large",
    ceiling && ceiling.provenArea === 0,
    `provenArea ${ceiling?.provenArea} — anything above 0 means an area was allocated to prove it`);

  // ------------------------------------------- the decision, without the UI
  const atLimit = await page.evaluate((s) => window.__gqCheckSize(s, 1), side);
  const oneOver = await page.evaluate((s) => window.__gqCheckSize(s + 1, 1), side);
  check("a size at the limit is accepted", atLimit.ok === true, `${side}×1 → ${atLimit.verdict}`);
  check("…and one pixel over is refused", oneOver.ok === false, `${side + 1}×1 → ${oneOver.verdict}`);
  check("…with a message naming both the size and the limit",
    oneOver.message.includes((side + 1).toLocaleString("en-US")) &&
      oneOver.message.includes(side.toLocaleString("en-US")),
    JSON.stringify(oneOver.message.slice(0, 90)));

  // ==================================== the item's check, through the real UI ==
  const before = await page.evaluate(STATE);

  /* One pixel UNDER: the control. If this did not open, a rail that only tested
     the refusal would pass just as well with the app refusing everything. */
  await importAsCanvas(page, FIX("size-65535x1.png"));
  const afterOk = await page.evaluate(STATE);
  check("a document exactly at the limit opens",
    afterOk.tabs.length === before.tabs.length + 1,
    `${before.tabs.length} tabs → ${afterOk.tabs.length}`);
  check("…and the engine really allocated it",
    afterOk.canvases.includes("65535x1"),
    afterOk.canvases.filter((c) => c.startsWith("65535")).join(", ") || "no 65535-wide canvas");
  /* Allocated is not the same as holding pixels — that is the whole lesson. */
  const ink = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].find((x) => x.width === 65535 && x.height === 1);
    if (!c) return null;
    try {
      const g = c.getContext("2d", { willReadFrequently: true });
      return g.getImageData(c.width - 1, 0, 1, 1).data[3];
    } catch (e) {
      return "throw:" + e.name;
    }
  });
  check("…and it holds pixels at its far edge", ink === 255, `alpha at x=65534: ${ink}`);

  /* One pixel OVER: the item's check. */
  const beforeOver = await page.evaluate(STATE);
  await importAsCanvas(page, FIX("size-65536x1.png"));
  const afterOver = await page.evaluate(STATE);
  const msg = await page.evaluate(MESSAGE);
  check("a document ONE PIXEL over the probed limit is refused",
    afterOver.tabs.length === beforeOver.tabs.length,
    `${beforeOver.tabs.length} tabs → ${afterOver.tabs.length}`);
  check("…with a message rather than in silence", !!msg, JSON.stringify((msg ?? "").slice(0, 100)));
  check("…that names the size the user chose", !!msg && msg.includes("65,536"), msg ? "names 65,536" : "no message");
  check("…and no blank canvas is left behind",
    afterOver.oversized.length === 0, afterOver.oversized.join(", ") || "no canvas over the limit");

  /* And the size that started all this. */
  const beforeBig = await page.evaluate(STATE);
  await importAsCanvas(page, FIX("size-70000x100.png"));
  const afterBig = await page.evaluate(STATE);
  check("the 20 KB file that used to open blank is refused",
    afterBig.tabs.length === beforeBig.tabs.length && afterBig.oversized.length === 0,
    `${beforeBig.tabs.length} tabs → ${afterBig.tabs.length}, ${afterBig.oversized.length} oversized canvases`);

  // ====================================== the dialogs cap from the same probe ==
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(900);
  const caps = await page.evaluate(() =>
    [...document.querySelectorAll('[role="dialog"] input[type="number"]')]
      .map((i) => i.getAttribute("max"))
      .filter(Boolean),
  );
  check("New Document caps its fields from the probe, not a constant",
    caps.length >= 2 && caps.slice(0, 2).every((m) => Number(m) === Math.min(8192, side)),
    `max=${caps.slice(0, 2).join(",")} with a probed side limit of ${side}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(500);

  /* No false refusals: the guard must be invisible for ordinary work. */
  const okBefore = await page.evaluate(STATE);
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(900);
  await page.locator('[role="dialog"] input[type="number"]').nth(0).fill("4000");
  await page.locator('[role="dialog"] input[type="number"]').nth(1).fill("3000");
  await page.waitForTimeout(300);
  await page
    .locator('[role="dialog"] button', { hasText: /^Create$/ })
    .first()
    .click({ timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(2000);
  const okAfter = await page.evaluate(STATE);
  check("an ordinary 4000×3000 document is untouched by any of this",
    okAfter.tabs.length === okBefore.tabs.length + 1 && okAfter.canvases.includes("4000x3000"),
    `${okBefore.tabs.length} tabs → ${okAfter.tabs.length}`);

  // ============================ sizes that arrive from storage, not from a file ==
  /* Preferences are read back with a plain spread — no validation — so a stored
     default size is as untrusted as a file. This is the path that makes the
     New Document guard reachable at all: the dialog caps its own fields, but
     "don't ask, just use my default" never goes near them. */
  const projBefore = await page.evaluate(STATE);
  const badProject = JSON.stringify({
    format: "graphiq-project",
    version: 24,
    name: "impossible",
    width: 70000,
    height: 100,
    layers: [],
  });
  await page.locator('input[type="file"][accept*="gproj"]').first().setInputFiles({
    name: "impossible.gproj",
    mimeType: "application/json",
    buffer: Buffer.from(badProject, "utf8"),
  });
  await page.waitForTimeout(2200);
  const projAfter = await page.evaluate(STATE);
  check("a project file declaring an impossible size is refused",
    projAfter.tabs.length === projBefore.tabs.length && projAfter.oversized.length === 0,
    `${projBefore.tabs.length} tabs → ${projAfter.tabs.length}`);
  check("…and says so", !!(await page.evaluate(MESSAGE)),
    JSON.stringify(((await page.evaluate(MESSAGE)) ?? "").slice(0, 80)));

  /* A stored default bigger than the browser allows, then File ▸ New with the
     "ask" preference off, which goes straight to creating the document. */
  await page.evaluate(() => {
    const KEY = "graphiq:preferences";
    const cur = JSON.parse(localStorage.getItem(KEY) || "{}");
    localStorage.setItem(KEY, JSON.stringify({ ...cur, newDocAsk: false, newDocWidth: 70000, newDocHeight: 100 }));
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  await dismissStartCard(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(900);
  const prefBefore = await page.evaluate(STATE);
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(1800);
  const prefAfter = await page.evaluate(STATE);
  check("a stored default size the browser cannot hold is refused too",
    prefAfter.tabs.length === prefBefore.tabs.length && prefAfter.oversized.length === 0,
    `${prefBefore.tabs.length} tabs → ${prefAfter.tabs.length}, ${prefAfter.oversized.length} oversized`);
  check("…rather than opening a document with no pixels in it",
    !!(await page.evaluate(MESSAGE)),
    JSON.stringify(((await page.evaluate(MESSAGE)) ?? "").slice(0, 80)));

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await context.close();
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
