/**
 * Export, handed to the operating system. (Ported from tools/verify-share.js,
 * TODO 2.1. The routing logic is unit-tested against fakes in
 * tests/share.test.ts.)
 *
 * A download is right on a desktop and close to useless on a phone: the
 * picture lands in Downloads, not the photo library. `navigator.share` with a
 * File opens the OS share sheet. What a browser has to prove is what fakes
 * cannot: the REAL export pipeline takes the share route on a phone and not on
 * a desktop, and hands over the same bytes either way.
 *
 * `navigator.share` cannot run headless (it needs a platform sheet), so it is
 * replaced with a recorder before the app loads. The stub is the OS;
 * everything upstream — encoder, metadata, naming, routing — is real.
 */
import { readFileSync } from "node:fs";
import type { Browser, Page } from "@playwright/test";
import { test, expect, bootApp, type App } from "./fixtures";

type Shared = { name: string; type: string; bytes: number[] };
type W = { __gqShared: Shared[]; __gqCanShareSaw?: { name: string; type: string }[] };

/** Replace the platform's share with a recorder that says yes. */
const STUB_SHARE = () => {
  const w = window as unknown as W;
  w.__gqShared = [];
  Object.defineProperty(navigator, "canShare", {
    configurable: true,
    value: (data: { files?: File[] }) => {
      w.__gqCanShareSaw = (data?.files ?? []).map((f) => ({ name: f.name, type: f.type }));
      return true;
    },
  });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async (data: { files: File[] }) => {
      const f = data.files[0];
      w.__gqShared.push({ name: f.name, type: f.type, bytes: [...new Uint8Array(await f.arrayBuffer())] });
    },
  });
};
/** A platform that cannot share — and has no save picker: the plain download. */
const NO_SHARE = () => {
  (window as unknown as W).__gqShared = [];
  Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
};

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };

/** A fresh session whose page runs `inits` before any app code (each is sent
 *  as source, so each must stand alone). */
async function session(browser: Browser, opts: object, ...inits: (() => void)[]): Promise<App> {
  const ctx = await browser.newContext({ ...opts, baseURL: test.info().project.use.baseURL, acceptDownloads: true });
  const page = await ctx.newPage();
  for (const init of inits) await page.addInitScript(init);
  return bootApp(page);
}
const NO_PICKER = () => {
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
};

/** One deterministic stroke, so two runs encode identical pixels. */
async function drawSomething(app: App) {
  await app.run("layer-new");
  await app.key("b");
  const b = await app.canvasBox();
  await app.page.mouse.move(b.x + b.width * 0.35, b.y + b.height * 0.45);
  await app.page.mouse.down();
  for (let i = 1; i <= 10; i++) await app.page.mouse.move(b.x + b.width * (0.35 + 0.02 * i), b.y + b.height * 0.45);
  await app.page.mouse.up();
  await app.settle(700);
}

/** Open a File menu row, through the phone's sheet or the desktop's bar. */
async function fileMenu(page: Page, row: string, mobile: boolean) {
  if (mobile) {
    await page.locator('header button[aria-label="Menu"]').first().click();
    await page.locator('[data-menubar][data-sheet="true"] > div > button', { hasText: "File" }).first().click();
  } else await page.locator("[data-menubar] > div > button", { hasText: "File" }).first().click();
  const item = page.locator('[data-menubar] [role="menu"] button', { hasText: row }).first();
  await item.scrollIntoViewIfNeeded();
  await item.click();
}

/** File ▸ Export as…, metadata OFF, through to its own Export button. */
async function exportImage(app: App, mobile: boolean) {
  await fileMenu(app.page, "Export as", mobile);
  await app.page.waitForSelector('[role="dialog"]');
  await app.settle(900);
  /* Metadata OFF is what lets the bytes be compared: export embeds a creation
     time, so two runs ten seconds apart differ in exactly the timestamp and
     the CRCs after it — the clock, not the pipeline. (`Toggle` is a
     role="switch" button; looking for a checkbox once found nothing and left
     metadata on.) */
  const meta = app.page.locator('[role="dialog"] button[role="switch"]', { hasText: "Embed metadata" }).first();
  if ((await meta.count()) && (await meta.getAttribute("aria-checked")) === "true") await meta.click();
  await app.page.locator('[role="dialog"] button', { hasText: /^(Export|Save|Download)$/ }).last().click();
}

