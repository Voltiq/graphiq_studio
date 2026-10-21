/**
 * The sample document, "Alpenglow" (Help ▸ Open sample document, and the
 * tour's last stop): painted in the browser, procedurally, into a recipe that
 * tests/sample-doc.test.ts checks without one. Here: that it builds, that its
 * pixels are the picture (sun, sky, snow, shore, type), that its layer comps
 * really turn golden hour into blue hour, and that its type is type.
 */
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";
import { H, HORIZON, SAMPLE_NAME, SUN, W } from "../app/lib/sample-doc";

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

/** Open the sample and wait until its pixels are down (the sun is lit). */
async function openSample(page: Page) {
  await page.evaluate(() => window.graphiq!.run("help-sample"));
  await page.waitForFunction(
    (name) => !!window.graphiq?.docs().some((d) => d.active && d.name === name),
    SAMPLE_NAME,
    { timeout: 15_000 },
  );
  await expect.poll(async () => (await at(page, [[SUN.x, SUN.y]]))[0][0], { timeout: 15_000 }).toBeGreaterThan(230);
}

type RGBA = [number, number, number, number];
const lum = ([r, g, b]: RGBA) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** The exported composite's pixels at these document points. */
const at = (page: Page, points: [number, number][]): Promise<RGBA[]> =>
  page.evaluate(async (pts) => {
    const blob = await window.graphiq!.exportPNG(1);
    const bmp = await createImageBitmap(blob!);
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const ctx = c.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0);
    return pts.map(([x, y]) => [...ctx.getImageData(Math.round(x), Math.round(y), 1, 1).data] as RGBA);
  }, points);

type Region = { x: number; y: number; w: number; h: number };

/** How many pixels of a document region are brighter than `min` luma — or,
 *  with `darker`, darker than it. */
const bright = (page: Page, r: Region, min: number, darker = false) =>
  page.evaluate(
    async ([r, min, darker]) => {
      const blob = await window.graphiq!.exportPNG(1);
      const bmp = await createImageBitmap(blob!);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const ctx = c.getContext("2d")!;
      ctx.drawImage(bmp, 0, 0);
      const d = ctx.getImageData(r.x, r.y, r.w, r.h).data;
      let n = 0;
      for (let i = 0; i < d.length; i += 4) {
        const l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        if (darker ? l < min : l > min) n++;
      }
      return n;
    },
    [r, min, darker] as const,
  );

const tree = (app: App) => app.page.evaluate(() => window.graphiq!.layers());
const flat = async (app: App) => {
  const walk = (ns: { name: string; visible: boolean; children?: unknown[] }[]): { name: string; visible: boolean }[] =>
    ns.flatMap((n) => [n, ...walk((n.children ?? []) as typeof ns)]);
  return walk(await tree(app));
};
const shown = async (app: App, name: string) => (await flat(app)).find((n) => n.name === name)?.visible;

test("Help ▸ Open sample document builds Alpenglow, layer by layer", async ({ app }) => {
  const t0 = Date.now();
  await openSample(app.page);
  const took = Date.now() - t0;
  const top = await tree(app);
  expect(top.map((n) => n.name)).toEqual([
    "Title",
    "Vignette",
    "Blue hour",
    "Golden glow",
    "Evening contrast",
    "Landscape",
  ]);
  expect(top.find((n) => n.name === "Landscape")!.children!.map((n) => n.name)).toEqual([
    "Birds",
    "Shore & pines",
    "Sun on the water",
    "Reflection",
    "Lake",
    "Alpenglow light",
    "Mountains, near",
    "Mountains, far",
    "Sun",
    "Clouds",
    "Stars",
    "Sky",
  ]);
  expect(top.filter((n) => n.type === "adjustment").length).toBe(3);

  // The pixels are the picture.
  const [sun, sky, snow] = await at(app.page, [
    [SUN.x, SUN.y],
    [60, 30],
    [1222, 300],
  ]);
  expect(sun[0], "the sun is lit").toBeGreaterThan(230);
  expect(sun[1]).toBeGreaterThan(190);
  expect(sky[2], "the sky at the top is deep blue").toBeGreaterThan(sky[0]);
  expect(lum(sky)).toBeLessThan(70);
  expect(lum(snow), "snow on the summit").toBeGreaterThan(140);
  // Measured: 97% of this corner is silhouette (26% with the shore hidden);
  // ~10,500 glints under the sun (none without its path on the water).
  const shore = { x: 0, y: 830, w: 500, h: 160 };
  const silhouette = await bright(app.page, shore, 18, true);
  expect(silhouette, "the shore is in silhouette").toBeGreaterThan(shore.w * shore.h * 0.85);
  const path = { x: SUN.x - 150, y: HORIZON + 30, w: 300, h: 250 };
  expect(await bright(app.page, path, 170), "the sun's path glitters on the water").toBeGreaterThan(3000);
  // The type, rasterised by the engine during the load.
  const titleBand = { x: Math.round(W / 2 - 330), y: 90, w: 660, h: 120 };
  expect(await bright(app.page, titleBand, 200), "the title is drawn").toBeGreaterThan(4000);
  console.log(`sample opened and composited in ${took} ms`);
});

