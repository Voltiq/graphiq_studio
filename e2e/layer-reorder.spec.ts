/**
 * Reordering layers with a finger — and still with a mouse. (Ported from tools/verify-layer-reorder.js, TODO 2.1.)
 *
 * The rows reorder with HTML5 drag and drop, and those events do not fire for
 * touch at all — so on a phone the layer order could not be changed by any
 * route. Touch now gets long-press to lift and drag to move; the mouse keeps
 * its drag and drop, and is checked too, because "leaving the mouse path
 * identical" is only a claim until something drives it.
 *
 * The order is read from the Layers panel AND confirmed against the composite:
 * a panel listing rows in a new order over an unchanged picture would be a
 * rename, not a reorder. Each layer is filled with its own colour, so the
 * centre pixel says which one is on top. (The script used `d`/`x`/`g`
 * shortcuts and a paint-bucket click; these fills go through the scripting
 * hook, three distinct colours, no persisted tool state.)
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const COLOURS = ["#ff0000", "#00ff00", "#0000ff"]; // bottom → top
const rgb = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(",");

/** Three opaque layers, red under green under blue. */
async function threeLayers(app: App): Promise<void> {
  const d = (await app.docs()).find((x) => x.active)!;
  for (const c of COLOURS) {
    await app.run("layer-new");
    await app.setForeground(c);
    await app.page.evaluate(([w, h]) => window.graphiq!.select([{ x: 0, y: 0, w, h }]), [d.width, d.height] as const);
    await app.key("Backspace");
    await app.run("select-deselect");
  }
}
/** Row labels, top of the list first. */
const order = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-tour="dock"] [data-layer-id]')].map(
      (el) => el.textContent?.trim().split("\n")[0]?.slice(0, 12) ?? "?",
    ),
  );
/** The colour the composite shows at its centre: the topmost layer's. */
const topColour = (page: Page) =>
  page.evaluate(() => {
    const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
    const d = c.getContext("2d", { willReadFrequently: true })!.getImageData(c.width >> 1, c.height >> 1, 1, 1).data;
    return `${d[0]},${d[1]},${d[2]}`;
  });
/** The Layers panel on screen with all three rows visible: the dock is a tall
 *  scroller, and a touch dispatched at a row's off-screen box lands on nothing. */
async function showLayers(app: App): Promise<void> {
  await app.setSheetDetent("full");
  expect(await app.openPanelById("layers"), "the Layers panel opens").toBe(true);
  await app.page.evaluate(() => {
    for (const section of document.querySelectorAll('[data-tour="dock"] section')) {
      const caret = section.querySelector<HTMLButtonElement>('button[class*="panelCaret"]');
      const label = caret?.getAttribute("aria-label") ?? "";
      if (label.startsWith("Collapse") && !label.endsWith("Layers")) caret!.click();
    }
  });
  await app.settle(600);
  await app.page.evaluate(() => document.querySelector('[data-panel-id="layers"]')?.scrollIntoView({ block: "start" }));
  await app.settle(500);
}

test.describe("with a finger", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("long-press lifts a row, a drag carries it to the top, and it is one Undo", async ({ app }) => {
    const { page } = app;
    await threeLayers(app);
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
    await app.settle(700);
    await showLayers(app);
    const rows = page.locator('[data-tour="dock"] [data-layer-id]');
    const start = await order(page);
    expect(start, "three layers, stacked").toHaveLength(3);
    expect(await topColour(page), "the top layer (blue) is what the picture shows").toBe(rgb(COLOURS[2]));

    /* The bottom row (red), lifted and carried above the top one. */
    const last = (await rows.nth(2).boundingBox())!;
    const first = (await rows.nth(0).boundingBox())!;
    const x = last.x + last.width / 2;
    await app.touchDown(x, last.y + last.height / 2);
    await app.settle(600); // hold: a long press lifts it
    expect(
      await page.evaluate(() => document.querySelectorAll('[data-tour="dock"] [data-dragging="true"]').length),
      "a long press lifts the row",
    ).toBe(1);
    await app.touchMove(x, first.y + first.height / 2, 8);
    await app.touchMove(x, first.y + 4, 2);
    await app.settle(200);
    await app.touchUp();
    await app.settle(900);

    const moved = await order(page);
    expect(moved[0], `${start.join(" / ")} → ${moved.join(" / ")}`).toBe(start[2]);
    expect(await topColour(page), "the picture is re-composited: red is on top now").toBe(rgb(COLOURS[0]));

    /* ONE Undo, not several: the drag reorders live, so if the gesture were
       recorded as it went every intermediate position would be its own step. */
    await app.key("Control+z");
    await app.settle(400);
    expect(await order(page), "one Undo puts the order back").toEqual(start);
    expect(await topColour(page), "...and the picture with it").toBe(rgb(COLOURS[2]));
    await app.key("Control+y");
    await app.settle(400);
    expect(await order(page), "Redo brings it back again").toEqual(moved);
  });
});

test.describe("with a mouse", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("drag and drop still reorders, and is one Undo", async ({ app }) => {
    const { page } = app;
    await threeLayers(app);
    await showLayers(app);
    const rows = page.locator('[data-tour="dock"] [data-layer-id]');
    const start = await order(page);
    /* dragTo, not a hand-rolled mouse sequence: these rows reorder with HTML5
       drag and drop, which plain mouse events do not start. */
    await rows.nth(2).dragTo(rows.nth(0), { targetPosition: { x: 20, y: 4 } });
    await app.settle(900);
    const moved = await order(page);
    expect(moved[0], `${start.join(" / ")} → ${moved.join(" / ")}`).toBe(start[2]);
    expect(await topColour(page), "the picture follows").toBe(rgb(COLOURS[0]));
    await app.key("Control+z");
    await app.settle(400);
    expect(await order(page), "one Undo puts a mouse reorder back too").toEqual(start);
  });
});
