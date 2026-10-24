/**
 * Export (TODO 1.10, app/commands/export.ts): the document in front is what
 * is exported — as an image, at its size, with the Preferences' attribution
 * embedded, the dialog closing after; as a PSD; and frames need two layers.
 */
import { readFileSync } from "node:fs";
import { test, expect, type App } from "./fixtures";

test.use({
  filePickers: false,
  storage: { "graphiq:preferences": JSON.stringify({ authorName: "Ann Example" }) },
});

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const newDoc = async (app: App, w: number, h: number) => {
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill(String(w));
  await nd.locator('input[type="number"]').nth(1).fill(String(h));
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
};
const downloaded = async (app: App, path: string, act: () => Promise<unknown>) => {
  const dl = app.page.waitForEvent("download", { timeout: 20_000 });
  await act();
  const d = await dl;
  await d.saveAs(path);
  return { name: d.suggestedFilename(), bytes: readFileSync(path) };
};

test("the document in front exports at its size, with its attribution; the dialog closes", async ({ app }, info) => {
  await app.run("layer-new"); // the first document holds a layer of its own
  await newDoc(app, 200, 150);
  await app.run("layer-new");
  await app.page.evaluate(() => window.graphiq!.run("export-as"));
  const dialog = app.page.getByRole("dialog", { name: "Export image" });
  await expect(dialog).toBeVisible();
  const png = await downloaded(app, info.outputPath("a.png"), () => dialog.locator("footer button").last().click());
  expect(png.name).toBe("Untitled-2.png");
  // A PNG's IHDR: width and height, big-endian, after the 8-byte signature and the chunk header.
  expect([png.bytes.readUInt32BE(16), png.bytes.readUInt32BE(20)]).toEqual([200, 150]);
  expect(png.bytes.includes(Buffer.from("Ann Example")), "the author from Preferences").toBe(true);
  await expect(dialog, "closed after").toHaveCount(0);

  const psd = await downloaded(app, info.outputPath("a.psd"), () => app.run("export-psd"));
  // A PSD's header: height then width, big-endian, at 14.
  expect([psd.name, psd.bytes.readUInt32BE(14), psd.bytes.readUInt32BE(18)]).toEqual(["Untitled-2.psd", 150, 200]);
});

test("frames need two layers, and say so", async ({ app }) => {
  await app.run("layer-new");
  await app.page.evaluate(() => window.graphiq!.run("export-frames"));
  await expect(app.page.locator('[role="status"]')).toContainText("Export frames needs at least two layers");
});
