/**
 * PRINT SETUP. (Ported from tools/verify-print.js, TODO 2.1.)
 *
 * Printing ends in a native dialog nothing can dismiss, so `print()` is
 * stubbed on the hidden iframe the app builds and the CSS it wrote is read
 * back instead. That is the right thing to assert anyway: the feature is
 * "where does the image land on the sheet", and the answer lives entirely in
 * the generated `@page` rule and image rect.
 *
 * The expected numbers are derived HERE from first principles rather than
 * from the app's layout function, so this cannot agree with a bug:
 *   A4 is 210x297 mm = 595.28 x 841.89 pt (1 pt = 1/72 in)
 *   image mode at N ppi puts a W px image on a (W/N)*72 pt page
 *   fitting a WxH image into a margin box scales by the smaller ratio
 */
import { writeFileSync } from "node:fs";
import type { Page } from "@playwright/test";
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 1500, height: 950 } });

test.afterEach(async ({ app }) => {
  expect(app.consoleErrors, "no console errors").toEqual([]);
});

const DOC_W = 600;
const DOC_H = 300;
const A4: [number, number] = [595.28, 841.89];
const MM = 72 / 25.4;

interface Printed {
  calls: number;
  css: string;
  srcHash: string;
  /** The image sent to the printer, as a data URL. */
  src: string;
}
declare global {
  interface Window {
    __print?: Printed;
  }
}

/* Catch the print iframe as it is appended and neuter print(), keeping the CSS.
 *
 * Hooked on appendChild rather than through a MutationObserver: the observer's
 * callback is a MICROTASK, and on a second print the image data URL is already
 * decoded, so `img.complete` is true the moment src is set and the app calls
 * print() synchronously — before the observer ever runs. The first print
 * looked fine and every one after it escaped to the real print(). appendChild
 * runs in the same tick as the insertion, which is early enough for both.
 * Installed after boot: the iframe only exists once Print is pressed. */
const hookPrint = (page: Page) =>
  page.evaluate(() => {
    window.__print = { calls: 0, css: "", srcHash: "", src: "" };
    const orig = Node.prototype.appendChild;
    Node.prototype.appendChild = function patched<T extends Node>(this: Node, node: T): T {
      const out = orig.call(this, node) as T;
      if (node instanceof HTMLIFrameElement && node.contentWindow) {
        const frame = node;
        node.contentWindow.print = () => {
          const d = frame.contentDocument;
          const p = window.__print!;
          p.calls++;
          p.css = d?.querySelector("style")?.textContent ?? "";
          /* A digest of the PIXELS being sent, so "the proof was applied" is
             checked by the image changing, not by the toggle's own say-so. */
          const src = d?.querySelector("img")?.getAttribute("src") ?? "";
          let h = 0;
          for (let i = 0; i < src.length; i++) h = (Math.imul(h, 31) + src.charCodeAt(i)) >>> 0;
          p.srcHash = `${h.toString(36)}.${src.length}`;
          p.src = src;
        };
      }
      return out;
    };
  });

/** Escape first and retry: a menu left open from a previous step swallows the
 *  click that should open the next one. */
async function menu(app: App, top: string, item: string): Promise<void> {
  const { page } = app;
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press("Escape");
    await app.settle(250);
    await page.getByText(top, { exact: true }).first().click();
    const up = await page
      .waitForSelector('[role="menu"]', { timeout: 2_500 })
      .then(() => true)
      .catch(() => false);
    if (!up) continue;
    await app.settle(200);
    const row = page.locator('[role="menu"] button').filter({ hasText: item }).first();
    if (!(await row.count())) continue;
    await row.click();
    await app.settle(800);
    return;
  }
  throw new Error(`could not open ${top} ▸ ${item}`);
}

/** A 600x300 document (non-square, so a swapped axis cannot hide) carrying a
 *  gradient: transforming transparent pixels changes nothing, so a blank
 *  canvas would make "the proof was applied" unfalsifiable. */
