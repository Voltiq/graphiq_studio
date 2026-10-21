/**
 * Tool options a phone can reach: the options card.
 * (Ported from tools/verify-options-sheet.js, TODO 2.1. The card's grip, fold
 * and remembered height are e2e/phone-shell.spec.ts.)
 *
 * Measured at 390px before any of this: all 29 tools overflowed the options
 * bar — a 25–127px window over up to 1982px of widgets — and with Crop active
 * Apply sat 1400px off the right, so a crop could not be committed by any
 * gesture. Since 3.0 the options are a card on the foot of the stage: the tool
 * named in its header, any action that would lose work pinned beside it, the
 * controls in rows of a 70px label, a track and a 52px value.
 *
 * The two ways this fails: the card overflows instead of the bar (the same
 * bug one layer down — measured for every tool), or the controls become
 * decorative (so a slider is dragged by a finger and read back, and the
 * pinned Apply commits a real crop).
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const pickTool = async (app: App, id: string) => {
  const { page } = app;
  await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().tap();
  await expect(page.locator("html")).toHaveAttribute("data-drawer", "tools");
  const tile = page.locator(`[data-tour="toolbar"] button[data-tool="${id}"]`);
  await tile.scrollIntoViewIfNeeded();
  await tile.tap();
  await expect(page.locator("html")).not.toHaveAttribute("data-drawer", /.+/);
  await app.settle(300);
};

/** How far the card's contents run past its sides. */
const cardFit = (app: App) =>
  app.page.evaluate(() => {
    const card = document.querySelector('[data-tour="options"]')!;
    const body = card.querySelector("[data-options-sheet] [class*='sheetBody']");
    const head = card.querySelector("[class*='cardHead']")!;
    const cr = card.getBoundingClientRect();
    const out = [...card.querySelectorAll("*")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.right > cr.right + 1 || r.left < cr.left - 1);
    });
    return {
      body: body ? body.scrollWidth - body.clientWidth : null,
      head: head.scrollWidth - head.clientWidth,
      outside: out.map((e) => e.getAttribute("aria-label") ?? e.tagName.toLowerCase()).slice(0, 4),
    };
  });

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("no tool's options run off the side of the card", async ({ app }) => {
    test.slow(); // twenty-nine tools, each picked from the sheet
    await app.run("layer-new");
    const ids = await app.page.evaluate(() =>
      [...document.querySelectorAll('[data-tour="toolbar"] button[data-tool]')].map((b) => b.getAttribute("data-tool")!),
    );
    expect(ids.length, "every tool is there to check").toBe(29);
    const over: string[] = [];
    for (const id of ids) {
      await pickTool(app, id);
      const f = await cardFit(app);
      if (f.body === null || f.body > 0 || f.head > 0 || f.outside.length)
        over.push(`${id}: body ${f.body}, head ${f.head}, outside [${f.outside.join(", ")}]`);
    }
    expect(over, "every tool's controls fit the card").toEqual([]);
  });

  test("with Crop, Apply is pinned beside the tool, a finger's size, and commits the crop", async ({ app }) => {
    const { page } = app;
    await app.run("layer-new");
    await pickTool(app, "crop");
    const apply = page.locator('[data-pin="commit"]');
    const a = (await apply.boundingBox())!;
    expect(a.x >= 0 && a.x + a.width <= 390, `Apply is on screen: ${JSON.stringify(a)}`).toBe(true);
    expect(a.width, "...at a size a finger can hit").toBeGreaterThanOrEqual(44);

    const size = () =>
      page.evaluate(() => {
        const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
        return `${c.width}×${c.height}`;
      });
    const before = await size();
    /* Crop lays its box over the WHOLE document: a drag inside it moves it
       (clamped back), so the corner is what shrinks it. The box is the part of
       the overlay the crop shade leaves clear. */
    const corner = await page.evaluate(() => {
      const ov = [...document.querySelectorAll<HTMLCanvasElement>('[data-tour="canvas"] canvas')]
        .filter((c) => !c.hasAttribute("data-loupe"))
        .pop()!;
      const d = ov.getContext("2d", { willReadFrequently: true })!.getImageData(0, 0, ov.width, ov.height).data;
      let x0 = 1e9;
      let y0 = 1e9;
      for (let y = 0; y < ov.height; y++)
        for (let x = 0; x < ov.width; x++) {
          if (d[(y * ov.width + x) * 4 + 3] > 100) continue;
          if (y < y0 || (y === y0 && x < x0)) {
            x0 = x;
            y0 = y;
          }
        }
      const r = ov.getBoundingClientRect();
      const dpr = ov.width / r.width;
      return x0 > 1e8 ? null : { x: r.left + x0 / dpr, y: r.top + y0 / dpr };
    });
    expect(corner, "a crop box is on screen").not.toBeNull();
    await app.touchDown(corner!.x + 2, corner!.y + 2);
    await app.touchMove(corner!.x + 40, corner!.y + 32, 8);
    await app.touchUp();
    await app.settle(600);
    await apply.tap();
    await expect.poll(size, { message: "the pinned Apply commits the crop" }).not.toBe(before);
  });

  test("a slider in the card answers a finger", async ({ app }) => {
    await app.run("layer-new");
    await app.key("b");
    const sizeInput = app.page.locator('[data-options-sheet] input[type="range"][aria-label="Size"]');
    const b = (await sizeInput.boundingBox())!;
    expect(b.width, "the Size track is a real length").toBeGreaterThan(150);
    const before = await sizeInput.inputValue();
    const y = Math.round(b.y + b.height / 2);
    await app.touchDown(Math.round(b.x + b.width / 2), y);
    await app.touchMove(Math.round(b.x + b.width / 2 + 60), y, 8);
    await app.touchUp();
    await expect.poll(() => sizeInput.inputValue(), { message: "dragging it changes the brush size" }).not.toBe(before);
  });

  test("the card is laid out as a column: one start for every control, flat dividers, one row per slider", async ({ app }) => {
    await app.key("b");
    const l = await app.page.evaluate(() => {
      const body = document.querySelector("[data-options-sheet] [class*='sheetBody']")!;
      const kids = [...body.children];
      /* Where the control beside each label begins. One column = one number. */
      const starts = kids
        .map((c) => {
          const next = c.querySelector(":scope > [class*='label']")?.nextElementSibling;
          return next ? Math.round(next.getBoundingClientRect().x) : null;
        })
        .filter((x): x is number => x !== null && x > 0);
      const tracks = [...body.querySelectorAll("input[type=range]")].map((e) => Math.round(e.getBoundingClientRect().x));
      return {
        columns: [...new Set([...starts, ...tracks])],
        dividers: kids
          .filter((c) => /divider/.test(c.className))
          .map((c) => ({ w: Math.round(c.getBoundingClientRect().width), h: Math.round(c.getBoundingClientRect().height) })),
        sliderRows: [...body.querySelectorAll("[class*='slider']")]
          .filter((e) => e.querySelector("input[type=range]"))
          .map((e) => Math.round(e.getBoundingClientRect().height)),
        trackHeights: [...body.querySelectorAll("input[type=range]")].map((e) => Math.round(e.getBoundingClientRect().height)),
      };
    });
    expect(l.columns, "every labelled control starts on the same column").toHaveLength(1);
    expect(l.dividers.length, "there are dividers").toBeGreaterThan(0);
    expect(l.dividers.filter((d) => d.h > 2 || d.w < 100), "...and they lie down").toEqual([]);
    expect(Math.max(...l.sliderRows), "a slider costs one row, not two").toBeLessThanOrEqual(52);
    expect(Math.min(...l.trackHeights), "...without giving up the 44px a finger needs").toBeGreaterThanOrEqual(44);
    const keys = await app.page.evaluate(() =>
      [...document.querySelectorAll('[data-tour="options"] [aria-label="Keyboard modifiers"] button')].map((c) => {
        const r = c.getBoundingClientRect();
        return Math.round(Math.min(r.width, r.height));
      }),
    );
    expect(keys, "Shift, Alt and Ctrl, each a 44px key").toHaveLength(3);
    expect(Math.min(...keys)).toBeGreaterThanOrEqual(44);
  });

  test("the header names the tool in hand, and its name gives way on a narrow phone", async ({ app }) => {
    const { page } = app;
    const head = page.locator("[data-options-open]");
    const read = () =>
      head.evaluate((el) => ({
        text: el.querySelector("[class*='toggleName']")?.textContent?.trim() ?? "",
        label: el.getAttribute("aria-label") ?? "",
      }));
    await app.key("b");
    expect(await read(), "named for the tool, and says what it opens").toEqual({ text: "Brush", label: "Brush options" });
    await app.key("m");
    expect((await read()).text, "...and follows the tool").toBe("Rectangular marquee");

    /* The longest name on the narrowest phone worth supporting: the name
       gives way, nothing else on the row does. */
    await page.setViewportSize({ width: 320, height: 568 });
    await app.settle(700);
    const tight = await page.evaluate(() => {
      const row = document.querySelector("[data-tour='options'] [class*='cardHead']")!;
      const t = document.querySelector("[data-options-open]")!.getBoundingClientRect();
      const r = row.getBoundingClientRect();
      return { clipped: t.right > r.right + 0.5 || t.left < r.left - 0.5, overflow: row.scrollWidth - row.clientWidth, h: t.height };
    });
    expect(tight, "the name shrinks instead of pushing the row off screen").toMatchObject({ clipped: false, overflow: 0 });
    expect(tight.h, "...still a 44px target").toBeGreaterThanOrEqual(44);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("the options stay the bar they always were", async ({ app }) => {
    const bar = await app.page.evaluate(() => {
      const el = document.querySelector('[data-tour="options"]')!;
      return {
        card: el.hasAttribute("data-mobile-options"),
        head: !!document.querySelector("[data-options-open]"),
        controls: el.querySelectorAll("button, input, select, [role='switch']").length,
      };
    });
    expect(bar.card || bar.head, "no phone card, no header toggle").toBe(false);
    expect(bar.controls, "the controls are inline").toBeGreaterThan(3);
  });
});
