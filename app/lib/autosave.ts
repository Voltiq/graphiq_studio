// Crash recovery: periodic `.gproj` snapshots in IndexedDB plus a heartbeat
// flag in localStorage. The flag is set on boot and cleared on `pagehide` —
// if it is still set when the app next starts, the previous session ended
// uncleanly (crash / killed tab) and the snapshot is offered for restore.
// Everything is best-effort: storage failures must never break editing.

const DB_NAME = "graphiq-autosave";
const STORE = "snapshots";
const KEY = "latest";
const ALIVE_KEY = "graphiq:session-alive";

export interface AutosaveSnapshot {
  /** The serialized project (same JSON as an `.gproj` file). */
  json: string;
  name: string;
  savedAt: number; // epoch ms
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
    const snap = await new Promise<AutosaveSnapshot | null>((resolve, reject) => {
      const tx = db.transaction(STORE, "readonly");
      const req = tx.objectStore(STORE).get(KEY);
      req.onsuccess = () => resolve((req.result as AutosaveSnapshot) ?? null);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return snap && typeof snap.json === "string" ? snap : null;
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
