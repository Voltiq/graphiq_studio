/**
 * TEMPORARY characterization for TODO 1.6, the history slice. Records, after
 * each step — strokes, undo and redo, a new edit after undo (linear: the redo
 * branch goes), jumps by the History panel, non-linear history (a branch kept,
 * jumped across, pruned when turned off), snapshots (taken, made the History
 * brush's source, painted from, restored, deleted), a step as the source, two
 * documents each with its own history, one closed — the History panel as it
 * reads (every row's state, the sources, the snapshots), the composite, and
 * the memory the engine holds. A second run caps the steps and the memory.
 * Run: CHAR_OUT=<dir>/<before|after> npx playwright test e2e/_char26.spec.ts
 */
import { writeFileSync } from "node:fs";
import { test, type App } from "./fixtures";

const OUT = process.env.CHAR_OUT;
test.skip(!OUT, "characterization only: set CHAR_OUT");
test.use({ actionTimeout: 10_000 });

const save = (name: string, data: unknown) => writeFileSync(`${OUT}.${name}.json`, JSON.stringify(data, null, 1));

const state = (app: App) =>
  app.page.evaluate(async () => {
    const root = document.querySelector('[data-panel-id="history"]');
    const blob = await window.graphiq!.exportPNG(1);
    const buf = new Uint8Array(await crypto.subtle.digest("SHA-256", await blob!.arrayBuffer()));
    type W = { __gqMemory?: () => { total: number; buffers: { name: string }[] } | null };
    const mem = (window as unknown as W).__gqMemory?.();
    return {
      rows: [...(root?.querySelectorAll("button[data-active]") ?? [])].map((b) => {
        const e = b as HTMLElement;
        return [e.textContent?.trim(), e.dataset.active, e.dataset.future, e.dataset.offpath ?? "-"].join("|");
      }),
      sources: [...(root?.querySelectorAll("button[data-source]") ?? [])]
        .map((b, i) => ((b as HTMLElement).dataset.source === "true" ? i : -1))
        .filter((i) => i >= 0),
      nonLinear: root?.querySelector('[aria-label="Non-linear history"]')?.getAttribute("aria-pressed") ?? null,
      snapshots: [...(root?.querySelectorAll('[aria-label^="Delete "]') ?? [])].map((b) => b.getAttribute("aria-label")),
      docs: window.graphiq!.docs().map((d) => [d.name, d.active]),
      pixels: [...buf].slice(0, 12).map((x) => x.toString(16).padStart(2, "0")).join(""),
      memory: mem ? [mem.total, mem.buffers.map((b) => b.name.replace(/:.*/, "")).sort().join(",")] : null,
    };
  });

const smallDoc = async (app: App, w = 400, h = 300) => {
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill(String(w));
  await nd.locator('input[type="number"]').nth(1).fill(String(h));
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
};

const recorder = (app: App, log: unknown[]) => async (name: string, fn: () => Promise<unknown>) => {
  console.log(`step: ${name}`);
  await fn();
  await app.settle(600);
  log.push([name, await state(app)]);
};

