/**
 * Popovers on a phone (3.3): a sheet from the dock, not a flyout.
 *
 * Reported: "the color picker and other popups like the pen pressure and the
 * tip shape popups are way too big and not designed for mobile". They were
 * the desktop flyouts, anchored under a trigger that on a phone sits in the
 * options card at the FOOT of the stage — measured at 390×844, Tip shape stood
 * 1007px tall from y=628, OpenType, Warp text and Type effects ran past the
 * bottom of the screen, and the colour popover was 721px tall.
 *
 * Now each one is a sheet between the header and the dock, the width of the
 * screen less the gutters, scrolling inside itself when it has more to show;
 * nothing in it runs out sideways; and a blanket behind it takes the tap that
 * closes it, so that tap does not land on the canvas as a dab of paint.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const dialog = (label: string) => `[role="dialog"][aria-label="${label}"]`;

/** Tap the trigger — or, when the options card has folded its controls away
 *  (a phone on its side), click it from script: where the sheet goes does not
 *  depend on where its trigger is. */
async function press(app: App, sel: string) {
  const t = app.page.locator(sel).first();
  await expect(t, `${sel} is there`).toHaveCount(1);
  if (await t.isVisible()) await t.tap();
  else await t.evaluate((el) => (el as HTMLElement).click());
}

const geometry = (app: App, sel: string) =>
  app.page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    const r = el.getBoundingClientRect();
    const dock = document.querySelector('[data-tour="mobilebar"]')!.getBoundingClientRect();
    return {
      left: r.left,
      top: r.top,
      right: r.right,
      bottom: r.bottom,
      vw: innerWidth,
      vh: innerHeight,
      dockTop: dock.top,
      // Sideways overflow: something inside wider than the sheet.
      sideways: el.scrollWidth - el.clientWidth,
      // Text past the sheet's content edge, into its padding or beyond — the
      // part a reader sees, so clipped by any box on the way that clips.
      textOut: (() => {
        const cs = getComputedStyle(el);
        const lo = r.left + el.clientLeft + parseFloat(cs.paddingLeft);
        const hi = r.left + el.clientLeft + el.clientWidth - parseFloat(cs.paddingRight);
        let worst = 0;
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          if (!n.textContent?.trim()) continue;
          const range = document.createRange();
          range.selectNodeContents(n);
          const t = range.getBoundingClientRect();
          if (!t.width) continue;
          let left = t.left;
          let right = t.right;
          for (let a = n.parentElement; a && a !== el; a = a.parentElement) {
            if (getComputedStyle(a).overflowX === "visible") continue;
            const b = a.getBoundingClientRect();
            left = Math.max(left, b.left);
            right = Math.min(right, b.right);
          }
          if (right <= left) continue;
          worst = Math.max(worst, right - hi, lo - left);
        }
        return Math.round(worst);
      })(),
      taller: el.scrollHeight - el.clientHeight,
      overflowY: getComputedStyle(el).overflowY,
    };
  }, sel);

type Popup = { name: string; tool: string; trigger: string; sheet: string; prep?: (app: App) => Promise<void> };

const POPUPS: Popup[] = [
  { name: "Pen pressure", tool: "b", trigger: 'button[aria-label="Pen pressure"]', sheet: dialog("Pen pressure") },
  { name: "Tip shape", tool: "b", trigger: 'button[aria-label="Tip shape"]', sheet: dialog("Tip shape") },
  { name: "Brush colour", tool: "b", trigger: 'button[aria-label="Brush color"]', sheet: dialog("Color picker") },
  { name: "Font", tool: "t", trigger: 'button[aria-label="Font"]', sheet: dialog("Fonts") },
  { name: "OpenType", tool: "t", trigger: '[data-tip^="OpenType"]', sheet: dialog("OpenType features") },
  { name: "Warp text", tool: "t", trigger: '[data-tip^="Warp text"]', sheet: dialog("Warp text") },
  { name: "Text fill", tool: "t", trigger: '[data-tip^="Text fill"]', sheet: dialog("Text fill") },
  { name: "Type effects", tool: "t", trigger: '[data-tip^="Type effects"]', sheet: dialog("Type effects") },
  {
    name: "Custom shapes",
    tool: "u",
    trigger: 'button[aria-label="Choose custom shape"]',
    sheet: dialog("Custom shapes"),
    prep: (app) => press(app, '[title="Custom shape"], [data-tip="Custom shape"]'),
  },
  {
    name: "Gradient",
    tool: "g",
    trigger: 'button[aria-label="Gradient colours"]',
    sheet: dialog("Gradient colours"),
    // G is the paint bucket first; Shift+G steps to the gradient.
    prep: async (app) => {
      if (!(await app.page.locator('button[aria-label="Gradient colours"]').count())) await app.key("Shift+G");
    },
  },
];

