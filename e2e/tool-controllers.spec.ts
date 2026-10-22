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

async function sample(app: App, hideTitle = true) {
  await app.page.evaluate(() => window.graphiq!.run("help-sample"));
  await app.page.waitForFunction(() => window.graphiq!.docs().some((d) => d.active && d.name.startsWith("Alpenglow")));
  await app.settle(2000);
  await app.page.evaluate((hideTitle) => {
    const walk = (ns: { id: string; name: string; children?: unknown[] }[]): { id: string; name: string }[] =>
      ns.flatMap((n) => [n, ...walk((n.children ?? []) as typeof ns)]);
    const all = walk(window.graphiq!.layers());
    if (hideTitle) window.graphiq!.setLayer(all.find((n) => n.name === "Title")!.id, { visible: false });
    window.graphiq!.selectLayer(all.find((n) => n.name === "Mountains, near")!.id);
  }, hideTitle);
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
  { tool: "Brush", step: "Brush" },
  { tool: "Pencil", step: "Pencil" },
  { tool: "Eraser", step: "Erase" },
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
    expect(await overlayInk(app), "the ring is on the pointer").toBeGreaterThan(20);
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

/** The composite's colour at a document point, as [r, g, b]. */
const rgbAt = (app: App, x: number, y: number) =>
  app.page.evaluate(
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

const stroke = async (app: App, from: readonly [number, number], to: readonly [number, number], button?: "right") => {
  await app.page.mouse.move(...from);
  await app.page.mouse.down({ button });
  await app.page.mouse.move(...to, { steps: 12 });
  await app.page.mouse.up({ button });
  await app.settle(800);
};

test("the right button paints with the secondary colour", async ({ app }) => {
  const at = await sample(app);
  await app.setForeground("#ff0000");
  await app.key("x");
  await app.setForeground("#0000ff"); // primary blue, secondary red
  await app.pickTool("Brush");
  await stroke(app, at(1050, 420), at(1350, 520), "right");
  const [r, g, b] = await rgbAt(app, 1200, 470);
  expect(r, "red: the secondary").toBeGreaterThan(200);
  expect(b).toBeLessThan(60);
  expect(g).toBeLessThan(60);
});

test("the History brush paints the picture back to how it was", async ({ app }) => {
  const at = await sample(app);
  await snapshot(app);
  await app.setForeground("#ff0000");
  await app.pickTool("Brush");
  expect(await app.setRange("Size", 60)).toBe(true);
  await stroke(app, at(1000, 470), at(1400, 470));
  const middle: [number, number, number, number] = [1150, 467, 1250, 473];
  expect((await changed(app, [middle]))[0], "painted over").toBeGreaterThan(550);
  await app.pickTool("History brush");
  expect(await app.setRange("Size", 16)).toBe(true);
  expect(await app.setRange("Hardness", 100)).toBe(true);
  await app.page.mouse.move(...at(1150, 470));
  expect(await overlayInk(app), "its ring is on the pointer").toBeGreaterThan(50);
  await stroke(app, at(1150, 470), at(1250, 470));
  const [restored, beside, before] = await changed(app, [middle, [1150, 448, 1250, 456], [1010, 467, 1100, 473]]);
  expect(restored, "back as it was where it went").toBe(0);
  expect(beside, "...its own tip wide, not the brush's").toBeGreaterThan(500);
  expect(before, "...and only there").toBeGreaterThan(500);
  expect((await lastStep(app)).last).toBe("History Brush");
});

test("Erase to History: the eraser paints the picture back instead of erasing it", async ({ app }) => {
  const at = await sample(app);
  await snapshot(app);
  await app.setForeground("#ff0000");
  await app.pickTool("Brush");
  await stroke(app, at(1000, 470), at(1400, 470));
  await app.pickTool("Eraser");
  await app.page.getByRole("switch", { name: "Erase to History" }).first().click();
  await stroke(app, at(1150, 470), at(1250, 470));
  expect((await changed(app, [[1150, 465, 1250, 475]]))[0], "back as it was, not erased").toBe(0);
  expect((await lastStep(app)).last).toBe("Erase to History");
});

test("the Clone stamp paints the source where it is dragged, nowhere else, as one step", async ({ app }) => {
  const at = await sample(app);
  // The source: a green patch on a layer of its own (which the clone paints).
  await app.run("layer-new");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 200, y: 100, w: 600, h: 300 }]));
  await app.setForeground("#00ff88");
  await app.key("Backspace");
  await app.page.evaluate(() => window.graphiq!.select(null));
  await app.settle(300);
  await snapshot(app);
  const steps = (await lastStep(app)).count;
  await app.pickTool("Clone stamp");
  // Nothing happens before a source is set.
  await stroke(app, at(1050, 420), at(1250, 500));
  expect((await changed(app, [[0, 0, W, H]]))[0], "no source: nothing painted").toBe(0);
  await app.page.keyboard.down("Alt");
  await app.page.mouse.click(...at(400, 200));
  await app.page.keyboard.up("Alt");
  await app.page.mouse.move(...at(1050, 420));
  expect(await overlayInk(app), "the ring is on the pointer").toBeGreaterThan(50);
  await stroke(app, at(1050, 420), at(1250, 500));
  expect((await changed(app, [[990, 360, 1310, 560]]))[0], "the picture changed where it was dragged").toBeGreaterThan(
    300,
  );
  expect((await changed(app, [[0, 0, 900, 340]]))[0], "...and nowhere else").toBe(0);
  // Mid-stroke, the pixels are the source's: green.
  const [r, g, b] = await rgbAt(app, 1150, 460);
  expect(g, "a copy of the source").toBeGreaterThan(r + 80);
  expect(g).toBeGreaterThan(b);
  expect(await lastStep(app)).toEqual({ count: steps + 1, last: "Clone Stamp" });
  // The pointer gone, the source's marker stays: it is what the next stroke samples.
  await app.page.mouse.move(5, 5);
  await app.settle(300);
  expect(await overlayInk(app), "the source stays marked").toBeGreaterThan(20);
});

