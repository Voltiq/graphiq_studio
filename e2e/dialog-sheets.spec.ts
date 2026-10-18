/**
 * Every dialog is a usable full-screen sheet on a phone.
 * (Ported from tools/verify-dialog-sheets.js — there one 207 s walk; here
 * independent tests, one per menu, that run in parallel.)
 *
 * Measured when this was built: at 390×844 every dialog was 358px of 390, and
 * 22 had `overflow: hidden` with no `max-height`, so a tall one clipped instead
 * of scrolling. On a SHORT phone (375×667) Export's header sat at top = -74 and
 * `elementFromPoint` on its Export button returned nothing — it could not be
 * pressed. So the walk runs at 390×844, the tall dialogs again at 375×667, and
 * again with a 300px keyboard up.
 */
import { test, expect, PHONE, SHORT_PHONE, type App } from "./fixtures";
import type { Page } from "@playwright/test";

/** The menu bar, in order. A test below fails if the app grows a menu this list
 *  does not know, so a new menu cannot quietly go unchecked. */
const MENUS = ["File", "Edit", "Image", "Layer", "Select", "Effects", "View", "Window", "Settings", "Help"];
/* Rows whose label ends in "…" but that open no dialog here, and why. The old
   rail skipped ANY row that produced nothing, so a dialog that silently stopped
   opening read as a skip. Naming them makes both directions fail loudly. */
const NOT_DIALOGS = new Map([
  ["File ▸ Open", "a file picker"],
  ["File ▸ Import", "a file picker"],
  ["File ▸ Export PSD (layered)", "downloads directly"],
  ["File ▸ Export SVG (vector layers)", "downloads directly"],
  ["File ▸ Export frames (zip)", "downloads directly"],
  ["File ▸ Export HDR PNG", "a toast: no HDR source in a fresh document"],
  ["Image ▸ HDR tone mapping", "a toast: no HDR source in a fresh document"],
  ["Layer ▸ Adjustment: color lookup (.cube)", "a file picker for the LUT"],
  ["Select ▸ Refine edge", "needs a selection; a fresh document has none"],
]);
const KB = 300;
/* The tall ones, for the short-phone and keyboard passes: a short dialog cannot
   demonstrate a clipped footer. */
const TALL: [string, string][] = [
  ["File", "Export as"],
  ["File", "Merge to HDR"],
  ["File", "Batch process"],
  ["Settings", "Color management"],
  ["Image", "Adjust: curves"],
];

interface Measure {
  label: string;
  w: number;
  h: number;
  top: number;
  bottom: number;
  vw: number;
  visible: number;
  hasHeader: boolean;
  hasFooter: boolean;
  footBottom: number | null;
  primary: string | null;
  reaches: string;
  middleScrolls: boolean;
  /** On a full-screen backdrop — what DialogFocus treats as modal — without
   *  saying so: assistive tech then reads the blocked page as reachable. */
  undeclaredModal: boolean;
}

/** Geometry of the open dialog, plus whether its primary action can be pressed. */
const measure = (page: Page) =>
  page.evaluate((): Measure | null => {
    const d = document.querySelector('[role="dialog"]');
    if (!d) return null;
    const r = d.getBoundingClientRect();
    const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0;
    const foot = d.querySelector("footer");
    // The primary action is the last footer button (this codebase's convention).
    const primary = [...(foot ?? d).querySelectorAll("button")].pop();
    const pr = primary?.getBoundingClientRect();
    let reaches = "none";
    if (primary && pr && pr.width > 0) {
      const el = document.elementFromPoint(Math.round(pr.x + pr.width / 2), Math.round(pr.y + pr.height / 2));
      reaches = el && primary.contains(el) ? "itself" : el ? el.tagName.toLowerCase() : "nothing";
    }
    const middle = [...d.children].filter((c) => !["HEADER", "FOOTER"].includes(c.tagName));
    return {
      label: d.getAttribute("aria-label") || d.querySelector("h2")?.textContent?.trim() || "?",
      w: Math.round(r.width),
      h: Math.round(r.height),
      top: Math.round(r.top),
      bottom: Math.round(r.bottom),
      vw: window.innerWidth,
      visible: Math.round(window.innerHeight - kb),
      hasHeader: !!d.querySelector(":scope > header"),
      hasFooter: !!foot,
      footBottom: foot ? Math.round(foot.getBoundingClientRect().bottom) : null,
      primary: primary ? (primary.textContent ?? "").trim().slice(0, 20) : null,
      reaches,
      middleScrolls: middle.some((c) => c.scrollHeight > c.clientHeight + 2),
      undeclaredModal:
        /overlay/i.test(d.parentElement?.className || "") && d.getAttribute("aria-modal") !== "true",
    };
  });

