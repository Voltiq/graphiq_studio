/**
 * The onboarding tour, walked end to end on a desktop and on a phone, and its
 * try-its done the way a person does them.
 *
 * A first-run phone user was once shown empty rectangles: three of the desktop
 * lap's spotlights pointed at nothing at 390×844 — the tool drawer parked
 * off-screen, the panels sheet below the fold (its one visible strip WAS the
 * dock bar, so "Panels" highlighted the bottom bar), the status bar hidden.
 * The phone walks its own lap, over chrome that is always on screen.
 *
 * Each spotlight is checked against LIVE chrome rather than against a copy of
 * the step list: some `[data-tour]` element (or the `[data-tour-spot]` part of
 * one) must be what the hole is drawn round. If none is, the tour is
 * highlighting empty space. These specs drive a plain page: the `app` fixture
 * dismisses the tour, which is the one thing they must not do.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { MOBILE_TOUR_STEPS, TOUR_STEPS } from "../app/lib/tour";
import { PAD } from "../app/lib/tour-layout";

const TOUR = 'div[aria-label="Interactive tour"]';
/** Long enough for the gentle spring (490ms) to land. */
const SETTLE = 800;

type Shot = {
  id: string | null;
  title: string;
  panes: number;
  segs: number;
  now: number;
  centred: boolean;
  onScreen: number;
  target: string | null;
  /** Drawn round the `data-tour-spot` part of its chrome, not the whole of it. */
  spot: boolean;
  cardFully: boolean;
  /** Every segment of the progress bar inside the card. */
  segsFit: boolean;
  coversTarget: boolean;
  /** How far the card stands from its target (0 if they overlap). */
  gap: number | null;
  /** The caret is drawn, and its tip lies over the target's span. */
  caret: "none" | "on" | "off";
  buttons: { label: string; w: number; h: number }[];
};

/** One stop: what is spotlit, which chrome it matches, where the card is. */
const shot = (page: Page) =>
  page.evaluate((pad): Shot | null => {
    const tour = document.querySelector('div[aria-label="Interactive tour"]');
    if (!tour) return null;
    const hr = tour.querySelector('[data-part="spotlight"]')!.getBoundingClientRect();
    const card = tour.querySelector('[data-part="card"]')!;
    const cr = card.getBoundingClientRect();
    const pane = card.querySelector('[data-phase="in"]');
    /* On-screen area — not width × height, which counts a drawer parked off
       the side as a healthy spotlight; and as a FRACTION, because the padding
       lets a parked drawer poke a sliver in. */
    const visible =
      Math.max(0, Math.min(hr.right, innerWidth) - Math.max(hr.left, 0)) *
      Math.max(0, Math.min(hr.bottom, innerHeight) - Math.max(hr.top, 0));
    const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
    /* The hole is the chrome's rect padded, then kept 2px inside the window. */
    const holeOf = (r: DOMRect) => {
      const x0 = Math.max(r.left - pad, 2);
      const y0 = Math.max(r.top - pad, 2);
      const x1 = Math.min(r.right + pad, innerWidth - 2);
      const y1 = Math.min(r.bottom + pad, innerHeight - 2);
      return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    };
    const matched = [...document.querySelectorAll("[data-tour], [data-tour-spot]")].find((e) => {
      const h = holeOf(e.getBoundingClientRect());
      return near(h.x, hr.left) && near(h.y, hr.top) && near(h.w, hr.width) && near(h.h, hr.height);
    });
    const tr = matched?.getBoundingClientRect();
    const segs = [...tour.querySelectorAll('[data-part="progress"] > button')];
    const kr = tour.querySelector('[data-part="caret"]')?.getBoundingClientRect();
    const kx = kr ? kr.left + kr.width / 2 : 0;
    const ky = kr ? kr.top + kr.height / 2 : 0;
    return {
      id: pane?.getAttribute("data-step") ?? null,
      title: pane?.querySelector('[data-part="title"]')?.textContent?.trim() ?? "",
      panes: card.querySelectorAll("[data-step]").length,
      segs: segs.length,
      now: segs.findIndex((b) => b.getAttribute("aria-current") === "step"),
      /* A centred stop has no target: the hole closes to a point. */
      centred: hr.width === 0 && hr.height === 0,
      onScreen: hr.width * hr.height > 0 ? visible / (hr.width * hr.height) : 0,
      target: matched?.closest("[data-tour]")?.getAttribute("data-tour") ?? null,
      spot: !!matched?.hasAttribute("data-tour-spot"),
      cardFully: cr.left >= 0 && cr.top >= 0 && cr.right <= innerWidth && cr.bottom <= innerHeight,
      segsFit: segs.every((b) => b.getBoundingClientRect().right <= cr.right - 4),
      coversTarget:
        !!tr && cr.left < tr.right && tr.left < cr.right && cr.top < tr.bottom && tr.top < cr.bottom,
      gap: tr
        ? Math.max(0, tr.left - cr.right, cr.left - tr.right, tr.top - cr.bottom, cr.top - tr.bottom)
        : null,
      caret: !kr
        ? "none"
        : tr && ((kx >= tr.left && kx <= tr.right) || (ky >= tr.top && ky <= tr.bottom))
          ? "on"
          : "off",
      buttons: [...card.querySelectorAll('[data-part="card"] > :last-child button')].map((b) => ({
        label: b.textContent!.trim(),
        w: Math.round(b.getBoundingClientRect().width),
        h: Math.round(b.getBoundingClientRect().height),
      })),
    };
  }, PAD);

