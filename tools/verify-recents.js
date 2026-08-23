/* Pictures the start card remembers.
 *
 * The app already had a recent-files store, but only for PROJECTS: `.gproj`
 * saved or opened, kept as a File System Access handle or as their own text,
 * listed in the recents dialog. A picture opened by import left no trace, so
 * the phone's start card had nothing to offer but "continue where you left
 * off" — the single autosave snapshot.
 *
 * Pictures now go into the same store as `kind: "image"`, with a preview and
 * their own bytes, which is what lets a row be tapped and open. One store, so
 * "Clear recent files" still means what it says.
 *
 * What is actually asserted, rather than assumed:
 *
 *   - three pictures opened in turn come back after a RELOAD, newest first,
 *     with their real names and previews that carry the right pixels. A
 *     thumbnail is checked by colour, not by "the image element loaded" — a
 *     blank or wrong-row preview is the failure that matters and it loads
 *     perfectly well.
 *   - a row opens the picture it names, from bytes that survived the reload.
 *   - the store is capped and evicts oldest-first.
 *   - the recents DIALOG still lists only projects. It opens `.gproj` text, and
 *     handing it a JPEG would be a silent failure a user could not read.
 *
 * Run: node tools/verify-recents.js [--url ...] [--channel ...]
 */
const zlib = require("zlib");
const { launchBrowser, urlArg } = require("./lib/launch");

/** A solid-colour PNG, built here so the harness carries no fixture files. */
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
  const table = [];
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const byte of buf) c = table[(c ^ byte) & 0xff] ^ (c >>> 8);
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
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/* Big enough that the preview is really downscaled — a 40px source would test
   the copy path and nothing else. Distinct, saturated colours so a preview can
   be matched to its row by what it shows. */
