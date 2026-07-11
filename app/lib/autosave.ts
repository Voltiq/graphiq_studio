// Crash recovery: periodic `.gproj` snapshots in IndexedDB plus a heartbeat
// flag in localStorage. The flag is set on boot and cleared on `pagehide` —
// if it is still set when the app next starts, the previous session ended
// uncleanly (crash / killed tab) and the snapshot is offered for restore.
// Everything is best-effort: storage failures must never break editing.

const DB_NAME = "graphiq-autosave";
const STORE = "snapshots";
const KEY = "latest";
const ALIVE_KEY = "graphiq:session-alive";

/** One document inside a snapshot: its `.gproj` JSON + display name. */
export interface AutosaveDoc {
  json: string;
  name: string;
}

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

/** Coerce any stored value into the current snapshot shape (migrating a legacy
 *  single-document entry), or null if it isn't a usable snapshot. */
function coerceSnapshot(raw: unknown): AutosaveSnapshot | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Partial<AutosaveSnapshot> & Partial<LegacySnapshot>;
  if (Array.isArray(o.docs)) {
    const docs = o.docs.filter(
      (d): d is AutosaveDoc => !!d && typeof d.json === "string",
    );
    if (!docs.length) return null;
    const activeIndex = Math.max(0, Math.min(docs.length - 1, o.activeIndex ?? 0));
    return { docs, activeIndex, savedAt: o.savedAt ?? Date.now() };
  }
  if (typeof o.json === "string") {
    return { docs: [{ json: o.json, name: o.name ?? "Untitled" }], activeIndex: 0, savedAt: o.savedAt ?? Date.now() };
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

export async function writeAutosave(snap: AutosaveSnapshot): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE, "readwrite");
      tx.objectStore(STORE).put(snap, KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  } catch {
    /* storage unavailable — autosave silently off */
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
    return coerceSnapshot(raw);
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

/** Heartbeat: set on boot, cleared on pagehide; still set ⇒ unclean exit. */
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