async function makeDocument(app: App): Promise<void> {
  const { page } = app;
  await menu(app, "File", "New…");
  const nd = page.locator('div[role="dialog"][aria-label="New document"]');
  await nd.waitFor({ timeout: 8_000 });
  await nd.locator('input[type="number"]').nth(0).fill(String(DOC_W));
  await nd.locator('input[type="number"]').nth(1).fill(String(DOC_H));
  await nd.getByText("Create", { exact: true }).click();
  await app.settle(1_500);
  await app.run("layer-new");
  const box = await app.canvasBox();
  await page.getByRole("button", { name: /^Gradient/ }).first().click();
  await app.settle(500);
  await page.mouse.move(box.x + 6, box.y + 6);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 6, box.y + box.height - 6, { steps: 10 });
  await page.mouse.up();
  await app.settle(1_100);
  await hookPrint(page);
}

const dialog = (page: Page) => page.locator('div[role="dialog"][aria-label="Print"]');
async function openPrint(app: App) {
  await menu(app, "File", "Print…");
  await dialog(app.page).waitFor({ timeout: 8_000 });
  return dialog(app.page);
}
/** Press the dialog's Print… and return what reached the (stubbed) printer. */
async function doPrint(app: App): Promise<Printed> {
  const { page } = app;
  await page.evaluate(() => Object.assign(window.__print!, { calls: 0, css: "" }));
  await dialog(page).getByText("Print…", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__print!.calls), { message: "printing reached the browser" }).toBe(1);
  return page.evaluate(() => ({ ...window.__print! }));
}
const pageSize = (css: string) => {
  const m = /@page\{size:([\d.]+)pt ([\d.]+)pt/.exec(css);
  return m ? [Number(m[1]), Number(m[2])] : null;
};
const imgRect = (css: string) => {
  const m = /left:([\d.]+)pt;top:([\d.]+)pt;width:([\d.]+)pt;height:([\d.]+)pt/.exec(css);
  return m ? m.slice(1).map(Number) : null;
};

test("File ▸ Print… opens a setup dialog rather than printing at once", async ({ app }) => {
  await makeDocument(app);
  await openPrint(app);
  await expect(dialog(app.page)).toHaveCount(1);
  expect(await app.page.evaluate(() => window.__print!.calls), "nothing printed yet").toBe(0);
});

test("A4 portrait: the image fills the margin box, centred, on a margin-free page", async ({ app }) => {
  await makeDocument(app);
  await openPrint(app);
  const { css } = await doPrint(app);
  const size = pageSize(css)!;
  expect(size[0], "an A4 sheet, in points").toBeCloseTo(A4[0], 0);
  expect(size[1]).toBeCloseTo(A4[1], 0);
  /* 600x300 into A4 portrait minus 10 mm margins: the width binds, so the
     image spans the margin box and is centred. */
  const boxW = A4[0] - 2 * 10 * MM;
  const [x, , w, h] = imgRect(css)!;
  expect(w, "width = the margin box").toBeCloseTo(boxW, 0);
  expect(h, "height = half of it (2:1)").toBeCloseTo(boxW / 2, 0);
  expect(x, "centred").toBeCloseTo((A4[0] - boxW) / 2, 0);
  expect(css, "placement is absolute, so the page carries no margin of its own").toMatch(/@page\{[^}]*margin:0/);
});

test("Landscape swaps the sheet's axes", async ({ app }) => {
  await makeDocument(app);
  const dlg = await openPrint(app);
  await dlg.getByText("Landscape", { exact: true }).click();
  await app.settle(400);
  const size = pageSize((await doPrint(app)).css)!;
  expect(size[0]).toBeCloseTo(A4[1], 0);
  expect(size[1]).toBeCloseTo(A4[0], 0);
});

test("Image size prints at the true size for the document's resolution", async ({ app }) => {
  await makeDocument(app);
  const dlg = await openPrint(app);
  await dlg.getByText("Image size", { exact: true }).click();
  await app.settle(500);
  const shown = (await dlg.locator("p").last().innerText()).replace(/\s+/g, " ");
  expect(shown, "the dialog says what resolution that lands at").toMatch(/\d+ ppi/);
  const size = pageSize((await doPrint(app)).css)!;
  // The document is created at 300 ppi, so 600 px is exactly 2 in = 144 pt.
  expect(size[0]).toBeCloseTo((DOC_W / 300) * 72, 0);
  expect(size[1]).toBeCloseTo((DOC_H / 300) * 72, 0);
});

test("a wider margin shrinks the image", async ({ app }) => {
  const { page } = app;
  await makeDocument(app);
  await openPrint(app);
  const narrow = imgRect((await doPrint(app)).css)!;
  const dlg = await openPrint(app);
  await dlg.getByText("Paper size", { exact: true }).click();
  await app.settle(400);
  const margin = dlg.locator('input[aria-label="Margin"]').first();
  await margin.focus();
  for (let i = 0; i < 10; i++) await page.keyboard.press("ArrowRight");
  const mm = await margin.inputValue();
  const wide = imgRect((await doPrint(app)).css)!;
  expect(wide[2], `a ${mm} mm margin against the 10 mm one`).toBeLessThan(narrow[2] - 1);
});

test("no soft-proof toggle is offered while no proof is set up", async ({ app }) => {
  await makeDocument(app);
  const dlg = await openPrint(app);
  await expect(dlg.locator("text=soft proof")).toHaveCount(0);
});

/* ---- the soft proof on paper ----------------------------------------------
 *
 * A proof is a VIEW transform the browser's print pipeline cannot apply, so to
 * reach paper the pixels have to carry it. It only does anything to colours
 * the target cannot hold, so the document here is a Display P3 image:
 *   left   P3 (0, 204, 102) — outside sRGB, inside Adobe RGB
 *   right  P3 (255, 0, 0)   — outside both
 * and the session works in Display P3.
 *
 * The script this came from printed a black-to-white gradient (all inside
 * sRGB) and checked only that the proof "changed the pixels". It did — but
 * through a bug, not the proof: the print path copied the document into a
 * canvas created without a colour space (so sRGB), and that copy alone clipped
 * every colour to sRGB; the proof then ran on sRGB numbers it took for P3.
 * With an sRGB target that looked right by accident. With Adobe RGB it printed
 * colours Adobe RGB holds as their sRGB clips. */
const GREENISH = [0, 204, 102];

/** The expected sRGB proof of a P3 colour, from first principles: to linear
 *  sRGB, clip, back to P3 (D65 matrices; both spaces use the sRGB curve). */
function sRgbProofOfP3(rgb: number[]): number[] {
  const P3_XYZ = [0.4865709, 0.2656677, 0.1982173, 0.2289746, 0.6917385, 0.0792869, 0, 0.0451134, 1.0439444];
  const XYZ_S = [3.2404542, -1.5371385, -0.4985314, -0.969266, 1.8760108, 0.041556, 0.0556434, -0.2040259, 1.0572252];
  const S_XYZ = [0.4124564, 0.3575761, 0.1804375, 0.2126729, 0.7151522, 0.072175, 0.0193339, 0.119192, 0.9503041];
  const XYZ_P3 = [2.4934969, -0.9313836, -0.4027108, -0.829489, 1.7626641, 0.0236247, 0.0358458, -0.0761724, 0.9568845];
  const mul = (m: number[], v: number[]) => [0, 1, 2].map((r) => m[r * 3] * v[0] + m[r * 3 + 1] * v[1] + m[r * 3 + 2] * v[2]);
  const clip = (v: number[]) => v.map((x) => Math.min(1, Math.max(0, x)));
  const dec = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const enc = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);
  const s = clip(mul(XYZ_S, mul(P3_XYZ, rgb.map((v) => dec(v / 255)))));
  return clip(mul(XYZ_P3, mul(S_XYZ, s))).map((v) => Math.round(enc(v) * 255));
}

