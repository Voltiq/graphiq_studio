/* The overlay loop stops animating when nobody is looking, without losing the picture.
 *
 * MEASURED BEFORE: a selection left alone re-armed `requestAnimationFrame`
 * **722 times in three seconds** — 241 a second — and did it again for the next
 * three, and would have done it for as long as the selection existed. The ants
 * were genuinely marching: the painted pixel count drifted from 1421 to 1317 as
 * the dashes moved. On a phone that is a frame of work every four milliseconds
 * to animate a dashed line, and the heat it makes is repaid by the next edit
 * running slower.
 *
 * THE DISTINCTION THAT MATTERS: parked is not stopped. The loop's existing exit
 * CLEARS the overlay, which is right when there is nothing to show and would
 * erase the selection outline when there is. So the checks below assert both
 * halves — no frames AND the outline still on screen, unchanged — because a
 * "fix" that simply stopped the loop would pass the first and fail the user.
 *
 * Run: node tools/verify-ants-idle.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg, dismissStartCard } = require("./lib/launch");

const VIEWPORT = { width: 1400, height: 900 };
/* The loop parks after 2s idle, so waiting 2.6s puts us safely past it. */
const PARK_WAIT = 2600;

/** Count rAF callbacks, and see what is painted on the overlays. */
const PROBE = () => {
  window.__raf = 0;
  const orig = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = function (cb) {
    return orig((t) => {
      window.__raf++;
      return cb(t);
    });
  };
  /* The most-painted overlay: the grid one is empty, the ants one is not.
     Returns a COUNT and a CHECKSUM, because the count alone cannot see motion:
     marching ants shift the phase of a 4-on-4-off dash, and the number of lit
     pixels is the same at most phases. The first version of this file asserted
     on the count and reported "1317 → 1317, so the dashes have moved", which is
     both self-contradictory and wrong. The checksum is position-weighted, so a
     pattern that has shifted by a pixel cannot collide with itself. */
  window.__ants = () => {
    let best = { painted: 0, sum: 0 };
    for (const ov of [...document.querySelectorAll("canvas")].filter((c) =>
      /overlay/i.test(c.className),
    )) {
      try {
        const d = ov.getContext("2d").getImageData(0, 0, ov.width, ov.height).data;
        let n = 0;
        let sum = 0;
        for (let i = 3, px = 0; i < d.length; i += 4, px++) {
          if (d[i] > 0) {
            n++;
            sum = (sum + px * 31 + d[i]) % 2147483647;
          }
        }
        if (n > best.painted) best = { painted: n, sum };
      } catch {
        /* a dead or tainted canvas is not the overlay we are after */
      }
    }
    return best;
  };
};

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const browser = await launchBrowser();
  const context = await browser.newContext({ viewport: VIEWPORT });
  await context.addInitScript(PROBE);
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
  await dismissStartCard(page);
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.keyboard.press("Control+Shift+N");
  await page.waitForTimeout(1400);

  /** rAF callbacks over `ms`, plus what is painted at the end of it. */
  const sample = async (ms) => {
    await page.evaluate(() => {
      window.__raf = 0;
    });
    await page.waitForTimeout(ms);
    return page.evaluate(() => ({ raf: window.__raf, ants: window.__ants() }));
  };

  // ============================ nothing to show: the loop was already right ==
  const empty = await sample(1500);
  check("with nothing on the overlay the loop does not run at all",
    empty.raf === 0 && empty.ants.painted === 0,
    `${empty.raf} rAF, ${empty.ants.painted} painted px`);

  // ================================================== make a selection ========
  await page.keyboard.press("m");
  await page.waitForTimeout(500);
  const box = await page.locator('[data-tour="canvas"]').boundingBox();
  await page.mouse.move(box.x + box.width / 2 - 100, box.y + box.height / 2 - 80);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2 + 80, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(300);

  /* While the user is actually there, the ants march — that is the whole point
     of them, and a fix that killed the animation outright would be wrong. */
  const fresh = await sample(700);
  check("a selection just made does animate",
    fresh.raf > 20 && fresh.ants.painted > 0,
    `${fresh.raf} rAF in 700ms, ${fresh.ants.painted} painted px`);

  // ========================================= left alone, it stops animating ==
  await page.waitForTimeout(PARK_WAIT);
  const parked = await sample(3000);
  check("left alone, the loop stops — the item's check",
    parked.raf === 0,
    `${parked.raf} rAF over 3s, against 722 before this change`);
  check("…and stays stopped",
    (await sample(3000)).raf === 0, "a second 3s window, still nothing");

  /* The half a naive fix would get wrong. */
  check("…while the selection outline is still on screen",
    parked.ants.painted > 0, `${parked.ants.painted} painted px — parked, not cleared`);

  const before = parked.ants;
  const stillThere = await page.evaluate(() => window.__ants());
  check("…and has stopped MOVING, not just stopped being redrawn",
    stillThere.sum === before.sum && stillThere.painted === before.painted,
    `the same ${before.painted} pixels in the same places — the dashes are frozen`);

  // ================================================= and it comes straight back ==
  await page.mouse.move(box.x + 320, box.y + 300);
  const woken = await sample(800);
  check("one movement of the pointer brings it back",
    woken.raf > 20, `${woken.raf} rAF in 800ms`);
  /* Motion, by the checksum rather than the count. */
  check("…and the ants are marching again",
    woken.ants.painted > 0 && woken.ants.sum !== before.sum,
    `the pattern changed (${before.painted} px → ${woken.ants.painted} px, checksum moved), ` +
      `so the dashes are travelling`);

  // ============================================ a keystroke wakes it as well ==
  await page.waitForTimeout(PARK_WAIT);
  const reparked = await sample(1500);
  check("it parks again after the next quiet spell", reparked.raf === 0, `${reparked.raf} rAF`);
  await page.keyboard.press("Shift");
  const keyed = await sample(800);
  check("…and a key wakes it, not only the mouse",
    keyed.raf > 20, `${keyed.raf} rAF in 800ms after one keypress`);

  // ==================================== the background tab keeps its overlay ==
  /* A hidden tab has nothing to animate for. The browser throttles rAF there in
     any case, so what is worth checking is ours: that the overlay survives the
     round trip rather than being cleared on the way out. */
  const other = await context.newPage();
  await other.goto("about:blank");
  await other.bringToFront();
  await page.waitForTimeout(1200);
  await page.bringToFront();
  await page.waitForTimeout(400);
  const back = await page.evaluate(() => window.__ants());
  check("coming back from a background tab, the selection is still drawn",
    back.painted > 0, `${back.painted} painted px after the tab was hidden and shown`);
  await other.close();

  // ================================== deselecting still clears, as it always did ==
  await page.keyboard.press("Control+d");
  await page.waitForTimeout(1200);
  const cleared = await page.evaluate(() => window.__ants());
  check("deselecting still clears the overlay",
    cleared.painted === 0, `${cleared.painted} painted px`);

  check("no console errors throughout", errors.length === 0,
    errors.slice(0, 3).join(" | ") || "clean");

  await context.close();
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
