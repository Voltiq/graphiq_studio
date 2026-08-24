import { describe, expect, it, vi } from "vitest";
import { shareOrDownload, type ShareDeps } from "../app/lib/share";

/**
 * Every branch of "hand this file to the OS" is a decision that fails quietly
 * in the wrong direction: a desktop user gets a share flyout instead of the
 * download they asked for, or someone who cancelled the share sheet finds the
 * file in Downloads anyway, or an export silently produces nothing because
 * `share()` rejected for a reason nobody handled.
 *
 * `shareOrDownload` takes its dependencies as arguments precisely so those
 * branches can be driven here rather than guessed at in a browser.
 */

const blob = () => new Blob([new Uint8Array([1, 2, 3, 4])], { type: "image/png" });

/** A File without a DOM — Node's File is fine, but keep it explicit. */
const makeFile = (b: Blob, name: string) => new File([b], name, { type: b.type }) as File;

const deps = (over: Partial<ShareDeps> = {}): ShareDeps & { downloaded: [Blob, string][] } => {
  const downloaded: [Blob, string][] = [];
  return {
    canShare: () => true,
    share: async () => {},
    coarse: true,
    download: (b, n) => downloaded.push([b, n]),
    makeFile,
    downloaded,
    ...over,
  };
};

describe("shareOrDownload", () => {
  it("shares on a touch device the platform supports", async () => {
    const share = vi.fn(async () => {});
    const d = deps({ share });
    expect(await shareOrDownload(blob(), "shot.png", d)).toBe("shared");
    expect(d.downloaded).toEqual([]);
    expect(share).toHaveBeenCalledOnce();
  });

  /* The gate that stops this being a desktop regression: Chrome on Windows
     answers `canShare({files})` with true, and a desktop user pressing Export
     wants a file, not the Windows share flyout. */
  it("downloads on a desktop even when the platform could share", async () => {
    const share = vi.fn(async () => {});
    const d = deps({ coarse: false, share });
    expect(await shareOrDownload(blob(), "shot.png", d)).toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
    expect(d.downloaded.map(([, n]) => n)).toEqual(["shot.png"]);
  });

  it("downloads when the platform cannot share files at all", async () => {
    const d = deps({ canShare: undefined, share: undefined });
    expect(await shareOrDownload(blob(), "shot.png", d)).toBe("downloaded");
    expect(d.downloaded.map(([, n]) => n)).toEqual(["shot.png"]);
  });

  it("downloads when canShare refuses this particular file", async () => {
    const share = vi.fn(async () => {});
    const d = deps({ canShare: () => false, share });
    expect(await shareOrDownload(blob(), "shot.tif", d)).toBe("downloaded");
    expect(share).not.toHaveBeenCalled();
  });

  /* Platforms refuse by MIME type, not just by capability, so the question has
     to be asked about the real file. Asking `canShare({ files: [] })` is a
     different — and always more optimistic — question. */
  it("asks canShare about the actual file, not an empty list", async () => {
    const seen: File[][] = [];
    const d = deps({
      canShare: (data) => {
        seen.push(data.files);
        return true;
      },
    });
    await shareOrDownload(blob(), "shot.png", d);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toHaveLength(1);
    expect(seen[0][0].name).toBe("shot.png");
    expect(seen[0][0].type).toBe("image/png");
  });

  /* Cancelling is a decision, not an error. Downloading anyway hands someone a
     file they just declined to send. */
  it("does not download when the user dismisses the share sheet", async () => {
    const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
    const d = deps({ share: async () => { throw abort; } });
    expect(await shareOrDownload(blob(), "shot.png", d)).toBe("cancelled");
    expect(d.downloaded).toEqual([]);
  });

  /* Every other rejection still has to produce the file. The common one:
     `share()` needs transient user activation, and encoding a large PNG can
     outlive the tap that started the export. */
  it("falls back to a download when the share fails for any other reason", async () => {
    const notAllowed = Object.assign(new Error("no activation"), { name: "NotAllowedError" });
    const d = deps({ share: async () => { throw notAllowed; } });
    expect(await shareOrDownload(blob(), "shot.png", d)).toBe("downloaded");
    expect(d.downloaded.map(([, n]) => n)).toEqual(["shot.png"]);
  });

  it("hands the download the same bytes it would have shared", async () => {
    const shared: File[] = [];
    const src = blob();
    const touch = deps({ canShare: () => true, share: async (data) => { shared.push(data.files[0]); } });
    await shareOrDownload(src, "shot.png", touch);
    const desk = deps({ coarse: false });
    await shareOrDownload(src, "shot.png", desk);

    const sharedBytes = new Uint8Array(await shared[0].arrayBuffer());
    const downloadedBytes = new Uint8Array(await desk.downloaded[0][0].arrayBuffer());
    expect([...sharedBytes]).toEqual([...downloadedBytes]);
    expect([...downloadedBytes]).toEqual([1, 2, 3, 4]);
  });

  it("names the shared file the same as the downloaded one", async () => {
    const shared: File[] = [];
    const d = deps({ share: async (data) => { shared.push(data.files[0]); } });
    await shareOrDownload(blob(), "holiday-photo.png", d);
    expect(shared[0].name).toBe("holiday-photo.png");
  });
});