test("the Actions recorder keeps a brush stroke, and plays it back", async ({ app }) => {
  const at = await sample(app);
  await snapshot(app);
  await app.openPanelById("actions");
  await app.page.getByLabel("New action name").fill("A stroke");
  await app.page.getByRole("button", { name: "Record", exact: true }).click();
  await app.setForeground("#ff0000");
  await app.pickTool("Brush");
  await stroke(app, at(1050, 420), at(1350, 520));
  await app.page.getByRole("button", { name: /^Recording/ }).click();
  expect(await app.page.evaluate(() => window.graphiq!.actions().map((a) => [a.name, a.steps]))).toEqual([
    ["A stroke", 1],
  ]);
  const box: [number, number, number, number] = [990, 360, 1420, 580];
  const painted = (await changed(app, [box]))[0];
  expect(painted).toBeGreaterThan(300);
  await app.page.evaluate(() => window.graphiq!.undo());
  await app.settle(600);
  expect((await changed(app, [box]))[0], "undone").toBe(0);
  expect(await app.page.evaluate(() => window.graphiq!.play("A stroke"))).toBe(true);
  await app.settle(1000);
  expect((await changed(app, [box]))[0], "played back where it was painted").toBeGreaterThan(painted * 0.9);
});

/* A pen's pressure reaches the stroke: with Size on, a light stroke is a
   thinner line than a firm one. (Driven through CDP: a scripted pen is the
   only way to set the pressure the page sees.) */
test("a pen's pressure sizes the stroke", async ({ app }) => {
  const at = await sample(app);
  await snapshot(app);
  await app.setForeground("#ff0000");
  await app.pickTool("Brush");
  expect(await app.setRange("Size", 40)).toBe(true);
  await app.page.getByRole("button", { name: "Pen pressure" }).first().click();
  const size = app.page.getByRole("dialog", { name: "Pen pressure" }).getByRole("switch", { name: "Size" });
  if ((await size.getAttribute("aria-checked")) !== "true") await size.click();
  await app.page.keyboard.press("Escape");
  await app.settle(300);
  const pen = async (y: number, force: number) => {
    const [x0, yy] = at(1000, y);
    const [x1] = at(1400, y);
    const ev = (type: string, x: number, extra: Record<string, unknown> = {}) =>
      app.cdp("Input.dispatchMouseEvent", { type, x, y: yy, pointerType: "pen", force, ...extra });
    await ev("mouseMoved", x0);
    await ev("mousePressed", x0, { button: "left", buttons: 1, clickCount: 1 });
    for (let i = 1; i <= 20; i++) await ev("mouseMoved", x0 + ((x1 - x0) * i) / 20, { button: "left", buttons: 1 });
    await ev("mouseReleased", x1, { button: "left", buttons: 0, clickCount: 1 });
    await app.settle(600);
  };
  await pen(430, 0.15);
  await pen(530, 1);
  const [light, firm] = await changed(app, [
    [1100, 390, 1300, 480],
    [1100, 490, 1300, 580],
  ]);
  expect(light, "the light stroke painted").toBeGreaterThan(200);
  expect(firm, "the firm one is a wider line").toBeGreaterThan(light * 2);
});

/* The source is a point in ONE document: back from another, there is none —
   a stroke would otherwise sample a picture the source was never set in. */
test("the clone source is forgotten when another document is worked on", async ({ app }) => {
  const at = await sample(app);
  const sampleId = await app.page.evaluate(() => window.graphiq!.docs().find((d) => d.active)!.id);
  await app.pickTool("Clone stamp");
  await app.page.keyboard.down("Alt");
  await app.page.mouse.click(...at(1150, 600));
  await app.page.keyboard.up("Alt");
  await app.page.evaluate((id) => {
    window.graphiq!.activate(window.graphiq!.docs().find((d) => d.id !== id)!.id);
  }, sampleId);
  await app.settle(600);
  await app.page.evaluate((id) => window.graphiq!.activate(id), sampleId);
  await app.settle(800);
  await snapshot(app);
  const steps = (await lastStep(app)).count;
  await stroke(app, at(1050, 420), at(1250, 500));
  expect((await changed(app, [[0, 0, W, H]]))[0], "no source: nothing painted").toBe(0);
  expect((await lastStep(app)).count).toBe(steps);
  // The same source set again here does paint: it was the switch that cleared it.
  await app.page.keyboard.down("Alt");
  await app.page.mouse.click(...at(1150, 600));
  await app.page.keyboard.up("Alt");
  await stroke(app, at(1050, 420), at(1250, 500));
  expect((await changed(app, [[990, 360, 1310, 560]]))[0]).toBeGreaterThan(300);
});

/* The tools that leave something on the canvas to adjust (slice 3): what each
   draws, what ends it, and what each tells the editor. */

/** Pick from an options-bar dropdown, found by what it shows now. */
const choose = async (app: App, showing: string, option: string) => {
  await app.page.locator('[data-tour="options"]:visible button[aria-haspopup="listbox"]', { hasText: showing }).first().click();
  await app.page.getByRole("option", { name: option }).first().click();
  await app.settle(300);
};

test("the Eyedropper outlines what it samples — at its size, from the layers it is told to", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Eyedropper");
  await app.page.mouse.move(...at(1050, 420));
  const point = await overlayInk(app);
  expect(point, "an outline round the pixel under the pointer").toBeGreaterThan(4);
  await choose(app, "Point sample", "11×11 average");
  await app.page.mouse.move(...at(1052, 420));
  expect(await overlayInk(app), "...and round 11×11 of them").toBeGreaterThan(point * 3);
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app), "it leaves with the pointer").toBe(0);
  // What it samples: every layer (the picture), or the active one alone — which
  // has nothing in the sky.
  const fg = () => app.page.evaluate(() => window.graphiq!.foreground());
  await app.setForeground("#123456");
  const set = await fg();
  await choose(app, "All layers", "Current layer");
  await app.page.mouse.click(...at(300, 150));
  expect(await fg(), "the layer has nothing there: nothing is picked").toBe(set);
  await choose(app, "Current layer", "All layers");
  await app.page.mouse.click(...at(300, 150));
  expect(await fg(), "the picture has sky there").not.toBe(set);
});

