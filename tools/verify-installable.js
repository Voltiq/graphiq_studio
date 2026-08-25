/* The service-worker decision, kept honest.
 *
 * DECIDED: no service worker. The reasoning is recorded in FEATURES.md; this
 * rail is the part that cannot rot, because it asserts the facts the decision
 * rests on rather than the prose about them.
 *
 * The decision was made on a premise that turned out to be false. The item said
 * "without one Chrome will not fire `beforeinstallprompt`, so the in-app Install
 * button cannot exist". On Chrome and Edge 151 that is simply not true: with
 * zero service workers registered the browser reports zero installability
 * errors and fires the event. The install prompt was already ours, so the trade
 * the item posed — a prompt in exchange for owning a cache-invalidation surface
 * — had nothing on one side of it.
 *
 * Why the repo believed otherwise for so long is worth a check of its own.
 * EVERY harness here drives a Playwright context, and those are incognito; the
 * sole installability error was `in-incognito`. A measurement artefact had been
 * reported as a property of the app. So this rail asserts BOTH sides: that a
 * real profile is installable, and that an incognito one is not and says why.
 *
 * The cost of declining is asserted too. An offline cold start does not reach
 * the editor, and that check is a deliberate tripwire: the day someone adds a
 * service worker it fails, and the decision gets revisited on purpose rather
 * than drifting.
 *
 * What cannot be measured here: Chrome ANDROID. The item's check names it, and
 * no harness on a desktop can produce it. Installability is decided by shared
 * Chromium code rather than per-platform rules, and it is verified here on both
 * engines — but that is inference, and it is written down as inference.
 *
 * Run: node tools/verify-installable.js [--url ...] [--channel ...]
 */
const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchBrowser, channelArg, urlArg } = require("./lib/launch");

const VIEWPORT = { width: 1400, height: 900 };

/** Settle a freshly loaded app: past the tour, past the start card. */
async function settle(page) {
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const tour = await page
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  const blank = page.locator('[data-start="blank"]');
  if (await blank.count()) {
    await blank.click().catch(() => {});
    await page.waitForTimeout(600);
  }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(600);
}

/** Open View ▸ More space… and read what it is offering. */
async function readOffer(page) {
  const clickMenu = async () => {
    await page
      .locator("[data-menubar] > div > button", { hasText: /^View$/ })
      .first()
      .click()
      .catch(() => {});
    await page.waitForTimeout(350);
    return page.evaluate(
      () =>
        [...document.querySelectorAll("[data-menubar] > div > button")]
          .find((x) => x.getAttribute("data-active") === "true")
          ?.textContent.trim() === "View",
    );
  };
  if (!(await clickMenu())) await clickMenu();
  await page
    .locator('[data-menubar] [role="menu"] button', { hasText: "More space" })
    .first()
    .click({ timeout: 4000 })
    .catch(() => {});
  await page.waitForTimeout(600);
  return page.evaluate(OFFER_NOW);
}

/** Read the panel that is already open, without touching it. */
const OFFER_NOW = () => {
  const d = document.querySelector("[data-more-space]");
  return d
    ? [...d.querySelectorAll("[data-space-action]")].map((e) => e.getAttribute("data-space-action"))
    : null;
};

