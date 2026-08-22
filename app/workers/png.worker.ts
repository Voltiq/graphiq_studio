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
export type PngResponse = { id: number; url: string } | { id: number; error: string };

self.onmessage = async (e: MessageEvent<PngRequest>) => {
  const { id, bitmap, width, height } = e.data;
  try {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("no 2d context in the worker");
    ctx.drawImage(bitmap, 0, 0);
    bitmap.close(); // the transferred copy is ours to release
    const blob = await canvas.convertToBlob({ type: "image/png" });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    /* btoa() wants a binary string, and String.fromCharCode(...bytes) blows the
       argument limit on anything this size — hence the chunking. */
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode.apply(null, [...bytes.subarray(i, i + 0x8000)]);
    (self as unknown as Worker).postMessage({ id, url: `data:image/png;base64,${btoa(binary)}` });
  } catch (err) {
    bitmap.close?.();
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
