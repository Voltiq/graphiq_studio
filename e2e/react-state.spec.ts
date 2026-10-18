/**
 * React state sync. (Ported from tools/verify-react-state.js, TODO 2.1.)
 *
 * The components whose prop→state sync moved out of an effect into a
 * render-time adjust (React's "adjusting state when a prop changes" pattern),
 * the dock handle that moved to useImperativeHandle, and the overlay's
 * per-frame draw, which was reading a PROP from inside a useCallback with no
 * dependencies.
 *
 * Those rewrites are the kind lint approves of and a user notices: get the
 * comparison wrong and a component either stops re-syncing (a stale draft) or
 * re-syncs on every render ("Too many re-renders", a blank screen). Neither
 * shows up in a unit test, because the behaviour only exists once React is
 * driving real components. So every test here also requires a clean console:
 * a render-phase setState loop throws, and throwing is the failure these
 * rewrites risk.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 1500, height: 950 } });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no React error reached the console").toEqual([]);
});

test("a slider follows a value changed from outside it", async ({ app }) => {
  // The brush Size slider and its click-to-type readout show the engine's
  // value. `]` changes that value from the KEYBOARD, nowhere near the control
  // — the script this came from set the slider itself and read it back.
  const { page } = app;
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await app.settle(300);
  await app.setRange("Size", 40);
  await app.settle(300);
  const slider = page.locator('[data-tour="options"] input[type="range"][aria-label="Size"]').first();
  const readout = slider.locator("xpath=..").locator('[role="button"]').first();
  expect(await slider.inputValue(), "the starting size took").toBe("40");
  await app.parkMouse();
  for (let i = 0; i < 3; i++) await page.keyboard.press("]");
  await app.settle(400);
  const now = Number(await slider.inputValue());
  expect(now, "] grew the brush, and the slider followed").toBeGreaterThan(40);
  await expect(readout, "...and so did its readout").toHaveText(`${now}px`);
});

test("the properties name field follows the selected layer", async ({ app }) => {
  const { page } = app;
  await app.run("layer-new");
  await app.run("layer-new");
  /* The rename input carries no `type` attribute, so `input[type="text"]` does
     NOT match it — target its class instead. */
  const rename = page.locator('[data-tour="dock"] input[class*="propsName"]').first();
  await expect(rename, "the properties panel exposes a name field").toHaveCount(1);
  const first = await rename.inputValue();
  const rows = page.locator('li[class*="layerItem"]');
  expect(await rows.count(), "two layers to switch between").toBeGreaterThan(1);
  const target = await page.evaluate(() => window.graphiq!.layers()[1].name);
  await rows.nth(1).click();
  await app.settle(800);
  const second = await rename.inputValue();
  expect(second, `"${first}" -> the clicked layer's name`).toBe(target);
  expect(second, "...which is a different layer").not.toBe(first);
});

test("typing in the command palette puts the highlight back on the first row", async ({ app }) => {
  const { page } = app;
  await page.keyboard.press("Control+k");
  const input = page.locator('input[placeholder*="ommand"], [role="dialog"] input').first();
  await expect(input, "the command palette opens").toBeVisible();
  const active = () =>
    page.evaluate(() => document.querySelector('[data-idx][aria-selected="true"]')?.getAttribute("data-idx") ?? null);
  await input.pressSequentially("lay", { delay: 40 });
  await app.settle(300);
  await page.keyboard.press("ArrowDown");
  await app.settle(200);
  // Without this, "row 0 is highlighted" would pass for a highlight that never moved.
  expect(await active(), "ArrowDown moved the highlight off the first row").toBe("1");
  await input.pressSequentially("er", { delay: 40 });
  await app.settle(300);
  expect(await active(), "a changed query resets it to the first row").toBe("0");
  await app.key("Escape");
});

test("a tooltip appears, is positioned, and goes away", async ({ app }) => {
  const { page } = app;
  await page.locator('[data-tour="toolbar"] button').first().hover();
  const tip = page.locator('[role="tooltip"]');
  await expect(tip, "a tooltip appears").toHaveCount(1, { timeout: 3_000 });
  const r = await tip.boundingBox();
  expect(r && r.width > 0 && r.height > 0, `it has been positioned (${JSON.stringify(r)})`).toBe(true);
  await page.mouse.move(750, 500);
  await expect(tip, "...and goes away when the pointer leaves").toHaveCount(0, { timeout: 3_000 });
});

