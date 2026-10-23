/**
 * The tools' options and the two colours (TODO 1.5, app/state). They are one
 * store that the options bar, the canvas, the rail, the dock and the status bar
 * each read for themselves — so a setting made in one place is the setting
 * everywhere — and they survive a reload.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const bar = (app: App) => app.page.locator('[data-tour="options"]:visible');
const range = (app: App, label: string) => bar(app).locator(`input[type="range"][aria-label="${label}"]`).first();
/** A rail colour chip's colour, as the browser computes it. */
const chip = (app: App, which: "Foreground" | "Background") =>
  app.page.evaluate((w) => {
    const el = document.querySelector(`[data-tour="toolbar"] [aria-label="${w} color"]`)!;
    return getComputedStyle(el).backgroundImage.match(/rgba?\([^)]*\)/)![0];
  }, which);
const segment = (app: App, title: string) => bar(app).locator(`[data-tip="${title}"], [title="${title}"]`).first();

test("the options survive a reload — all but which colour is in use", async ({ app }) => {
  await app.pickTool("Brush");
  await app.setRange("Size", 61);
  await app.pickTool("Magic wand");
  await app.setRange("Tolerance", 77);
  await app.pickTool("Shape");
  await segment(app, "Ellipse").click();
  await app.setForeground("#123456ff");
  await app.page.locator('[data-tour="toolbar"] [aria-label="Swap foreground and background colors"]').click();
  expect(await app.openPanelById("color")).toBe(true);
  await app.page.locator('[data-panel-id="color"] [aria-label="Edit the secondary colour"]').click();
  await expect(app.page.locator('[data-panel-id="color"] [aria-label="Secondary colour, being edited"]')).toHaveCount(1);
  await app.settle(600); // saved a quarter-second after the last change
  await app.boot();
  await app.pickTool("Brush");
  await expect(range(app, "Size")).toHaveValue("61");
  await app.pickTool("Magic wand");
  await expect(range(app, "Tolerance")).toHaveValue("77");
  await app.pickTool("Shape");
  await expect(segment(app, "Ellipse")).toHaveAttribute("data-active", "true");
  expect([await chip(app, "Foreground"), await chip(app, "Background")]).toEqual([
    "rgb(255, 255, 255)",
    "rgb(18, 52, 86)",
  ]);
  expect(await app.openPanelById("color")).toBe(true);
  await expect(
    app.page.locator('[data-panel-id="color"] [aria-label="Primary colour, being edited"]'),
    "the slot is not saved",
  ).toHaveCount(1);
});

test("each brush keeps its own settings, and the Brushes panel sets the one in use", async ({ app }) => {
  await app.pickTool("Brush");
  await app.setRange("Size", 60);
  await app.pickTool("Eraser");
  await expect(range(app, "Size"), "the eraser's own").toHaveValue("30");
  await app.setRange("Size", 45);
  await app.pickTool("Pencil");
  await expect(range(app, "Size"), "the pencil's own").toHaveValue("4");
  await app.pickTool("Brush");
  await expect(range(app, "Size")).toHaveValue("60");
  expect(await app.openPanelById("brushes")).toBe(true);
  await app.pickTool("Eraser");
  await app.page.locator('[data-panel-id="brushes"] ul > li').nth(1).click(); // Hard Round, 18 px
  await expect(range(app, "Size")).toHaveValue("18");
  await app.pickTool("Brush");
  await expect(range(app, "Size"), "the brush untouched").toHaveValue("60");
  // ...and paints with its own: an eraser of 18 across a block takes ~18 rows, not the brush's 60.
  const { page } = app;
  await app.run("layer-new");
  await page.evaluate(() => window.graphiq!.select([{ x: 400, y: 300, w: 800, h: 400 }]));
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.pickTool("Eraser");
  const doc = await page.evaluate(() => window.graphiq!.docs().find((d) => d.active)!);
  const b = await app.canvasBox();
  const at = (x: number, y: number) => [b.x + (x / doc.width) * b.width, b.y + (y / doc.height) * b.height] as const;
  await page.mouse.move(...at(450, 500));
  await page.mouse.down();
  await page.mouse.move(...at(1150, 500), { steps: 10 });
  await page.mouse.up();
  await app.settle(500);
  const erased = await page.evaluate(async () => {
    const blob = await window.graphiq!.exportPNG(1);
    const bmp = await createImageBitmap(blob!);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const col = ctx.getImageData(800, 300, 1, 400).data;
    let n = 0;
    for (let i = 0; i < col.length; i += 4) if (col[i + 3] < 128) n++; // erased through to nothing
    return n;
  });
  expect(erased, "rows erased down one column").toBeGreaterThan(8);
  expect(erased).toBeLessThan(30);
  // The on-canvas HUD (Alt + right-drag) sizes the tool in hand, and only it.
  await page.keyboard.down("Alt");
  await page.mouse.move(...at(800, 800));
  await page.mouse.down({ button: "right" });
  await page.mouse.move(...at(1000, 800), { steps: 8 });
  await page.mouse.up({ button: "right" });
  await page.keyboard.up("Alt");
  await app.settle(300);
  expect(Number(await range(app, "Size").inputValue()), "the eraser, resized").toBeGreaterThan(18);
  await app.pickTool("Brush");
  await expect(range(app, "Size"), "the brush untouched").toHaveValue("60");
});

