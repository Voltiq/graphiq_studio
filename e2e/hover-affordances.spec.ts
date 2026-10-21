/**
 * The things you could only reach by hovering.
 * (Ported from tools/verify-hover-affordances.js, TODO 2.1.)
 *
 *  - The delete button on every saved thing (filter presets, history
 *    snapshots, colour samplers, saved brushes, gradient presets, custom
 *    shapes, layer styles) is `opacity: 0` until its row is hovered: readable
 *    with a mouse, unreachable with a finger, because no gesture hovers.
 *  - The tooltip host ignores touch (a finger has no hover to track), which
 *    left every icon-only control on a phone with no label at all. A long
 *    press now shows it.
 *
 * The gate is `hover: none`, not the phone shell: the question is whether the
 * device can hover, and a tablet cannot either — so a tablet profile is
 * checked too. The seven kinds live in four stylesheets, so each is checked by
 * COMPUTED STYLE on an element built from the hashed class the stylesheets
 * really carry, nested in its real parent (a rule written against a class that
 * does not exist is how this breaks); two kinds are then driven end to end,
 * because "opacity is 1" is not the same claim as "a finger can delete this".
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** Each reveal button, and the row it lives in (the base rule is often nested in it). */
const KINDS: [string, string, string][] = [
  ["presetDelete", "filterChip", "filter presets"],
  ["snapDel", "historyRow", "history snapshots"],
  ["samplerDel", "samplerRow", "colour samplers"],
  ["brushDel", "brushItem", "saved brushes"],
  ["presetDel", "presetCell", "gradient presets"],
  ["shapeDel", "shapeCell", "custom shapes"],
  ["styleDel", "styleCell", "layer styles"],
];

/** The computed opacity of each reveal button, built from the shipped CSSOM;
 *  null for a class no stylesheet mentions. */
const opacities = (app: App) =>
  app.page.evaluate((kinds) => {
    const hashed: Record<string, Set<string>> = {};
    const walk = (list: CSSRuleList) => {
      for (const r of list) {
        if ("cssRules" in r && (r as CSSGroupingRule).cssRules) walk((r as CSSGroupingRule).cssRules);
        const sel = (r as CSSStyleRule).selectorText;
        if (!sel) continue;
        for (const m of sel.matchAll(/\.([A-Za-z0-9_-]+)/g))
          for (const pair of kinds)
            for (const name of pair.slice(0, 2))
              if (m[1].endsWith("__" + name) || m[1] === name) (hashed[name] ??= new Set()).add(m[1]);
      }
    };
    for (const sheet of document.styleSheets) {
      try {
        walk(sheet.cssRules);
      } catch {
        // a cross-origin sheet: nothing of ours is in one
      }
    }
    const out: Record<string, number | null> = {};
    for (const [name, parent] of kinds) {
      const own = [...(hashed[name] ?? [])];
      if (!own.length) {
        out[name] = null;
        continue;
      }
      const host = document.createElement("div");
      host.className = [...(hashed[parent] ?? [])].join(" ");
      const el = document.createElement("div");
      el.className = own.join(" ");
      host.appendChild(el);
      document.body.appendChild(host);
      out[name] = Number(getComputedStyle(el).opacity);
      host.remove();
    }
    return out;
  }, KINDS);

