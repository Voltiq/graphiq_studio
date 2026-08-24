/* Export, handed to the operating system.
 *
 * A download is the right answer on a desktop and close to useless on a phone:
 * the picture lands in Downloads, not in the photo library. `navigator.share`
 * with a `File` opens the OS share sheet — Photos, Messages, AirDrop.
 *
 * The branching is unit-tested against fakes in `tests/share.test.ts`. What a
 * browser has to prove is the part fakes cannot: that the REAL export pipeline
 * takes the share route on a phone, does not take it on a desktop, and that the
 * bytes are the same either way. So the same document is exported twice — once
 * with `navigator.share` stubbed and the File captured, once with sharing
 * removed entirely and the download captured through Playwright — and the two
 * byte arrays are compared.
 *
 * `navigator.share` cannot be driven for real in a headless browser (it needs a
 * platform sheet and transient activation), so it is replaced with a stub that
 * records what it was handed. The stub is the OS; everything upstream of it —
 * the encoder, the metadata embed, the naming, the routing — is the real thing.
 *
 * Run: node tools/verify-share.js [--url ...] [--channel ...]
 */
const { dismissStartCard, launchBrowser, urlArg } = require("./lib/launch");

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1400, height: 900 };

/** Replace the platform's share with a recorder, before any page script runs. */
const STUB_SHARE = (accept) => {
  const w = window;
  w.__gqShared = [];
  Object.defineProperty(navigator, "canShare", {
    configurable: true,
    value: (data) => {
      w.__gqCanShareCalls = (w.__gqCanShareCalls ?? 0) + 1;
      w.__gqCanShareSaw = (data?.files ?? []).map((f) => ({ name: f.name, type: f.type, size: f.size }));
      return accept;
    },
  });
  Object.defineProperty(navigator, "share", {
    configurable: true,
    value: async (data) => {
      const f = data.files[0];
      w.__gqShared.push({
        name: f.name,
        type: f.type,
        bytes: [...new Uint8Array(await f.arrayBuffer())],
      });
    },
  });
};