test("a colour sampler is dropped with Shift, dragged, and the drag undone as one step", async ({ app }) => {
  const at = await sample(app);
  await app.openPanelById("info");
  const info = app.page.locator('[data-panel-id="info"]');
  await app.pickTool("Eyedropper");
  await app.page.keyboard.down("Shift");
  await app.page.mouse.click(...at(300, 150));
  await app.page.keyboard.up("Shift");
  await expect(info).toContainText("300, 150");
  await stroke(app, at(300, 150), at(900, 480));
  await expect(info).toContainText("900, 480");
  await app.page.evaluate(() => window.graphiq!.undo());
  await app.settle(400);
  await expect(info, "back where the drag began — not gone").toContainText("300, 150");
});

test("the ruler is drawn while the Measure tool is selected", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Measure");
  await stroke(app, at(200, 200), at(800, 500));
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app), "the line, its ends and its label").toBeGreaterThan(300);
  await expect(app.page.locator('[data-tour="options"]').first(), "the options bar reads it").toContainText("671");
  await app.key("z");
  expect(await overlayInk(app), "another tool: it is not drawn").toBe(0);
});

test("a gradient stays live — redrawn as its settings change — until Esc or another tool commits it", async ({
  app,
}) => {
  const at = await sample(app);
  await app.run("layer-new");
  await app.pickTool("Gradient");
  await stroke(app, at(200, 200), at(1200, 800));
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app), "its handles").toBeGreaterThan(100);
  await snapshot(app);
  await app.page.getByRole("switch", { name: "Reverse" }).first().click();
  await app.settle(600);
  const box: [number, number, number, number] = [200, 200, 1200, 800];
  expect((await changed(app, [box]))[0], "reversed, while it is live").toBeGreaterThan(10_000);
  await app.page.keyboard.press("Escape");
  await app.settle(400);
  expect(await overlayInk(app), "Esc: its handles go...").toBe(0);
  expect((await changed(app, [box]))[0], "...and it stays").toBeGreaterThan(10_000);
  // Another, committed by picking another tool.
  await stroke(app, at(300, 300), at(900, 600));
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app)).toBeGreaterThan(100);
  await app.key("z");
  expect(await overlayInk(app), "another tool: committed").toBe(0);
  expect((await lastStep(app)).last).toBe("Gradient");
});

test("a live fill is baked by Esc; an undo ends it, and its marker goes", async ({ app }) => {
  const at = await sample(app);
  await app.run("layer-new");
  await app.pickTool("Paint bucket");
  await app.page.mouse.click(...at(300, 150));
  await app.settle(500);
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app), "the seed's marker").toBeGreaterThan(10);
  await app.page.keyboard.press("Escape");
  expect(await overlayInk(app), "Esc: baked, the marker gone").toBe(0);
  await app.run("layer-new");
  await app.page.mouse.click(...at(300, 150));
  await app.settle(500);
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app)).toBeGreaterThan(10);
  await app.page.evaluate(() => window.graphiq!.undo());
  await app.settle(600);
  expect(await overlayInk(app), "the engine ended it, and its marker went").toBe(0);
});

/* A live fill becomes a history step only when it ends. Undo used to work out
   which step to take back BEFORE ending it: with nothing to undo yet it was
   not offered at all (the fill stayed), and after another step it took the
   fill AND that step. */
test("Undo takes a live fill, and only it — on a document with nothing else to undo too", async ({ app }) => {
  const at = await sample(app, false);
  expect((await lastStep(app)).count, "nothing to undo yet").toBe(1);
  await snapshot(app);
  await app.pickTool("Paint bucket");
  await app.page.mouse.click(...at(300, 150));
  await app.settle(500);
  expect((await changed(app, [[0, 0, W, H]]))[0], "filled").toBeGreaterThan(1000);
  const undo = app.page.locator('[title="Undo (Ctrl+Z)"], [data-tip="Undo (Ctrl+Z)"]').first();
  await expect(undo, "Undo is offered").toBeEnabled();
  await undo.click();
  await app.settle(600);
  expect((await changed(app, [[0, 0, W, H]]))[0], "Undo takes it").toBe(0);
  await app.run("layer-new");
  await app.settle(300);
  const layers = await app.page.evaluate(() => JSON.stringify(window.graphiq!.layers()));
  await snapshot(app);
  await app.page.mouse.click(...at(300, 150));
  await app.settle(500);
  await app.page.keyboard.press("Control+z");
  await app.settle(600);
  expect((await changed(app, [[0, 0, W, H]]))[0], "after a step of its own, Undo takes the fill...").toBe(0);
  expect(await app.page.evaluate(() => JSON.stringify(window.graphiq!.layers())), "...and leaves the step").toBe(
    layers,
  );
});

test("Redo with a live fill up keeps the fill — on a branching history too", async ({ app }) => {
  const at = await sample(app, false);
  await app.openPanelById("history");
  await app.page.getByRole("button", { name: "Non-linear history" }).first().click();
  await app.run("layer-new");
  await app.page.keyboard.press("Control+z"); // a state to redo, on a branch the fill will not be on
  await app.settle(400);
  const layers = await app.page.evaluate(() => JSON.stringify(window.graphiq!.layers()));
  await snapshot(app);
  await app.pickTool("Paint bucket");
  await app.page.mouse.click(...at(300, 150));
  await app.settle(500);
  const [filled] = await changed(app, [[0, 0, W, H]]);
  expect(filled).toBeGreaterThan(1000);
  await app.page.keyboard.press("Control+Shift+z");
  await app.settle(600);
  expect((await changed(app, [[0, 0, W, H]]))[0], "the fill stays").toBe(filled);
  expect(await app.page.evaluate(() => JSON.stringify(window.graphiq!.layers())), "nothing redone").toBe(layers);
});

