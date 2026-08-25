/* Running out of canvas memory is reported, not composited as a blank photograph.
 *
 * THE FAILURE. WebKit enforces a per-page canvas memory budget and, past it,
 * hands back a canvas that draws, composites and reads perfectly — as
 * transparent black, for ever. No throw, no null context, no console warning.
 * The user does not see "your device ran out of room"; they see the photo they
 * just opened turn into nothing, which reads as this app having destroyed it.
 *
 * IT CANNOT BE PRODUCED HERE, and that is measured rather than assumed: this
 * harness allocated 48 canvases of 4096×4096 — 3 GB — on desktop Chromium
 * without a single failure. So the item's own check says to fake it, and that is
 * what happens below: `getImageData` is stubbed to return zeros for canvases
 * over a size, which is precisely what a failed allocation does.
 *
 * THE SENTINEL HAS TO WRITE. An empty canvas and a dead canvas read identically
 * — transparent black — and every canvas starts empty, so a read-only check can
 * never tell them apart. That is asserted here before anything else, because it
 * is the reason the sentinel costs what it costs.
 *
 * THE THRESHOLD IS TESTED IN BOTH DIRECTIONS. The sentinel is a GPU→CPU readback
 * stall of 0.7–0.8ms whatever the canvas size, and a census of a real session
 * found 20 of 27 allocations under a quarter of a megapixel. So only allocations
 * of a megapixel or more are checked. That is a real limit, not an oversight,
 * and it is asserted as one: a failure below the threshold is NOT reported, and
 * this rail says so out loud rather than leaving it to be discovered.
 *
 * Run: node tools/verify-canvas-memory.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg, dismissStartCard } = require("./lib/launch");

const VIEWPORT = { width: 1400, height: 900 };
const MESSAGE = /Your device ran out of memory[^\n]*/;

/**
 * Make canvases at or above `minPixels` behave as a failed allocation: every
 * read comes back transparent black, however much is drawn. Installed before any
 * app code runs, and dormant until a size is set.
 */
const STUB = () => {
  /* Marks canvases created WHILE ARMED, rather than deciding by size at read
     time. That distinction is the whole fidelity of the simulation: a real
     allocation failure kills the canvas that just failed, and leaves every
     buffer the app already holds working. A stub that decides by size instead
     retroactively kills the open document's buffers, and the app never gets far
     enough to allocate anything — which is exactly what happened first, and
     looked for all the world like the guard not firing. */
  window.__gqFailNew = false;
  const DEAD = Symbol("dead");
  /* A BAND, not a floor. A floor of 1 also kills the structural probe's own
     trial canvases, so the ceiling comes back unknown and the document is
     refused before the engine allocates anything — which made the
     below-threshold check vacuous and let a mutation through. A band lets the
     probe work while killing exactly the allocations under test. */
  window.__gqDeadMin = 1048576;
  window.__gqDeadMax = Infinity;
  /* The FIRST big canvas after arming is spared, and that is not a fudge — it is
     what makes this a memory test at all. Before the engine allocates anything,
     the structural pre-check from the previous item probes the requested size by
     allocating it. Kill that probe and the document is refused as structurally
     impossible and the engine never runs, which is precisely what happened on
     the first attempt here. Sparing it reproduces the real case: a size the app
     has just proven the browser CAN hold, whose actual allocation then fails. */
  window.__gqSpareBig = 1;
  const orig = document.createElement.bind(document);
  document.createElement = function (tag, ...rest) {
    const el = orig(tag, ...rest);
    if (window.__gqFailNew && String(tag).toLowerCase() === "canvas") el[DEAD] = true;
    return el;
  };
  const proto = CanvasRenderingContext2D.prototype;
  const realGet = proto.getImageData;
  proto.getImageData = function (x, y, w, h, ...rest) {
    const c = this.canvas;
    const area = c ? c.width * c.height : 0;
    if (c && c[DEAD] && area >= window.__gqDeadMin && area <= window.__gqDeadMax) {
      if (window.__gqSpareBig > 0) {
        /* Spared: this is the pre-check's own probe canvas. Un-mark it so its
           second read (the sentinel reads twice) is spared too. */
        c[DEAD] = false;
        window.__gqSpareBig--;
      } else {
        /* Exactly what a dead backing store serves: the right shape, all zeros. */
        return new ImageData(Math.max(1, w | 0), Math.max(1, h | 0));
      }
    }
    return realGet.call(this, x, y, w, h, ...rest);
  };
  /* Read a canvas as if it had just been allocated dead, for the demonstration
     that reading alone cannot tell the difference. */
  window.__gqReadAsDead = (c) => {
    c[DEAD] = true;
    const spare = window.__gqSpareBig;
    window.__gqSpareBig = 0; // this read is the demonstration, not the pre-check
    const g = c.getContext("2d", { willReadFrequently: true });
    const d = Array.from(g.getImageData(c.width - 1, c.height - 1, 1, 1).data);
    window.__gqSpareBig = spare;
    return d;
  };
};