/** What is wrong with a dialog, in the item's own terms. */
function faultsOf(m: Measure): string[] {
  const f: string[] = [];
  if (m.w !== m.vw) f.push(`width ${m.w} of ${m.vw}`);
  if (m.top < 0) f.push(`top ${m.top}`);
  if (m.bottom > m.visible) f.push(`bottom ${m.bottom} > ${m.visible}`);
  if (m.reaches !== "itself") f.push(`primary "${m.primary}" reaches ${m.reaches}`);
  if (!m.hasHeader) f.push("no title bar");
  if (m.undeclaredModal) f.push("blocks the page but is not aria-modal");
  if (m.hasFooter && m.footBottom! > m.visible) f.push(`footer ends ${m.footBottom} > ${m.visible}`);
  return f;
}

const MENU_BUTTONS = "[data-menubar] > div > button";

/** The phone's menu lives in a sheet behind the header's Menu button. */
async function openSheet(page: Page) {
  if (await page.locator('[data-menubar][data-sheet="true"]').count()) return;
  await page.locator("header button[aria-label='Menu' i]").first().click();
  await page.waitForSelector('[data-menubar][data-sheet="true"]', { timeout: 6000 });
  await page.waitForTimeout(300);
}

async function closeSheet(page: Page) {
  if (await page.locator('[data-menubar][data-sheet="true"]').count()) {
    await page.locator("header button[aria-label='Menu' i]").first().click();
    await page.waitForTimeout(300);
  }
}

/** Make `menu` the active one. Clicking a menu name TOGGLES, so state is asserted
 *  rather than assumed — the old walk once reported "Curves will not open" when
 *  the Layer menu had simply been left open. */
async function activate(page: Page, menu: string) {
  for (let i = 0; i < 2; i++) {
    await page.evaluate(
      ([sel, l]) => [...document.querySelectorAll<HTMLButtonElement>(sel)].find((x) => x.textContent?.trim() === l)?.click(),
      [MENU_BUTTONS, menu] as const,
    );
    await page.waitForTimeout(350);
    const active = await page.evaluate(
      (sel) => [...document.querySelectorAll(sel)].find((x) => x.getAttribute("data-active") === "true")?.textContent?.trim(),
      MENU_BUTTONS,
    );
    if (active === menu) return;
  }
  throw new Error(`could not open the ${menu} menu`);
}

/** The enabled rows of `menu` that open a dialog (their label ends in "…"). */
async function dialogRows(page: Page, menu: string): Promise<string[]> {
  await openSheet(page);
  await activate(page, menu);
  const items = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLButtonElement>('[data-menubar] [role="menu"] button')]
      .filter((x) => !x.disabled)
      .map((x) => (x.querySelector("span")?.textContent ?? x.textContent ?? "").trim())
      .filter((label) => /…\s*$/.test(label))
      .map((label) => label.replace(/…\s*$/, "")),
  );
  await closeSheet(page);
  return items;
}

/** Open one row from a CLOSED sheet and measure the dialog it produced. */
async function openDialog(page: Page, menu: string, item: string): Promise<Measure | null> {
  await closeSheet(page);
  await openSheet(page);
  await activate(page, menu);
  const row = page.locator('[data-menubar] [role="menu"] button', { hasText: item }).first();
  if (!(await row.count())) return null;
  await row.scrollIntoViewIfNeeded().catch(() => {});
  await row.click().catch(() => {});
  await page.waitForTimeout(900);
  return measure(page);
}

/** Close the dialog and WAIT until it is gone (some ignore Escape; Close is the
 *  second attempt, and absence is the condition, not a timeout). */
async function closeDialog(page: Page): Promise<boolean> {
  for (let i = 0; i < 4; i++) {
    if (!(await page.locator('[role="dialog"]').count())) return true;
    if (i % 2 === 0) await page.keyboard.press("Escape");
    else await page.locator('[role="dialog"] button[aria-label="Close"]').first().click().catch(() => {});
    await page.waitForTimeout(450);
  }
  return !(await page.locator('[role="dialog"]').count());
}

/** A layer to act on, so layer dialogs are enabled (as the old rail did). */
async function withLayer(app: App) {
  await app.page.keyboard.press("Control+Shift+N");
  await app.settle(1100);
}

