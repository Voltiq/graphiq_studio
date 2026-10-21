/**
 * The software keyboard: what it covers, which one opens, and whether it
 * opens at all. (Ported from tools/verify-keyboard.js and
 * tools/verify-keyboard-fields.js, TODO 2.1.)
 *
 * Measured at 390×844 with a 300px keyboard, before: focusing Export's last
 * field left it 185px BELOW the keyboard, and the dock sat 300px behind it —
 * the phone's only route to tools and panels. And across ten dialogs: 6
 * opened with the keyboard already up (focus landed on a text field), numeric
 * fields offered QWERTY, and 7 had 12–14px fields, which makes iOS zoom — in
 * an app that can never zoom back (`user-scalable=no`, the canvas owns pinch).
 *
 * A test cannot summon a keyboard (it shrinks the VISUAL viewport, which
 * nothing here drives), so the halves are checked honestly: `--kb-inset` is
 * written by hand for the CSS, `__gqKeepFocusVisible` is called for the
 * scrolling, and a visualViewport resize proves the listener is bound.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const KB = 300;
const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
const TYPEABLE =
  'input:not([type="range"]):not([type="checkbox"]):not([type="radio"]):not([type="color"]):not([type="file"]), textarea';

async function openDialog(app: App, menu: string, item: string) {
  const { page } = app;
  const menuButton = page.locator('header button[aria-label="Menu"]');
  if (await menuButton.isVisible().catch(() => false)) {
    await menuButton.click();
    await page.waitForSelector('[data-menubar][data-sheet="true"]');
  }
  await page.locator("[data-menubar] > div > button", { hasText: new RegExp(`^${menu}$`) }).first().click();
  const row = page.locator('[data-menubar] [role="menu"] button', { hasText: item }).first();
  await row.scrollIntoViewIfNeeded();
  await row.click();
  await page.waitForSelector('[role="dialog"]');
  /* Long enough for a dialog that focuses itself on a timer (Canvas Size,
     30ms) to have done it — read sooner, the central decision still stands. */
  await app.settle(1000);
}
async function closeDialogs(app: App) {
  for (let i = 0; i < 4 && (await app.page.locator('[role="dialog"]').count()); i++) {
    if (i % 2) await app.page.evaluate(() => document.querySelector<HTMLButtonElement>('[role="dialog"] button[aria-label="Close"]')?.click());
    else await app.page.keyboard.press("Escape");
    await app.settle(350);
  }
}
const keyboardLine = (app: App) =>
  app.page.evaluate(() => innerHeight - (parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0));
const barBottom = (app: App) =>
  app.page.evaluate(() => Math.round(document.querySelector('[data-tour="mobilebar"]')!.getBoundingClientRect().bottom));

