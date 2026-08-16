"use client";

import { Component, useEffect, useState, type ReactNode } from "react";
import { AlertTriangle, Check, ClipboardCopy, Download, RotateCcw } from "lucide-react";
import styles from "./ErrorBoundary.module.scss";
import {
  collectRecovery,
  describeAge,
  formatBytes,
  formatReport,
  noteRuntimeError,
  recoveryFilename,
  toCrashInfo,
  type CrashInfo,
  type RecoveryDoc,
  type RecoveryResult,
} from "../lib/crash";
import { downloadBlob, PROJECT_EXT } from "../lib/project";
import { readAutosave } from "../lib/autosave";
import { buildZip, type ZipEntry } from "../lib/zip";
import pkg from "../../package.json";

/**
 * The last line of defence: if a render throws, the editor is gone, but the
 * user's unsaved work may still be recoverable from the engine. This catches
 * the error, offers to write every open document to disk as `.gproj`, and gives
 * them a report to paste into a bug.
 *
 * WHAT IT DOES NOT CATCH, said plainly: React error boundaries only see errors
 * thrown while RENDERING. Most of this app's work happens in pointer handlers
 * and async callbacks, and a throw there leaves the UI standing (usually with
 * one tool silently dead). Those are recorded via `noteRuntimeError` so they
 * appear as context in whatever crash comes later, but they do not raise this
 * screen — replacing a working editor with a crash dialog because one gesture
 * failed would lose more work than it saved.
 */
interface State {
  info: CrashInfo | null;
  /** Collected in `componentDidCatch`, as close to the moment of the crash as
   *  React allows. Leaving it until a child's effect would give the torn-down
   *  editor more time to become unreadable, for no benefit. */
  recovery: RecoveryResult | null;
  /** Dev-only probe, so the recovery path can be exercised on purpose. */
  armed: boolean;
}

/** Throws during render when armed — an error boundary cannot catch its own
 *  render, so the deliberate crash has to come from a child. */
function CrashProbe({ armed }: { armed: boolean }) {
  if (armed) throw new Error("Deliberate crash from the dev probe (window.__gqCrash)");
  return null;
}

export default class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { info: null, recovery: null, armed: false };

  static getDerivedStateFromError(error: unknown): Partial<State> {
    return { info: toCrashInfo(error) };
  }

  componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    this.setState({
      info: toCrashInfo(error, info.componentStack ?? undefined),
      recovery: collectRecovery(),
    });
    // Still worth the console: the report is for the user, this is for whoever
    // has devtools open.
    console.error("Graphiq crashed:", error);
  }

  componentDidMount() {
    window.addEventListener("error", this.onWindowError);
    window.addEventListener("unhandledrejection", this.onRejection);
    if (process.env.NODE_ENV !== "production") {
      (window as unknown as { __gqCrash?: () => void }).__gqCrash = () => this.setState({ armed: true });
    }
  }

  componentWillUnmount() {
    window.removeEventListener("error", this.onWindowError);
    window.removeEventListener("unhandledrejection", this.onRejection);
    delete (window as unknown as { __gqCrash?: () => void }).__gqCrash;
  }

  onWindowError = (e: ErrorEvent) => noteRuntimeError(e.message || String(e.error));
  onRejection = (e: PromiseRejectionEvent) =>
    noteRuntimeError(`unhandled rejection: ${String(e.reason?.message ?? e.reason)}`);

  render() {
    if (this.state.info) return <CrashScreen info={this.state.info} recovery={this.state.recovery} />;
    return (
      <>
        <CrashProbe armed={this.state.armed} />
        {this.props.children}
      </>
    );
  }
}

/** What can be saved, and where it came from. */
type Offer =
  | { kind: "live"; docs: RecoveryDoc[] }
  // The age is resolved when the snapshot is read, not when it is rendered:
  // reading the clock during render is impure (and the React compiler says so).
  | { kind: "autosave"; docs: RecoveryDoc[]; age: string }
  | { kind: "none"; problem?: string };

