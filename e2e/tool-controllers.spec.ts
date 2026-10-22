/**
 * The tools driven by controllers (TODO 1.4, app/tools/), on real pixels.
 *
 * Moving a tool out of CanvasArea's pointer handlers into a controller is a
 * refactor: nothing a user can see may change. When each family moved, a fixed
 * gesture per tool was recorded before and after — composite, history, ring —
 * and matched byte for byte. This spec keeps what that proved true: each brush
 * changes the picture where it was dragged and nowhere else, as ONE history
 * step named for it; its ring follows the pointer and leaves with it; and a
 * stroke belongs to the tool that began it, even if a shortcut switches tools
 * half way.
 *
 * The picture is the sample document (deterministic, procedural) with its type
 * hidden, worked on its near mountain range.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const W = 1500;
const H = 1000;

async function sample(app: App) {
  await app.page.evaluate(() => window.graphiq!.run("help-sample"));
  await app.page.waitForFunction(() => window.graphiq!.docs().some((d) => d.active && d.name.startsWith("Alpenglow")));
  await app.settle(2000);
  await app.page.evaluate(() => {
    const walk = (ns: { id: string; name: string; children?: unknown[] }[]): { id: string; name: string }[] =>
      ns.flatMap((n) => [n, ...walk((n.children ?? []) as typeof ns)]);
    const all = walk(window.graphiq!.layers());
    window.graphiq!.setLayer(all.find((n) => n.name === "Title")!.id, { visible: false });
    window.graphiq!.selectLayer(all.find((n) => n.name === "Mountains, near")!.id);
  });
  await app.run("view-fit");
  await app.settle(600);
  const b = (await app.page.locator(`canvas[width="${W}"][height="${H}"]`).first().boundingBox())!;
  const s = b.width / W;
  return (x: number, y: number) => [b.x + x * s, b.y + y * s] as const;
}

/** Keep the composite's pixels, in the page, to compare against later. */
const snapshot = (app: App) =>
  app.page.evaluate(async () => {
    const blob = await window.graphiq!.exportPNG(1);
    const bmp = await createImageBitmap(blob!);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    (window as unknown as { __snap: ImageData }).__snap = ctx.getImageData(0, 0, bmp.width, bmp.height);
  });

/** Pixels of the composite that differ from the snapshot, inside a document
 *  box [x0, y0, x1, y1) — one count per box. */
const changed = (app: App, boxes: [number, number, number, number][]) =>
  app.page.evaluate(async (boxes) => {
    const blob = await window.graphiq!.exportPNG(1);
    const bmp = await createImageBitmap(blob!);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const now = ctx.getImageData(0, 0, bmp.width, bmp.height).data;
    const was = (window as unknown as { __snap: ImageData }).__snap.data;
    return boxes.map(([x0, y0, x1, y1]) => {
      let n = 0;
      for (let y = y0; y < y1; y++)
        for (let x = x0; x < x1; x++) {
          const i = (y * bmp.width + x) * 4;
          if (now[i] !== was[i] || now[i + 1] !== was[i + 1] || now[i + 2] !== was[i + 2]) n++;
        }
      return n;
    });
  }, boxes);

/** The red channel of the composite at a document point. */
const redAt = (app: App, x: number, y: number) =>
  app.page.evaluate(
    async ([x, y]) => {
      const blob = await window.graphiq!.exportPNG(1);
      const bmp = await createImageBitmap(blob!);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      return ctx.getImageData(x, y, 1, 1).data[0];
    },
    [x, y],
  );

const lastStep = async (app: App) => {
  await app.openPanelById("history");
  return app.page.evaluate(() => {
    const rows = [...document.querySelectorAll('[data-panel-id="history"] li')].map((li) => li.textContent!.trim());
    return { count: rows.length, last: rows[rows.length - 1].replace(/\d+$/, "") };
  });
};

/** Ink on the overlay canvases: where the rings are drawn. */
const overlayInk = (app: App) =>
  app.page.evaluate(async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    let n = 0;
    for (const ov of [...document.querySelectorAll("canvas")].filter((c) => /overlay/i.test(c.className))) {
      const d = ov.getContext("2d")!.getImageData(0, 0, ov.width, ov.height).data;
      for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
    }
    return n;
  });

const BRUSHES = [
  { tool: "Blur", step: "Blur" },
  { tool: "Smudge", step: "Smudge" },
  { tool: "Mixer brush", step: "Mixer Brush" },
  { tool: "Dodge", step: "Dodge" },
  { tool: "Sponge", step: "Sponge" },
  { tool: "Spot heal", step: "Spot Heal" },
];

for (const b of BRUSHES) {
  test(`${b.tool}: works where it is dragged, nowhere else, as one step — with a ring that follows`, async ({
    app,
  }) => {
    const at = await sample(app);
    await snapshot(app);
    const steps = (await lastStep(app)).count;
    await app.pickTool(b.tool);
    const [x0, y0] = at(1050, 420);
    await app.page.mouse.move(x0, y0);
    expect(await overlayInk(app), "the ring is on the pointer").toBeGreaterThan(50);
    await app.page.mouse.down();
    const [x1, y1] = b.tool === "Spot heal" ? at(1110, 440) : at(1350, 520);
    await app.page.mouse.move(x1, y1, { steps: 12 });
    await app.page.mouse.up();
    await app.settle(1200);
    // Healing is worked out off the main thread: wait for it to land.
    await expect
      .poll(async () => (await changed(app, [[990, 360, 1420, 580]]))[0], {
        message: "the picture changed where it was dragged",
        timeout: 10_000,
      })
      .toBeGreaterThan(300);
    expect((await changed(app, [[0, 0, 900, 340]]))[0], "...and nowhere else").toBe(0);
    expect(await lastStep(app)).toEqual({ count: steps + 1, last: b.step });
    await app.page.mouse.move(5, 5);
    await app.settle(300);
    expect(await overlayInk(app), "the ring leaves with the pointer").toBe(0);
  });
}

