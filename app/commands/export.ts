// The export family (TODO 1.10): the Export dialog opened on the flattened
// image, a single export (its metadata embedded or not) and a batch of them as
// one .zip, a layered PSD, the vector layers as an SVG, and the top-level
// layers as a sequence of frames.
//
// `exportOps` is called on every render of Editor, as `layerOps` is.

import type { BatchRun } from "../components/ExportDialog";
import { delayFromLabel } from "../lib/animated";
import { dedupeFilenames, targetFilename } from "../lib/exportpresets";
import { availableFormats, renderExport, saveImageBlob, type ExportOptions } from "../lib/imageio";
import type { LayerLeaf, LayerNode } from "../lib/layers";
import { embedMetadata, type ExportMetadata } from "../lib/metadata-write";
import type { EngineHandle } from "../lib/paint";
import type { Preferences } from "../lib/prefs";
import { buildPSD, type PsdOutNode } from "../lib/psd";
import { saveExportBlob } from "../lib/share";
import { exportSVG } from "../lib/svg";
import { buildZip, type ZipEntry } from "../lib/zip";
import type { Doc } from "../state/documents";

/** What the export operations need of the editor. */
export interface ExportContext {
  /** The active document — the latest, read when an export runs. */
  activeDocRef: { readonly current: Doc };
  paintRef: { readonly current: EngineHandle | null };
  prefsRef: { readonly current: Preferences };
  showToast(message: string): void;
  /** The flattened image the Export dialog is open on, as this render sees it. */
  exportComposite: HTMLCanvasElement | null;
  setExportComposite(composite: HTMLCanvasElement | null): void;
}

