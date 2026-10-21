/**
 * Installing, and "More space": what the platform can really do, and only that.
 * (Ported from tools/verify-installable.js and tools/verify-more-space.js,
 * TODO 2.1.)
 *
 * THE SERVICE-WORKER DECISION: there is none, and this keeps the facts it
 * rests on honest rather than the prose about them. The premise that Chrome
 * will not fire `beforeinstallprompt` without one is false on Chrome/Edge:
 * with zero workers the browser reports zero installability errors and fires
 * the event. The repo believed otherwise because every Playwright context is
 * INCOGNITO, whose one installability error is `in-incognito` — a measurement
 * artefact reported as a property of the app. So both sides are asserted: a
 * real profile is installable; an incognito one is not, and says why. The
 * cost of declining is a tripwire: an offline cold start does not reach the
 * editor, and the day a service worker exists that fails on purpose.
 *
 * MORE SPACE never shows an option that would do nothing — a button that
 * silently has no effect teaches people the app is broken. Each platform is
 * produced for real: fullscreen entered and left; an installed window via
 * Chrome's `--app` (CDP's display-mode emulation silently does nothing);
 * fullscreen denied by Permissions Policy, the channel iPhone Safari answers
 * on; and an iPhone UA on top of that.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Frame, type Page } from "@playwright/test";
import { test, expect } from "./fixtures";

test.use({ viewport: { width: 1400, height: 900 } });

type Offer = { actions: string[]; hints: string[]; buttons: { text: string; w: number; h: number }[]; words: number };

/** What the panel offers, as a person would read it. */
const offer = (where: Page | Frame) =>
  where.evaluate((): Offer | null => {
    const d = document.querySelector("[data-more-space]");
    if (!d) return null;
    const vis = (e: Element) => e.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true });
    return {
      actions: [...d.querySelectorAll("[data-space-action]")].filter(vis).map((e) => e.getAttribute("data-space-action")!),
      hints: [...d.querySelectorAll("[data-space-hint]")].filter(vis).map((e) => e.getAttribute("data-space-hint")!),
      buttons: [...d.querySelectorAll("[data-space-action]")].map((e) => {
        const r = e.getBoundingClientRect();
        return { text: e.textContent!.trim(), w: Math.round(r.width), h: Math.round(r.height) };
      }),
      words: (d as HTMLElement).innerText.trim().replace(/\s+/g, " ").length,
    };
  });

/** Settle a freshly loaded app in `frame`: past the tour, past the start card. */
async function settle(page: Page, frame: Page | Frame = page) {
  await frame.waitForSelector('[data-tour="canvas"]', { timeout: 60_000 });
  const tour = await frame.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8_000 }).catch(() => null);
  if (tour) {
    await page.keyboard.press("Escape");
    await page.waitForTimeout(700);
  }
  const blank = frame.locator('[data-start="blank"]');
  if (await blank.count()) await blank.click();
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(500);
}

