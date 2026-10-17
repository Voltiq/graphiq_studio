/**
 * Switching tabs finishes what is open in the tab you leave — in THAT tab
 * (fixed in v2.6.1).
 *
 * Before: "Hello from A", typed and left open, then a tab switch, left no text
 * layer anywhere. Editor's `setActiveId` gate now commits UI-side edits before
 * the active document changes, and the engine commits a float before parking
 * the old tab's history.
 *
 * MUTATION: drop the gate's commitPendingEdits() and the two text checks fail;
 * drop the float commit from endLiveSessions and the two float checks fail.
 * (Ported from tools/verify-tab-switch-commit.js.)
 */
import { test, expect } from "./fixtures";

test("open text and a pending float are committed in their own tab", async ({ app }) => {
  const a = (await app.docs())[0].id;
  const b = await app.newDoc();
  await app.activate(a);

  // ---- an open text edit ----
  await app.page.keyboard.press("t");
  await app.settle(300);
  const box = await app.canvasBox();
  await app.page.mouse.click(box.x + box.width * 0.3, box.y + box.height * 0.4);
  await app.settle(600);
  await app.page.keyboard.type("Hello from A", { delay: 15 });
  await app.settle(400);
  await expect(app.page.locator("[role=textbox]"), "the text session took the typing").toHaveText("Hello from A");
  await app.activate(b);
  const bNames = await app.layerNames();
  await app.activate(a);
  const aNames = await app.layerNames();
  expect.soft(aNames, "an open text edit lands in its own tab").toContain("Hello from A");
  expect.soft(bNames, "…and not in the tab switched to").toEqual([]);
  await app.parkMouse();
  await app.key("Control+z");
  expect.soft(
    aNames.includes("Hello from A") && !(await app.layerNames()).includes("Hello from A"),
    "…as one undoable step in its own history",
  ).toBe(true);

  // ---- a pending float ----
  await app.page.keyboard.press("v"); // Move tool: arrows nudge the float
  await app.settle(300);
  await app.run("layer-new");
  await app.setForeground("#e0402a");
  await app.page.evaluate(() => window.graphiq!.select([{ x: 100, y: 100, w: 300, h: 200 }]));
  await app.settle(300);
  await app.key("Backspace"); // a 300×200 red block
  await app.run("edit-copy");
  await app.run("edit-paste"); // an in-app copy pastes in place, floating
  for (let i = 0; i < 5; i++) await app.page.keyboard.press("Shift+ArrowRight");
  await app.settle();
  const aFloating = await app.exported(); // the export leaves a pending float out
  await app.activate(b);
  // The VIEW, not the export: a float leaking across would be drawn on screen.
  expect.soft(await app.viewInk(), "the other tab's view is untouched by the float").toBe(0);
  await app.activate(a); // no Enter anywhere: the switch alone must have committed it
  const aAfter = await app.exported();
  expect(aFloating.ink, "the block is the size it was drawn").toBe(60000);
  // Committed where it was put: the block plus its nudge, in whole 200px columns.
  expect.soft(aAfter.ink > 60000 && aAfter.ink % 200 === 0, `a pending float is committed in its own tab (${aAfter.ink} px)`).toBe(true);
  await app.parkMouse();
  await app.key("Control+z");
  expect.soft(
    aAfter.ink > 60000 && (await app.exported()).ink === 60000,
    "…and that commit is the last step of its own history",
  ).toBe(true);
});
