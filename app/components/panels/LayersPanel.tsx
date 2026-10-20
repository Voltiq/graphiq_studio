"use client";

import {
  type CSSProperties,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine,
  ChevronDown,
  ChevronRight,
  CornerDownRight,
  Focus,
  Grid2x2,
  ScanEye,
  Move,
  Paintbrush,
  PaintBucket,
  Pencil,
  FlaskConical,
  Sparkles,
  X,
} from "lucide-react";
import {
  Check,
  Copy,
  Eye,
  EyeOff,
  Folder,
  FolderMinus,
  FolderOpen,
  FolderPlus,
  Layers as LayersIcon,
  Link2,
  Lock,
  LockOpen,
  Search,
  Trash2,
  Unlink2,
  MaskIcon,
  AdjustmentIcon,
} from "../../lib/icons";
import styles from "../RightDock.module.scss";
import { Select } from "../Controls";
import { cssGradient } from "../GradientControl";
import { clamp, swatchBg } from "../../lib/color";
import { uiZoom } from "../../lib/ui-scale";
import {
  BLEND_MODES,
  clipGroupsOf,
  EMPTY_LAYER_FILTER,
  filterLayerTree,
  filterMaskKey,
  findNode,
  hasAnyLock,
  isFillLayer,
  isLinked,
  isPixelsLocked,
  isPositionLocked,
  isTransparencyLocked,
  labelColor,
  type FillSpec,
  layerFilterActive,
  LAYER_LABELS,
  type LayerFilter,
  type LayerLabel,
  type LayerNode,
  type LayersApi,
  type LockFlag,
} from "../../lib/layers";
import { resolveIsolation } from "../../lib/isolate";
import { hasEnabledFx } from "../../lib/effects";
import { hasEnabledFilters } from "../../lib/filters";
import { clampX, clampY } from "../../lib/safeArea";
import { registerDismissible } from "../../lib/dismiss";
import { exitProps, useLinger } from "../../lib/use-presence";
import { MENUS } from "../../lib/menus";
import type { EngineHandle } from "../../lib/paint";

type ClipRole = "none" | "base" | "member";
interface Row {
  node: LayerNode;
  depth: number;
  clip: ClipRole;
  /** Visible-but-not-matching under an active filter (rendered dimmed). */
  dim: boolean;
}

// Photoshop-style locks: transparency & pixels apply to pixel layers only;
// position & all apply to every kind. `all` overrides the individual three.
const LOCK_DEFS: { flag: LockFlag; label: string; name: string; Icon: typeof Lock; pixelOnly?: boolean }[] = [
  { flag: "transparency", label: "transparency", name: "Transparency", Icon: Grid2x2, pixelOnly: true },
  { flag: "pixels", label: "image pixels", name: "Image pixels", Icon: Paintbrush, pixelOnly: true },
  { flag: "position", label: "position", name: "Position", Icon: Move },
  { flag: "all", label: "all", name: "Everything", Icon: Lock },
];

/** The Layer menu's adjustment-layer commands, for the footer's "new fill or
 *  adjustment" menu — read from the menu itself, so the two never disagree. */
const ADJUSTMENT_COMMANDS: { label: string; action: string }[] = MENUS.flatMap((m) =>
  m.items.flatMap((it) =>
    "action" in it && typeof it.action === "string" && it.action.startsWith("adj-")
      ? [{ label: it.label.replace(/^Adjustment:\s*/i, ""), action: it.action }]
      : [],
  ),
);

/** Background style previewing a fill spec in the layer thumbnail. */
function fillPreview(fill: FillSpec): CSSProperties {
  return fill.kind === "solid" ? swatchBg(fill.color) : { backgroundImage: cssGradient(fill.gradient.stops) };
}

/** Human-readable summary of a layer's active locks (row indicator tooltip). */
function lockSummary(n: LayerNode): string {
  if (n.locks?.all) return "All locked";
  const on: string[] = [];
  if (isTransparencyLocked(n)) on.push("transparency");
  if (isPixelsLocked(n)) on.push("pixels");
  if (isPositionLocked(n)) on.push("position");
  return `Locked: ${on.join(", ")}`;
}

const KIND_OPTIONS = ["All kinds", "Layers", "Groups", "Adjustments"] as const;
const KIND_BY_OPTION: Record<string, LayerFilter["kind"]> = {
  "All kinds": "all",
  Layers: "layer",
  Groups: "group",
  Adjustments: "adjustment",
};

/** Flatten the tree into display rows, hiding the children of collapsed groups.
 *  Each row carries its clip role within its parent (resolved by clipGroupsOf): a
 *  clip-group `base` (underlined) or a clipped `member` (indented with an elbow).
 *  Under an active filter, only `vis.visible` rows appear (non-matches dimmed) —
 *  and matched rows inside COLLAPSED groups are revealed so a search always
 *  shows its hits. */
function flattenRows(nodes: LayerNode[], vis: { match: Set<string>; visible: Set<string> } | null, depth = 0): Row[] {
  const role = new Map<string, ClipRole>();
  for (const g of clipGroupsOf(nodes)) {
    if (g.members.length) {
      role.set(g.base.id, "base");
      for (const m of g.members) role.set(m.id, "member");
    }
  }
  const out: Row[] = [];
  for (const n of nodes) {
    if (vis && !vis.visible.has(n.id)) continue;
    out.push({ node: n, depth, clip: role.get(n.id) ?? "none", dim: !!vis && !vis.match.has(n.id) });
    if (n.type === "group" && (n.expanded || (vis && !vis.match.has(n.id))))
      out.push(...flattenRows(n.children, vis, depth + 1));
  }
  return out;
}

/* ---- Thumbnails -------------------------------------------------------------
   A row's thumbnail is the layer itself, drawn small: a 72×52 canvas (36×26 at
   2×) fitted from the engine's own raster, and its masks likewise.

   Drawing a large raster small is not free — a 12-megapixel layer is a real
   copy to scale down — so a thumbnail is drawn when its row first appears,
   the active layer's again a moment after the engine reports a change (a
   stroke lands in the layer you are working on), and the rest are swept up
   one at a time in idle moments a little later, which catches anything an
   undo or a merge changed elsewhere without ever holding up a stroke. */
