/* The web app manifest, and the icons it points at.
 *
 * Installed, the browser's ~110px of URL bar and toolbar goes away and the
 * editor gets it. Without a manifest there is no install at all — there was no
 * manifest, no `public/` and no icons.
 *
 * The item's check names DevTools' installability verdict, which a harness
 * cannot read. So the requirements behind that verdict are checked directly —
 * a linked manifest, a name, a `start_url` in scope, a display mode, and icons
 * at 192 and 512 that actually load — and the one it singles out, "the
 * installed launcher glyph is not letterboxed", is checked as the property that
 * causes it: a `maskable` icon that is fully opaque and keeps its glyph inside
 * the centre 80% the platform's shape crop leaves. Android letterboxes when
 * there is no maskable icon; a maskable icon with transparent corners crops to
 * nothing; one with an edge-to-edge glyph loses its wingtips.
 *
 * Run: node tools/verify-manifest.js [--url ...] [--channel ...]
 */
const { launchBrowser, urlArg } = require("./lib/launch");

const SAFE = 0.8; // the maskable safe zone: the centre 80%

/** Decode a PNG in the page and report its size, opacity and content bounds. */
const INSPECT = async (url) => {
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: res.status };
  const blob = await res.blob();
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext("2d", { willReadFrequently: true });
  g.drawImage(bmp, 0, 0);
  const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
  let clear = 0;
  let x0 = 1e9,
    y0 = 1e9,
    x1 = -1,
    y1 = -1;
  for (let y = 0; y < bmp.height; y++)
    for (let x = 0; x < bmp.width; x++) {
      const i = (y * bmp.width + x) * 4;
      const a = data[i + 3];
      if (a < 250) clear++;
      /* "Content" = not transparent AND not the flat ground it sits on, so a
         maskable icon's opaque background is not mistaken for the glyph. */
      const lum = (data[i] + data[i + 1] + data[i + 2]) / 3;
      if (a > 20 && lum > 40) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  return {
    ok: true,
    type: blob.type,
    bytes: blob.size,
    w: bmp.width,
    h: bmp.height,
    transparentPx: clear,
    content: x1 < 0 ? null : { x0, y0, x1, y1 },
  };
};