test("the Eyedropper sets the colour in use; a shape is filled with the primary and stroked with the secondary", async ({
  app,
}) => {
  const { page } = app;
  await app.run("layer-new");
  await app.setForeground("#d02060ff");
  await page.evaluate(() => window.graphiq!.select([{ x: 200, y: 200, w: 300, h: 300 }]));
  await app.key("Backspace");
  await app.run("select-deselect");
  await app.setForeground("#2050d0ff");
  expect(await app.openPanelById("color")).toBe(true);
  await page.locator('[data-panel-id="color"] [aria-label="Edit the secondary colour"]').click();
  await app.pickTool("Eyedropper");
  const doc = await page.evaluate(() => window.graphiq!.docs().find((d) => d.active)!);
  const b = await app.canvasBox();
  const at = (x: number, y: number) => [b.x + (x / doc.width) * b.width, b.y + (y / doc.height) * b.height] as const;
  await page.mouse.click(...at(350, 350));
  await app.settle(300);
  expect([await chip(app, "Foreground"), await chip(app, "Background")], "the secondary took it").toEqual([
    "rgb(32, 80, 208)",
    "rgb(208, 32, 96)",
  ]);
  const hex = async (label: string) => ((await bar(app).locator(`[aria-label="${label}"]`).first().textContent()) ?? "").toLowerCase();
  await app.pickTool("Brush");
  expect(await hex("Brush color"), "the brush's chip: the colour in use").toContain("d02060");
  // Primary blue, secondary red: a shape is filled blue and stroked red, whatever slot is in use.
  await app.pickTool("Shape");
  expect([await hex("Fill"), await hex("Stroke")]).toEqual([expect.stringContaining("2050d0"), expect.stringContaining("d02060")]);
  await segment(app, "Rectangle").click();
  await app.setRange("Stroke W", 20);
  await app.setRange("Radius", 0);
  await page.mouse.move(...at(800, 300));
  await page.mouse.down();
  await page.mouse.move(...at(1200, 700), { steps: 6 });
  await page.mouse.up();
  await app.settle(500);
  const px = (x: number, y: number) =>
    page.evaluate(
      async ([x, y]) => {
        const blob = await window.graphiq!.exportPNG(1);
        const bmp = await createImageBitmap(blob!);
        const c = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = c.getContext("2d")!;
        ctx.drawImage(bmp, 0, 0);
        return [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)];
      },
      [x, y],
    );
  expect(await px(1000, 500), "filled with the primary").toEqual([32, 80, 208]);
  expect(await px(1000, 306), "stroked with the secondary").toEqual([208, 32, 96]);
  // A gradient with no stops of its own runs from the primary to the secondary.
  await app.run("select-deselect");
  await app.run("layer-new");
  await app.pickTool("Gradient");
  await page.mouse.move(...at(100, 950));
  await page.mouse.down();
  await page.mouse.move(...at(doc.width - 100, 950), { steps: 6 });
  await page.mouse.up();
  await app.settle(500);
  expect([await px(40, 950), await px(doc.width - 40, 950)]).toEqual([
    [32, 80, 208],
    [208, 32, 96],
  ]);
  // Editing the brush's chip edits the colour in use: the secondary.
  await app.pickTool("Brush");
  await bar(app).locator('[aria-label="Brush color"]').first().click();
  const swatch = page.locator('[role="dialog"][aria-label="Color picker"] [aria-label="Preset swatches"] button').nth(2);
  const picked = (await swatch.getAttribute("aria-label"))!.slice(1, 7).toLowerCase();
  await swatch.click();
  await page.keyboard.press("Escape");
  await app.settle(300);
  expect(await hex("Brush color")).toContain(picked);
  expect(await chip(app, "Foreground"), "the primary untouched").toBe("rgb(32, 80, 208)");
});

test.describe("on a tablet", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
  test("the status bar shows the colour in use", async ({ app }) => {
    const status = app.page.locator('footer[data-tour="status"]');
    await expect(status).toContainText("#6366F1100%");
    await app.setForeground("#336699cc");
    await expect(status).toContainText("#33669980%");
    await app.setForeground("#6366f1ff"); // back to where it began
    await expect(status, "and back").toContainText("#6366F1100%");
    await app.setForeground("#336699cc");
    await expect(status).toContainText("#33669980%");
    await app.key("x"); // swap
    await expect(status).toContainText("#FFFFFF100%");
    // (The dock is a drawer here: its controls are pressed from script.)
    await app.page.evaluate(() =>
      document.querySelector<HTMLElement>('[data-panel-id="color"] [aria-label="Edit the secondary colour"]')!.click(),
    );
    await expect(status, "the secondary, now in use").toContainText("#33669980%");
  });
});
