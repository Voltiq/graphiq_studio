// Export presets + batch-export targets + filename templates (TODO §9).
// Pure model, persistence and string logic — the encode/save side lives in
// Editor/imageio. The template + sanitization helpers are Node-testable.

/** A saved Export-As configuration (format + quality + scale + matte). */
export interface ExportPreset {
  id: string;
  name: string;
  /** ExportFormat id ("png" / "jpeg" / "webp" / "avif"). */
  formatId: string;
  /** Quality 0..100 (lossy formats). */
  quality: number;
  /** Scale as a percentage (100 = full size). */
  scalePct: number;
  transparent: boolean;
  matte: string;
  /** True for the shipped presets (shown first, not deletable). */
  builtin?: boolean;
}

/** One row of a batch export: a format + size, named by the shared template. */
export interface BatchTarget {
  id: string;
  formatId: string;
  quality: number;
  scalePct: number;
  /** Optional suffix distinguishing this target when the template lacks size
   *  tokens (keeps filenames unique). Appended before the extension. */
  suffix: string;
}

export const EXPORT_PRESETS_KEY = "graphiq:export-presets";

/** Shipped presets — always available, shown before the user's own. */
export const BUILTIN_EXPORT_PRESETS: ExportPreset[] = [
  { id: "b-png", name: "PNG — full size", formatId: "png", quality: 100, scalePct: 100, transparent: true, matte: "#ffffffff", builtin: true },
  { id: "b-jpeg", name: "JPEG — web (85%)", formatId: "jpeg", quality: 85, scalePct: 100, transparent: false, matte: "#ffffffff", builtin: true },
  { id: "b-webp", name: "WebP — web (80%)", formatId: "webp", quality: 80, scalePct: 100, transparent: true, matte: "#ffffffff", builtin: true },
  { id: "b-half", name: "PNG — half size", formatId: "png", quality: 100, scalePct: 50, transparent: true, matte: "#ffffffff", builtin: true },
];

export function loadExportPresets(): ExportPreset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(EXPORT_PRESETS_KEY);
    const list = raw ? (JSON.parse(raw) as ExportPreset[]) : [];
    return Array.isArray(list) ? list.filter((p) => p && !p.builtin) : [];
  } catch {
    return [];
  }
}

export function saveExportPresets(list: ExportPreset[]): void {
  try {
    // Never persist the built-ins (they're code, not user data).
    window.localStorage.setItem(EXPORT_PRESETS_KEY, JSON.stringify(list.filter((p) => !p.builtin)));
  } catch {
    /* ignore (private mode / quota) */
  }
}

export function freshPresetId(): string {
  return `ep-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

// ---------------------------------------------------------------------------
// Filename templates
// ---------------------------------------------------------------------------

/** Values a filename template can reference. */
export interface TemplateContext {
  /** Base document name (no extension). */
  name: string;
  /** Output pixel size (post-scale). */
  w: number;
  h: number;
  /** Scale percentage (100 = full). */
  scale: number;
  /** Format id / extension. */
  ext: string;
  /** 1-based index within a batch run. */
  index: number;
}

/** Reduce a string to a safe basename: replace path separators, illegal
 *  characters and spaces with hyphens, collapse hyphen runs, trim edges. */
export function sanitizeFilename(s: string): string {
  const cleaned = s
    .replace(/[\/:*?"<>|\s-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120);
  return cleaned || "export";
}

/** The template tokens shown in the help text. */
export const TEMPLATE_TOKENS = ["{name}", "{w}", "{h}", "{scale}", "{ext}", "{n}"] as const;

/**
 * Expand a filename template. Unknown tokens are left as-is (so a stray brace
 * doesn't vanish silently); the result is sanitized to a safe basename (no
 * extension — the caller appends `.ext`).
 */
export function applyTemplate(template: string, ctx: TemplateContext): string {
  const map: Record<string, string> = {
    "{name}": ctx.name,
    "{w}": String(ctx.w),
    "{h}": String(ctx.h),
    "{scale}": String(ctx.scale),
    "{ext}": ctx.ext,
    "{n}": String(ctx.index),
  };
  const out = template.replace(/\{name\}|\{w\}|\{h\}|\{scale\}|\{ext\}|\{n\}/g, (m) => map[m] ?? m);
  return sanitizeFilename(out);
}

export function freshTargetId(): string {
  return `bt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** The full output filename (with extension) for one batch target. */
export function targetFilename(
  target: BatchTarget,
  template: string,
  docName: string,
  compW: number,
  compH: number,
  index: number,
  ext: string,
): string {
  const w = Math.max(1, Math.round((compW * target.scalePct) / 100));
  const h = Math.max(1, Math.round((compH * target.scalePct) / 100));
  let base = applyTemplate(template, { name: docName, w, h, scale: target.scalePct, ext, index });
  if (target.suffix) base = sanitizeFilename(base + target.suffix);
  return `${base}.${ext}`;
}

/** De-duplicate a list of filenames in order, appending -2, -3, … to later
 *  collisions (case-insensitive) while preserving each extension. */
export function dedupeFilenames(names: string[]): string[] {
  const seen = new Map<string, number>();
  return names.map((full) => {
    const dot = full.lastIndexOf(".");
    const base = dot > 0 ? full.slice(0, dot) : full;
    const ext = dot > 0 ? full.slice(dot) : "";
    const key = full.toLowerCase();
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n === 0 ? full : `${base}-${n + 1}${ext}`;
  });
}

/** A sensible starting batch: full-size PNG + half-size JPEG. */
export function defaultBatchTargets(): BatchTarget[] {
  return [
    { id: freshTargetId(), formatId: "png", quality: 100, scalePct: 100, suffix: "" },
    { id: freshTargetId(), formatId: "jpeg", quality: 85, scalePct: 50, suffix: "@0.5x" },
  ];
}
