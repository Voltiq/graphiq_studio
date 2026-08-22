/**
 * PNG encoding, off the main thread.
 *
 * Autosave used to encode every layer with `canvas.toDataURL()`, which is
 * synchronous: on a 4000×3000 photographic document that measured **1066 ms of
 * blocked main thread** in a single task — and it runs when the page is being
 * hidden, which is exactly when a phone's OS is deciding whether to keep the
 * tab. `toBlob` is not the answer either: it is async in shape but still
 * encodes on the caller's thread (measured at 409 ms blocked for one layer).
 *
 * An `ImageBitmap` is transferable and costs the main thread nothing to make
 * (measured: 0 ms for three 12-megapixel layers), so the pixels come here and
 * the string goes back — the caller never touches the encoder or the base64.
 */

export type PngRequest = { id: number; bitmap: ImageBitmap; width: number; height: number };
export type PngResponse = { id: number; blob: Blob } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<PngRequest>) => {
  const { id, bitmap, width, height } = e.data;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context in the worker");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close(); // the transferred copy is ours to release
    /* A Blob, not a data URL. Base64 inflates the bytes by a third and then has
       to be spliced into a JSON string the caller must build in memory — which
       measured 281 ms of blocked main thread for three 12-megapixel layers,
       more than the encoding it replaced. A Blob crosses back by reference. */
    const blob = await canvas.convertToBlob({ type: "image/png" });
    (self as unknown as Worker).postMessage({ id, blob });
  } catch (err) {
    bitmap.close?.();
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
