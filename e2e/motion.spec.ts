/**
 * Motion (3.2): popups and panels move rather than appear.
 *
 *  - A popup grows out of the point it was opened from and LEAVES — it stays
 *    drawn for its exit (`data-state="closed"`), unusable and unannounced
 *    while it goes, then is removed.
 *  - Its shape and its visibility are separate animations: a spring for the
 *    scale, lift and corner radius, a short reveal for opacity and blur.
 *  - A panel folds and unfolds through every height in between, so its card's
 *    padding and corners change continuously instead of in one frame.
 *  - The menu bar swaps instantly between neighbours; Reduce motion makes
 *    everything immediate.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 1440, height: 900 } });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const menuSel = '[role="menu"][aria-label="Layer"]';
const openLayerMenu = async (app: App) => {
  await app.run("layer-new");
  await app.settle(300);
  const row = app.page.locator('[data-panel-id="layers"] [data-layer-id]').first();
  const b = (await row.boundingBox())!;
  const at = { x: Math.round(b.x + 150), y: Math.round(b.y + 12) };
  await app.page.mouse.click(at.x, at.y, { button: "right" });
  return at;
};

test("a context menu grows out of the click, its shape on a spring and its reveal quick", async ({ app }) => {
  const at = await openLayerMenu(app);
  const m = await app.page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel)!;
    const anims = el.getAnimations().map((a) => {
      const k = (a.effect as KeyframeEffect | null)?.getKeyframes()[0] ?? {};
      const t = (a.effect as KeyframeEffect).getTiming();
      // Shorthands come back as their longhands (borderTopLeftRadius…).
      const keys = Object.keys(k);
      return {
        radius: keys.some((x) => /radius/i.test(x)),
        opacity: keys.includes("opacity"),
        // A CSS animation's timing function lives on its keyframes.
        easing: String((k as { easing?: string }).easing ?? t.easing),
        dur: Number(t.duration),
      };
    });
    return { left: parseFloat(el.style.left), top: parseFloat(el.style.top), origin: el.style.getPropertyValue("--origin"), anims };
  }, menuSel);
  const [ox, oy] = m.origin.split(" ").map(parseFloat);
  expect(Math.abs(m.left + ox - at.x), "the transform origin is the click (x)").toBeLessThanOrEqual(1);
  expect(Math.abs(m.top + oy - at.y), "...and (y)").toBeLessThanOrEqual(1);
  const shape = m.anims.find((a) => a.radius);
  const reveal = m.anims.find((a) => a.opacity);
  expect(shape, "an animation draws the corners in").toBeTruthy();
  expect(shape!.easing, "...on a spring").toMatch(/^linear\(/);
  expect(reveal, "a separate one reveals it").toBeTruthy();
  expect(reveal!.dur, "...and is the quicker of the two").toBeLessThan(shape!.dur);
});

test("a context menu leaves rather than vanishing, and takes no click on its way out", async ({ app }) => {
  await openLayerMenu(app);
  await app.settle(600);
  await app.page.keyboard.press("Escape");
  const leaving = await app.page.evaluate((sel) => {
    const el = document.querySelector<HTMLElement>(sel);
    return el
      ? { state: el.dataset.state, inert: el.inert, hidden: el.getAttribute("aria-hidden"), pe: getComputedStyle(el).pointerEvents }
      : null;
  }, menuSel);
  expect(leaving, "still drawn for its exit").not.toBeNull();
  expect(leaving).toEqual({ state: "closed", inert: true, hidden: "true", pe: "none" });
  await expect(app.page.getByRole("menu", { name: "Layer" }), "not announced while it leaves").toHaveCount(0);
  await expect(app.page.locator(menuSel), "then gone").toHaveCount(0, { timeout: 1000 });
});

test("a panel folds and unfolds through every height in between", async ({ app }) => {
  const sample = () =>
    app.page.evaluate(
      () =>
        new Promise<number[]>((done) => {
          const card = document.querySelector<HTMLElement>('[data-panel-id="color"]')!;
          const out: number[] = [];
          const t0 = performance.now();
          const tick = () => {
            out.push(Math.round(card.getBoundingClientRect().height));
            if (performance.now() - t0 < 650) requestAnimationFrame(tick);
            else done(out);
          };
          requestAnimationFrame(tick);
        }),
    );
  const open = Math.round((await app.page.locator('[data-panel-id="color"]').boundingBox())!.height);
  const caret = app.page.locator('[data-panel-id="color"] button[aria-label="Collapse Color"]');
  const [fold] = await Promise.all([sample(), caret.click()]);
  const shut = fold[fold.length - 1];
  expect(shut, "it folded").toBeLessThan(open / 3);
  const between = fold.filter((h) => h > shut + 8 && h < open - 8);
  expect(between.length, `folding passed through the middle: ${fold.join(",")}`).toBeGreaterThanOrEqual(4);

  const [unfold] = await Promise.all([
    sample(),
    app.page.locator('[data-panel-id="color"] button[aria-label="Expand Color"]').click(),
  ]);
  expect(unfold[unfold.length - 1], "it unfolded").toBeGreaterThan(open - 4);
  expect(
    unfold.filter((h) => h > shut + 8 && h < open - 8).length,
    `unfolding too: ${unfold.join(",")}`,
  ).toBeGreaterThanOrEqual(4);
});

test("the menu bar swaps instantly between neighbouring menus", async ({ app }) => {
  const bar = app.page.locator("[data-menubar]");
  await bar.getByRole("button", { name: "File", exact: true }).click();
  await expect(bar.locator('[role="menu"]')).toHaveCount(1);
  await expect(bar.locator('[role="menu"]'), "opened from nothing: an entrance").not.toHaveAttribute("data-instant");
  await bar.getByRole("button", { name: "Edit", exact: true }).hover();
  const menus = bar.locator('[role="menu"]');
  await expect(menus, "the old one is gone at once").toHaveCount(1);
  await expect(menus.first(), "the new one swaps in").toHaveAttribute("data-instant");
});

test("with Reduce motion on, things close at once", async ({ app }) => {
  await app.page.evaluate(() => document.documentElement.setAttribute("data-motion", "off"));
  await openLayerMenu(app);
  await app.settle(200);
  await app.page.keyboard.press("Escape");
  // 50ms in: an exit (150ms) would still be on screen.
  await app.page.waitForTimeout(50);
  expect(await app.page.locator(menuSel).count(), "no exit to wait for").toBe(0);
});