const tipText = (app: App) => app.page.evaluate(() => document.querySelector('[role="tooltip"]')?.textContent ?? null);

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test("every delete button that waited for a hover is visible", async ({ app }) => {
    const o = await opacities(app);
    expect(
      KINDS.filter(([n]) => o[n] === null).map(([n]) => n),
      "every reveal button's class is one the stylesheets carry",
    ).toEqual([]);
    expect(
      KINDS.filter(([n]) => (o[n] ?? 1) < 1).map(([n, , what]) => `${what} (${n}) at ${o[n]}`),
      "all seven fully visible",
    ).toEqual([]);
  });

  test("a finger can create and delete a history snapshot and a saved brush", async ({ app }) => {
    const { page } = app;
    await app.run("layer-new");
    await page.locator('[data-tour="mobilebar"] button', { hasText: "Panels" }).first().tap();
    await app.settle(700);
    expect(await app.setSheetDetent("full")).toBe(true);
    const count = (cls: string) => page.locator(`[class*="${cls}"]`).count();
    const visible = (cls: string) =>
      page.evaluate(
        (k) =>
          [...document.querySelectorAll(`[class*="${k}"]`)].filter(
            (e) => Number(getComputedStyle(e).opacity) > 0.5 && e.getBoundingClientRect().width > 4,
          ).length,
        cls,
      );
    for (const [what, tip, cls, panel] of [
      ["history snapshot", "Take a snapshot of the current state", "snapDel", "history"],
      ["saved brush", "Save the current brush settings as a preset", "brushDel", "brushes"],
    ]) {
      expect(await app.openPanelById(panel), `the ${panel} panel opens`).toBe(true);
      const before = await count(cls);
      /* Titles move to `data-tip` on the tooltip host: `[title=…]` finds nothing. */
      await page.locator(`[data-tip="${tip}"]`).first().tap();
      await app.settle(900);
      const after = await count(cls);
      expect(after, `a ${what} can be created`).toBeGreaterThan(before);
      expect(await visible(cls), "...and its delete button shows without a hover").toBeGreaterThan(0);
      await page.locator(`[class*="${cls}"]`).first().tap();
      await app.settle(900);
      expect(await count(cls), `...and tapping it deletes the ${what}`).toBeLessThan(after);
    }
  });

  test("a long press labels an icon-only control; a tap or a drag does not", async ({ app }) => {
    const { page } = app;
    /* An icon-only control that is genuinely on top where it sits. */
    const icon = await page.evaluate(() => {
      const el = [...document.querySelectorAll("[data-tip]")].find((e) => {
        const r = e.getBoundingClientRect();
        if (r.width < 8 || r.top < 0 || r.bottom > innerHeight || (e.textContent ?? "").trim()) return false;
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
        return !!hit && (e.contains(hit) || hit.contains(e));
      });
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { tip: el.getAttribute("data-tip")!, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    expect(icon, "an icon-only control with a tip is on screen").not.toBeNull();
    expect(await tipText(app), "no tooltip before the press").toBeNull();
    await app.touchDown(icon!.x, icon!.y);
    await app.settle(220);
    expect(await tipText(app), "...nor while it is still a tap, not a hold").toBeNull();
    await app.settle(500);
    expect(await tipText(app), "a long press shows the full text").toBe(icon!.tip);
    await app.touchUp();
    await app.settle(400);

    /* A press that MOVES is a drag and leaves no label. With `touch-action:
       none` forced on: otherwise the browser takes the move for a scroll and
       fires pointercancel, which ends the press for free and passes whether or
       not the slop guard exists (a mutation proved it). */
    await page.addStyleTag({ content: "[data-tip]{touch-action:none!important}" });
    await app.touchDown(icon!.x, icon!.y);
    for (let i = 1; i <= 5; i++) await app.touchMove(icon!.x + i * 6, icon!.y + i * 2, 1);
    await app.settle(700);
    const afterDrag = await tipText(app);
    await app.touchUp();
    expect(afterDrag, "a press that turns into a drag shows nothing").toBeNull();
  });

  test("the tap that ends a long press does not also press the control", async ({ app }) => {
    /* Proved on the Alt chip: its whole state is one attribute, it is always
       there, and it changes nothing about the document. */
    const chip = app.page.locator('[aria-label="Keyboard modifiers"] button', { hasText: /^Alt/ }).first();
    await expect(chip).toHaveAttribute("data-mode", "off");
    const b = (await chip.boundingBox())!;
    const c = { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) };
    await app.touchDown(c.x, c.y);
    await app.settle(750);
    const label = await tipText(app);
    await app.touchUp();
    await app.settle(700);
    expect(label, "long-pressing it labels it").toBeTruthy();
    await expect(chip, "...and the tap that ended the press did NOT arm it").toHaveAttribute("data-mode", "off");
    await app.touchDown(c.x, c.y);
    await app.touchUp();
    await expect(chip, "while an ordinary tap still arms it").toHaveAttribute("data-mode", "armed");
  });

  test("with two documents, each tab's close button shows and closes it", async ({ app }) => {
    const { page } = app;
    await app.newDoc();
    const strip = await page.evaluate(() => {
      const el = document.querySelector("[data-tabs]");
      if (!el) return null;
      const sr = el.getBoundingClientRect();
      const tab = el.querySelector("button")!;
      const tr = tab.getBoundingClientRect();
      const close = el.querySelector('[role="button"][aria-label^="Close"]');
      if (!close) return { noClose: true };
      const cr = close.getBoundingClientRect();
      const cy = Math.round(cr.y + cr.height / 2);
      const hit = (x: number, y: number) => {
        const e = document.elementFromPoint(x, y);
        if (!e) return "none";
        if (e.closest('[role="button"][aria-label^="Close"]')) return "close";
        return e.closest("[data-tabs] button") ? "tab" : "other";
      };
      return {
        fits: tr.top >= sr.top - 0.5 && tr.bottom <= sr.bottom + 0.5,
        stripH: Math.round(sr.height),
        tabH: Math.round(tr.height),
        visible: close.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
        close: { w: Math.round(cr.width), h: Math.round(cr.height) },
        contained: cr.right <= tr.right + 0.5,
        tabAnswers: hit(Math.round(tr.x + 20), cy),
      };
    });
    expect(strip, "a tab strip shows two documents").not.toBeNull();
    expect(strip, "each tab has a close button").not.toHaveProperty("noClose");
    const s = strip as Exclude<typeof strip, null | { noClose: boolean }>;
    expect(s.fits, `the strip is tall enough for the tab in it: ${s.tabH}px tab, ${s.stripH}px strip`).toBe(true);
    expect(s.visible, "the close button shows without a hover").toBe(true);
    expect(s.close.w >= 28 && s.close.h >= 40, `...as a target, not a 16px mark: ${s.close.w}×${s.close.h}`).toBe(true);
    expect(s.contained && s.tabAnswers === "tab", "...within its own tab, which still answers at its left").toBe(true);
    const tabs = page.locator("[data-tabs] button[class*='tab']");
    const was = await tabs.count();
    await page.locator('[data-tabs] [role="button"][aria-label^="Close"]').first().tap();
    await expect(tabs, "tapping it closes that document").toHaveCount(was - 1);
  });
});