async function pickTool(app: App, key: string, prep?: (app: App) => Promise<void>) {
  await app.key(key);
  await app.settle(300);
  if (prep) {
    await prep(app);
    await app.settle(300);
  }
}

/** Open each popover, check it as a sheet, close it. Soft, so one run names
 *  every popover that misbehaves. */
async function walk(app: App, aboveDock: boolean) {
  await app.run("layer-new");
  for (const p of POPUPS) {
    await pickTool(app, p.tool, p.prep);
    await press(app, p.trigger);
    const sheet = app.page.locator(p.sheet);
    await expect(sheet, `${p.name}: open`).toHaveCount(1);
    await app.settle(700); // the spring has landed
    const g = await geometry(app, p.sheet);
    const at = `${p.name}: ${JSON.stringify(g)}`;
    expect.soft(g.left, `${at} — inside the left edge`).toBeGreaterThanOrEqual(0);
    expect.soft(g.right, `${at} — inside the right edge`).toBeLessThanOrEqual(g.vw);
    expect.soft(g.top, `${at} — inside the top`).toBeGreaterThanOrEqual(0);
    expect.soft(g.bottom, `${at} — inside the bottom`).toBeLessThanOrEqual(g.vh);
    if (aboveDock) expect.soft(g.bottom, `${at} — above the dock`).toBeLessThanOrEqual(g.dockTop);
    expect.soft(g.sideways, `${at} — nothing inside runs out sideways`).toBeLessThanOrEqual(0);
    expect.soft(g.textOut, `${at} — no text past the sheet's content edge`).toBeLessThanOrEqual(1);
    if (g.taller > 0) expect.soft(g.overflowY, `${at} — the rest is a scroll away`).toMatch(/auto|scroll/);
    await app.page.keyboard.press("Escape");
    await expect(sheet, `${p.name}: closed`).toHaveCount(0);
  }
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("every popover is a sheet between the header and the dock, nothing out of bounds", async ({ app }) => {
    await walk(app, true);
  });

  test("Tip shape shows a section's settings only while it is on — and scrolls when all are", async ({ app }) => {
    await app.run("layer-new");
    await pickTool(app, "b");
    await press(app, 'button[aria-label="Tip shape"]');
    const sheet = app.page.locator(dialog("Tip shape"));
    await expect(sheet).toHaveCount(1);
    const shown = (label: string) => sheet.getByRole("slider", { name: label, exact: true });
    await expect(shown("Roundness"), "the tip itself is always there").toHaveCount(1);
    await expect(shown("Amount"), "scatter off: no scatter settings").toHaveCount(0);
    await expect(shown("Depth"), "texture off: no texture settings").toHaveCount(0);
    await expect(shown("Hardness"), "dual tip off: no dual-tip settings").toHaveCount(0);
    // A track takes its row: capped at the options card's 104px it left half
    // the sheet empty beside the readout.
    const track = (await shown("Roundness").boundingBox())!;
    const box = (await sheet.boundingBox())!;
    expect(track.width, "the track takes the row").toBeGreaterThan(box.width / 2);
    for (const toggle of ["Scatter dabs", "Use texture", "Use dual tip"]) await sheet.getByRole("switch", { name: toggle }).tap();
    await expect(shown("Amount"), "scatter on").toHaveCount(1);
    await expect(shown("Depth"), "texture on").toHaveCount(1);
    await expect(shown("Hardness"), "dual tip on").toHaveCount(1);
    await app.settle(300);
    const g = await geometry(app, dialog("Tip shape"));
    expect(g.bottom, "all of it open still ends above the dock").toBeLessThanOrEqual(g.dockTop);
    expect(g.top, "...and starts on screen").toBeGreaterThanOrEqual(0);
    expect(g.taller, "longer than the sheet").toBeGreaterThan(0);
    // The last setting is reachable: scrolled to, it is inside the sheet.
    const last = shown("Count").last();
    await last.scrollIntoViewIfNeeded();
    const lb = (await last.boundingBox())!;
    expect(lb.y + lb.height, "the last setting scrolls into the sheet").toBeLessThanOrEqual(g.bottom);
  });

  test("the colour sheet brings one row of swatches, not the library", async ({ app }) => {
    await pickTool(app, "b");
    await press(app, 'button[aria-label="Brush color"]');
    const sheet = app.page.locator(dialog("Color picker"));
    await expect(sheet).toHaveCount(1);
    await expect(sheet.getByRole("button", { name: "Add the current colour to your swatches" })).toHaveCount(1);
    await expect(sheet.getByRole("group", { name: "Preset swatches" }), "no library grid").toHaveCount(0);
  });

  test("a tap beside a sheet closes it and paints nothing", async ({ app }) => {
    await app.run("layer-new");
    await pickTool(app, "b");
    const before = (await app.exported()).hash;
    for (const p of [POPUPS[0], POPUPS[2]]) {
      await press(app, p.trigger);
      const sheet = app.page.locator(p.sheet);
      await expect(sheet).toHaveCount(1);
      await app.settle(600);
      // Over the picture, above the sheet.
      const c = await app.canvasBox();
      const s = (await sheet.boundingBox())!;
      const x = Math.round(c.x + c.width / 2);
      const y = Math.round((Math.max(c.y, 80) + s.y) / 2);
      const hit = await app.page.evaluate(([x, y]) => {
        const el = document.elementFromPoint(x, y);
        if (!el || el.closest('[data-tour="canvas"]')) return "canvas";
        // ...and it is seen: the blanket dims what is behind the sheet.
        return getComputedStyle(el).backgroundColor === "rgba(0, 0, 0, 0)" ? "unseen" : "blanket";
      }, [x, y]);
      expect(hit, `${p.name}: the point beside the sheet is the blanket's`).toBe("blanket");
      await app.page.touchscreen.tap(x, y);
      await expect(sheet, `${p.name}: the tap closed it`).toHaveCount(0);
      await app.settle(300);
    }
    expect((await app.exported()).hash, "and drew nothing").toBe(before);
  });

  test("closing a gradient stop's colour sheet leaves the gradient sheet open", async ({ app }) => {
    await pickTool(app, "g", POPUPS[9].prep);
    await press(app, POPUPS[9].trigger);
    const gradient = app.page.locator(dialog("Gradient colours"));
    await expect(gradient).toHaveCount(1);
    await app.settle(600);
    await press(app, `${dialog("Gradient colours")} button[aria-haspopup="dialog"]`);
    const colour = app.page.locator(dialog("Color picker"));
    await expect(colour).toHaveCount(1);
    await app.settle(600);
    // The header is above both sheets, under the colour sheet's blanket.
    await app.page.touchscreen.tap(195, 30);
    await expect(colour, "the colour sheet closed").toHaveCount(0);
    await expect(gradient, "the gradient sheet did not").toHaveCount(1);
  });
});