test("a live fill re-runs from the picture under it as Tolerance moves", async ({ app }) => {
  const at = await sample(app);
  await app.page.evaluate(() => {
    const walk = (ns: { id: string; name: string; children?: unknown[] }[]): { id: string; name: string }[] =>
      ns.flatMap((n) => [n, ...walk((n.children ?? []) as typeof ns)]);
    window.graphiq!.selectLayer(walk(window.graphiq!.layers()).find((n) => n.name === "Lake")!.id); // a gradient
  });
  await app.pickTool("Paint bucket");
  expect(await app.setRange("Tolerance", 60)).toBe(true);
  await snapshot(app);
  await app.page.mouse.click(...at(750, 900));
  await app.settle(500);
  const [wide] = await changed(app, [[0, 0, W, H]]);
  expect(await app.setRange("Tolerance", 4)).toBe(true);
  await app.settle(500);
  const [narrow] = await changed(app, [[0, 0, W, H]]);
  expect(narrow, "a closer match fills less").toBeLessThan(wide * 0.8);
  expect(narrow).toBeGreaterThan(0);
});

/* A live fill or path that a pixel lock refuses as it ends writes no step:
   the Undo it offered while it was open goes again. */
test("a fill or a path the layer's lock refuses leaves nothing to undo", async ({ app }) => {
  const at = await sample(app, false);
  const undo = app.page.locator('[title="Undo (Ctrl+Z)"], [data-tip="Undo (Ctrl+Z)"]').first();
  await expect(undo, "nothing to undo yet").toBeDisabled();
  await snapshot(app);
  await app.pickTool("Paint bucket");
  await app.page.mouse.click(...at(300, 150));
  await app.settle(500);
  await expect(undo, "a fill is open: Undo has it to take").toBeEnabled();
  await app.openPanelById("layers");
  await app.page.locator('[data-panel-id="layers"] [aria-haspopup="menu"][aria-label="Lock the layer"]').first().click();
  await app.page.getByRole("menuitemcheckbox", { name: "Image pixels" }).first().click();
  await app.page.locator('[class*="menuScrim"]').first().click(); // closes the popup
  await app.settle(300);
  await app.page.keyboard.press("Escape"); // bakes the fill — which the lock refuses
  await app.settle(500);
  expect((await changed(app, [[0, 0, W, H]]))[0], "refused: the picture as it was").toBe(0);
  await expect(undo, "...no step, nothing to undo").toBeDisabled();
  await app.pickTool("Pen");
  await app.page.mouse.click(...at(300, 300));
  await app.page.mouse.click(...at(700, 250));
  await app.settle(300);
  await expect(undo, "a path is open: Undo has it to take").toBeEnabled();
  await app.page.keyboard.press("Enter");
  await app.settle(500);
  await expect(undo, "the lock refused it: no step, nothing to undo").toBeDisabled();
});

test("a frame's size shows in the Info panel while it is dragged out, and the frame is made", async ({ app }) => {
  const at = await sample(app);
  await app.openPanelById("info");
  await app.pickTool("Frame");
  await app.page.mouse.move(...at(300, 300));
  await app.page.mouse.down();
  await app.page.mouse.move(...at(700, 600), { steps: 8 });
  await app.settle(300);
  const info = app.page.locator('[data-panel-id="info"]');
  await expect(info, "the readout").toContainText("W × H");
  await expect(info).toContainText("400 × 300");
  expect(await overlayInk(app), "the rubber band").toBeGreaterThan(200);
  await app.page.mouse.up();
  await app.settle(500);
  await expect(info, "it goes with the drag").not.toContainText("W × H");
  expect((await lastStep(app)).last).toBe("New Frame");
});

test("a text box is drawn as it is dragged out, and becomes the editor's box", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Text");
  await app.page.mouse.move(...at(200, 150));
  await app.page.mouse.down();
  await app.page.mouse.move(...at(600, 300), { steps: 8 });
  expect(await overlayInk(app), "the box being dragged").toBeGreaterThan(200);
  await app.page.mouse.up();
  await app.settle(400);
  await app.page.keyboard.type("Box");
  await app.page.keyboard.press("Control+Enter");
  await app.settle(600);
  expect((await lastStep(app)).last).toBe("Type");
});

test("new text is in the foreground colour, and a click on it opens it again", async ({ app }) => {
  const at = await sample(app);
  await app.setForeground("#ff0000");
  await app.pickTool("Text");
  await app.page.mouse.click(...at(200, 150));
  await app.settle(400);
  await app.page.keyboard.type("HHHH");
  await app.page.keyboard.press("Control+Enter");
  await app.settle(800);
  const red = await app.page.evaluate(async () => {
    const blob = await window.graphiq!.exportPNG(1);
    const bmp = await createImageBitmap(blob!);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, 800, 400).data;
    let n = 0;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i] > 180 && d[i + 1] < 90 && d[i + 2] < 90) {
        n++;
        sx += (i / 4) % 800;
        sy += Math.floor(i / 4 / 800);
      }
    }
    return { n, x: n ? sx / n : 0, y: n ? sy / n : 0 };
  });
  expect(red.n, "red letters").toBeGreaterThan(50);
  const layers = () => app.page.evaluate(() => JSON.stringify(window.graphiq!.layers()).match(/"id"/g)!.length);
  const n = await layers();
  await app.page.mouse.click(...at(red.x, red.y)); // on the letters
  await app.settle(400);
  await app.page.keyboard.press("End");
  await app.page.keyboard.type("!");
  await app.page.keyboard.press("Control+Enter");
  await app.settle(800);
  expect(await layers(), "the same layer, edited — not a new one").toBe(n);
  expect((await lastStep(app)).last).toBe("Edit Text");
});

/* The selection tools (slice 4). A selection is measured by what it lets a
   fill reach: filled on a layer of its own, the pixels that changed. */

const selectedArea = async (app: App) => {
  await app.run("layer-new");
  await snapshot(app);
  await app.setForeground("#00ff88");
  await app.key("Backspace");
  await app.settle(500);
  const [n] = await changed(app, [[0, 0, W, H]]);
  await app.page.evaluate(() => {
    window.graphiq!.undo();
    window.graphiq!.undo();
  });
  await app.settle(400);
  return n;
};