test("its layer comps turn golden hour into blue hour, and back", async ({ app }) => {
  await openSample(app.page);
  // The Layer Comps panel is in the dock by default, folded. (Window ▸ Layer
  // Comps TOGGLES it — from there it would hide it.)
  expect(await app.openPanelById("comps"), "the Layer Comps panel opens").toBe(true);
  const apply = (name: string) => app.page.locator(`button[aria-label="Apply ${name}"]`).first().click();
  await expect(app.page.locator('button[aria-label^="Apply "]'), "the sample's four comps are listed").toHaveCount(4);
  // The top of the sky, above the type and the clouds: only stars, if any.
  // (Measured: 0 bright pixels at golden hour, 107 at blue hour.)
  const sky = { x: 0, y: 0, w: W, h: 60 };
  const starsBefore = await bright(app.page, sky, 90);

  await apply("Blue hour");
  await app.settle(800);
  expect(await shown(app, "Stars")).toBe(true);
  expect(await shown(app, "Blue hour")).toBe(true);
  expect([await shown(app, "Sun"), await shown(app, "Sun on the water"), await shown(app, "Golden glow")]).toEqual([
    false,
    false,
    false,
  ]);
  const [sunGone] = await at(app.page, [[SUN.x, SUN.y]]);
  expect(sunGone[0], "the sun has set").toBeLessThan(200);
  expect(starsBefore, "no stars at golden hour").toBe(0);
  expect(await bright(app.page, sky, 90), "the stars are out").toBeGreaterThan(50);

  await apply("Before grading");
  await app.settle(800);
  for (const name of ["Blue hour", "Golden glow", "Evening contrast", "Vignette"])
    expect(await shown(app, name), name).toBe(false);
  expect(await shown(app, "Sun"), "...with the sun back").toBe(true);

  await apply("Photo only");
  await app.settle(800);
  expect(await shown(app, "Title")).toBe(false);

  await apply("Golden hour");
  await app.settle(800);
  expect(await shown(app, "Title")).toBe(true);
  expect(await shown(app, "Stars")).toBe(false);
  expect((await at(app.page, [[SUN.x, SUN.y]]))[0][0], "and it rises again").toBeGreaterThan(230);
});

test("its title is type: double-click it with the Type tool to edit it", async ({ app }) => {
  await openSample(app.page);
  await app.run("view-fit");
  await app.key("t");
  const doc = (await app.page.locator(`canvas[width="${W}"][height="${H}"]`).first().boundingBox())!;
  const s = doc.width / W;
  await app.page.mouse.dblclick(doc.x + (W / 2) * s, doc.y + 150 * s);
  await app.settle(500);
  const box = app.page.locator('[role="textbox"]');
  await expect(box).toBeVisible();
  await expect(box).toContainText("Alpenglow");
  await app.key("Escape");
});

test("opening it is not a step to undo: Undo leaves it whole", async ({ app }) => {
  await openSample(app.page);
  const before = JSON.stringify(await tree(app));
  await app.page.evaluate(() => window.graphiq!.undo());
  await app.settle(500);
  expect(JSON.stringify(await tree(app))).toBe(before);
  expect((await at(app.page, [[SUN.x, SUN.y]]))[0][0]).toBeGreaterThan(230);
});

test.describe("from the tour", () => {
  test("the last stop's Open the sample opens it", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    const tour = page.locator('div[aria-label="Interactive tour"]');
    await tour.waitFor({ timeout: 30_000 });
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    for (let i = 0; i < 12 && !(await tour.getByText("Open the sample", { exact: true }).count()); i++) {
      await page.keyboard.press("ArrowRight");
      await page.waitForTimeout(250);
    }
    await tour.getByText("Open the sample", { exact: true }).click();
    await expect(tour).toHaveCount(0);
    await page.waitForFunction(
      (name) => !!window.graphiq?.docs().some((d) => d.active && d.name === name),
      SAMPLE_NAME,
      { timeout: 15_000 },
    );
  });
});
