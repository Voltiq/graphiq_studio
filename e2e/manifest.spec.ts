/**
 * The web app manifest, and the icons it points at. (Ported from
 * tools/verify-manifest.js, TODO 2.1.)
 *
 * Installed, the browser's ~110px of URL bar and toolbar goes to the editor.
 * DevTools' installability verdict cannot be read from a test, so its
 * requirements are checked directly: a linked manifest, a name, a start_url in
 * scope, a display mode, icons at 192 and 512 that load. "The launcher glyph
 * is not letterboxed" is checked as the property that causes it: a MASKABLE
 * icon, fully opaque, its glyph inside the centre 80% the shape crop leaves.
 */
import { test, expect, type App } from "./fixtures";

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

const SAFE = 0.8; // the maskable safe zone

/** Decode an image in the page: size, opacity, and where its glyph sits. */
const inspect = (app: App, url: string) =>
  app.page.evaluate(async (url) => {
    const res = await fetch(url);
    if (!res.ok) return { ok: false as const, status: res.status };
    const bmp = await createImageBitmap(await res.blob());
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    const g = c.getContext("2d", { willReadFrequently: true })!;
    g.drawImage(bmp, 0, 0);
    const { data } = g.getImageData(0, 0, bmp.width, bmp.height);
    let transparent = 0;
    let x0 = 1e9;
    let x1 = -1;
    let y0 = 1e9;
    let y1 = -1;
    for (let y = 0; y < bmp.height; y++)
      for (let x = 0; x < bmp.width; x++) {
        const i = (y * bmp.width + x) * 4;
        if (data[i + 3] < 250) transparent++;
        /* The glyph: not transparent AND not the flat dark ground under it. */
        if (data[i + 3] > 20 && (data[i] + data[i + 1] + data[i + 2]) / 3 > 40) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y0 = Math.min(y0, y);
          y1 = Math.max(y1, y);
        }
      }
    return { ok: true as const, w: bmp.width, h: bmp.height, transparent, glyph: x1 < 0 ? null : { x0, x1, y0, y1 } };
  }, url);

type Icon = { src: string; sizes: string; purpose?: string };

