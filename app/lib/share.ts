/**
 * Handing a finished file to the operating system.
 *
 * Export has always been a download, which on a desktop is what everyone
 * wants and on a phone is close to useless: the picture lands in Downloads,
 * not in the photo library, and getting it from one to the other is a file
 * manager and several taps. `navigator.share` with a `File` opens the OS share
 * sheet instead — Photos, Messages, AirDrop, whatever the device offers.
 *
 * Every branch here is a decision that can go wrong quietly, so the whole thing
 * takes its dependencies as arguments and `tests/share.test.ts` drives them:
 *
 *  - **Only where a share sheet is the native idiom.** `canShare({files})` is
 *    true on plenty of desktops too — Chrome on Windows will happily open the
 *    Windows share flyout — and silently replacing a desktop download with a
 *    share dialog is a regression, not a feature. The extra gate is a coarse
 *    pointer, which is phones and tablets and not an ordinary desktop.
 *  - **`canShare` is asked about the ACTUAL file.** Platforms refuse by MIME
 *    type as well as by capability, so `canShare({ files: [file] })` and
 *    `canShare({ files: [] })` are different questions; only the first one is
 *    worth asking.
 *  - **A cancelled share is not a failure.** Dismissing the sheet rejects with
 *    `AbortError`, and falling back to a download there would push a file at
 *    someone who just declined to send one. Every other rejection does fall
 *    back — including the common one: `share()` needs transient user
 *    activation, and encoding a large PNG can outlive the tap that started it.
 */

import { downloadBlob } from "./project";

export type SaveOutcome = "shared" | "cancelled" | "downloaded";

export interface ShareDeps {
  /** `navigator.canShare`, bound. Absent = the platform cannot share files. */
  canShare?: (data: { files: File[] }) => boolean;
  /** `navigator.share`, bound. */
  share?: (data: { files: File[]; title?: string }) => Promise<void>;
  /** Is a share sheet the native idiom here? (`(pointer: coarse)`) */
  coarse: boolean;
  /** The fallback, and the only thing that runs on a desktop. */
  download: (blob: Blob, filename: string) => void;
  /** Injectable so a test can build a `File` without a DOM. */
  makeFile?: (blob: Blob, filename: string) => File;
}

const defaultMakeFile = (blob: Blob, filename: string) =>
  new File([blob], filename, { type: blob.type || "application/octet-stream" });

/**
 * Share the file if the platform and the device both make sense for it;
 * otherwise download it. Returns what actually happened, so a caller can tell
 * "the user cancelled" from "the file is saved" — they need different toasts.
 */
export async function shareOrDownload(
  blob: Blob,
  filename: string,
  deps: ShareDeps,
): Promise<SaveOutcome> {
  const { canShare, share, coarse, download, makeFile = defaultMakeFile } = deps;

  if (coarse && canShare && share) {
    const file = makeFile(blob, filename);
    if (canShare({ files: [file] })) {
      try {
        await share({ files: [file], title: filename });
        return "shared";
      } catch (e) {
        /* Dismissed on purpose — do not then push a download at them. */
        if ((e as DOMException)?.name === "AbortError") return "cancelled";
        /* Anything else (no activation left, an unsupported type slipping past
           canShare, a platform hiccup) still has to produce the file. */
      }
    }
  }

  download(blob, filename);
  return "downloaded";
}

/**
 * The whole File ▸ Export family, in one call.
 *
 * Every export route — PNG/JPEG through `saveImageBlob`, plus PSD, TIFF, PDF,
 * SVG, LUT, the frames zip and the batch zip — goes through here, so a phone
 * gets the share sheet from all of them rather than from one. Deliberately NOT
 * used by crash recovery (which must not wait on a sheet at the moment the
 * editor is falling over) or by saving a project (where the native picker is
 * the point).
 *
 * Never rejects: a failed share falls back to the download, so a `void` call
 * from a synchronous handler cannot leave an unhandled rejection behind.
 */
export function saveExportBlob(
  blob: Blob,
  filename: string,
  download: (b: Blob, n: string) => void = downloadBlob,
): Promise<SaveOutcome> {
  return shareOrDownload(blob, filename, browserShareDeps(download));
}

/** The live dependencies, read at call time so a test never needs the globals. */
export function browserShareDeps(download: (blob: Blob, filename: string) => void): ShareDeps {
  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return {
    canShare: nav?.canShare ? (d) => nav.canShare(d) : undefined,
    share: nav?.share ? (d) => nav.share(d) : undefined,
    coarse:
      typeof window !== "undefined" &&
      typeof window.matchMedia === "function" &&
      window.matchMedia("(pointer: coarse)").matches,
    download,
  };
}