/** Open a first-run page and wait for the tour to greet it. */
async function firstRun(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector(TOUR, { timeout: 30_000 });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(SETTLE);
  return errors;
}

/** The way on: the card's primary button, whatever it says at this stop. */
const primary = (page: Page) =>
  page.locator(TOUR).locator("button", { hasText: /^(Take the tour|Next|Start creating)$/ });

/** Walk the whole lap with the primary button. */
async function walk(page: Page) {
  const lap: Shot[] = [];
  for (let i = 0; i < 20; i++) {
    const s = await shot(page);
    if (!s) break;
    lap.push(s);
    await primary(page).click();
    await page.waitForTimeout(SETTLE);
  }
  return { lap, closed: (await shot(page)) === null };
}

/** Advance with the keyboard to the stop with this id. */
async function goTo(page: Page, id: string) {
  for (let i = 0; i < 20 && (await shot(page))?.id !== id; i++) {
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(250);
  }
  await page.waitForTimeout(SETTLE);
  expect((await shot(page))?.id).toBe(id);
}

const tryDone = (page: Page) => page.locator(TOUR).locator('[data-part="try"]').getAttribute("data-done");
const activeTool = (page: Page) =>
  page.locator('[data-tour="toolbar"] [data-tool][data-active="true"]').first().getAttribute("data-tool");

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("the whole lap: every stop spotlights live chrome, and the card stands clear of it", async ({ page }) => {
    const errors = await firstRun(page);
    const { lap, closed } = await walk(page);
    expect(lap.map((s) => s.id), "every stop is shown, in order").toEqual(TOUR_STEPS.map((s) => s.id));
    lap.forEach((s, i) => {
      const step = TOUR_STEPS[i];
      expect(s.title, s.id!).toBe(step.title);
      if (step.target) {
        expect(s.target, `${s.id}: the spotlight is drawn round its chrome`).toBe(step.target);
        expect(s.onScreen, `${s.id}: on screen`).toBeGreaterThan(0.5);
        // Beside it — except the canvas, which fills the window and has it inside,
        // close enough to read as about it, the caret on it.
        if (step.id !== "canvas") {
          expect(s.coversTarget, `${s.id}: the card covers it`).toBe(false);
          expect(s.gap, `${s.id}: the card stands beside it`).toBeLessThanOrEqual(24);
          expect(s.caret, `${s.id}: the caret points at it`).toBe("on");
        }
      } else {
        expect(s.centred, `${s.id}: a centred stop closes the spotlight`).toBe(true);
      }
      expect(s.cardFully, `${s.id}: the card is on screen`).toBe(true);
      expect([s.segs, s.now], `${s.id}: the progress bar counts this lap, and lights this stop`).toEqual([
        lap.length,
        i,
      ]);
      expect(s.panes, `${s.id}: the previous stop has slid away`).toBe(1);
    });
    expect(lap[lap.length - 1].buttons.map((b) => b.label)).toEqual(["Back", "Open the sample", "Start creating"]);
    expect(closed, "pressing on through it ends the tour").toBe(true);
    expect(await page.evaluate(() => localStorage.getItem("graphiq:welcomed")), "and it is not shown again").toBe("1");
    expect(errors, "no page or console errors").toEqual([]);
  });

  test("the tools try-it: a tool's letter reaches the editor, and the card notices", async ({ page }) => {
    await firstRun(page);
    await goTo(page, "toolbar");
    expect(await activeTool(page)).toBe("brush");
    expect(await tryDone(page)).toBe("false");
    // Not the tour's keys: Ctrl+K stays with it — no palette opens under it.
    await page.keyboard.press("Control+k");
    await page.waitForTimeout(300);
    await expect(page.locator('[aria-label="Command palette"]')).toHaveCount(0);
    await page.keyboard.press("v");
    await page.waitForTimeout(300);
    expect(await activeTool(page), "V reached the editor").toBe("move");
    expect(await tryDone(page), "...and the tour saw it").toBe("true");
    await expect(primary(page), "the way on asks to be taken").toHaveAttribute("data-nudge", "true");
    await expect(page.locator(TOUR).locator('[data-part="try"]')).toContainText("That's it");

    // Back to it later: still done, though the tool is put back.
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(SETTLE);
    expect((await shot(page))!.id).toBe("options");
    // A stop with nothing to try keeps the keyboard: B does not reach the editor.
    await page.keyboard.press("b");
    await page.waitForTimeout(200);
    expect(await activeTool(page), "a letter on a plain stop stays with the tour").toBe("move");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(SETTLE);
    expect(await tryDone(page)).toBe("true");
  });

  test("the tools try-it can be done with the pointer, through the spotlight", async ({ page }) => {
    await firstRun(page);
    await goTo(page, "toolbar");
    await page.locator('[data-tour="toolbar"] [data-tool="move"]').first().click();
    await page.waitForTimeout(300);
    expect(await activeTool(page)).toBe("move");
    expect(await tryDone(page)).toBe("true");
    // The dim round the spotlight still blocks: the dock is out of reach.
    const blocked = await page.evaluate(() => {
      const r = document.querySelector('[data-tour="dock"]')!.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + 40);
      return !!hit?.closest('[aria-label="Interactive tour"]');
    });
    expect(blocked, "a click outside the spotlight lands on the tour").toBe(true);
  });

  test("the canvas try-it lets the wheel through, and nothing that could paint", async ({ page }) => {
    await firstRun(page);
    const zoom = page.locator("[data-zoom-value]").first();
    /* Zoom on an EARLIER stop (the tools try-it lets Ctrl+= through): the
       canvas try-it measures from when it opens, so that is not it done. */
    await goTo(page, "toolbar");
    const first = (await zoom.textContent())!.trim();
    await page.keyboard.press("Control+Equal");
    await page.waitForTimeout(300);
    expect((await zoom.textContent())!.trim(), "Ctrl+= reached the editor").not.toBe(first);
    await goTo(page, "canvas");
    expect(await tryDone(page), "a zoom before the stop opened does not count").toBe("false");
    const before = (await zoom.textContent())!.trim();
    const box = (await page.locator('[data-tour="canvas"]').boundingBox())!;
    const x = box.x + box.width * 0.35;
    const y = box.y + box.height * 0.4;
    const landsOnTour = await page.evaluate(
      ([px, py]) => !!document.elementFromPoint(px, py)?.closest('[aria-label="Interactive tour"]'),
      [x, y],
    );
    expect(landsOnTour, "a click on the canvas lands on the tour, not on the picture").toBe(true);
    await page.mouse.move(x, y);
    await page.keyboard.down("Control");
    await page.mouse.wheel(0, -400);
    await page.keyboard.up("Control");
    await page.waitForTimeout(400);
    expect((await zoom.textContent())!.trim(), "Ctrl+wheel zoomed the picture").not.toBe(before);
    expect(await tryDone(page)).toBe("true");
  });

  test("the keyboard and the progress bar move through it; Esc leaves", async ({ page }) => {
    await firstRun(page);
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(SETTLE);
    expect((await shot(page))!.id).toBe("topbar");
    await page.keyboard.press("ArrowLeft");
    await page.waitForTimeout(SETTLE);
    expect((await shot(page))!.id).toBe("welcome");
    // Enter on the focused primary is one step, not two.
    await page.keyboard.press("Enter");
    await page.waitForTimeout(SETTLE);
    expect((await shot(page))!.id).toBe("topbar");
    // A segment of the progress bar jumps straight to its stop.
    await page.locator(TOUR).locator('[data-part="progress"] > button').nth(8).click();
    await page.waitForTimeout(SETTLE);
    expect((await shot(page))!.id).toBe(TOUR_STEPS[8].id);
    // A focused Back takes its own Enter: back a stop, not on.
    await page.locator(TOUR).locator("button", { hasText: /^Next$/ }).focus();
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => document.activeElement?.textContent?.trim())).toBe("Back");
    await page.keyboard.press("Enter");
    await page.waitForTimeout(SETTLE);
    expect((await shot(page))!.id).toBe(TOUR_STEPS[7].id);
    // Tab stays in the card.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press("Tab");
      expect(
        await page.evaluate(() => !!document.activeElement?.closest('[data-part="card"]')),
        `focus after ${i + 1} Tab`,
      ).toBe(true);
    }
    await page.keyboard.press("Escape");
    await expect(page.locator(TOUR)).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem("graphiq:welcomed"))).toBe("1");
  });

  test("Help ▸ Interactive tour takes it again, from the start", async ({ app }) => {
    await app.page.evaluate(() => window.graphiq!.run("help-tour"));
    await expect(app.page.locator(TOUR)).toBeVisible();
    await app.page.waitForTimeout(SETTLE);
    expect((await shot(app.page))!.id).toBe("welcome");
    await app.page.keyboard.press("Escape");
    await expect(app.page.locator(TOUR)).toHaveCount(0);
  });

  test.describe("with motion reduced", () => {
    test.use({ contextOptions: { reducedMotion: "reduce" } });

    test("it lands at once and leaves at once", async ({ page }) => {
      await firstRun(page);
      /* Read in the same task as the key: once React has committed (a few
         microtasks), the spotlight must already be round the top bar. Any
         transition at all — even the global rule's 0.01ms — would still
         report where it came from until the next frame. */
      const landed = await page.evaluate(async () => {
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        for (let i = 0; i < 5; i++) await Promise.resolve();
        const h = document.querySelector('[data-part="spotlight"]')!.getBoundingClientRect();
        const t = document.querySelector('[data-tour="topbar"]')!.getBoundingClientRect();
        return {
          step: document.querySelector('[data-phase="in"]')?.getAttribute("data-step"),
          dy: Math.abs(h.bottom - (t.bottom + 6)),
        };
      });
      expect(landed.step, "the stop changed").toBe("topbar");
      expect(landed.dy, "and the spotlight is already round the top bar, in the same frame").toBeLessThan(1.5);
      await page.waitForTimeout(60);
      const s = (await shot(page))!;
      expect(s.target).toBe("topbar");
      expect(s.panes, "and no outgoing stop lingers").toBe(1);
      await page.keyboard.press("Escape");
      await page.waitForTimeout(60);
      expect(await page.locator(TOUR).count(), "gone without an exit to watch").toBe(0);
    });
  });
});

