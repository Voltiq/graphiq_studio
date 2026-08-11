// Saved selections as named alpha channels (TODO §3) — pure model, no DOM.
//
// A saved selection is a grayscale raster living in the engine's ORDINARY masks
// map under a reserved key, exactly like the quick mask and the filter mask.
// That reuse is the whole design: allocMask("selection", …) already turns a
// selection into a mask, maskSelectionRects() already turns one back, and
// captureMask/restoreMask already move them in and out of a file. Nothing here
// touches pixels — this is the naming, identity and validation half.

/** One saved selection: an id (stable, keys the raster) plus a display name. */
export interface SavedChannel {
  id: string;
  name: string;
}

/** How a loaded channel combines with the current selection. */
export type ChannelSelectOp = "new" | "add" | "subtract" | "intersect";

/**
 * Engine masks-map key for a document's saved selection.
 *
 * Keyed by DOCUMENT as well as channel, like the quick mask: the engine holds
 * every open document's rasters in one map, so two tabs each with an "Alpha 1"
 * must not collide.
 */
export const selectionChannelKey = (docId: string, channelId: string): string =>
  `ch:${docId}:${channelId}`;

/** Is this masks-map key a saved selection? (Used to skip composite work — a
 *  saved selection is never drawn, so editing one must not dirty any cache.) */
export const isChannelKey = (key: string): boolean => key.startsWith("ch:");

/** A channel id unique within `existing`. */
export function freshChannelId(existing: SavedChannel[]): string {
  let n = existing.length + 1;
  const taken = new Set(existing.map((c) => c.id));
  while (taken.has(`ch${n}`)) n++;
  return `ch${n}`;
}

/**
 * The next free "Alpha N" name.
 *
 * Counts up past whatever is taken rather than using `length + 1`, so deleting
 * Alpha 1 and saving again gives Alpha 3 rather than a duplicate Alpha 2.
 */
export function defaultChannelName(existing: SavedChannel[]): string {
  const taken = new Set(existing.map((c) => c.name.trim().toLowerCase()));
  let n = 1;
  while (taken.has(`alpha ${n}`)) n++;
  return `Alpha ${n}`;
}

/** Trim a user-entered name, falling back to the default when it's empty. */
export function cleanChannelName(raw: string, existing: SavedChannel[]): string {
  const t = raw.trim().slice(0, 60);
  return t || defaultChannelName(existing);
}

export function renameChannel(list: SavedChannel[], id: string, name: string): SavedChannel[] {
  const clean = name.trim().slice(0, 60);
  if (!clean) return list; // an empty rename is a no-op, not a nameless channel
  return list.map((c) => (c.id === id ? { ...c, name: clean } : c));
}

export const removeChannel = (list: SavedChannel[], id: string): SavedChannel[] =>
  list.filter((c) => c.id !== id);

/** Validate channels read from a `.gproj` — ids must be present and unique. */
export function coerceChannels(raw: unknown): SavedChannel[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedChannel[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const o = item as Partial<SavedChannel>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, name: typeof o.name === "string" && o.name.trim() ? o.name.trim().slice(0, 60) : id });
  }
  return out;
}

/** The history-step label for loading a channel under `op`. */
export function loadLabel(name: string, op: ChannelSelectOp): string {
  switch (op) {
    case "add":
      return `Add ${name} to Selection`;
    case "subtract":
      return `Subtract ${name} from Selection`;
    case "intersect":
      return `Intersect ${name} with Selection`;
    default:
      return `Load ${name}`;
  }
}

/** Pointer modifiers → combine op, matching the Paths panel exactly. */
export function opFromModifiers(e: { ctrlKey: boolean; metaKey: boolean; altKey: boolean }): ChannelSelectOp {
  const ctrl = e.ctrlKey || e.metaKey;
  if (ctrl && e.altKey) return "intersect";
  if (ctrl) return "add";
  if (e.altKey) return "subtract";
  return "new";
}
