/* A committed paint-bucket fill keeps the colour it was committed with.
 *
 * MEASURED BEFORE: fill a layer red, and — with the Paint Bucket still the
 * selected tool — pick green in the Colour panel. The fill turned green.
 * `255,0,0,255` → `0,255,0,255`, with no click on the canvas, no new history
 * step, and nothing on screen to say it had happened. Switching tools did not
 * put it back; the green was now the committed pixel.
 *
 * WHY IT HAPPENED, because the feature underneath is a good one and was not the
 * bug. A bucket fill stays *live* after the click: `liveBucketRef` keeps the
 * seed so tolerance, contiguity, anti-alias and opacity can be auditioned
 * against the result, until the next action. That re-run read the foreground
 * colour from a ref at render time, and the effect that drove it listed
 * `foreground` and `background` among its dependencies — so a colour change
 * both triggered a re-run and supplied it with a new colour.
 *
 * WHY THE OBVIOUS FIX IS NOT ENOUGH, and this rail's second check exists to
 * prove it: dropping the two colours from the dependency list stops the colour
 * change from triggering a re-run, but the re-run still READS the live
 * foreground. Change the colour and then nudge tolerance, and the fill turns
 * green after all — a click further away from the cause, which is worse. So the
 * colour is frozen into the handle at the moment of the commit instead, and
 * opacity stays live because it is one of the options this feature is for.
 *
 * NON-VACUITY OF THAT CHECK: "the fill did not change colour" also passes if the
 * re-run has simply stopped happening, which would silently delete the feature.
 * So the option nudged is OPACITY, whose effect on the pixel is asserted in the
 * same breath — the fill must visibly change, and stay the committed hue.
 *
 * Run: node tools/verify-bucket-commit.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg, dismissStartCard } = require("./lib/launch");

const VIEWPORT = { width: 1400, height: 900 };

/** The document's own centre pixel, as `r,g,b,a`. */
const CENTRE = () => {
  const vp = document.querySelector('[data-tour="canvas"]');
  const c = [...vp.querySelectorAll("canvas")].find((x) => /view/i.test(x.className));
  if (!c) return null;
  const d = c.getContext("2d").getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
  return [d[0], d[1], d[2], d[3]].join(",");
};

/**
 * Drive a range input the way React hears it.
 *
 * Assigning `.value` and dispatching `input` is not enough: React installs its
 * own value setter on the prototype and reads the tracked value to decide
 * whether anything changed, so a plain assignment is swallowed and the check
 * that depended on it passes having changed nothing.
 */
const SET_RANGE = ([label, value]) => {
  const bar = document.querySelector('[data-tour="options"]');
  const el = [...bar.querySelectorAll('input[type="range"]')].find((x) =>
    new RegExp(label, "i").test(x.getAttribute("aria-label") || ""),
  );
  if (!el) return null;
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;
  setter.call(el, String(value));
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return el.value;
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
  await page.waitForTimeout(1500);

  const centre = () => page.evaluate(CENTRE);
  const setFg = (hex) => page.evaluate((h) => window.graphiq.setForeground(h), hex);
  const setRange = (label, v) => page.evaluate(SET_RANGE, [label, v]);
  const hue = (px) => (px ? px.split(",").slice(0, 3).join(",") : "");

  await page.keyboard.press("g");
  await page.waitForTimeout(400);
  const tool = await page.evaluate(
    () =>
      document
        .querySelector('[data-tour="toolbar"] [aria-pressed="true"]')
        ?.getAttribute("aria-label") ?? "?",
  );
  check("the paint bucket is the selected tool", /bucket/i.test(tool), tool);

  const box = await page.locator('[data-tour="canvas"]').boundingBox();
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  // ===================== the bug, in the words of the report =================
  const empty = await centre();
  await setFg("#ff0000");
  await page.waitForTimeout(300);
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(900);
  const filled = await centre();
  check("a bucket fill puts the foreground colour on the layer",
    filled === "255,0,0,255", `${empty} → ${filled}`);

  await setFg("#00ff00");
  await page.waitForTimeout(800);
  const afterColour = await centre();
  check("…and changing the foreground afterwards does not repaint it",
    afterColour === filled,
    `${filled} → ${afterColour}${afterColour === filled ? "" : "  (the fill followed the colour picker)"}`);

  // ============ the same thing one step removed, which a narrower fix misses ==
  /* Nudging an option re-runs the fill. If the re-run still read the live
     foreground, this is where the green would arrive. Opacity is the option on
     purpose: its effect is visible in the pixel, so "nothing changed" cannot be
     mistaken for "the fill is safe". */
  const setTo = await setRange("opacity", 40);
  await page.waitForTimeout(900);
  const afterOpacity = await centre();
  check("the fill is still live — an option re-runs it",
    setTo === "40" && afterOpacity !== null && afterOpacity !== afterColour,
    `opacity ${setTo}: ${afterColour} → ${afterOpacity}`);
  check("…and it re-runs in the colour it was committed with, not the current one",
    hue(afterOpacity) === "255,0,0",
    `${afterOpacity} — red is the committed colour, green is the one now in the picker`);

  // ================ one Undo still takes the whole fill away =================
  /* The report's own reassurance, kept true: the colour change is not a step of
     its own, so a single Undo must land on the empty canvas rather than on some
     intermediate colour. */
  await page.evaluate(() => window.graphiq.undo());
  await page.waitForTimeout(900);
  const undone = await centre();
  check("one Undo removes the fill entirely, landing where it started",
    undone === empty, `${afterOpacity} → ${undone}, and the canvas began at ${empty}`);

  // ============ the uncommitted fill is untouched — the item's second check ===
  /* Before release there is no commit to protect, and auditioning a colour is
     the point: whatever is in the picker when you let go is what lands. */
  await setRange("opacity", 100);
  await page.waitForTimeout(400);
  await setFg("#ff0000");
  await page.waitForTimeout(300);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.waitForTimeout(600);
  await setFg("#0000ff");
  await page.waitForTimeout(600);
  await page.mouse.up();
  await page.waitForTimeout(900);
  const midDrag = await centre();
  check("a fill that is not committed yet still takes the colour picked before release",
    midDrag === "0,0,255,255",
    `held the button with red selected, picked blue, released → ${midDrag}`);

  /* …and that one is now committed in its turn. */
  await setFg("#ffff00");
  await page.waitForTimeout(800);
  const midDragAfter = await centre();
  check("…and is frozen from the moment it lands",
    midDragAfter === midDrag, `${midDrag} → ${midDragAfter}`);

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
