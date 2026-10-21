/**
 * The onboarding tour, walked end to end on a phone and on a desktop.
 * (Ported from tools/verify-tour.js, TODO 2.1.)
 *
 * A first-run phone user was shown empty rectangles: three of the desktop
 * lap's six spotlights pointed at nothing at 390×844 — the tool drawer parked
 * off-screen, the panels sheet below the fold (its one visible strip WAS the
 * dock bar, so "Panels" highlighted the bottom bar), the status bar hidden.
 * The phone walks its own lap now, over chrome that is always on screen.
 *
 * Each spotlight is checked against LIVE chrome rather than a copy of the step
 * list: some `[data-tour]` element's rect, padded, must be the hole. If none
 * is, the tour is highlighting empty space — stated without knowing the
 * itinerary. This spec drives a plain page: the `app` fixture dismisses the
 * tour, which is the one thing this must not do.
 */
import type { Page } from "@playwright/test";
import { test, expect } from "./fixtures";

const PAD = 6; // TourOverlay's spotlight padding

type Shot = {
  title: string;
  dots: number;
  centred: boolean;
  onScreen: number;
  target: string | null;
  cardFully: boolean;
  buttons: { label: string; w: number; h: number }[];
};

/** One step: what is spotlit, which chrome it matches, where the card is. */
const shot = (page: Page) =>
  page.evaluate((pad): Shot | null => {
    const blanket = document.querySelector('div[aria-label="Interactive tour"]');
    if (!blanket) return null;
    const hr = blanket.querySelector('[class*="hole"]')!.getBoundingClientRect();
    const card = blanket.querySelector('[class*="card"]')!;
    const cr = card.getBoundingClientRect();
    /* On-screen area — not width × height, which counts a drawer parked off
       the side as a healthy spotlight; and as a FRACTION, because the 6px
       padding lets a parked drawer poke a sliver in. */
    const visible =
      Math.max(0, Math.min(hr.right, innerWidth) - Math.max(hr.left, 0)) *
      Math.max(0, Math.min(hr.bottom, innerHeight) - Math.max(hr.top, 0));
    const near = (a: number, b: number) => Math.abs(a - b) <= 1.5;
    const matched = [...document.querySelectorAll("[data-tour]")].find((e) => {
      const r = e.getBoundingClientRect();
      return near(r.left - pad, hr.left) && near(r.top - pad, hr.top) && near(r.width + pad * 2, hr.width) && near(r.height + pad * 2, hr.height);
    });
    return {
      title: card.querySelector('[class*="title"]')?.textContent?.trim() ?? "",
      /* Children of `.dots`: a loose `[class*="dot"]` counts the container too. */
      dots: blanket.querySelector('[class*="dots"]')?.childElementCount ?? -1,
      /* A centred step has no target: the hole collapses to a point. */
      centred: hr.width === 0 && hr.height === 0,
      onScreen: hr.width * hr.height > 0 ? visible / (hr.width * hr.height) : 0,
      target: matched?.getAttribute("data-tour") ?? null,
      cardFully: cr.left >= 0 && cr.top >= 0 && cr.right <= innerWidth && cr.bottom <= innerHeight,
      buttons: [...card.querySelectorAll("button")].map((b) => ({
        label: b.textContent!.trim(),
        w: Math.round(b.getBoundingClientRect().width),
        h: Math.round(b.getBoundingClientRect().height),
      })),
    };
  }, PAD);

/** A first run greets itself with the tour; walk the whole lap. */
async function walk(page: Page) {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
  await page.goto("/", { waitUntil: "domcontentloaded" });
  await page.waitForSelector('div[aria-label="Interactive tour"]', { timeout: 30_000 });
  await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
  await page.waitForTimeout(900);
  const lap: Shot[] = [];
  for (let i = 0; i < 20; i++) {
    const s = await shot(page);
    if (!s) break;
    lap.push(s);
    await page.locator('div[aria-label="Interactive tour"] button', { hasText: /^(Take the tour|Next|Done)$/ }).last().click();
    await page.waitForTimeout(600);
  }
  return { lap, errors, closed: (await shot(page)) === null };
}

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("its own lap spotlights only chrome that is on screen, with a card a finger can use", async ({ page }) => {
    const { lap, errors, closed } = await walk(page);
    const titles = lap.map((s) => s.title).join(" → ");
    expect(lap.length, `the phone's own, shorter lap: ${titles}`).toBeGreaterThanOrEqual(5);
    expect(lap.length).toBeLessThanOrEqual(7);
    const targeted = lap.filter((s) => !s.centred);
    expect(targeted.length, "more than a couple of spotlights").toBeGreaterThanOrEqual(4);
    expect(targeted.filter((s) => s.onScreen < 0.5).map((s) => s.title), "no spotlight over empty space").toEqual([]);
    expect(targeted.filter((s) => !s.target).map((s) => s.title), "every one drawn around real chrome").toEqual([]);
    /* Named, because "on screen" alone passed the panels sheet: its visible
       strip was the dock bar, a different control from the one it named. */
    expect(
      targeted.filter((s) => ["toolbar", "dock", "status"].includes(s.target!)).map((s) => `${s.title} → ${s.target}`),
      "none of them is chrome the phone hides",
    ).toEqual([]);
    expect(lap.filter((s) => !s.cardFully).map((s) => s.title), "the card is on screen at every step").toEqual([]);
    expect(
      lap.flatMap((s) => s.buttons.filter((b) => b.h < 44 || b.w < 22)).map((b) => `${b.label} ${b.w}×${b.h}`),
      "its buttons are sized for a finger",
    ).toEqual([]);
    expect([lap[0].centred, lap[lap.length - 1].centred], "it opens and closes on a centred card").toEqual([true, true]);
    /* ...and nothing between them is: a target gone missing renders as a
       centred card, invisible to every geometric check above (deleting
       `data-tour="mobilestatus"` passed them all until this). */
    expect(lap.slice(1, -1).filter((s) => s.centred).map((s) => s.title), "every step between spotlights something").toEqual([]);
    expect(lap.filter((s) => s.dots !== lap.length).length, `the dots count this lap: ${lap[0].dots} for ${lap.length}`).toBe(0);
    expect(closed, "pressing on through it ends the tour").toBe(true);
    expect(errors, "no page or console errors").toEqual([]);
  });
});

test.describe("on a desktop", () => {
  test.use({ viewport: { width: 1400, height: 900 } });

  test("the desktop lap is untouched, and every spotlight lands on chrome", async ({ page }) => {
    const { lap, errors } = await walk(page);
    expect(lap.length, lap.map((s) => s.title).join(" → ")).toBe(8);
    const targeted = lap.filter((s) => !s.centred);
    expect(targeted.filter((s) => s.onScreen < 0.5 || !s.target).map((s) => s.title), "every spotlight lands on chrome").toEqual([]);
    expect(
      ["toolbar", "dock", "status"].filter((t) => !targeted.some((s) => s.target === t)),
      "including the three the phone drops",
    ).toEqual([]);
    expect(errors, "no page or console errors").toEqual([]);
  });
});
