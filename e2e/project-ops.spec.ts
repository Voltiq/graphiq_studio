/**
 * Projects (TODO 1.10, app/commands/projects.ts): Save As names the document
 * in front, closes its dialog and marks it saved; a project opened beside
 * another keeps their layers apart and brings its colours; a floating paste
 * is put down first; a restored tab never looked at survives the next crash.
 */
import type { BrowserContext, Page } from "@playwright/test";
import { test, expect, bootApp, type App } from "./fixtures";

test.use({ filePickers: false });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const docs = (app: App) => app.page.evaluate(() => window.graphiq!.docs().map((d) => `${d.name}|${d.active}`));
const pixel = (app: App, x: number, y: number) =>
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
const block = async (app: App, hex: string, onNew = true) => {
  if (onNew) await app.run("layer-new");
  await app.setForeground(hex);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 10, y: 10, w: 50, h: 50 }]));
  await app.key("Backspace");
  await app.run("select-deselect");
};
const saveFile = async (app: App, path: string) => {
  const dl = app.page.waitForEvent("download", { timeout: 20_000 });
  await app.run("save");
  await (await dl).saveAs(path);
  return path;
};
const open = (app: App, path: string) => app.page.locator('input[type="file"][accept*="gproj"]').setInputFiles(path);
const newDoc = async (app: App) => {
  await app.page.evaluate(() => window.graphiq!.run("new-doc"));
  await app.page.locator('div[role="dialog"][aria-label="New document"]').getByText("Create", { exact: true }).click();
  await app.settle(800);
};

test("Save As names the document in front, closes its dialog, and marks it saved", async ({ app }) => {
  await newDoc(app);
  await app.run("layer-new");
  const saved = app.page.locator("[data-status-save]");
  await expect(saved).toHaveAttribute("data-saved", "false");
  const dl = app.page.waitForEvent("download", { timeout: 20_000 });
  await app.page.evaluate(() => window.graphiq!.run("save-as"));
  const dialog = app.page.locator('div[role="dialog"][aria-label="Save project as"]');
  await dialog.locator('input[aria-label="File name"]').fill("Postcard");
  await dialog.getByText("Save", { exact: true }).click();
  await dl;
  await app.settle(300);
  expect(await docs(app)).toEqual(["Untitled-1|false", "Postcard|true"]);
  await expect(dialog, "closed").toHaveCount(0);
  await expect(saved).toHaveAttribute("data-saved", "true");
  await expect(saved).toContainText("Saved");
});

test("a project opened beside another keeps their layers apart, and brings its colours", async ({ app }, info) => {
  await block(app, "#d02060");
  await app.setForeground("#123456");
  const file = await saveFile(app, info.outputPath("red.gproj"));
  await block(app, "#2060d0", false); // the first document goes on, in blue
  await app.setForeground("#abcdef");
  await open(app, file);
  await app.settle(1_500);
  expect(await docs(app)).toEqual(["Untitled-1|false", "Untitled-1|true"]);
  expect(await pixel(app, 30, 30), "the file's picture").toEqual([208, 32, 96, 255]);
  expect(await app.page.evaluate(() => window.graphiq!.foreground()), "the file's colours").toBe("#123456");
  await app.page.evaluate(() => window.graphiq!.activate(window.graphiq!.docs()[0].id));
  await app.settle(800);
  expect(await pixel(app, 30, 30), "the first document's own layer, untouched").toEqual([32, 96, 208, 255]);
});

test("a project opened twice gets fresh group ids each time", async ({ app }, info) => {
  await block(app, "#d02060");
  await app.run("layer-group");
  const file = await saveFile(app, info.outputPath("grouped.gproj"));
  await open(app, file);
  await app.settle(1_200);
  await open(app, file);
  await app.settle(1_200);
  const groups: string[] = [];
  for (const id of await app.page.evaluate(() => window.graphiq!.docs().map((d) => d.id))) {
    await app.page.evaluate((id) => window.graphiq!.activate(id), id);
    await app.settle(300);
    const top = await app.page.evaluate(() =>
      window.graphiq!.layers().filter((n) => n.type === "group").map((n) => n.id),
    );
    groups.push(...top);
  }
  expect(groups).toHaveLength(3);
  expect(new Set(groups).size, "every group its own id").toBe(3);
});

test("a floating paste is put down before a project comes in", async ({ app }, info) => {
  await app.openPanelById("history");
  await block(app, "#d02060");
  const file = await saveFile(app, info.outputPath("a.gproj"));
  await app.run("edit-copy");
  await app.run("edit-paste"); // floating
  await open(app, file);
  await app.settle(1_500);
  await app.page.evaluate(() => window.graphiq!.activate(window.graphiq!.docs()[0].id));
  await app.settle(800);
  expect((await app.historyRows()).some((r) => r.startsWith("Paste")), "the paste put down").toBe(true);
});

const hide = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  });
async function restoreIn(context: BrowserContext): Promise<App> {
  const next = await bootApp(await context.newPage());
  const dialog = next.page.locator('div[aria-label="Restore session"]');
  await dialog.waitFor({ timeout: 10_000 });
  await dialog.locator("button", { hasText: "Restore" }).first().click();
  await next.settle(2_500);
  return next;
}

test("a restored tab never looked at survives the next crash", async ({ app, context }) => {
  test.setTimeout(120_000);
  await block(app, "#d02060");
  await newDoc(app);
  await block(app, "#2060d0"); // in front when the tab is taken
  await hide(app.page);
  await app.settle(3_000);
  const second = await restoreIn(context);
  // Taken again at once: the red document behind was never shown in this session.
  await hide(second.page);
  await second.settle(3_000);
  const third = await restoreIn(context);
  const seen: string[] = [];
  for (const id of await third.page.evaluate(() => window.graphiq!.docs().map((d) => d.id))) {
    await third.page.evaluate((id) => window.graphiq!.activate(id), id);
    await third.settle(800);
    seen.push((await pixel(third, 30, 30)).join(","));
  }
  expect(seen, "the tab never looked at").toContain("208,32,96,255");
  expect(seen).toContain("32,96,208,255");
});

