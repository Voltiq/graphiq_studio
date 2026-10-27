/**
 * TEMPORARY characterization for TODO 1.6, the heal slice. Records, after each
 * step, the composite (hash and census), the history's last rows and whether
 * the heal worker answered since the last step (counted by a wrapper round
 * `Worker`) — over bands of colour with white blemishes: a spot heal on a
 * blemish, one across a band's edge, one inside a selection; content-aware
 * fill of a selection; undo, redo; and, the worker's reply held, a heal that
 * lands after its document has gone to the back. With workers on, and off.
 * Run: CHAR_OUT=<dir>/<before|after> npx playwright test e2e/_char33.spec.ts
 */
import { writeFileSync } from "node:fs";
import { test, type App } from "./fixtures";

const OUT = process.env.CHAR_OUT;
test.skip(!OUT, "characterization only: set CHAR_OUT");
test.use({ actionTimeout: 10_000 });

const save = (name: string, data: unknown) => writeFileSync(`${OUT}.${name}.json`, JSON.stringify(data, null, 1));

/** Count the heal worker's replies, and hold them from `hold` until `release`. */
const watched = (app: App) =>
  app.page.evaluate(() => {
    const w = window as unknown as { __replies: number; __hold: boolean; __held: (() => void)[] };
    Object.assign(w, { __replies: 0, __hold: false, __held: [] });
    const Real = window.Worker;
    window.Worker = class extends Real {
      private heal: boolean;
      constructor(url: string | URL, opts?: WorkerOptions) {
        super(url, opts);
        this.heal = String(url).includes("heal");
      }
      set onmessage(fn: ((e: MessageEvent) => void) | null) {
        super.onmessage = (e: MessageEvent) => {
          if (this.heal) w.__replies++;
          if (w.__hold) w.__held.push(() => fn!(e));
          else fn!(e);
        };
      }
    } as typeof Worker;
  });
const replies = (app: App) => app.page.evaluate(() => (window as unknown as { __replies: number }).__replies);

/** The composite once it stops changing: a heal lands off the main thread. */
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
    await app.settle(1_200);
    const pixels = await settledHash(app);
    const r = await replies(app);
    log.push([
      name,
      { pixels, census: await app.exported(), history: (await app.historyRows()).slice(-2), worker: r > last },
    ]);
    last = r;
  };
};

/** Bands of colour across the canvas, with white blemishes on them. */
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
  await app.brush(14, 100);
  await app.setForeground("#ffffff");
  for (const [fx, fy] of [
    [0.3, 0.2],
    [0.5, 0.35],
    [0.7, 0.5],
  ] as const)
    await app.drag(fy, fx, fx + 0.01);
}

/** A spot-heal stroke from (fx0, fy) to (fx1, fy), of the tool's size. */
async function heal(app: App, fy: number, fx0: number, fx1: number) {
  await app.pickTool("Spot heal");
  await app.drag(fy, fx0, fx1);
}

async function run(app: App, log: unknown[], workers: boolean) {
  const step = recorder(app, log);
  await watched(app);
  await app.openPanelById("history");
  await artwork(app);
  await step("the artwork", async () => {});
  await step("a blemish healed", () => heal(app, 0.2, 0.295, 0.315));
  await step("across a band's edge", () => heal(app, 0.275, 0.4, 0.45));
  await step("inside a selection", async () => {
    await app.page.evaluate(() => window.graphiq!.select([{ x: 1340, y: 500, w: 40, h: 120 }]));
    await heal(app, 0.5, 0.69, 0.72);
    await app.run("select-deselect");
  });
  await step("content-aware fill", async () => {
    await app.page.evaluate(() => window.graphiq!.select([{ x: 940, y: 360, w: 40, h: 40 }]));
    await app.run("edit-caf");
    await app.run("select-deselect");
  });
  await step("undone, the deselect and the fill", async () => {
    await app.key("Control+z");
    await app.key("Control+z");
  });
  await step("redone", async () => {
    await app.key("Control+Shift+z");
    await app.key("Control+Shift+z");
  });
  if (!workers) return;
  // A heal whose document goes to the back before the worker answers.
  const first = (await app.docs()).find((d) => d.active)!.id;
  await app.page.evaluate(() => ((window as unknown as { __hold: boolean }).__hold = true));
  await heal(app, 0.35, 0.495, 0.515); // the blemish no step above healed
  const second = await app.newDoc();
  await app.page.evaluate(() => {
    const w = window as unknown as { __hold: boolean; __held: (() => void)[] };
    w.__hold = false;
    for (const f of w.__held.splice(0)) f();
  });
  await step("the other document, after the heal landed", async () => {});
  await step("back to the healed one", () => app.activate(first));
  log.push(["documents", [first !== second]]);
}

test("char33 heal, workers on", async ({ app }) => {
  test.setTimeout(400_000);
  const log: unknown[] = [];
  await run(app, log, true);
  save("on", log);
});

test.describe("workers off", () => {
  test.use({ storage: { "graphiq:preferences": JSON.stringify({ useWorkers: false }) } });

  test("char33 heal, workers off", async ({ app }) => {
    test.setTimeout(400_000);
    const log: unknown[] = [];
    await run(app, log, false);
    save("off", log);
  });
});
