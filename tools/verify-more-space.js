/* "More space" offers only what the platform can actually do.
 *
 * The rule is one sentence — never show an option that would do nothing — and
 * the failure it prevents is specific: a button that a user presses, that does
 * not visibly fail, and that simply has no effect. That teaches them the app is
 * broken, when the truth is that the platform reserves the thing.
 *
 * The four platforms the item names are all reachable from a desktop, and none
 * of them is faked:
 *
 *   NOT INSTALLED — an ordinary context. Fullscreen is real here and is entered
 *   and left for real, both directions asserted on `document.fullscreenElement`.
 *
 *   INSTALLED — `--app=<url>` in a persistent context. Chrome's app window puts
 *   the page in `display-mode: standalone` for real; nothing is emulated, which
 *   matters because CDP's `Emulation.setEmulatedMedia` silently ignores
 *   `display-mode` (it applies `prefers-color-scheme` from the same call, so a
 *   harness built on it would have passed while testing nothing).
 *
 *   NO FULLSCREEN — an iframe with `allow="fullscreen 'none'"`. That is a real
 *   Permissions Policy denial arriving down the same `document.fullscreenEnabled`
 *   channel that iPhone Safari uses to say the same thing. (An iframe without
 *   `allowfullscreen` is NOT enough any more: the feature's default allowlist is
 *   `self`, so a same-origin frame still reports true.)
 *
 *   IOS SAFARI — the above, in a context with an iPhone user agent: the exact
 *   pair of facts a real iPhone reports, and the one case where the honest
 *   answer is no buttons at all.
 *
 * The install prompt is the one thing that cannot be produced HERE: Chrome
 * fires `beforeinstallprompt` only outside incognito, and every context in this
 * file is one. (It fires perfectly well with no service worker — see
 * `verify-installable.js`, which drives a real profile and watches the real
 * event.) So it is dispatched as a real event into the real listener, and the
 * capture, the storage, the single use and the disappearance afterwards are all
 * the product's own code.
 *
 * Run: node tools/verify-more-space.js [--url ...] [--channel ...]
 */
const { chromium } = require("playwright-core");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { launchBrowser, channelArg, urlArg } = require("./lib/launch");

const DESKTOP = { width: 1400, height: 900 };
const PHONE = { width: 390, height: 844 };
const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 " +
  "(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

/** What the panel is offering, as a person would read it. */
const OFFER = () => {
  const d = document.querySelector("[data-more-space]");
  if (!d) return null;
  const vis = (e) => e.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
  return {
    actions: [...d.querySelectorAll("[data-space-action]")]
      .filter(vis)
      .map((e) => e.getAttribute("data-space-action")),
    hints: [...d.querySelectorAll("[data-space-hint]")]
      .filter(vis)
      .map((e) => e.getAttribute("data-space-hint")),
    /* Every button must say something and be big enough to press. */
    buttons: [...d.querySelectorAll("[data-space-action]")].map((e) => {
      const r = e.getBoundingClientRect();
      return { text: e.textContent.trim(), w: Math.round(r.width), h: Math.round(r.height) };
    }),
    words: d.innerText.trim().replace(/\s+/g, " ").length,
  };
};

/** Open the panel from the View menu — the one control, where a user finds it. */
async function openFromMenu(frame) {
  const clickMenu = async () => {
    await frame
      .locator("[data-menubar] > div > button", { hasText: /^View$/ })
      .first()
      .click()
      .catch(() => {});
    await frame.page().waitForTimeout(350);
    return frame.evaluate(
      () =>
        [...document.querySelectorAll("[data-menubar] > div > button")]
          .find((x) => x.getAttribute("data-active") === "true")
          ?.textContent.trim() === "View",
    );
  };
  if (!(await clickMenu())) await clickMenu();
  const row = frame.locator('[data-menubar] [role="menu"] button', { hasText: "More space" }).first();
  if (!(await row.count())) return false;
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.click({ timeout: 4000 }).catch(() => {});
  await frame.page().waitForTimeout(500);
  return (await frame.locator("[data-more-space]").count()) > 0;
}

