/**
 * Smoke: the one journey that has to work or nothing else matters. Boot, paint,
 * undo and redo, save the project, open it back, export a PNG — and survive a
 * crash. Every other spec checks one subsystem in depth; this checks that the
 * subsystems are still joined together. (Ported from tools/smoke.js, TODO 2.1.)
 *
 * IT ASSERTS OUTCOMES, NOT STEPS. "Clicked Save and no exception" is worth
 * nothing — the interesting failures are a project that saves but restores a
 * blank canvas, or an export that writes a valid PNG of the wrong thing. So the
 * pixels are hashed before saving and again after re-opening, and the exported
 * PNG is decoded and compared with the canvas it came from.
 *
 * The checks are SOFT within a leg, so a broken leg reports every check it
 * trips, not just the first. That is what the mutation record below relies on.
 *
 * PROVEN TO FAIL, in the right place. Three legs were broken one at a time
 * (in the script this was ported from), and each tripped exactly the checks
 * that cover it:
 *
 *   export at half scale      -> "at the document's size", "of the right picture"
 *   save drops layer pixels   -> the PNG-payload check, the round-trip hash,
 *                                and the export picture (the reopened doc is blank)
 *   the undo action removed   -> "undo takes the stroke back off"
 *
 * The undo mutant was applied to the MENU action while the test presses Ctrl+Z
 * — it still failed, because both routes go through the one shortcut registry.
 *
 * A HARNESS TRAP WORTH KEEPING. A `selectOption` that cannot match blocks for
 * the full default timeout; with a download waiter already ticking, that once
 * read as "export is broken" for 30 s while export was working perfectly. So
 * locators that might not match carry short, explicit timeouts.
 */
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { test, expect, type App } from "./fixtures";

/* No File System Access pickers: the download / <input type=file> route. */
test.use({ filePickers: false });

const DOC_W = 400;
const DOC_H = 300;
/** The crash leg uses its own size so its recovery file is unmistakable. */
const CRASH_W = 260;
const CRASH_H = 180;

/** File ▸ New at a given size. */
async function newDocument(app: App, w: number, h: number): Promise<void> {
  await app.menu("File", "New…");
  const nd = app.page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.waitFor({ timeout: 8_000 });
  await nd.locator('input[type="number"]').nth(0).fill(String(w));
  await nd.locator('input[type="number"]').nth(1).fill(String(h));
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_400);
}

/** A diagonal brush stroke across the view, between two fractional points. */
async function stroke(app: App, from: [number, number], to: [number, number], steps: number): Promise<void> {
  const b = await app.canvasBox();
  await app.page.mouse.move(b.x + b.width * from[0], b.y + b.height * from[1]);
  await app.page.mouse.down();
  await app.page.mouse.move(b.x + b.width * to[0], b.y + b.height * to[1], { steps });
  await app.page.mouse.up();
  await app.settle(900);
}

const layerRows = (app: App) => app.page.locator('li[class*="layerItem"]').count();
const openProject = (app: App, path: string) =>
  app.page.locator('input[type="file"][accept*="gproj"]').setInputFiles(path);