test("Reset workspace reaches the dock through its imperative handle", async ({ app }) => {
  /* The useImperativeHandle conversion. Reset Workspace calls apply(null)
     through the ref; if the ref were never published the item would do nothing,
     so the dock's panel count must actually change. */
  const { page } = app;
  const panels = () => page.evaluate(() => document.querySelectorAll('[data-tour="dock"] section').length);
  /* The menubar sometimes swallows a click that lands while the previous menu
     is still closing, so open it with a retry rather than one hopeful click. */
  const windowMenu = async (item: RegExp) => {
    for (let i = 0; i < 4; i++) {
      await page.keyboard.press("Escape");
      await app.settle(250);
      await page.getByText("Window", { exact: true }).first().click();
      const ok = await page
        .waitForSelector('[role="menu"]', { timeout: 2_500 })
        .then(() => true)
        .catch(() => false);
      if (ok) break;
    }
    await app.settle(250);
    await page.locator('[role="menu"] button').filter({ hasText: item }).first().click({ timeout: 5_000 });
    await app.settle(800);
  };
  const before = await panels();
  await windowMenu(/^Layers$/);
  const closed = await panels();
  expect(closed, "a panel can be toggled off from the Window menu").toBeLessThan(before);
  await windowMenu(/^Reset workspace$/);
  expect(await panels(), `Reset workspace brought it back (${before} -> ${closed} -> reset)`).toBeGreaterThan(closed);
});

test("the gradient popover opens fully on screen", async ({ app }) => {
  // `g` lands on the paint bucket OR the gradient (whichever was last used, and
  // that persists), so the tool is picked by name.
  const { page } = app;
  await page.getByRole("button", { name: /^Gradient/ }).first().click();
  await app.settle(500);
  const swatch = page.locator('[data-tour="options"] button[aria-label="Gradient colours"]').first();
  await expect(swatch, "the gradient tool exposes a swatch").toHaveCount(1);
  await swatch.click();
  const pop = page.locator('div[class*="popover"]').filter({ hasText: "Primary → Secondary" });
  await expect(pop, "the gradient popover opens").toHaveCount(1);
  const r = (await pop.boundingBox())!;
  const vp = page.viewportSize()!;
  expect(
    r.x >= 0 && r.y >= 0 && r.x + r.width <= vp.width && r.y + r.height <= vp.height,
    `it is positioned inside the viewport (${JSON.stringify(r)} in ${vp.width}x${vp.height})`,
  ).toBe(true);
  await app.key("Escape");
});

/** Overlay ink: the last canvas that is NOT the loupe. The loupe was added
 *  after the overlay in the DOM and is blank for a mouse, so "the last canvas"
 *  once measured zero whatever the overlay drew. */
const overlayInk = (app: App) =>
  app.page.evaluate(() => {
    const cs = [...document.querySelectorAll("canvas")].filter((c) => !c.hasAttribute("data-loupe"));
    const el = cs[cs.length - 1];
    const d = el.getContext("2d")!.getImageData(0, 0, el.width, el.height).data;
    let n = 0;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 8) n++;
    return n;
  });

test("the overlay draws frame chrome for the CURRENTLY selected layer", async ({ app }) => {
  /* `drawAnts` is useCallback(..., []) — deliberately, it is the per-frame
     overlay draw — and it was reading the `activeLayerId` PROP, so it captured
     whatever was selected at mount and never updated: a frame drawn after
     mount got no chrome. It now reads activeLayerIdRef.
     The overlay loop STOPS and clears itself when nothing needs it, so the
     pointer is parked over the canvas with the eyedropper — a keep-alive
     branch that draws almost nothing itself. Without that the overlay is blank
     either way and the measurement proves nothing. */
  const { page } = app;
  // A plain layer to switch to. A fresh document has none, and "the last row"
  // is then the frame itself (the script this came from had made two earlier).
  await app.run("layer-new");
  const plain = (await app.layerNames()).at(-1)!;
  const box = await app.canvasBox();
  const hoverCanvas = async () => {
    await page.getByRole("button", { name: /^Eyedropper/ }).first().click();
    await app.settle(400);
    await page.mouse.move(box.x + box.width * 0.8, box.y + box.height * 0.85);
    await app.settle(250);
    await page.mouse.move(box.x + box.width * 0.8 + 3, box.y + box.height * 0.85 + 3);
    await app.settle(900);
  };
  await page.getByRole("button", { name: /^Frame/ }).first().click();
  await app.settle(500);
  await page.mouse.move(box.x + box.width * 0.25, box.y + box.height * 0.25);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.7, { steps: 10 });
  await page.mouse.up();
  await app.settle(1_200);
  await hoverCanvas();
  const inkFrame = await overlayInk(app);
  expect(await app.layerNames(), "the frame was drawn as a layer of its own").toHaveLength(2);
  await page.locator('li[class*="layerItem"]').filter({ hasText: plain }).first().click();
  await app.settle(800);
  await hoverCanvas();
  const inkPlain = await overlayInk(app);
  expect(inkFrame, `overlay ink with the frame selected vs ${inkPlain} with a plain layer`).toBeGreaterThan(
    inkPlain + 200,
  );
});
