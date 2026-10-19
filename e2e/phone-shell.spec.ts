/**
 * The phone shell's own controls, as the 3.0.0 redesign draws them: the glass
 * dock's quick tools, the readout chip that fits the picture, and the
 * document menu behind the name in the header.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

const dock = (app: App) => app.page.locator('[data-tour="mobilebar"]');
const zoomShown = (app: App) =>
  app.page.evaluate(() => parseInt(document.querySelector("[data-status-zoom]")?.textContent ?? "", 10));

test("a quick tool in the dock picks its tool in one tap, and shows it", async ({ app }) => {
  const eraser = dock(app).locator('button[data-quick="eraser"]');
  await eraser.tap();
  await app.settle(300);
  await expect(eraser, "the dock shows the eraser as the tool").toHaveAttribute("aria-pressed", "true");
  await expect(dock(app).locator('button[data-quick="brush"]')).toHaveAttribute("aria-pressed", "false");
  await expect(app.page.locator("[data-options-open]"), "...and the options card names it").toHaveAccessibleName(
    /^Eraser options$/,
  );
});

test("tapping the readout chip fits the picture again", async ({ app }) => {
  const fitted = await zoomShown(app);
  expect(fitted, "the chip reads the zoom").toBeGreaterThan(0);
  // Two fingers apart over the picture: a pinch zoom.
  const b = await app.canvasBox();
  const cx = b.x + b.width / 2;
  const cy = b.y + b.height / 2;
  await app.touches("touchStart", [
    { x: cx - 30, y: cy },
    { x: cx + 30, y: cy },
  ]);
  for (let i = 1; i <= 6; i++)
    await app.touches("touchMove", [
      { x: cx - 30 - i * 15, y: cy },
      { x: cx + 30 + i * 15, y: cy },
    ]);
  await app.touches("touchEnd", []);
  await app.settle(2_500); // Chromium drops the click of the next tap for ~2s after a touch drag
  const pinched = await zoomShown(app);
  expect(pinched, "the pinch zoomed in").toBeGreaterThan(fitted);
  await app.page.locator("[data-mobile-status]").tap();
  await app.settle(500);
  expect(await zoomShown(app), "the chip put it back").toBe(fitted);
});

test("the document menu switches between open documents", async ({ app }) => {
  const title = app.page.locator('[data-tour="topbar"] button[aria-haspopup="menu"]').first();
  const first = (await app.docs())[0];
  await app.newDoc();
  const docs = await app.docs();
  expect(docs.length, "two documents open").toBe(2);
  await expect(title, "the header names the new one").toContainText(docs[1].name);
  await title.tap();
  const menu = app.page.getByRole("menu", { name: "Documents" });
  await expect(menu.getByRole("menuitemradio")).toHaveCount(2);
  await menu.getByRole("menuitemradio", { name: first.name }).tap();
  await app.settle(400);
  await expect(menu, "picking one closes the menu").toHaveCount(0);
  await expect(title, "...and the header follows").toContainText(first.name);
});

const card = (app: App) => app.page.locator('[data-tour="options"]');
const cardHeight = async (app: App) => (await card(app).boundingBox())!.height;

test("the options card opens with the tool's controls showing", async ({ app }) => {
  await expect(app.page.locator("[data-options-open]")).toHaveAttribute("aria-expanded", "true");
  await expect(card(app).locator('input[type="range"][aria-label="Size"]'), "the brush's Size, on screen").toBeVisible();
  await expect(card(app).locator('[aria-label="Keyboard modifiers"] button'), "the keys at the foot").toHaveCount(3);
});

test("the grip resizes the card, folds it, and the size is remembered", async ({ app }) => {
  const grip = app.page.locator("[data-options-grip]");
  const g = (await grip.boundingBox())!;
  const x = g.x + g.width / 2;
  const y = g.y + g.height / 2;
  const before = await cardHeight(app);

  await app.touchDown(x, y); // drag it up: taller
  await app.touchMove(x, y - 90, 8);
  await app.touchUp();
  await app.settle(500);
  const taller = await cardHeight(app);
  expect(taller - before, `${before}px → ${taller}px`).toBeGreaterThan(70);

  await app.boot(); // a reload: the same storage, a cold mount
  expect(Math.abs((await cardHeight(app)) - taller), "the height survives a reload").toBeLessThan(2);

  const g2 = (await grip.boundingBox())!;
  await app.touchDown(g2.x + g2.width / 2, g2.y + g2.height / 2); // dragged right down: folded
  await app.touchMove(g2.x + g2.width / 2, g2.y + 400, 8);
  await app.touchUp();
  await app.settle(500);
  await expect(app.page.locator("[data-options-open]")).toHaveAttribute("aria-expanded", "false");
  expect(await cardHeight(app), "folded to its header and keys").toBeLessThan(before);

  await app.settle(2_500); // Chromium drops the click of a tap for ~2s after a touch drag
  await grip.tap(); // a tap opens it again, at the remembered height
  await app.settle(500);
  await expect(app.page.locator("[data-options-open]")).toHaveAttribute("aria-expanded", "true");
  expect(Math.abs((await cardHeight(app)) - taller), "back at the height it had").toBeLessThan(2);
});

test("the panels sheet: a chip per panel, one panel at a time", async ({ app }) => {
  await dock(app).locator("button", { hasText: "Panels" }).first().tap();
  await app.settle(700);
  const chips = app.page.locator("[data-panel-chip]");
  expect(await chips.count(), "every panel has a chip").toBeGreaterThanOrEqual(8);
  await expect(app.page.locator('[data-panel-id="layers"]'), "Layers shows first").toHaveAttribute("data-open", "true");
  await app.page.locator('[data-panel-chip="history"]').tap();
  await app.settle(500);
  await expect(app.page.locator('[data-panel-chip="history"]')).toHaveAttribute("aria-selected", "true");
  await expect(app.page.locator('[data-panel-id="history"]')).toBeVisible();
  await expect(app.page.locator('[data-panel-id="layers"]'), "...and only it").toBeHidden();
  // The card's controls step aside for the sheet; its keys stay in reach.
  await expect(card(app).locator("[data-options-sheet]")).toBeHidden();
  await expect(card(app).locator('[aria-label="Keyboard modifiers"] button').first()).toBeVisible();
});

test("the tools sheet groups the tools by what they are for", async ({ app }) => {
  await dock(app).locator("button", { hasText: "Tools" }).first().tap();
  await app.settle(600);
  const sections = app.page.locator('[data-tour="toolbar"] [data-tool-section]');
  await expect(sections).toHaveCount(5);
  await expect(sections.first()).toContainText("Select & move");
  await app.page.locator('[data-tour="toolbar"]').getByRole("button", { name: "Pencil", exact: true }).tap();
  await app.settle(500);
  await expect(app.page.locator("[data-options-open]"), "picked, and the sheet gave way").toHaveAccessibleName(
    /^Pencil options$/,
  );
});