test("the manifest makes the app installable, with icons a launcher will not letterbox", async ({ app }) => {
  const { page } = app;
  const href = await page.evaluate(() => {
    const el = document.querySelector('link[rel="manifest"]');
    return el ? new URL(el.getAttribute("href")!, location.href).href : null;
  });
  expect(href, "the page links a manifest").toBeTruthy();
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"], "served as a manifest").toMatch(/manifest\+json/);
  const m = await res.json();

  expect(m.name, "it names the app").toBeTruthy();
  expect(m.short_name?.length, "...with a short name for the launcher").toBeLessThanOrEqual(12);
  expect(String(m.start_url).startsWith(m.scope), `start_url "${m.start_url}" inside scope "${m.scope}"`).toBe(true);
  expect(["standalone", "fullscreen"], "a window of its own").toContain(m.display);
  /* A mode the app does not implement is worse than none: window-controls-
     overlay hands the title bar to a page that ignores titlebarAreaRect, and
     the OS draws its window controls over the top bar. */
  expect(m.display_override ?? [], "no mode it does not implement").not.toContain("window-controls-overlay");
  expect(m.background_color, "a background colour").toMatch(/^#[0-9a-f]{6}$/i);
  expect(m.theme_color, "a theme colour").toMatch(/^#[0-9a-f]{6}$/i);

  const icons: Icon[] = m.icons ?? [];
  const purpose = (i: Icon) => (i.purpose ?? "any").split(/\s+/);
  const any = icons.filter((i) => purpose(i).includes("any"));
  const maskable = icons.filter((i) => purpose(i).includes("maskable"));
  expect(any.map((i) => i.sizes), "icons at 192 and 512").toEqual(expect.arrayContaining(["192x192", "512x512"]));
  expect(maskable.map((i) => i.sizes), "a maskable set, which is what stops the letterboxing").toContain("512x512");
  /* One file declared as both is the usual shortcut, wrong both ways at once. */
  expect(any.filter((a) => maskable.some((k) => k.src === a.src)).map((i) => i.src), "any and maskable are different files").toEqual([]);

  for (const i of icons) {
    const info = await inspect(app, new URL(i.src, href!).href);
    expect(info.ok, `${i.src} loads`).toBe(true);
    if (!info.ok) continue;
    expect(`${info.w}x${info.h}`, `${i.src} is the size it claims`).toBe(i.sizes);
    if (!i.src.endsWith(".png")) continue;
    const span = info.glyph ? (info.glyph.x1 - info.glyph.x0) / info.w : 0;
    if (purpose(i).includes("maskable")) {
      expect(info.transparent, `${i.src}: a mask is fully opaque — nothing to crop into`).toBe(0);
      const lo = (info.w * (1 - SAFE)) / 2;
      const hi = info.w - lo;
      const g = info.glyph!;
      expect(g.x0 >= lo - 1 && g.x1 <= hi + 1 && g.y0 >= lo - 1 && g.y1 <= hi + 1, `${i.src}: the glyph inside the centre 80%`).toBe(true);
    } else {
      /* Non-vacuity: the plain icons are NOT padded, or the check above passes
         on two copies of one padded picture. */
      expect(span, `${i.src}: the plain icon runs edge to edge`).toBeGreaterThan(0.9);
    }
  }
});

test("the tab icon is named, served, and transparent — unlike the launcher icons", async ({ app }) => {
  /* A different rule from the maskable one: the tab strip supplies its own
     ground, so a filled favicon shows as a dark box in a light theme. It was
     filled once, the Apple icon's rule carried one block down in the generator. */
  const declared = await app.page.evaluate(() => [...document.querySelectorAll('link[rel~="icon"]')].map((l) => l.getAttribute("href")));
  expect(declared.some((h) => /favicon\.ico/.test(h ?? "")), `the document names it: ${declared}`).toBe(true);
  const fav = await inspect(app, new URL("/favicon.ico", app.page.url()).href);
  expect(fav.ok, "served, not a 404 on every load").toBe(true);
  expect(fav.ok && fav.transparent, "...on a transparent ground").toBeGreaterThan(0);
});

/* The iOS half (ported from tools/verify-ios-webapp.js). Safari ignores the
   manifest's `display`, so on an iPhone an installed copy is a tab with a URL
   bar unless these tags say otherwise. `black-translucent` is more than a
   colour: it is the one status-bar style that puts the page UNDER the status
   bar, which is what makes `safe-area-inset-top` non-zero — so without the top
   inset it would slide the top bar under the clock. Adding to the home screen
   cannot be done here; reading the tags, and measuring the top bar against a
   real CDP notch, can. */
test("iOS: web-app capable, a translucent status bar, a short label and an opaque 180px icon", async ({ app }) => {
  const m = await app.page.evaluate(() => {
    const meta = (n: string) => document.querySelector(`meta[name="${n}"]`)?.getAttribute("content") ?? null;
    const icon = document.querySelector('link[rel="apple-touch-icon"]');
    return {
      apple: meta("apple-mobile-web-app-capable"),
      std: meta("mobile-web-app-capable"),
      statusBar: meta("apple-mobile-web-app-status-bar-style"),
      title: meta("apple-mobile-web-app-title"),
      docTitle: document.title,
      icon: icon ? { href: new URL(icon.getAttribute("href")!, location.href).href, sizes: icon.getAttribute("sizes") } : null,
    };
  });
  /* Both spellings: Next renders the standard one Chrome asks for; iOS has only
     been documented as honouring the Apple one. */
  expect({ apple: m.apple, std: m.std }, "web-app capable, both spellings").toEqual({ apple: "yes", std: "yes" });
  expect(m.statusBar, "the status bar is translucent").toBe("black-translucent");
  /* iOS truncates the home-screen label rather than wrapping it. */
  expect(m.title && m.title.length <= 12 && m.title !== m.docTitle, `a short label: "${m.title}"`).toBe(true);
  expect(m.icon?.sizes, "an apple-touch-icon at 180×180").toBe("180x180");
  const icon = await inspect(app, m.icon!.href);
  expect(icon.ok && `${icon.w}x${icon.h}`, "...which loads at that size").toBe("180x180");
  /* iOS paints transparency black behind its own mask. */
  expect(icon.ok && icon.transparent, "...fully opaque").toBe(0);
});

test("iOS: with a notch, the top bar grows by the inset and no control sits under the clock", async ({ app }) => {
  const NOTCH = { top: 47, right: 0, bottom: 34, left: 0 };
  const topbar = () =>
    app.page.evaluate((inset) => {
      const bar = document.querySelector('[data-tour="topbar"]')!;
      const r = bar.getBoundingClientRect();
      const controls = [...bar.querySelectorAll("button, a, input, select")]
        .map((e) => ({ e, b: e.getBoundingClientRect() }))
        .filter(({ b }) => b.width > 0 && b.height > 0);
      return {
        safeTop: parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--safe-t")) || 0,
        top: Math.round(r.top),
        height: Math.round(r.height),
        controls: controls.length,
        under: controls.filter(({ b }) => b.top < inset - 0.5).map(({ e, b }) => `${e.getAttribute("aria-label")} at y=${Math.round(b.top)}`),
      };
    }, NOTCH.top);
  const before = await topbar();
  expect({ top: before.top, safeTop: before.safeTop }, "no inset: flush, and none reported").toEqual({ top: 0, safeTop: 0 });
  expect(before.controls, "controls on the bar to be covered").toBeGreaterThanOrEqual(4);
  await app.setSafeArea(NOTCH);
  const after = await topbar();
  expect(after.safeTop, "a notch makes the inset real").toBe(NOTCH.top);
  /* The difference is the point: a hard-coded bar height passes the first
     reading and fails this one. */
  expect(after.height, "the bar grows by exactly the inset").toBe(before.height + NOTCH.top);
  expect(after.top, "...still flush at the top").toBe(0);
  expect(after.under, "no control in the status-bar strip").toEqual([]);
});
