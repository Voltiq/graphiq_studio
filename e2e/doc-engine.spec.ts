/**
 * Each open document has its own engine state (TODO 1.2): its rasters, caches
 * and history live in a DocumentState, and the engine works on the one in
 * front. What that makes possible, and what it fixed:
 *
 *  - a background tab can be composited where it is, at its own size, without
 *    being brought forward (what multi-page PDF, B.2, was blocked on);
 *  - changing the working space converted every tab's layers at the ACTIVE
 *    tab's size, cropping a larger tab in the background;
 *  - closing a tab drops its state whole, so the editor no longer has to name
 *    every raster it owned (it used to free the quick mask by key);
 *  - a heal finishing after its tab was left journalled into the tab in front.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** File ▸ New at a given size; returns the new document's id. */
async function newDocOfSize(app: App, w: number, h: number): Promise<string> {
  const before = new Set((await app.docs()).map((d) => d.id));
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.waitFor({ timeout: 8_000 });
  await nd.locator('input[type="number"]').nth(0).fill(String(w));
  await nd.locator('input[type="number"]').nth(1).fill(String(h));
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_200);
  const made = (await app.docs()).find((d) => !before.has(d.id));
  if (!made) throw new Error("File ▸ New made no document");
  return made.id;
}

/** A new layer in the active document with `rect` filled in `color`. */
async function paint(app: App, rect: { x: number; y: number; w: number; h: number }, color: string, newLayer = true) {
  if (newLayer) await app.run("layer-new");
  await app.page.evaluate((r) => window.graphiq!.select([r]), rect);
  await app.setForeground(color);
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.settle(300);
}

/** Any open document's composite, read back: its size and a few pixels. */
const composite = (app: App, docId: string | undefined, at: [number, number][]) =>
  app.page.evaluate(
    async ({ docId, at }) => {
      const blob = await window.graphiq!.exportPNG(1, docId);
      if (!blob) return null;
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d")!;
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      let hash = 0;
      for (let i = 0; i < d.length; i += 97) hash = (hash * 31 + d[i]) | 0;
      return {
        w: bmp.width,
        h: bmp.height,
        hash,
        px: at.map(([x, y]) => Array.from(g.getImageData(x, y, 1, 1).data)),
      };
    },
    { docId, at },
  );

const RED = [224, 64, 42, 255];
const BLUE = [42, 96, 224, 255];
const CLEAR = [0, 0, 0, 0];

test("a background tab composites at its own size, without being brought forward", async ({ app }) => {
  const a = await newDocOfSize(app, 300, 200);
  await paint(app, { x: 20, y: 20, w: 100, h: 60 }, "#e0402a");
  const b = await newDocOfSize(app, 500, 400);
  await paint(app, { x: 0, y: 0, w: 500, h: 400 }, "#2a60e0");
  const active = async () => (await app.docs()).find((d) => d.active)?.id;
  expect(await active()).toBe(b);

  const bg = await composite(app, a, [[50, 50], [250, 150]]);
  expect(bg, "the background tab composites").not.toBeNull();
  expect([bg!.w, bg!.h], "at its own size, not the active tab's").toEqual([300, 200]);
  expect(bg!.px, "with its own pixels").toEqual([RED, CLEAR]);

  expect(await active(), "and stays in the background").toBe(b);
  const front = await composite(app, undefined, [[50, 50]]);
  expect([front!.w, front!.h, ...front!.px[0]], "the tab in front is untouched").toEqual([500, 400, ...BLUE]);
  expect(await composite(app, "doc-nope", [])).toBeNull();
});

test("changing the working space keeps a larger background tab whole", async ({ app }) => {
  const big = await newDocOfSize(app, 600, 400);
  await paint(app, { x: 500, y: 300, w: 90, h: 90 }, "#e0402a"); // outside the small tab's 200×150
  await newDocOfSize(app, 200, 150);

  await app.menu("Settings", "Color management…");
  const p3 = app.page.getByRole("button", { name: "Display P3 (wide gamut)" });
  test.skip(await p3.isDisabled(), "this browser has no Display P3 canvas");
  await p3.click();
  await app.settle(800);
  await app.page.keyboard.press("Escape");

  const bg = await composite(app, big, [[545, 345]]);
  expect([bg!.w, bg!.h], "the background tab keeps its size").toEqual([600, 400]);
  expect(bg!.px[0][3], "and the paint near its far corner survived the conversion").toBe(255);
  expect(bg!.px[0][0], "...still red").toBeGreaterThan(150);
});

