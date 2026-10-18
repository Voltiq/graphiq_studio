/**
 * The dock's DRAG BEHAVIOUR: reordering, tabbed groups, the drop indicator,
 * and the two docks. (Ported from tools/verify-panel-groups.js, TODO 2.1.)
 *
 * REAL DRAGS, and that is the whole point. An earlier version dispatched
 * DragEvents by hand and passed every check while dragging a panel in the
 * browser did nothing at all: a hand-dispatched drop is not a discrete user
 * gesture, so React batched its state updates instead of flushing them
 * mid-dispatch — and the bug lived entirely in that flush. Chromium's own drag
 * is driven here, through real mouse input, held open so the indicator can be
 * read while the pointer is still over a band.
 *
 * Driving it, three things that cost a cycle each:
 *   - Chromium COALESCES dragover. Moving in N steps can leave the last
 *     delivered dragover mid-path, so every aim ends with a one-pixel nudge.
 *   - Chromium AUTO-SCROLLS a scrollable dock while a drag hovers near its
 *     edge, sliding the target out from under a pointer that never moved; a
 *     drop is only delivered where the last dragover was accepted. So the
 *     target is scrolled into view first, and re-aimed once the drag is live.
 *   - The left dock's drop zone only exists WHILE a drag is in progress, so it
 *     is measured mid-drag.
 *
 * Each test builds what it needs in its own page. In the script, cancelling a
 * drag with Escape quietly broke the next drag in the same page (a CDP input
 * artefact, not the app), so it had to run last; a fresh page per test removes
 * the ordering.
 */
import type { Locator, Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

const VIEW_H = 950;
test.use({ viewport: { width: 1500, height: VIEW_H } });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const sectionOf = (page: Page, name: string) =>
  page
    .locator('[data-tour="dock"] section')
    .filter({ has: page.locator(`button[aria-label$="${name}"]`) })
    .first();
const headerOf = (page: Page, name: string) => sectionOf(page, name).locator("header").first();
/** A grouped panel is a TAB, not a section of its own — that is what it is dragged by. */
const tabOf = (page: Page, name: string) =>
  page.locator('[data-tour="dock"] [role="tab"]').filter({ hasText: new RegExp(`^${name}$`) }).first();

const panelNames = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll('[data-tour="dock"] section')].map((s) =>
      (s.querySelector('button[class*="panelCaret"]')?.getAttribute("aria-label") || "?").replace(
        /^(Collapse|Expand)\s+/,
        "",
      ),
    ),
  );

interface DockState {
  sections: number;
  grouped: number;
  tabs: string[][];
  hints: (string | null)[];
  dragging: number;
  stored: { groups?: Record<string, string> } | null;
  bodyText: string;
}
const state = (page: Page) =>
  page.evaluate(
    (): DockState => ({
      sections: document.querySelectorAll('[data-tour="dock"] section').length,
      grouped: document.querySelectorAll('[data-tour="dock"] section[data-grouped]').length,
      tabs: [...document.querySelectorAll('[data-tour="dock"] [role="tablist"]')].map((tl) =>
        [...tl.querySelectorAll('[role="tab"]')].map(
          (b) => (b.textContent || "").trim() + (b.getAttribute("aria-selected") === "true" ? "*" : ""),
        ),
      ),
      hints: [...document.querySelectorAll("[data-drop]")].map((s) => s.getAttribute("data-drop")),
      dragging: document.querySelectorAll('section[data-dragging="true"]').length,
      stored: (() => {
        try {
          return JSON.parse(localStorage.getItem("graphiq:panel-layout") || "{}");
        } catch {
          return null;
        }
      })(),
      bodyText: (() => {
        const b = document.querySelector('[data-tour="dock"] section[data-grouped] [class*="panelBody"]');
        return b ? (b.textContent || "").trim().slice(0, 40) : "";
      })(),
    }),
  );

/** "Panel:kind" so a failure says WHICH panel was marked, not just how. */
const readHint = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll("[data-drop]")]
      .map((s) => {
        const n = (s.querySelector('button[class*="panelCaret"]')?.getAttribute("aria-label") || "?").replace(
          /^(Collapse|Expand)\s+/,
          "",
        );
        return `${n}:${s.getAttribute("data-drop")}`;
      })
      .join(","),
  );

const onScreen = (b: { y: number; height: number } | null) => !!b && b.y > 4 && b.y + b.height < VIEW_H - 4;
/** Box of `loc`, scrolling it into view first if it is off the fold. */
async function reachableBox(page: Page, loc: Locator) {
  let b = await loc.boundingBox().catch(() => null);
  if (onScreen(b)) return b;
  await loc.evaluate((el) => el.scrollIntoView({ block: "nearest" })).catch(() => {});
  await page.waitForTimeout(250);
  b = await loc.boundingBox().catch(() => null);
  return onScreen(b) ? b : null;
}

/**
 * Drag one panel onto a band of another and return what the dock PROMISED
 * while the pointer was there. `where`: "top"/"bottom" (the edge bands that
 * place it on its own either side) or "middle" (make it a tab). `hold` leaves
 * the drag in progress instead of dropping.
 */
