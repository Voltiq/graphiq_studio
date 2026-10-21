/**
 * A command that does not apply right now is greyed, with its reason — by the
 * same rule wherever it is offered (TODO 1.1): the menu bar, the phone's menu
 * sheet, the command palette and the header's undo/redo all ask
 * commands/registry.ts. The rules are unit-tested
 * (tests/command-registry.test.ts); this is that every surface asks them, asks
 * them fresh, and that greying changed what a row SAYS, not what it DOES.
 */
import { test, expect, PHONE, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

interface Row {
  menu: string;
  label: string;
  /** Why it is greyed; null when it applies. */
  why: string | null;
}

const MENU_BUTTONS = "[data-menubar] > div > button";

/** Every row of every menu, as the menu bar shows it now. */
async function menuRows(app: App): Promise<Row[]> {
  const { page } = app;
  const menus = await page.locator(MENU_BUTTONS).allTextContents();
  const out: Row[] = [];
  for (const menu of menus) {
    await page.locator(MENU_BUTTONS, { hasText: menu }).first().click();
    const rows = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-menubar] [role="menu"] [role^="menuitem"]')].map((b) => ({
        label: b.querySelector("span")!.textContent!.trim(),
        why: b.getAttribute("aria-disabled") === "true" ? b.getAttribute("data-tip") : null,
      })),
    );
    for (const r of rows) out.push({ menu: menu.trim(), ...r });
    await page.keyboard.press("Escape");
  }
  return out;
}

/** How the palette shows `label` — its reason, null if it applies, or
 *  undefined if the search did not find it. */
async function paletteRow(app: App, label: string): Promise<string | null | undefined> {
  const name = label.replace(/…$/, "");
  await app.page.getByRole("combobox", { name: "Search commands" }).fill(name);
  return app.page.evaluate((name) => {
    const rows = [...document.querySelectorAll<HTMLElement>('#command-palette-list [role="option"]')];
    /* A row is its icon, then its label, then the rest — which for a tool (the
       Crop tool sits beside Image ▸ Crop) starts "Tool". */
    const row = rows.find(
      (r) => r.children[1]?.textContent === name && !r.textContent!.slice(name.length).startsWith("Tool"),
    );
    if (!row) return undefined;
    return row.getAttribute("aria-disabled") === "true" ? row.getAttribute("data-tip") : null;
  }, name);
}

const toastWith = (app: App, text: string) => app.page.locator('[role="status"]', { hasText: text });

test("the menus and the palette grey the same commands, for the same reasons", async ({ app }) => {
  test.slow(); // one search per menu row
  const rows = await menuRows(app);
  const greyed = rows.filter((r) => r.why);
  // A fresh document greys plenty (nothing selected, no history, no mask…)
  // and leaves most alone — or this compares two empty lists.
  expect(greyed.length, "a fresh document greys something").toBeGreaterThan(20);
  expect(rows.length - greyed.length, "…and leaves most commands alone").toBeGreaterThan(rows.length / 2);
  expect(
    greyed.filter((r) => !r.why!.trim()).map((r) => `${r.menu} ▸ ${r.label}`),
    "every greyed row says why",
  ).toEqual([]);

  await app.openPalette();
  const differ: string[] = [];
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.label)) continue; // one palette entry per command
    seen.add(r.label);
    const p = await paletteRow(app, r.label);
    if (p !== r.why) differ.push(`${r.menu} ▸ ${r.label}: menu ${JSON.stringify(r.why)}, palette ${JSON.stringify(p)}`);
  }
  expect(differ).toEqual([]);
});

test("greying follows the document: a selection un-greys the selection commands", async ({ app }) => {
  const why = async (label: string) => (await menuRows(app)).find((r) => r.menu === "Select" && r.label === label)?.why;
  expect(await why("Deselect")).toBe("Nothing is selected.");
  expect(await why("Border…")).toBe("Nothing is selected.");

  await app.run("select-all");
  await app.settle(300);
  expect(await why("Deselect")).toBeNull();
  expect(await why("Border…")).toBeNull();

  await app.openPalette();
  expect(await paletteRow(app, "Deselect")).toBeNull();
  await app.page.keyboard.press("Escape");

  // Reselect applies once the selection is gone, and brings it back.
  await app.run("select-deselect");
  await app.settle(300);
  expect(await why("Deselect")).toBe("Nothing is selected.");
  expect(await why("Reselect")).toBeNull();
  await app.run("select-reselect");
  await app.settle(300);
  expect(await why("Deselect"), "the selection is back").toBeNull();
  expect(await why("Reselect")).toBe("Something is already selected.");
});