test("closing a tab frees its quick mask without anyone naming it", async ({ app }) => {
  const doomed = await app.newDoc();
  await app.run("layer-new");
  await app.run("select-quickmask");
  await app.settle(300);
  const memory = () =>
    app.page.evaluate(() =>
      (window as unknown as { __gqMemory: () => { buffers: { name: string }[] } })
        .__gqMemory()
        .buffers.map((b) => b.name),
    );
  expect(await memory(), "the quick mask is a raster").toContain(`mask:qm:${doomed}`);
  // Left ON: the tab closes with its quick mask still up.
  const name = (await app.docs()).find((d) => d.id === doomed)!.name;
  await app.page.locator(`[aria-label="Close ${name}"]`).first().click({ force: true });
  await app.settle();
  expect(await memory(), "and it went with the tab").not.toContain(`mask:qm:${doomed}`);
});

test("a heal that finishes after its tab is left lands in that tab", async ({ app }) => {
  const { page } = app;
  const a = (await app.docs()).find((d) => d.active)!.id;
  await paint(app, { x: 100, y: 100, w: 400, h: 300 }, "#e0402a");
  await paint(app, { x: 290, y: 240, w: 20, h: 20 }, "#2a60e0", false); // the spot to heal
  /* Reframe it twice (a flip and back), so this tab's epoch is not the one a
     brand-new tab starts at — the heal's "was it reframed?" check must read
     its OWN tab's, and equal numbers would hide reading the wrong one. */
  await app.run("image-flip-h");
  await app.run("image-flip-h");
  await app.settle(300);
  const spot: [number, number] = [300, 250];
  const before = await composite(app, a, [spot]);
  expect(before!.px[0], "the spot is there to heal").toEqual(BLUE);

  /* Hold the heal worker's job, so the tab switch is certainly in between —
     the race this is about, made deterministic. */
  await page.evaluate(() => {
    const held: [Worker, unknown, Transferable[]][] = [];
    const send = Worker.prototype.postMessage as (this: Worker, m: unknown, t: Transferable[]) => void;
    Worker.prototype.postMessage = function (this: Worker, msg: unknown, transfer?: Transferable[]) {
      if (msg && typeof msg === "object" && "coverage" in msg && "src" in msg) {
        held.push([this, msg, transfer ?? []]);
        return;
      }
      send.call(this, msg, transfer ?? []);
    } as typeof Worker.prototype.postMessage;
    (window as unknown as { __releaseHeal: () => number }).__releaseHeal = () => {
      const n = held.length;
      for (const [w, m, t] of held.splice(0)) send.call(w, m, t);
      return n;
    };
  });
  await app.key("j");
  const box = await app.canvasBox();
  const doc = (await app.docs()).find((d) => d.active)!;
  const at = { x: box.x + (spot[0] / doc.width) * box.width, y: box.y + (spot[1] / doc.height) * box.height };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.up();

  await app.newDoc(); // leave the tab while its heal is in flight
  const undo = page.locator("header button[data-tip^='Undo'], header button[aria-label^='Undo']").first();
  await expect(undo, "a new tab has nothing to undo").toBeDisabled();
  expect(
    await page.evaluate(() => (window as unknown as { __releaseHeal: () => number }).__releaseHeal()),
    "the heal really was in flight",
  ).toBe(1);
  await expect
    .poll(async () => (await composite(app, a, [spot]))!.px[0], { message: "the heal landed in its own tab" })
    .not.toEqual(BLUE);
  await expect(undo, "...and not in the history of the tab in front").toBeDisabled();

  await page.evaluate((id) => window.graphiq!.activate(id), a);
  await app.settle(500);
  await page.evaluate(() => window.graphiq!.undo());
  await app.settle(500);
  expect((await composite(app, a, [spot]))!.px[0], "its own history takes it back").toEqual(BLUE);
});

