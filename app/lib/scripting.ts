// Scripting hook — TODO §14. A SAFE dev console API on `window.graphiq`.
//
// Power users get a curated surface, not the raw engine: every mutation routes
// through the SAME paths the UI uses — menu-command dispatch (journaled,
// undoable, identical to clicking the menu / palette / shortcut), the Layers
// panel's live-patch API, the Actions player and the export compositor. That
// makes the hook safe by construction: nothing here can put a document into a
// state the UI itself couldn't.
//
// The API object is built ONCE and reads a deps ref at call time, so console
// snippets always see the live editor state. `graphiq.help()` prints the
// cheat sheet; the Help dialog documents it too. Dev tool honesty: the
// surface may grow between versions — `version` bumps when it changes shape.

import { MENUS } from "./menus";
import type { LayersApi, LayerNode } from "./layers";
import type { EngineHandle } from "./paint";
import type { Rect } from "./view";
import type { SavedAction } from "./actions";
import { downloadBlob } from "./project";

/** Compact, serializable layer-tree summary (no engine objects leak out). */
export interface ScriptLayerNode {
  id: string;
  name: string;
  type: string;
  visible: boolean;
  opacity: number;
  blend: string;
  children?: ScriptLayerNode[];
}

/** Everything the api reads — Editor assigns this ref fresh every render. */
export interface ScriptingDeps {
  docs: { id: string; name: string; width: number; height: number }[];
  activeId: string;
  setActiveId: (id: string) => void;
  handleMenuAction: (action: string) => void;
  layersApi: LayersApi;
  foreground: string;
  setForeground: (hex: string) => void;
  setSelection: (rects: Rect[]) => void;
  savedActions: SavedAction[];
  playAction: (id: string) => Promise<void>;
  /** The live engine handle ref (CanvasArea re-points it per active doc). */
  engineRef: { current: EngineHandle | null };
  activeLayers: LayerNode[];
}

export interface GraphiqScripting {
  readonly version: 1;
  /** Print the cheat sheet to the console. */
  help(): void;
  /** Open documents (tabs). */
  docs(): { id: string; name: string; width: number; height: number; active: boolean }[];
  /** Switch tabs. */
  activate(docId: string): boolean;
  /** Every executable command id (the same ids menus/palette/actions use). */
  commands(): string[];
  /** Dispatch a command — identical to clicking it (journaled, undoable). */
  run(actionId: string): boolean;
  /** Layer-tree summary of the active document. */
  layers(): ScriptLayerNode[];
  /** Make a layer active (Layers-panel select). */
  selectLayer(id: string): boolean;
  /** Patch name / visible / opacity / blend on a layer. */
  setLayer(
    id: string,
    patch: { name?: string; visible?: boolean; opacity?: number; blend?: string },
  ): boolean;
  foreground(): string;
  setForeground(hex: string): void;
  /** Replace the selection with rects (null / [] = deselect). */
  select(rects: { x: number; y: number; w: number; h: number }[] | null): void;
  undo(): void;
  redo(): void;
  /** Saved actions (macros). */
  actions(): { id: string; name: string; steps: number }[];
  /** Play a saved action by id or (first-match) name. Resolves when done. */
  play(idOrName: string): Promise<boolean>;
  /** Flattened composite as a PNG blob (scale 1 = full size). */
  exportPNG(scale?: number): Promise<Blob | null>;
  /** exportPNG + download. */
  download(filename?: string, scale?: number): Promise<boolean>;
}

/** Every menu item id that actually dispatches (pure — Node-verified). */
export function executableCommandIds(): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const menu of MENUS) {
    for (const item of menu.items) {
      if (item.action && !seen.has(item.action)) {
        seen.add(item.action);
        out.push(item.action);
      }
    }
  }
  return out;
}

/** Resolve a saved action by exact id, then by first name match (pure). */
export function resolveAction(list: SavedAction[], idOrName: string): SavedAction | null {
  return list.find((a) => a.id === idOrName) ?? list.find((a) => a.name === idOrName) ?? null;
}

/** LayerNode tree → plain summary (pure). */
export function summarizeLayers(nodes: LayerNode[]): ScriptLayerNode[] {
  return nodes.map((n) => {
    const base: ScriptLayerNode = {
      id: n.id,
      name: n.name,
      type: n.type,
      visible: n.visible,
      opacity: n.opacity,
      blend: n.blend,
    };
    if (n.type === "group") base.children = summarizeLayers(n.children);
    return base;
  });
}

