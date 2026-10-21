/**
 * Finishing and abandoning a text session on a phone.
 * (Ported from tools/verify-text-session.js, TODO 2.1.)
 *
 * The ✓/✕ pair covers a text session with 52×52 buttons. What broke only
 * shows with a keyboard up — which, for TEXT, is always: the pair sat at
 * `--chrome-bottom`, 232px behind a 300px keyboard, and the caret went behind
 * it too (six lines typed low in the artwork put it 61px past the keyboard).
 * Since 3.0 the dock and the tool's options card ride ON the keyboard, so the
 * line the caret has to clear is the card's top, not the keyboard's
 * (lib/stage-area `coveredFrom`) — clearing only the keyboard left it resting
 * behind the card.
 *
 * A test cannot summon a keyboard, so `--kb-inset` is written by hand for the
 * CSS half and `__gqKeepCaretVisible` is called for the panning half; what
 * would call it is bound only while a session is live, so its presence and
 * absence are both asserted.
 */
import { test, expect, type App } from "./fixtures";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const KB = 300;

const state = (app: App) =>
  app.page.evaluate(() => {
    const kb = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--kb-inset")) || 0;
    /* What covers the stage from below: the keyboard, and on a phone the dock
       and the options card riding on it. */
    let line = innerHeight - kb;
    for (const sel of ['[data-tour="options"][data-mobile-options]', '[data-tour="mobilebar"]']) {
      const r = document.querySelector(sel)?.getBoundingClientRect();
      if (r && r.height > 0 && r.top > 0) line = Math.min(line, r.top);
    }
    const pair = document.querySelector(".gq-m-commit");
    const pr = pair?.getBoundingClientRect();
    const sel = window.getSelection();
    let caret: number | null = null;
    if (sel?.rangeCount) {
      const rr = sel.getRangeAt(0).getBoundingClientRect();
      if (rr.width || rr.height) caret = Math.round(rr.bottom);
    }
    return {
      live: document.documentElement.dataset.commit === "1",
      editing: !!document.querySelector('[contenteditable="true"]'),
      pairOnScreen: !!pr && pr.width > 0 && pr.height > 0,
      pairBehindKeyboard: pr ? Math.round(pr.bottom - (innerHeight - kb)) : null,
      buttons: pair
        ? [...pair.querySelectorAll("button")].map((b) => {
            const r = b.getBoundingClientRect();
            const el = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
            return { w: Math.round(r.width), h: Math.round(r.height), reaches: !!el && (b === el || b.contains(el)) };
          })
        : [],
      caret,
      line: Math.round(line),
      hook: typeof (window as unknown as { __gqKeepCaretVisible?: unknown }).__gqKeepCaretVisible === "function",
    };
  });

/** Start a session low in the artwork and type `lines` lines. */
const startText = async (app: App, lines: number) => {
  await app.key("t");
  const box = await app.canvasBox();
  await app.page.mouse.click(Math.round(box.x + box.width * 0.3), Math.round(box.y + box.height * 0.92));
  await app.settle(900);
  for (let i = 0; i < lines; i++) {
    await app.page.keyboard.type(`line ${i}`);
    await app.page.keyboard.press("Enter");
  }
  await app.page.keyboard.type("last");
  await app.settle(600);
};

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("with a keyboard up, Done and Cancel stay reachable and the caret is panned into view", async ({ app }) => {
    const { page } = app;
    await app.run("layer-new");
    await startText(app, 5);
    const typing = await state(app);
    expect({ live: typing.live, editing: typing.editing }, "a text session is live and editable").toEqual({ live: true, editing: true });
    expect(typing.pairOnScreen, "the finish / cancel pair is on screen").toBe(true);
    expect(
      typing.buttons.map((b) => b.w >= 44 && b.h >= 44 && b.reaches),
      "both big enough to tap, and reachable",
    ).toEqual([true, true]);
    expect(typing.hook, "the panning hook is bound while the session runs").toBe(true);

    await page.evaluate((px) => document.documentElement.style.setProperty("--kb-inset", `${px}px`), KB);
    await app.settle(600);
    const up = await state(app);
    expect(up.pairBehindKeyboard!, `with a ${KB}px keyboard the pair stays above it`).toBeLessThanOrEqual(0);
    expect(up.buttons.every((b) => b.reaches), "...and its buttons are still reachable there").toBe(true);
    /* Non-vacuity: the caret must START hidden, or bringing it back is a claim
       about a caret that never was. */
    expect(up.caret!, `the caret begins hidden (line at ${up.line})`).toBeGreaterThan(up.line);

    await page.evaluate(() => (window as unknown as { __gqKeepCaretVisible: () => void }).__gqKeepCaretVisible());
    await app.settle(600);
    const panned = await state(app);
    expect(panned.caret!, "panning brings it back above what covers the stage").toBeLessThan(panned.line);
    /* By the MINIMUM: "does a second call move anything?" cannot show it (the
       view is clamped by then — a mutation adding 40px to every delta passed
       that). The resting place shows it: just above the line, not flung up. */
    expect(panned.line - panned.caret!, "...landing just above it (the margin is 12)").toBeLessThanOrEqual(40);
    const again = await page.evaluate(() => {
      const sel = window.getSelection()!;
      const before = sel.getRangeAt(0).getBoundingClientRect().bottom;
      (window as unknown as { __gqKeepCaretVisible: () => void }).__gqKeepCaretVisible();
      return Math.round(sel.getRangeAt(0).getBoundingClientRect().bottom - before);
    });
    expect(again, "a caret already in view is left where it is").toBe(0);
    await page.evaluate(() => document.documentElement.style.removeProperty("--kb-inset"));
  });

  test("Done commits the text as a layer; Cancel leaves none, and the hook goes with the session", async ({ app }) => {
    const { page } = app;
    await app.run("layer-new");
    const before = (await app.layerNames()).length;
    await startText(app, 2);
    await page.locator('.gq-m-commit button[aria-label="Commit"]').tap();
    await expect.poll(async () => (await state(app)).live, { message: "Done ends the session" }).toBe(false);
    const committed = (await app.layerNames()).length;
    expect(committed, "...and commits the text as a layer").toBe(before + 1);

    await startText(app, 2);
    expect((await state(app)).live, "a second session starts").toBe(true);
    await page.locator('.gq-m-commit button[aria-label="Cancel"]').tap();
    await expect.poll(async () => (await state(app)).live, { message: "Cancel ends it too" }).toBe(false);
    expect((await app.layerNames()).length, "...and leaves no layer behind").toBe(committed);
    expect((await state(app)).hook, "the panning hook is unbound once nothing is edited").toBe(false);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("a desktop gets no on-canvas pair", async ({ app }) => {
    await app.run("layer-new");
    await startText(app, 2);
    const s = await state(app);
    expect(s.live, "the session is live").toBe(true);
    expect(s.pairOnScreen, "...with no on-canvas pair").toBe(false);
    await app.page.keyboard.press("Escape");
  });
});