const shared = (app: App) => app.page.evaluate(() => (window as unknown as W).__gqShared ?? []);

test("a phone hands its export to the share sheet — and without one, downloads the same bytes", async ({ browser }) => {
  test.slow();
  const phone = await session(browser, PHONE, STUB_SHARE);
  let downloaded = false;
  phone.page.on("download", () => (downloaded = true));
  await drawSomething(phone);
  await exportImage(phone, true);
  await expect.poll(async () => (await shared(phone)).length, { message: "a phone hands the export to the share sheet" }).toBe(1);
  const [file] = await shared(phone);
  expect(downloaded, "...and does not also download it behind the sheet").toBe(false);
  const saw = await phone.page.evaluate(() => (window as unknown as W).__gqCanShareSaw);
  expect(saw?.length, "...having asked canShare about the real file").toBe(1);
  expect(file.bytes.length, "...a real encoded image").toBeGreaterThan(1000);
  expect(file.bytes.slice(0, 4), "...a PNG").toEqual([0x89, 0x50, 0x4e, 0x47]);
  expect(phone.errors).toEqual([]);
  await phone.page.context().close();

  const bare = await session(browser, PHONE, NO_SHARE);
  const dl = bare.page.waitForEvent("download");
  await drawSomething(bare);
  await exportImage(bare, true);
  const download = await dl;
  const bytes = [...readFileSync(await download.path())];
  expect((await shared(bare)).length, "without platform support nothing is shared").toBe(0);
  /* The fallback must be the same FILE, not a re-encode that looks similar. */
  expect(bytes.length, "the download is the same size as the share").toBe(file.bytes.length);
  expect(bytes.findIndex((b, i) => b !== file.bytes[i]), "...and byte-identical").toBe(-1);
  expect(bare.errors).toEqual([]);
  await bare.page.context().close();
});

test("a desktop downloads even where the platform offers to share — the image funnel and the PSD route", async ({ browser }) => {
  /* `canShare({files})` is true on Chrome for Windows: without the coarse
     gate a desktop Export would open the Windows share flyout. And the two
     routes are gated in different places — deleting the gate inside
     shareOrDownload left the PNG path untouched and passed the image check —
     so PSD (no dialog, no preconditions) is driven too. */
  const desk = await session(browser, { viewport: { width: 1400, height: 900 } }, STUB_SHARE, NO_PICKER);
  await drawSomething(desk);
  const png = desk.page.waitForEvent("download");
  await exportImage(desk, false);
  expect((await png).suggestedFilename(), "the image downloads").toMatch(/\.png$/i);
  const psd = desk.page.waitForEvent("download");
  await fileMenu(desk.page, "Export PSD", false);
  expect((await psd).suggestedFilename(), "...and so does the PSD").toMatch(/\.psd$/i);
  expect((await shared(desk)).length, "nothing went to the share sheet").toBe(0);
  expect(desk.errors).toEqual([]);
  await desk.page.context().close();
});

test("a phone shares the other exports too, not just the image", async ({ browser }) => {
  const phone = await session(browser, PHONE, STUB_SHARE);
  let downloaded = false;
  phone.page.on("download", () => (downloaded = true));
  await phone.run("layer-new");
  await fileMenu(phone.page, "Export PSD", true);
  await expect.poll(async () => (await shared(phone)).map((f) => f.name), { message: "the PSD is shared" }).toEqual([
    expect.stringMatching(/\.psd$/i),
  ]);
  expect(downloaded, "...not downloaded").toBe(false);
  expect(phone.errors).toEqual([]);
  await phone.page.context().close();
});