const HELP = `graphiq v1 — the scripting hook (everything routes through the same
journaled paths as the UI, so it is all undoable):

  graphiq.docs()                     open tabs; .activate(id) switches
  graphiq.commands()                 all command ids; .run(id) dispatches one
  graphiq.layers()                   layer-tree summary of the active document
  graphiq.selectLayer(id)            make a layer active
  graphiq.setLayer(id, {name, visible, opacity, blend})
  graphiq.foreground() / .setForeground("#ff8800")
  graphiq.select([{x,y,w,h}, …])     replace the selection (null = deselect)
  graphiq.undo() / .redo()
  graphiq.actions()                  saved macros; await graphiq.play(idOrName)
  await graphiq.exportPNG(scale?)    composite as a PNG Blob
  await graphiq.download(name?, scale?)

Example — run a macro over the current doc and save the result:
  await graphiq.play("My action"); await graphiq.download("result.png");`;

/** Build the console API around a live deps ref (read fresh on every call). */
export function buildScriptingApi(depsRef: { current: ScriptingDeps | null }): GraphiqScripting {
  const deps = (): ScriptingDeps | null => depsRef.current;
  const known = new Set(executableCommandIds());
  return {
    version: 1,
    help() {
      console.log(HELP);
    },
    docs() {
      const d = deps();
      if (!d) return [];
      return d.docs.map((x) => ({
        id: x.id,
        name: x.name,
        width: x.width,
        height: x.height,
        active: x.id === d.activeId,
      }));
    },
    activate(docId) {
      const d = deps();
      if (!d || !d.docs.some((x) => x.id === docId)) return false;
      d.setActiveId(docId);
      return true;
    },
    commands() {
      return executableCommandIds();
    },
    run(actionId) {
      const d = deps();
      if (!d) return false;
      if (!known.has(actionId)) {
        console.warn(`graphiq.run: unknown command "${actionId}" — see graphiq.commands()`);
        return false;
      }
      d.handleMenuAction(actionId);
      return true;
    },
    layers() {
      const d = deps();
      return d ? summarizeLayers(d.activeLayers) : [];
    },
    selectLayer(id) {
      const d = deps();
      if (!d) return false;
      d.layersApi.select(id, "replace");
      return true;
    },
    setLayer(id, patch) {
      const d = deps();
      if (!d) return false;
      const p: { name?: string; visible?: boolean; opacity?: number; blend?: string } = {};
      if (typeof patch.name === "string") p.name = patch.name;
      if (typeof patch.visible === "boolean") p.visible = patch.visible;
      if (typeof patch.opacity === "number" && Number.isFinite(patch.opacity)) {
        p.opacity = Math.max(0, Math.min(100, patch.opacity));
      }
      if (typeof patch.blend === "string") p.blend = patch.blend;
      d.layersApi.update(id, p);
      return true;
    },
    foreground() {
      return deps()?.foreground ?? "#000000";
    },
    setForeground(hex) {
      deps()?.setForeground(hex);
    },
    select(rects) {
      const d = deps();
      if (!d) return;
      const clean = (rects ?? []).filter(
        (r) =>
          r &&
          [r.x, r.y, r.w, r.h].every((v) => Number.isFinite(v)) &&
          r.w > 0 &&
          r.h > 0,
      );
      d.setSelection(clean.map((r) => ({ x: r.x, y: r.y, w: r.w, h: r.h })));
    },
    undo() {
      deps()?.engineRef.current?.undo();
    },
    redo() {
      deps()?.engineRef.current?.redo();
    },
    actions() {
      return (deps()?.savedActions ?? []).map((a) => ({
        id: a.id,
        name: a.name,
        steps: a.steps.length,
      }));
    },
    async play(idOrName) {
      const d = deps();
      if (!d) return false;
      const act = resolveAction(d.savedActions, idOrName);
      if (!act) {
        console.warn(`graphiq.play: no action "${idOrName}" — see graphiq.actions()`);
        return false;
      }
      await d.playAction(act.id);
      return true;
    },
    async exportPNG(scale = 1) {
      const d = deps();
      const src = d?.engineRef.current?.exportComposite(d.activeLayers);
      if (!src) return null;
      const k = Number.isFinite(scale) && scale > 0 ? scale : 1;
      let c = src;
      if (k !== 1) {
        c = document.createElement("canvas");
        c.width = Math.max(1, Math.round(src.width * k));
        c.height = Math.max(1, Math.round(src.height * k));
        const ctx = c.getContext("2d");
        if (!ctx) return null;
        ctx.imageSmoothingEnabled = true;
        ctx.imageSmoothingQuality = "high";
        ctx.drawImage(src, 0, 0, c.width, c.height);
      }
      return new Promise((resolve) => c.toBlob((b) => resolve(b), "image/png"));
    },
    async download(filename, scale = 1) {
      const d = deps();
      const blob = await this.exportPNG(scale);
      if (!blob) return false;
      const name = filename?.trim() || `${d?.docs.find((x) => x.id === d.activeId)?.name ?? "graphiq"}.png`;
      downloadBlob(blob, name.endsWith(".png") ? name : `${name}.png`);
      return true;
    },
  };
}

declare global {
  interface Window {
    graphiq?: GraphiqScripting;
  }
}