type ThumbKind = "layer" | "mask" | "filterMask";

function sourceFor(eng: EngineHandle, id: string, kind: ThumbKind): HTMLCanvasElement | null {
  if (kind === "layer") return eng.getLayerImageCanvas(id);
  if (kind === "mask") return eng.getMaskImageCanvas(id);
  return eng.getMaskImageCanvas(filterMaskKey(id));
}

function drawThumb(cv: HTMLCanvasElement, src: HTMLCanvasElement | null) {
  const ctx = cv.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, cv.width, cv.height);
  if (!src || !src.width || !src.height) return;
  const s = Math.min(cv.width / src.width, cv.height / src.height);
  const w = Math.max(1, Math.round(src.width * s));
  const h = Math.max(1, Math.round(src.height * s));
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "medium";
  ctx.drawImage(src, Math.round((cv.width - w) / 2), Math.round((cv.height - h) / 2), w, h);
}

function useThumbnails(
  engineRef: RefObject<EngineHandle | null> | undefined,
  listRef: RefObject<HTMLElement | null>,
  activeId: string | null,
) {
  const drawn = useRef(new WeakSet<HTMLCanvasElement>());
  const activeRef = useRef(activeId);
  useEffect(() => {
    activeRef.current = activeId;
  }, [activeId]);

  const canvases = useCallback(
    () => [...(listRef.current?.querySelectorAll<HTMLCanvasElement>("canvas[data-thumb-id]") ?? [])],
    [listRef],
  );
  const draw = useCallback(
    (cv: HTMLCanvasElement) => {
      const eng = engineRef?.current;
      if (!eng) return;
      drawThumb(cv, sourceFor(eng, cv.dataset.thumbId!, cv.dataset.thumbKind as ThumbKind));
      drawn.current.add(cv);
    },
    [engineRef],
  );

  // New rows (and a new document's rows) get their picture on first paint.
  useEffect(() => {
    for (const cv of canvases()) if (!drawn.current.has(cv)) draw(cv);
  });

  useEffect(() => {
    if (!engineRef) return;
    let unsub = () => {};
    let retry = 0;
    let soon = 0;
    let later = 0;
    let idle = 0;
    let cancelled = false;
    const ric: (cb: IdleRequestCallback) => number =
      typeof window.requestIdleCallback === "function"
        ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
        : (cb) => window.setTimeout(() => cb({ didTimeout: true, timeRemaining: () => 8 } as IdleDeadline), 50);
    const cic = (id: number) =>
      typeof window.cancelIdleCallback === "function" ? window.cancelIdleCallback(id) : window.clearTimeout(id);

    /** One thumbnail per idle slice, until every row has been redrawn. */
    const sweep = () => {
      const queue = canvases();
      const step: IdleRequestCallback = (dl) => {
        while (queue.length && (dl.didTimeout || dl.timeRemaining() > 6)) {
          const cv = queue.shift()!;
          if (cv.isConnected) draw(cv);
          if (dl.didTimeout) break;
        }
        idle = queue.length && !cancelled ? ric(step) : 0;
      };
      cic(idle);
      idle = ric(step);
    };
    const onChange = () => {
      window.clearTimeout(soon);
      soon = window.setTimeout(() => {
        const id = activeRef.current;
        if (id) for (const cv of canvases()) if (cv.dataset.thumbId === id) draw(cv);
      }, 250);
      window.clearTimeout(later);
      later = window.setTimeout(sweep, 1200);
    };
    const attach = () => {
      if (cancelled) return;
      const eng = engineRef.current;
      if (eng) {
        unsub = eng.subscribe(onChange);
        for (const cv of canvases()) draw(cv);
      } else retry = window.setTimeout(attach, 150);
    };
    attach();
    return () => {
      cancelled = true;
      window.clearTimeout(retry);
      window.clearTimeout(soon);
      window.clearTimeout(later);
      cic(idle);
      unsub();
    };
  }, [engineRef, canvases, draw]);
}

/* ---- A popup anchored to a point -------------------------------------------
   The context menu, the lock list and the new-adjustment list share it: kept
   on screen, and closed by a click away — or by Escape and a phone's back
   gesture, both of which close the most recently registered layer first
   (lib/dismiss.ts) before the editor would act on the document, so an Escape
   that closes the menu does not also drop the selection. */
function Popup({
  at,
  label,
  onClose,
  closing = false,
  children,
}: {
  at: { x: number; y: number };
  label: string;
  onClose: () => void;
  /** Leaving: drawn for its exit animation, but no longer there to use. */
  closing?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  // Clamp to the viewport once the size is known, before paint. The menu is
  // UI-scale-zoomed: gBCR is viewport px, but offsets on a zoomed element
  // render ×z, so divide when writing them.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const z = uiZoom();
    // Its own size, not its first animation frame's: it starts scaled down.
    const r = el.getBoundingClientRect();
    const t = getComputedStyle(el).transform;
    const m = t && t !== "none" ? new DOMMatrixReadOnly(t) : null;
    const left = clampX(at.x, r.width / (m?.a || 1), 8);
    const top = clampY(at.y, r.height / (m?.d || 1), 8);
    el.style.left = `${left / z}px`;
    el.style.top = `${top / z}px`;
    // It grows out of the point it was opened at — the click itself — even
    // when it had to move to stay on screen.
    el.style.setProperty("--origin", `${(at.x - left) / z}px ${(at.y - top) / z}px`);
  }, [at]);
  useEffect(() => (closing ? undefined : registerDismissible(onClose)), [onClose, closing]);
  if (typeof document === "undefined") return null;
  return createPortal(
    <>
      {!closing && (
        <div
          className={styles.menuScrim}
          onClick={onClose}
          onContextMenu={(e) => {
            e.preventDefault();
            onClose();
          }}
        />
      )}
      <div
        ref={ref}
        className={styles.layerMenu}
        style={{ left: at.x, top: at.y }}
        role="menu"
        aria-label={label}
        {...exitProps(closing)}
      >
        {children}
      </div>
    </>,
    document.body,
  );
}

/**
 * The layer's opacity as the design draws it: a mono field reading "100 %".
 * Drag across it to scrub (half a percent a pixel), or click and type;
 * arrows step by 1, Shift+arrows by 10.
 */
