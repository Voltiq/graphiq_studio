/**
 * Crash recovery plumbing (TODO §15).
 *
 * When a render throws, React unmounts the subtree — which in this app means
 * the editor, its refs, and every closure that knew how to serialize the open
 * documents. That is exactly the moment the user most needs those documents
 * written to disk. So the ability to snapshot them lives HERE, at module scope,
 * where an unmount cannot reach it: the editor registers a collector while it is
 * alive, and the error boundary calls it afterwards.
 *
 * Two rules follow from what this is for:
 *
 *   - Nothing here may throw. It runs after something already went wrong; a
 *     recovery path that fails loudly is worse than no recovery path.
 *   - The report is safe to paste in public. It carries the error, the app
 *     version, the browser, and the SHAPE of the open documents (how many, how
 *     big) — never pixels, never file contents, never names of files on disk.
 *
 * DOM-free and testable in Node, apart from the optional `env` the caller
 * passes in.
 */

/** One document's `.gproj` JSON plus its display name — the same shape autosave
 *  stores, so a recovery copy and an autosave entry are interchangeable. */
export interface RecoveryDoc {
  json: string;
  name: string;
}

/** Returns every open document, serialized. Registered by the editor. */
export type RecoverySource = () => RecoveryDoc[];

export interface CrashInfo {
  message: string;
  stack?: string;
  /** React's component stack, when the error came through a boundary. */
  componentStack?: string;
  at: Date;
}

export interface CrashEnv {
  version?: string;
  userAgent?: string;
  url?: string;
  language?: string;
  screen?: string;
}

/** Where a recovery copy came from, so the dialog can say so honestly. */
export type RecoveryOrigin = "live" | "none";