/** Open it the way a phone user does — through the palette, which is a fallback
    route that also proves the new action reached the command list. */
async function openFromPalette(frame) {
  await frame.locator('button[aria-label="Open the command palette"]').first().click();
  await frame.page().waitForTimeout(400);
  const input = frame.locator('input[aria-label="Search commands"]');
  await input.fill("More space");
  await frame.page().waitForTimeout(400);
  const hit = frame.locator('[role="option"]').first();
  if (!(await hit.count())) return false;
  await hit.click({ timeout: 4000 }).catch(() => {});
  await frame.page().waitForTimeout(500);
  return (await frame.locator("[data-more-space]").count()) > 0;
}

/* Press one of the offered actions. A button that is not there is reported by
   the check that asked for it, rather than stopping the run 30 seconds later on
   a locator timeout. */
async function press(where, action, wait = 800) {
  await where
    .locator(`[data-space-action="${action}"]`)
    .click({ timeout: 4000 })
    .catch(() => {});
  await (where.page ? where.page() : where).waitForTimeout(wait);
}

async function closePanel(frame) {
  await frame.locator("[data-more-space] footer button").first().click().catch(() => {});
  await frame.page().waitForTimeout(350);
}

/** Settle a freshly loaded app: past the tour, past the start card. */
async function settle(page, frame = page) {
  await frame.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  const tour = await frame
    .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
    .catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  const blank = frame.locator('[data-start="blank"]');
  if (await blank.count()) {
    await blank.click().catch(() => {});
    await page.waitForTimeout(600);
  }
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
  await page.waitForTimeout(500);
}