/** An empty canvas and a dead one, read without writing. */
const READS_ARE_IDENTICAL = () => {
  const make = (draw) => {
    const c = document.createElement("canvas");
    c.width = c.height = 1200;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (draw) {
      g.fillStyle = "#ff0000";
      g.fillRect(0, 0, 1200, 1200); // drawn, and still dead
    }
    return c;
  };
  const healthy = make(false);
  const hg = healthy.getContext("2d", { willReadFrequently: true });
  const empty = Array.from(hg.getImageData(1199, 1199, 1, 1).data);
  const dead = window.__gqReadAsDead(make(true));
  return { empty, dead };
};

const TOAST = () => {
  const m = document.body.innerText.match(/Your device ran out of memory[^\n]*/);
  return m ? m[0] : null;
};

/** Make a document of the given size through the New Document dialog. */
async function newDoc(page, w, h) {
  await page.keyboard.press("Control+n");
  await page.waitForTimeout(900);
  await page.locator('[role="dialog"] input[type="number"]').nth(0).fill(String(w));
  await page.locator('[role="dialog"] input[type="number"]').nth(1).fill(String(h));
  await page.waitForTimeout(250);
  await page
    .locator('[role="dialog"] button', { hasText: /^Create$/ })
    .first()
    .click({ timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(2500);
}

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(STUB);
  const page = await context.newPage();
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

  // ============================== why the sentinel cannot just read ==========
  const reads = await page.evaluate(READS_ARE_IDENTICAL);
  check("an empty canvas and a dead one read identically",
    JSON.stringify(reads.empty) === JSON.stringify(reads.dead) &&
      reads.dead.every((v) => v === 0),
    `empty ${JSON.stringify(reads.empty)} vs dead ${JSON.stringify(reads.dead)} — so a read-only check is worthless`);

  // ====================================== nothing is cried wolf about ========
  await newDoc(page, 2000, 1500);
  check("a healthy document reports nothing",
    (await page.evaluate(TOAST)) === null, "no memory error on a working allocation");

  // ============================ the item's check: reads return zeros =========
  /* Reloaded first, because the engine REUSES its document-sized buffers: a
     second document of a different size resizes what is already there rather
     than allocating, so nothing would go through the guarded path at all. That
     cost an hour of looking in the wrong place, and it is why the failing case
     gets a fresh engine. */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  await dismissStartCard(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(800);
  /* Anything from a megapixel up is now dead — which is every document-sized
     buffer the next document allocates. */
  await page.evaluate(() => {
    window.__gqFailNew = true;
  });
  await newDoc(page, 2400, 1800);
  const toast = await page.evaluate(TOAST);
  check("a failed allocation is reported as a memory error",
    !!toast, JSON.stringify((toast ?? "").slice(0, 90)));
  check("…and the message says it was memory, not the picture",
    !!toast && /ran out of memory/i.test(toast), toast ? "names memory" : "no message");
  check("…names the size that could not be held",
    !!toast && /2,400 × 1,800/.test(toast), toast ? toast.match(/[\d,]+ × [\d,]+/)?.[0] ?? "no size" : "no message");
  check("…and tells the user what to do about it",
    !!toast && /save/i.test(toast), toast ? "suggests saving a copy" : "no message");

  // ===================================== one event, not one per buffer =======
  /* Counted at the source rather than read off the screen. The toast is a single
     slot, so five reports over-write one another and the page looks identical —
     a check on the visible text cannot tell the difference, and passed happily
     with the de-duplication removed. */
  const fires = await page.evaluate(() => window.__gqCanvasFailures ?? 0);
  check("reported once, however many buffers died", fires === 1,
    `handler fired ${fires}× for a document whose buffers all came back dead`);

  // ============ a failed allocation must not be reported as a browser limit ==
  /* Discovered by this rail refusing to pass. The structural pre-check and the
     memory sentinel are the SAME operation — write a pixel, read it back — so a
     device that is merely out of room fails the pre-check too, and the app used
     to answer "this browser cannot hold a canvas that big". That is false and
     it is the worst kind of false: permanent-sounding, when closing a tab would
     have fixed it. The side limit can still be stated definitely, because it is
     the one decided WITHOUT allocating anything. */
  const areaMsg = await page.evaluate(() => {
    window.__gqSpareBig = 0;
    window.__gqFailNew = true;
    const r = window.__gqCheckSize(3000, 3000);
    window.__gqFailNew = false;
    return r;
  });
  check("a failed allocation is not blamed on the browser",
    areaMsg.verdict === "too-many-pixels" && !/this browser (cannot|will not)/i.test(areaMsg.message),
    JSON.stringify(areaMsg.message.slice(0, 80)));
  check("…it offers the thing that might actually help",
    /closing other documents|tabs may help/i.test(areaMsg.message),
    areaMsg.message.includes("closing") ? "suggests closing documents or tabs" : "no advice");
  const sideMsg = await page.evaluate(() => window.__gqCheckSize(70000, 1));
  check("…while a side limit, which needs no allocation, stays definite",
    sideMsg.verdict === "too-wide" && /cannot hold a canvas longer/i.test(sideMsg.message),
    JSON.stringify(sideMsg.message.slice(0, 70)));

  // ======================== the threshold, asserted in both directions =======
  /* Below it, a failure is deliberately NOT detected. Saying so here is the
     point: it is a documented limit of the design, and a rail that quietly
     skipped it would let the limit be forgotten. */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  await dismissStartCard(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(800);
  await page.evaluate(() => {
    /* Dead only in the range the sentinel deliberately does not inspect: big
       enough to be a document buffer, too small to be checked. The structural
       probe's own trials (65535×1 and smaller) sit below the band and keep
       working, which is what lets the document get created at all. */
    window.__gqDeadMin = 100_000;
    window.__gqDeadMax = 1_000_000;
    window.__gqSpareBig = 1; // the pre-check's probe, again
    window.__gqFailNew = true;
  });
  await newDoc(page, 800, 600);
  const smallFires = await page.evaluate(() => window.__gqCanvasFailures ?? 0);
  check("a failure below the threshold is knowingly not reported",
    (await page.evaluate(TOAST)) === null && smallFires === 0,
    `handler fired ${smallFires}× — the accepted limit: a device that cannot allocate 4 MB has already lost the tab`);

  // ================== and the sentinel does not damage what it inspects ======
  /* It writes a pixel to test the canvas. If it did not put it back, every
     document would carry a red dot in its bottom-right corner. */
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  await dismissStartCard(page);
  await page.waitForTimeout(800);
  await newDoc(page, 1600, 1200);
  const corner = await page.evaluate(() => {
    const c = [...document.querySelectorAll("canvas")].find((x) => x.width === 1600 && x.height === 1200);
    if (!c) return null;
    const g = c.getContext("2d", { willReadFrequently: true });
    return Array.from(g.getImageData(1599, 1199, 1, 1).data);
  });
  check("the sentinel leaves no mark on the document it checked",
    !!corner && corner[3] === 0,
    corner ? `far corner reads ${JSON.stringify(corner)}` : "no 1600×1200 canvas found");

  await context.close();
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
