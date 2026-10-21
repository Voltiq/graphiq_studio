/**
 * The command palette, and the menu sheet it leads on a phone.
 * (Ported from tools/verify-command-palette.js, TODO 2.1.)
 *
 * "163 menu rows rendered as one flat scrolling column is not navigable" —
 * measured, the sheet was not flat: ten menu names, each expanding inline.
 * What was broken was narrower: the palette hid behind a textless magnifier,
 * and an expanded menu pushed the other nine off the end (Layer grew the
 * sheet to 2471px, 2.9 screens). So: search leads the sheet, and an open menu
 * scrolls inside it rather than lengthening it. (3.0 moved search out of the
 * phone's header entirely: it is the sheet's first row.)
 *
 * The keyboard is exercised through `--kb-inset`, the property the app really
 * uses (useVisualViewport): mobile browsers mostly do NOT resize the layout
 * viewport for a keyboard, so a resize would test a case that does not happen.
 * Two keyboards, and the second is the point: at 300px the palette fits even
 * with its height clamp deleted; the clamp only works past ~309px, so a
 * 300-only check passed two mutations that removed it.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** The palette's list, and whether its 5th row can be tapped. */
const readPalette = (app: App) =>
  app.page.evaluate(() => {
    const list = document.getElementById("command-palette-list");
    if (!list) return null;
    const rows = [...list.querySelectorAll('[role="option"]')];
    const fifth = rows[4];
    const fr = fifth?.getBoundingClientRect();
    const hit = fr && document.elementFromPoint(fr.x + fr.width / 2, fr.y + fr.height / 2);
    const visibleBottom =
      innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0);
    return {
      rows: rows.length,
      minRowH: Math.round(Math.min(...rows.map((r) => r.getBoundingClientRect().height))),
      scrolls: list.scrollHeight > list.clientHeight + 2,
      listBottom: Math.round(list.getBoundingClientRect().bottom),
      visibleBottom: Math.round(visibleBottom),
      fifthReachable: !!hit && hit.closest('[role="option"]') === fifth && fr.top >= 0 && fr.bottom <= visibleBottom,
    };
  });

