/**
 * Preferences (TODO 1.5, app/state/prefs.ts): read where they apply — the
 * canvas's checkerboard, document grid, rulers, cursor, and the status bar —
 * changed in the dialog and saved the moment they change.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The colours drawn on the overlay canvases (the grid's, the cursor's). */
const overlayColours = (app: App) =>
  app.page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const seen = new Set<string>();
    for (const c of [...document.querySelectorAll("canvas")].filter((x) => /overlay/i.test(x.className))) {
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 40) seen.add(`${d[i]},${d[i + 1]},${d[i + 2]}`);
    }
    return [...seen];
  });

test.describe("from stored Preferences", () => {
  test.use({
    storage: {
      "graphiq:preferences": JSON.stringify({
        checkerSize: "large",
        checkerColors: "custom",
        checkerA: "#ffeeee",
        checkerB: "#cc8888",
        gridColor: "#ff0000",
        unit: "cm",
        defaultDpi: 100,
        ringColor: "#00ff00",
        brushCrosshair: false,
      }),
    },
  });

  test("the checkerboard, the document grid, the rulers and the cursor follow them", async ({ app }) => {
    const checker = await app.page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[data-tour="canvas"] [class*="checker"]')!;
      const cs = getComputedStyle(el);
      return [cs.backgroundColor, cs.backgroundSize];
    });
    expect(checker).toEqual(["rgb(255, 238, 238)", "24px 24px"]);
    await app.run("view-docgrid");
    await app.settle(500);
    expect(await overlayColours(app), "the grid in its colour").toContain("255,0,0");
    await app.run("view-rulers");
    await app.settle(500);
    const labels = await app.page.evaluate(() =>
      [...document.querySelectorAll("[data-ruler] em")].map((e) => Number(e.textContent)),
    );
    // A 1920px document at 100 ppi is 48.8 cm wide: no label reaches 100.
    expect(Math.max(...labels), "the rulers in centimetres").toBeLessThan(100);
    await app.run("view-docgrid");
    await app.pickTool("Brush");
    const b = await app.canvasBox();
    await app.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await app.settle(300);
    const green = (await overlayColours(app)).filter((c) => /^0,(2[0-9]{2}),0$/.test(c));
    expect(green.length, "the ring in its colour").toBeGreaterThan(0);
  });
});

test("a change in the dialog applies at once, and is kept", async ({ app }) => {
  await app.run("view-rulers");
  await app.settle(300);
  const label = () =>
    app.page.evaluate(() => Math.max(...[...document.querySelectorAll("[data-ruler] em")].map((e) => Number(e.textContent))));
  expect(await label(), "pixels: labels in the hundreds").toBeGreaterThan(100);
  await app.page.evaluate(() => window.graphiq!.run("preferences"));
  await app.page.locator('[aria-modal="true"] button[aria-label="Units & rulers"]').click();
  await app.page.locator('[aria-modal="true"]').getByText("Inches", { exact: true }).first().click();
  await app.page.keyboard.press("Escape");
  await expect.poll(label, { message: "inches, at once" }).toBeLessThan(100);
  expect(await app.page.evaluate(() => JSON.parse(localStorage.getItem("graphiq:preferences")!).unit)).toBe("in");
  await app.boot();
  await expect.poll(label, { message: "and after a reload" }).toBeLessThan(100);
});

test.describe("on a tablet", () => {
  test.use({ viewport: { width: 1024, height: 768 }, hasTouch: true, isMobile: true });
  test("the status bar shows the active document's size, its layers and its selection", async ({ app }) => {
    const status = app.page.locator('footer[data-tour="status"]');
    await expect(status).toContainText("1920 × 1080 px");
    await app.run("layer-new");
    await app.run("layer-new");
    await app.page.evaluate(() => window.graphiq!.select([{ x: 10, y: 20, w: 300, h: 200 }]));
    await expect(status).toContainText("300 × 200");
    await expect(status, "two layers").toContainText(/2 layers|Doc [\d.]+M \/ [\d.]+M/);
    // A second document: the bar follows the one in front.
    await app.page.evaluate(() => window.graphiq!.run("new-doc"));
    const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
    await nd.locator('input[type="number"]').nth(0).fill("640");
    await nd.locator('input[type="number"]').nth(1).fill("480");
    await nd.getByText("Create", { exact: true }).click();
    await expect(status).toContainText("640 × 480 px");
    await app.page.evaluate(() => window.graphiq!.select([{ x: 5, y: 5, w: 70, h: 40 }]));
    await expect(status, "its selection").toContainText("70 × 40");
  });
});

