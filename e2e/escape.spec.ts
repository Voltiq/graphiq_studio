/**
 * Escape closes what is in front of the document before it touches the document,
 * and the deselect it does perform can be undone. (TODO 0.2b)
 *
 * Measured before: with a selection made, opening the colour picker and pressing
 * Escape closed the picker AND cleared the selection. ~80 popovers, dropdowns and
 * menus close themselves on Escape from a `document` listener without consuming
 * the key, so the editor's `window` handler deselected on the same keystroke —
 * and that deselect was not a history step (the menu's Select ▸ Deselect is), so
 * the selection was gone for good.
 *
 * The probe: Backspace fills the selection, so after Escape a filled 400×300 rect
 * (120,000 px) means the selection survived and nothing filled means it was lost.
 */
import { test, expect, type App } from "./fixtures";
import type { Locator } from "@playwright/test";

const RECT = { x: 300, y: 200, w: 400, h: 300 };
const AREA = RECT.w * RECT.h;

async function select(app: App) {
  await app.page.evaluate((r) => window.graphiq!.select([r]), RECT);
  await app.settle(400);
}

/** Fill the selection (if any) and report how many pixels got ink. */
async function fillInk(app: App): Promise<number> {
  await app.setForeground("#e0402a");
  await app.key("Backspace");
  return (await app.exported()).ink;
}

const transients: [string, (app: App) => Promise<Locator>][] = [
  [
    "the colour picker",
    async (app) => {
      // Its trigger's aria-expanded is the open/closed signal: a docked panel
      // carries the same "Color picker" label, so matching by label is ambiguous.
      const trigger = app.page.getByRole("button", { name: "Brush color" }).first();
      await trigger.click();
      return app.page.locator('button[aria-label="Brush color"][aria-expanded="true"]');
    },
  ],
  [
    "a dropdown",
    async (app) => {
      await app.page.locator('button[aria-haspopup="listbox"]').first().click();
      return app.page.locator('[role="listbox"]');
    },
  ],
  [
    "a menu-bar menu",
    async (app) => {
      await app.page.locator("[data-menubar] > div > button", { hasText: "Select" }).first().click();
      return app.page.locator('[data-menubar] [role="menu"]');
    },
  ],
];

for (const [what, open] of transients) {
  test(`Escape closes ${what} and leaves the selection alone`, async ({ app }) => {
    await app.page.getByRole("button", { name: "Brush", exact: true }).click(); // a tool whose bar has a colour + dropdowns
    await select(app);
    const ui = await open(app);
    await expect(ui, `${what} opened`).toBeVisible();
    await app.page.keyboard.press("Escape");
    await expect(ui, `${what} closed`).toBeHidden();
    await app.settle(300);
    expect(await fillInk(app), "the selection survived the Escape").toBe(AREA);
  });
}

test("an Escape that does deselect can be undone", async ({ app }) => {
  await select(app);
  await app.key("Escape");
  expect(await fillInk(app), "Escape deselected (nothing to fill)").toBe(0);
  await app.parkMouse();
  await app.key("Control+z");
  expect(await fillInk(app), "Ctrl+Z brought the selection back").toBe(AREA);
});
