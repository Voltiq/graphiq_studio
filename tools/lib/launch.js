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

module.exports = { launchBrowser, channelArg, urlArg };