/** Open the two-colour P3 image as a document, with the proof switched on. */
async function proofedP3Document(app: App, outPath: string): Promise<void> {
  const { page } = app;
  const b64 = await page.evaluate(async (left) => {
    const c = new OffscreenCanvas(200, 100);
    const g = c.getContext("2d", { colorSpace: "display-p3" })!;
    g.fillStyle = `color(display-p3 ${left.map((v) => v / 255).join(" ")})`;
    g.fillRect(0, 0, 100, 100);
    g.fillStyle = "color(display-p3 1 0 0)";
    g.fillRect(100, 0, 100, 100);
    const u8 = new Uint8Array(await (await c.convertToBlob({ type: "image/png" })).arrayBuffer());
    let bin = "";
    for (const x of u8) bin += String.fromCharCode(x);
    return btoa(bin);
  }, GREENISH);
  writeFileSync(outPath, Buffer.from(b64, "base64"));
  await page.locator('input[data-start-input="open"]').setInputFiles(outPath);
  await app.settle(2_000);
  await hookPrint(page);
  await menu(app, "View", "Proof colors");
  await app.settle(700);
}

/** Print with the proof toggle in the given state; the two pixels, read AS P3. */
async function printProof(app: App, bake: boolean): Promise<{ left: number[]; right: number[] }> {
  const { page } = app;
  const dlg = await openPrint(app);
  await expect(dlg.locator("text=soft proof"), "the proof toggle is offered").not.toHaveCount(0);
  const toggle = dlg.locator('button[role="switch"]').last();
  if ((await toggle.getAttribute("aria-checked")) !== String(bake)) {
    await toggle.click();
    await app.settle(300);
  }
  const { src } = await doPrint(app);
  return page.evaluate(async (url) => {
    const bmp = await createImageBitmap(await (await fetch(url)).blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d", { colorSpace: "display-p3" })!;
    g.drawImage(bmp, 0, 0);
    const at = (x: number) => [...g.getImageData(x, 50, 1, 1, { colorSpace: "display-p3" }).data.slice(0, 3)];
    return { left: at(50), right: at(150) };
  }, src);
}
const near = (a: number[], b: number[]) => a.every((v, i) => Math.abs(v - b[i]) <= 2);

test.describe("with an sRGB soft proof", () => {
  test.use({ storage: { "pe-colorspace": "display-p3" } });

  test("off prints the colours as they are; on prints their sRGB clip", async ({ app }, info) => {
    await proofedP3Document(app, info.outputPath("p3.png"));
    const off = await printProof(app, false);
    expect(near(off.left, GREENISH), `without the proof, P3 ${GREENISH} prints as itself (got ${off.left})`).toBe(true);
    const on = await printProof(app, true);
    const want = sRgbProofOfP3(GREENISH);
    expect(near(on.left, want), `with it, P3 ${GREENISH} prints as its sRGB clip ${want} (got ${on.left})`).toBe(true);
  });
});

test.describe("with an Adobe RGB soft proof", () => {
  test.use({ storage: { "pe-colorspace": "display-p3", "pe-proof-target": "adobe-rgb" } });

  test("printing the proof keeps colours Adobe RGB holds, and clips the ones it does not", async ({ app }, info) => {
    await proofedP3Document(app, info.outputPath("p3.png"));
    const on = await printProof(app, true);
    expect(near(on.left, GREENISH), `P3 ${GREENISH}, inside Adobe RGB, prints as itself (got ${on.left})`).toBe(true);
    expect(near(on.right, [255, 0, 0]), `P3 red, outside Adobe RGB, is clipped (got ${on.right})`).toBe(false);
  });
});
