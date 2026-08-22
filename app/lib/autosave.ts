// Crash recovery: periodic `.gproj` snapshots in IndexedDB plus a heartbeat
// flag in localStorage. The flag is set on boot and cleared on `pagehide` —
// if it is still set when the app next starts, the previous session ended
// uncleanly (crash / killed tab) and the snapshot is offered for restore.
// Everything is best-effort: storage failures must never break editing.

const DB_NAME = "graphiq-autosave";
const STORE = "snapshots";
const KEY = "latest";
const ALIVE_KEY = "graphiq:session-alive";

/** One document inside a snapshot: its `.gproj` JSON + display name.
 *
 *  `images` is how autosave keeps the pixels OUT of that JSON. Each entry is a
 *  PNG Blob, and the JSON holds `gqblob:<key>` where a data URL would otherwise
 *  sit. Writing it that way is the whole point: building one JSON string with
 *  three 12-megapixel layers base64'd into it measured 281 ms of blocked main
 *  thread, at the moment the page is being hidden. Blobs cross from the encoder
 *  by reference and go into IndexedDB as they are.
 *
 *  Absent on a snapshot written by the crash path, which cannot await a worker
 *  and so still inlines data URLs — and on anything written before this. */
export interface AutosaveDoc {
  json: string;
  name: string;
  images?: Record<string, Blob>;
}

/** Marks a place in the JSON where an image lives in `images` instead. */
export const BLOB_REF = "gqblob:";

export interface AutosaveSnapshot {
  /** Every open document at snapshot time, in tab order. */
  docs: AutosaveDoc[];
  /** Index into `docs` of the document that was active. */
  activeIndex: number;
  savedAt: number; // epoch ms
}

/** Legacy single-document snapshot shape (pre multi-document autosave). */
interface LegacySnapshot {
  json: string;
  name: string;
  savedAt: number;
}

/** How a document is STORED. The JSON goes in as a Blob because IndexedDB caps
 *  a single structured-clone value at about 127 MiB — a 4000x3000 photograph
 *  serializes to ~45 MB of base64 per document, so a few open documents used to
 *  sail past that and the write failed with
 *  `size=141557806 bytes, max=133169152`. A Blob is stored out of line and does
 *  not count towards that limit: the same payload writes fine. Strings are
 *  still READ, because snapshots written before this exist. */
interface StoredDoc {
  json: string | Blob;
  name: string;
  images?: Record<string, Blob>;
}

/** Coerce any stored value into the current snapshot shape — migrating a legacy
 *  single-document entry, and reading a document stored either way — or null if
 *  it isn't a usable snapshot. */
/** Put the blobs back where the references are, as data URLs.
 *
 *  Restoring is user-initiated and happens once, so the base64 is affordable
 *  HERE in a way it is not on every autosave — and it keeps every consumer of a
 *  snapshot's JSON exactly as it was, which is worth more than the saving.
 *  (Object URLs would be cheaper still, but they have to be revoked by someone,
 *  and there is no good moment for that between here and the decoder.) */
async function inlineImages(json: string, images?: Record<string, Blob>): Promise<string> {
  if (!images || !json.includes(BLOB_REF)) return json;
  const urls = new Map<string, string>();
  for (const [key, blob] of Object.entries(images)) {
    urls.set(
      key,
      await new Promise<string>((resolve) => {
        const fr = new FileReader();
        fr.onload = () => resolve(String(fr.result));
        fr.onerror = () => resolve("");
        fr.readAsDataURL(blob);
      }),
    );
  }
  /* The references sit inside JSON string literals, so a plain replace is
     enough — the keys are ids, with nothing needing escaping. */
  return json.replace(
    new RegExp(`${BLOB_REF}([^"]+)`, "g"),
    (whole, key: string) => urls.get(key) ?? whole,
  );
}