const PHOTOS = [
  { name: "sunset.png", w: 600, h: 400, rgb: [230, 60, 40] },
  { name: "forest.png", w: 520, h: 480, rgb: [40, 190, 90] },
  { name: "harbour.png", w: 640, h: 360, rgb: [60, 110, 235] },
];

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));

  const boot = async () => {
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
    await page.waitForTimeout(1300);
  };
  const canvasSize = () =>
    page.evaluate(() => {
      const c = document.querySelector('[data-tour="canvas"] canvas');
      return c ? `${c.width}×${c.height}` : "none";
    });
  const rows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("[data-recent]")].map((e) => e.getAttribute("data-recent")),
    );

  await boot();
  check("a fresh profile has no recent pictures to show",
    (await rows()).length === 0, `${(await rows()).length} rows`);

  // ------------------------------------------------- open three, in order --
  for (const photo of PHOTOS) {
    await page.locator('[data-start-input="open"]').setInputFiles({
      name: photo.name,
      mimeType: "image/png",
      buffer: solidPng(photo.w, photo.h, photo.rgb),
    });
    await page.waitForTimeout(2300);
    check(`${photo.name} opens as its own document`,
      (await canvasSize()) === `${photo.w}×${photo.h}`, await canvasSize());
    await boot(); // a reload between each: the store is what has to remember
  }

  const listed = await rows();
  check("after a reload the card lists all three, newest first",
    listed.join(",") === "harbour.png,forest.png,sunset.png", listed.join(", ") || "none");

  /* Previews by CONTENT. An <img> that loaded proves nothing about which
     picture it is showing, and a preview attached to the wrong row is exactly
     the mistake worth catching. */
  const thumbs = await page.evaluate(async () => {
    const out = [];
    for (const img of document.querySelectorAll("[data-recent-thumb]")) {
      if (!img.complete || !img.naturalWidth) {
        out.push({ ok: false, why: "not loaded" });
        continue;
      }
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d").drawImage(img, 0, 0);
      const d = c.getContext("2d").getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      out.push({ ok: true, size: `${img.naturalWidth}×${img.naturalHeight}`, rgb: [d[0], d[1], d[2]] });
    }
    return out;
  });
  check("every preview is a real, painted image", thumbs.length === 3 && thumbs.every((t) => t.ok),
    thumbs.map((t) => (t.ok ? t.size : t.why)).join(", "));
  /* JPEG at quality 0.72, so the colour moves a little; the three are far
     enough apart that "nearest of the three" is unambiguous. */
  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) < 90;
  const expected = [PHOTOS[2], PHOTOS[1], PHOTOS[0]];
  const matched = thumbs.every((t, i) => t.ok && near(t.rgb, expected[i].rgb));
  check("…showing the picture its row names, not some other row's",
    matched,
    thumbs.map((t, i) => `${expected[i].name}: rgb(${t.rgb?.join(",")})`).join(" | "));
  check("…and downscaled rather than stored whole",
    thumbs.every((t) => t.ok && Math.max(...t.size.split("×").map(Number)) <= 160),
    thumbs.map((t) => t.size).join(", "));

  // -------------------------------------------------- a row actually opens --
  await page.locator('[data-recent="forest.png"]').click();
  await page.waitForTimeout(2600);
  check("tapping a row opens that picture, from bytes that outlived the reload",
    (await canvasSize()) === `${PHOTOS[1].w}×${PHOTOS[1].h}`,
    `${await canvasSize()}, expected ${PHOTOS[1].w}×${PHOTOS[1].h}`);
  const centre = await page.evaluate(() => {
    const c = document.querySelector('[data-tour="canvas"] canvas');
    const d = c.getContext("2d", { willReadFrequently: true })
      .getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
    return [d[0], d[1], d[2]];
  });
  check("…and it is the right picture", near(centre, PHOTOS[1].rgb),
    `rgb(${centre.join(",")}), expected rgb(${PHOTOS[1].rgb.join(",")})`);

  await boot();
  const afterReopen = await rows();
  check("re-opening moves it to the top rather than listing it twice",
    afterReopen.join(",") === "forest.png,harbour.png,sunset.png", afterReopen.join(", "));

  // ------------------------------------------------- the cap, and eviction --
  /* The limit is a preference (default 8). Rather than drive Preferences, the
     store is filled past it and the oldest is expected to fall off the end. */
  for (let i = 0; i < 8; i++) {
    await page.locator('[data-start-input="open"]').setInputFiles({
      name: `filler-${i}.png`,
      mimeType: "image/png",
      buffer: solidPng(120 + i, 90, [10 + i * 5, 10, 10]),
    });
    await page.waitForTimeout(1800);
    await boot();
  }
  const capped = await rows();
  check("the list is capped", capped.length <= 8, `${capped.length} rows`);
  check("…and the oldest picture is the one that went",
    !capped.includes("sunset.png") && capped[0] === "filler-7.png",
    capped.join(", "));

  // ---------------------------------- the dialog still opens projects only --
  /* Driven through the MENU rather than by reading IndexedDB back. The claim is
     about what the dialog lists, and reading the store instead tested the
     store — which is how an earlier version of this passed with the filter
     mutated away. */
  await page.locator('button[aria-label="Menu"]').first().click();
  await page.waitForTimeout(800);
  await page
    .locator('[data-menubar][data-sheet="true"] > div > button', { hasText: "File" })
    .first()
    .click();
  await page.waitForTimeout(600);
  const openRecent = page
    .locator('[data-menubar][data-sheet="true"] [role="menu"] button', { hasText: "Open recent" })
    .first();
  const reachable = (await openRecent.count()) > 0;
  check("the recents dialog is reachable from the menu", reachable);
  if (reachable) {
    await openRecent.scrollIntoViewIfNeeded().catch(() => {});
    await openRecent.click();
    await page.waitForTimeout(1200);
    const dialogText = await page.evaluate(() => {
      const dlg = [...document.querySelectorAll('[role="dialog"]')].pop();
      return dlg ? dlg.textContent ?? "" : null;
    });
    const mentionsPictures = dialogText !== null && dialogText.includes(".png");
    check("…and lists no pictures, because it can only open project text",
      dialogText !== null && !mentionsPictures,
      dialogText === null
        ? "no dialog opened"
        : mentionsPictures
          ? "the dialog offers a .png it cannot open"
          : "projects only");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(500);
  }

  check("no console errors throughout", errors.length === 0, errors.slice(0, 3).join(" | ") || "clean");

  await context.close();
  await browser.close();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error("FAIL", e.stack || e.message);
  process.exit(1);
});
