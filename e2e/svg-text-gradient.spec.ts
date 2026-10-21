/**
 * Gradient-filled text exports as a gradient, not a flat colour. (Ported from
 * tools/verify-svg-text-gradient.js, TODO 2.1.)
 *
 * The SVG emitter read the text's SOLID colour and never its gradient: a
 * gradient heading rasterized correctly and exported as one flat colour. The
 * fix is exact rather than close — the canvas renderer and the SVG emitter
 * consume the same 65-sample ramp (`gradientRamp`) and placement
 * (`gradientGeometry`); tests/gradient.test.ts pins their agreement. What this
 * adds: `exportSVG` cannot run in Node (text layout needs a real canvas), so
 * "applied in the UI" to "a paint server in the file" is only observable here.
 * An ANGLE (conic) gradient has no SVG equivalent at all, and keeps the flat
 * colour — the honest option, asserted rather than hidden.
 */
import { readFileSync } from "node:fs";
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 1500, height: 950 } });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** A text layer whose fill is chosen BEFORE it is committed. */
async function makeText(app: App, type: "linear" | "angle", words: string) {
  const { page } = app;
  await app.key("t");
  await page.locator('[data-tour="options"] [data-tip^="Text fill"]').click();
  const pop = page.locator('[role="dialog"][aria-label="Text fill"]');
  await pop.getByRole("button", { name: /^gradient$/i }).click();
  /* The type control renders only once Gradient is picked — and it is a
     Segmented row of buttons, not a <select>. */
  await pop.getByRole("button", { name: new RegExp(`^${type}$`, "i") }).click();
  await page.keyboard.press("Escape");
  await expect(pop).toHaveCount(0);
  const box = await app.canvasBox();
  await page.mouse.click(Math.round(box.x + box.width * 0.25), Math.round(box.y + box.height * 0.5));
  await app.settle(900);
  await page.keyboard.type(words);
  await page.keyboard.press("Control+Enter"); // the desktop commit
  await app.settle(1400);
}

async function exportSvg(app: App) {
  const download = app.page.waitForEvent("download");
  await app.page.evaluate(() => window.graphiq!.run("export-svg"));
  return readFileSync(await (await download).path(), "utf8");
}

test("a linear text gradient exports as a paint server with the canvas's own 65-stop ramp — a conic one is not faked", async ({ app }) => {
  await app.run("layer-new");
  await makeText(app, "linear", "Gradient");
  const svg = await exportSvg(app);
  expect(svg, "an SVG").toContain("<svg");
  expect((svg.match(/<text[\s>]/g) ?? []).length, "the text is in it, so the rest means something").toBeGreaterThanOrEqual(1);
  expect(svg, "a gradient paint server, not a flat colour").toMatch(/<linearGradient\b/);
  expect(svg, "...referenced by the text").toMatch(/fill="url\(#/);
  expect(svg, "...in the document's coordinates, where the raster ramps").toContain('gradientUnits="userSpaceOnUse"');
  /* 65 by construction; a handful would mean something re-derived it. */
  expect((svg.match(/<stop\b/g) ?? []).length, "the full ramp the canvas uses").toBeGreaterThanOrEqual(65);
  expect(svg, "no fill-opacity beside it — the stops carry their alpha").not.toMatch(/fill="url\(#[^"]*"\s+fill-opacity=/);

  await makeText(app, "angle", "Angle");
  const svg2 = await exportSvg(app);
  /* The first block is still linear: one paint server. A second would be the
     conic pretending to be expressible. */
  expect((svg2.match(/<linearGradient\b|<radialGradient\b/g) ?? []).length, "a conic is not faked as a linear").toBeLessThanOrEqual(1);
  expect((svg2.match(/<text[\s>]/g) ?? []).length, "...and both blocks are in a valid file").toBeGreaterThanOrEqual(2);
});
