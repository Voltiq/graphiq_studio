/**
 * The Color and Layers panels as the 3.x design draws them (desktop): what the
 * redesign moved or added still does the job it promises.
 *
 *  - Color: the Picker / Swatches control in the header switches the view and
 *    is remembered; the value format is chosen inside the value field; the
 *    hex field takes an alpha too; the back chip of the primary/secondary
 *    pair switches which one is being edited.
 *  - Layers: the rows draw the layer itself; opacity is a field you can drag
 *    across or type into; the locks live behind the padlock; the filter row
 *    opens from the header and clears when closed; the footer's half-disc
 *    makes fill and adjustment layers.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 1440, height: 900 } });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const color = (app: App) => app.page.locator('[data-panel-id="color"]');
const layers = (app: App) => app.page.locator('[data-panel-id="layers"]');
const foreground = (app: App) =>
  app.page.evaluate(() => window.graphiq!.foreground().toLowerCase());
const tree = (app: App) => app.page.evaluate(() => window.graphiq!.layers());

test.describe("Color", () => {
  test("Picker / Swatches switches the view, and the choice is remembered", async ({ app }) => {
    await expect(color(app).locator('[aria-label="Saturation and brightness"]'), "the picker shows first").toBeVisible();
    await color(app).locator('[data-color-view="swatches"]').click();
    await expect(color(app).locator('[aria-label="Preset swatches"]'), "the library").toBeVisible();
    await expect(color(app).locator('[aria-label="Saturation and brightness"]')).toHaveCount(0);
    // A preset sets the colour being edited.
    await color(app).locator('[aria-label="Preset swatches"] button[aria-label="#22C55E"]').click();
    await app.settle(300);
    expect(await foreground(app)).toMatch(/^#22c55e/);

    await app.boot(); // the same storage, a cold mount
    await expect(color(app).locator('[aria-label="Preset swatches"]'), "still the library after a reload").toBeVisible();
    await color(app).locator('[data-color-view="picker"]').click();
    await expect(color(app).locator('[aria-label="Saturation and brightness"]')).toBeVisible();
  });

  /* Both live in this browser's storage, which the server cannot see. Read in
     the first render they drew what the server had not, hydration failed, and
     React re-rendered the page from the root — reported as "Encountered a
     script tag while rendering React component" (the layout's inline script
     being created on the client). */
  test("a remembered view and saved swatches hydrate cleanly", async ({ app }) => {
    await color(app).locator('button[aria-label="Add the current colour to your swatches"]').click();
    await color(app).locator('[data-color-view="swatches"]').click();
    await app.settle(300);
    await app.boot();
    await app.settle(800);
    expect(app.consoleErrors.filter((e) => /hydrat|script tag/i.test(e)), "no failed hydration").toEqual([]);
    await expect(color(app).locator('[aria-label="Your swatches"] button'), "the saved swatch is back").toHaveCount(1);
    await expect(color(app).locator('[data-color-view="swatches"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("the value format lives in the value field: RGB edits a channel, hex takes alpha", async ({ app }) => {
    const field = color(app).locator('[data-format]');
    await field.locator('button[aria-haspopup="listbox"]').click();
    await app.page.getByRole("option", { name: "RGB" }).click();
    await expect(field, "three channels").toHaveAttribute("data-format", "RGB");
    const red = field.locator('input[aria-label="Red"]');
    await red.fill("255");
    await app.settle(200);
    expect(await foreground(app), "the red channel is now full").toMatch(/^#ff/);

    await field.locator('button[aria-haspopup="listbox"]').click();
    await app.page.getByRole("option", { name: "HEX" }).click();
    const hex = field.locator('input[aria-label="Hex"]');
    await hex.fill("11223380");
    await app.settle(200);
    expect(await foreground(app), "8 digits carry the alpha").toBe("#11223380");
    await expect(color(app).locator('input[aria-label="Opacity"]')).toHaveValue("50");
  });

  test("the back chip switches which colour is being edited; the swap swaps", async ({ app }) => {
    const before = await foreground(app);
    await color(app).locator('button[aria-label="Edit the secondary colour"]').click();
    await app.settle(200);
    await expect(color(app).locator('[aria-label="Secondary colour, being edited"]')).toBeVisible();
    // Editing now goes to the secondary: the primary is left alone.
    await color(app).locator('input[aria-label="Hex"]').fill("FF8800");
    await app.settle(200);
    expect(await foreground(app), "the primary is untouched").toBe(before);
    await color(app).locator('button[aria-label="Swap primary and secondary colors"]').click();
    await app.settle(200);
    expect(await foreground(app), "swapped in").toMatch(/^#ff8800/);
  });
});

test.describe("Layers", () => {
  test("a row draws the layer itself", async ({ app }) => {
    await app.run("layer-new");
    await app.settle(300);
    const thumbInk = () =>
      app.page.evaluate(() => {
        const cv = document.querySelector<HTMLCanvasElement>('[data-panel-id="layers"] canvas[data-thumb-kind="layer"]');
        if (!cv) return -1;
        const d = cv.getContext("2d")!.getImageData(0, 0, cv.width, cv.height).data;
        let n = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
        return n;
      });
    expect(await thumbInk(), "an empty layer draws nothing").toBe(0);
    const b = await app.canvasBox();
    await app.page.mouse.move(b.x + b.width * 0.2, b.y + b.height * 0.5);
    await app.page.mouse.down();
    for (let i = 1; i <= 12; i++) await app.page.mouse.move(b.x + b.width * (0.2 + i * 0.05), b.y + b.height * 0.5);
    await app.page.mouse.up();
    await app.settle(1200);
    expect(await thumbInk(), "the stroke shows in the row's thumbnail").toBeGreaterThan(20);
  });

  test("opacity: drag across the field to scrub, or click and type", async ({ app }) => {
    await app.run("layer-new");
    await app.settle(300);
    const field = layers(app).locator('input[aria-label="Layer opacity"]');
    const box = (await field.boundingBox())!;
    await app.page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.mouse.down();
    await app.page.mouse.move(box.x + box.width / 2 - 60, box.y + box.height / 2, { steps: 6 });
    await app.page.mouse.up();
    await app.settle(300);
    const scrubbed = (await tree(app))[0].opacity;
    expect(scrubbed, "60px left is 30% less").toBe(70);

    await field.click();
    await app.page.keyboard.press("Control+A");
    await app.page.keyboard.type("45");
    await app.page.keyboard.press("Enter");
    await app.settle(300);
    expect((await tree(app))[0].opacity, "typed").toBe(45);
    /* `data-tip`, not `title`: Tooltip.tsx moves every title into it. */
    await expect(layers(app).locator('[data-layer-id] [data-tip="Opacity 45%"]'), "the row says so").toHaveText("45%");
  });

  test("the padlock holds the locks", async ({ app }) => {
    await app.run("layer-new");
    await app.settle(300);
    const lock = layers(app).locator('button[aria-haspopup="menu"][aria-label="Lock the layer"]');
    await lock.click();
    const popup = app.page.getByRole("menu", { name: "Layer locks" });
    await popup.getByRole("menuitemcheckbox", { name: "Position" }).click();
    await app.settle(200);
    await expect(popup.getByRole("menuitemcheckbox", { name: "Position" })).toHaveAttribute("aria-checked", "true");
    await app.page.keyboard.press("Escape"); // (that it spares the selection: escape.spec.ts)
    await expect(popup, "Escape closes it").toHaveCount(0);
    await expect(layers(app).locator('[data-layer-id] [aria-label="Locked: position"]'), "the row shows a padlock").toHaveCount(1);
    await expect(layers(app).locator('button[aria-label^="Locks:"]'), "and the padlock lights up").toHaveCount(1);
  });

  test("the filter row opens from the header, and closing it clears the filter", async ({ app }) => {
    await app.run("layer-new");
    await app.run("layer-new");
    await app.settle(300);
    const rows = layers(app).locator("[data-layer-id]");
    await expect(rows).toHaveCount(2);
    await expect(layers(app).locator('input[aria-label="Filter layers by name"]'), "no filter row at rest").toHaveCount(0);
    await layers(app).locator('button[aria-label="Filter layers"]').click();
    const input = layers(app).locator('input[aria-label="Filter layers by name"]');
    await expect(input, "it opens with the field focused").toBeFocused();
    await input.fill("Layer 1");
    await expect(rows).toHaveCount(1);
    await layers(app).locator('button[aria-label="Filter layers"]').click();
    await expect(input).toHaveCount(0);
    await expect(rows, "closing it shows every layer again").toHaveCount(2);
  });

  test("the half-disc makes fill and adjustment layers", async ({ app }) => {
    await app.run("layer-new");
    await app.settle(300);
    await layers(app).locator('button[aria-label="New fill or adjustment layer"]').click();
    const menu = app.page.getByRole("menu", { name: "New fill or adjustment layer" });
    await menu.getByRole("menuitem", { name: "Curves" }).click();
    await app.settle(800);
    await app.page.keyboard.press("Escape"); // the Curves dialog
    await app.settle(500);
    const t = await tree(app);
    expect(t.map((n) => n.type), "an adjustment layer on top").toContain("adjustment");
  });
});