test.describe("on an iPhone 13 mini", () => {
  test.use({ viewport: { width: 375, height: 629 }, hasTouch: true });

  test("every popover fits between the header and the dock", async ({ app }) => {
    await walk(app, true);
  });
});

test.describe("on a phone on its side", () => {
  test.use({ viewport: { width: 844, height: 390 }, hasTouch: true });

  test("every popover fits on screen, at a readable width", async ({ app }) => {
    await walk(app, false);
  });

  test("the colour sheet shows the whole picker without scrolling", async ({ app }) => {
    await pickTool(app, "b");
    await press(app, 'button[aria-label="Brush color"]');
    await expect(app.page.locator(dialog("Color picker"))).toHaveCount(1);
    await app.settle(700);
    const g = await geometry(app, dialog("Color picker"));
    expect(g.right - g.left, "not stretched across the whole width").toBeLessThanOrEqual(520);
    expect(g.taller, `nothing below the fold: ${JSON.stringify(g)}`).toBeLessThanOrEqual(0);
    expect(g.top, "its top on screen").toBeGreaterThanOrEqual(0);
    expect(g.bottom, "its foot on screen").toBeLessThanOrEqual(g.vh);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1440, height: 900 } });

  test("a popover still opens under its trigger", async ({ app }) => {
    await app.key("b");
    const trigger = app.page.locator('button[aria-label="Pen pressure"]');
    await trigger.click();
    const sheet = app.page.locator(dialog("Pen pressure"));
    await expect(sheet).toHaveCount(1);
    await app.settle(700);
    const t = (await trigger.boundingBox())!;
    const s = (await sheet.boundingBox())!;
    expect(Math.abs(s.y - (t.y + t.height + 6)), "6px under the trigger").toBeLessThanOrEqual(2);
    expect(s.width, "its own width, not the screen's").toBeLessThan(400);
  });
});
