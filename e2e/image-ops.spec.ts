/**
 * The image commands (TODO 1.10, app/commands/image.ts): rotate and crop act
 * on the document in front; Free Transform and Transform Selection hand the
 * marquee its mode, a floating paste put down first.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const sizes = (app: App) => app.page.evaluate(() => window.graphiq!.docs().map((d) => `${d.width}x${d.height}`));
const mode = (app: App) =>
  app.page.evaluate(() => {
    const buttons = [...document.querySelectorAll<HTMLElement>('[data-tour="options"] [role="group"] button')].filter(
      (x) => x.offsetParent,
    );
    const content = buttons.find((x) => x.textContent?.trim() === "Content");
    const bounds = buttons.find((x) => x.textContent?.trim() === "Bounds");
    if (!content || !bounds) return null;
    if (content.getAttribute("data-active") === "true") return "content";
    return bounds.getAttribute("data-active") === "true" ? "bounds" : "?";
  });

test("rotate and crop act on the document in front", async ({ app }) => {
  await app.run("layer-new"); // the first document holds a layer of its own
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.locator('input[type="number"]').nth(0).fill("200");
  await nd.locator('input[type="number"]').nth(1).fill("150");
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_000);
  await app.run("layer-new");
  await app.run("image-rotate-cw");
  expect(await sizes(app)).toEqual(["1920x1080", "150x200"]);
  await app.key("Control+z");
  await app.settle(300);
  expect(await sizes(app)).toEqual(["1920x1080", "200x150"]);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 20, y: 10, w: 120, h: 90 }]));
  await app.run("image-crop");
  expect(await sizes(app)).toEqual(["1920x1080", "120x90"]);
});

test("Free Transform moves the pixels, Transform Selection the outline, a float put down first", async ({ app }) => {
  await app.openPanelById("history");
  await app.run("layer-new");
  await app.setForeground("#d02060");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 100, y: 100, w: 200, h: 100 }]));
  await app.key("Backspace");
  await app.run("edit-copy");
  await app.run("edit-paste"); // floating
  await app.pickTool("Brush");
  await app.run("free-transform");
  await app.settle(300);
  expect(await mode(app), "the marquee, moving the pixels").toBe("content");
  expect((await app.historyRows()).some((r) => r.startsWith("Paste")), "the paste put down").toBe(true);
  await app.key("Escape");
  await app.pickTool("Brush");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 100, y: 100, w: 200, h: 100 }]));
  await app.run("transform");
  await app.settle(300);
  expect(await mode(app), "the marquee, moving the outline").toBe("bounds");
});

test("Free Transform with nothing selected takes the whole canvas", async ({ app }) => {
  await app.run("layer-new");
  await app.setForeground("#d02060");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 100, y: 100, w: 200, h: 100 }]));
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.pickTool("Brush");
  await app.run("free-transform");
  await app.settle(300);
  const box = await app.page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll('[data-tour="options"] input[data-numeric]')]
        .filter((i) => (i as HTMLElement).offsetParent)
        .map((i) => [i.closest("label")?.querySelector("span")?.textContent?.trim(), (i as HTMLInputElement).value]),
    ),
  );
  expect(box).toMatchObject({ X: "0", Y: "0", W: "1920", H: "1080" });
});
