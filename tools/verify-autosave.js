/* Does the work survive the tab going away?
 *
 * The only autosave write used to be a `setInterval` on `autosaveMinutes`
 * (default 2). A phone does not give you two minutes: iOS reclaims backgrounded
 * tabs eagerly and without warning, so switching to another app could lose
 * everything since the last tick. There is now a write on
 * `visibilitychange → hidden` and on `pagehide` as well.
 *
 * HOW THE KILL IS EMULATED. Recovery is offered when the previous session left
 * its "alive" flag set — an unclean exit. A reload cannot produce that: the
 * reload fires `pagehide`, which clears the flag, so the next boot looks clean.
 * A SECOND PAGE in the same context does: same origin, same storage, and the
 * first page never gets to say goodbye — which is precisely what an OS kill
 * looks like from the app's side.
 *
 * The first check is the one that makes the rest mean anything: it asserts the
 * timer has NOT written, so what the second page recovers can only have come
 * from the hidden handler.
 *
 * Run: node tools/verify-autosave.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const boot = async (page) => {
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
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
    await page.waitForTimeout(800);
  };

  /** The stored snapshot, straight out of IndexedDB, without going through any
   *  UI: how many documents, when it was written, and how big its payload is. */
  const stored = (page) =>
    page.evaluate(
      async () => {
        /* Look before opening. `indexedDB.open(name)` CREATES the database when
           it is absent — at version 1, with no object store — and the app then
           opens its own version 1, gets no upgrade event, never creates the
           store, and every write fails silently into its catch. Reading the
           store this way once cost four checks and looked exactly like the
           feature being broken. */
        const dbs = await indexedDB.databases();
        if (!dbs.some((d) => d.name === "graphiq-autosave")) return null;
        return new Promise((resolve) => {
          const req = indexedDB.open("graphiq-autosave");
          req.onerror = () => resolve(null);
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains("snapshots")) return resolve(null);
            const tx = db.transaction("snapshots", "readonly");
            const get = tx.objectStore("snapshots").get("latest");
            get.onsuccess = () => {
              const s = get.result;
              resolve(
                s
                  ? { docs: s.docs?.length ?? 0, savedAt: s.savedAt ?? 0,
                      bytes: (s.docs ?? []).reduce((n, d) => n + (d.json?.length ?? 0), 0) }
                  : null,
              );
            };
            get.onerror = () => resolve(null);
          };
        });
      },
    );

  /** A hash of what is on the canvas, read only once it has stopped changing. */
  const stableShot = async (page) => {
    let last = null;
    for (let i = 0; i < 20; i++) {
      const h = await page.evaluate(() => {
        const c = document.querySelector('[data-tour="canvas"] canvas');
        if (!c) return null;
        const d = c.getContext("2d", { willReadFrequently: true })
          .getImageData(0, 0, c.width, c.height).data;
        let a = 5381;
        for (let i = 0; i < d.length; i += 997) a = ((a * 33) ^ d[i]) >>> 0;
        let ink = 0;
        for (let i = 3; i < d.length; i += 4 * 97) if (d[i] > 8) ink++;
        return `${a.toString(36)}/${ink}`;
      });
      if (h && h === last) return h;
      last = h;
      await page.waitForTimeout(250);
    }
    return last;
  };

  // ---------- 1. an edit, and nothing written yet ----------
  const page = await context.newPage();
  await boot(page);
  const before = await stored(page);

  /* Paint something unmistakable, with the brush, on the open document. */
  const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
  await page.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++)
    await page.mouse.move(box.x + box.width * (0.3 + i * 0.03), box.y + box.height * (0.4 + i * 0.02));
  await page.mouse.up();
  await page.waitForTimeout(900);
  const painted = await stableShot(page);
  check("a stroke lands on the canvas", !!painted && painted !== "0/0", `canvas now ${painted}`);

  const afterEdit = await stored(page);
  /* The timer is two minutes away, so anything recovered later cannot have come
     from it. Without this the whole rail could pass on the old code. */
  check("the timer has not written the edit yet",
    (afterEdit?.savedAt ?? 0) === (before?.savedAt ?? 0),
    `snapshot savedAt ${before?.savedAt ?? "none"} → ${afterEdit?.savedAt ?? "none"}`);

  // ---------- 2. the page goes hidden ----------
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(2500);
  const afterHidden = await stored(page);
  check("going hidden writes a snapshot",
    !!afterHidden && afterHidden.savedAt > (afterEdit?.savedAt ?? 0),
    afterHidden
      ? `${afterHidden.docs} document(s), ${Math.round(afterHidden.bytes / 1024)} KB, savedAt ${afterHidden.savedAt}`
      : "nothing stored");

  // ---------- 3. the tab is taken away, and the work comes back ----------
  /* A second page rather than a reload: a reload says goodbye through pagehide
     and the next boot would look like a clean exit. */
  const revived = await context.newPage();
  await boot(revived);
  const dialog = revived.locator('div[aria-label="Restore session"]');
  const offered = await dialog.count();
  check("the next session is offered the lost work", offered === 1,
    offered ? "the restore dialog is up" : "no restore dialog appeared");
  if (offered) {
    await dialog.locator("button", { hasText: "Restore" }).first().click();
    await revived.waitForTimeout(2500);
    const back = await stableShot(revived);
    check("…and it is the document that was on screen, pixel for pixel", back === painted,
      `recovered ${back}, was ${painted}`);
  } else {
    check("…and it is the document that was on screen, pixel for pixel", false, "nothing to restore");
  }
  await revived.close();

  // ---------- 4. pagehide writes too, for the paths that skip visibilitychange ----------
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(400);
  const beforePageHide = await stored(page);
  /* Another edit, so there is something new to write — a snapshot is skipped
     when nothing has changed, and this proves that guard is not what is being
     measured. */
  await page.mouse.move(box.x + box.width * 0.6, box.y + box.height * 0.7);
  await page.mouse.down();
  for (let i = 1; i <= 8; i++)
    await page.mouse.move(box.x + box.width * (0.6 + i * 0.02), box.y + box.height * 0.7);
  await page.mouse.up();
  await page.waitForTimeout(900);
  await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  await page.waitForTimeout(2500);
  const afterPageHide = await stored(page);
  check("pagehide writes one as well",
    !!afterPageHide && afterPageHide.savedAt > (beforePageHide?.savedAt ?? 0),
    `savedAt ${beforePageHide?.savedAt ?? "none"} → ${afterPageHide?.savedAt ?? "none"}`);

  // ---------- 5. an unchanged document is not re-written ----------
  const quiet = await stored(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(1800);
  const stillQuiet = await stored(page);
  check("with nothing changed, going hidden writes nothing",
    stillQuiet?.savedAt === quiet?.savedAt,
    `savedAt stayed ${stillQuiet?.savedAt ?? "none"}`);

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