(async () => {
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];
  const watch = (page) => {
    page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  };

  const browser = await launchBrowser();

  // =========================================================== not installed ==
  const context = await browser.newContext({ viewport: DESKTOP });
  const page = await context.newPage();
  watch(page);
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await settle(page);

  check("View ▸ More space… opens the panel", await openFromMenu(page.mainFrame()));

  const plain = await page.evaluate(OFFER);
  /* A desktop browser can go fullscreen and cannot be asked to install without
     a prompt it has never fired. One button, nothing else. */
  check("an ordinary browser is offered fullscreen and nothing else",
    plain && JSON.stringify(plain.actions) === '["fullscreen"]',
    plain ? `actions [${plain.actions}]` : "no panel");
  check("…no install button without a prompt to fire",
    plain && !plain.actions.includes("install"),
    "beforeinstallprompt has not fired: nothing to offer");
  check("…and no hints, because the action says it all",
    plain && plain.hints.length === 0, `hints [${plain?.hints}]`);
  check("…the button is labelled and pressable",
    plain && plain.buttons.every((b) => b.text.length > 3 && b.h >= 28 && b.w > 100),
    plain ? plain.buttons.map((b) => `"${b.text}" ${b.w}×${b.h}`).join(", ") : "");

  // -------------------------------------------- fullscreen, actually entered
  await press(page, "fullscreen");
  const inFs = await page.evaluate(() => document.fullscreenElement?.tagName ?? null);
  check("pressing it really enters fullscreen", inFs === "HTML", `fullscreenElement = ${inFs}`);
  const whileFs = await page.evaluate(OFFER);
  /* The offer is live: it must now name the way out, and must not offer to do
     again the thing that is already done. */
  check("…and the panel flips to the way out",
    whileFs && JSON.stringify(whileFs.actions) === '["exit-fullscreen"]',
    `actions [${whileFs?.actions}]`);

  await press(page, "exit-fullscreen");
  const left = await page.evaluate(() => !!document.fullscreenElement);
  check("pressing that really leaves it", left === false, `fullscreenElement = ${left}`);
  const afterFs = await page.evaluate(OFFER);
  check("…and the panel flips back", afterFs && JSON.stringify(afterFs.actions) === '["fullscreen"]',
    `actions [${afterFs?.actions}]`);
  await closePanel(page.mainFrame());

  // ------------------------------------------------ the install prompt fires
  /* Chrome will not fire this without a service worker, so it is dispatched
     into the app's own listener as a real, cancellable event. Everything after
     this line — capturing it, keeping it, spending it once — is the product. */
  await page.evaluate(() => {
    window.__gqPrompted = 0;
    const e = new Event("beforeinstallprompt", { cancelable: true });
    e.prompt = () => {
      window.__gqPrompted++;
      return Promise.resolve({ outcome: "accepted" });
    };
    window.dispatchEvent(e);
    window.__gqDefaultPrevented = e.defaultPrevented;
  });
  await page.waitForTimeout(400);
  check("the app swallows the browser's own install bar",
    await page.evaluate(() => window.__gqDefaultPrevented === true),
    "preventDefault() on beforeinstallprompt");

  check("the panel opens from the command palette too", await openFromPalette(page.mainFrame()));
  const withPrompt = await page.evaluate(OFFER);
  check("a captured prompt turns Install on",
    withPrompt && withPrompt.actions[0] === "install",
    `actions [${withPrompt?.actions}]`);

  await press(page, "install");
  check("…pressing it opens the browser's install flow",
    (await page.evaluate(() => window.__gqPrompted)) === 1,
    `prompt() called ${await page.evaluate(() => window.__gqPrompted)}×`);
  const spent = await page.evaluate(OFFER);
  /* The event is good for one use whatever the user answers, so a button that
     stayed would be exactly the no-op the item forbids. */
  check("…and disappears once spent, rather than becoming a no-op",
    spent && !spent.actions.includes("install"), `actions [${spent?.actions}]`);
  await closePanel(page.mainFrame());

  // ================================= no fullscreen: a real permissions denial ==
  const FRAME = (u) => {
    const f = document.createElement("iframe");
    f.id = "gq-denied";
    f.setAttribute("allow", "fullscreen 'none'");
    f.src = u;
    f.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:99999";
    document.body.appendChild(f);
  };
  await page.evaluate(FRAME, urlArg());
  const denied = await page.waitForSelector("#gq-denied", { timeout: 10000 });
  const dframe = await denied.contentFrame();
  await settle(page, dframe);
  check("an embedded copy is really denied fullscreen",
    (await dframe.evaluate(() => document.fullscreenEnabled)) === false,
    "document.fullscreenEnabled — the same channel iPhone Safari answers on");

  check("the panel still opens there", await openFromMenu(dframe));
  const none = await dframe.evaluate(OFFER);
  check("where nothing can be done, nothing is offered",
    none && none.actions.length === 0, `actions [${none?.actions}]`);
  check("…and it says so instead of showing an empty panel",
    none && none.hints.includes("nothing-to-offer") && none.words > 60,
    `hints [${none?.hints}], ${none?.words} chars of text`);
  await page.evaluate(() => document.getElementById("gq-denied")?.remove());

  check("no console errors on the desktop route", errors.length === 0,
    errors.slice(0, 3).join(" | ") || "clean");
  await context.close();

  // ============================================================== iPhone Safari ==
  /* An iPhone reports two things: it is an iOS device, and it has no fullscreen
     at all. Both are produced here for real — the UA from the context, the
     fullscreen refusal from Permissions Policy. */
  const ios = await browser.newContext({
    viewport: PHONE,
    hasTouch: true,
    isMobile: true,
    userAgent: IPHONE_UA,
  });
  const ipage = await ios.newPage();
  const iosErrors = [];
  ipage.on("pageerror", (e) => iosErrors.push("pageerror: " + String(e)));
  ipage.on("console", (m) => m.type() === "error" && iosErrors.push("console: " + m.text()));
  await ipage.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await settle(ipage);
  await ipage.evaluate(FRAME, urlArg());
  const iel = await ipage.waitForSelector("#gq-denied", { timeout: 10000 });
  const iframe = await iel.contentFrame();
  await settle(ipage, iframe);

  /* The phone's menu bar is a sheet behind the hamburger. */
  await iframe.locator('header button[aria-label="Menu"]').first().click().catch(() => {});
  await ipage.waitForTimeout(500);
  check("the panel opens on a phone", await openFromMenu(iframe));
  const iOffer = await iframe.evaluate(OFFER);
  check("iPhone Safari is offered nothing to press",
    iOffer && iOffer.actions.length === 0, `actions [${iOffer?.actions}]`);
  /* Add to Home Screen exists on iOS and lives in Safari's own Share menu,
     which no page can open — so the honest answer is to say where it is. */
  check("…and is told where Add to Home Screen lives",
    iOffer && iOffer.hints.includes("ios-add-to-home"), `hints [${iOffer?.hints}]`);
  check("…and the panel fits the phone",
    await iframe.evaluate(() => {
      const d = document.querySelector("[data-more-space]");
      if (!d) return false;
      const r = d.getBoundingClientRect();
      return r.left >= -0.5 && r.right <= innerWidth + 0.5 && r.bottom <= innerHeight + 0.5;
    }),
    `${PHONE.width}×${PHONE.height}`);
  check("no console errors on the iPhone route", iosErrors.length === 0,
    iosErrors.slice(0, 3).join(" | ") || "clean");
  await ios.close();
  await browser.close();

  // ================================================== installed, for real ==
  /* `--app=` is Chrome's own app window: `display-mode: standalone`, exactly
     what a home-screen launch gives. */
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gq-installed-"));
  const channel = channelArg();
  const app = await chromium.launchPersistentContext(dir, {
    ...(channel === "chromium" ? {} : { channel }),
    headless: !process.env.GQ_HEADFUL,
    args: ["--app=" + urlArg()],
    viewport: DESKTOP,
  });
  const apage = app.pages()[0] ?? (await app.newPage());
  const appErrors = [];
  apage.on("pageerror", (e) => appErrors.push("pageerror: " + String(e)));
  apage.on("console", (m) => m.type() === "error" && appErrors.push("console: " + m.text()));
  if (!apage.url().startsWith(urlArg())) await apage.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await settle(apage);
  const mode = await apage.evaluate(() =>
    ["fullscreen", "standalone", "minimal-ui", "browser"].find((m) =>
      matchMedia(`(display-mode: ${m})`).matches,
    ),
  );
  check("an installed window really is standalone", mode === "standalone", `display-mode: ${mode}`);

  /* The hard case: a browser that STILL offers a prompt for a copy that is
     already installed. The display mode has to win, or the user gets a button
     that installs what they are already using. */
  await apage.evaluate(() => {
    window.__gqPrompted = 0;
    const e = new Event("beforeinstallprompt", { cancelable: true });
    e.prompt = () => {
      window.__gqPrompted++;
      return Promise.resolve({});
    };
    window.dispatchEvent(e);
  });
  await apage.waitForTimeout(400);
  check("the panel opens in the installed window", await openFromMenu(apage.mainFrame()));
  const installed = await apage.evaluate(OFFER);
  check("an installed copy is never offered installing again",
    installed && !installed.actions.includes("install"),
    `actions [${installed?.actions}] — with a prompt captured`);
  check("…it is told it already has the window",
    installed && installed.hints.includes("already-installed"), `hints [${installed?.hints}]`);
  check("…and fullscreen is still on the table",
    installed && installed.actions.includes("fullscreen"), `actions [${installed?.actions}]`);
  check("no console errors in the installed window", appErrors.length === 0,
    appErrors.slice(0, 3).join(" | ") || "clean");

  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
