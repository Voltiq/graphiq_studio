/**
 * The phone's tools sheet: every tool, by name, a tap away.
 * (Ported from tools/verify-tool-sheet.js, TODO 2.1. The desktop rail's slots
 * and flyouts are e2e/rail-slots.spec.ts.)
 *
 * The drawer began as the desktop rail with a transform on it: a 76px column
 * of 29 unlabelled icons whose only text was a keyboard-shortcut badge — on a
 * phone, a key that does not exist. Since 3.0 it is a sheet of the rail's five
 * families as titled groups, each tool a tile with its name under it.
 *
 * What the checks are about: every tool carries its NAME (read back against
 * the name the app declares, so captions like "V", "M", "L" would fail); none
 * is behind a flyout or out of reach; and a captioned tile still does what a
 * rail button did. (The pre-3.0 rail's numbers — six core tools first, the
 * whole sheet within 1.2 screens — described a layout 3.0 replaced.)
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** RAIL_CLUSTER_NAMES in lib/tools.ts, in order. */
const FAMILIES = ["Select & move", "Crop & sample", "Paint & retouch", "Type & shapes", "Navigate"];
const TOOL_COUNT = 29;

const openTools = async (app: App) => {
  await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().tap();
  await expect(app.page.locator("html")).toHaveAttribute("data-drawer", "tools");
  await app.settle(600);
};

test("every tool is on the sheet, named, in its family", async ({ app }) => {
  await openTools(app);
  const sheet = await app.page.evaluate(() => {
    const tb = document.querySelector('[data-tour="toolbar"]')!;
    return {
      width: Math.round(tb.getBoundingClientRect().width),
      kbds: tb.querySelectorAll("kbd").length,
      sections: [...tb.querySelectorAll("[data-tool-section]")].map((s) => ({
        name: s.getAttribute("data-tool-section"),
        tools: [...s.querySelectorAll("button[data-tool]")].map((b) => ({
          aria: b.getAttribute("aria-label"),
          caption: b.querySelector('[class*="toolLabel"]')?.textContent?.trim() ?? "",
        })),
      })),
    };
  });
  expect(sheet.width, "a sheet, not a 76px rail").toBeGreaterThanOrEqual(260);
  expect(sheet.sections.map((s) => s.name), "the rail's five families, in order").toEqual(FAMILIES);
  const all = sheet.sections.flatMap((s) => s.tools);
  expect(all.length, "every tool, none behind a flyout").toBe(TOOL_COUNT);
  expect(new Set(all.map((t) => t.aria)).size, "...each once").toBe(TOOL_COUNT);
  expect(
    all.filter((t) => !t.caption || t.caption !== t.aria).map((t) => `${t.aria}: "${t.caption}"`),
    "each captioned with its own name",
  ).toEqual([]);
  expect(sheet.kbds, "no keyboard-shortcut badges on a device with no keyboard").toBe(0);
  await expect(app.page.locator('[data-tour="toolbar"]').getByText("Spot heal", { exact: true })).toBeVisible();
});

test("every tile can be scrolled to and pressed where it sits", async ({ app }) => {
  await openTools(app);
  const tiles = app.page.locator('[data-tour="toolbar"] button[data-tool]');
  const unreachable: string[] = [];
  for (let i = 0; i < (await tiles.count()); i++) {
    const tile = tiles.nth(i);
    await tile.scrollIntoViewIfNeeded();
    const ok = await tile.evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (r.top < 0 || r.bottom > innerHeight || r.width < 40 || r.height < 40) return false;
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return !!hit && el.contains(hit);
    });
    if (!ok) unreachable.push((await tile.getAttribute("aria-label")) ?? `#${i}`);
  }
  expect(unreachable, "no tile is out of reach or covered").toEqual([]);
});

test("tapping a tile picks that tool and closes the sheet", async ({ app }) => {
  await openTools(app);
  const pressed = () =>
    app.page.evaluate(() => document.querySelector('[data-tour="toolbar"] button[aria-pressed="true"]')?.getAttribute("aria-label"));
  const before = await pressed();
  const smudge = app.page.locator('[data-tour="toolbar"] button[data-tool="smudge"]');
  await smudge.scrollIntoViewIfNeeded();
  await smudge.tap();
  await expect.poll(pressed).toBe("Smudge");
  expect(before).not.toBe("Smudge");
  await expect(app.page.locator("html"), "...and the sheet closes, as picking a tool always did").not.toHaveAttribute(
    "data-drawer",
    /.+/,
  );
});