const SW_STATE = async () => ({
  controller: navigator.serviceWorker?.controller ? "yes" : null,
  registrations: (await navigator.serviceWorker.getRegistrations()).length,
});

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };

  // ======================================= the capture is in the document ==
  /* Asserted against the SERVED HTML, because the whole point is that it runs
     before React exists. Anything React attaches is not in this response. */
  const html = await fetch(urlArg()).then((r) => r.text());
  const head = html.slice(0, html.indexOf("</head>"));
  check("the install prompt is caught in <head>, before anything renders",
    head.includes("beforeinstallprompt"),
    "in the document response, not attached by React");
  check("…and its default is prevented in the same tick",
    /beforeinstallprompt[\s\S]{0,200}?preventDefault/.test(head),
    "which is what suppresses the browser's own install bar");

  // ============================================ a real profile: installable ==
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gq-installable-"));
  const channel = channelArg();
  const ctx = await chromium.launchPersistentContext(dir, {
    ...(channel === "chromium" ? {} : { channel }),
    headless: !process.env.GQ_HEADFUL,
    viewport: VIEWPORT,
  });
  await ctx.addInitScript(() => {
    window.__bip = 0;
    addEventListener("beforeinstallprompt", () => {
      window.__bip++;
    });
  });
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Page.enable").catch(() => {});
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.waitForTimeout(2500);

  // ----------------------------------------- the decision, actually in force
  const sw = await page.evaluate(SW_STATE);
  check("no service worker is registered", sw.registrations === 0,
    `${sw.registrations} registrations`);
  check("…and none controls the page", sw.controller === null,
    `navigator.serviceWorker.controller = ${sw.controller}`);

  // ------------------------------------- and the app is installable anyway
  /* Deprecated CDP, so it is diagnosis rather than the assertion: if it goes
     away the event below still decides the question. */
  let installErrs = null;
  try {
    installErrs = (await cdp.send("Page.getInstallabilityErrors")).installabilityErrors;
  } catch {
    installErrs = null;
  }
  if (installErrs) {
    check("the browser finds nothing wrong with installing it",
      installErrs.length === 0,
      installErrs.length ? JSON.stringify(installErrs) : "no installability errors, with no service worker");
  } else {
    console.log("NOTE  Page.getInstallabilityErrors is gone; relying on the event alone");
  }

  /* The claim the item got wrong, asserted directly. */
  check("beforeinstallprompt fires without a service worker",
    (await page.evaluate(() => window.__bip)) >= 1,
    `fired ${await page.evaluate(() => window.__bip)}×`);
  check("…and the pre-paint script still holds it",
    (await page.evaluate(() => !!window.__gqInstall)) === true,
    "window.__gqInstall is populated");

  /* End to end, with nothing synthetic anywhere: a real browser decision, a
     real event, and the product's own button. */
  const offer = await readOffer(page);
  check("More space really offers to install it",
    offer && offer.includes("install"), `actions [${offer}]`);
  check("no console errors on the installable route", errors.length === 0,
    errors.slice(0, 3).join(" | ") || "clean");

  // ================================ the cost of declining, recorded as a check ==
  /* A TRIPWIRE, not a bug: the day a service worker is added this fails, and
     the decision gets revisited deliberately instead of drifting. */
  await ctx.setOffline(true);
  const res = await page
    .goto(urlArg(), { waitUntil: "domcontentloaded" })
    .then((r) => `status ${r?.status?.() ?? "?"}`)
    .catch((e) => e.message.split("\n")[0]);
  const reached = await page
    .waitForSelector('[data-tour="canvas"]', { timeout: 8000 })
    .then(() => true)
    .catch(() => false);
  check("a cold start with no network does not reach the editor — the accepted cost",
    reached === false, `${res.slice(0, 48)} — if this now passes, a service worker exists and FEATURES.md is stale`);
  await ctx.setOffline(false);
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });

  // ============================ why every other harness reports the opposite ==
  /* Recorded so nobody concludes from another rail that the app is not
     installable. Playwright contexts are incognito, and that alone is
     disqualifying. */
  const browser = await launchBrowser();
  const inc = await browser.newContext({ viewport: VIEWPORT });
  const ipage = await inc.newPage();
  await inc.addInitScript(() => {
    window.__bip = 0;
    addEventListener("beforeinstallprompt", () => {
      window.__bip++;
    });
  });
  const icdp = await inc.newCDPSession(ipage);
  await icdp.send("Page.enable").catch(() => {});
  await ipage.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await settle(ipage);
  await ipage.waitForTimeout(2500);
  let ierrs = null;
  try {
    ierrs = (await icdp.send("Page.getInstallabilityErrors")).installabilityErrors;
  } catch {
    ierrs = null;
  }
  if (ierrs) {
    check("an incognito context is disqualified, and says exactly that",
      ierrs.length === 1 && ierrs[0].errorId === "in-incognito",
      JSON.stringify(ierrs.map((e) => e.errorId)));
  }
  check("…so no prompt fires there — which is why the other rails never see one",
    (await ipage.evaluate(() => window.__bip)) === 0,
    "not a property of the app: a property of the harness");

  // ================== a prompt that arrives after the editor has already started ==
  /* Catching it in <head> covers the prompt that beats React to it, which is the
     ordinary case and the one the bug was about. It does NOT cover a prompt that
     arrives later — and something has to, because the editor's one read on mount
     cannot see an event that has not happened yet. This context has no real
     prompt (incognito), so a late one can be introduced and followed through.
     Without the notification the panel here stays exactly as it was. */
  const quiet = await readOffer(ipage);
  check("nothing is offered in incognito to begin with",
    quiet && !quiet.includes("install"), `actions [${quiet}]`);

  await ipage.evaluate(() => {
    const e = new Event("beforeinstallprompt", { cancelable: true });
    e.prompt = () => Promise.resolve({});
    window.dispatchEvent(e);
  });
  await ipage.waitForTimeout(600);
  const late = await ipage.evaluate(OFFER_NOW);
  check("a prompt arriving after start-up is picked up while the panel is open",
    late && late.includes("install"), `actions [${late}]`);

  /* And the reverse: once the browser says the app is installed, the button has
     to go, or it offers to install what the user is already running. */
  await ipage.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await ipage.waitForTimeout(600);
  const done = await ipage.evaluate(OFFER_NOW);
  check("…and drops away the moment the app reports itself installed",
    done && !done.includes("install"), `actions [${done}]`);

  await inc.close();
  await browser.close();

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