/** View ▸ More space…, checking the menu that opened (a name toggles). */
async function openFromMenu(frame: Page | Frame) {
  const menuButton = frame.locator('header button[aria-label="Menu"]');
  if (await menuButton.isVisible().catch(() => false)) await menuButton.click();
  const view = frame.locator("[data-menubar] > div > button", { hasText: /^View$/ }).first();
  for (let i = 0; i < 2 && (await view.getAttribute("data-active")) !== "true"; i++) await view.click();
  const row = frame.locator('[data-menubar] [role="menu"] button', { hasText: "More space" }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await expect(frame.locator("[data-more-space]")).toHaveCount(1);
}
const closePanel = (frame: Page | Frame) => frame.locator("[data-more-space] footer button").first().click();

/** A real browser profile (not incognito), with the configured channel. */
async function profile(args: string[] = []) {
  const dir = mkdtempSync(join(tmpdir(), "gq-profile-"));
  const channel = test.info().project.use.channel;
  const ctx = await chromium.launchPersistentContext(dir, {
    ...(channel ? { channel } : {}),
    headless: !process.env.GQ_HEADFUL,
    viewport: { width: 1400, height: 900 },
    args,
  });
  return { ctx, done: async () => (await ctx.close(), rmSync(dir, { recursive: true, force: true })) };
}

test("the install prompt is caught in <head>, before anything renders", async ({ request }) => {
  /* Against the SERVED HTML: the point is that it runs before React exists. */
  const html = await (await request.get("/")).text();
  const head = html.slice(0, html.indexOf("</head>"));
  expect(head, "caught in the document").toContain("beforeinstallprompt");
  expect(head, "...and its default prevented in the same tick, suppressing the browser's own bar").toMatch(
    /beforeinstallprompt[\s\S]{0,200}?preventDefault/,
  );
});

test("a real profile, with no service worker, is installable and More space offers it — offline it cannot start", async () => {
  test.slow();
  const { ctx, done } = await profile();
  try {
    await ctx.addInitScript(() => {
      const w = window as unknown as { __bip: number };
      w.__bip = 0;
      addEventListener("beforeinstallprompt", () => w.__bip++);
    });
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    const cdp = await ctx.newCDPSession(page);
    await cdp.send("Page.enable");
    await page.goto(test.info().project.use.baseURL!, { waitUntil: "domcontentloaded" });
    await settle(page);
    await page.waitForTimeout(2500);
    const sw = await page.evaluate(async () => ({
      controlled: !!navigator.serviceWorker?.controller,
      registrations: (await navigator.serviceWorker.getRegistrations()).length,
    }));
    expect(sw, "no service worker, registered or in control").toEqual({ controlled: false, registrations: 0 });
    /* Deprecated CDP — diagnosis, not the assertion: the event decides. */
    const errs = await cdp
      .send("Page.getInstallabilityErrors" as never)
      .then((r) => (r as { installabilityErrors: { errorId: string }[] }).installabilityErrors)
      .catch(() => null);
    if (errs) expect(errs.map((e) => e.errorId), "the browser finds nothing wrong with installing it").toEqual([]);
    expect(await page.evaluate(() => (window as unknown as { __bip: number }).__bip), "beforeinstallprompt fires").toBeGreaterThanOrEqual(1);
    expect(await page.evaluate(() => !!(window as unknown as { __gqInstall?: unknown }).__gqInstall), "the pre-paint script holds it").toBe(
      true,
    );
    await openFromMenu(page);
    expect((await offer(page))!.actions, "More space really offers to install it").toContain("install");
    expect(errors, "no errors on the installable route").toEqual([]);

    /* The TRIPWIRE: the accepted cost of having no service worker. */
    await ctx.setOffline(true);
    await page.goto(test.info().project.use.baseURL!, { waitUntil: "domcontentloaded" }).catch(() => null);
    const reached = await page.waitForSelector('[data-tour="canvas"]', { timeout: 8000 }).then(() => true, () => false);
    expect(reached, "offline, a cold start does not reach the editor — if this flips, a service worker exists and the docs are stale").toBe(
      false,
    );
    await ctx.setOffline(false);
  } finally {
    await done();
  }
});

test("incognito is disqualified and says so — and a prompt arriving later is still picked up, then dropped once installed", async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __bip: number };
    w.__bip = 0;
    addEventListener("beforeinstallprompt", () => w.__bip++);
  });
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Page.enable");
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await settle(page);
  await page.waitForTimeout(2500);
  const errs = await cdp
    .send("Page.getInstallabilityErrors" as never)
    .then((r) => (r as { installabilityErrors: { errorId: string }[] }).installabilityErrors)
    .catch(() => null);
  if (errs) expect(errs.map((e) => e.errorId), "incognito, and that alone").toEqual(["in-incognito"]);
  expect(await page.evaluate(() => (window as unknown as { __bip: number }).__bip), "so no prompt — a property of the harness").toBe(0);

  await openFromMenu(page);
  expect((await offer(page))!.actions, "nothing to install at first").not.toContain("install");
  /* The <head> catch covers a prompt that beats React; one arriving later needs
     the editor told. Introduced here, where no real prompt exists. */
  await page.evaluate(() => {
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<object> };
    e.prompt = () => Promise.resolve({});
    window.dispatchEvent(e);
  });
  await expect.poll(async () => (await offer(page))!.actions, { message: "a late prompt is picked up with the panel open" }).toContain("install");
  await page.evaluate(() => window.dispatchEvent(new Event("appinstalled")));
  await expect.poll(async () => (await offer(page))!.actions, { message: "...and dropped once the app reports itself installed" }).not.toContain(
    "install",
  );
});

test("More space in a browser: fullscreen in and out for real, and a captured prompt spent exactly once", async ({ app }) => {
  const { page } = app;
  await openFromMenu(page);
  const plain = (await offer(page))!;
  expect(plain.actions, "an ordinary browser is offered fullscreen, and nothing else").toEqual(["fullscreen"]);
  expect(plain.hints, "...no hints: the action says it all").toEqual([]);
  expect(plain.buttons.every((b) => b.text.length > 3 && b.h >= 28 && b.w > 100), "labelled and pressable").toBe(true);

  await page.locator('[data-space-action="fullscreen"]').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.tagName ?? null), { message: "it really enters fullscreen" }).toBe("HTML");
  await expect.poll(async () => (await offer(page))!.actions, { message: "...and offers the way out instead" }).toEqual(["exit-fullscreen"]);
  await page.locator('[data-space-action="exit-fullscreen"]').click();
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement), { message: "it really leaves" }).toBe(false);
  await expect.poll(async () => (await offer(page))!.actions, { message: "...and flips back" }).toEqual(["fullscreen"]);
  await closePanel(page);

  /* Incognito never fires the prompt, so it is dispatched into the app's own
     listener; capturing, keeping and spending it once are the product. */
  const prevented = await page.evaluate(() => {
    const w = window as unknown as { __prompted: number };
    w.__prompted = 0;
    const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<object> };
    e.prompt = () => (w.__prompted++, Promise.resolve({ outcome: "accepted" }));
    window.dispatchEvent(e);
    return e.defaultPrevented;
  });
  expect(prevented, "the app swallows the browser's own install bar").toBe(true);
  /* The palette route too, which proves the action reached the command list. */
  await app.openPalette();
  await page.locator('[role="combobox"]').fill("More space");
  await page.locator('[role="option"]').first().click();
  await expect(page.locator("[data-more-space]")).toHaveCount(1);
  expect((await offer(page))!.actions[0], "a captured prompt turns Install on").toBe("install");
  await page.locator('[data-space-action="install"]').click();
  expect(await page.evaluate(() => (window as unknown as { __prompted: number }).__prompted), "it opens the install flow").toBe(1);
  /* Good for one use whatever the answer: a button that stayed would be the no-op this forbids. */
  await expect.poll(async () => (await offer(page))!.actions, { message: "...and goes once spent" }).not.toContain("install");
  expect(app.consoleErrors).toEqual([]);
});