test("a greyed row still answers: a loud reason is said, a quiet one says nothing", async ({ app }) => {
  const { page } = app;
  const row = (label: RegExp) => page.locator('[data-menubar] [role="menu"] [role^="menuitem"]', { hasText: label }).first();
  // Quiet: Select ▸ Deselect with nothing selected does nothing, as it always did.
  await page.locator(MENU_BUTTONS, { hasText: "Select" }).first().click();
  await expect(row(/^Deselect/)).toHaveAttribute("aria-disabled", "true");
  await row(/^Deselect/).click({ force: true }); // a person can click it; Playwright waits for "enabled"
  await app.settle(400);
  await expect(page.locator('[role="status"]')).toHaveCount(0);

  // Loud: Image ▸ Crop with nothing selected says why, as it always did.
  await page.locator(MENU_BUTTONS, { hasText: "Image" }).first().click();
  await expect(row(/^Crop/)).toHaveAttribute("aria-disabled", "true");
  await row(/^Crop/).click({ force: true });
  await expect(toastWith(app, "Crop trims the canvas to the selection — make a selection first.")).toBeVisible();
});

test("the header's undo and redo ask the same question", async ({ app }) => {
  const undo = app.page.locator("header button[data-tip^='Undo'], header button[aria-label^='Undo']").first();
  const redo = app.page.locator("header button[data-tip^='Redo'], header button[aria-label^='Redo']").first();
  await expect(undo).toBeDisabled();
  await expect(redo).toBeDisabled();
  const layers = () => app.page.evaluate(() => window.graphiq!.layers().length);
  const n = await layers();
  await app.run("layer-new");
  await expect(undo).toBeEnabled();
  await undo.click();
  await expect.poll(layers).toBe(n);
  await expect(redo).toBeEnabled();
  await expect(undo).toBeDisabled();
});

test("a script hears whether its command ran", async ({ app }) => {
  const run = (id: string) => app.page.evaluate((id) => window.graphiq!.run(id), id);
  expect(await run("select-deselect"), "nothing selected: Deselect does not apply").toBe(false);
  expect(await run("image-crop"), "Crop does not apply either").toBe(false);
  await expect(toastWith(app, "Crop trims the canvas")).toBeVisible();
  expect(await run("select-all")).toBe(true);
  await app.settle(200);
  expect(await run("select-deselect"), "now it does").toBe(true);
  expect(await run("no-such-command")).toBe(false);
  app.consoleErrors.length = 0; // the unknown id warns, which is the point
});

test.describe("on a phone", () => {
  test.use(PHONE);

  test("the menu sheet greys the same rows, with the reason on a long press", async ({ app }) => {
    const { page } = app;
    await page.locator('header button[aria-label="Menu"]').first().tap();
    await expect(page.locator('[data-menubar][data-sheet="true"]')).toHaveCount(1);
    await page.locator(MENU_BUTTONS, { hasText: "Select" }).first().tap();
    await app.settle(300);
    const deselect = page.locator('[data-menubar] [role="menu"] [role^="menuitem"]', { hasText: /^Deselect/ }).first();
    await expect(deselect).toHaveAttribute("aria-disabled", "true");
    await expect(deselect).toHaveAttribute("data-tip", "Nothing is selected.");
    await expect(
      page.locator('[data-menubar] [role="menu"] [role^="menuitem"]', { hasText: /^All/ }).first(),
    ).not.toHaveAttribute("aria-disabled", "true");

    const box = (await deselect.boundingBox())!;
    await app.touchDown(box.x + box.width / 2, box.y + box.height / 2);
    await app.page.waitForTimeout(700);
    await expect(page.getByRole("tooltip")).toHaveText("Nothing is selected.");
    await app.touchUp();
  });
});
