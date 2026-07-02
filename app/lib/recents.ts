// Recent-files store. Saved/opened projects are remembered in IndexedDB either
// as a File System Access handle (re-openable from disk on supporting browsers)
// or, as a fallback, the project content itself.

export interface RecentMeta {
  id: string;
  name: string;
  savedAt: number;
  kind: "handle" | "data";
}

interface FileHandleLike {
  name?: string;
  getFile: () => Promise<File>;
  queryPermission?: (opts: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
  requestPermission?: (opts: { mode: "read" | "readwrite" }) => Promise<PermissionState>;
}

const DB_NAME = "graphiq-editor";
const LEGACY_DB_NAME = "aperture-editor"; // pre-rebrand store, still read as a fallback
const DB_VERSION = 1;
const META = "recent-meta";
const PAYLOAD = "recent-payload";
const MAX_RECENTS = 8;

const supported = () => typeof indexedDB !== "undefined";

function openDB(name: string = DB_NAME): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META, { keyPath: "id" });
      if (!db.objectStoreNames.contains(PAYLOAD)) db.createObjectStore(PAYLOAD);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

function reqValue<T>(r: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function listFrom(name: string): Promise<RecentMeta[]> {
  const db = await openDB(name);
  const metas = (await reqValue(
    db.transaction(META, "readonly").objectStore(META).getAll(),
  )) as RecentMeta[];
  db.close();
  return metas;
}

export async function listRecents(): Promise<RecentMeta[]> {
  if (!supported()) return [];
  try {
    let metas = await listFrom(DB_NAME);
    // Fall back to the pre-rebrand store until the new one has its own entries.
    if (!metas.length) {
      try {
        metas = await listFrom(LEGACY_DB_NAME);
      } catch {
        /* no legacy store */
      }
    }
    return metas.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** Remember a project. Prefer a (re-openable) handle; otherwise store its content. */
export async function addRecent(
  name: string,
  payload: { handle?: unknown; blob?: Blob },
): Promise<void> {
  if (!supported()) return;
  try {
    const db = await openDB();
    const metas = (await reqValue(
      db.transaction(META, "readonly").objectStore(META).getAll(),
    )) as RecentMeta[];

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const meta: RecentMeta = {
      id,
      name,
      savedAt: Date.now(),
      kind: payload.handle ? "handle" : "data",
    };
    const value = payload.handle ?? payload.blob;

    const tx = db.transaction([META, PAYLOAD], "readwrite");
    // Replace any previous entry for the same file name.
    for (const m of metas.filter((m) => m.name === name)) {
      tx.objectStore(META).delete(m.id);
      tx.objectStore(PAYLOAD).delete(m.id);
    }
    tx.objectStore(META).put(meta);
    tx.objectStore(PAYLOAD).put(value, id);
    await txDone(tx);

    // Keep only the most-recent MAX_RECENTS.
    const remaining = (
      (await reqValue(db.transaction(META, "readonly").objectStore(META).getAll())) as RecentMeta[]
    ).sort((a, b) => b.savedAt - a.savedAt);
    const extra = remaining.slice(MAX_RECENTS);
    if (extra.length) {
      const tx2 = db.transaction([META, PAYLOAD], "readwrite");
      for (const m of extra) {
        tx2.objectStore(META).delete(m.id);
        tx2.objectStore(PAYLOAD).delete(m.id);
      }
      await txDone(tx2);
    }
    db.close();
  } catch {
    // storage failures are non-fatal
  }
}

async function readFrom(name: string, id: string): Promise<string | null> {
  const db = await openDB(name);
  const meta = (await reqValue(
    db.transaction(META, "readonly").objectStore(META).get(id),
  )) as RecentMeta | undefined;
  const payload = await reqValue(db.transaction(PAYLOAD, "readonly").objectStore(PAYLOAD).get(id));
  db.close();
  if (!meta || payload == null) return null;

  if (meta.kind === "handle") {
    const h = payload as FileHandleLike;
    if (h.queryPermission) {
      let perm = await h.queryPermission({ mode: "read" });
      if (perm !== "granted" && h.requestPermission) {
        perm = await h.requestPermission({ mode: "read" });
      }
      if (perm !== "granted") return null;
    }
    const file = await h.getFile();
    return await file.text();
  }
  return await (payload as Blob).text();
}

/** Read a recent project's `.gproj` text, or null if unavailable / permission denied. */
export async function readRecent(id: string): Promise<string | null> {
  if (!supported()) return null;
  try {
    const fromNew = await readFrom(DB_NAME, id);
    if (fromNew != null) return fromNew;
    return await readFrom(LEGACY_DB_NAME, id); // legacy recents stored pre-rebrand
  } catch {
    return null;
  }
}

export async function removeRecent(id: string): Promise<void> {
  if (!supported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction([META, PAYLOAD], "readwrite");
    tx.objectStore(META).delete(id);
    tx.objectStore(PAYLOAD).delete(id);
    await txDone(tx);
    db.close();
  } catch {
    // ignore
  }
}

export async function clearRecents(): Promise<void> {
  if (!supported()) return;
  try {
    const db = await openDB();
    const tx = db.transaction([META, PAYLOAD], "readwrite");
    tx.objectStore(META).clear();
    tx.objectStore(PAYLOAD).clear();
    await txDone(tx);
    db.close();
  } catch {
    // ignore
  }
}