async function dragPanel(app: App, from: string, to: string, where: "top" | "bottom" | "middle", hold = false) {
  const { page } = app;
  await sectionOf(page, to).evaluate((el) => el.scrollIntoView({ block: "nearest" }));
  await app.settle(250);
  const fromLoc = (await tabOf(page, from).count()) ? tabOf(page, from) : headerOf(page, from);
  /* Centring the target can push the panel to PICK UP off the fold, and
     boundingBox() answers for those too — the drag would start at a point the
     pointer cannot reach and simply do nothing. */
  const src = await reachableBox(page, fromLoc);
  expect(src, `"${from}" can be reached to pick up`).not.toBeNull();
  const aim = async () => {
    const d = await sectionOf(page, to).boundingBox();
    if (!d) return null;
    return {
      x: d.x + d.width / 2,
      y: where === "top" ? d.y + 4 : where === "bottom" ? d.y + d.height - 4 : d.y + d.height / 2,
    };
  };
  let first = await aim();
  if (first && !(first.y > 4 && first.y < VIEW_H - 4)) {
    // Bringing the source into view can push the target off the other end.
    await sectionOf(page, to).evaluate((el) => el.scrollIntoView({ block: "nearest" }));
    await app.settle(250);
    first = await aim();
  }
  expect(first && first.y > 4 && first.y < VIEW_H - 4, `"${to}"'s ${where} band is on screen`).toBe(true);
  await page.mouse.move(src!.x + src!.width / 2, src!.y + src!.height / 2);
  await page.mouse.down();
  await page.mouse.move(src!.x + src!.width / 2, src!.y - 25, { steps: 4 });
  await page.mouse.move(first!.x, first!.y, { steps: 8 });
  // Re-aim once the drag is live, then nudge to force a fresh dragover there.
  const at = (await aim()) ?? first!;
  await page.mouse.move(at.x, at.y, { steps: 2 });
  await page.mouse.move(at.x + 1, at.y, { steps: 2 });
  await page.mouse.move(at.x, at.y, { steps: 2 });
  await app.settle(220);
  const hint = await readHint(page);
  if (!hold) {
    await page.mouse.up();
    await app.settle(700);
  }
  return hint;
}

/** Toggle a Window-menu row. The menubar sometimes swallows a click that lands
 *  while the previous menu is still closing, hence the retry. */
async function windowMenu(app: App, item: RegExp): Promise<void> {
  const { page } = app;
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Escape");
    await app.settle(250);
    await page.getByText("Window", { exact: true }).first().click();
    const up = await page
      .waitForSelector('[role="menu"]', { timeout: 2_500 })
      .then(() => true)
      .catch(() => false);
    if (up) break;
  }
  await app.settle(200);
  await page.locator('[role="menu"] button').filter({ hasText: item }).first().click({ timeout: 5_000 });
  await app.settle(800);
}

/** Swatches dropped on the middle of Color: the group most tests start from. */
async function groupSwatchesWithColor(app: App): Promise<DockState> {
  const hint = await dragPanel(app, "Swatches", "Color", "middle");
  expect(hint, 'dragging Swatches onto the middle of Color announces "group"').toContain("group");
  const s = await state(app.page);
  expect({ grouped: s.grouped, tabs: s.tabs[0]?.length }, "...and the drop merges them into one frame").toEqual({
    grouped: 1,
    tabs: 2,
  });
  return s;
}

test("the dock starts with no groups", async ({ app }) => {
  const s = await state(app.page);
  expect({ grouped: s.grouped, tablists: s.tabs.length }).toEqual({ grouped: 0, tablists: 0 });
});

test("an edge drop announces 'before' and actually reorders", async ({ app }) => {
  /* The check that could catch every drop silently doing nothing. Both panels
     are near the top on purpose: a target below the fold is never reached. */
  const order0 = await panelNames(app.page);
  const mover = order0[2];
  const hint = await dragPanel(app, mover, order0[0], "top");
  expect(hint, `dragging "${mover}" onto "${order0[0]}"'s top edge`).toContain("before");
  const order1 = await panelNames(app.page);
  expect(order1[0], `${order0.slice(0, 3).join(" > ")}  ->  ${order1.slice(0, 3).join(" > ")}`).toBe(mover);
});

test("a middle drop makes a tab group, persisted under one key", async ({ app }) => {
  const s = await groupSwatchesWithColor(app);
  const key = s.stored?.groups?.color;
  expect(key, `stored ${JSON.stringify(s.stored?.groups)}`).toBeTruthy();
  expect(s.stored?.groups?.swatches, "both members share it").toBe(key);
});

