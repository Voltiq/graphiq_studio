/**
 * The desktop rail combines tools into slots, Photoshop-style (3.0.0): one
 * button per family, the rest of the family in a flyout. These are the
 * behaviours that make that usable rather than a place tools go to hide:
 *  - the flyout opens on right-click and on a held press, and a hold that
 *    opened it does not ALSO pick the tool under the finger;
 *  - a slot remembers the last tool used from it, however it was chosen;
 *  - and the whole rail fits a 900px window, which is why it was combined.
 */
import { test, expect, type App } from "./fixtures";

const rail = (app: App) => app.page.locator('[data-tour="toolbar"]');
const pressed = (app: App) =>
  app.page.evaluate(() => document.querySelector('[data-tour="toolbar"] [aria-pressed="true"]')?.getAttribute("aria-label") ?? null);

test("a flyout pick takes over its slot, and the slot keeps it", async ({ app }) => {
  const brushSlot = rail(app).getByRole("button", { name: "Brush", exact: true });
  await brushSlot.click({ button: "right" });
  const menu = app.page.getByRole("menu", { name: /tools$/ });
  await expect(menu.getByRole("menuitemradio")).toHaveText([/Brush/, /Pencil/, /Mixer brush/]);
  await menu.getByRole("menuitemradio", { name: /^Pencil/ }).click();
  await expect(menu).toHaveCount(0);
  expect(await pressed(app), "Pencil is the active tool").toBe("Pencil");

  // Leave the slot, then come back to it with one click.
  await rail(app).getByRole("button", { name: "Eraser", exact: true }).click();
  expect(await pressed(app)).toBe("Eraser");
  const slot = rail(app).getByRole("button", { name: "Pencil", exact: true });
  await expect(slot, "the slot still shows Pencil").toHaveCount(1);
  await slot.click();
  expect(await pressed(app), "one click brings Pencil back").toBe("Pencil");
});

test("a shortcut for a tool in a flyout shows that tool in its slot", async ({ app }) => {
  await app.parkMouse();
  await app.key("n"); // Pencil
  expect(await pressed(app)).toBe("Pencil");
  await expect(rail(app).getByRole("button", { name: "Brush", exact: true }), "the slot switched").toHaveCount(0);
});

test("holding a slot opens its flyout and does not also pick the tool", async ({ app }) => {
  await rail(app).getByRole("button", { name: "Eraser", exact: true }).click();
  const wand = rail(app).getByRole("button", { name: "Magic wand", exact: true });
  const b = (await wand.boundingBox())!;
  await app.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await app.page.mouse.down();
  await app.page.waitForTimeout(600);
  await app.page.mouse.up();
  await expect(app.page.getByRole("menu", { name: /tools$/ }), "the flyout is open").toHaveCount(1);
  expect(await pressed(app), "the held slot's tool was not chosen by the release").toBe("Eraser");
  await app.page.keyboard.press("Escape");
  await expect(app.page.getByRole("menu", { name: /tools$/ })).toHaveCount(0);
});

test("the rail fits a 900px window without scrolling", async ({ app }) => {
  const fit = await app.page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('[data-tour="toolbar"]')!;
    return { scroll: el.scrollHeight, client: el.clientHeight, slots: el.querySelectorAll("button[data-tool]").length };
  });
  expect(fit.slots).toBeGreaterThan(10);
  expect(fit.scroll, `${fit.slots} slots in ${fit.client}px`).toBeLessThanOrEqual(fit.client);
});
