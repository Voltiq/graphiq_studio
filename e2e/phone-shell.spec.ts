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

/* An iPhone 13 mini in Safari: 375 wide, and 629 of its 812 is what the page
   gets once the address and tab bars have taken theirs. The reports these
   pin came from that phone. */
test.describe("on an iPhone 13 mini", () => {
  test.use({ viewport: { width: 375, height: 629 } });

  const keysAndName = (app: App) =>
    app.page.evaluate(() => {
      const mid = (s: string) => {
        const b = document.querySelector(s)!.getBoundingClientRect();
        return Math.round(b.top + b.height / 2);
      };
      return {
        name: mid("[data-options-open]"),
        key: mid('[aria-label="Keyboard modifiers"] button'),
        published: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--m-options-h")),
      };
    });

  test("folded, the card is one row: the tool with its keys beside it", async ({ app }) => {
    const open = await cardHeight(app);
    await app.page.locator("[data-options-open]").tap();
    await app.settle(600);
    const folded = await cardHeight(app);
    expect(folded, `${open}px open → ${folded}px folded`).toBeLessThanOrEqual(70);
    const r = await keysAndName(app);
    expect(Math.abs(r.name - r.key), "Shift / Alt / Ctrl on the tool's row").toBeLessThanOrEqual(2);
    await expect(card(app).locator('[aria-label="Keyboard modifiers"] button').first()).toBeVisible();
    expect(Math.abs(r.published - folded), "...and the picture is fitted to the row").toBeLessThan(2);
  });

  test("the panels sheet: the chips are whole, on screen and on top", async ({ app }) => {
    await dock(app).locator("button", { hasText: "Panels" }).first().tap();
    await app.settle(800);
    const g = await app.page.evaluate(() => {
      const box = (s: string) => document.querySelector(s)!.getBoundingClientRect();
      const strip = box('[role="tablist"][aria-label="Panels"]');
      const chip = box('[data-panel-chip="layers"]');
      const hit = document.elementFromPoint(chip.left + chip.width / 2, chip.top + chip.height / 2);
      return {
        strip: { top: strip.top, bottom: strip.bottom },
        chip: { top: chip.top, bottom: chip.bottom, h: chip.height },
        sheetTop: box('[data-tour="dock"]').top,
        headerBottom: box('[data-tour="topbar"]').bottom,
        onTop: !!hit?.closest('[data-panel-chip="layers"]'),
      };
    });
    expect(g.sheetTop, "the sheet starts below the header").toBeGreaterThanOrEqual(g.headerBottom);
    expect(g.chip.h, "a full-height chip").toBeGreaterThanOrEqual(44);
    expect(g.chip.top, "...inside its strip").toBeGreaterThanOrEqual(g.strip.top);
    expect(g.chip.bottom, "...not clipped by it").toBeLessThanOrEqual(g.strip.bottom);
    expect(g.onTop, "...and nothing drawn over it").toBe(true);
    // The card gives the sheet its room: one row while a drawer is open.
    expect(await cardHeight(app)).toBeLessThanOrEqual(70);
  });

  test("the tool's name drags the card open, and a tap still folds it", async ({ app }) => {
    const name = app.page.locator("[data-options-open]");
    await name.tap();
    await app.settle(600);
    const folded = await cardHeight(app);
    const b = (await name.boundingBox())!;
    const x = b.x + b.width / 3;
    const y = b.y + b.height / 2;
    await app.touchDown(x, y);
    await app.touchMove(x, y - 120, 8);
    await app.touchUp();
    await app.settle(600);
    await expect(name, "dragged open").toHaveAttribute("aria-expanded", "true");
    const opened = await cardHeight(app);
    expect(opened - folded, `${folded}px → ${opened}px`).toBeGreaterThan(80);

    await app.settle(2_500); // Chromium drops the click of a tap for ~2s after a touch drag
    await name.tap();
    await app.settle(600);
    await expect(name, "the next tap is a tap again").toHaveAttribute("aria-expanded", "false");
  });
});

/* Reported: renaming a document in the tab strip on a phone showed "a way too
   huge" text box — the touch floor (44px, 16px type) made the inline input a
   slab overflowing its 32px tab. The tab itself is the field now. */