export interface RecoveryResult {
  docs: RecoveryDoc[];
  origin: RecoveryOrigin;
  /** Why a live collection produced nothing, when it did not. */
  problem?: string;
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

let source: RecoverySource | null = null;

/** Editor: call with a collector on mount, and with null on unmount. */
export function registerRecovery(fn: RecoverySource | null): void {
  source = fn;
}

export const hasRecoverySource = (): boolean => !!source;

/**
 * Snapshot the open documents, after a crash.
 *
 * The collector reads engine canvases and React refs belonging to a tree that
 * has just been torn down, so it is entirely possible for it to throw or come
 * back empty. That is not an error to propagate — it is a result to report, so
 * the dialog can offer the (older) autosave snapshot instead.
 */
export function collectRecovery(): RecoveryResult {
  if (!source) return { docs: [], origin: "none", problem: "no collector was registered" };
  try {
    const docs = source().filter((d) => d && typeof d.json === "string" && d.json.length > 0);
    if (!docs.length) return { docs: [], origin: "none", problem: "no documents were open" };
    return { docs, origin: "live" };
  } catch (e) {
    return { docs: [], origin: "none", problem: describe(e) };
  }
}

// ---------------------------------------------------------------------------
// Recent runtime errors
// ---------------------------------------------------------------------------

const RECENT_MAX = 10;
const recent: string[] = [];

/**
 * Note an error that did NOT bring the tree down — a throw inside a pointer
 * handler, a rejected promise. Most of this app's work happens in event
 * handlers, which React error boundaries do not see, so these would otherwise
 * leave no trace at all; kept as context for whatever crashes later.
 */
export function noteRuntimeError(message: string, at = new Date()): void {
  const line = `${at.toISOString()}  ${String(message).slice(0, 300)}`;
  if (recent[recent.length - 1] === line) return; // a loop firing every frame
  recent.push(line);
  if (recent.length > RECENT_MAX) recent.shift();
}

export const recentErrors = (): string[] => [...recent];
export const clearRecentErrors = (): void => void (recent.length = 0);

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

/** Anything at all → a non-empty string. `throw undefined` and a promise
 *  rejected with no reason both reach here, and `JSON.stringify(undefined)`
 *  returns undefined rather than a string — which would leave the crash dialog
 *  displaying nothing where the error should be. */
function describe(e: unknown): string {
  if (e instanceof Error) return `${e.name}: ${e.message}`;
  if (typeof e === "string") return e || "(empty error)";
  if (e === undefined) return "undefined was thrown";
  if (e === null) return "null was thrown";
  try {
    return JSON.stringify(e) ?? String(e);
  } catch {
    return String(e); // circular, or a throwing toJSON
  }
}

/** Turn anything thrown into a CrashInfo — including the non-Errors that a
 *  `throw "oops"` or a rejected promise can produce. */
export function toCrashInfo(e: unknown, componentStack?: string, at = new Date()): CrashInfo {
  if (e instanceof Error) {
    return { message: `${e.name}: ${e.message}`, stack: e.stack, componentStack, at };
  }
  return { message: describe(e), componentStack, at };
}

/** Truncate a stack to its most useful part: the top frames. */
export function trimStack(stack: string | undefined, lines = 12): string {
  if (!stack) return "";
  const rows = stack.split("\n").map((r) => r.trimEnd());
  return rows.length <= lines ? rows.join("\n") : [...rows.slice(0, lines), `  … ${rows.length - lines} more`].join("\n");
}

/**
 * A plain-text report the user can paste into a bug report.
 *
 * Documents appear as `name (12.4 KB)` — enough to say "three documents were
 * open and one was large" without carrying a single pixel of the user's work
 * out of the browser.
 */
export function formatReport(info: CrashInfo, env: CrashEnv = {}, docs: RecoveryDoc[] = []): string {
  const out: string[] = ["Graphiq Studio — crash report", ""];
  out.push(`when     ${info.at.toISOString()}`);
  if (env.version) out.push(`version  ${env.version}`);
  if (env.url) out.push(`url      ${env.url}`);
  if (env.userAgent) out.push(`browser  ${env.userAgent}`);
  if (env.language) out.push(`language ${env.language}`);
  if (env.screen) out.push(`screen   ${env.screen}`);
  out.push("", `error    ${info.message}`);
  if (info.stack) out.push("", "stack", trimStack(info.stack));
  if (info.componentStack) out.push("", "component stack", trimStack(info.componentStack, 10));
  if (docs.length) {
    out.push("", `documents open (${docs.length})`);
    for (const d of docs) out.push(`  ${d.name} (${formatBytes(d.json.length)})`);
  }
  const errs = recentErrors();
  if (errs.length) {
    out.push("", `earlier runtime errors (${errs.length})`);
    for (const e of errs) out.push(`  ${e}`);
  }
  out.push("", "No image data is included in this report.");
  return out.join("\n");
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** `My photo.gproj` → `My-photo-recovered-2026-08-16-1830.gproj`.
 *
 *  A document name is user input on its way into a `download` attribute, so
 *  anything outside a safe set becomes a dash — and runs of dots go too: `..`
 *  survived an earlier version of this, and a name that begins with a dot is a
 *  hidden file on half the systems this will land on. */
export function recoveryFilename(name: string, ext: string, at = new Date()): string {
  const base =
    (name || "Untitled")
      .replace(/\.[a-z0-9]{1,8}$/i, "")
      .replace(/[^\w.-]+/g, "-")
      .replace(/\.{2,}/g, "-")
      .replace(/-{2,}/g, "-")
      .replace(/^[.-]+|[.-]+$/g, "")
      .slice(0, 60) || "Untitled";
  const p = (v: number) => String(v).padStart(2, "0");
  const stamp =
    `${at.getFullYear()}-${p(at.getMonth() + 1)}-${p(at.getDate())}` +
    `-${p(at.getHours())}${p(at.getMinutes())}`;
  return `${base}-recovered-${stamp}.${ext}`;
}

/** "4 minutes ago" for the age of an autosave snapshot. */
export function describeAge(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 45) return "moments ago";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} minute${m === 1 ? "" : "s"} ago`;
  const h = Math.round(m / 60);
  return `${h} hour${h === 1 ? "" : "s"} ago`;
}
