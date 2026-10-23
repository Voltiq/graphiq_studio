/**
 * Which dialogs are open (TODO 1.5, app/state/dialogs.ts). Each command opens
 * its own dialog; one opened over another leaves the first open, and Escape
 * closes them in turn; Preferences re-opens where it was left.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The open modal dialogs' names, top of the page first as they are in it. */
const open = (app: App) =>
  app.page.evaluate(() =>
    [...document.querySelectorAll('[aria-modal="true"]')].map((d) => d.getAttribute("aria-label") ?? ""),
  );

const BY_COMMAND: [string, string][] = [
  ["open-recent", "Recent projects"],
  ["save-as", "Save project as"],
  ["doc-rename", "Rename document"],
  ["merge-hdr", "Merge to HDR"],
  ["batch-process", "Batch process"],
  ["export-tiff", "Export TIFF"],
  ["export-pdf", "Export PDF"],
  ["export-lut", "Export LUT"],
  ["print", "Print"],
  ["pattern-fill", "Fill with pattern"],
  ["image-trim", "Trim"],
  ["image-size", "Image Size"],
  ["canvas-size", "Canvas Size"],
  ["view-more-space", "More space"],
  ["select-feather", "Feather selection"],
  ["select-save", "Save selection"],
  ["select-load", "Load selection"],
  ["view-new-guide", "New guide"],
  ["workspaces", "Workspaces"],
  ["preferences", "Preferences"],
  ["color-manage", "Color management"],
  ["shortcuts", "Keyboard shortcuts"],
  ["help-docs", "Help"],
  ["about", "About Graphiq Studio"],
  ["new-doc", "New document"],
];

test("each command opens its own dialog, and Escape closes it", async ({ app }) => {
  test.setTimeout(180_000);
  await app.run("layer-new");
  for (const [id, name] of BY_COMMAND) {
    await app.run("select-all");
    expect(await app.page.evaluate((id) => window.graphiq!.run(id), id), id).toBe(true);
    await expect.poll(() => open(app), { message: id }).toEqual([name]);
    await app.page.keyboard.press("Escape");
    await expect.poll(() => open(app), { message: `${id}: closed` }).toEqual([]);
  }
});

test("one opened over another leaves it open, and Escape closes them in turn", async ({ app }) => {
  await app.page.evaluate(() => window.graphiq!.run("preferences"));
  await expect.poll(() => open(app)).toEqual(["Preferences"]);
  await app.page.keyboard.press("Control+Alt+i"); // Image size, over Preferences
  await expect.poll(() => open(app)).toEqual(["Image Size", "Preferences"]);
  await app.page.keyboard.press("Escape");
  await expect.poll(() => open(app)).toEqual(["Preferences"]);
  await app.page.keyboard.press("Escape");
  await expect.poll(() => open(app)).toEqual([]);
});

test("Preferences opens on the section asked for, and re-opens where it was left", async ({ app }) => {
  const section = () =>
    app.page.evaluate(
      () =>
        document
          .querySelector('[aria-modal="true"] :is([aria-selected="true"], [aria-current="page"], [data-active="true"])')
          ?.textContent?.trim() ?? "",
    );
  await app.page.evaluate(() => window.graphiq!.run("prefs-performance"));
  await expect.poll(section).toBe("Performance");
  await app.page.keyboard.press("Escape");
  await app.page.evaluate(() => window.graphiq!.run("preferences"));
  await expect.poll(section, "where it was left").toBe("Performance");
});
