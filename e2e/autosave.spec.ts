/**
 * Does the work survive the tab going away? (Ported from tools/verify-autosave.js, TODO 2.1.)
 *
 * The only autosave write used to be a `setInterval` on `autosaveMinutes`
 * (default 2). A phone does not give you two minutes: iOS reclaims backgrounded
 * tabs eagerly and without warning. There is now a write on
 * `visibilitychange → hidden` and on `pagehide` as well.
 *
 * HOW THE KILL IS EMULATED. Recovery is offered when the previous session left
 * its "alive" flag set — an unclean exit. A reload cannot produce that: it
 * fires `pagehide`, which clears the flag. A SECOND PAGE in the same context
 * does: same origin, same storage, and the first page never says goodbye —
 * which is what an OS kill looks like from the app's side.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, bootApp, type App } from "./fixtures";

interface Stored {
  docs: number;
  savedAt: number;
  bytes: number;
}
/** The stored snapshot straight out of IndexedDB, without going through any UI. */
const stored = (page: Page) =>
  page.evaluate(async (): Promise<Stored | null> => {
    /* Look before opening. `indexedDB.open(name)` CREATES an absent database at
       version 1 with no store; the app then opens its own version 1, gets no
       upgrade event, never creates the store, and every write fails silently.
       Reading it the naive way once looked exactly like the feature broken. */
    if (!(await indexedDB.databases()).some((d) => d.name === "graphiq-autosave")) return null;
    return new Promise((resolve) => {
      const req = indexedDB.open("graphiq-autosave");
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains("snapshots")) return resolve(null);
        const get = db.transaction("snapshots", "readonly").objectStore("snapshots").get("latest");
        get.onsuccess = () => {
          const s = get.result as { docs?: { json: string | Blob }[]; savedAt?: number } | undefined;
          db.close();
          resolve(
            s
              ? {
                  docs: s.docs?.length ?? 0,
                  savedAt: s.savedAt ?? 0,
                  // JSON is stored as a Blob now; strings are still read, from older snapshots.
                  bytes: (s.docs ?? []).reduce((n, d) => n + (typeof d.json === "string" ? d.json.length : d.json.size), 0),
                }
              : null,
          );
        };
        get.onerror = () => resolve(null);
      };
    });
  });

/** A hash of what is on the canvas, read once it has stopped changing. */
async function stableShot(page: Page): Promise<string | null> {
  let last: string | null = null;
  for (let i = 0; i < 20; i++) {
    const h = await page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas');
      if (!c) return null;
      const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, c.width, c.height).data;
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
}

/** A brush stroke from (fx, fy), drifting right and down. */
async function stroke(app: App, fx: number, fy: number): Promise<void> {
  const b = await app.canvasBox();
  const { mouse } = app.page;
  await mouse.move(b.x + b.width * fx, b.y + b.height * fy);
  await mouse.down();
  for (let i = 1; i <= 10; i++) await mouse.move(b.x + b.width * (fx + i * 0.02), b.y + b.height * (fy + i * 0.015));
  await mouse.up();
  await app.settle(900);
}

const setVisibility = (page: Page, state: "hidden" | "visible") =>
  page.evaluate((s) => {
    Object.defineProperty(document, "visibilityState", { value: s, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  }, state);
const pagehide = (page: Page, persisted: boolean) =>
  page.evaluate((p) => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: p })), persisted);

/** The OS takes the tab: a new page in the same context. Restores what it is
 *  offered and returns the canvas hash, or null when nothing was offered. */
async function afterKill(ctx: BrowserContext, extra: App[]): Promise<string | null> {
  const next = await bootApp(await ctx.newPage());
  extra.push(next);
  const dialog = next.page.locator('div[aria-label="Restore session"]');
  if (!(await dialog.count())) return null;
  await dialog.locator("button", { hasText: "Restore" }).first().click();
  await next.settle(2_500);
  return stableShot(next.page);
}

/* The extra sessions a test opened, so their errors are checked too. */
let extra: App[] = [];
test.beforeEach(() => {
  extra = [];
});
test.afterEach(async ({ app }) => {
  for (const a of [app, ...extra]) {
    expect(a.errors, "no page errors").toEqual([]);
    expect(a.consoleErrors, "no console errors").toEqual([]);
  }
});