test("char26 history: undo, branches, snapshots, the History brush's source, two documents", async ({ app }) => {
  test.setTimeout(400_000);
  const { page } = app;
  const log: unknown[] = [];
  const step = recorder(app, log);
  const history = page.locator('[data-panel-id="history"]');
  const row = (i: number) => history.locator("button[data-active]").nth(i);
  const paint = async (hex: string, fy: number) => {
    await app.setForeground(hex);
    await app.drag(fy, 0.2, 0.8);
  };

  await app.openPanelById("history");
  await smallDoc(app);
  await step("start", async () => {});
  await step("a layer", () => app.run("layer-new"));
  await step("brush tool", async () => {
    await app.pickTool("Brush");
    await app.brush(24, 100);
  });
  await step("red", () => paint("#d02020", 0.3));
  await step("blue", () => paint("#2040d0", 0.5));
  await step("green", () => paint("#20a040", 0.7));
  await step("undo", () => app.key("Control+z"));
  await step("undo again", () => app.key("Control+z"));
  await step("redo", () => app.key("Control+Shift+z"));
  await step("a new edit after undo", () => paint("#e0a000", 0.6));
  await step("jump to the layer", () => row(1).click());
  await step("jump to the newest", async () => row((await history.locator("button[data-active]").count()) - 1).click());
  await step("non-linear on", () => history.getByRole("button", { name: "Non-linear history" }).click());
  await step("undo", () => app.key("Control+z"));
  await step("a branch", () => paint("#a020c0", 0.4));
  await step("jump across to the other branch", async () => {
    const rows = history.locator("button[data-active][data-offpath]");
    await rows.last().click();
  });
  await step("redo on that branch", () => app.key("Control+Shift+z"));
  await step("undo twice", async () => {
    await app.key("Control+z");
    await app.key("Control+z");
  });
  await step("non-linear off", () => history.getByRole("button", { name: "Non-linear history" }).click());
  await step("take a snapshot", () => history.getByRole("button", { name: "Take snapshot" }).click());
  await step("paint over it", () => paint("#101010", 0.5));
  await step("the snapshot as the source", () => history.getByRole("button", { name: /as History-brush source/ }).first().click());
  await step("the History brush", async () => {
    await app.pickTool("History brush");
    await app.drag(0.5, 0.3, 0.6);
  });
  await step("a step as the source", () => history.getByRole("button", { name: "Set as History-brush source" }).nth(2).click());
  await step("the History brush again", () => app.drag(0.3, 0.4, 0.9));
  await step("the original as the source", () => history.getByRole("button", { name: "Set as History-brush source" }).first().click());
  await step("the History brush from the original", () => app.drag(0.7, 0.1, 0.5));
  await step("restore the snapshot", () => history.locator('li:has([aria-label^="Delete "])').first().locator("button").nth(1).click());
  await step("undo the restore", () => app.key("Control+z"));
  await step("a second snapshot", () => history.getByRole("button", { name: "Take snapshot" }).click());
  await step("delete the first", () => history.locator('[aria-label^="Delete "]').first().click());
  // A second document, its own history.
  await step("another document", () => smallDoc(app, 300, 200));
  await step("its layer", () => app.run("layer-new"));
  await step("paint there", async () => {
    await app.pickTool("Brush");
    await paint("#20c0c0", 0.5);
  });
  await step("undo there", () => app.key("Control+z"));
  const ids = (await app.docs()).map((d) => d.id);
  await step("back to the first", () => app.activate(ids[1]));
  await step("undo in the first", () => app.key("Control+z"));
  await step("redo in the first", () => app.key("Control+Shift+z"));
  await step("to the second again", () => app.activate(ids[2]));
  await step("redo there", () => app.key("Control+Shift+z"));
  await step("close it", () => app.run("doc-close"));
  save("session", log);
});

test.describe("with the history capped at 10 steps and 32 MB", () => {
  test.use({
    storage: { "graphiq:preferences": JSON.stringify({ historyLimit: 10, historyBudgetMB: 32 }) },
  });

  test("char26 history caps: the oldest steps go, by count and by memory", async ({ app }) => {
    test.setTimeout(300_000);
    const { page } = app;
    const log: unknown[] = [];
    const step = recorder(app, log);
    await app.openPanelById("history");
    await smallDoc(app);
    for (let i = 0; i < 12; i++) await step(`layer ${i + 1}`, () => app.run("layer-new"));
    await step("undo three", async () => {
      for (let i = 0; i < 3; i++) await app.key("Control+z");
    });
    await step("a new edit", () => app.run("layer-new"));
    await step("a big document", () => smallDoc(app, 2000, 1500));
    await step("a layer there", () => app.run("layer-new"));
    for (let i = 0; i < 4; i++)
      await step(`fill it ${i + 1}`, async () => {
        await app.setForeground(["#c03030", "#30c030", "#3030c0", "#c0c030"][i]);
        await page.evaluate(() => window.graphiq!.select([{ x: 0, y: 0, w: 2000, h: 1500 }]));
        await app.key("Backspace");
      });
    await step("back to the small one", async () => app.activate((await app.docs())[1].id));
    await step("one more there", () => app.run("layer-new"));
    save("caps", log);
  });
});
