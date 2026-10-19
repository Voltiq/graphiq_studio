/**
 * The brush-style shortcuts reach every painting tool the Shortcuts dialog
 * lists them for: `[` / `]` size, `{` / `}` hardness, digits opacity.
 *
 * Until v2.6.10 only blur, smudge, history, clone, dodge, sponge and quick
 * selection had them. The Brush itself — and the eraser, pencil, mixer, heal
 * and red eye — did nothing on `[` / `]`, while the dialog promised they would.
 * Two rails pressed `]` to enlarge the brush for years and painted at the
 * default size every time. The step arithmetic is unit-tested in
 * tests/brush-keys.test.ts; this proves the wiring, one tool at a time.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 1500, height: 950 } });

/** Choose a tool by its rail slot, opening the slot's flyout if it is not
 *  the one showing. */
const pick = (app: App, name: string) => app.pickTool(name);

const option = (app: App, label: string) =>
  app.page.locator(`[data-tour="options"] input[type="range"][aria-label="${label}"]`).first();

async function press(app: App, key: string, times = 1): Promise<void> {
  await app.parkMouse();
  for (let i = 0; i < times; i++) await app.page.keyboard.press(key);
  await app.settle(300);
}

/** name, its slider range, and whether it has hardness / opacity to set. */
const TOOLS: [string, { min: number; max: number; hardness: boolean; opacity: boolean }][] = [
  ["Brush", { min: 1, max: 500, hardness: true, opacity: true }],
  ["Eraser", { min: 1, max: 500, hardness: true, opacity: true }],
  ["Pencil", { min: 1, max: 500, hardness: false, opacity: true }],
  ["Mixer brush", { min: 1, max: 500, hardness: true, opacity: false }],
  ["Spot heal", { min: 4, max: 300, hardness: true, opacity: false }],
  ["Red eye", { min: 6, max: 200, hardness: false, opacity: false }],
];

for (const [name, t] of TOOLS) {
  test(`${name}: [ and ] resize it, within its range`, async ({ app }) => {
    await pick(app, name);
    const size = option(app, "Size");
    await expect(size, `${name} shows a Size slider`).toHaveCount(1);
    await app.setRange("Size", 100);
    await app.settle(200);
    await press(app, "]");
    expect(Number(await size.inputValue()), "] grows it by a tenth").toBe(Math.min(t.max, 110));
    await press(app, "[", 2);
    expect(Number(await size.inputValue()), "[ shrinks it").toBeLessThan(110);
    await press(app, "[", 80);
    // The READOUT, not the slider: a range input clamps what it shows to its
    // own min, so it reads 4 even while the tool's state has gone to 1.
    const readout = size.locator("xpath=..").locator('[role="button"]').first();
    await expect(readout, "...but never below the slider's minimum").toHaveText(`${t.min}px`);
  });

  if (t.hardness)
    test(`${name}: { and } change its hardness`, async ({ app }) => {
      await pick(app, name);
      await app.setRange("Hardness", 50);
      await app.settle(200);
      await press(app, "}");
      expect(await option(app, "Hardness").inputValue()).toBe("60");
      await press(app, "{", 2);
      expect(await option(app, "Hardness").inputValue()).toBe("40");
    });

  if (t.opacity)
    test(`${name}: a digit sets its opacity`, async ({ app }) => {
      await pick(app, name);
      await press(app, "4");
      expect(await option(app, "Opacity").inputValue()).toBe("40");
      await press(app, "0");
      expect(await option(app, "Opacity").inputValue()).toBe("100");
    });
}

test("the pencil stays hard: { and } leave it alone", async ({ app }) => {
  await pick(app, "Pencil");
  await expect(option(app, "Hardness"), "the pencil shows no hardness").toHaveCount(0);
  await press(app, "{", 3);
  await press(app, "]"); // a change the prefs save is sure to see
  await app.settle(600); // the tool-prefs save is debounced 250 ms
  const saved = await app.page.evaluate(() => JSON.parse(localStorage.getItem("graphiq:tool-settings") ?? "{}"));
  expect(saved.pencil?.hardness, "its hardness is still 100").toBe(100);
});