test("going hidden writes a snapshot, and the next session restores it pixel for pixel", async ({ app }) => {
  const before = await stored(app.page);
  await stroke(app, 0.3, 0.4);
  const painted = await stableShot(app.page);
  expect(painted, "a stroke lands on the canvas").not.toBe("0/0");
  /* The timer is two minutes away, so anything recovered later cannot have
     come from it. Without this, the whole test could pass on the old code. */
  const afterEdit = await stored(app.page);
  expect(afterEdit?.savedAt ?? 0, "the timer has not written the edit yet").toBe(before?.savedAt ?? 0);

  await setVisibility(app.page, "hidden");
  await app.settle(2_500);
  const hidden = await stored(app.page);
  expect(hidden?.savedAt ?? 0, "going hidden writes a snapshot").toBeGreaterThan(afterEdit?.savedAt ?? 0);

  /* The pixels sit BESIDE the JSON, not inside it. Inlined as base64 they made
     one ~134 MB string per document, 281 ms of blocked main thread to build at
     the moment the page is hiding. */
  const shape = await app.page.evaluate(
    () =>
      new Promise<{ images: number; refs: number; inlined: number } | null>((resolve) => {
        const r = indexedDB.open("graphiq-autosave");
        r.onerror = () => resolve(null);
        r.onsuccess = () => {
          const db = r.result;
          const g = db.transaction("snapshots", "readonly").objectStore("snapshots").get("latest");
          g.onsuccess = async () => {
            const d = g.result?.docs?.[0];
            db.close();
            if (!d) return resolve(null);
            const json: string = typeof d.json === "string" ? d.json : await d.json.text();
            resolve({
              images: Object.keys(d.images ?? {}).length,
              refs: (json.match(/gqblob:/g) ?? []).length,
              inlined: (json.match(/data:image\/png;base64/g) ?? []).length,
            });
          };
          g.onerror = () => {
            db.close();
            resolve(null);
          };
        };
      }),
  );
  expect(shape?.images ?? 0, "image blobs are stored").toBeGreaterThan(0);
  expect(shape, "one reference per blob, nothing inlined").toEqual({ images: shape!.images, refs: shape!.images, inlined: 0 });

  expect(await afterKill(app.page.context(), extra), "the next session gets the lost work back, as it was").toBe(painted);
});

test("pagehide writes too, and an unchanged document is not written again", async ({ app }) => {
  const { page } = app;
  await stroke(app, 0.3, 0.4);
  await setVisibility(page, "hidden");
  await app.settle(2_500);
  await setVisibility(page, "visible");
  await app.settle(400);
  const first = await stored(page);
  expect(first, "a first snapshot exists").not.toBeNull();
  // Another edit, so there is something new: an unchanged snapshot is skipped.
  await stroke(app, 0.6, 0.6);
  await pagehide(page, true);
  await app.settle(2_500);
  const second = await stored(page);
  expect(second!.savedAt, "pagehide writes one as well").toBeGreaterThan(first!.savedAt);

  await setVisibility(page, "hidden");
  await app.settle(1_800);
  expect((await stored(page))!.savedAt, "with nothing changed, going hidden writes nothing").toBe(second!.savedAt);
});

test("a tab switch is not a goodbye: a kill after one still offers the work back", async ({ app }) => {
  /* The two halves compound in the real failure: the snapshot IS written on the
     tab switch, and the heartbeat used to throw away the only signal that would
     have offered it back. */
  const { page } = app;
  const flag = () => page.evaluate(() => localStorage.getItem("graphiq:session-alive"));
  expect(await flag(), "a live session is marked alive").toBe("1");
  await stroke(app, 0.4, 0.5);
  const work = await stableShot(page);
  // A tab switch, as the browser reports it: pagehide with persisted set.
  await pagehide(page, true);
  await app.settle(2_000);
  expect(await flag(), "switching tabs does not mark it clean").toBe("1");
  await page.evaluate(() => {
    window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true }));
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await app.settle(500);
  expect(await flag(), "...and coming back leaves it alive").toBe("1");

  expect(await afterKill(page.context(), extra), "the OS takes the tab: the work is offered back").toBe(work);

  // The other side: a real close reads as clean, or every exit would offer recovery.
  await pagehide(page, false);
  await app.settle(500);
  expect(await flag(), "closing for real does mark it clean").toBeNull();
});

