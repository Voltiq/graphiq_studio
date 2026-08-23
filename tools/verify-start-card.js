/* The phone's launch state.
 *
 * The app opens on a blank 1920×1080 artboard, which is the desktop's
 * job-to-be-done: you came to make something. Someone arriving on a phone
 * almost always came to edit a picture that is already on the device, and
 * reaching it meant finding the menu sheet, then File, then Import.
 *
 * Two things are asserted that a headless browser can genuinely settle, and one
 * that it cannot — stated plainly rather than faked:
 *
 *   - the card is there with ZERO taps on a fresh profile, and covers the
 *     canvas area rather than the chrome;
 *   - a photo picked through the camera input becomes the document, with the
 *     image's own dimensions and its pixels on a layer. `setInputFiles` is
 *     exactly what the OS picker does when it returns — the file arrives on the
 *     input and `change` fires — so everything downstream of the picker is
 *     really being driven here;
 *   - whether the OS opens the CAMERA rather than the photo library is decided
 *     by the `capture` attribute, and no automated browser can be made to open
 *     a camera. The attribute is asserted; the camera itself is a claim about
 *     the platform, not about this code.
 *
 * The negative cases are the ones that keep it from being a nuisance: it must
 * never appear over work, and never on a mouse.
 *
 * Run: node tools/verify-start-card.js [--url ...] [--channel ...]
 */
const zlib = require("zlib");
const { launchBrowser, urlArg } = require("./lib/launch");

/** A solid-colour PNG, built here so the harness carries no fixture files.
 *  Hand-rolled for the same reason the app encodes its own PNGs: it is a
 *  handful of chunks and a CRC, and a dependency would be the larger cost. */
