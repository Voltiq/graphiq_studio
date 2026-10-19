/**
 * Every control a finger can reach is a 44×44 target. (Ported from tools/verify-hit-targets.js, TODO 2.1.)
 *
 * The mobile stylesheet once enlarged exactly one family (the toolbar's tool
 * buttons) and left the rest at mouse size: 20px steppers, 24px carets, 27px
 * zoom and tab buttons, 30px selects, a 15px swap. A sweep found 24 kinds under
 * 44×44, the smallest box a fingertip reliably lands on.
 *
 * The sweep is run over SURFACES, each scrolled end to end, because one reading
 * at the top of a 1500px dock declares victory over whatever is visible. Three
 * guards stop it passing on nothing:
 *   - a floor on how many controls were measured on each surface — "zero boxes
 *     under 44px" is exactly what a broken selector or a drawer that never
 *     opened would report;
 *   - reachability: a box that measures 44px under something else is not a
 *     target, so each control's centre is hit-tested (against clipping
 *     scrollers too);
 *   - the rows a 44px floor overflows (the Layers footer, the Swatches
 *     toolbar) must stay inside the drawer that clips them.
 *
 * The panels sheet is an accordion, so each panel is opened IN TURN and swept.
 * The script this came from expanded "every" panel at once — which leaves only
 * the last one open — and so swept the headers plus one panel.
 *
 * Desktop is asserted UNCHANGED by its old sizes: a rule leaking out of the
 * touch block would make every panel row taller where a mouse hits 20px fine.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

const MIN = 44;

interface Sweep {
  seen: number;
  bad: string[];
}
/** Every rendered on-screen control under the floor, inside `scope`. */
const sweepHere = (page: Page, scope?: string) =>
  page.evaluate(
    ({ min, scope }): Sweep => {
      const root = scope ? document.querySelector(scope) : document;
      if (!root) return { seen: 0, bad: [] };
      const bad: string[] = [];
      let seen = 0;
      for (const el of root.querySelectorAll<HTMLElement>('button, input, select, [role="menuitem"]')) {
        const r = el.getBoundingClientRect();
        // A zero box is a hidden control; one past the edge is measured at another position.
        if (r.width < 1 || r.height < 1) continue;
        if (r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) continue;
        seen++;
        if (r.width >= min && r.height >= min) continue;
        const cls = el.className.toString().replace(/^\S*module__\w+__/, "").split(" ")[0];
        const label = (el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 20);
        const type = (el as HTMLInputElement).type;
        bad.push(`${el.tagName.toLowerCase()}${type ? `[${type}]` : ""}.${cls || "-"} ${Math.round(r.width)}×${Math.round(r.height)} "${label}"`);
      }
      return { seen, bad };
    },
    { min: MIN, scope },
  );

/** Sweep `scope` at every scroll position of `scroller`. */
async function sweep(app: App, scroller: string | null, scope?: string): Promise<Sweep> {
  const positions = scroller
    ? await app.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return [0];
        const out: number[] = [];
        for (let y = 0; y < el.scrollHeight; y += Math.max(200, el.clientHeight - 60)) out.push(y);
        return out.length ? out : [0];
      }, scroller)
    : [0];
  const all: Sweep = { seen: 0, bad: [] };
  for (const y of positions) {
    if (scroller) await app.page.evaluate(([sel, top]) => document.querySelector(sel)?.scrollTo(0, top), [scroller, y] as const);
    await app.settle(260);
    const r = await sweepHere(app.page, scope);
    all.seen += r.seen;
    for (const b of r.bad) if (!all.bad.includes(b)) all.bad.push(b);
  }
  return all;
}