const openSheet = async (app: App) => {
  await app.page.locator('header button[aria-label="Menu"]').first().tap();
  await expect(app.page.locator('[data-menubar][data-sheet="true"]')).toHaveCount(1);
  await app.settle(400);
};

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("search is the menu sheet's first row, and opens the palette in the sheet's place", async ({ app }) => {
    await openSheet(app);
    const first = await app.page.evaluate(() => {
      const s = document.querySelector("[data-menubar]")!.querySelector(":scope > div > button")!;
      const r = s.getBoundingClientRect();
      return { search: s.hasAttribute("data-sheet-search"), text: s.textContent!.trim(), w: r.width, h: r.height };
    });
    expect(first.search, `the first row is search: "${first.text}"`).toBe(true);
    expect(first.h >= 44 && first.w >= 300, `...a full-width, tappable row: ${first.w}×${first.h}`).toBe(true);
    await app.page.locator("[data-sheet-search]").tap();
    await expect(app.page.locator("#command-palette-list"), "the palette opens").toHaveCount(1);
    await expect(app.page.locator('[data-menubar][data-sheet="true"]'), "...and the sheet closes").toHaveCount(0);
  });

  test("the palette's rows take a finger, scroll, and stay above a keyboard", async ({ app }) => {
    await app.run("layer-new");
    await app.openPalette();
    /* Empty, it shows a hint, not a list; a word with many answers fills it.
       On touch the field is not focused for you (no dialog raises the keyboard
       by itself — lib/focus), so the query goes in the way a finger would. */
    await app.page.locator('[role="combobox"]').fill("layer");
    await app.settle(400);
    const bare = (await readPalette(app))!;
    expect(bare.minRowH, `its rows are sized for a finger (${bare.rows} rows)`).toBeGreaterThanOrEqual(44);
    expect(bare.scrolls, "the list scrolls when the results outrun it").toBe(true);
    expect(bare.fifthReachable, "the 5th row can be tapped").toBe(true);
    for (const kb of [300, 380]) {
      await app.page.evaluate((px) => document.documentElement.style.setProperty("--kb-inset", `${px}px`), kb);
      await app.settle(600);
      const p = (await readPalette(app))!;
      expect(p.scrolls, `with a ${kb}px keyboard the list still scrolls`).toBe(true);
      expect(p.fifthReachable, `...its 5th row is still on screen and hit-testable`).toBe(true);
      expect(p.listBottom, `...and it ends above the keyboard, not behind it`).toBeLessThanOrEqual(p.visibleBottom);
    }
    await app.page.evaluate(() => document.documentElement.style.removeProperty("--kb-inset"));
  });

  test("a command run from the palette does the thing", async ({ app }) => {
    const before = (await app.layerNames()).length;
    await app.openPalette();
    await app.page.locator('[role="combobox"]').fill("new layer");
    await app.settle(400);
    await app.page.keyboard.press("Enter");
    await expect(app.page.locator("#command-palette-list"), "the palette closes").toHaveCount(0);
    await expect.poll(async () => (await app.layerNames()).length, { message: "...and a layer was made" }).toBe(before + 1);
  });

  test("an open menu scrolls inside the sheet instead of pushing the others off it", async ({ app }) => {
    const { page } = app;
    await openSheet(app);
    const names = await page.evaluate(() =>
      [...document.querySelectorAll("[data-menubar] > div > button")]
        .filter((x) => !x.hasAttribute("data-sheet-search"))
        .map((x) => x.textContent!.trim()),
    );
    expect(names.length, `the sheet lists every menu: ${names.join(", ")}`).toBeGreaterThanOrEqual(10);
    const tap = (label: string) =>
      page.evaluate((l) => {
        [...document.querySelectorAll<HTMLButtonElement>("[data-menubar] > div > button")]
          .find((b) => b.textContent!.trim() === l)
          ?.click();
      }, label);
    const far: string[] = [];
    let worst = { label: "", screens: 0 };
    let longest: { label: string; items: number; scrolls: boolean } | null = null;
    for (const label of names) {
      await tap(label);
      await app.settle(320);
      const m = await page.evaluate((l) => {
        const nav = document.querySelector("[data-menubar]")!;
        const dd = nav.querySelector('[role="menu"]');
        const tops = [...nav.querySelectorAll(":scope > div > button")].filter((x) => !x.hasAttribute("data-sheet-search"));
        const i = tops.findIndex((x) => x.textContent!.trim() === l);
        const next = tops[i + 1] ?? tops[i - 1];
        return {
          screens: nav.scrollHeight / innerHeight,
          items: dd ? dd.querySelectorAll("button").length : 0,
          scrolls: dd ? dd.scrollHeight > dd.clientHeight + 2 : false,
          /* The DISTANCE to the next name, not its position: what went wrong
             was ~2000px of Layer's items between it and Select. */
          gap: Math.round(next.getBoundingClientRect().top - tops[i].getBoundingClientRect().top),
        };
      }, label);
      if (m.screens > worst.screens) worst = { label, screens: m.screens };
      if (Math.abs(m.gap) > 844) far.push(`${label}: ${m.gap}px`);
      if (m.items >= 40) longest = { label, items: m.items, scrolls: m.scrolls };
      await tap(label);
      await app.settle(200);
    }
    expect(worst.screens, `no menu turns the sheet into a scroll marathon (worst: ${worst.label})`).toBeLessThanOrEqual(1.5);
    expect(far, "an open menu never pushes its neighbour more than a screen away").toEqual([]);
    expect(longest, "the longest menu is there").not.toBeNull();
    expect(longest!.scrolls, `${longest!.label} (${longest!.items} items) scrolls inside the sheet`).toBe(true);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("the search pill names itself and its shortcut, with no phone sheet", async ({ app }) => {
    const pill = await app.page.evaluate(() => {
      const el = document.querySelector('button[aria-label="Open the command palette"]');
      return el ? el.textContent!.replace(/\s+/g, " ").trim() : null;
    });
    expect(pill, "the hint and the Ctrl+K chip").toMatch(/Search tools.*Ctrl\+K/);
    expect(
      await app.page.evaluate(() => ({
        searchRow: !!document.querySelector("[data-sheet-search]"),
        hamburger: !!document.querySelector('header button[aria-label="Menu"]'),
      })),
    ).toEqual({ searchRow: false, hamburger: false });
  });

  test("the Layer menu shows all of itself inside the window, without scrolling", async ({ app }) => {
    /* 3.0: a long menu opens as titled columns, capped to the window. Clicked
       and read in separate steps: read in the same tick, React had not
       rendered it, which read as "fine" for any menu. */
    await app.page.locator("[data-menubar]").getByRole("button", { name: "Layer", exact: true }).click();
    const menu = app.page.locator('[data-menubar] [role="menu"]');
    await expect(menu).toHaveCount(1);
    await app.still('[data-menubar] [role="menu"]');
    const m = await menu.evaluate((dd) => {
      const r = dd.getBoundingClientRect();
      const items = [...dd.querySelectorAll("button")];
      return {
        items: items.length,
        bottom: r.bottom,
        right: r.right,
        scrolls: dd.scrollHeight > dd.clientHeight + 2,
        hidden: items.filter((b) => b.getBoundingClientRect().bottom > innerHeight).length,
      };
    });
    expect(m.items, "every Layer command").toBeGreaterThanOrEqual(40);
    expect(m.bottom <= 900 && m.right <= 1400, "inside the window").toBe(true);
    expect(m.hidden, "no item below the bottom of the window").toBe(0);
  });
});