const isOpen = (app: App) => app.page.evaluate(() => document.documentElement.dataset.commit === "1");

test("a lasso selects what it went round, Alt takes part of it away, and its ants march", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Lasso");
  const round = async (pts: [number, number][], mod?: "Alt") => {
    if (mod) await app.page.keyboard.down(mod);
    await app.page.mouse.move(...at(...pts[0]));
    await app.page.mouse.down();
    for (const p of pts.slice(1)) await app.page.mouse.move(...at(...p), { steps: 6 });
    await app.page.mouse.up();
    if (mod) await app.page.keyboard.up(mod);
    await app.settle(400);
  };
  // A diamond: no two rows of it alike, so a region of hundreds of rects whose
  // outline the engine traced once (the ants cannot afford to trace it again).
  await round([
    [500, 250],
    [750, 450],
    [500, 650],
    [250, 450],
  ]);
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app), "its outline").toBeGreaterThan(300);
  const whole = await selectedArea(app);
  expect(whole, "about the 100,000 px² it went round").toBeGreaterThan(100_000 * 0.9);
  expect(whole).toBeLessThan(100_000 * 1.1);
  await round(
    [
      [500, 250],
      [800, 250],
      [800, 650],
      [500, 650],
    ],
    "Alt",
  );
  const left = await selectedArea(app);
  expect(left, "the right half taken away").toBeLessThan(whole * 0.6);
  expect(left).toBeGreaterThan(whole * 0.4);
});

test("the polygonal lasso: a click on its start closes it; Esc drops one, Enter closes another", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Lasso");
  await app.page.locator('[data-tip^="Polygonal lasso"]:visible').first().click();
  for (const p of [
    [300, 300],
    [700, 300],
    [700, 600],
  ] as const)
    await app.page.mouse.click(...at(p[0], p[1]));
  expect(await isOpen(app), "open: the phone's ✓/✕ show").toBe(true);
  await app.page.mouse.move(...at(320, 580), { steps: 4 });
  expect(await overlayInk(app), "its edges and the rubber band").toBeGreaterThan(300);
  await app.page.mouse.click(...at(301, 301));
  expect(await isOpen(app), "closed").toBe(false);
  const tri = await selectedArea(app);
  expect(tri, "the triangle it closed").toBeGreaterThan(400 * 300 * 0.4);
  expect(tri).toBeLessThan(400 * 300 * 0.6);
  // Esc drops a polygon; Enter closes one.
  await app.page.mouse.click(...at(900, 300));
  await app.page.mouse.click(...at(1100, 300));
  await app.page.keyboard.press("Escape");
  expect(await isOpen(app)).toBe(false);
  for (const p of [
    [300, 300],
    [700, 300],
    [700, 600],
  ] as const)
    await app.page.mouse.click(...at(p[0], p[1]));
  await app.page.keyboard.press("Enter");
  await app.settle(300);
  expect(await isOpen(app)).toBe(false);
  expect(Math.abs((await selectedArea(app)) - tri), "the same triangle").toBeLessThan(tri * 0.02);
});

test("a double-click closes the polygonal lasso, at the corner it was made on", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Lasso");
  await app.page.locator('[data-tip^="Polygonal lasso"]:visible').first().click();
  for (const p of [
    [300, 300],
    [700, 300],
    [700, 600],
  ] as const)
    await app.page.mouse.click(...at(p[0], p[1]));
  await app.page.mouse.dblclick(...at(300, 600));
  await app.settle(300);
  expect(await isOpen(app), "closed").toBe(false);
  const area = await selectedArea(app);
  expect(area, "the rectangle it closed").toBeGreaterThan(400 * 300 * 0.97);
  expect(area).toBeLessThan(400 * 300 * 1.03);
});

test("the magic wand selects like pixels — and re-runs as Tolerance moves", async ({ app }) => {
  const at = await sample(app);
  // The sky, as the picture has it: a gradient, so how far a flood reaches is
  // the tolerance's to say.
  await app.pickTool("Magic wand");
  await app.page.getByRole("switch", { name: "Sample all layers" }).first().click();
  expect(await app.setRange("Tolerance", 4)).toBe(true);
  await app.page.mouse.click(...at(300, 150));
  await app.settle(400);
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app), "its ants (the traced outline)").toBeGreaterThan(300);
  const tight = await selectedArea(app);
  expect(tight).toBeGreaterThan(100);
  expect(await app.setRange("Tolerance", 60)).toBe(true);
  await app.settle(800);
  expect(await selectedArea(app), "a looser tolerance reaches further").toBeGreaterThan(tight * 1.3);
});

test("a triangle marquee re-shapes as its Apex moves", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Rectangular marquee");
  await app.page.locator('[data-tip="Triangular marquee"]:visible').first().click();
  // How much of the box's lower-left quarter a triangle covers: little with
  // its apex centred, much more with it at the left edge.
  const quarter = async () => {
    await app.run("layer-new");
    await snapshot(app);
    await app.setForeground("#00ff88");
    await app.key("Backspace");
    await app.settle(400);
    const [n] = await changed(app, [[300, 450, 500, 600]]);
    await app.page.evaluate(() => {
      window.graphiq!.undo();
      window.graphiq!.undo();
    });
    await app.settle(300);
    return n;
  };
  await stroke(app, at(300, 300), at(700, 600));
  const centred = await quarter();
  await app.page.evaluate(() => window.graphiq!.select(null));
  await stroke(app, at(300, 300), at(700, 600)); // a fresh one: the Apex slider is its
  expect(await app.setRange("Apex", 0)).toBe(true);
  await app.settle(800);
  expect(await quarter(), "the apex to the left: more of the left").toBeGreaterThan(centred * 1.2);
});

test("the marquee's handles transform the selection, and say so on hover", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Rectangular marquee");
  await stroke(app, at(400, 300), at(800, 600));
  const small = await selectedArea(app);
  await app.page.mouse.move(...at(800, 600));
  await app.settle(200);
  const cursor = await app.page.evaluate(
    () => getComputedStyle(document.querySelector('[data-tour="canvas"] canvas')!).cursor,
  );
  expect(cursor, "a resize cursor over the corner").toMatch(/resize/);
  await stroke(app, at(800, 600), at(1000, 750));
  expect(await selectedArea(app), "dragged bigger").toBeGreaterThan(small * 1.5);
});