test("boot, paint, undo, save, reopen, export", async ({ app }, info) => {
  const { page } = app;

  await test.step("boot", async () => {
    expect.soft(await page.locator('aside[aria-label="Tools"]').count(), "the tool rail").toBeGreaterThan(0);
    expect.soft(await page.locator('[data-tour="options"]').count(), "the options bar").toBeGreaterThan(0);
    expect.soft(app.consoleErrors, "nothing logged an error during boot").toEqual([]);
  });

  await test.step("a new document", async () => {
    await newDocument(app, DOC_W, DOC_H);
    const blank = await app.stableViewShot();
    expect.soft([blank.w, blank.h], "a new document is the size asked for").toEqual([DOC_W, DOC_H]);
    expect.soft(blank.ink, "...and starts empty").toBe(0);
  });

  const painted = await test.step("paint", async () => {
    await page.getByRole("button", { name: "Brush", exact: true }).click();
    await app.settle(300);
    for (let i = 0; i < 12; i++) await page.keyboard.press("]");
    await stroke(app, [0.2, 0.3], [0.8, 0.7], 24);
    const shot = await app.stableViewShot();
    expect(shot.ink, "painting puts pixels on the canvas").toBeGreaterThan(500);
    expect.soft(await layerRows(app), "...on a layer the panel shows").toBe(1);
    return shot;
  });

  await test.step("undo / redo", async () => {
    const b = await app.canvasBox();
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
    await app.key("Control+z");
    expect.soft((await app.stableViewShot()).ink, "undo takes the stroke back off").toBe(0);
    await app.key("Control+Shift+z");
    // Byte-identical, not merely "ink is back": a redo that re-rasterized the
    // stroke slightly differently would pass the weaker check.
    expect.soft((await app.stableViewShot()).hash, "redo restores it exactly").toBe(painted.hash);
  });

  const projPath = await test.step("save", async () => {
    const saved = page.waitForEvent("download", { timeout: 20_000 });
    await app.menu("File", "Save as…");
    const sa = page.locator('div[role="dialog"][aria-label="Save project as"]');
    await sa.waitFor({ timeout: 8_000 });
    await sa.locator('input[aria-label="File name"]').fill("smoke-doc");
    await sa.getByText("Save", { exact: true }).click();
    const dl = await saved;
    const path = info.outputPath(dl.suggestedFilename() || "smoke.gproj");
    await dl.saveAs(path);
    expect.soft(statSync(path).size, "saving writes a project file").toBeGreaterThan(1_000);
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    expect.soft(
      { layers: !!parsed.layers, w: parsed.width, h: parsed.height },
      "...that is valid JSON with the document in it",
    ).toEqual({ layers: true, w: DOC_W, h: DOC_H });
    const payloads = (JSON.stringify(parsed).match(/data:image\/png/g) ?? []).length;
    expect.soft(payloads, "...carrying the layer's pixels, not just its metadata").toBeGreaterThan(0);
    return path;
  });

  await test.step("open it back", async () => {
    // Into a DIFFERENT document, so a pass cannot come from the file never
    // having been read: the restored one has to arrive as a new tab.
    await newDocument(app, 120, 90);
    const decoy = await app.stableViewShot();
    expect([decoy.w, decoy.h], "a second, different document is active").toEqual([120, 90]);

    await openProject(app, projPath);
    await app.settle(2_500);
    const reopened = await app.stableViewShot();
    expect.soft([reopened.w, reopened.h], "opening the project restores the document").toEqual([DOC_W, DOC_H]);
    expect.soft(reopened.hash, `...with the very same pixels (ink ${painted.ink} vs ${reopened.ink})`).toBe(
      painted.hash,
    );
    expect.soft(await layerRows(app), "...and its layer").toBe(1);
  });

  await test.step("export", async () => {
    await app.menu("File", "Export as…");
    const ex = page.locator('div[role="dialog"][aria-label="Export image"]');
    await ex.waitFor({ timeout: 8_000 });
    const fmt = ex.locator('select[aria-label="Format"]');
    if ((await fmt.inputValue()) !== "png") await fmt.selectOption("png", { timeout: 5_000 });
    await ex.locator('input[aria-label="File name"]').fill("smoke-export", { timeout: 5_000 });
    const exported = page.waitForEvent("download", { timeout: 30_000 });
    await ex.getByText("Export", { exact: true }).click();
    const dl = await exported;
    const pngPath = info.outputPath(dl.suggestedFilename() || "smoke.png");
    await dl.saveAs(pngPath);
    const png = readFileSync(pngPath);
    expect([...png.subarray(0, 4)], "exporting writes a PNG").toEqual([0x89, 0x50, 0x4e, 0x47]);
    // The IHDR width/height are bytes 16..23 — enough to prove the export is of
    // THIS document and not, say, the 120x90 decoy.
    expect.soft([png.readUInt32BE(16), png.readUInt32BE(20)], "...at the document's size").toEqual([
      DOC_W,
      DOC_H,
    ]);
    const ink = await page.evaluate(async (bytes) => {
      const bmp = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext("2d")!;
      x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
      return n;
    }, [...png]);
    expect
      .soft(Math.abs(ink - painted.ink), `...and of the right picture (exported ${ink} px vs canvas ${painted.ink})`)
      .toBeLessThanOrEqual(painted.ink * 0.02);
  });

  expect(app.consoleErrors, "no console errors across the whole journey").toEqual([]);
});

/* Its own test, because it destroys the editor on purpose. The promise is not
   "a dialog appears" but "work that existed only in memory comes back off the
   disk", so the recovered file is opened and its pixels compared. */