/* A tablet walks the desktop lap, but its dock is a closed drawer and it has
   no Export button in the bar. Those stops are left out rather than shown
   pointing at nothing — or, worse, shown as a centred card that talks about
   chrome it does not point at. */
test.describe("on a tablet", () => {
  test.use({ viewport: { width: 768, height: 1024 }, hasTouch: true, isMobile: true });

  test("a stop whose chrome is not on screen is skipped, not shown empty", async ({ page }) => {
    const errors = await firstRun(page);
    const { lap } = await walk(page);
    const ids = lap.map((s) => s.id!);
    expect(ids.filter((id) => !TOUR_STEPS.some((s) => s.id === id)), "only the desktop lap's stops").toEqual([]);
    expect(TOUR_STEPS.map((s) => s.id).filter((id) => !ids.includes(id)), "skipped").toEqual(["dock", "export"]);
    for (const s of lap) {
      const step = TOUR_STEPS.find((t) => t.id === s.id)!;
      if (step.target) expect([s.id, s.target], "spotlit on its own chrome").toEqual([s.id, step.target]);
      else expect(s.centred, `${s.id} is centred`).toBe(true);
      expect(s.segs, "the progress bar counts the lap it walks").toBe(lap.length);
    }
    expect(errors).toEqual([]);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("its own lap spotlights only chrome that is on screen, with a card a finger can use", async ({ page }) => {
    const errors = await firstRun(page);
    /* The start card waits for the tour: it blurs the stage the tour points at. */
    await expect(page.locator("[data-startcard]")).toHaveCount(0);
    const { lap, closed } = await walk(page);
    expect(lap.map((s) => s.id), "the phone's own lap, every stop of it").toEqual(MOBILE_TOUR_STEPS.map((s) => s.id));
    const targeted = lap.filter((s) => !s.centred);
    expect(targeted.length, "more than a couple of spotlights").toBeGreaterThanOrEqual(6);
    expect(targeted.filter((s) => s.onScreen < 0.5).map((s) => s.title), "no spotlight over empty space").toEqual([]);
    expect(targeted.filter((s) => !s.target).map((s) => s.title), "every one drawn round real chrome").toEqual([]);
    /* Named, because "on screen" alone passed the panels sheet: its visible
       strip was the dock bar, a different control from the one it named. */
    expect(
      targeted
        .filter((s) => ["toolbar", "dock", "status"].includes(s.target!))
        .map((s) => `${s.title} → ${s.target}`),
      "none of them is chrome the phone hides",
    ).toEqual([]);
    expect(lap.filter((s) => !s.cardFully).map((s) => s.title), "the card is on screen at every stop").toEqual([]);
    expect(
      lap.flatMap((s) => s.buttons.filter((b) => b.h < 44 || b.w < 44)).map((b) => `${b.label} ${b.w}×${b.h}`),
      "its buttons are sized for a finger",
    ).toEqual([]);
    expect([lap[0].centred, lap[lap.length - 1].centred], "it opens and closes on a centred card").toEqual([
      true,
      true,
    ]);
    /* ...and every stop between them that has a target spotlights it: a target
       gone missing renders as a centred card, invisible to every geometric
       check above (deleting `data-tour="mobilestatus"` passed them all). */
    expect(
      lap.filter((s, i) => !!MOBILE_TOUR_STEPS[i].target === s.centred).map((s) => s.title),
      "every stop with a target spotlights it",
    ).toEqual([]);
    expect(lap.filter((s) => s.segs !== lap.length).length, "the progress bar counts this lap").toBe(0);
    /* The touch shell's 44px floor for buttons would make nine segments 396px
       of a 366px card. */
    expect(lap.filter((s) => !s.segsFit).map((s) => s.id), "...and fits in the card").toEqual([]);
    /* The bottom bar is the whole foot of the screen; its ring goes round the
       dock pill floating in it, not along the screen's edges. */
    expect(lap.find((s) => s.id === "mobilebar")!.spot, "the bottom bar's spotlight rings its pill").toBe(true);
    expect(closed, "pressing on through it ends the tour").toBe(true);
    await expect(page.locator("[data-startcard]"), "...and the start card takes over").toHaveCount(1);
    expect(errors, "no page or console errors").toEqual([]);
  });

  test("the bottom bar try-it: a tap on a tool, and only the tools", async ({ page }) => {
    await firstRun(page);
    await goTo(page, "mobilebar");
    // The grid opens the tools sheet, which would come up under the tour.
    const gridBlocked = await page.evaluate(() => {
      const b = [...document.querySelectorAll('[data-tour="mobilebar"] button')].find(
        (e) => e.textContent?.trim() === "Tools",
      )!;
      const r = b.getBoundingClientRect();
      return !!document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)?.closest(
        '[aria-label="Interactive tour"]',
      );
    });
    expect(gridBlocked, "the grid is behind the dim").toBe(true);
    await page.locator('[data-quick="move"]').tap();
    await page.waitForTimeout(300);
    await expect(page.locator('[data-quick="move"]')).toHaveAttribute("aria-pressed", "true");
    expect(await tryDone(page)).toBe("true");
  });

  test("a swipe across the card turns the page, either way", async ({ page }) => {
    await firstRun(page);
    const swipe = (dx: number) =>
      page.evaluate((d) => {
        const card = document.querySelector('[data-part="card"]')!;
        const r = card.getBoundingClientRect();
        const y = r.top + r.height / 2;
        const x = r.left + r.width / 2 - d / 2;
        const ev = (type: string, cx: number) =>
          new PointerEvent(type, { bubbles: true, pointerId: 7, pointerType: "touch", clientX: cx, clientY: y });
        card.dispatchEvent(ev("pointerdown", x));
        card.dispatchEvent(ev("pointerup", x + d));
      }, dx);
    await swipe(-140);
    await page.waitForTimeout(SETTLE);
    expect((await shot(page))!.id).toBe("topbar");
    await swipe(-140);
    await page.waitForTimeout(SETTLE);
    expect((await shot(page))!.id).toBe("mobilebar");
    await swipe(140);
    await page.waitForTimeout(SETTLE);
    expect((await shot(page))!.id).toBe("topbar");
    // A short or mostly-vertical drag is not a swipe.
    await swipe(-20);
    await page.waitForTimeout(SETTLE);
    expect((await shot(page))!.id).toBe("topbar");
  });
});