test("renaming a document in the tab strip: the tab becomes the field, no bigger than a tab", async ({ app }) => {
  await app.newDoc();
  await app.settle(500);
  const active = app.page.locator('[data-tabs] button[data-active="true"]');
  await active.tap();
  await app.settle(400);
  const input = app.page.locator("[data-tabs] input");
  await expect(input, "the name is editable in place").toBeFocused();
  const g = await app.page.evaluate(() => {
    const box = (el: Element) => el.getBoundingClientRect();
    const input = document.querySelector("[data-tabs] input")!;
    const tab = input.closest("[data-editing]")!;
    const other = document.querySelector('[data-tabs] button[data-active="false"]')!;
    const fs = (el: Element) => parseFloat(getComputedStyle(el).fontSize);
    const r = box(input);
    const t = box(tab);
    return {
      inside: r.top >= t.top - 0.5 && r.bottom <= t.bottom + 0.5,
      tabH: Math.round(t.height),
      otherH: Math.round(box(other).height),
      inputFont: fs(input),
      tabFont: fs(other),
      inputBorder: getComputedStyle(input).borderTopWidth,
    };
  });
  expect(g.inside, "the field sits inside its tab").toBe(true);
  expect(g.tabH, "the editing tab is as tall as its neighbours").toBe(g.otherH);
  expect(g.inputFont - g.tabFont, "the name barely changes size").toBeLessThanOrEqual(1);
  expect(g.inputFont, "...and is never under 16px (Safari would zoom the page)").toBeGreaterThanOrEqual(16);
  expect(g.inputBorder, "no box of its own").toBe("0px");
  await input.fill("Poster");
  await app.page.keyboard.press("Enter");
  await app.settle(300);
  expect((await app.docs()).map((d) => d.name), "renamed").toContain("Poster");
});

/* Reported: on a phone the Color panel's slider ends were oval, its swatch
   row was cut off, its Picker / Swatches buttons were lopsided, and it was
   hard to scroll — the whole picker refused vertical swipes. */
test.describe("the Color panel on a phone", () => {
  const openColour = async (app: App) => {
    await dock(app).locator("button", { hasText: "Panels" }).first().tap();
    await app.settle(800);
    await app.setSheetDetent("full");
    await app.page.locator('[data-panel-chip="color"]').tap();
    await app.settle(700);
  };
  const fg = (app: App) => app.page.evaluate(() => window.graphiq!.foreground().toLowerCase());

  test("round strips, whole swatches, an even Picker / Swatches control", async ({ app }) => {
    await openColour(app);
    const g = await app.page.evaluate(() => {
      const panel = document.querySelector('[data-panel-id="color"]')!;
      const hue = panel.querySelector<HTMLElement>('[aria-label="Hue"]')!;
      const row = panel.querySelector('[class*="swRowItems"]')!.getBoundingClientRect();
      const chips = [...panel.querySelectorAll('[class*="swRowItems"] button')]
        .map((b) => b.getBoundingClientRect())
        .filter((r) => r.top < row.bottom);
      const seg = panel.querySelector('[role="group"][aria-label="Color view"]')!.getBoundingClientRect();
      const halves = [...panel.querySelectorAll("[data-color-view]")].map((b) => Math.round(b.getBoundingClientRect().width));
      const body = panel.querySelector('[class*="colorPanel"]')!.getBoundingClientRect();
      return {
        huePad: getComputedStyle(hue).paddingTop,
        hueH: hue.getBoundingClientRect().height,
        chipsWhole: chips.length > 0 && chips.every((r) => r.bottom <= row.bottom + 0.5),
        chipH: Math.round(chips[0]?.height ?? 0),
        segFull: seg.width >= body.width - 2,
        halves,
      };
    });
    expect(g.huePad, "the strip is its own box: a pill, not a pill cut from a padded box").toBe("0px");
    expect(g.hueH, "...14px tall").toBe(14);
    expect(g.chipsWhole, "every swatch in the row shows whole").toBe(true);
    expect(g.chipH, "...at the 44px floor").toBe(44);
    expect(g.segFull, "Picker / Swatches spans the panel").toBe(true);
    expect(Math.abs(g.halves[0] - g.halves[1]), "...in two even halves").toBeLessThanOrEqual(1);
  });

  test("a vertical swipe over a strip scrolls the panel; a sideways drag sets the colour", async ({ app }) => {
    await openColour(app);
    await app.setSheetDetent("half"); // a sheet shorter than the panel: something to scroll
    await app.settle(600);
    const before = await fg(app);
    const sheet = app.page.locator('[data-tour="dock"]');
    const top0 = await sheet.evaluate((el) => el.scrollTop);
    let b = (await app.page.locator('[data-panel-id="color"] [aria-label="Hue"]').boundingBox())!;
    await app.touchDown(b.x + b.width * 0.3, b.y + b.height / 2);
    await app.touchMove(b.x + b.width * 0.3, b.y + b.height / 2 - 160, 10);
    await app.touchUp();
    await app.settle(700);
    expect(await sheet.evaluate((el) => el.scrollTop), "the panel scrolled").toBeGreaterThan(top0 + 40);
    expect(await fg(app), "and the colour is untouched").toBe(before);

    await app.settle(2_000); // Chromium drops the gesture after a touch scroll for a moment
    b = (await app.page.locator('[data-panel-id="color"] [aria-label="Hue"]').boundingBox())!;
    await app.touchDown(b.x + b.width * 0.1, b.y + b.height / 2);
    await app.touchMove(b.x + b.width * 0.15, b.y + b.height / 2, 4);
    await app.touchMove(b.x + b.width * 0.05, b.y + b.height / 2, 6);
    await app.touchUp();
    await app.settle(400);
    expect(await fg(app), "a sideways drag on the strip changes the hue").not.toBe(before);
  });
});
