/* One place that decides which browser a harness drives.
 *
 * Every tool used to hardcode `channel: "msedge"`, which is fine on the machine
 * these were written on and useless anywhere else — a CI runner has whatever it
 * has. The channel now comes from `--channel` or `$GQ_CHANNEL`, defaulting to
 * msedge so nothing changes locally.
 *
 * `playwright-core` deliberately ships no browsers: it drives an installed one.
 * So the value here has to name a real install —
 *   msedge | msedge-beta | msedge-dev | chrome | chrome-beta | chromium
 * — and "chromium" only works if a Playwright browser has been installed
 * separately (`npx playwright install chromium` with the full `playwright`
 * package). GitHub's ubuntu runners carry Chrome and Edge, so `chrome` is the
 * safe CI value and needs no download at all.
 *
 * `GQ_HEADFUL=1` opens a real window, which is the only way to watch a harness
 * misbehave when a selector has drifted.
 */
const { chromium } = require("playwright-core");

/** The channel a harness should use: `--channel X`, else $GQ_CHANNEL, else msedge. */
function channelArg(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--channel");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.GQ_CHANNEL || "msedge";
}

/** Base URL for a harness: `--url X`, else $GQ_URL, else the dev server. */
function urlArg(argv = process.argv.slice(2)) {
  const i = argv.indexOf("--url");
  if (i >= 0 && argv[i + 1]) return argv[i + 1];
  return process.env.GQ_URL || "http://localhost:3000";
}

/** Launch with the configured channel. Extra options are merged over the defaults. */
function launchBrowser(opts = {}) {
  const channel = channelArg();
  const headless = process.env.GQ_HEADFUL ? false : true;
  // "chromium" means Playwright's own build, which is selected by passing NO
  // channel at all — passing the string would send it looking for a browser
  // called "chromium" on PATH.
  const base = channel === "chromium" ? { headless } : { channel, headless };
  return chromium.launch({ ...base, ...opts });
}

/**
 * Clear the phone's start card, if it is showing.
 *
 * A fresh mobile profile opens on the launch card rather than straight onto the
 * artboard, and the card covers the canvas area — deliberately, since there is
 * nothing underneath worth touching yet. Any harness that presses the canvas on
 * a fresh load has to get past it exactly as a user does, by choosing to start
 * blank. Harnesses that make a layer first (`Control+Shift+N`) never see it,
 * which is why only some of them need this.
 *
 * A no-op on desktop, and on any state where the card is not showing.
 */
async function dismissStartCard(page) {
  const blank = page.locator('[data-start="blank"]');
  if (!(await blank.count())) return false;
  await blank.first().click();
  await page.waitForTimeout(400);
  return true;
}

/**
 * Run `fn` with the phone's options sheet open, then put it back.
 *
 * On touch a tool's controls no longer live in the options bar — they are in a
 * sheet, and the sheet is not rendered until it is opened. So a harness that
 * reaches for `input[type="range"][aria-label="Size"]` finds NOTHING on a phone
 * rather than finding it off-screen, which is a different failure from the one
 * those harnesses were written against. This is how they reach it now.
 *
 * A no-op on desktop, where the controls are in the bar as they always were.
 */
async function withOptionsSheet(page, fn) {
  const toggle = page.locator("[data-options-open]");
  const onPhone = (await toggle.count()) > 0;
  if (onPhone) {
    await toggle.first().click();
    await page.waitForTimeout(450);
  }
  try {
    return await fn();
  } finally {
    if (onPhone && (await page.locator("[data-options-sheet]").count())) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(350);
    }
  }
}

/**
 * Put the phone's panels sheet at a given height: "peek", "half" or "full".
 *
 * The panels dock is a bottom sheet with three detents and opens at "half", so
 * a harness that wants to work with a tall panel — dragging layer rows, say —
 * has to raise it first, exactly as a person would. Before this, rows below the
 * fold had off-screen boxes and every dispatched touch landed on nothing, which
 * reads as "long press does not lift a row".
 *
 * Taps the handle, which steps through the detents and wraps. A no-op on
 * desktop and anywhere the sheet is not open.
 */
async function setSheetDetent(page, want) {
  const handle = page.locator("[data-sheet-handle]");
  if (!(await handle.count())) return false;
  for (let i = 0; i < 4; i++) {
    if ((await page.evaluate(() => document.documentElement.dataset.sheet)) === want) return true;
    await handle.first().click();
    await page.waitForTimeout(420);
  }
  return (await page.evaluate(() => document.documentElement.dataset.sheet)) === want;
}

module.exports = {
  launchBrowser,
  channelArg,
  urlArg,
  dismissStartCard,
  withOptionsSheet,
  setSheetDetent,
};
