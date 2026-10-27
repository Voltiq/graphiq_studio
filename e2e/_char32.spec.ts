/**
 * TEMPORARY characterization for TODO 1.6, the Blur Gallery slice. Records,
 * after each step, the composite (hash and census), the history's last rows
 * and whether the blur worker answered since the last step (counted by a
 * wrapper round `Worker`) — over bands of colour and a gradient: gaussian
 * applied, motion at an angle, zoom, spin, tilt-shift, box and bokeh; one inside
 * a selection; a preview shown and then cancelled; undo, redo. With workers on,
 * and off.
 * Run: CHAR_OUT=<dir>/<before|after> npx playwright test e2e/_char32.spec.ts
 */
import { writeFileSync } from "node:fs";
import { test, type App } from "./fixtures";

const OUT = process.env.CHAR_OUT;
test.skip(!OUT, "characterization only: set CHAR_OUT");
test.use({ actionTimeout: 10_000 });

const save = (name: string, data: unknown) => writeFileSync(`${OUT}.${name}.json`, JSON.stringify(data, null, 1));

/** Count every reply a blur worker sends, from workers made after this. */
const counted = (app: App) =>
  app.page.evaluate(() => {
    const w = window as unknown as { __blurReplies: number };
    w.__blurReplies = 0;
    const Real = window.Worker;
    window.Worker = class extends Real {
      private blur: boolean;
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        this.blur = String(url).includes("blurfx");
      }
      set onmessage(fn: ((e: MessageEvent) => void) | null) {
        super.onmessage = (e: MessageEvent) => {
          if (this.blur) w.__blurReplies++;
          fn!(e);
        };
      }
    } as typeof Worker;
  });
const replies = (app: App) => app.page.evaluate(() => (window as unknown as { __blurReplies: number }).__blurReplies);

/** The composite once it stops changing: the preview renders off the main thread. */
const settledHash = (app: App) =>
  app.page.evaluate(async () => {
    const hash = async () => {
      const buf = await crypto.subtle.digest("SHA-256", await (await window.graphiq!.exportPNG(1))!.arrayBuffer());
      return [...new Uint8Array(buf)].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join("");
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

const recorder = (app: App, log: unknown[]) => {
  let last = 0;
  return async (name: string, fn: () => Promise<unknown>) => {
    console.log(`step: ${name}`);
    await fn();
    await app.settle(600);
    const pixels = await settledHash(app);
    const r = await replies(app);
    log.push([
      name,
      {
        pixels,
        census: await app.exported(),
        history: (await app.historyRows()).slice(-2),
        worker: r > last,
      },
    ]);
    last = r;
  };
};

/** Bands of colour across the canvas, and a black-to-white gradient beneath them. */
async function artwork(app: App) {
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
  await app.page.evaluate(() => window.graphiq!.select([{ x: 0, y: 650, w: 1920, h: 430 }]));
  await app.setForeground("#000000");
  await app.pickTool("Gradient");
  await app.drag(0.8, 0.05, 0.95);
  await app.run("select-deselect");
}

const dialog = (app: App) => app.page.getByRole("dialog", { name: "Blur gallery" });
/** The dialog's `n`th range (the first is the kind's amount). */
const range = (app: App, n: number, v: number) =>
  app.page.evaluate(
    ([n, v]) => {
      const el = document.querySelectorAll<HTMLInputElement>(
        '[role="dialog"][aria-label="Blur gallery"] input[type="range"]',
      )[n];
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    },
    [n, v] as const,
  );

/** Open the Blur Gallery, pick `kind`, set its ranges, and Apply (or Cancel). */
async function blur(app: App, kind: string, ranges: number[], apply = true) {
  await app.page.evaluate(() => window.graphiq!.run("effect-blur"));
  await dialog(app).waitFor({ timeout: 8_000 });
  await dialog(app).getByRole("button", { name: kind, exact: true }).click();
  await app.settle(300);
  for (const [i, v] of ranges.entries()) {
    await range(app, i, v);
    await app.settle(300);
  }
  await app.settle(800);
  await dialog(app)
    .locator("footer button")
    .getByText(apply ? "Apply" : "Cancel", { exact: true })
    .click();
  await dialog(app).waitFor({ state: "hidden", timeout: 90_000 }); // Apply waits for the preview in flight
}

async function run(app: App, log: unknown[]) {
  const step = recorder(app, log);
  await counted(app);
  await app.openPanelById("history");
  await artwork(app);
  await step("the artwork", async () => {});
  await step("gaussian", () => blur(app, "Gaussian", [14]));
  await step("motion at an angle", () => blur(app, "Motion", [30, 60]));
  await step("zoom", () => blur(app, "Zoom", [25]));
  await step("spin", () => blur(app, "Spin", [20]));
  await step("tilt-shift", () => blur(app, "Tilt-Shift", [12, 30, 20]));
  await step("box", () => blur(app, "Box", [9]));
  await step("bokeh", () => blur(app, "Bokeh", [11]));
  await step("in a selection", async () => {
    await app.page.evaluate(() => window.graphiq!.select([{ x: 300, y: 150, w: 700, h: 500 }]));
    await blur(app, "Gaussian", [30]);
    await app.run("select-deselect");
  });
  await step("previewed", async () => {
    await app.page.evaluate(() => window.graphiq!.run("effect-blur"));
    await dialog(app).waitFor({ timeout: 8_000 });
    await range(app, 0, 40);
  });
  await step("cancelled", async () => {
    await dialog(app).locator("footer button").getByText("Cancel", { exact: true }).click();
    await dialog(app).waitFor({ state: "hidden", timeout: 90_000 }); // Apply waits for the preview in flight
  });
  await step("undone, the deselect and the blur", async () => {
    await app.key("Control+z");
    await app.key("Control+z");
  });
  await step("redone", async () => {
    await app.key("Control+Shift+z");
    await app.key("Control+Shift+z");
  });
}

test("char32 the Blur Gallery, workers on", async ({ app }) => {
  test.setTimeout(400_000);
  const log: unknown[] = [];
  await run(app, log);
  save("on", log);
});

test.describe("workers off", () => {
  test.use({ storage: { "graphiq:preferences": JSON.stringify({ useWorkers: false }) } });

  test("char32 the Blur Gallery, workers off", async ({ app }) => {
    test.setTimeout(400_000);
    const log: unknown[] = [];
    await run(app, log);
    save("off", log);
  });
});