test.describe("on a phone", () => {
  test.use(PHONE);

  test("the page asks to be resized for the keyboard, and follows it", async ({ app }) => {
    const meta = await app.page.evaluate(() => document.querySelector('meta[name="viewport"]')?.getAttribute("content") ?? "");
    expect(meta, "the viewport asks the browser to resize for the keyboard").toMatch(/interactive-widget=resizes-content/);
    /* The value does not matter, only that a resize event reaches a listener —
       the half `__gqKeepFocusVisible` being callable cannot show. */
    const after = await app.page.evaluate(
      () =>
        new Promise<string>((done) => {
          const root = document.documentElement;
          root.style.setProperty("--kb-inset", "999px");
          window.visualViewport!.dispatchEvent(new Event("resize"));
          setTimeout(() => done(getComputedStyle(root).getPropertyValue("--kb-inset").trim()), 200);
        }),
    );
    expect(after, "a visualViewport resize recomputes --kb-inset").not.toBe("999px");
  });

  test("the dock rides above the keyboard, and a focused field is scrolled above it — by the least needed", async ({ app }) => {
    const { page } = app;
    await app.run("layer-new");
    await page.evaluate(() => document.documentElement.style.removeProperty("--kb-inset"));
    expect(await barBottom(app), "with no keyboard the dock sits on the bottom").toBe(844);
    await page.evaluate((px) => document.documentElement.style.setProperty("--kb-inset", `${px}px`), KB);
    await app.settle(400);
    expect(await barBottom(app), `with a ${KB}px keyboard the dock's bottom is the visible bottom`).toBe(844 - KB);
    await page.evaluate(() => document.documentElement.style.removeProperty("--kb-inset"));

    await openDialog(app, "File", "Export as");
    const fields = await page.evaluate(() => {
      const d = document.querySelector('[role="dialog"]')!;
      const all = [...d.querySelectorAll<HTMLElement>('input:not([type="range"]), select')];
      all.at(-1)?.focus();
      return all.length;
    });
    expect(fields, "Export has fields to focus").toBeGreaterThanOrEqual(2);
    await page.evaluate((px) => document.documentElement.style.setProperty("--kb-inset", `${px}px`), KB);
    await app.settle(400);
    const activeBottom = () => page.evaluate(() => Math.round(document.activeElement!.getBoundingClientRect().bottom));
    /* Non-vacuity: the field has to START behind the keyboard. */
    expect(await activeBottom(), "the keyboard covers the last field to begin with").toBeGreaterThan(await keyboardLine(app));
    await page.evaluate((px) => (window as unknown as { __gqKeepFocusVisible: (n: number) => void }).__gqKeepFocusVisible(px), KB);
    await app.settle(400);
    expect(await activeBottom(), "...and it is scrolled above it").toBeLessThan(await keyboardLine(app));
    expect(await barBottom(app), "the dock is still above the keyboard with a dialog open").toBe(844 - KB);

    /* Minimum movement, asked of a field with room to move: repeating the call
       on the last field proves nothing (the scroller is at its end, so an
       over-scroll of a fixed 40px is clamped to zero — a mutation survived
       exactly that). */
    const idle = await page.evaluate((px) => {
      const first = document.querySelector('[role="dialog"]')!.querySelector<HTMLElement>('input:not([type="range"]), select')!;
      first.focus();
      let scroller: HTMLElement | null = null;
      for (let n = first.parentElement; n && !scroller; n = n.parentElement) {
        const oy = getComputedStyle(n).overflowY;
        if ((oy === "auto" || oy === "scroll") && n.scrollHeight > n.clientHeight + 1) scroller = n;
      }
      const top = first.getBoundingClientRect().top;
      const visible = first.getBoundingClientRect().bottom < innerHeight - px;
      (window as unknown as { __gqKeepFocusVisible: (n: number) => void }).__gqKeepFocusVisible(px);
      return {
        visible,
        room: scroller ? Math.round(scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop) : 0,
        moved: Math.round(first.getBoundingClientRect().top - top),
      };
    }, KB);
    expect(idle.visible && idle.room > 40, `a visible first field with room to move (${idle.room}px)`).toBe(true);
    expect(idle.moved, "...is left where it is").toBe(0);
  });

  test("dialogs do not raise the keyboard, iOS has nothing to zoom, numbers get a keypad", async ({ app }) => {
    test.slow(); // ten dialogs
    await app.run("layer-new");
    const DIALOGS = [
      ["File", "New"],
      ["File", "Export as"],
      ["File", "Save as"],
      ["File", "Export PDF"],
      ["Image", "Image size"],
      ["Image", "Canvas size"],
      ["Select", "Feather"],
      ["Layer", "New fill: solid color"],
      ["View", "New guide"],
      ["Settings", "Preferences"],
    ] as const;
    const grabbed: string[] = [];
    const small: string[] = [];
    const qwerty: string[] = [];
    let withFields = 0;
    let numeric = 0;
    for (const [menu, item] of DIALOGS) {
      await openDialog(app, menu, item);
      const m = await app.page.evaluate((typeable) => {
        const d = document.querySelector('[role="dialog"]')!;
        const fields = [...d.querySelectorAll(typeable)];
        return {
          fields: fields.length,
          focused: fields.includes(document.activeElement!),
          /* Under 16px is what makes iOS zoom. */
          small: [...new Set(fields.map((e) => Math.round(parseFloat(getComputedStyle(e).fontSize))).filter((px) => px < 16))],
          /* Fields that TAKE a number say so (`data-numeric`); reading the
             numBox wrapper once called New's Name field numeric. */
          numeric: [...d.querySelectorAll('input[type="number"], input[data-numeric]')].map((e) => ({
            type: (e.getAttribute("type") || "text").toLowerCase(),
            mode: (e.getAttribute("inputmode") || "").toLowerCase(),
          })),
        };
      }, TYPEABLE);
      if (m.fields) withFields++;
      if (m.focused) grabbed.push(item);
      if (m.small.length) small.push(`${item}: ${m.small.join(",")}px`);
      numeric += m.numeric.length;
      for (const f of m.numeric)
        if (f.type !== "number" && !["numeric", "decimal"].includes(f.mode)) qwerty.push(`${item}: type=${f.type} inputmode=${f.mode || "-"}`);
      await closeDialogs(app);
    }
    expect(withFields, "enough of them have fields to mean something").toBeGreaterThanOrEqual(6);
    expect(grabbed, "no dialog opens with the keyboard up (it was 6 of 10)").toEqual([]);
    expect(small, "no typeable field under 16px").toEqual([]);
    expect(numeric, "there are numeric fields to check").toBeGreaterThan(0);
    expect(qwerty, "every numeric field asks for a numeric keyboard").toEqual([]);

    /* The other home of NumberField: the Text tool's options (Size, Tracking,
       Baseline). With the brush there are none, and the check passed on an
       empty list once. */
    await app.key("t");
    const bar = await app.page.evaluate(() =>
      [...document.querySelectorAll('[data-tour="options"] input[type="number"], [data-tour="options"] input[data-numeric]')].map((e) => ({
        type: (e.getAttribute("type") || "text").toLowerCase(),
        mode: (e.getAttribute("inputmode") || "").toLowerCase(),
      })),
    );
    expect(bar.length, "the Text tool has numeric options").toBeGreaterThanOrEqual(3);
    expect(bar.filter((f) => f.type !== "number" && !["numeric", "decimal"].includes(f.mode)), "...each with a keypad").toEqual([]);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("a mouse still lands on the text field, and keeps its smaller fields", async ({ app }) => {
    /* Typing straight away costs a mouse nothing; and the 16px floor exists
       for iOS, so it must be touch-only. */
    await app.run("layer-new");
    const focus: string[] = [];
    const small: string[] = [];
    for (const [menu, item] of [
      ["File", "Save as"],
      ["File", "Export as"],
      ["Image", "Canvas size"],
    ] as const) {
      await openDialog(app, menu, item);
      const m = await app.page.evaluate((typeable) => {
        const d = document.querySelector('[role="dialog"]')!;
        const fields = [...d.querySelectorAll(typeable)];
        return {
          focused: fields.includes(document.activeElement!),
          small: fields.some((e) => parseFloat(getComputedStyle(e).fontSize) < 16),
        };
      }, TYPEABLE);
      if (!m.focused) focus.push(item);
      if (m.small) small.push(item);
      await closeDialogs(app);
    }
    expect(focus, "every one lands on its text field").toEqual([]);
    expect(small.length, "smaller fields remain on a desktop").toBeGreaterThan(0);
  });
});