function CrashScreen({ info, recovery }: { info: CrashInfo; recovery: RecoveryResult | null }) {
  const [fallback, setFallback] = useState<Offer | null>(null);
  const [saved, setSaved] = useState(0);
  const [copied, setCopied] = useState(false);
  const [details, setDetails] = useState(false);

  // `recovery` arrives on the SECOND render: React renders this screen from
  // getDerivedStateFromError and only then calls componentDidCatch, which is
  // where the documents get collected. Deriving the offer from the prop rather
  // than seeding it into state is what makes that transition work — a
  // useState initializer runs once, with the prop still null, and an earlier
  // version of this file duly reported "no recoverable work" every time while
  // the pixels sat safely in the engine.
  const offer: Offer | null =
    recovery && recovery.origin === "live" ? { kind: "live", docs: recovery.docs } : fallback;

  // Nothing live to save: fall back to the last autosave — minutes old perhaps,
  // but written while everything still worked.
  useEffect(() => {
    if (!recovery || recovery.origin === "live") return;
    let cancelled = false;
    void readAutosave()
      .then((snap) => {
        if (cancelled) return;
        if (snap?.docs?.length)
          setFallback({ kind: "autosave", docs: snap.docs, age: describeAge(Date.now() - snap.savedAt) });
        else setFallback({ kind: "none", problem: recovery.problem });
      })
      .catch(() => !cancelled && setFallback({ kind: "none", problem: recovery.problem }));
    return () => {
      cancelled = true;
    };
  }, [recovery]);

  const docs = offer && offer.kind !== "none" ? offer.docs : [];
  const totalBytes = docs.reduce((n, d) => n + d.json.length, 0);

  const save = () => {
    const at = new Date();
    try {
      if (docs.length === 1) {
        downloadBlob(
          new Blob([docs[0].json], { type: "application/json" }),
          recoveryFilename(docs[0].name, PROJECT_EXT, at),
        );
        setSaved(1);
        return;
      }
      // Several documents go out as ONE zip rather than one download each.
      // Browsers throttle or silently block a page that fires several automatic
      // downloads in a row — measured: the same run wrote five files once and
      // two the next time — and losing a document to that at the exact moment
      // the user is promised all of them is the worst possible failure here.
      //
      // Tabs can also share a name (two untitled documents, or a file opened
      // beside the original it was saved from), so entries are de-duplicated:
      // inside a zip a repeated name is not merely confusing, it is a document
      // overwriting another.
      const used = new Map<string, number>();
      const enc = new TextEncoder();
      const entries: ZipEntry[] = docs.map((d) => {
        const base = recoveryFilename(d.name, PROJECT_EXT, at);
        const seen = used.get(base) ?? 0;
        used.set(base, seen + 1);
        return {
          name: seen ? base.replace(/\.([^.]+)$/, `-${seen + 1}.$1`) : base,
          data: enc.encode(d.json),
        };
      });
      downloadBlob(buildZip(entries, at), recoveryFilename("graphiq-recovery", "zip", at));
      setSaved(docs.length);
    } catch {
      setSaved(0); // nothing written; the button stays offering to try again
    }
  };

  const copy = () => {
    const report = formatReport(
      info,
      {
        version: pkg.version,
        userAgent: navigator.userAgent,
        url: location.href,
        language: navigator.language,
        screen: `${window.screen?.width}x${window.screen?.height} @${window.devicePixelRatio}x`,
      },
      docs,
    );
    void navigator.clipboard
      ?.writeText(report)
      .then(() => setCopied(true))
      .catch(() => setCopied(false));
  };

  return (
    <div className={styles.screen} role="alertdialog" aria-modal="true" aria-label="Graphiq has stopped">
      <div className={styles.card}>
        <header className={styles.head}>
          <span className={styles.icon}>
            <AlertTriangle size={20} />
          </span>
          <div>
            <h1>Graphiq has stopped</h1>
            <p className={styles.sub}>
              Something went wrong and the editor could not carry on. Your work has not been sent
              anywhere — it is still in this browser, and you can save a copy of it now.
            </p>
          </div>
        </header>

        <div className={styles.body}>
          <div className={styles.recovery} data-state={offer?.kind ?? "checking"}>
            {!offer && <p>Looking for recoverable work…</p>}
            {offer?.kind === "live" && (
              <p>
                <strong>
                  {docs.length} document{docs.length === 1 ? "" : "s"} can be saved
                </strong>{" "}
                ({formatBytes(totalBytes)}), exactly as {docs.length === 1 ? "it was" : "they were"} when
                the error happened.
              </p>
            )}
            {offer?.kind === "autosave" && (
              <p>
                The open documents could not be read, so this is the{" "}
                <strong>last autosave, from {offer.age}</strong> —{" "}
                {docs.length} document{docs.length === 1 ? "" : "s"} ({formatBytes(totalBytes)}). Anything
                done since then is not in it.
              </p>
            )}
            {offer?.kind === "none" && (
              <p>
                No recoverable work was found{offer.problem ? ` (${offer.problem})` : ""}. If autosave is
                on, reloading may still offer to restore an earlier snapshot.
              </p>
            )}
          </div>

          <div className={styles.actions}>
            <button
              type="button"
              className={`${styles.btn} ${styles.primary}`}
              onClick={save}
              disabled={!docs.length}
            >
              {saved ? <Check size={15} /> : <Download size={15} />}
              {saved
                ? `Saved ${saved} document${saved === 1 ? "" : "s"}`
                : docs.length > 1
                  ? "Save recovery copy (.zip)"
                  : "Save recovery copy"}
            </button>
            <button type="button" className={styles.btn} onClick={copy}>
              {copied ? <Check size={15} /> : <ClipboardCopy size={15} />}
              {copied ? "Report copied" : "Copy report"}
            </button>
            <button type="button" className={styles.btn} onClick={() => location.reload()}>
              <RotateCcw size={15} />
              Reload Graphiq
            </button>
          </div>

          <p className={styles.privacy}>
            The report describes the error, your browser and how many documents were open. It contains
            no image data.
          </p>

          <button type="button" className={styles.disclosure} onClick={() => setDetails((v) => !v)}>
            {details ? "Hide" : "Show"} technical details
          </button>
          {details && (
            <pre className={styles.details}>
              {formatReport(info, { version: pkg.version }, docs)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}