/** Remove sharing entirely — a platform that cannot do it. */
const NO_SHARE = () => {
  Object.defineProperty(navigator, "canShare", { configurable: true, value: undefined });
  Object.defineProperty(navigator, "share", { configurable: true, value: undefined });
  /* …and no save picker either, so the desktop path is the plain download the
     item promises as the fallback. */
  Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
};

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const open = async (viewport, touch, label, init) => {
    const context = await browser.newContext({
      viewport,
      hasTouch: touch,
      isMobile: touch,
      acceptDownloads: true,
    });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(`pageerror(${label}): ` + String(e)));
    page.on("console", (m) => m.type() === "error" && errors.push(`console(${label}): ` + m.text()));
    await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
    const tour = await page
      .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 6000 })
      .catch(() => null);
    if (tour) {
      await page.keyboard.press("Escape");
      await page.waitForTimeout(700);
    }
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" }).catch(() => {});
    await dismissStartCard(page);
    await page.waitForTimeout(1100);
    return { context, page };
  };

  /* One deterministic document, so the two runs encode identical pixels: a
     fixed-size canvas with one filled rectangle. Comparing bytes is only
     meaningful if the input is the same both times. */
  const drawSomething = async (page) => {
    await page.keyboard.press("Control+Shift+N");
    await page.waitForTimeout(900);
    await page.evaluate(() => {
      const cv = document.querySelector('[data-tour="canvas"] canvas');
      void cv;
    });
    const box = await page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    await page.keyboard.press("b");
    await page.waitForTimeout(400);
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.45);
    await page.mouse.down();
    for (let i = 1; i <= 10; i++)
      await page.mouse.move(box.x + box.width * (0.35 + 0.02 * i), box.y + box.height * 0.45);
    await page.mouse.up();
    await page.waitForTimeout(700);
  };

  /** Drive File ▸ Export as… through to the format's own Export button. */
  const runExport = async (page, mobile) => {
    if (mobile) {
      await page.evaluate(() => {
        [...document.querySelectorAll("header button")].find((x) =>
          /^Menu$/i.test(x.getAttribute("aria-label") || ""),
        )?.click();
      });
      await page.waitForSelector('[data-menubar][data-sheet="true"]', { timeout: 6000 });
      await page.waitForTimeout(400);
      await page.evaluate(() => {
        [...document.querySelectorAll("[data-menubar] > div > button")]
          .find((x) => x.textContent.trim() === "File")
          ?.click();
      });
    } else {
      await page.locator("[data-menubar] > div > button", { hasText: "File" }).first().click();
    }
    await page.waitForTimeout(500);
    const row = page.locator('[role="menu"] button', { hasText: "Export as" }).first();
    await row.scrollIntoViewIfNeeded().catch(() => {});
    await row.click();
    await page.waitForSelector('[role="dialog"]', { timeout: 10000 });
    await page.waitForTimeout(900);

    /* Metadata OFF, and this is the whole reason the check below can exist.
       Export embeds a creation time, so two exports of the same artwork are
       never byte-identical: run with it on, the files matched in length and
       differed in exactly the timestamp — `2026:08:24 17:03:39` against
       `…17:03:49`, ten seconds apart because the two runs are sequential — plus
       the chunk CRCs that follow it. That is the clock, not the pipeline. With
       the stamp out of the way the comparison says what the item wanted it to
       say: the share route and the download route hand over the same file. */
    /* `Toggle` is a `role="switch"` BUTTON, not a checkbox in a label — the
       first version of this looked for `input[type=checkbox]`, found nothing,
       silently left metadata on and reported the timestamp difference again. */
    const metaToggle = page
      .locator('[role="dialog"] button[role="switch"]', { hasText: "Embed metadata" })
      .first();
    if (await metaToggle.count()) {
      if ((await metaToggle.getAttribute("aria-checked")) === "true") {
        await metaToggle.click();
        await page.waitForTimeout(600);
      }
    }

    const go = page
      .locator('[role="dialog"] button', { hasText: /^(Export|Save|Download)$/ })
      .last();
    await go.click();
  };

  // ================================================== a phone: the share sheet ==
  const m = await open(PHONE, true, "phone", () => {
    const w = window;
    w.__gqShared = [];
    Object.defineProperty(navigator, "canShare", {
      configurable: true,
      value: (data) => {
        w.__gqCanShareCalls = (w.__gqCanShareCalls ?? 0) + 1;
        w.__gqCanShareSaw = (data?.files ?? []).map((f) => ({
          name: f.name,
          type: f.type,
          size: f.size,
        }));
        return true;
      },
    });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data) => {
        const f = data.files[0];
        w.__gqShared.push({
          name: f.name,
          type: f.type,
          bytes: [...new Uint8Array(await f.arrayBuffer())],
        });
      },
    });
  });
  let phoneDownloaded = false;
  m.page.on("download", () => {
    phoneDownloaded = true;
  });
  await drawSomething(m.page);
  await runExport(m.page, true);
  await m.page.waitForTimeout(2500);

  const shared = await m.page.evaluate(() => ({
    count: window.__gqShared?.length ?? 0,
    first: window.__gqShared?.[0]
      ? {
          name: window.__gqShared[0].name,
          type: window.__gqShared[0].type,
          size: window.__gqShared[0].bytes.length,
        }
      : null,
    canShareCalls: window.__gqCanShareCalls ?? 0,
    canShareSaw: window.__gqCanShareSaw ?? null,
    bytes: window.__gqShared?.[0]?.bytes ?? null,
  }));

  check("a phone hands the export to the share sheet", shared.count === 1,
    shared.first
      ? `shared "${shared.first.name}" (${shared.first.type}, ${shared.first.size} bytes)`
      : `${shared.count} shares`);
  check("…and does not also download it behind the sheet", !phoneDownloaded,
    phoneDownloaded ? "a download fired as well" : "no download");
  check("…having asked canShare about the real file, not an empty list",
    shared.canShareCalls >= 1 && Array.isArray(shared.canShareSaw) && shared.canShareSaw.length === 1,
    shared.canShareSaw
      ? `canShare saw ${shared.canShareSaw.length} file(s): ${shared.canShareSaw.map((f) => `${f.name} ${f.type}`).join(", ")}`
      : "canShare was never called");
  check("…and what it shared is a real encoded image",
    !!shared.bytes && shared.bytes.length > 1000 &&
      shared.bytes[0] === 0x89 && shared.bytes[1] === 0x50, // PNG magic
    shared.bytes ? `${shared.bytes.length} bytes, starts ${shared.bytes.slice(0, 4).join(",")}` : "nothing");
  await m.context.close();

  // ================================= a phone the platform cannot share from ==
  const noShare = await open(PHONE, true, "phone-noshare", NO_SHARE);
  const dlWait = noShare.page.waitForEvent("download", { timeout: 30000 });
  await drawSomething(noShare.page);
  await runExport(noShare.page, true);
  const dl = await dlWait.catch(() => null);
  check("without platform support the phone falls back to a download", !!dl,
    dl ? `downloaded "${dl.suggestedFilename()}"` : "no download fired");

  let fallbackBytes = null;
  if (dl) {
    const fs = require("fs");
    const path = await dl.path();
    fallbackBytes = [...new Uint8Array(fs.readFileSync(path))];
  }
  const sharedNothing = await noShare.page.evaluate(() => window.__gqShared?.length ?? 0);
  check("…and nothing was shared on that run", sharedNothing === 0, `${sharedNothing} shares`);

  /* The item's own check: the fallback has to produce the same file, not a
     re-encode that happens to look similar. */
  if (fallbackBytes && shared.bytes && fallbackBytes.length === shared.bytes.length) {
    const diff = [];
    for (let i = 0; i < fallbackBytes.length && diff.length < 40; i++)
      if (fallbackBytes[i] !== shared.bytes[i]) diff.push(i);
    if (diff.length) {
      const at = diff[0];
      const asText = (arr) =>
        arr.slice(Math.max(0, at - 24), at + 40).map((b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : ".")).join("");
      console.log(`      [diag] ${diff.length}+ differing bytes, first at ${at}`);
      console.log(`      [diag] shared     : ${asText(shared.bytes)}`);
      console.log(`      [diag] downloaded : ${asText(fallbackBytes)}`);
    }
  }
  check("the fallback download is byte-identical to what would have been shared",
    !!fallbackBytes && !!shared.bytes &&
      fallbackBytes.length === shared.bytes.length &&
      fallbackBytes.every((b, i) => b === shared.bytes[i]),
    fallbackBytes && shared.bytes
      ? fallbackBytes.length === shared.bytes.length
        ? `${fallbackBytes.length} bytes, identical`
        : `${shared.bytes.length} shared vs ${fallbackBytes.length} downloaded`
      : "one of the two runs produced nothing");
  await noShare.context.close();

  // ====================================== a desktop keeps the download it had ==
  /* `canShare({files})` is true on Chrome for Windows, so without the coarse
     gate a desktop Export would open the Windows share flyout instead of
     saving a file. The stub says yes to everything; the desktop must still
     decline. */
  const d = await open(DESKTOP, false, "desktop", () => {
    const w = window;
    w.__gqShared = [];
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data) => {
        w.__gqShared.push({ name: data.files[0].name });
      },
    });
    Object.defineProperty(window, "showSaveFilePicker", { configurable: true, value: undefined });
  });
  const deskWait = d.page.waitForEvent("download", { timeout: 30000 });
  await drawSomething(d.page);
  await runExport(d.page, false);
  const deskDl = await deskWait.catch(() => null);
  const deskShared = await d.page.evaluate(() => window.__gqShared?.length ?? 0);
  check("a desktop still downloads, even where the platform offers to share",
    deskShared === 0 && !!deskDl,
    `${deskShared} shares, download: ${deskDl ? deskDl.suggestedFilename() : "none"}`);

  /* …and again through a DIFFERENT route, because the two are gated in
     different places. `saveImageBlob` picks between "share" and "picker" before
     it ever calls `shareOrDownload`, so deleting the coarse gate inside
     `shareOrDownload` left the PNG path untouched and the mutation passed the
     whole harness. Every other export — PSD, TIFF, PDF, SVG, LUT, the two zips
     — goes straight to `shareOrDownload` and has only that gate to protect it.
     PSD is the one with no dialog and no preconditions. */
  const psdWait = d.page.waitForEvent("download", { timeout: 30000 });
  await d.page.locator("[data-menubar] > div > button", { hasText: "File" }).first().click();
  await d.page.waitForTimeout(400);
  const psdRow = d.page.locator('[role="menu"] button', { hasText: "Export PSD" }).first();
  await psdRow.scrollIntoViewIfNeeded().catch(() => {});
  await psdRow.click();
  const psdDl = await psdWait.catch(() => null);
  const psdShared = await d.page.evaluate(() => window.__gqShared?.length ?? 0);
  check("…including the exports that do not go through the image funnel",
    psdShared === 0 && !!psdDl,
    `PSD: ${psdShared} shares, download: ${psdDl ? psdDl.suggestedFilename() : "none"}`);
  await d.context.close();

  // ================================ …and a phone shares those routes too ==
  const m2 = await open(PHONE, true, "phone-psd", () => {
    const w = window;
    w.__gqShared = [];
    Object.defineProperty(navigator, "canShare", { configurable: true, value: () => true });
    Object.defineProperty(navigator, "share", {
      configurable: true,
      value: async (data) => {
        w.__gqShared.push({ name: data.files[0].name, type: data.files[0].type });
      },
    });
  });
  let psdPhoneDownloaded = false;
  m2.page.on("download", () => {
    psdPhoneDownloaded = true;
  });
  await m2.page.keyboard.press("Control+Shift+N");
  await m2.page.waitForTimeout(900);
  await m2.page.evaluate(() => {
    [...document.querySelectorAll("header button")].find((x) =>
      /^Menu$/i.test(x.getAttribute("aria-label") || ""),
    )?.click();
  });
  await m2.page.waitForSelector('[data-menubar][data-sheet="true"]', { timeout: 6000 });
  await m2.page.waitForTimeout(400);
  await m2.page.evaluate(() => {
    [...document.querySelectorAll("[data-menubar] > div > button")]
      .find((x) => x.textContent.trim() === "File")
      ?.click();
  });
  await m2.page.waitForTimeout(500);
  const mPsd = m2.page.locator('[data-menubar] [role="menu"] button', { hasText: "Export PSD" }).first();
  await mPsd.scrollIntoViewIfNeeded().catch(() => {});
  await mPsd.click();
  await m2.page.waitForTimeout(3000);
  const psdPhoneShared = await m2.page.evaluate(() => window.__gqShared ?? []);
  check("a phone shares the other exports as well, not just the image one",
    psdPhoneShared.length === 1 && !psdPhoneDownloaded,
    psdPhoneShared.length
      ? `shared "${psdPhoneShared[0].name}" (${psdPhoneShared[0].type}), download: ${psdPhoneDownloaded}`
      : `${psdPhoneShared.length} shares, download: ${psdPhoneDownloaded}`);
  await m2.context.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
