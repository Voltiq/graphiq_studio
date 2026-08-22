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
                      /* A document's JSON is stored as a Blob now (strings are
                         still read, for snapshots written before that). */
                      bytes: (s.docs ?? []).reduce(
                        (n, d) => n + (typeof d.json === "string" ? d.json.length : (d.json?.size ?? 0)), 0) }
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

  // ---------- 6. the heartbeat: a tab switch is not a goodbye ----------
  /* Its own context, so the flag and the snapshot start clean. The two halves
     compound in the real failure: the snapshot IS written on the tab switch
     (section 2), and then the heartbeat used to throw away the only signal that
     would have offered it back. */
  {
    const fresh = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const live = await fresh.newPage();
    await boot(live);
    const flag = () => live.evaluate(() => localStorage.getItem("graphiq:session-alive"));
    check("a live session is marked alive", (await flag()) === "1", `flag ${await flag()}`);

    const c = await live.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await live.mouse.move(c.x + c.width * 0.4, c.y + c.height * 0.5);
    await live.mouse.down();
    for (let i = 1; i <= 10; i++)
      await live.mouse.move(c.x + c.width * (0.4 + i * 0.02), c.y + c.height * (0.5 + i * 0.02));
    await live.mouse.up();
    await live.waitForTimeout(900);
    const work = await stableShot(live);

    /* A tab switch, as the browser reports it: pagehide with persisted set,
       the page still alive in the back/forward cache. */
    await live.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await live.waitForTimeout(2000);
    check("switching tabs does not mark it clean", (await flag()) === "1",
      `flag after a persisted pagehide: ${await flag()}`);

    await live.evaluate(() => {
      window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await live.waitForTimeout(500);
    check("…and coming back leaves it alive", (await flag()) === "1", `flag ${await flag()}`);

    /* Now the OS takes the tab. No goodbye, so the flag stays set. */
    const after = await fresh.newPage();
    await boot(after);
    const dialog = after.locator('div[aria-label="Restore session"]');
    const offered = await dialog.count();
    check("a kill after a tab switch still offers the work back", offered === 1,
      offered ? "the restore dialog is up" : "no restore dialog appeared");
    if (offered) {
      await dialog.locator("button", { hasText: "Restore" }).first().click();
      await after.waitForTimeout(2500);
      const back = await stableShot(after);
      check("…and it is the work that was on screen", back === work, `recovered ${back}, was ${work}`);
    } else {
      check("…and it is the work that was on screen", false, "nothing to restore");
    }
    await after.close();

    /* The other side of the rule: a real close must still read as clean, or
       every ordinary exit would offer recovery it does not need. */
    await live.evaluate(() =>
      window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false })));
    await live.waitForTimeout(500);
    check("closing for real does mark it clean", (await flag()) === null,
      `flag after an unpersisted pagehide: ${await flag()}`);
    await fresh.close();
  }

  // ---------- 7. a write that fails must SAY so ----------
  /* IndexedDB caps a single value at about 127 MiB (measured:
     `size=141557806 bytes, max=133169152`), which a few open photographs used
     to sail past — and the write failed into a bare catch while the status bar
     still read "Autosaved HH:MM". Documents are stored as Blobs now, which are
     held out of line and do not count towards that cap, so the realistic case
     no longer fails at all; this checks what happens when a write fails ANYWAY.

     The fault is injected rather than provoked: filling a 10 GB quota in a rail
     is not practical, so the object store is removed underneath the app, which
     makes the very next write throw. */
  {
    const fresh = await browser.newContext({ viewport: { width: 1400, height: 900 } });
    const live = await fresh.newPage();
    await boot(live);
    const label = () =>
      live.locator('[data-tour="status"]').innerText().then((t) => t.replace(/\s+/g, " "));

    const c = await live.locator('[data-tour="canvas"] canvas').first().boundingBox();
    const stroke = async (at) => {
      await live.mouse.move(c.x + c.width * at, c.y + c.height * at);
      await live.mouse.down();
      for (let i = 1; i <= 8; i++)
        await live.mouse.move(c.x + c.width * (at + i * 0.02), c.y + c.height * (at + i * 0.01));
      await live.mouse.up();
      await live.waitForTimeout(700);
    };
    const hide = async () => {
      await live.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await live.waitForTimeout(2500);
      await live.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
        document.dispatchEvent(new Event("visibilitychange"));
      });
      await live.waitForTimeout(300);
    };

    await stroke(0.3);
    await hide();
    check("a snapshot that works says so", (await label()).includes("Autosaved"),
      `status: "${(await label()).slice(-40)}"`);

    // Take the store away, so the next write cannot land.
    await live.evaluate(
      () =>
        new Promise((resolve) => {
          const req = indexedDB.open("graphiq-autosave", 2);
          req.onupgradeneeded = () => req.result.deleteObjectStore("snapshots");
          req.onsuccess = () => {
            req.result.close();
            resolve(null);
          };
          req.onerror = () => resolve(null);
        }),
    );
    await stroke(0.6);
    await hide();
    const failed = await label();
    check("a snapshot that fails does NOT claim to have worked", !failed.includes("Autosaved"),
      `status: "${failed.slice(-52)}"`);
    check("…and says what happened instead", /Autosave failed/i.test(failed),
      `status: "${failed.slice(-52)}"`);
    await fresh.close();
  }

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
