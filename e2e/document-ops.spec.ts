/**
 * Documents (TODO 1.10, app/commands/documents.ts): closing the one in front
 * brings its neighbour forward; New at the stored size when Preferences say
 * not to ask — and refused, saying so, when that size cannot be held.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const docs = (app: App) =>
  app.page.evaluate(() => window.graphiq!.docs().map((d) => `${d.name}|${d.width}x${d.height}|${d.active}`));
const cmd = (app: App, id: string) => app.page.evaluate((id) => window.graphiq!.run(id), id);

test.describe("New without asking", () => {
  const prefs = { newDocAsk: false, newDocWidth: 640, newDocHeight: 480 };
  test.use({ storage: { "graphiq:preferences": JSON.stringify(prefs) } });

  test("makes the stored size; closing the one in front brings its neighbour forward", async ({ app }) => {
    await cmd(app, "new-doc");
    await cmd(app, "new-doc");
    await app.settle(500);
    expect(await docs(app)).toEqual([
      "Untitled-1|1920x1080|false",
      "Untitled-2|640x480|false",
      "Untitled-3|640x480|true",
    ]);
    await app.page.evaluate(() => window.graphiq!.activate(window.graphiq!.docs()[1].id));
    await app.settle(400);
    await cmd(app, "doc-close");
    await app.settle(400);
    const left = ["Untitled-1|1920x1080|false", "Untitled-3|640x480|true"];
    expect(await docs(app), "its neighbour, in front").toEqual(left);
  });
});

test.describe("New at a size that cannot be held", () => {
  const prefs = { newDocAsk: false, newDocWidth: 60000, newDocHeight: 60000 };
  test.use({ storage: { "graphiq:preferences": JSON.stringify(prefs) } });

  test("is refused, and says so", async ({ app }) => {
    await cmd(app, "new-doc");
    await app.settle(400);
    expect(await docs(app)).toEqual(["Untitled-1|1920x1080|true"]);
    await expect(app.page.locator('[role="status"]')).toContainText("60,000 × 60,000");
  });
});