export function exportOps(ctx: ExportContext) {
  const { activeDocRef, paintRef, prefsRef, showToast, exportComposite, setExportComposite } = ctx;

  const openExport = () => {
    const composite = paintRef.current?.exportComposite(activeDocRef.current.layers);
    if (composite) setExportComposite(composite);
  };

  /** What an export of `d` would embed: the document's own metadata (raw EXIF
   *  twins) with the Preferences attribution as fallback, plus the doc's ppi. */
  const exportMetaFor = (d: Doc): ExportMetadata => {
    const m = d.metadata;
    const p = prefsRef.current;
    return {
      description: m?.description || undefined,
      artist: m?.artist || p.authorName.trim() || undefined,
      copyright: m?.copyright || p.copyrightNotice.trim() || undefined,
      make: m?.make,
      model: m?.model,
      lensModel: m?.lensModel,
      dateTakenRaw: m?.dateTakenRaw,
      exposureTime: m?.exposureTime,
      fNumberValue: m?.fNumberValue,
      iso: m?.iso,
      focalLengthMm: m?.focalLengthMm,
      focalLength35Mm: m?.focalLength35Mm,
      gps: m?.gps,
      dpi: d.dpi ?? 300,
    };
  };

  const doExport = async (opts: ExportOptions, filename: string, embedMeta: boolean) => {
    if (!exportComposite) return;
    let blob = await renderExport(exportComposite, opts);
    if (blob && embedMeta) {
      blob = await embedMetadata(
        blob,
        opts.format.id,
        exportMetaFor(activeDocRef.current),
        Math.max(1, Math.round(exportComposite.width * opts.scale)),
        Math.max(1, Math.round(exportComposite.height * opts.scale)),
      );
    }
    if (blob) {
      const base = filename.trim() || activeDocRef.current.name;
      await saveImageBlob(blob, `${base}.${opts.format.ext}`, opts.format);
    }
    setExportComposite(null);
  };

  // Batch export: encode every target (format + scale + quality) from the same
  // composite, name each through the shared filename template, and download
  // them as ONE .zip (store method — the images are already compressed).
  const doBatchExport = async (run: BatchRun, docName: string) => {
    const comp = exportComposite;
    if (!comp || !run.targets.length) return;
    const fmts = availableFormats();
    const fmtById = (id: string) => fmts.find((f) => f.id === id) ?? fmts[0];
    const names: string[] = [];
    const datas: Uint8Array<ArrayBuffer>[] = [];
    let failed = 0;
    const meta = run.embedMeta ? exportMetaFor(activeDocRef.current) : null;
    for (let i = 0; i < run.targets.length; i++) {
      const t = run.targets[i];
      const fmt = fmtById(t.formatId);
      let blob = await renderExport(comp, {
        format: fmt,
        quality: t.quality / 100,
        scale: t.scalePct / 100,
        transparent: true, // per-target mattes aren't modelled; alpha formats stay transparent
        matte: "#ffffffff",
      });
      if (blob && meta) {
        blob = await embedMetadata(
          blob,
          fmt.id,
          meta,
          Math.max(1, Math.round(comp.width * (t.scalePct / 100))),
          Math.max(1, Math.round(comp.height * (t.scalePct / 100))),
        );
      }
      if (!blob) {
        failed++;
        continue;
      }
      names.push(targetFilename(t, run.template, docName, comp.width, comp.height, i + 1, fmt.ext));
      datas.push(new Uint8Array(await blob.arrayBuffer()));
    }
    if (!datas.length) {
      showToast("Batch export failed — nothing could be encoded.");
      return;
    }
    const unique = dedupeFilenames(names);
    const zip = buildZip(unique.map((name, i) => ({ name, data: datas[i] })));
    void saveExportBlob(zip, `${(docName.trim() || "export").replace(/\.zip$/i, "")}.zip`);
    setExportComposite(null);
    showToast(
      failed
        ? `Exported ${datas.length} file${datas.length === 1 ? "" : "s"} — ${failed} failed to encode`
        : `Exported ${datas.length} file${datas.length === 1 ? "" : "s"} as .zip`,
    );
  };

  /**
   * File ▸ Export frames — write each top-level LAYER out as its own numbered
   * PNG inside a zip. This is the timeline-less half of animation support: the
   * document already models an animation as a layer stack (that is what an
   * animated import produces), so "export the frames" is "export the layers",
   * and no timeline UI has to exist first.
   *
   * Each frame is rendered on its own — the layer alone over transparency, at
   * full canvas size — so the sequence round-trips what was imported. Delays
   * survive in the filenames, which is the only channel a plain image sequence
   * has for them.
   */
  const exportFrames = async () => {
    const doc = activeDocRef.current;
    const eng = paintRef.current;
    // Only top-level leaves are frames; a group is a composed thing, not a frame.
    const frames = doc.layers.filter((n): n is LayerLeaf => n.type === "layer");
    if (!eng || frames.length < 2) {
      showToast(
        frames.length < 2
          ? "Export frames needs at least two layers — each layer becomes one frame."
          : "Nothing to export.",
      );
      return;
    }
    const canvas = document.createElement("canvas");
    canvas.width = doc.width;
    canvas.height = doc.height;
    const ctx = canvas.getContext("2d")!;
    const entries: ZipEntry[] = [];
    const base = (doc.name.trim() || "frames").replace(/\.[a-z0-9]+$/i, "");
    const pad = String(frames.length).length;
    // Bottom-up: the stack shows frame 1 at the bottom, so reverse to play order.
    const ordered = [...frames].reverse();
    let skipped = 0;
    for (let i = 0; i < ordered.length; i++) {
      const src = eng.getLayerCanvas(ordered[i].id);
      if (!src) {
        skipped++;
        continue;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(src, 0, 0);
      const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
      if (!blob) {
        skipped++;
        continue;
      }
      const delay = delayFromLabel(ordered[i].name);
      const n = String(i + 1).padStart(pad, "0");
      entries.push({
        name: `${base}-${n}${delay ? `-${delay}ms` : ""}.png`,
        data: new Uint8Array(await blob.arrayBuffer()),
      });
    }
    if (!entries.length) {
      showToast("Export frames failed — nothing could be encoded.");
      return;
    }
    void saveExportBlob(buildZip(entries), `${base}-frames.zip`);
    showToast(
      `Exported ${entries.length} frame${entries.length === 1 ? "" : "s"} as .zip` +
        (skipped ? ` (${skipped} empty layer${skipped === 1 ? "" : "s"} skipped)` : ""),
    );
  };

  // Serialize the document's vector-bearing layers (shape / text / imported
  // SVG) to a standalone .svg download. Raster/adjustment layers, masks and
  // layer effects have no vector source — they're skipped and reported.
  const exportVectorSVG = () => {
    const d = activeDocRef.current;
    const { svg, vectorLayers, skipped } = exportSVG(d.layers, d.width, d.height);
    if (!vectorLayers) {
      window.alert(
        "No vector layers to export. SVG export covers shape layers, text layers and imported SVG vector layers.",
      );
      return;
    }
    const name = (d.name || "artwork").replace(/\.svg$/i, "");
    void saveExportBlob(new Blob([svg], { type: "image/svg+xml" }), `${name}.svg`);
    showToast(
      skipped
        ? `Exported ${vectorLayers} vector layer${vectorLayers === 1 ? "" : "s"} — ${skipped} without a vector source skipped`
        : `Exported ${vectorLayers} vector layer${vectorLayers === 1 ? "" : "s"}`,
    );
  };

  // Write the document as a layered PSD: the full tree (groups as section
  // dividers), masks, opacity/blend/clipping/visibility, plus the flattened
  // composite every PSD reader requires. Adjustment layers have no PSD
  // equivalent in our model and are skipped (the composite keeps the look).
  const exportPSD = () => {
    const d = activeDocRef.current;
    const eng = paintRef.current;
    if (!eng) return;
    const leafIds: string[] = [];
    const collectIds = (ns: LayerNode[]) =>
      ns.forEach((n) => {
        if (n.type === "layer") leafIds.push(n.id);
        else if (n.type === "group") collectIds(n.children);
      });
    collectIds(d.layers);
    const snaps = eng.captureLeaves(leafIds);
    let skipped = 0;
    const convert = (ns: LayerNode[]): PsdOutNode[] =>
      ns.flatMap((n): PsdOutNode[] => {
        if (n.type === "adjustment") {
          skipped++;
          return [];
        }
        if (n.type === "group")
          return [
            {
              kind: "group",
              name: n.name,
              visible: n.visible,
              opacity: n.opacity,
              blend: n.blend,
              children: convert(n.children),
              mask: n.mask ? (eng.captureMask(n.id) ?? null) : null,
              maskEnabled: n.mask?.enabled !== false,
            },
          ];
        const snap = snaps.get(n.id);
        return [
          {
            kind: "layer",
            name: n.name,
            visible: n.visible,
            opacity: n.opacity,
            blend: n.blend,
            clipped: !!n.clipped,
            image: snap?.layer ?? null,
            mask: n.mask ? (snap?.mask ?? null) : null,
            maskEnabled: n.mask?.enabled !== false,
          },
        ];
      });
    const nodes = convert(d.layers);
    const comp = eng.exportComposite(d.layers);
    const ctx = comp.getContext("2d");
    if (!ctx) return;
    const buf = buildPSD(
      d.width,
      d.height,
      d.dpi ?? 300,
      nodes,
      ctx.getImageData(0, 0, comp.width, comp.height),
    );
    void saveExportBlob(new Blob([buf], { type: "image/vnd.adobe.photoshop" }), `${d.name || "artwork"}.psd`);
    showToast(
      skipped
        ? `Exported PSD — ${skipped} adjustment layer${skipped === 1 ? "" : "s"} skipped (no PSD equivalent)`
        : "Exported PSD",
    );
  };

  return {
    openExport,
    exportMetaFor,
    doExport,
    doBatchExport,
    exportFrames,
    exportVectorSVG,
    exportPSD,
  };
}