async function coerceSnapshot(raw: unknown): Promise<AutosaveSnapshot | null> {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<{ docs: StoredDoc[]; activeIndex: number; savedAt: number }> &
    Partial<LegacySnapshot>;
  const text = async (v: unknown): Promise<string | null> =>
    typeof v === "string" ? v : v instanceof Blob ? await v.text() : null;
  if (Array.isArray(o.docs)) {
    const docs: AutosaveDoc[] = [];
    for (const d of o.docs) {
      const json = d ? await text(d.json) : null;
      if (json) docs.push({ json: await inlineImages(json, d.images), name: d.name ?? "Untitled" });
    }
    if (!docs.length) return null;
    const activeIndex = Math.max(0, Math.min(docs.length - 1, o.activeIndex ?? 0));
    return { docs, activeIndex, savedAt: o.savedAt ?? Date.now() };
  }
  const legacy = await text(o.json);
  if (legacy) {
    return { docs: [{ json: legacy, name: o.name ?? "Untitled" }], activeIndex: 0, savedAt: o.savedAt ?? Date.now() };
  }
  return null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Whether the snapshot reached storage. A failure has to be REPORTED, not
 *  swallowed: this used to return void whatever happened, so a write that was
 *  rejected still left the caller announcing "Autosaved HH:MM" — the case where
 *  the work is most at risk reassuring the user most confidently. */
export type AutosaveWrite = { ok: true } | { ok: false; reason: string };

export async function writeAutosave(snap: AutosaveSnapshot): Promise<AutosaveWrite> {
  try {
    const db = await openDb();
    /* Each document's JSON as its own Blob — see StoredDoc. */
    const stored = {
      docs: snap.docs.map((d) => ({
        json: new Blob([d.json], { type: "application/json" }),
        name: d.name,
        ...(d.images ? { images: d.images } : {}),
      })),
      activeIndex: snap.activeIndex,
      savedAt: snap.savedAt,
    };
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(stored, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      // A quota rejection aborts the transaction without firing onerror first.
      tx.onabort = () => reject(tx.error);
    });
    db.close();
    return { ok: true };
  } catch (e) {
    const err = e as { name?: string; message?: string } | null;
    return {
      ok: false,
      reason: err?.name === "QuotaExceededError" ? "there is no room left in storage" : "storage refused it",
    };
  }
}

export async function readAutosave(): Promise<AutosaveSnapshot | null> {
  try {
    const db = await openDb();
    const raw = await new Promise<unknown>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve(req.result ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return await coerceSnapshot(raw);
  } catch {
    return null;
  }
}

export async function clearAutosave(): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).delete(KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* ignore */
  }
}

/* ---------------------------------------------------------------- heartbeat
   A flag set while a session is live. If it is still set at the next boot, the
   previous one did not end on its own terms — a crash, or the OS reclaiming the
   tab — and the last snapshot is worth offering back.

   Getting the LIFECYCLE right is the whole difficulty, and it is not the
   obvious one. Clearing the flag on `pagehide` looks correct and is what this
   did; on a phone it is wrong twice over. `pagehide` fires on an ordinary tab
   switch with the page still very much alive, so the flag was cleared while the
   user was still working — and nothing ever put it back, so a kill an hour
   later looked like a tidy exit and the work was never offered. Confirmed
   before it was changed: after a tab switch the flag read `null`, coming back
   left it `null`, and a kill offered no recovery at all.

   Hence `heartbeatAfter`, which is where the policy lives so it can be tested
   as a sequence of events rather than through a browser. */

/** A page-lifecycle event, as far as the heartbeat is concerned. */
export type HeartbeatEvent =
  | { type: "boot" }
  | { type: "pagehide"; persisted: boolean }
  | { type: "pageshow" }
  | { type: "visible" };

/**
 * Whether `event` should leave the session marked alive.
 *
 * `true` — arm it. `false` — disarm it: this session ended deliberately.
 * `null` — leave it exactly as it was.
 */
export function heartbeatAfter(event: HeartbeatEvent): boolean | null {
  switch (event.type) {
    case "boot":
    case "pageshow":
    case "visible":
      // Anything that means "the page is here" re-arms it, which is what was
      // missing: the flag could be cleared and never restored.
      return true;
    case "pagehide":
      /* A PERSISTED pagehide is the page entering the back/forward cache, which
         on mobile is what a tab switch looks like. The page is still alive and
         may well come back, so the flag must survive it — otherwise a later
         kill is indistinguishable from a clean exit. An unpersisted one is a
         real unload: closing the tab, or navigating away. */
      return event.persisted ? null : false;
  }
}

/**
 * Arm the heartbeat and keep it armed for as long as the page is alive.
 * Returns a function that removes the listeners.
 *
 * Call `wasUncleanExit()` BEFORE this: arming overwrites the answer.
 */
export function installHeartbeat(): () => void {
  const apply = (event: HeartbeatEvent) => {
    const armed = heartbeatAfter(event);
    if (armed === true) markSessionAlive();
    else if (armed === false) markSessionClean();
  };
  const onHide = (e: PageTransitionEvent) => apply({ type: "pagehide", persisted: e.persisted });
  const onShow = () => apply({ type: "pageshow" });
  const onVisible = () => {
    if (document.visibilityState === "visible") apply({ type: "visible" });
  };
  apply({ type: "boot" });
  window.addEventListener("pagehide", onHide);
  window.addEventListener("pageshow", onShow);
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.removeEventListener("pagehide", onHide);
    window.removeEventListener("pageshow", onShow);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Still set at boot ⇒ the previous session did not end on its own terms. */
export function wasUncleanExit(): boolean {
  try {
    return window.localStorage.getItem(ALIVE_KEY) === "1";
  } catch {
    return false;
  }
}
export function markSessionAlive(): void {
  try {
    window.localStorage.setItem(ALIVE_KEY, "1");
  } catch {
    /* ignore */
  }
}
export function markSessionClean(): void {
  try {
    window.localStorage.removeItem(ALIVE_KEY);
  } catch {
    /* ignore */
  }
}