function OpacityField({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [draft, setDraft] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const scrub = useRef<{ x: number; v: number; moved: boolean } | null>(null);
  const set = (n: number) => onChange(clamp(Math.round(n), 0, 100));
  const commit = () => {
    if (draft !== null && draft.trim() !== "") set(Number(draft));
    setDraft(null);
  };
  return (
    <div
      className={styles.opacityField}
      title="Layer opacity — drag sideways, or click and type"
      onPointerDown={(e) => {
        if (document.activeElement === input.current || e.button !== 0) return;
        e.preventDefault(); // no focus yet: a drag scrubs, a click types
        e.currentTarget.setPointerCapture(e.pointerId);
        scrub.current = { x: e.clientX, v: value, moved: false };
      }}
      onPointerMove={(e) => {
        const s = scrub.current;
        if (!s) return;
        const dx = e.clientX - s.x;
        if (!s.moved && Math.abs(dx) < 3) return;
        s.moved = true;
        set(s.v + dx / 2);
      }}
      onPointerUp={(e) => {
        const s = scrub.current;
        scrub.current = null;
        if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
        if (s && !s.moved) {
          input.current?.focus();
          input.current?.select();
        }
      }}
      onPointerCancel={() => (scrub.current = null)}
    >
      <input
        ref={input}
        className={styles.opacityInput}
        value={draft ?? String(value)}
        inputMode="numeric"
        aria-label="Layer opacity"
        onFocus={() => setDraft(String(value))}
        onChange={(e) => setDraft(e.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
        onBlur={commit}
        onKeyDown={(e) => {
          e.stopPropagation(); // single-letter tool shortcuts stay out
          if (e.key === "Enter") {
            commit();
            input.current?.blur();
          } else if (e.key === "Escape") {
            setDraft(null);
            input.current?.blur();
          } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
            e.preventDefault();
            const n = clamp(Number(draft ?? value) + (e.key === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 10 : 1), 0, 100);
            setDraft(String(n));
            set(n);
          }
        }}
      />
      <span className={styles.opacityFix}>%</span>
    </div>
  );
}

export default function LayersPanel({
  api,
  engineRef,
  onCommand,
  filterOpen = false,
  onFilterOpen,
}: {
  api: LayersApi;
  /** The paint engine, for the rows' thumbnails (none without it). */
  engineRef?: RefObject<EngineHandle | null>;
  /** Runs a menu command: the footer's adjustment-layer list. */
  onCommand?: (id: string) => void;
  /** The filter row, opened from the panel header's search button. */
  filterOpen?: boolean;
  onFilterOpen?: (open: boolean) => void;
}) {
  const { layers, activeLayerId, selectedLayerIds } = api;
  const active = activeLayerId ? findNode(layers, activeLayerId) : null;
  const selected = new Set(selectedLayerIds);
  const listRef = useRef<HTMLUListElement>(null);
  useThumbnails(engineRef, listRef, activeLayerId);

  const [dragId, setDragId] = useState<string | null>(null);

  /* Reordering by TOUCH.
   *
   * The rows reorder with HTML5 drag and drop, and those events do not fire for
   * a finger at all — so on a phone the layer order could not be changed, by
   * any route. This is a second path rather than a replacement: the mouse keeps
   * the drag-and-drop it already had, unchanged, and touch gets long-press to
   * lift and drag to move. Both end up calling the same `api.move`.
   *
   * A long press is what separates "lift this row" from "scroll the list",
   * which is the only ambiguity a finger has here. */
  const LIFT_MS = 350;
  const SLOP = 8; // px of movement that still counts as holding still
  const touchDrag = useRef<{
    id: string;
    x: number;
    y: number;
    timer: number | null;
    lifted: boolean;
  } | null>(null);

  /* The move/end listeners live only for as long as a touch drag does.
   *
   * They used to be attached for the lifetime of the panel, and that broke the
   * MOUSE path outright: with a window `pointerup`/`pointercancel` pair
   * registered, the rows stopped reordering by drag-and-drop entirely — the
   * same drag reordered against the file without them and did nothing with.
   * Guarding the handlers was not enough, because it is the registration and
   * not the handler that does it. Since nothing needs them until a finger has
   * actually lifted a row, they go on at that moment and come off at the end,
   * and a mouse drag never coexists with them at all. */
  const detach = useRef<(() => void) | null>(null);
  /** The stack as it stood when this drag began, for the single undo entry. */
  const treeBefore = useRef<LayerNode[] | null>(null);
  const commitMove = useCallback(() => {
    const before = treeBefore.current;
    treeBefore.current = null;
    if (before) api.commitMove(before);
  }, [api]);

  const endTouchDrag = useCallback(() => {
    const t = touchDrag.current;
    if (t?.timer) window.clearTimeout(t.timer);
    touchDrag.current = null;
    detach.current?.();
    detach.current = null;
    if (t?.lifted) commitMove();
    setDragId(null);
  }, [commitMove]);

  const attachTouchDrag = useCallback(() => {
    const onMove = (e: PointerEvent) => {
      const t = touchDrag.current;
      if (!t) return;
      if (!t.lifted) {
        // Still deciding: enough movement before the press lands means a scroll.
        if (Math.hypot(e.clientX - t.x, e.clientY - t.y) > SLOP) endTouchDrag();
        return;
      }
      const el = document.elementFromPoint(e.clientX, e.clientY);
      const row = el instanceof Element ? el.closest("[data-layer-id]") : null;
      const overId = row?.getAttribute("data-layer-id");
      if (!overId || overId === t.id) return;
      const r = row!.getBoundingClientRect();
      api.move(t.id, overId, e.clientY - r.top < r.height / 2);
    };
    const onUp = () => endTouchDrag();
    /* Once lifted, the list must stop scrolling under the finger. `touch-action`
       cannot do it: it is latched when the gesture starts, and the gesture has
       already started by the time the press lands — so the scroll is refused
       here instead, which needs a non-passive listener. */
    const block = (e: TouchEvent) => {
      if (touchDrag.current?.lifted) e.preventDefault();
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    document.addEventListener("touchmove", block, { passive: false });
    detach.current = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      document.removeEventListener("touchmove", block);
    };
  }, [api, endTouchDrag]);

  const onRowPointerDown = (e: React.PointerEvent, id: string) => {
    if (e.pointerType !== "touch" || filterActive || editingId === id) return;
    const timer = window.setTimeout(() => {
      const t = touchDrag.current;
      if (!t) return;
      t.lifted = true;
      t.timer = null;
      treeBefore.current = api.layers;
      setDragId(t.id); // the row dims, exactly as it does for a mouse drag
    }, LIFT_MS);
    touchDrag.current = { id, x: e.clientX, y: e.clientY, timer, lifted: false };
    attachTouchDrag();
  };
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [menu, setMenu] = useState<{ x: number; y: number; node: LayerNode } | null>(null);
  const [lockAt, setLockAt] = useState<{ x: number; y: number } | null>(null);
  const [adjustAt, setAdjustAt] = useState<{ x: number; y: number } | null>(null);
  // Each popup is still drawn for its exit after it closes, where it was.
  const { shown: menuShown, closing: menuClosing } = useLinger(menu);
  const { shown: lockShown, closing: lockClosing } = useLinger(lockAt);
  const { shown: adjustShown, closing: adjustClosing } = useLinger(adjustAt);
  const closeMenu = () => setMenu(null);
  const closeLock = () => setLockAt(null);
  const closeAdjust = () => setAdjustAt(null);
  /** Open a popup under (or, kept on screen, near) the button that asked. */
  const below = (e: React.MouseEvent<HTMLElement>, alignRight = false) => {
    const r = e.currentTarget.getBoundingClientRect();
    return { x: alignRight ? r.right - 220 : r.left, y: r.bottom + 6 };
  };

  const startRename = (n: LayerNode) => {
    setEditingId(n.id);
    setDraftName(n.name);
  };
  const commitRename = () => {
    if (editingId) api.update(editingId, { name: draftName.trim() || "Layer" });
    setEditingId(null);
  };

  const onRowClick = (e: React.MouseEvent, id: string) => {
    if (e.altKey) api.toggleClip(id); // Alt-click clips this layer to the one below
    else if (e.shiftKey) api.select(id, "range");
    else if (e.ctrlKey || e.metaKey) api.select(id, "toggle");
    else api.select(id, "replace");
  };

  const openMenu = (e: React.MouseEvent, node: LayerNode) => {
    e.preventDefault();
    e.stopPropagation();
    if (!selected.has(node.id)) api.select(node.id, "replace");
    setMenu({ x: e.clientX, y: e.clientY, node });
  };

  const run = (fn: () => void) => {
    fn();
    setMenu(null);
  };

  // ---- Search / filter row (name + kind + colour label) ---------------------
  const [filter, setFilter] = useState<LayerFilter>(EMPTY_LAYER_FILTER);
  const filterActive = layerFilterActive(filter);
  // Closing the row clears the filter: rows hidden by a filter you can no
  // longer see would read as layers gone missing.
  const [prevOpen, setPrevOpen] = useState(filterOpen);
  if (filterOpen !== prevOpen) {
    setPrevOpen(filterOpen);
    if (!filterOpen) setFilter(EMPTY_LAYER_FILTER);
  }
  const vis = useMemo(() => filterLayerTree(layers, filter), [layers, filter]);
  const toggleLabelFilter = (l: LayerLabel) =>
    setFilter((f) => ({
      ...f,
      labels: f.labels.includes(l) ? f.labels.filter((x) => x !== l) : [...f.labels, l],
    }));
  // Which labels and whether any group are in use (the label dots and the
  // caret column only appear when they mean something).
  const { anyLabels, anyGroups } = useMemo(() => {
    let labels = false;
    let groups = false;
    const walk = (ns: LayerNode[]) => {
      for (const n of ns) {
        if (n.label) labels = true;
        if (n.type === "group") {
          groups = true;
          walk(n.children);
        }
      }
    };
    walk(layers);
    return { anyLabels: labels, anyGroups: groups };
  }, [layers]);

  // Apply a colour label to every selected node (menu acts on the selection).
  const applyLabel = (l: LayerLabel | undefined) => {
    const ids = selectedLayerIds.length ? selectedLayerIds : menu ? [menu.node.id] : [];
    for (const id of ids) api.update(id, { label: l });
  };

  const rows = flattenRows(layers, vis);
  // Isolate mode dims the rows the canvas is not showing. The panel keeps
  // listing them: they are still in the document, and hiding them here would
  // make isolate feel like a destructive filter rather than a viewing aid.
  const isolatedOut = useMemo(() => {
    if (!api.isolatedIds?.length) return null;
    const keep = resolveIsolation(layers, api.isolatedIds).keep;
    const out = new Set<string>();
    const walk = (nodes: typeof layers) => {
      for (const n of nodes) {
        if (!keep.has(n.id)) out.add(n.id);
        if (n.type === "group") walk(n.children);
      }
    };
    walk(layers);
    return out;
  }, [layers, api.isolatedIds]);
  const multi = selectedLayerIds.length > 1;

  // Link button: bind 2+ selected layers, or unlink when everything selected is
  // already linked (so a single linked layer can be unlinked here too).
  const selectedNodes = selectedLayerIds.map((id) => findNode(layers, id)).filter((n): n is LayerNode => !!n);
  const allSelLinked = selectedNodes.length > 0 && selectedNodes.every((n) => isLinked(n));
  const canToggleLink = selectedLayerIds.length >= 2 || allSelLinked;

  /** The four lock toggles for a node, as rows of a popup (lock button, context menu). */
  const lockItems = (n: LayerNode) =>
    LOCK_DEFS.map(({ flag, label, name, Icon, pixelOnly }) => {
      const allOn = !!n.locks?.all;
      const rawOn = !!n.locks?.[flag];
      const na = pixelOnly && n.type !== "layer"; // no pixels to lock
      const on = flag === "all" ? allOn : allOn || rawOn;
      // Individual flags are frozen (but shown locked) while Lock-all is on.
      const disabled = na || (flag !== "all" && allOn);
      return (
        <button
          key={flag}
          type="button"
          role="menuitemcheckbox"
          aria-checked={on}
          className={styles.lockItem}
          data-on={on}
          disabled={disabled}
          title={
            na
              ? `Lock ${label} applies to pixel layers only`
              : flag === "all"
                ? on
                  ? "Unlock all"
                  : "Lock all"
                : `${on ? "Unlock" : "Lock"} ${label}`
          }
          onClick={() => api.setLock(n.id, flag, flag === "all" ? !allOn : !rawOn)}
        >
          <Icon size={13} />
          <span>{name}</span>
          <span className={styles.lockCheck}>{on && <Check size={13} />}</span>
        </button>
      );
    });

  const anyLockOn = !!active && hasAnyLock(active);

  return (
    <div className={styles.layers}>
      {filterOpen && (
        <div className={styles.layerFilterBlock}>
          <div className={styles.layerFilter}>
            <label className={styles.layerFilterBox}>
              <Search size={14} />
              <input
                autoFocus
                value={filter.query}
                placeholder="Filter layers…"
                aria-label="Filter layers by name"
                onChange={(e) => setFilter((f) => ({ ...f, query: e.target.value }))}
                onKeyDown={(e) => {
                  e.stopPropagation(); // keep single-letter tool shortcuts out
                  if (e.key === "Escape") {
                    if (filterActive) setFilter(EMPTY_LAYER_FILTER);
                    else onFilterOpen?.(false);
                  }
                }}
              />
              {filterActive && (
                <button
                  type="button"
                  onClick={() => setFilter(EMPTY_LAYER_FILTER)}
                  aria-label="Clear layer filter"
                  title="Clear filter"
                >
                  <X size={12} />
                </button>
              )}
            </label>
            <Select
              options={[...KIND_OPTIONS]}
              value={KIND_OPTIONS.find((o) => KIND_BY_OPTION[o] === filter.kind) ?? "All kinds"}
              onChange={(o) => setFilter((f) => ({ ...f, kind: KIND_BY_OPTION[o] ?? "all" }))}
            />
          </div>
          {(anyLabels || filter.labels.length > 0) && (
            <div className={styles.labelFilterRow} aria-label="Filter by colour label">
              {LAYER_LABELS.map((l) => (
                <button
                  key={l.id}
                  type="button"
                  className={styles.labelFilterDot}
                  data-active={filter.labels.includes(l.id)}
                  style={{ background: l.color }}
                  title={`Show ${l.name.toLowerCase()}-labelled layers`}
                  aria-pressed={filter.labels.includes(l.id)}
                  onClick={() => toggleLabelFilter(l.id)}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {active && (
        <div className={styles.layerControls}>
          <div className={styles.layerBlend}>
            <Select block options={BLEND_MODES} value={active.blend} onChange={(s) => api.update(active.id, { blend: s })} />
          </div>
          <OpacityField value={active.opacity} onChange={(n) => api.update(active.id, { opacity: n })} />
          <button
            type="button"
            className={styles.lockButton}
            data-on={anyLockOn || undefined}
            aria-haspopup="menu"
            aria-expanded={!!lockAt}
            aria-label={anyLockOn ? `Locks: ${lockSummary(active)}` : "Lock the layer"}
            title={anyLockOn ? lockSummary(active) : "Lock transparency, pixels or position"}
            onClick={(e) => setLockAt(lockAt ? null : below(e, true))}
          >
            {anyLockOn ? <Lock size={15} /> : <LockOpen size={15} />}
          </button>
        </div>
      )}

      {rows.length > 0 ? (
        <ul ref={listRef} className={styles.layerList} data-carets={anyGroups || undefined}>
          {rows.map(({ node: l, depth, clip, dim }) => {
            const isGroup = l.type === "group";
            const isAdjustment = l.type === "adjustment";
            const isText = l.type === "layer" && l.vector?.type === "text";
            const masked = !!(l.mask || l.filterMask);
            const pixelsActive = masked ? l.id === activeLayerId && api.maskSurface === "pixels" : undefined;
            return (
              <li
                key={l.id}
                className={styles.layerItem}
                data-selected={selected.has(l.id)}
                data-active={l.id === activeLayerId}
                data-hidden={!l.visible}
                data-dim={dim || (isolatedOut ? isolatedOut.has(l.id) : false)}
                data-dragging={l.id === dragId}
                data-layer-id={l.id}
                draggable={editingId !== l.id && !filterActive}
                onPointerDown={(e) => onRowPointerDown(e, l.id)}
                onClick={(e) => onRowClick(e, l.id)}
                onContextMenu={(e) => openMenu(e, l)}
                onDragStart={(e) => {
                  setDragId(l.id);
                  treeBefore.current = api.layers;
                  e.dataTransfer.effectAllowed = "move";
                }}
                onDragOver={(e) => {
                  e.preventDefault();
                  // Reordering with parts of the tree hidden would be blind —
                  // clear the filter to rearrange.
                  if (filterActive) return;
                  if (dragId && dragId !== l.id) {
                    const r = e.currentTarget.getBoundingClientRect();
                    const before = e.clientY - r.top < r.height / 2;
                    api.move(dragId, l.id, before);
                  }
                }}
                onDragEnd={() => {
                  commitMove();
                  setDragId(null);
                }}
              >
                <button
                  type="button"
                  className={styles.layerEye}
                  onClick={(e) => {
                    e.stopPropagation();
                    api.update(l.id, { visible: !l.visible });
                  }}
                  aria-label={l.visible ? "Hide layer" : "Show layer"}
                  aria-pressed={!l.visible}
                >
                  {l.visible ? <Eye size={16} /> : <EyeOff size={16} />}
                </button>
                <div
                  className={styles.layerMain}
                  style={{ paddingLeft: 6 + depth * 14 + (clip === "member" ? 14 : 0) }}
                >
                  {anyGroups &&
                    (isGroup ? (
                      <button
                        type="button"
                        className={styles.layerCaret}
                        onClick={(e) => {
                          e.stopPropagation();
                          api.update(l.id, { expanded: !l.expanded });
                        }}
                        aria-label={l.expanded ? "Collapse group" : "Expand group"}
                      >
                        {l.expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    ) : (
                      <span className={styles.layerCaret} />
                    ))}
                  {clip === "member" && (
                    <CornerDownRight
                      size={12}
                      className={styles.clipElbow}
                      aria-label="Clipped to layer below"
                    />
                  )}
                  {isGroup ? (
                    <span className={styles.layerTile} data-active={pixelsActive} title="Group">
                      {l.expanded ? <FolderOpen size={15} /> : <Folder size={15} />}
                    </span>
                  ) : isAdjustment ? (
                    <span className={styles.layerTile} data-kind="adjustment" title="Adjustment layer">
                      <AdjustmentIcon size={15} />
                    </span>
                  ) : (
                    <span
                      className={styles.layerThumb}
                      data-kind={isFillLayer(l) ? "fill" : isText ? "text" : "pixels"}
                      data-active={pixelsActive}
                      style={isFillLayer(l) ? fillPreview(l.fill) : undefined}
                      title={
                        isFillLayer(l)
                          ? "Fill layer — double-click to edit"
                          : masked
                            ? "The layer's pixels — click to paint them"
                            : undefined
                      }
                      onDoubleClick={
                        isFillLayer(l)
                          ? (e) => {
                              e.stopPropagation();
                              api.editFill(l.id);
                            }
                          : undefined
                      }
                      onClick={
                        masked
                          ? (e) => {
                              e.stopPropagation();
                              api.select(l.id, "replace");
                              api.chooseSurface(l.id, "pixels");
                            }
                          : undefined
                      }
                    >
                      {isText ? (
                        <span className={styles.thumbGlyph}>T</span>
                      ) : isFillLayer(l) ? null : (
                        <canvas width={72} height={52} data-thumb-id={l.id} data-thumb-kind="layer" />
                      )}
                    </span>
                  )}
                  {l.mask && (
                    <>
                      <button
                        type="button"
                        className={styles.maskLink}
                        data-on={l.mask.linked}
                        title={l.mask.linked ? "Mask linked — click to unlink" : "Mask unlinked — click to link"}
                        onClick={(e) => {
                          e.stopPropagation();
                          api.toggleMaskLinked(l.id);
                        }}
                      >
                        {l.mask.linked ? <Link2 size={11} /> : <Unlink2 size={11} />}
                      </button>
                      <button
                        type="button"
                        className={styles.maskThumb}
                        data-active={l.id === activeLayerId && api.maskSurface === "mask"}
                        data-disabled={!l.mask.enabled}
                        data-viewing={api.maskViewId === l.id || undefined}
                        title={
                          l.mask.enabled
                            ? api.maskViewId === l.id
                              ? "Viewing the mask — Alt-click (or click a thumbnail) to return"
                              : "Layer mask — click to paint it, Alt-click to view it on the canvas, Shift-click to disable"
                            : "Layer mask (disabled) — Shift-click to enable"
                        }
                        onClick={(e) => {
                          e.stopPropagation();
                          if (e.shiftKey) {
                            api.toggleMaskEnabled(l.id);
                            return;
                          }
                          if (e.altKey) {
                            api.select(l.id, "replace");
                            api.toggleMaskView(l.id);
                            return;
                          }
                          api.select(l.id, "replace");
                          api.chooseSurface(l.id, "mask");
                        }}
                      >
                        <span className={styles.maskChip}>
                          <canvas width={72} height={52} data-thumb-id={l.id} data-thumb-kind="mask" />
                          {!l.mask.enabled && <span className={styles.maskOff}>✕</span>}
                        </span>
                      </button>
                    </>
                  )}
                  {l.type !== "adjustment" && l.filterMask && (
                    <button
                      type="button"
                      className={styles.maskThumb}
                      data-kind="filter"
                      data-active={l.id === activeLayerId && api.maskSurface === "filterMask"}
                      data-disabled={!l.filterMask.enabled}
                      title={
                        l.filterMask.enabled
                          ? "Filter mask (confines the smart filters) — click to paint it, Shift-click to disable"
                          : "Filter mask (disabled) — Shift-click to enable"
                      }
                      onClick={(e) => {
                        e.stopPropagation();
                        if (e.shiftKey) {
                          api.toggleFilterMaskEnabled(l.id);
                          return;
                        }
                        api.select(l.id, "replace");
                        api.chooseSurface(l.id, "filterMask");
                      }}
                    >
                      <span className={styles.maskChip}>
                        <canvas width={72} height={52} data-thumb-id={l.id} data-thumb-kind="filterMask" />
                        {l.filterMask.enabled ? (
                          <FlaskConical size={11} className={styles.maskBadge} />
                        ) : (
                          <span className={styles.maskOff}>✕</span>
                        )}
                      </span>
                    </button>
                  )}
                  {l.label && (
                    <span
                      className={styles.labelDot}
                      style={{ background: labelColor(l.label) }}
                      title={`${LAYER_LABELS.find((x) => x.id === l.label)?.name ?? ""} label`}
                    />
                  )}
                  {editingId === l.id ? (
                    <input
                      className={styles.layerRename}
                      autoFocus
                      value={draftName}
                      aria-label="Layer name"
                      onChange={(e) => setDraftName(e.target.value)}
                      onClick={(e) => e.stopPropagation()}
                      onBlur={commitRename}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitRename();
                        if (e.key === "Escape") setEditingId(null);
                      }}
                    />
                  ) : (
                    <span
                      className={styles.layerName}
                      style={clip === "base" ? { textDecoration: "underline" } : undefined}
                      title={clip === "base" ? "Clip-group base" : "Double-click to rename"}
                      onDoubleClick={(e) => {
                        e.stopPropagation();
                        startRename(l);
                      }}
                    >
                      {l.name}
                    </span>
                  )}
                  <span className={styles.layerBadges}>
                    {l.opacity < 100 && (
                      <span className={styles.layerOpacity} title={`Opacity ${l.opacity}%`}>
                        {l.opacity}%
                      </span>
                    )}
                    {isAdjustment && (
                      <button
                        type="button"
                        className={styles.layerBadge}
                        data-on={l.clipped}
                        title={
                          l.clipped
                            ? "Clipped to the layer below — click to affect all layers below"
                            : "Affects all layers below — click to clip to the layer directly below"
                        }
                        aria-label={l.clipped ? "Clipped to the layer below" : "Clip to the layer below"}
                        onClick={(e) => {
                          e.stopPropagation();
                          api.setAdjustmentClipped(l.id, !l.clipped);
                        }}
                      >
                        <CornerDownRight size={12} />
                      </button>
                    )}
                    {isLinked(l) && (
                      <button
                        type="button"
                        className={styles.layerBadge}
                        data-on
                        title="Linked — moves with its link-mates; click to unlink"
                        aria-label="Linked layer — click to unlink"
                        onClick={(e) => {
                          e.stopPropagation();
                          api.unlinkLayer(l.id);
                        }}
                      >
                        <Link2 size={12} />
                      </button>
                    )}
                    {!isAdjustment && hasEnabledFilters(l.filters) && (
                      <button
                        type="button"
                        className={styles.layerBadge}
                        title="Smart filters — click to edit"
                        aria-label="Smart filters"
                        onClick={(e) => {
                          e.stopPropagation();
                          api.openFilters(l.id);
                        }}
                      >
                        <FlaskConical size={12} />
                      </button>
                    )}
                    {!isAdjustment && hasEnabledFx(l.effects) && (
                      <button
                        type="button"
                        className={styles.layerBadge}
                        data-fx
                        title="Layer effects — click to edit"
                        aria-label="Layer effects"
                        onClick={(e) => {
                          e.stopPropagation();
                          api.openLayerStyle(l.id);
                        }}
                      >
                        fx
                      </button>
                    )}
                    {hasAnyLock(l) && (
                      <span className={styles.rowLock} title={lockSummary(l)} aria-label={lockSummary(l)} role="img">
                        <Lock size={13} />
                      </span>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      ) : filterActive ? (
        <div className={styles.layersEmpty}>
          <span className={styles.layersEmptyIcon}>
            <Search size={20} />
          </span>
          <p>No layers match</p>
          <span className={styles.layersEmptyHint}>Adjust the filter above, or clear it to see every layer.</span>
        </div>
      ) : (
        <div className={styles.layersEmpty}>
          <span className={styles.layersEmptyIcon}>
            <LayersIcon size={20} />
          </span>
          <p>No layers yet</p>
          <span className={styles.layersEmptyHint}>Create a layer to start building this canvas.</span>
        </div>
      )}

      <div className={styles.layerFooter}>
        <button
          type="button"
          title={allSelLinked ? "Unlink layers" : "Link layers — move them together without grouping"}
          aria-label={allSelLinked ? "Unlink layers" : "Link layers"}
          data-on={allSelLinked || undefined}
          disabled={!canToggleLink}
          onClick={() => api.toggleLinkSelected()}
        >
          {allSelLinked ? <Unlink2 size={16} /> : <Link2 size={16} />}
        </button>
        <button
          type="button"
          className={styles.footerFx}
          title="Layer style…"
          aria-label="Layer effects"
          disabled={!activeLayerId || active?.type === "adjustment"}
          onClick={() => activeLayerId && api.openLayerStyle(activeLayerId)}
        >
          fx
        </button>
        <button
          type="button"
          title={active?.mask ? "Layer already has a mask" : "Add layer mask (reveal all)"}
          aria-label="Add layer mask"
          disabled={!activeLayerId || !!active?.mask}
          onClick={() => api.addMask("reveal")}
        >
          <MaskIcon size={16} />
        </button>
        <button
          type="button"
          title="New fill or adjustment layer"
          aria-label="New fill or adjustment layer"
          aria-haspopup="menu"
          aria-expanded={!!adjustAt}
          onClick={(e) => setAdjustAt(adjustAt ? null : below(e))}
        >
          <AdjustmentIcon size={16} />
        </button>
        <button
          type="button"
          title={multi ? "Duplicate layers" : "Duplicate layer"}
          aria-label={multi ? "Duplicate layers" : "Duplicate layer"}
          disabled={!selectedLayerIds.length}
          onClick={() => api.duplicate()}
        >
          <Copy size={16} />
        </button>
        <button
          type="button"
          title={
            api.isolatedIds
              ? "Leave isolate mode — show every layer again"
              : "Isolate the selected layers (Ctrl+Alt+L) — a view only, nothing is changed"
          }
          aria-label={api.isolatedIds ? "Exit isolate mode" : "Isolate selected layers"}
          data-on={api.isolatedIds ? true : undefined}
          onClick={() => api.toggleIsolate()}
        >
          {api.isolatedIds ? <ScanEye size={16} /> : <Focus size={16} />}
        </button>
        <button
          type="button"
          className={styles.footerDanger}
          title={multi ? "Delete layers" : "Delete layer"}
          aria-label={multi ? "Delete layers" : "Delete layer"}
          disabled={!selectedLayerIds.length}
          onClick={() => api.remove()}
        >
          <Trash2 size={16} />
        </button>
      </div>

      {lockShown && active && (
        <Popup at={lockShown} label="Layer locks" onClose={closeLock} closing={lockClosing}>
          <span className={styles.menuHead}>Lock</span>
          {lockItems(active)}
        </Popup>
      )}

      {adjustShown && (
        <Popup at={adjustShown} label="New fill or adjustment layer" onClose={closeAdjust} closing={adjustClosing}>
          <span className={styles.menuHead}>Fill layer</span>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeAdjust();
              api.addFill("solid");
            }}
          >
            <PaintBucket size={13} /> Solid colour…
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              closeAdjust();
              api.addFill("gradient");
            }}
          >
            <PaintBucket size={13} /> Gradient…
          </button>
          {onCommand && (
            <>
              <div className={styles.menuSep} />
              <span className={styles.menuHead}>Adjustment layer</span>
              <div className={styles.menuScroll}>
                {ADJUSTMENT_COMMANDS.map((c) => (
                  <button
                    key={c.action}
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      closeAdjust();
                      onCommand(c.action);
                    }}
                  >
                    <AdjustmentIcon size={13} /> {c.label.charAt(0).toUpperCase() + c.label.slice(1)}
                  </button>
                ))}
              </div>
            </>
          )}
        </Popup>
      )}

      {menuShown && (
        <Popup at={menuShown} label="Layer" onClose={closeMenu} closing={menuClosing}>
          <button type="button" onClick={() => run(() => startRename(menuShown.node))}>
            <Pencil size={13} /> Rename
          </button>
          <div className={styles.menuLabelRow} aria-label="Colour label">
            <button
              type="button"
              className={styles.menuLabelNone}
              data-active={!menuShown.node.label}
              title="No label"
              onClick={() => run(() => applyLabel(undefined))}
            >
              <X size={10} />
            </button>
            {LAYER_LABELS.map((l) => (
              <button
                key={l.id}
                type="button"
                className={styles.menuLabelDot}
                data-active={menuShown.node.label === l.id}
                style={{ background: l.color }}
                title={`${l.name} label${multi ? " (all selected)" : ""}`}
                onClick={() => run(() => applyLabel(l.id))}
              />
            ))}
          </div>
          <div className={styles.menuLockRow} aria-label="Lock">
            <span className={styles.menuLockLabel}>Lock</span>
            {LOCK_DEFS.map(({ flag, label, Icon, pixelOnly }) => {
              // Read the live node so toggles stay in sync without closing the menu.
              const node = findNode(layers, menuShown.node.id) ?? menuShown.node;
              const allOn = !!node.locks?.all;
              const rawOn = !!node.locks?.[flag];
              const na = pixelOnly && node.type !== "layer";
              const on = flag === "all" ? allOn : allOn || rawOn;
              const disabled = na || (flag !== "all" && allOn);
              return (
                <button
                  key={flag}
                  type="button"
                  className={styles.lockBtn}
                  data-on={on}
                  disabled={disabled}
                  title={
                    na
                      ? `Lock ${label} applies to pixel layers only`
                      : flag === "all"
                        ? on
                          ? "Unlock all"
                          : "Lock all"
                        : `${on ? "Unlock" : "Lock"} ${label}`
                  }
                  onClick={() => api.setLock(node.id, flag, flag === "all" ? !allOn : !rawOn)}
                >
                  <Icon size={12} />
                </button>
              );
            })}
          </div>
          <button type="button" onClick={() => run(api.duplicate)}>
            <Copy size={13} /> {multi ? "Duplicate layers" : "Duplicate"}
          </button>
          {menuShown.node.type === "adjustment" && (
            <button type="button" onClick={() => run(() => api.editAdjustment(menuShown.node.id))}>
              <AdjustmentIcon size={13} /> Edit Adjustment…
            </button>
          )}
          {isFillLayer(menuShown.node) && (
            <button type="button" onClick={() => run(() => api.editFill(menuShown.node.id))}>
              <PaintBucket size={13} /> Edit Fill…
            </button>
          )}
          <button type="button" onClick={() => run(() => api.toggleClip(menuShown.node.id))}>
            <CornerDownRight size={13} /> {menuShown.node.clipped ? "Release clipping mask" : "Create clipping mask"}
          </button>
          <div className={styles.menuSep} />
          {isLinked(menuShown.node) ? (
            <button type="button" onClick={() => run(() => api.unlinkLayer(menuShown.node.id))}>
              <Unlink2 size={13} /> Unlink layer
            </button>
          ) : (
            multi && (
              <button type="button" onClick={() => run(api.toggleLinkSelected)}>
                <Link2 size={13} /> Link layers
              </button>
            )
          )}
          <button type="button" onClick={() => run(api.group)}>
            <FolderPlus size={13} /> {multi ? "Group selection" : "Group"}
          </button>
          {menuShown.node.type === "group" && (
            <button type="button" onClick={() => run(() => api.ungroup(menuShown.node.id))}>
              <FolderMinus size={13} /> Ungroup
            </button>
          )}
          <button type="button" onClick={() => run(api.merge)}>
            <ArrowDownToLine size={13} /> {multi ? "Merge layers" : "Merge down"}
          </button>
          <button type="button" onClick={() => run(api.flatten)}>
            <LayersIcon size={13} /> Flatten Image
          </button>
          {menuShown.node.type !== "adjustment" && (
            <>
              <div className={styles.menuSep} />
              <button type="button" onClick={() => run(() => api.openLayerStyle(menuShown.node.id))}>
                <Sparkles size={13} /> Layer Style…
              </button>
              <button type="button" onClick={() => run(() => api.copyLayerStyle(menuShown.node.id))}>
                <Copy size={13} /> Copy Layer Style
              </button>
              {api.canPasteStyle && (
                <button type="button" onClick={() => run(() => api.pasteLayerStyle(menuShown.node.id))}>
                  <Sparkles size={13} /> Paste Layer Style
                </button>
              )}
              {hasEnabledFx(menuShown.node.effects) && (
                <button type="button" onClick={() => run(() => api.clearLayerStyle(menuShown.node.id))}>
                  <Trash2 size={13} /> Clear Layer Style
                </button>
              )}
              <button type="button" onClick={() => run(() => api.openFilters(menuShown.node.id))}>
                <FlaskConical size={13} /> Smart Filters…
              </button>
            </>
          )}
          <div className={styles.menuSep} />
          {menuShown.node.mask ? (
            <>
              <button type="button" onClick={() => run(api.loadMaskAsSelection)}>
                <MaskIcon size={13} /> Mask to Selection
              </button>
              <button type="button" onClick={() => run(() => api.toggleMaskEnabled(menuShown.node.id))}>
                <MaskIcon size={13} /> {menuShown.node.mask.enabled ? "Disable mask" : "Enable mask"}
              </button>
              <button type="button" onClick={() => run(api.applyMask)}>
                <MaskIcon size={13} /> Apply Mask
              </button>
              <button type="button" className={styles.menuDanger} onClick={() => run(api.removeMask)}>
                <Trash2 size={13} /> Delete Mask
              </button>
            </>
          ) : (
            <>
              <button type="button" onClick={() => run(() => api.addMask("reveal"))}>
                <MaskIcon size={13} /> Add Layer Mask
              </button>
              <button type="button" onClick={() => run(() => api.addMask("selection"))}>
                <MaskIcon size={13} /> Mask from Selection
              </button>
            </>
          )}
          <div className={styles.menuSep} />
          <button type="button" className={styles.menuDanger} onClick={() => run(api.remove)}>
            <Trash2 size={13} /> {multi ? "Delete layers" : "Delete"}
          </button>
        </Popup>
      )}
    </div>
  );
}