test.describe("phone 390×844", () => {
  test.use(PHONE);

  test("the menu bar is the one this file walks", async ({ app }) => {
    await openSheet(app.page);
    const menus = await app.page.evaluate(
      (sel) =>
        [...document.querySelectorAll(sel)]
          .filter((x) => !x.hasAttribute("data-sheet-search"))
          .map((x) => x.textContent?.trim()),
      MENU_BUTTONS,
    );
    expect(menus).toEqual(MENUS);
  });

  test("the menus offer a serious number of dialogs to check", async ({ app }) => {
    await withLayer(app);
    let n = 0;
    for (const m of MENUS) n += (await dialogRows(app.page, m)).length;
    expect(n).toBeGreaterThanOrEqual(40);
  });

  for (const menu of MENUS) {
    test(`${menu}: every dialog opens as a full-screen sheet, and closes`, async ({ app }) => {
      await withLayer(app);
      const rows = await dialogRows(app.page, menu);
      // A menu with no "…" rows proves nothing here — report a skip, not a pass.
      test.skip(rows.length === 0, `${menu} has no dialog-opening rows`);
      for (const item of rows) {
        const name = `${menu} ▸ ${item}`;
        const m = await openDialog(app.page, menu, item);
        if (NOT_DIALOGS.has(name)) {
          expect.soft(m, `${name} opens no dialog (${NOT_DIALOGS.get(name)}) — if it does now, check it here`).toBeNull();
        } else {
          expect.soft(m, `${name} opens a dialog`).not.toBeNull();
          if (m) expect.soft(faultsOf(m), `${name} at 390×844`).toEqual([]);
        }
        expect.soft(await closeDialog(app.page), `${menu} ▸ ${item} can be dismissed again`).toBe(true);
      }
      expect.soft(app.consoleErrors, "no console errors").toEqual([]);
    });
  }

  for (const [menu, item] of TALL) {
    test(`${item}: usable under a ${KB}px keyboard`, async ({ app }) => {
      await withLayer(app);
      expect(await openDialog(app.page, menu, item), "it opens").not.toBeNull();
      await app.page.evaluate((px) => document.documentElement.style.setProperty("--kb-inset", `${px}px`), KB);
      await app.settle(500);
      expect(faultsOf((await measure(app.page))!)).toEqual([]);
    });
  }

  /* `:has(> header)` scopes the sheet rule. The palette wears role="dialog" with
     no title bar, so it must NOT be dressed as a sheet. */
  test("the command palette is not dressed as a dialog sheet", async ({ app }) => {
    await app.page.locator('button[aria-label="Open the command palette"]').click();
    await app.settle(700);
    const pal = await app.page.evaluate(() => {
      const d = document.querySelector('[role="dialog"][aria-label="Command palette"]');
      if (!d) return null;
      const r = d.getBoundingClientRect();
      return { w: Math.round(r.width), top: Math.round(r.top), vw: window.innerWidth, hasHeader: !!d.querySelector(":scope > header") };
    });
    expect(pal, "the palette opened").not.toBeNull();
    expect(pal!.hasHeader).toBe(false);
    expect(pal!.w < pal!.vw || pal!.top > 0, `${pal!.w}px of ${pal!.vw} at top ${pal!.top}`).toBe(true);
  });
});

test.describe("short phone 375×667, where it bit", () => {
  test.use(SHORT_PHONE);

  for (const [menu, item] of TALL) {
    test(`${item}: fits a short phone`, async ({ app }) => {
      await withLayer(app);
      const m = await openDialog(app.page, menu, item);
      expect(m, "it opens").not.toBeNull();
      expect(faultsOf(m!)).toEqual([]);
      /* Non-vacuity: Export is the dialog that did not fit (816px in 667), so it
         must fit by SCROLLING its contents — else the check is about dialogs
         that always fit. */
      if (item === "Export as") expect(m!.middleScrolls, "Export scrolls internally").toBe(true);
    });
  }
});

test("a desktop keeps its centred, self-sized dialogs", async ({ app }) => {
  await withLayer(app);
  for (const [menu, item] of [["File", "Export as"], ["Settings", "Preferences"], ["Select", "Feather"]] as const) {
    await app.page.locator(MENU_BUTTONS, { hasText: menu }).first().click();
    await app.settle(350);
    await app.page.locator('[data-menubar] [role="menu"] button', { hasText: item }).first().click();
    await app.settle(900);
    const m = await measure(app.page);
    expect.soft(m, `${menu} ▸ ${item} opens`).not.toBeNull();
    if (m) expect.soft(m.w === m.vw || m.top === 0, `${item}: ${m.w}×${m.h} at top ${m.top}`).toBe(false);
    await closeDialog(app.page);
  }
});
