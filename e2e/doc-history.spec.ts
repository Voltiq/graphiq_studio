/**
 * Every document tab has its own undo history (fixed in v2.5.1).
 *
 * Before: one engine, one undo stack. Paint in tab A, open an untouched tab B,
 * Ctrl+Z — A's stroke was undone off-screen. Each check below looks at the OTHER
 * tab too: "undo did nothing" alone would also pass on an undo that had stopped
 * working. MUTATION: drop CanvasArea's setHistoryDocument layout effect and five
 * of these fail. (Ported from tools/verify-doc-history.js.)
 */
import { test, expect, type App } from "./fixtures";

async function stroke(app: App, fy: number) {
  const b = await app.canvasBox();
  await app.page.getByRole("button", { name: "Brush", exact: true }).click();
  await app.settle(200);
  for (let i = 0; i < 10; i++) await app.page.keyboard.press("]");
  await app.page.mouse.move(b.x + b.width * 0.2, b.y + b.height * fy);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x + b.width * 0.8, b.y + b.height * fy, { steps: 20 });
  await app.page.mouse.up();
  await app.settle(900);
  await app.parkMouse();
}

test("each tab undoes only its own edits", async ({ app }) => {
  await app.expandPanel("History");

  // A: one stroke. B: new and untouched.
  await stroke(app, 0.3);
  const a = (await app.docs())[0].id;
  const aInk = await app.viewInk();
  const aRows = await app.historyRows();
  const b = await app.newDoc();
  const bRows = await app.historyRows();
  expect.soft(aRows.length, "the History panel is readable").toBeGreaterThan(1);
  expect.soft(bRows, "a new tab's History holds only its own origin").toHaveLength(1);

  await app.key("Control+z");
  await app.activate(a);
  expect(aInk, "the stroke in A is real").toBeGreaterThan(500);
  expect.soft(await app.viewInk(), "Ctrl+Z in an untouched tab leaves another tab's stroke alone").toBe(aInk);

  // Two strokes in B, so B's history is longer than A's and a leak changes the count.
  await app.activate(b);
  await stroke(app, 0.6);
  await stroke(app, 0.8);
  const bInk = await app.viewInk();
  await app.activate(a);
  await app.key("Control+z");
  expect.soft(await app.viewInk(), "Ctrl+Z in A undoes A's stroke").toBe(0);
  await app.activate(b);
  expect(bInk).toBeGreaterThan(500);
  expect.soft(await app.viewInk(), "…and not B's").toBe(bInk);
  await app.activate(a);
  await app.key("Control+Shift+z");
  expect.soft(await app.viewInk(), "redo in A brings A's stroke back").toBe(aInk);
  expect.soft(await app.historyRows(), "A's History shows A's steps only").toHaveLength(aRows.length);

  // Close B: A is still undoable.
  await app.activate(b);
  const bName = (await app.docs()).find((d) => d.id === b)!.name;
  await app.page.locator(`[aria-label="Close ${bName}"]`).first().click({ force: true });
  await app.settle();
  expect.soft((await app.docs()).map((d) => d.id), "the second tab closed").toEqual([a]);
  await app.key("Control+z");
  expect.soft(await app.viewInk(), "after closing a tab, the remaining tab still undoes its own step").toBe(0);
});