test("a marquee shows as its ants while dragged, and its size in the Info panel", async ({ app }) => {
  const at = await sample(app);
  await app.openPanelById("info");
  const info = app.page.locator('[data-panel-id="info"]');
  await app.pickTool("Rectangular marquee");
  await app.page.mouse.move(...at(300, 300));
  await app.page.mouse.down();
  await app.page.mouse.move(...at(700, 600), { steps: 8 });
  await app.settle(300);
  expect(await overlayInk(app), "the rectangle-to-be, as ants").toBeGreaterThan(300);
  await expect(info).toContainText("400 × 300");
  await app.page.mouse.up();
});

/* With View ▸ Snap on, a marquee's corners snap — the first to the canvas's
   edge here — and the box lands on whole pixels. On a document of its own:
   nothing in it to snap to but the canvas. */
test("with Snap on, a marquee snaps to the canvas edge and lands on whole pixels", async ({ app }) => {
  await app.newDoc();
  await app.settle(600);
  const d = await app.page.evaluate(() => window.graphiq!.docs().find((x) => x.active)!);
  const b = (await app.page.locator(`canvas[width="${d.width}"][height="${d.height}"]`).first().boundingBox())!;
  const s = b.width / d.width;
  const at = (x: number, y: number) => [b.x + x * s, b.y + y * s] as const;
  await app.pickTool("Rectangular marquee");
  await stroke(app, at(3, 3), at(300.4, 200.4));
  expect(await selectedArea(app), "0,0 to 300,200 exactly").toBe(300 * 200);
});

test("quick selection paints a selection on, with a ring", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Quick selection");
  await app.page.mouse.move(...at(1050, 420));
  expect(await overlayInk(app), "the ring").toBeGreaterThan(20);
  await stroke(app, at(1050, 420), at(1250, 520));
  expect(await selectedArea(app)).toBeGreaterThan(1000);
});

/* Move and Crop (slice 5). */

/** A green block on a layer of its own (made the active layer). */
const block = async (app: App, r: { x: number; y: number; w: number; h: number }) => {
  await app.run("layer-new");
  await app.page.evaluate((r) => window.graphiq!.select([r]), r);
  await app.setForeground("#00ff88");
  await app.key("Backspace");
  await app.page.evaluate(() => window.graphiq!.select(null));
  await app.settle(400);
};

const switchOn = async (app: App, name: string) => {
  const sw = app.page.getByRole("switch", { name }).first();
  if ((await sw.getAttribute("aria-checked")) !== "true") await sw.click();
  await app.settle(200);
};

test("the Move tool drags the layer as one step", async ({ app }) => {
  const at = await sample(app);
  await block(app, { x: 300, y: 300, w: 200, h: 150 });
  await snapshot(app);
  const steps = (await lastStep(app)).count;
  await app.pickTool("Move");
  await app.page.keyboard.down("Control"); // no snapping: exactly where it is dragged
  await stroke(app, at(400, 380), at(500, 420));
  await app.page.keyboard.up("Control");
  const [left, landed] = await changed(app, [
    [300, 300, 400, 340],
    [500, 340, 600, 490],
  ]);
  expect(left, "gone from where it was").toBeGreaterThan(3000);
  expect(landed, "...and there, 100 right and 40 down").toBeGreaterThan(14_000);
  expect(await lastStep(app)).toEqual({ count: steps + 1, last: "Move" });
});

test("a moved layer snaps to the canvas's edge — unless Ctrl is held", async ({ app }) => {
  const at = await sample(app);
  await block(app, { x: 40, y: 300, w: 100, h: 100 });
  await snapshot(app);
  await app.pickTool("Move");
  await stroke(app, at(90, 350), at(53, 350)); // 37 left: 3 px short of the edge
  const [edge] = await changed(app, [[0, 300, 3, 400]]);
  expect(edge, "it went the last 3 px to the edge").toBeGreaterThan(250);
  await app.page.evaluate(() => window.graphiq!.undo());
  await app.settle(400);
  await app.page.keyboard.down("Control");
  await stroke(app, at(90, 350), at(53, 350));
  await app.page.keyboard.up("Control");
  expect((await changed(app, [[0, 300, 3, 400]]))[0], "with Ctrl: where it was dragged").toBe(0);
});

test("a selection's pixels are lifted and moved, with how far in the Info panel", async ({ app }) => {
  const at = await sample(app);
  await block(app, { x: 300, y: 300, w: 200, h: 150 });
  await app.page.evaluate(() => window.graphiq!.select([{ x: 300, y: 300, w: 100, h: 150 }]));
  await snapshot(app);
  await app.openPanelById("info");
  const info = app.page.locator('[data-panel-id="info"]');
  await app.pickTool("Move");
  await app.page.keyboard.down("Control");
  await app.page.mouse.move(...at(350, 380));
  await app.page.mouse.down();
  await app.page.mouse.move(...at(450, 420), { steps: 8 });
  await app.settle(300);
  await expect(info).toContainText("ΔX, ΔY");
  await expect(info).toContainText("100, 40");
  await app.page.mouse.up();
  await app.page.keyboard.up("Control");
  await app.page.keyboard.press("Enter");
  await app.settle(500);
  const [kept, emptied] = await changed(app, [
    [400, 300, 500, 340],
    [300, 300, 400, 340],
  ]);
  expect(kept, "the unselected half stays").toBe(0);
  expect(emptied, "the selected half has gone").toBeGreaterThan(3000);
});

test("a whole layer dragged with nothing selected says how far in the Info panel too", async ({ app }) => {
  const at = await sample(app);
  await app.openPanelById("info");
  const info = app.page.locator('[data-panel-id="info"]');
  await app.pickTool("Move");
  await app.page.keyboard.down("Control"); // no snapping
  await app.page.mouse.move(...at(350, 380));
  await app.page.mouse.down();
  await app.page.mouse.move(...at(450, 420), { steps: 8 });
  await app.settle(300);
  await expect(info).toContainText("ΔX, ΔY");
  await expect(info).toContainText("100, 40");
  await app.page.mouse.up();
  await app.page.keyboard.up("Control");
});