test("a brush works inside the selection, and stops at its edge", async ({ app }) => {
  const at = await sample(app);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 1000, y: 380, w: 160, h: 140 }]));
  await app.settle(300);
  await snapshot(app);
  await app.pickTool("Blur");
  const [x0, y0] = at(1050, 420);
  const [x1, y1] = at(1350, 520);
  await app.page.mouse.move(x0, y0);
  await app.page.mouse.down();
  await app.page.mouse.move(x1, y1, { steps: 12 });
  await app.page.mouse.up();
  await app.settle(800);
  const [inside, beyond] = await changed(app, [
    [1000, 380, 1160, 520],
    [1180, 380, 1420, 580],
  ]);
  expect(inside, "blurred inside the selection").toBeGreaterThan(300);
  expect(beyond, "...and not past its edge, where the stroke went on").toBe(0);
});

test("Red eye darkens a red pupil under one click", async ({ app }) => {
  const at = await sample(app);
  const [x, y] = at(1050, 420);
  await app.setForeground("#d01010");
  await app.pickTool("Brush");
  await app.page.mouse.move(x, y);
  await app.page.mouse.down();
  await app.page.mouse.move(x + 4, y + 2, { steps: 3 });
  await app.page.mouse.up();
  await app.settle(400);
  const before = await redAt(app, 1050, 420);
  await app.pickTool("Red eye");
  await app.page.mouse.move(x, y);
  expect(await overlayInk(app), "the ring is on the pointer").toBeGreaterThan(50);
  await app.page.mouse.click(x, y);
  await app.settle(600);
  expect(await redAt(app, 1050, 420), "the red is darkened").toBeLessThan(before - 40);
  expect((await lastStep(app)).last).toBe("Red Eye");
  // Its ring leaves with the pointer, like every other — it used to stay behind.
  await app.page.mouse.move(5, 5);
  await app.settle(300);
  expect(await overlayInk(app), "the ring leaves with the pointer").toBe(0);
});

test("Zoom steps in on a click and out with Alt, about the pointer", async ({ app }) => {
  const at = await sample(app);
  const zoom = async () => parseInt((await app.page.locator("[data-zoom-value]").first().textContent())!, 10);
  const start = await zoom();
  await app.pickTool("Zoom");
  const [x, y] = at(930, 492);
  await app.page.mouse.click(x, y);
  await app.settle(400);
  const zoomedIn = await zoom();
  expect(zoomedIn).toBeGreaterThan(start);
  await app.page.keyboard.down("Alt");
  await app.page.mouse.click(x, y);
  await app.page.keyboard.up("Alt");
  await app.settle(400);
  expect(await zoom()).toBeLessThan(zoomedIn);
});

/* The gesture goes to the controller that began it. A shortcut half way
   through a Blur stroke switches the TOOL, not the stroke: it still ends as
   one Blur step (and does not leave a session open for the Brush to trip on). */
test("a stroke belongs to the tool that began it, even if the tool changes half way", async ({ app }) => {
  const at = await sample(app);
  await snapshot(app);
  const steps = (await lastStep(app)).count;
  await app.pickTool("Blur");
  const [x0, y0] = at(1050, 420);
  const [xm, ym] = at(1200, 470);
  const [x1, y1] = at(1350, 520);
  await app.page.mouse.move(x0, y0);
  await app.page.mouse.down();
  await app.page.mouse.move(xm, ym, { steps: 6 });
  await app.page.keyboard.press("b");
  await app.page.mouse.move(x1, y1, { steps: 6 });
  await app.page.mouse.up();
  await app.settle(800);
  expect(await lastStep(app)).toEqual({ count: steps + 1, last: "Blur" });
  // The half after the switch was blurred too: the moves kept coming to it.
  const [secondHalf] = await changed(app, [[1230, 455, 1360, 540]]);
  expect(secondHalf, "the stroke went on blurring after the switch").toBeGreaterThan(200);
  // ...and the Brush, now in hand, paints a stroke of its own.
  await app.page.mouse.move(x0, y0 + 60);
  await app.page.mouse.down();
  await app.page.mouse.move(x1, y1 + 60, { steps: 6 });
  await app.page.mouse.up();
  await app.settle(800);
  expect(await lastStep(app)).toEqual({ count: steps + 2, last: "Brush" });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  /* Pan mode gives every DRAG tool's drag to the pan. Zoom is a click tool,
     and has always answered a tap first: its controller says so (overPan). */
  test("with pan mode on, a tap with the Zoom tool still zooms", async ({ app }) => {
    const zoom = async () => parseInt((await app.page.locator("[data-status-zoom]").first().textContent())!, 10);
    await app.key("z");
    await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Pan" }).first().click();
    await app.settle(300);
    const z0 = await zoom();
    const box = await app.canvasBox();
    await app.page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await app.settle(500);
    expect(await zoom()).toBeGreaterThan(z0);
  });
});