test("clicking a tab selects it, and the body changes with it", async ({ app }) => {
  const { page } = app;
  await groupSwatchesWithColor(app);
  const tabs = page.locator('[data-tour="dock"] [role="tab"]');
  const idx = (await tabs.nth(0).getAttribute("aria-selected")) === "true" ? 1 : 0;
  const wanted = (await tabs.nth(idx).innerText()).trim();
  const bodyBefore = (await state(page)).bodyText;
  await tabs.nth(idx).click();
  await app.settle(700);
  const after = await state(page);
  expect(after.tabs[0], `clicking "${wanted}"`).toContain(`${wanted}*`);
  expect(after.bodyText, "the body changed").not.toBe(bodyBefore);
});

test("hiding a group's active member leaves the other as a plain panel; showing it restores the group", async ({
  app,
}) => {
  /* The frame renders its ACTIVE member, so hiding that one must not take the
     whole group with it. */
  const { page } = app;
  const grouped = await groupSwatchesWithColor(app);
  const active = grouped.tabs[0].find((t) => t.endsWith("*"))!.replace("*", "");
  await windowMenu(app, new RegExp(`^${active}$`));
  const hidden = await state(page);
  expect(hidden.sections, "the other panel stays on screen").toBe(grouped.sections);
  expect({ grouped: hidden.grouped, tablists: hidden.tabs.length }, "...as a plain panel").toEqual({
    grouped: 0,
    tablists: 0,
  });
  await windowMenu(app, new RegExp(`^${active}$`));
  const back = await state(page);
  expect({ grouped: back.grouped, tabs: back.tabs[0]?.length }, "putting it back restores the tab strip").toEqual({
    grouped: 1,
    tabs: 2,
  });
});

test("the grouping survives a reload", async ({ app }) => {
  await groupSwatchesWithColor(app);
  await app.boot(); // a fresh navigation in the same context: the same storage, a cold mount
  const s = await state(app.page);
  expect({ grouped: s.grouped, tabs: s.tabs[0]?.length }).toEqual({ grouped: 1, tabs: 2 });
});

test("a tab leaves its group by an edge drop", async ({ app }) => {
  await groupSwatchesWithColor(app);
  const hint = await dragPanel(app, "Swatches", "Brushes", "top");
  expect(hint, "dragging a grouped panel to another panel's edge").toContain("before");
  const s = await state(app.page);
  expect(s.grouped, "it left the group").toBe(0);
  expect(Object.keys(s.stored?.groups ?? {}), "and nothing is stored as grouped").toEqual([]);
});

test("a panel can move to the left dock, leaving nothing greyed out", async ({ app }) => {
  /* Moving a panel across destroys the node the drag started on, so its own
     `dragend` never arrives; the drag state has to be cleaned up regardless, or
     the panel stays greyed out with the dashed zones showing. */
  const { page } = app;
  const plain = (await panelNames(page)).find((n) => n !== "?") ?? "Navigator";
  const src = await reachableBox(page, headerOf(page, plain));
  expect(src, `"${plain}" can be reached to pick up`).not.toBeNull();
  await page.mouse.move(src!.x + src!.width / 2, src!.y + src!.height / 2);
  await page.mouse.down();
  await page.mouse.move(src!.x + src!.width / 2, src!.y - 25, { steps: 4 });
  await page.mouse.move(400, 400, { steps: 6 });
  const zone = await page.locator('[aria-label="Left dock"] > div').first().boundingBox().catch(() => null);
  expect(zone, "a drop zone appears in the left dock while dragging").not.toBeNull();
  await page.mouse.move(zone!.x + zone!.width / 2, zone!.y + zone!.height / 2, { steps: 6 });
  await page.mouse.move(zone!.x + zone!.width / 2 + 1, zone!.y + zone!.height / 2, { steps: 2 });
  await app.settle(200);
  await page.mouse.up();
  await app.settle(800);
  const after = await page.evaluate(() => ({
    dragging: document.querySelectorAll('section[data-dragging="true"]').length,
    zones: document.querySelectorAll('[aria-label="Left dock"] > div, [data-tour="dock"] > div').length,
    left: document.querySelectorAll('[aria-label="Left dock"] section').length,
  }));
  expect(after.left, `"${plain}" landed in the left dock`).toBeGreaterThan(0);
  expect({ greyed: after.dragging, zones: after.zones }, "nothing is left greyed out or showing a zone").toEqual({
    greyed: 0,
    zones: 0,
  });
});

test("Reset workspace clears the grouping", async ({ app }) => {
  await groupSwatchesWithColor(app);
  await windowMenu(app, /^Reset workspace$/);
  await app.settle(900);
  const s = await state(app.page);
  expect(s.grouped).toBe(0);
  expect(Object.keys(s.stored?.groups ?? {})).toEqual([]);
});

test("the bottom band announces 'after', and cancelling leaves nothing marked", async ({ app }) => {
  const hint = await dragPanel(app, "Color", "Info", "bottom", true);
  expect(hint, "hovering a panel's bottom edge").toContain("after");
  await app.page.keyboard.press("Escape");
  await app.page.mouse.up();
  await app.settle(700);
  const s = await state(app.page);
  expect({ marked: s.hints.length, greyed: s.dragging }).toEqual({ marked: 0, greyed: 0 });
});