test("with Auto-select, a press moves the layer under it, not the one selected", async ({ app }) => {
  const at = await sample(app);
  await block(app, { x: 200, y: 100, w: 200, h: 120 }); // in the sky, where the mountains are not
  await app.page.evaluate(() => {
    const walk = (ns: { id: string; name: string; children?: unknown[] }[]): { id: string; name: string }[] =>
      ns.flatMap((n) => [n, ...walk((n.children ?? []) as typeof ns)]);
    window.graphiq!.selectLayer(walk(window.graphiq!.layers()).find((n) => n.name === "Mountains, near")!.id);
  });
  await snapshot(app);
  await app.pickTool("Move");
  await switchOn(app, "Auto-select");
  await stroke(app, at(300, 160), at(300, 300));
  const [sky, mountains] = await changed(app, [
    [200, 100, 400, 140],
    [900, 350, 1300, 600],
  ]);
  expect(sky, "the block moved").toBeGreaterThan(5000);
  expect(mountains, "the selected layer did not").toBe(0);
  await app.openPanelById("layers");
  await expect(
    app.page.locator('[data-panel-id="layers"] li[data-active="true"]').first(),
    "...and the block's layer is now the active one",
  ).toContainText("Layer");
});

test("in Selection mode, Move takes the outline and leaves the pixels", async ({ app }) => {
  const at = await sample(app);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 300, y: 300, w: 200, h: 150 }]));
  await snapshot(app);
  await app.pickTool("Move");
  await app.page.locator('[data-tip="Move selection outline only"]:visible').first().click();
  await app.page.keyboard.down("Control"); // no snapping: exactly where it is dragged
  await stroke(app, at(400, 380), at(600, 380));
  await app.page.keyboard.up("Control");
  expect((await changed(app, [[0, 0, W, H]]))[0], "no pixel moved").toBe(0);
  await app.run("layer-new");
  await snapshot(app); // a layer under a clipped one changes what it clips to
  await app.setForeground("#00ff88");
  await app.key("Backspace");
  await app.settle(400);
  const [was, now] = await changed(app, [
    [300, 300, 500, 450],
    [520, 300, 700, 450],
  ]);
  expect(was, "the selection is no longer where it was").toBeLessThan(5000);
  expect(now, "...it is 200 to the right").toBeGreaterThan(26_000);
});

test("the transform controls scale the layer from a corner, which says so on hover", async ({ app }) => {
  const at = await sample(app);
  await block(app, { x: 300, y: 300, w: 200, h: 150 });
  await snapshot(app);
  await app.pickTool("Move");
  await switchOn(app, "Transform controls");
  await app.page.mouse.move(...at(500, 450));
  await app.settle(200);
  const cursor = await app.page.evaluate(
    () => getComputedStyle(document.querySelector('[data-tour="canvas"] canvas')!).cursor,
  );
  expect(cursor, "a resize cursor over the corner").toMatch(/resize/);
  expect(await overlayInk(app), "the box and its handles").toBeGreaterThan(300);
  await stroke(app, at(500, 450), at(600, 550));
  await app.settle(400);
  expect((await changed(app, [[510, 460, 590, 540]]))[0], "the block reaches the new corner").toBeGreaterThan(5000);
});

test("a locked crop ratio holds while the box is dragged out", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Crop");
  await choose(app, "Free", "1 : 1");
  await stroke(app, at(1, 1), at(400, 100)); // the top-left handle, dragged wide
  await app.page.locator('[data-tour="options"]:visible').getByRole("button", { name: "Apply" }).click();
  await app.settle(800);
  const doc = await app.page.evaluate(() => window.graphiq!.docs().find((d) => d.active)!);
  expect(doc.width, "square").toBe(doc.height);
});

test("Crop: its shield dims the rest; Apply crops the picture to the box", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Crop");
  await stroke(app, at(1, 1), at(300, 200)); // the top-left handle
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app), "the shield over what goes").toBeGreaterThan(50_000);
  await app.settle(300);
  await app.page.locator('[data-tour="options"]:visible').getByRole("button", { name: "Apply" }).click();
  await app.settle(800);
  const doc = await app.page.evaluate(() => window.graphiq!.docs().find((d) => d.active)!);
  expect([doc.width, doc.height]).toEqual([1200, 800]);
  expect((await lastStep(app)).last).toBe("Crop");
});

test("a double-click inside the crop box applies it; outside, it does not", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Crop");
  await stroke(app, at(1, 1), at(300, 200)); // the top-left handle
  await app.settle(300);
  const size = async () => {
    const d = await app.page.evaluate(() => window.graphiq!.docs().find((d) => d.active)!);
    return [d.width, d.height];
  };
  await app.page.mouse.dblclick(...at(150, 600));
  await app.settle(600);
  expect(await size(), "outside: nothing").toEqual([1500, 1000]);
  await app.page.mouse.dblclick(...at(800, 600));
  await app.settle(800);
  expect(await size()).toEqual([1200, 800]);
  expect((await lastStep(app)).last).toBe("Crop");
});

/* Shapes, the Pen and Direct selection (slice 6), and what every tool tells
   the canvas: its cursor, and whether the right button is its own. */

test("the Pen lays a path, drawn as it goes; a double-click finishes it", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Pen");
  for (const p of [
    [300, 300],
    [700, 250],
    [600, 700],
  ] as const)
    await app.page.mouse.click(...at(p[0], p[1]));
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app), "its skeleton, anchors and handles").toBeGreaterThan(300);
  const steps = (await lastStep(app)).count;
  await app.page.mouse.dblclick(...at(400, 650));
  await app.settle(600);
  expect(await lastStep(app), "finished: one step").toEqual({ count: steps + 1, last: "Path" });
  expect(await overlayInk(app), "nothing left to edit").toBe(0);
});

