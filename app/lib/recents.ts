// Recent-files store. Saved/opened projects are remembered in IndexedDB either
// as a File System Access handle (re-openable from disk on supporting browsers)
// or, as a fallback, the project content itself.
//
// Pictures are remembered here too, as `kind: "image"`: the phone's start card
// offers them as its fastest way back into something, and a second store would
// be a second thing for "Clear recent files" to miss. They differ from projects
// in two ways the rest of this file has to respect — the payload is image bytes
// rather than `.gproj` text, so `readRecent` must not hand one to a JSON
// parser; and they are LARGE, so the count cap that was plenty for projects is
// joined by one on bytes.

export interface RecentMeta {
  id: string;
  name: string;
  savedAt: number;
  kind: "handle" | "data" | "image";
  /** Images only: a ~160px preview, the pixel size, the mime type, and how much
   *  the payload weighs — kept on the meta so the byte trim does not have to
   *  read every payload back to add them up. */
  thumb?: Blob;
  width?: number;
  height?: number;
  type?: string;
  bytes?: number;
}

/** Everything a picture's row needs. */
export type RecentImage = RecentMeta & { thumb: Blob; width: number; height: number };

/** How much the remembered PICTURES may weigh together. Projects are not
 *  counted: they are small, and a cap able to evict someone's work in favour of
 *  a photograph would be the wrong trade. */
export const RECENT_IMAGE_BYTES = 60 * 1024 * 1024;

/**
 * The entries that survive a trim: newest first, at most `limit` of them, and
 * with the images weighing under `maxBytes` together.
 *
 * Pure, and lifted out of `addRecent`, because this is where the edge cases
 * live. The one worth naming: `keepId` is never trimmed away. A photograph
 * larger than the whole byte budget would otherwise be forgotten the instant it
 * was remembered, leaving older and smaller pictures in the list instead.
 */
export function trimRecents(
  metas: RecentMeta[],
  limit: number,
  maxBytes = RECENT_IMAGE_BYTES,
  keepId?: string,
): RecentMeta[] {
  const ordered = [...metas].sort((a, b) => b.savedAt - a.savedAt);
  const out: RecentMeta[] = [];
  let bytes = 0;
  for (const m of ordered) {
    const mustKeep = m.id === keepId;
    if (out.length >= limit && !mustKeep) continue;
    const size = m.kind === "image" ? (m.bytes ?? 0) + (m.thumb?.size ?? 0) : 0;
    if (size && bytes + size > maxBytes && !mustKeep) continue;
    out.push(m);
    bytes += size;
  }
  return out.sort((a, b) => b.savedAt - a.savedAt);
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

// Preferences ▸ Files "Recent files" — applied by Editor on pref change; the
// list trims as entries are ADDED, so shrinking takes effect on the next save.
let recentsLimit = 8;

/** Set how many recents survive the post-add trim (clamped to 1–20). */
export function setRecentsLimit(n: number): void {
  recentsLimit = Math.max(1, Math.min(20, Math.round(n) || 8));
}

/* ------------------------------- thumbnails ------------------------------- */

/** The longest edge of a stored preview. */
export const THUMB_EDGE = 160;

/**
 * A small preview of a bitmap, for a recent picture's row.
 *
 * Measured on a 12-megapixel source: the downscale blocks the main thread for
 * ~0ms (it is a blit) and the whole cycle including the encode takes 0.6ms of
 * wall clock — comfortably inside a frame, which is why there is no worker
 * here and no `createImageBitmap` resize dance. JPEG rather than PNG: the
 * preview of a photograph is a photograph.
 */
export async function makeThumb(
  source: CanvasImageSource & { width: number; height: number },
): Promise<Blob | null> {
  try {
    const scale = Math.min(1, THUMB_EDGE / Math.max(source.width, source.height, 1));
    const w = Math.max(1, Math.round(source.width * scale));
    const h = Math.max(1, Math.round(source.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) return null;
    ctx.drawImage(source, 0, 0, w, h);
    return await new Promise<Blob | null>((resolve) =>
      canvas.toBlob((b) => resolve(b), "image/jpeg", 0.72),
    );
  } catch {
    return null;
  }
}

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

/** `only` narrows the list: "image" for the start card's pictures, "project"
 *  for the recents dialog, which can only open `.gproj` text. */
export async function listRecents(only?: "image" | "project"): Promise<RecentMeta[]> {
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
    const wanted = only
      ? metas.filter((m) => (only === "image" ? m.kind === "image" : m.kind !== "image"))
      : metas;
    return wanted.sort((a, b) => b.savedAt - a.savedAt);
  } catch {
    return [];
  }
}

/** The remembered pictures, newest first, with their previews. */
export async function listRecentImages(): Promise<RecentImage[]> {
  const metas = await listRecents("image");
  return metas.filter((m): m is RecentImage => m.thumb instanceof Blob && !!m.width && !!m.height);
}

/** Remember a project or a picture. Projects prefer a (re-openable) handle and
 *  otherwise store their content; a picture stores its own bytes plus a preview,
 *  which is what lets the start card show and reopen it. */
export async function addRecent(
  name: string,
  payload: {
    handle?: unknown;
    blob?: Blob;
    image?: { file: Blob; thumb: Blob; width: number; height: number; type: string };
  },
): Promise<void> {
  if (!supported()) return;
  try {
    const db = await openDB();
    const metas = (await reqValue(
      db.transaction(META, "readonly").objectStore(META).getAll(),
    )) as RecentMeta[];

    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const img = payload.image;
    const meta: RecentMeta = {
      id,
      name,
      savedAt: Date.now(),
      kind: img ? "image" : payload.handle ? "handle" : "data",
      ...(img
        ? {
            thumb: img.thumb,
            width: img.width,
            height: img.height,
            type: img.type,
            bytes: img.file.size,
          }
        : {}),
    };
    const value = img?.file ?? payload.handle ?? payload.blob;

    const tx = db.transaction([META, PAYLOAD], "readwrite");
    // Replace any previous entry for the same file name.
    for (const m of metas.filter((m) => m.name === name)) {
      tx.objectStore(META).delete(m.id);
      tx.objectStore(PAYLOAD).delete(m.id);
    }
    tx.objectStore(META).put(meta);
    tx.objectStore(PAYLOAD).put(value, id);
    await txDone(tx);

    // Trim to the count limit, and to the picture budget — see trimRecents.
    const remaining = (await reqValue(
      db.transaction(META, "readonly").objectStore(META).getAll(),
    )) as RecentMeta[];
    const kept = new Set(
      trimRecents(remaining, recentsLimit, RECENT_IMAGE_BYTES, id).map((m) => m.id),
    );
    const extra = remaining.filter((m) => !kept.has(m.id));
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
  /* A picture is not project text. Decoding JPEG bytes as UTF-8 and handing the
     result to a JSON parser would fail in a way nobody could read. */
  if (meta.kind === "image") return null;

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

/** A remembered picture's bytes, as a File ready to be imported again. */
export async function readRecentFile(id: string): Promise<File | null> {
  if (!supported()) return null;
  try {
    const db = await openDB();
    const meta = (await reqValue(
      db.transaction(META, "readonly").objectStore(META).get(id),
    )) as RecentMeta | undefined;
    const payload = await reqValue(db.transaction(PAYLOAD, "readonly").objectStore(PAYLOAD).get(id));
    db.close();
    if (!meta || meta.kind !== "image" || !(payload instanceof Blob)) return null;
    return new File([payload], meta.name, { type: meta.type || "image/*" });
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