test.describe("snapping and the pen, from stored Preferences", () => {
  test.use({ storage: { "graphiq:preferences": JSON.stringify({ snapDistance: 40, penPressure: false }) } });

  test("a wider snap pulls from further; with pressure off, a pen's light and firm strokes match", async ({ app }) => {
    const { page } = app;
    const doc = await page.evaluate(() => window.graphiq!.docs().find((d) => d.active)!);
    const b = await app.canvasBox();
    const s = b.width / doc.width;
    const at = (x: number, y: number) => [b.x + x * s, b.y + y * s] as const;
    const alpha = (x0: number, y0: number, x1: number, y1: number) =>
      page.evaluate(
        async ([x0, y0, x1, y1]) => {
          const blob = await window.graphiq!.exportPNG(1);
          const bmp = await createImageBitmap(blob!);
          const c = new OffscreenCanvas(bmp.width, bmp.height);
          const ctx = c.getContext("2d")!;
          ctx.drawImage(bmp, 0, 0);
          const d = ctx.getImageData(x0, y0, x1 - x0, y1 - y0).data;
          let n = 0;
          for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
          return n;
        },
        [x0, y0, x1, y1],
      );
    // Stopped 30 document px short of the edge: well inside 40 screen px, outside 6.
    expect(30 * s, "the gap, in screen px").toBeGreaterThan(8);
    expect(30 * s).toBeLessThan(35);
    await app.run("layer-new");
    await page.evaluate(() => window.graphiq!.select([{ x: 100, y: 300, w: 100, h: 100 }]));
    await app.key("Backspace");
    await page.evaluate(() => window.graphiq!.select(null));
    await app.settle(300);
    await app.pickTool("Move");
    await page.mouse.move(...at(150, 350));
    await page.mouse.down();
    await page.mouse.move(...at(80, 350), { steps: 12 });
    await page.mouse.up();
    await app.settle(600);
    expect(await alpha(0, 300, 3, 400), "snapped to the edge").toBeGreaterThan(250);

    await app.run("layer-new");
    await app.pickTool("Brush");
    expect(await app.setRange("Size", 40)).toBe(true);
    await page.getByRole("button", { name: "Pen pressure" }).first().click();
    const size = page.getByRole("dialog", { name: "Pen pressure" }).getByRole("switch", { name: "Size" });
    if ((await size.getAttribute("aria-checked")) !== "true") await size.click();
    await page.keyboard.press("Escape");
    await app.settle(300);
    const pen = async (y: number, force: number) => {
      const [x0, yy] = at(900, y);
      const [x1] = at(1300, y);
      const ev = (type: string, x: number, extra: Record<string, unknown> = {}) =>
        app.cdp("Input.dispatchMouseEvent", { type, x, y: yy, pointerType: "pen", force, ...extra });
      await ev("mouseMoved", x0);
      await ev("mousePressed", x0, { button: "left", buttons: 1, clickCount: 1 });
      for (let i = 1; i <= 20; i++) await ev("mouseMoved", x0 + ((x1 - x0) * i) / 20, { button: "left", buttons: 1 });
      await ev("mouseReleased", x1, { button: "left", buttons: 0, clickCount: 1 });
      await app.settle(600);
    };
    await pen(600, 0.15);
    await pen(800, 1);
    const light = await alpha(1000, 560, 1200, 640);
    const firm = await alpha(1000, 760, 1200, 840);
    expect(light, "the light stroke painted").toBeGreaterThan(200);
    expect(Math.abs(firm - light), "the same width").toBeLessThan(light * 0.1);
  });
});