(async () => {
  const browser = await launchBrowser();
  const results = [];
  const check = (name, ok, detail = "") => {
    results.push({ name, ok: !!ok });
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  };
  const errors = [];

  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push("pageerror: " + String(e)));
  page.on("console", (m) => m.type() === "error" && errors.push("console: " + m.text()));
  await page.goto(urlArg(), { waitUntil: "domcontentloaded" });
  await page.waitForSelector('[data-tour="canvas"]', { timeout: 90000 });
  await page.waitForTimeout(900);

  // ================================================ the document links one ==
  const link = await page.evaluate(() => {
    const el = document.querySelector('link[rel="manifest"]');
    return el ? new URL(el.getAttribute("href"), location.href).href : null;
  });
  check("the page links a manifest", !!link, link ?? "no <link rel=manifest>");
  if (!link) {
    console.log("\n0/1 checks passed");
    process.exit(1);
  }

  const fetched = await page.evaluate(async (href) => {
    const r = await fetch(href);
    return { status: r.status, type: r.headers.get("content-type"), body: await r.text() };
  }, link);
  check("…which is served as a manifest", fetched.status === 200 && /manifest\+json/.test(fetched.type ?? ""),
    `${fetched.status} ${fetched.type}`);

  let m = null;
  try {
    m = JSON.parse(fetched.body);
  } catch {
    /* reported by the next check */
  }
  check("…and is valid JSON", !!m, m ? `${Object.keys(m).length} keys` : "could not parse");
  if (!m) {
    const passed = results.filter((r) => r.ok).length;
    console.log(`\n${passed}/${results.length} checks passed`);
    process.exit(1);
  }

  // ============================================ what installability needs ==
  check("it names the app", !!m.name && !!m.short_name && m.short_name.length <= 12,
    `name "${m.name}", short_name "${m.short_name}"`);
  check("…gives a start_url inside its own scope",
    typeof m.start_url === "string" && typeof m.scope === "string" && m.start_url.startsWith(m.scope),
    `start_url "${m.start_url}", scope "${m.scope}"`);
  check("…and asks for a window of its own",
    m.display === "standalone" || m.display === "fullscreen",
    `display: ${m.display}, display_override: ${JSON.stringify(m.display_override ?? [])}`);

  /* A mode the app does not implement is worse than not asking for one:
     `window-controls-overlay` hands the title-bar strip to the page, and a page
     that ignores `titlebarAreaRect` gets the OS window controls drawn over its
     own top bar. */
  check("…without asking for a mode it does not implement",
    !(m.display_override ?? []).includes("window-controls-overlay"),
    `display_override: ${JSON.stringify(m.display_override ?? [])}`);

  check("it sets a background and theme colour",
    /^#[0-9a-f]{6}$/i.test(m.background_color ?? "") && /^#[0-9a-f]{6}$/i.test(m.theme_color ?? ""),
    `background ${m.background_color}, theme ${m.theme_color}`);

  // ===================================================== the icons it names ==
  const icons = m.icons ?? [];
  const purposeOf = (i) => (i.purpose ?? "any").split(/\s+/);
  const anyIcons = icons.filter((i) => purposeOf(i).includes("any"));
  const maskables = icons.filter((i) => purposeOf(i).includes("maskable"));
  check("it declares icons at 192 and 512",
    ["192x192", "512x512"].every((s) => anyIcons.some((i) => i.sizes === s)),
    anyIcons.map((i) => i.sizes).join(", ") || "none");
  check("…and a maskable set as well, which is what stops the letterboxing",
    maskables.length >= 1 && maskables.some((i) => i.sizes === "512x512"),
    maskables.map((i) => `${i.sizes} ${i.purpose}`).join(", ") || "no maskable icon");

  /* `any` and `maskable` must be DIFFERENT files. One file declared as both is
     the usual shortcut and it is wrong in both directions at once. */
  const shared = anyIcons.filter((a) => maskables.some((k) => k.src === a.src));
  check("…and they are not the same file wearing two hats", shared.length === 0,
    shared.length ? shared.map((i) => i.src).join(", ") : `${anyIcons.length} any, ${maskables.length} maskable`);

  // ------------------------------------------- every declared icon is real
  const loaded = [];
  for (const i of icons) {
    const href = new URL(i.src, link).href;
    const info = await page.evaluate(INSPECT, href);
    loaded.push([i, info]);
  }
  const missing = loaded.filter(([, info]) => !info.ok);
  check("every icon it names actually loads", missing.length === 0,
    missing.length ? missing.map(([i, info]) => `${i.src} → ${info.status}`).join(", ") : `${loaded.length} icons fetched`);

  const wrongSize = loaded.filter(([i, info]) => info.ok && `${info.w}x${info.h}` !== i.sizes);
  check("…at the size it claims", wrongSize.length === 0,
    wrongSize.length
      ? wrongSize.map(([i, info]) => `${i.src} says ${i.sizes}, is ${info.w}x${info.h}`).join(", ")
      : loaded.map(([i]) => i.sizes).join(", "));

  // ------------------------------- the two properties a mask actually needs
  const maskLoaded = loaded.filter(([i]) => purposeOf(i).includes("maskable") && i.src.endsWith(".png"));
  const seeThrough = maskLoaded.filter(([, info]) => info.ok && info.transparentPx > 0);
  check("a maskable icon is fully opaque", seeThrough.length === 0,
    seeThrough.length
      ? seeThrough.map(([i, info]) => `${i.src}: ${info.transparentPx} transparent px`).join(", ")
      : `${maskLoaded.length} maskable icons, no transparency to crop into`);

  const outside = maskLoaded.filter(([, info]) => {
    if (!info.ok || !info.content) return true;
    const lo = (info.w * (1 - SAFE)) / 2;
    const hi = info.w - lo;
    return info.content.x0 < lo - 1 || info.content.x1 > hi + 1 || info.content.y0 < lo - 1 || info.content.y1 > hi + 1;
  });
  check("…and keeps its glyph inside the centre 80% the shape mask leaves",
    outside.length === 0,
    outside.length
      ? outside
          .map(([i, info]) =>
            info.content
              ? `${i.src}: glyph ${info.content.x0}..${info.content.x1} of ${info.w}, safe zone ${Math.round((info.w * (1 - SAFE)) / 2)}..${Math.round(info.w - (info.w * (1 - SAFE)) / 2)}`
              : `${i.src}: no glyph found`,
          )
          .join(" | ")
      : maskLoaded
          .map(([i, info]) => `${i.src.split("/").pop()} glyph spans ${Math.round(((info.content.x1 - info.content.x0) / info.w) * 100)}%`)
          .join(", "));

  /* Non-vacuity: the `any` icons must NOT be padded into the safe zone, or the
     check above is passing on two copies of the same padded picture. */
  const anyLoaded = loaded.filter(([i]) => purposeOf(i).includes("any"));
  const anyFills = anyLoaded.filter(([, info]) => {
    if (!info.ok || !info.content) return false;
    return (info.content.x1 - info.content.x0) / info.w > 0.9;
  });
  check("…while the plain icons still run edge to edge", anyFills.length === anyLoaded.length,
    anyLoaded
      .map(([i, info]) =>
        info.content ? `${i.src.split("/").pop()} ${Math.round(((info.content.x1 - info.content.x0) / info.w) * 100)}%` : "?",
      )
      .join(", "));

  // ============================================= the icon in the browser tab ==
  /* A DIFFERENT rule from the two above, and getting them confused is what went
     wrong: a maskable icon must be fully opaque and the Apple icon must be too
     (iOS paints transparency black), but the FAVICON must not be. The tab strip
     supplies its own background — light in a light theme — so a filled ground
     shows up as a dark box around the butterfly. It was filled, because the
     Apple rule had been carried one block down in the generator. */
  const declared = await page.evaluate(() =>
    [...document.querySelectorAll('link[rel~="icon"]')].map((l) => l.getAttribute("href")),
  );
  check("the document names its tab icon rather than leaving it to a probe",
    declared.some((h) => /favicon\.ico/.test(h)),
    declared.length ? declared.join(", ") : "no rel=icon link — the browser falls back to /favicon.ico");

  const fav = await page.evaluate(INSPECT, new URL("/favicon.ico", urlArg()).href);
  check("…and it is served rather than 404ing on every load",
    fav.ok, fav.ok ? `${fav.bytes} bytes, ${fav.w}x${fav.h}` : `status ${fav.status}`);
  check("…with a transparent ground, unlike the Apple and maskable icons",
    fav.ok && fav.transparentPx > 0,
    fav.ok
      ? `${fav.transparentPx} transparent px of ${fav.w * fav.h}`
      : "not decoded");

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