test("a brush in a larger tab reaches its far corner after a smaller one was used", async ({ app }) => {
  const { page } = app;
  const big = await newDocOfSize(app, 800, 600);
  await app.run("layer-new");
  await newDocOfSize(app, 300, 200);
  await app.run("layer-new");
  await app.key("b");
  /* A stroke in the small tab: the shared brush buffers are now 300×200. */
  const stroke = async (fx0: number, fy0: number, fx1: number, fy1: number) => {
    const box = await app.canvasBox();
    await page.mouse.move(box.x + box.width * fx0, box.y + box.height * fy0);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width * fx1, box.y + box.height * fy1, { steps: 8 });
    await page.mouse.up();
    await app.settle(400);
  };
  await stroke(0.2, 0.5, 0.8, 0.5);
  await page.evaluate((id) => window.graphiq!.activate(id), big);
  await app.settle(800);
  // Across the big tab's bottom-right, far outside 300×200.
  await stroke(0.8, 0.9, 0.95, 0.9);
  const out = await composite(app, big, [[700, 540]]);
  expect(out!.px[0][3], "the stroke was drawn where it went, not clipped to the other tab's size").toBeGreaterThan(0);
});

test("the memory report counts every open tab, not just the one in front", async ({ app }) => {
  await paint(app, { x: 10, y: 10, w: 50, h: 50 }, "#e0402a"); // a raster exists once drawn on
  const id = (await app.page.evaluate(() => window.graphiq!.layers()))[0].id;
  await app.newDoc();
  const names = await app.page.evaluate(() =>
    (window as unknown as { __gqMemory: () => { buffers: { name: string }[] } })
      .__gqMemory()
      .buffers.map((b) => b.name),
  );
  expect(names, "a background tab's layer is still accounted for").toContain(`layer:${id}`);
});

test("closing a tab takes its renders out of the shared cache", async ({ app }) => {
  const { page } = app;
  const doomed = await app.newDoc();
  await paint(app, { x: 100, y: 100, w: 300, h: 200 }, "#e0402a");
  await app.run("fx-add-stroke"); // a styled layer: its render is cached, and owned
  await app.settle(800);
  const stats = () =>
    page.evaluate(() =>
      (window as unknown as { __gqRenderCache: { stats: () => { bytes: number; entries: number } } }).__gqRenderCache.stats(),
    );
  const before = await stats();
  expect(before.bytes, "the styled layer's render is in the cache").toBeGreaterThan(0);
  const name = (await app.docs()).find((d) => d.id === doomed)!.name;
  await page.locator(`[aria-label="Close ${name}"]`).first().click({ force: true });
  await app.settle();
  const after = await stats();
  // The tab left in front has no layers, so nothing of its own is cached.
  expect(after, "every byte the closed tab cached came back").toMatchObject({ bytes: 0, entries: 0 });
});

test("leaving a tab files it with its pixels, read from the background", async ({ app }) => {
  const { page } = app;
  await paint(app, { x: 40, y: 40, w: 200, h: 120 }, "#e0402a");
  const id = (await page.evaluate(() => window.graphiq!.layers()))[0].id;
  /* Leaving a tab writes its JSON — after the engine has already moved on to
     the next one, so its pixels are read from a background document. */
  await app.newDoc();
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  const layer = () =>
    page.evaluate(async (layerId) => {
      if (!(await indexedDB.databases()).some((d) => d.name === "graphiq-autosave")) return null;
      const snap = await new Promise<{ docs?: { json: string | Blob }[] } | null>((resolve) => {
        const req = indexedDB.open("graphiq-autosave");
        req.onerror = () => resolve(null);
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("snapshots")) return resolve(null);
          const get = db.transaction("snapshots", "readonly").objectStore("snapshots").get("latest");
          get.onsuccess = () => {
            db.close();
            resolve(get.result ?? null);
          };
          get.onerror = () => resolve(null);
        };
      });
      for (const d of snap?.docs ?? []) {
        const text = typeof d.json === "string" ? d.json : await d.json.text();
        const doc = JSON.parse(text) as { layers?: { id: string; data?: string | null }[] };
        const hit = doc.layers?.find((l) => l.id === layerId);
        if (hit) return { data: typeof hit.data === "string" ? hit.data.slice(0, 22) : hit.data ?? null };
      }
      return null;
    }, id);
  await expect.poll(layer, { message: "the left tab is in the snapshot" }).not.toBeNull();
  expect((await layer())!.data, "with its layer's pixels").toBe("data:image/png;base64,");
});