test.describe("on a tablet", () => {
  test.use({ viewport: { width: 900, height: 1200 }, hasTouch: true });

  test("a wide touch device gets the buttons too, though it is not the phone shell", async ({ app }) => {
    expect(await app.page.evaluate(() => document.documentElement.dataset.mobile ?? null)).toBeNull();
    const o = await opacities(app);
    expect(KINDS.filter(([n]) => (o[n] ?? 1) < 1).map(([n]) => n), "all seven visible").toEqual([]);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("a mouse still gets the quiet rows, the hover tooltip and the hover-only tab cross", async ({ app }) => {
    const { page } = app;
    const o = await opacities(app);
    expect(KINDS.filter(([n]) => (o[n] ?? 0) > 0).map(([n]) => `${n}=${o[n]}`), "hidden until hovered").toEqual([]);

    const tip = await page.evaluate(() => {
      const el = [...document.querySelectorAll("[data-tip]")].find((e) => e.getBoundingClientRect().width > 8)!;
      const r = el.getBoundingClientRect();
      return { tip: el.getAttribute("data-tip"), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    });
    await page.mouse.move(tip.x, tip.y);
    await expect.poll(() => tipText(app), { message: "hovering still shows a tooltip" }).toBe(tip.tip);

    await app.newDoc();
    const close = page.locator('[data-tabs] [role="button"][aria-label^="Close"]').first();
    await page.mouse.move(5, 450);
    expect(await close.evaluate((e) => getComputedStyle(e).opacity), "the tab's cross waits for a hover").toBe("0");
  });
});