test("a crash loses nothing that was open", async ({ app }, info) => {
  const { page } = app;
  test.skip(
    (await page.evaluate(() => typeof (window as unknown as { __gqCrash?: unknown }).__gqCrash)) !== "function",
    "the crash probe is stripped from production builds",
  );

  // A document at a size nothing else uses, so the recovered file is
  // identifiable without relying on names, which tabs can share. With the
  // document the app opened on, two are open: recovery writes ONE zip.
  await newDocument(app, CRASH_W, CRASH_H);
  await page.getByRole("button", { name: "Brush", exact: true }).click();
  await app.settle(300);
  await stroke(app, [0.25, 0.6], [0.75, 0.25], 18);
  const beforeCrash = await app.stableViewShot();
  expect(beforeCrash.w, "the crash document is on screen").toBe(CRASH_W);
  expect(beforeCrash.ink, "there is unsaved work to lose").toBeGreaterThan(300);

  const recovered: string[] = [];
  page.on("download", async (d) => {
    try {
      const p = info.outputPath(d.suggestedFilename());
      await d.saveAs(p);
      recovered.push(p);
    } catch {
      /* the context is going away */
    }
  });
  await page.evaluate(() => (window as unknown as { __gqCrash: () => void }).__gqCrash());
  const crash = page.locator('div[role="alertdialog"][aria-label="Graphiq has stopped"]');
  await expect(crash, "a deliberate crash raises the recovery screen").toHaveCount(1);
  expect.soft(await page.locator('[data-tour="canvas"]').count(), "...and the editor is gone").toBe(0);
  const offered = (await crash.innerText()).replace(/\s+/g, " ");
  expect.soft(offered, "...offering the live documents").toMatch(/\d+ documents? can be saved/);
  expect.soft(offered, "...rather than a stale autosave").not.toMatch(/autosave/);

  await crash.getByText(/^Save recovery copy/).click();
  await expect.poll(() => recovered.length, { message: "saving the recovery copy writes a file" }).toBe(1);
  // One archive rather than a burst of downloads: browsers throttle or block a
  // page that fires several in a row (one run wrote five documents, the next two).
  expect(recovered[0], "...as a single archive").toMatch(/\.zip$/);
  await expect(crash, "the button confirms what it did").toContainText(/Saved \d+ documents?/);

  // The archive uses the store method, so walking the local file headers gets
  // each document back out — and proves the headers are well formed.
  const zip = readFileSync(recovered[0]);
  expect([zip[0], zip[1]], "a real zip").toEqual([0x50, 0x4b]);
  const entries: { name: string; data: Buffer }[] = [];
  for (let o = 0; o + 30 <= zip.length && zip.readUInt32LE(o) === 0x04034b50; ) {
    const size = zip.readUInt32LE(o + 18);
    const nameLen = zip.readUInt16LE(o + 26);
    const extraLen = zip.readUInt16LE(o + 28);
    const at = o + 30 + nameLen + extraLen;
    entries.push({ name: zip.subarray(o + 30, o + 30 + nameLen).toString("utf8"), data: zip.subarray(at, at + size) });
    o = at + size;
  }
  expect(entries.map((e) => e.name), "one entry per open document").toHaveLength(2);
  expect(entries.every((e) => e.data.length > 0), "every entry has a body").toBe(true);
  const lost = entries.find((e) => {
    try {
      const j = JSON.parse(e.data.toString("utf8"));
      return j.width === CRASH_W && j.height === CRASH_H;
    } catch {
      return false;
    }
  });
  expect(lost, "...including the document that was on screen").toBeTruthy();

  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 60_000 });
  await app.settle(1_500);
  for (let i = 0; i < 3 && (await page.locator('div[role="dialog"]').count()); i++) {
    await app.key("Escape"); // any restore prompt: compare against the FILE
  }
  const extracted = info.outputPath("extracted.gproj");
  writeFileSync(extracted, lost!.data);
  await openProject(app, extracted);
  await app.settle(2_500);
  const back = await app.stableViewShot();
  expect([back.w, back.h], "it opens back at its size").toEqual([CRASH_W, CRASH_H]);
  // A hash, not an ink count: ink once matched while the colour was wrong.
  expect(back.hash, `...pixel for pixel (ink ${beforeCrash.ink} vs ${back.ink})`).toBe(beforeCrash.hash);
});