test("a write that fails says so, instead of claiming it saved", async ({ app }) => {
  /* IndexedDB caps one value at ~127 MiB (measured: size=141557806,
     max=133169152); a few open photos once sailed past it and the write failed
     into a bare catch while the status bar read "Autosaved HH:MM". Documents
     are Blobs now, so that case no longer fails at all — this checks what
     happens when a write fails ANYWAY. The fault is injected: the object store
     is removed underneath the app, so the next write throws. */
  const { page } = app;
  const label = async () => (await page.locator('[data-tour="status"]').innerText()).replace(/\s+/g, " ");
  const hideAndBack = async () => {
    await setVisibility(page, "hidden");
    await app.settle(2_500);
    await setVisibility(page, "visible");
    await app.settle(300);
  };
  await stroke(app, 0.3, 0.3);
  await hideAndBack();
  expect(await label(), "a snapshot that works says so").toContain("Autosaved");

  await page.evaluate(
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
  await stroke(app, 0.6, 0.6);
  await hideAndBack();
  const failed = await label();
  expect(failed, "a failed snapshot does NOT claim to have worked").not.toContain("Autosaved");
  expect(failed, "...and says what happened instead").toMatch(/Autosave failed/i);
});

test("a snapshot in the previous format still restores", async ({ app }) => {
  /* Autosave keeps each image in its own Blob behind a `gqblob:` reference.
     Anyone upgrading has a snapshot in the OLD shape. The fixture is not
     hand-written (an earlier attempt spent its time debugging its own field
     names): the app writes a real snapshot, which is converted BACK — every
     reference replaced by its blob as a data URL, the images map dropped, the
     JSON a plain string. */
  const { page } = app;
  await stroke(app, 0.35, 0.45);
  const painted = await stableShot(page);
  await setVisibility(page, "hidden");
  await app.settle(2_500);
  const converted = await page.evaluate(async () => {
    const open = () =>
      new Promise<IDBDatabase>((res, rej) => {
        const r = indexedDB.open("graphiq-autosave");
        r.onsuccess = () => res(r.result);
        r.onerror = () => rej(r.error);
      });
    let db = await open();
    const snap = await new Promise<{ docs: { json: string | Blob; name: string; images?: Record<string, Blob> }[]; activeIndex: number; savedAt: number } | null>(
      (res) => {
        const g = db.transaction("snapshots", "readonly").objectStore("snapshots").get("latest");
        g.onsuccess = () => res(g.result ?? null);
        g.onerror = () => res(null);
      },
    );
    db.close();
    if (!snap) return null;
    const asDataUrl = (blob: Blob) =>
      new Promise<string>((res) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => res("");
        fr.readAsDataURL(blob);
      });
    const docs: { json: string; name: string }[] = [];
    let refs = 0;
    for (const d of snap.docs) {
      let json = typeof d.json === "string" ? d.json : await d.json.text();
      for (const [key, blob] of Object.entries(d.images ?? {})) {
        const next = json.split(`gqblob:${key}`).join(await asDataUrl(blob));
        if (next !== json) refs++;
        json = next;
      }
      docs.push({ json, name: d.name }); // a plain string, and no images map
    }
    db = await open();
    await new Promise((res) => {
      const tx = db.transaction("snapshots", "readwrite");
      tx.objectStore("snapshots").put({ docs, activeIndex: snap.activeIndex, savedAt: snap.savedAt }, "latest");
      tx.oncomplete = () => res(null);
      tx.onerror = () => res(null);
    });
    db.close();
    return { docs: docs.length, refs };
  });
  expect(converted?.refs ?? 0, "the snapshot was put back into the previous format").toBeGreaterThan(0);
  /* This page stays OPEN: closing it is a real unload, which the heartbeat
     reads as a clean exit and would clear the flag this depends on. */
  expect(await afterKill(page.context(), extra), "it is offered, and restores pixel for pixel").toBe(painted);
});