function solidPng(w, h, [r, g, bl]) {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const row = y * (w * 3 + 1);
    raw[row] = 0; // filter: none
    for (let x = 0; x < w; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = bl;
    }
  }
  const crcTable = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crcTable[i] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const tail = Buffer.alloc(4);
    tail.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, tail]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const PHOTO = { w: 61, h: 43, rgb: [0, 128, 255] };

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const open = async (viewport, touch, label) => {
    const context = await browser.newContext({ viewport, hasTouch: touch });
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
    await page.waitForTimeout(1100);
    return { context, page };
  };

  const cardBox = (page) =>
    page.evaluate(() => {
      const el = document.querySelector("[data-startcard]");
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top), bottom: Math.round(r.bottom) };
    });

  // ================================================= a fresh phone, zero taps
  const phone = await open({ width: 390, height: 844 }, true, "phone");
  const box = await cardBox(phone.page);
  check("a fresh phone profile shows the start card with no taps at all",
    !!box && box.w > 200 && box.h > 200, box ? `${box.w}×${box.h}` : "no card");
  /* Over the artwork, not over the chrome: the top bar, the options bar and the
     bottom bar all have to stay usable, because the card is an offer. */
  const chrome = await phone.page.evaluate(() => {
    const bar = document.querySelector('[data-tour="mobilebar"]')?.getBoundingClientRect();
    const opts = document.querySelector('[data-tour="options"]')?.getBoundingClientRect();
    return { barTop: Math.round(bar?.top ?? 0), optsBottom: Math.round(opts?.bottom ?? 0) };
  });
  check("…covering the canvas area and neither bar",
    !!box && box.top >= chrome.optsBottom - 1 && box.bottom <= chrome.barTop + 1,
    box ? `card spans ${box.top}–${box.bottom}; options end ${chrome.optsBottom}, bar starts ${chrome.barTop}` : "");

  const rows = await phone.page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-start]")].map((e) => [
        e.getAttribute("data-start"),
        e.textContent.trim(),
      ]),
    ),
  );
  check("it offers a photo, a camera and a way out",
    !!rows.open && !!rows.camera && !!rows.blank,
    Object.entries(rows).map(([k, v]) => `${k}="${v}"`).join(", "));

  const inputs = await phone.page.evaluate(() =>
    Object.fromEntries(
      [...document.querySelectorAll("[data-start-input]")].map((e) => [
        e.getAttribute("data-start-input"),
        { accept: e.accept, capture: e.getAttribute("capture") },
      ]),
    ),
  );
  check("both pickers filter to images, so the OS shows pictures and not files",
    inputs.open?.accept === "image/*" && inputs.camera?.accept === "image/*",
    `open accept="${inputs.open?.accept}", camera accept="${inputs.camera?.accept}"`);
  /* The one thing a headless browser cannot settle: `capture` is what makes the
     OS open the camera. Its presence is the whole mechanism, so its presence is
     what is asserted — and it must be on the camera input ONLY, or the photo
     button would open a camera too. */
  check("the camera picker carries `capture`, which is what opens the camera",
    inputs.camera?.capture === "environment" && inputs.open?.capture === null,
    `camera capture="${inputs.camera?.capture}", open capture="${inputs.open?.capture}"`);

  // -------------------------------------- a photo returned from that picker
  const before = await phone.page.evaluate(() => ({
    tabs: document.querySelectorAll('[data-tour="canvas"] [class*="tab"]').length,
  }));
  await phone.page.locator('[data-start-input="camera"]').setInputFiles({
    name: "snap.png",
    mimeType: "image/png",
    buffer: solidPng(PHOTO.w, PHOTO.h, PHOTO.rgb),
  });
  await phone.page.waitForTimeout(2500);

  const landed = await phone.page.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    if (!c) return null;
    const g = c.getContext("2d", { willReadFrequently: true });
    const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return { w: c.width, h: c.height, centre: `${d[0]},${d[1]},${d[2]},${d[3]}` };
  });
  check("the returned photo becomes the document, at its own size",
    !!landed && landed.w === PHOTO.w && landed.h === PHOTO.h,
    landed ? `document is ${landed.w}×${landed.h}, photo was ${PHOTO.w}×${PHOTO.h}` : "no canvas");
  check("…and its pixels are on a layer, not an empty canvas",
    landed?.centre === `${PHOTO.rgb.join(",")},255`,
    `centre pixel rgba(${landed?.centre}), photo was rgb(${PHOTO.rgb.join(",")})`);
  const layers = await phone.page.evaluate(async () => {
    const btn = [...document.querySelectorAll('[data-tour="mobilebar"] button')].find((b) =>
      /Panels/.test(b.textContent || ""));
    btn?.click();
    await new Promise((r) => setTimeout(r, 900));
    const n = document.querySelectorAll('[data-tour="dock"] [data-layer-id]').length;
    window.history.back();
    await new Promise((r) => setTimeout(r, 700));
    return n;
  });
  check("…as exactly one layer", layers === 1, `${layers} layer row(s)`);
  check("and the card is gone once there is something to edit",
    (await cardBox(phone.page)) === null);
  await phone.context.close();

  // ------------------------------------------------- dismissing it, and work
  const second = await open({ width: 390, height: 844 }, true, "dismiss");
  check("the card is back on the next fresh load", !!(await cardBox(second.page)));
  await second.page.locator('[data-start="blank"]').click();
  await second.page.waitForTimeout(600);
  check("“Start with a blank canvas” dismisses it", (await cardBox(second.page)) === null);
  const stillBlank = await second.page.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    return c ? `${c.width}×${c.height}` : "none";
  });
  check("…and leaves the blank artboard it was covering", stillBlank === "1920×1080", stillBlank);
  await second.context.close();

  /* Never over work: the predicate has to react to CONTENT, not just to having
     been dismissed once. A fresh load, then one real edit. */
  const third = await open({ width: 390, height: 844 }, true, "work");
  check("a fresh load shows it again", !!(await cardBox(third.page)));
  await third.page.keyboard.press("Control+Shift+N"); // a layer is work
  await third.page.waitForTimeout(1400);
  check("making a layer takes it away without dismissing it",
    (await cardBox(third.page)) === null);
  await third.context.close();

  /* The user who ignores the card entirely and imports the ordinary way. This
     is the path that exercises the CONTENT half of the predicate: nothing was
     dismissed, so if the card only knew about dismissal it would sit on top of
     the picture that just opened. It also covers `docs.length === 1`, since
     importing as a canvas opens a second document. */
  const fourth = await open({ width: 390, height: 844 }, true, "ignore");
  check("the card is showing, and about to be ignored", !!(await cardBox(fourth.page)));
  /* By accept, not by position: the FIRST multiple-file input on the page is
     the animation-pack picker (.gifp/.aifp), and a PNG dropped on that one is
     silently ignored — which read as "the import path is broken". */
  const importInput = fourth.page
    .locator('input[type="file"][multiple][accept*="image/*"]')
    .first();
  check("the ordinary import picker is reachable", (await importInput.count()) > 0);
  await importInput.setInputFiles({
    name: "ignored.png",
    mimeType: "image/png",
    buffer: solidPng(PHOTO.w, PHOTO.h, [255, 0, 128]),
  });
  await fourth.page.waitForTimeout(2200);
  const dialog = fourth.page.locator('[role="dialog"] button', { hasText: /^Import$/ }).first();
  const hadDialog = (await dialog.count()) > 0;
  check("the ordinary path still goes through the import dialog", hadDialog);
  if (hadDialog) {
    /* "New canvas", not the default "Add as a layer": opening a SECOND document
       is the case `docs.length === 1` exists for, and the case where the card
       would otherwise reappear on top of a picture the user just opened. */
    await fourth.page.locator('[role="dialog"] button', { hasText: "New canvas" }).first().click();
    await fourth.page.waitForTimeout(400);
    await dialog.click();
    await fourth.page.waitForTimeout(2400);
  }
  const opened = await fourth.page.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    return {
      size: c ? `${c.width}×${c.height}` : "none",
      tabs: document.querySelectorAll('[data-tour="canvas"] [class*="tab"]:not([class*="tabNew"]):not([class*="tabBar"])').length,
    };
  });
  check("…and opens it as a second document",
    opened.size === `${PHOTO.w}×${PHOTO.h}` && opened.tabs >= 2,
    `canvas ${opened.size}, ${opened.tabs} tab(s)`);
  check("the card does not come back over a picture it was never dismissed for",
    (await cardBox(fourth.page)) === null);
  await fourth.context.close();

  // ------------------------------------------------------------- not a mouse
  const desk = await open({ width: 1400, height: 900 }, false, "desktop");
  check("a desktop never sees it", (await cardBox(desk.page)) === null);
  const deskCanvas = await desk.page.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    return c ? `${c.width}×${c.height}` : "none";
  });
  check("…and opens on the blank artboard exactly as before", deskCanvas === "1920×1080", deskCanvas);
  await desk.context.close();

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