/** Can a touch at each wholly visible control's centre land on it? */
const reach = (page: Page, scope: string) =>
  page.evaluate((scope) => {
    const root = document.querySelector(scope);
    if (!root) return { tested: 0, bad: [] as string[] };
    const bad: string[] = [];
    let tested = 0;
    const clipped = (el: Element) => {
      let b = el.getBoundingClientRect();
      let box = { left: b.left, right: b.right, top: b.top, bottom: b.bottom };
      for (let p = el.parentElement; p; p = p.parentElement) {
        const s = getComputedStyle(p);
        if (s.overflowY === "visible" && s.overflowX === "visible") continue;
        b = p.getBoundingClientRect();
        box = { left: Math.max(box.left, b.left), right: Math.min(box.right, b.right), top: Math.max(box.top, b.top), bottom: Math.min(box.bottom, b.bottom) };
      }
      return box;
    };
    const cls = (x: Element) => x.className.toString().replace(/^\S*module__\w+__/, "").split(" ")[0];
    for (const el of root.querySelectorAll('button, select, [role="menuitem"]')) {
      const r = el.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) continue;
      const v = clipped(el);
      // Wholly visible only: a half-scrolled row is one the user scrolls to.
      if (v.right - v.left < r.width - 1 || v.bottom - v.top < r.height - 1) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
      tested++;
      const hit = document.elementFromPoint(cx, cy);
      if (!hit || el.contains(hit) || hit.contains(el)) continue;
      bad.push(`.${cls(el)} "${(el.getAttribute("aria-label") || el.textContent || "").trim().slice(0, 18)}" covered by <${hit.tagName.toLowerCase()}>.${cls(hit)}`);
    }
    return { tested, bad };
  }, scope);

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test.beforeEach(async ({ app }) => {
    await app.run("layer-new"); // so the panels have content
  });

  test("the canvas view and the tools drawer: every control 44px, and reachable", async ({ app }) => {
    const canvas = await sweep(app, null);
    await app.page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().tap();
    await app.settle(1_000);
    const tools = await sweep(app, '[data-tour="toolbar"] [class*="tools"]');
    expect([...canvas.bad, ...tools.bad], "controls under 44×44").toEqual([]);
    expect(canvas.seen + tools.seen, "enough controls were measured to mean something").toBeGreaterThanOrEqual(40);
    const r = await reach(app.page, '[data-tour="toolbar"]');
    expect(r.tested, "tool-drawer controls hit-tested").toBeGreaterThanOrEqual(10);
    expect(r.bad, "every tool-drawer control is reachable at its own centre").toEqual([]);
  });

  test("every panel, opened in turn: every control 44px, and reachable", async ({ app }) => {
    const { page } = app;
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
    await app.settle(1_000);
    await app.setSheetDetent("full");
    const ids = await page.evaluate(() => [...document.querySelectorAll("[data-panel-id]")].map((s) => s.getAttribute("data-panel-id")!));
    expect(ids.length, "the dock lists its panels").toBeGreaterThanOrEqual(8);
    const bad: string[] = [];
    const reachBad: string[] = [];
    let seen = 0;
    let tested = 0;
    for (const id of ids) {
      if (!(await app.openPanelById(id))) continue;
      const scroller = await page.evaluate(() => {
        document.querySelector('[data-scroller="1"]')?.removeAttribute("data-scroller");
        const el = [...document.querySelectorAll('[data-tour="dock"] *')].find((e) => e.scrollHeight > e.clientHeight + 40);
        el?.setAttribute("data-scroller", "1");
        return !!el;
      });
      const s = await sweep(app, scroller ? '[data-scroller="1"]' : null, '[data-tour="dock"]');
      seen += s.seen;
      for (const b of s.bad) bad.push(`${id}: ${b}`);
      const r = await reach(page, '[data-tour="dock"]');
      tested += r.tested;
      for (const b of r.bad) reachBad.push(`${id}: ${b}`);
    }
    expect([...new Set(bad)], "panel controls under 44×44").toEqual([]);
    /* 180: on the phone a panel shows without its fold caret and float pin
       (the chip strip chooses the panel), two fewer controls per panel. */
    expect(seen, "enough panel controls were measured").toBeGreaterThanOrEqual(180);
    expect(tested, "panel controls hit-tested").toBeGreaterThanOrEqual(50);
    expect([...new Set(reachBad)], "every panel control is reachable at its own centre").toEqual([]);
  });

  test("the rows a 44px floor overflows wrap inside the drawer", async ({ app }) => {
    /* The Layers footer holds eight buttons and the Swatches toolbar seven; at
       44px each they ran 366px and 308px wide in a 295px drawer that clips. */
    const { page } = app;
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
    await app.settle(1_000);
    await app.setSheetDetent("full");
    const overflow = async (id: string, sel: string) => {
      expect(await app.openPanelById(id), `${id} opens`).toBe(true);
      return page.evaluate((sel) => {
        const right = document.querySelector('[data-tour="dock"]')!.getBoundingClientRect().right;
        const row = document.querySelector(sel);
        if (!row) return null;
        let over = -Infinity;
        let n = 0;
        for (const b of row.children) {
          const r = b.getBoundingClientRect();
          if (r.width < 1) continue;
          n++;
          over = Math.max(over, Math.round(r.right - right));
        }
        return { n, over };
      }, sel);
    };
    const layers = await overflow("layers", '[class*="layerFooter"]');
    expect(layers?.n, "the Layers footer's buttons").toBeGreaterThanOrEqual(6);
    expect(layers!.over, "...none past the drawer's edge").toBeLessThanOrEqual(0);
    const swatches = await overflow("swatches", '[class*="swToolbar"]');
    expect(swatches?.n, "the Swatches toolbar's children").toBeGreaterThanOrEqual(5);
    expect(swatches!.over, "...none past the drawer's edge").toBeLessThanOrEqual(0);
  });

  test("the menu sheet, with a menu open: every row 44px, and reachable", async ({ app }) => {
    const { page } = app;
    const sheet = '[data-menubar][data-sheet="true"]';
    await page.locator('button[aria-label="Menu"]').first().tap();
    await app.settle(900);
    const closed = await sweep(app, sheet);
    /* `:not([data-sheet-search])`: the sheet's first row is the palette
       trigger, not a menu, and tapping it closes the sheet. */
    await page.locator(`${sheet} > div > button:not([data-sheet-search])`).first().tap();
    await app.settle(700);
    const open = await sweep(app, sheet);
    expect([...closed.bad, ...open.bad], "menu controls under 44×44").toEqual([]);
    expect(closed.seen + open.seen, "enough menu controls were measured").toBeGreaterThanOrEqual(30);
    const r = await reach(page, sheet);
    expect(r.tested).toBeGreaterThanOrEqual(5);
    expect(r.bad, "every menu row is reachable at its own centre").toEqual([]);
  });

  test("a dialog: every control 44px", async ({ app }) => {
    const { page } = app;
    const sheet = '[data-menubar][data-sheet="true"]';
    await page.locator('button[aria-label="Menu"]').first().tap();
    await app.settle(900);
    await page.locator(`${sheet} > div > button:not([data-sheet-search])`).first().tap();
    await app.settle(700);
    const row = page.locator(`${sheet} [role="menu"] button`, { hasText: "…" }).first();
    await row.scrollIntoViewIfNeeded();
    await row.tap();
    await app.settle(1_100);
    // Scoped to the dialog: a document-wide count would credit the top bar behind it.
    const d = await sweep(app, null, '[role="dialog"]');
    expect(d.seen, "a dialog opened, with controls to measure").toBeGreaterThanOrEqual(3);
    expect(d.bad, "dialog controls under 44×44").toEqual([]);
  });

  test("a switch takes the floor as reach, not as paint", async ({ app }) => {
    /* A switch is a 32×16 track with a thumb 2px inside it. Given the 44px
       minimum it became 44×44 — a pill radius on a square is a CIRCLE, with the
       thumb pinned 2px from a corner: a green disc with a dot in the top left.
       So the floor is spent on an invisible pseudo-element: the PAINT stays the
       track, the REACH is 44px, and only elementFromPoint sees the second. */
    const { page } = app;
    await app.openPalette();
    await app.settle(100);
    await page.locator('input[aria-label="Search commands"]').fill("Preferences");
    await app.settle(500);
    await page.locator('[role="option"]').first().tap();
    await app.settle(1_600);
    const sw = page.locator('[role="switch"]').first();
    await sw.scrollIntoViewIfNeeded();
    await app.settle(400);
    const s = await page.evaluate(() => {
      const e = [...document.querySelectorAll('[role="switch"]')].find((x) => x.getBoundingClientRect().width > 0)!;
      const r = e.getBoundingClientRect();
      const t = e.firstElementChild!.getBoundingClientRect();
      const cx = Math.round(r.x + r.width / 2);
      const cy = Math.round(r.y + r.height / 2);
      const lands = (dx: number, dy: number) => {
        const el = document.elementFromPoint(cx + dx, cy + dy);
        return !!el && (el === e || e.contains(el));
      };
      // Would a switch swallow a tap meant for something else?
      const stolen = [...document.querySelectorAll('[role="dialog"] button, [role="dialog"] select, [role="dialog"] input')]
        .filter((c) => c.getAttribute("role") !== "switch")
        .filter((c) => {
          const b = c.getBoundingClientRect();
          if (b.width <= 0 || b.height <= 0) return false;
          return !!document.elementFromPoint(Math.round(b.x + b.width / 2), Math.round(b.y + b.height / 2))?.closest('[role="switch"]');
        }).length;
      return {
        w: Math.round(r.width),
        h: Math.round(r.height),
        thumbInside: t.x >= r.x - 0.5 && t.right <= r.right + 0.5 && t.y >= r.y - 0.5 && t.bottom <= r.bottom + 0.5,
        /* "Inside" is not enough: a 12px thumb in the corner of a 44px square
           is inside it too — which is what the bug looked like. Centred is. */
        thumbOffCentre: Math.round(Math.abs(t.y + t.height / 2 - (r.y + r.height / 2))),
        reach: { up: lands(0, -18), down: lands(0, 18), left: lands(-20, 0), right: lands(20, 0), centre: lands(0, 0) },
        stolen,
        checked: e.getAttribute("aria-checked"),
      };
    });
    expect(s.w, `painted as a track, not a square (${s.w}×${s.h})`).toBeGreaterThanOrEqual(s.h * 1.5);
    expect({ inside: s.thumbInside, offCentre: s.thumbOffCentre <= 1 }, "the thumb is centred on the track").toEqual({
      inside: true,
      offCentre: true,
    });
    expect(s.reach, "a finger lands on it from 18px above and below, and 20px either side").toEqual({
      up: true,
      down: true,
      left: true,
      right: true,
      centre: true,
    });
    expect(s.stolen, "...without swallowing a tap meant for anything else").toBe(0);
    await sw.tap();
    await app.settle(500);
    expect(await sw.getAttribute("aria-checked"), "and pressing it still flips it").not.toBe(s.checked);
  });

  test("a touch slider: round ends, a track to aim at, a 44px box, a knob to grab", async ({ app }) => {
    /* Reported as "the sliders have very pointy tips". The cause was
       arithmetic: `border-radius` describes the BORDER box, and
       `background-clip: content-box` re-uses that curve reduced by the padding
       — a 999px pill radius on a 46px box, clipped to a 4px track, gave a
       corner 32px wide and 2px tall. Four of those is a spindle. */
    const { page } = app;
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Tools" }).first().tap();
    await app.settle(500);
    await page.locator('[data-tour="toolbar"]').getByRole("button", { name: "Brush", exact: true }).tap();
    await app.settle(600);
    if ((await page.evaluate(() => document.documentElement.dataset.drawer ?? "")) !== "") {
      await page.evaluate(() => window.history.back());
      await app.settle(500);
    }
    // The options card opens by default; unfold it only if it was folded.
    if ((await page.locator("[data-options-open]").getAttribute("aria-expanded")) !== "true") {
      await page.locator("[data-options-open]").tap();
      await app.settle(900);
    }
    const s = await page.evaluate(() => {
      const els = [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')].filter((e) => e.getBoundingClientRect().width > 0);
      if (!els.length) return null;
      const cs = getComputedStyle(els[0]);
      const radius = cs.borderTopLeftRadius; // "4px 23px" once it has two axes
      const [rh, rv] = radius.split(/\s+/).map(parseFloat);
      return {
        count: els.length,
        track: parseFloat(cs.height),
        pad: parseFloat(cs.paddingTop),
        box: Math.round(els[0].getBoundingClientRect().height),
        rh,
        rv: Number.isFinite(rv) ? rv : rh,
        uniform: els.every((e) => {
          const c = getComputedStyle(e);
          return c.height === cs.height && c.borderTopLeftRadius === radius;
        }),
      };
    });
    expect(s, "a slider is on screen").not.toBeNull();
    // A pill on the CONTENT box: horizontal radius half the track, vertical the padding plus that.
    expect(Math.abs(s!.rh - s!.track / 2), `radius ${s!.rh}px / ${s!.rv}px, ${s!.track}px track, ${s!.pad}px padding`).toBeLessThan(0.6);
    expect(Math.abs(s!.rv - (s!.pad + s!.track / 2))).toBeLessThan(0.6);
    expect(s!.track, "the track is thick enough to see and aim at").toBeGreaterThanOrEqual(8);
    expect(s!.box, "the box is the 44px a finger needs").toBeGreaterThanOrEqual(44);
    expect(s!.uniform, `all ${s!.count} sliders alike`).toBe(true);

    /* The thumb is a pseudo-element script cannot measure (`getComputedStyle`
       answers with the INPUT's box, and elementFromPoint for the whole
       control), so it is measured in pixels: the knob is white on a dark
       track, and the run of near-white along the centre line is its diameter.
       Decoded in the page — no image library needed. */
    await page.evaluate(() => {
      const e = [...document.querySelectorAll<HTMLInputElement>('input[type="range"]')].find((x) => x.getBoundingClientRect().width > 0)!;
      e.value = e.min || "0";
      e.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await app.settle(300);
    const k = (await page.locator('input[type="range"]').first().boundingBox())!;
    const png = await page.screenshot({ clip: { x: k.x - 4, y: k.y + k.height / 2 - 16, width: 64, height: 32 } });
    const run = await page.evaluate(async (b64) => {
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${b64}`)).blob());
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const g = c.getContext("2d")!;
      g.drawImage(bmp, 0, 0);
      const row = g.getImageData(0, Math.floor(bmp.height / 2), bmp.width, 1).data;
      let n = 0;
      for (let x = 0; x < bmp.width; x++) {
        const white = row[x * 4] > 225 && row[x * 4 + 1] > 225 && row[x * 4 + 2] > 225;
        if (white) n++;
        else if (n) break;
      }
      return n;
    }, png.toString("base64"));
    expect(run, "a knob big enough to grab, not a 12px mouse dot").toBeGreaterThanOrEqual(16);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("the touch floor stays on touch: the old sizes are unchanged", async ({ app }) => {
    await app.run("layer-new");
    const one = (sel: string) =>
      app.page.evaluate((sel) => {
        const el = document.querySelector(sel);
        if (!el) return "absent";
        const r = el.getBoundingClientRect();
        return `${Math.round(r.width)}×${Math.round(r.height)}`;
      }, sel);
    expect(await one('[data-tour="dock"] button[class*="panelCaret"]'), "panel carets").toBe("28×28");
    expect(await one('[data-tour="toolbar"] button[class*="swatch"]'), "toolbar swatches").toBe("24×24");
    expect(await one('[data-tour="canvas"] [class*="zoomBar"] button'), "zoom buttons").toBe("30×30");
    const s = await sweepHere(app.page);
    expect(s.bad.length, `${s.bad.length} of ${s.seen} desktop controls are under 44px, as before`).toBeGreaterThanOrEqual(10);
  });
});
