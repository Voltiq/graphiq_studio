/**
 * Selections made with a tool are history steps, one per gesture. (TODO 0.2d)
 *
 * Before: only Select-menu commands were journalled. A marquee, lasso, wand or
 * Quick Selection — and the plain click that deselects — went straight into the
 * document, so Ctrl+Z after drawing a marquee undid the PAINT before it, and a
 * deselecting click could not be undone at all. Tools update the selection live
 * (a Quick Selection drag every dab), so the editor holds the pre-gesture state
 * and writes ONE step when the gesture ends.
 */
import { test, expect, type App } from "./fixtures";

/** The tool the toolbar shows as active. */
const activeTool = (app: App) =>
  app.page.evaluate(() => document.querySelector('aside[aria-label="Tools"] [aria-pressed="true"]')?.getAttribute("aria-label") ?? null);

/** Select a tool by its shortcut, cycling the group (Shift+key) until it is `name`. */
async function pickTool(app: App, key: string, name: string) {
  await app.page.keyboard.press(key);
  await app.settle(200);
  for (let i = 0; i < 4 && (await activeTool(app)) !== name; i++) {
    await app.page.keyboard.press(`Shift+${key}`);
    await app.settle(200);
  }
  expect(await activeTool(app), `the ${name} tool is active`).toBe(name);
}

/** Fill whatever is selected; report the exported ink. */
async function fillInk(app: App): Promise<number> {
  await app.setForeground("#e0402a");
  await app.key("Backspace");
  return (await app.exported()).ink;
}

/** Drag a rectangular marquee across the given fraction of the view. */
async function marquee(app: App, x0: number, y0: number, x1: number, y1: number) {
  await pickTool(app, "m", "Rectangular marquee");
  const b = await app.canvasBox();
  await app.page.mouse.move(b.x + b.width * x0, b.y + b.height * y0);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x + b.width * x1, b.y + b.height * y1, { steps: 8 });
  await app.page.mouse.up();
  await app.settle();
  await app.parkMouse();
}

test("Ctrl+Z after a marquee undoes the marquee, not the paint before it", async ({ app }) => {
  await app.run("layer-new");
  await app.brush(80, 100);
  await app.setForeground("#2050e0");
  await app.drag(0.8, 0.1, 0.9); // a stroke along the bottom
  const painted = (await app.exported()).ink;
  expect(painted, "the stroke is real").toBeGreaterThan(1000);

  await marquee(app, 0.2, 0.2, 0.5, 0.5);
  await app.key("Control+z");
  expect((await app.exported()).ink, "the paint survived the undo").toBe(painted);
  // With no selection, Backspace fills nothing (and journals nothing).
  expect(await fillInk(app), "the marquee is gone").toBe(painted);

  await app.key("Control+Shift+z");
  expect(await fillInk(app), "redo brought the marquee back, and it fills").toBeGreaterThan(painted);
});

test("a click that deselects can be undone", async ({ app }) => {
  await marquee(app, 0.2, 0.2, 0.5, 0.5);
  const b = await app.canvasBox();
  await app.page.mouse.click(b.x + b.width * 0.8, b.y + b.height * 0.8); // a plain click clears
  await app.settle();
  await app.parkMouse();
  expect(await fillInk(app), "the click deselected").toBe(0);
  await app.key("Control+z");
  expect(await fillInk(app), "Ctrl+Z brought the selection back").toBeGreaterThan(10_000);
});

test("a Quick Selection drag is ONE history step, however many dabs it makes", async ({ app }) => {
  /* Six differently coloured stripes, so each dab across them GROWS the
     selection — a live change per stripe. On a flat colour the first dab takes
     everything and the rest change nothing, and the first version of this test
     passed with every live change journalled separately. */
  await app.run("layer-new");
  const colours = ["#e04040", "#40a040", "#4060e0", "#e0c040", "#a040c0", "#40c0c0"];
  for (let i = 0; i < colours.length; i++) {
    await app.page.evaluate((x) => window.graphiq!.select([{ x, y: 0, w: 320, h: 1080 }]), i * 320);
    await app.setForeground(colours[i]);
    await app.key("Backspace");
  }
  await app.run("select-deselect");
  await app.expandPanel("History");
  await pickTool(app, "w", "Quick selection");
  const before = await app.historyRows();
  const b = await app.canvasBox();
  await app.page.mouse.move(b.x + b.width * 0.05, b.y + b.height * 0.5);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x + b.width * 0.95, b.y + b.height * 0.5, { steps: 40 }); // across all six stripes
  await app.page.mouse.up();
  await app.settle();
  const added = (await app.historyRows()).slice(before.length);
  expect(added, "exactly one step for the whole drag").toHaveLength(1);
  expect(added[0]).toContain("Quick Selection");
});