test("Direct selection gathers anchors with a marquee and drags them", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Pen");
  for (const p of [
    [300, 300],
    [700, 250],
    [600, 700],
  ] as const)
    await app.page.mouse.click(...at(p[0], p[1]));
  await app.key("a"); // the rail's flyout would pass through other tools, which finish the path
  await app.page.mouse.move(...at(250, 200));
  await app.page.mouse.down();
  await app.page.mouse.move(...at(750, 350), { steps: 6 });
  const withMarquee = await overlayInk(app);
  await app.page.mouse.up();
  await app.page.mouse.move(5, 5);
  expect(withMarquee - (await overlayInk(app)), "its marquee").toBeGreaterThan(300);
  await snapshot(app);
  await stroke(app, at(700, 250), at(760, 200)); // drags both picked anchors
  expect((await changed(app, [[0, 0, W, H]]))[0], "the live path moved with them").toBeGreaterThan(500);
});

test("a live triangle's apex slides along its top, as one step with the triangle", async ({ app }) => {
  const at = await sample(app);
  await app.pickTool("Shape");
  await app.page.locator('[data-tip="Triangle"]:visible').first().click();
  await snapshot(app);
  await stroke(app, at(300, 300), at(700, 600));
  const steps = (await lastStep(app)).count;
  const top = async (x: number) => (await changed(app, [[x - 15, 305, x + 15, 315]]))[0]; // its tip, there
  expect([await top(500) > 30, await top(335)], "its apex in the middle").toEqual([true, 0]);
  await stroke(app, at(500, 300), at(330, 300));
  expect([await top(335) > 30, await top(500)], "...pulled to the left").toEqual([true, 0]);
  expect(await lastStep(app), "the same step").toEqual({ count: steps, last: "Shape" });
});

/* A drawn shape stays live while its selection is up. Its selection used to
   be journalled as a step of its own, and a step ends a live shape: it was
   over the moment it was drawn, and neither its options nor its nodes reached
   it. */
test("a drawn shape stays live: one step, reshaped by its Radius and its node; Undo takes it whole", async ({
  app,
}) => {
  const at = await sample(app);
  await app.pickTool("Shape");
  await app.page.locator('[data-tip="Rectangle"]:visible').first().click();
  expect(await app.setRange("Radius", 0)).toBe(true);
  await app.settle(200);
  const steps = (await lastStep(app)).count;
  await snapshot(app);
  await app.page.mouse.move(...at(300, 300));
  await app.page.mouse.down();
  await app.page.mouse.move(...at(700, 600), { steps: 6 });
  expect(await overlayInk(app), "the shape-to-be, filled and stroked").toBeGreaterThan(40_000);
  await app.page.mouse.up();
  await app.settle(400);
  await app.page.mouse.move(5, 5);
  expect(await overlayInk(app), "its box is the selection: its ants and handles").toBeGreaterThan(800);
  expect(await lastStep(app), "drawn: one step, its selection in it").toEqual({ count: steps + 1, last: "Shape" });
  const corner = async () => (await changed(app, [[302, 302, 312, 312]]))[0];
  expect(await corner(), "square: its corner is the shape").toBeGreaterThan(80);
  // Live: the Radius rounds it...
  expect(await app.setRange("Radius", 80)).toBe(true);
  await app.settle(400);
  expect(await corner(), "rounded: the corner is the picture again").toBe(0);
  expect((await changed(app, [[450, 400, 550, 500]]))[0], "...the rest still the shape").toBeGreaterThan(9000);
  // ...and so does its corner node, pulled back to square (it snaps there).
  await app.page.mouse.move(...at(380, 300));
  const cursor = () =>
    app.page.evaluate(() => getComputedStyle(document.querySelector('[data-tour="canvas"] canvas')!).cursor);
  expect(await cursor(), "the node says it can be grabbed").toBe("grab");
  await stroke(app, at(380, 300), at(301, 300));
  expect(await corner(), "square again").toBeGreaterThan(80);
  await expect(app.page.locator('input[type="range"][aria-label="Radius"]'), "snapped to 0").toHaveValue("0");
  expect(await lastStep(app), "all of it the one step").toEqual({ count: steps + 1, last: "Shape" });
  // Undo takes the shape and its selection together.
  await app.page.keyboard.press("Control+z");
  await app.settle(600);
  expect((await changed(app, [[0, 0, W, H]]))[0], "the picture as it was").toBe(0);
  expect(await app.page.evaluate(() => window.graphiq!.run("select-deselect")), "nothing selected").toBe(false);
});

test("the selection's handles show for the tools that transform it", async ({ app }) => {
  await sample(app);
  await app.page.evaluate(() => window.graphiq!.select([{ x: 400, y: 300, w: 400, h: 300 }]));
  const ink = async (tool: string) => {
    await app.pickTool(tool);
    await app.page.mouse.move(5, 5);
    return overlayInk(app);
  };
  const lasso = await ink("Lasso");
  expect(await ink("Rectangular marquee"), "eight handles and the anchor").toBeGreaterThan(lasso + 200);
  expect(await ink("Magic wand")).toBeGreaterThan(lasso + 200);
});

test("each tool sets the canvas's cursor, and takes the right button where it is its own", async ({ app }) => {
  await sample(app);
  const look = async (tool: string) => {
    await app.pickTool(tool);
    return app.page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
      const ev = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
      const shut = !c.dispatchEvent(ev);
      return { cursor: getComputedStyle(c).cursor, shut };
    });
  };
  expect(await look("Brush")).toEqual({ cursor: "none", shut: true });
  expect(await look("Move")).toEqual({ cursor: "move", shut: false });
  expect(await look("Text")).toEqual({ cursor: "text", shut: false });
  expect(await look("Rectangular marquee")).toEqual({ cursor: "crosshair", shut: false });
  expect(await look("Paint bucket")).toEqual({ cursor: "crosshair", shut: true });
  expect(await look("Zoom")).toEqual({ cursor: "zoom-in", shut: true });
  expect((await look("Eyedropper")).cursor).toMatch(/^url\(/);
  expect((await look("Measure")).cursor).toBe("default");
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