const DENIED_FRAME = (url: string) => {
  const f = document.createElement("iframe");
  f.id = "gq-denied";
  /* `fullscreen 'none'` — an iframe without allowfullscreen is NOT enough any
     more: the default allowlist is `self`, so a same-origin frame says true. */
  f.setAttribute("allow", "fullscreen 'none'");
  f.src = url;
  f.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;z-index:99999";
  document.body.appendChild(f);
};

test("where nothing can be done, nothing is offered — and the panel says why", async ({ app }) => {
  const { page } = app;
  await page.evaluate(DENIED_FRAME, page.url());
  const frame = (await (await page.waitForSelector("#gq-denied")).contentFrame())!;
  await settle(page, frame);
  expect(await frame.evaluate(() => document.fullscreenEnabled), "really denied fullscreen").toBe(false);
  await openFromMenu(frame);
  const none = (await offer(frame))!;
  expect(none.actions, "no buttons").toEqual([]);
  expect(none.hints, "...and it says so instead of showing an empty panel").toContain("nothing-to-offer");
  expect(none.words).toBeGreaterThan(60);
});

test.describe("iPhone Safari", () => {
  test.use({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  });

  test("offers nothing to press, says where Add to Home Screen lives, and fits the phone", async ({ app }) => {
    const { page } = app;
    await page.evaluate(DENIED_FRAME, page.url());
    const frame = (await (await page.waitForSelector("#gq-denied")).contentFrame())!;
    await settle(page, frame);
    await openFromMenu(frame);
    const o = (await offer(frame))!;
    expect(o.actions, "nothing to press").toEqual([]);
    /* It lives in Safari's own Share menu, which no page can open. */
    expect(o.hints, "told where Add to Home Screen is").toContain("ios-add-to-home");
    /* A phone sheet rises from the foot: measure it once it has landed. */
    await frame.waitForFunction(() =>
      document
        .querySelector("[data-more-space]")!
        .getAnimations({ subtree: true })
        .every((a) => a.playState !== "running"),
    );
    const box = await frame.evaluate(() => {
      const r = document.querySelector("[data-more-space]")!.getBoundingClientRect();
      return { l: Math.round(r.left), r: Math.round(r.right), b: Math.round(r.bottom), vw: innerWidth, vh: innerHeight };
    });
    expect(box.l >= 0 && box.r <= box.vw && box.b <= box.vh, `the panel fits the phone: ${JSON.stringify(box)}`).toBe(true);
  });
});

test("an installed window is standalone, never offered installing again, and keeps fullscreen", async () => {
  /* `--app=` is Chrome's own app window: display-mode standalone, for real. */
  const url = test.info().project.use.baseURL!;
  const { ctx, done } = await profile([`--app=${url}`]);
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    if (!page.url().startsWith(url)) await page.goto(url, { waitUntil: "domcontentloaded" });
    await settle(page);
    const mode = await page.evaluate(() => ["fullscreen", "standalone", "minimal-ui", "browser"].find((m) => matchMedia(`(display-mode: ${m})`).matches));
    expect(mode, "an installed window really is standalone").toBe("standalone");
    /* The hard case: a browser that STILL offers a prompt for a copy already
       installed. The display mode has to win. */
    await page.evaluate(() => {
      const e = new Event("beforeinstallprompt", { cancelable: true }) as Event & { prompt: () => Promise<object> };
      e.prompt = () => Promise.resolve({});
      window.dispatchEvent(e);
    });
    await openFromMenu(page);
    const o = (await offer(page))!;
    expect(o.actions, "never install again, even with a prompt captured").not.toContain("install");
    expect(o.hints, "...told it already has the window").toContain("already-installed");
    expect(o.actions, "...fullscreen still on the table").toContain("fullscreen");
  } finally {
    await done();
  }
});
