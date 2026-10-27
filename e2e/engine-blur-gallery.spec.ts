/**
 * The engine's Blur Gallery (TODO 1.6, app/lib/engine/blur-gallery.ts), as the
 * engine wires them: the preview shows in front, Apply is one step that undoes
 * and redoes, Cancel puts the pixels back — on a layer in a group too, whose
 * merge is cached; in a selection it blurs only there; the preview is rendered
 * by the worker, and a render out counts as a job until it answers.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** Count the blur worker's replies, and hold them from `hold` until `release`. */
const watched = (app: App) =>
  app.page.evaluate(() => {
    const w = window as unknown as { __replies: number; __hold: boolean; __held: (() => void)[] };
    Object.assign(w, { __replies: 0, __hold: false, __held: [] });
    const Real = window.Worker;
    window.Worker = class extends Real {
      private blur: boolean;
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        this.blur = String(url).includes("blurfx");
      }
      set onmessage(fn: ((e: MessageEvent) => void) | null) {
        super.onmessage = (e: MessageEvent) => {
          if (this.blur) w.__replies++;
          if (w.__hold) w.__held.push(() => fn!(e));
          else fn!(e);
        };
      }
    } as typeof Worker;
  });
const replies = (app: App) => app.page.evaluate(() => (window as unknown as { __replies: number }).__replies);

/** The composite once it stops changing: the preview renders off the main thread. */
const composite = (app: App) =>
  app.page.evaluate(async () => {
    const hash = async () => {
      const buf = await crypto.subtle.digest("SHA-256", await (await window.graphiq!.exportPNG(1))!.arrayBuffer());
      return [...new Uint8Array(buf)].slice(0, 8).join(",");
    };
    let h = await hash();
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const next = await hash();
      if (next === h) break;
      h = next;
    }
    return h;
  });
const rgba = (app: App, x: number, y: number) =>
  app.page.evaluate(
    async ([x, y]) => {
      const bmp = await createImageBitmap((await window.graphiq!.exportPNG(1))!);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return [...ctx.getImageData(x, y, 1, 1).data];
    },
    [x, y],
  );
/** The on-screen view at (fx, fy) of its size. */
const onScreen = (app: App, fx: number, fy: number) =>
  app.page.evaluate(
    ([fx, fy]) => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
      return [...c.getContext("2d")!.getImageData(Math.round(c.width * fx), Math.round(c.height * fy), 1, 1).data];
    },
    [fx, fy] as const,
  );

const dialog = (app: App) => app.page.getByRole("dialog", { name: "Blur gallery" });
const amount = (app: App, v: number) =>
  app.page.evaluate((v) => {
    const sel = '[role="dialog"][aria-label="Blur gallery"] input[type="range"]';
    const el = document.querySelector<HTMLInputElement>(sel)!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, v);
async function preview(app: App, v: number) {
  await app.page.evaluate(() => window.graphiq!.run("effect-blur"));
  await dialog(app).waitFor({ timeout: 8_000 });
  await amount(app, v);
  await app.settle(800);
  // Under load the worker's reply can take a while: wait it out.
  await expect(dialog(app).getByText("Rendering preview…")).toHaveCount(0, { timeout: 30_000 });
}
async function close(app: App, button: "Apply" | "Cancel") {
  await dialog(app).locator("footer button").getByText(button, { exact: true }).click();
  await dialog(app).waitFor({ state: "hidden", timeout: 60_000 }); // Apply waits for a preview in flight
  await app.settle(400);
}

/** Bands of red, green and blue on a layer of their own. */
async function bands(app: App) {
  await app.run("layer-new");
  await app.brush(160, 100);
  for (const [hex, fy] of [
    ["#d02020", 0.2],
    ["#20a040", 0.35],
    ["#2040d0", 0.5],
  ] as const) {
    await app.setForeground(hex);
    await app.drag(fy, 0.05, 0.95);
  }
}

test("the preview shows in front; Apply is one step that undoes and redoes; Cancel puts it back", async ({ app }) => {
  await app.openPanelById("history");
  await watched(app);
  await bands(app);
  const before = await composite(app);
  await preview(app, 30);
  await expect.poll(() => composite(app), { message: "previewed", timeout: 30_000 }).not.toBe(before);
  const shown = await composite(app);
  expect(await replies(app), "rendered by the worker").toBeGreaterThan(0);
  await close(app, "Cancel");
  expect(await composite(app), "Cancel: as it was").toBe(before);
  await preview(app, 30);
  await close(app, "Apply");
  expect([await composite(app), (await app.historyRows()).at(-1)?.replace(/\d+$/, "")]).toEqual([
    shown,
    "Gaussian Blur",
  ]);
  await app.key("Control+z");
  expect(await composite(app), "undone").toBe(before);
  await app.key("Control+Shift+z");
  expect(await composite(app), "redone").toBe(shown);
});

test("in a selection it blurs only there", async ({ app }) => {
  await bands(app);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 0, y: 0, w: 960, h: 1080 }]));
  await preview(app, 30);
  await close(app, "Apply");
  expect(await rgba(app, 1440, 290), "outside: the layer's own red").toEqual([208, 32, 32, 255]);
  expect(await rgba(app, 480, 290), "inside: blurred toward the green").not.toEqual([208, 32, 32, 255]);
});

test("on a layer in a group, whose merge is cached: the preview shows, Cancel and Apply too", async ({ app }) => {
  await bands(app);
  const id = await app.page.evaluate(() => window.graphiq!.layers()[0].id);
  await app.run("layer-group");
  await app.page.evaluate((id) => window.graphiq!.selectLayer(id), id);
  await app.settle(300);
  const before = await onScreen(app, 0.5, 0.27);
  await preview(app, 30);
  const message = "on screen, before Apply";
  await expect.poll(() => onScreen(app, 0.5, 0.27), { message, timeout: 30_000 }).not.toEqual(before);
  const shown = await composite(app);
  const previewed = await onScreen(app, 0.5, 0.27);
  await close(app, "Cancel");
  expect(await onScreen(app, 0.5, 0.27), "cancelled: on screen as it was").toEqual(before);
  await preview(app, 30);
  await close(app, "Apply");
  expect([await onScreen(app, 0.5, 0.27), await composite(app)], "applied: on screen and exported").toEqual([
    previewed,
    shown,
  ]);
});

test("a render out to the worker counts as a job until it answers", async ({ app }) => {
  await watched(app);
  await bands(app);
  await preview(app, 20);
  await composite(app);
  await app.page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = true));
  await amount(app, 35);
  await app.settle(800);
  const out = await app.page.evaluate(() => window.__gqRenderCache!.stats().workerJobs);
  await app.page.evaluate(() => {
    const w = window as unknown as { __hold: boolean; __held: (() => void)[] };
    w.__hold = false;
    for (const f of w.__held.splice(0)) f();
  });
  await composite(app);
  const after = await app.page.evaluate(() => window.__gqRenderCache!.stats().workerJobs);
  await close(app, "Cancel");
  expect([out > 0, after], "out, then answered").toEqual([true, 0]);
});
