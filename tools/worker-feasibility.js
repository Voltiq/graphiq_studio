/* Can a Worker + OffscreenCanvas do what this engine needs? (TODO 8, P3)
 *
 *   npm i -D playwright-core   &&   npm run dev   &&   node tools/worker-feasibility.js
 *
 * Runs the checks INSIDE a real worker rather than inferring support from docs,
 * because the answer decides whether "composite off the main thread" is even
 * possible here. Result on Edge/Chromium, 2026-08-12: 15/16.
 *
 * Available: OffscreenCanvas 2D, colorSpace display-p3, willReadFrequently,
 * getImageData/putImageData, ImageData, all 19 blend modes, linear/radial/conic
 * gradients, Path2D, ctx.filter, createImageBitmap, transferControlToOffscreen,
 * and — the one that looked most likely to sink it — TEXT: measureText and
 * fillText work, self.fonts exists, and a named system font (Arial) resolves to
 * different metrics than a bogus family, so it is genuinely resolving fonts and
 * not silently falling back.
 *
 * NOT available: queryLocalFonts, which is main-thread only. That is font
 * ENUMERATION for the picker UI, not rendering, so it does not block a move —
 * the picker stays on the main thread and passes family names to the worker.
 */
const { launchBrowser } = require("./lib/launch");

const WORKER_SRC = `
self.onmessage = async () => {
  const R = [];
  const ok = (name, fn) => { try { R.push({ name, ...fn() }); } catch (e) { R.push({ name, pass: false, note: String(e).slice(0, 90) }); } };

  ok("OffscreenCanvas + 2d context", () => {
    const c = new OffscreenCanvas(64, 64);
    return { pass: !!c.getContext("2d") };
  });
  ok("colorSpace: display-p3 honoured", () => {
    const c = new OffscreenCanvas(8, 8);
    const ctx = c.getContext("2d", { colorSpace: "display-p3" });
    const got = ctx.getContextAttributes ? ctx.getContextAttributes().colorSpace : "unknown";
    return { pass: got === "display-p3", note: "reported " + got };
  });
  ok("willReadFrequently accepted", () => {
    const ctx = new OffscreenCanvas(8, 8).getContext("2d", { willReadFrequently: true });
    return { pass: !!ctx };
  });
  ok("getImageData / putImageData", () => {
    const ctx = new OffscreenCanvas(4, 4).getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#123456"; ctx.fillRect(0, 0, 4, 4);
    const d = ctx.getImageData(0, 0, 4, 4);
    ctx.putImageData(d, 0, 0);
    return { pass: d.data[0] === 0x12 && d.data[1] === 0x34 && d.data[2] === 0x56 };
  });
  ok("new ImageData(w,h)", () => ({ pass: new ImageData(4, 4).data.length === 64 }));
  ok("all 19 blend modes settable", () => {
    const ctx = new OffscreenCanvas(4, 4).getContext("2d");
    const modes = ["source-over","darken","multiply","color-burn","lighten","screen","color-dodge",
      "lighter","overlay","soft-light","hard-light","difference","exclusion","hue","saturation","color","luminosity","destination-in","destination-out"];
    const bad = modes.filter((m) => { ctx.globalCompositeOperation = m; return ctx.globalCompositeOperation !== m; });
    return { pass: bad.length === 0, note: bad.length ? "rejected: " + bad.join(",") : modes.length + " ok" };
  });
  ok("gradients (linear/radial/conic)", () => {
    const ctx = new OffscreenCanvas(8, 8).getContext("2d");
    return { pass: !!ctx.createLinearGradient(0,0,8,8) && !!ctx.createRadialGradient(4,4,0,4,4,4) && !!ctx.createConicGradient(0,4,4) };
  });
  ok("Path2D", () => { const p = new Path2D(); p.rect(0,0,4,4); return { pass: !!p }; });
  ok("ctx.filter", () => {
    const ctx = new OffscreenCanvas(8, 8).getContext("2d");
    ctx.filter = "blur(2px)";
    return { pass: ctx.filter === "blur(2px)", note: "reported " + ctx.filter };
  });
  ok("createImageBitmap", () => {
    const c = new OffscreenCanvas(8, 8);
    return { pass: typeof createImageBitmap === "function" && !!c };
  });
  // --- the risky ones: text ---
  ok("measureText with a generic family", () => {
    const ctx = new OffscreenCanvas(64, 64).getContext("2d");
    ctx.font = "32px sans-serif";
    const m = ctx.measureText("Graphiq");
    return { pass: m.width > 0, note: "width " + m.width.toFixed(1) };
  });
  ok("fillText actually marks pixels", () => {
    const c = new OffscreenCanvas(96, 48);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.fillStyle = "#ffffff"; ctx.font = "32px sans-serif"; ctx.fillText("Ag", 4, 36);
    const d = ctx.getImageData(0, 0, 96, 48).data;
    let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i] > 0) n++;
    return { pass: n > 0, note: n + " px drawn" };
  });
  ok("named SYSTEM font resolves (Arial vs sans-serif)", () => {
    const ctx = new OffscreenCanvas(64, 64).getContext("2d");
    ctx.font = "32px Arial"; const a = ctx.measureText("Wg").width;
    ctx.font = "32px 'ThisFontDoesNotExist12345'"; const b = ctx.measureText("Wg").width;
    return { pass: a > 0, note: "Arial " + a.toFixed(1) + " vs bogus " + b.toFixed(1) + (a === b ? " (IDENTICAL - fell back)" : " (distinct)") };
  });
  ok("document.fonts equivalent in worker", () => {
    const has = typeof self.fonts !== "undefined";
    return { pass: has, note: has ? "self.fonts present" : "NO self.fonts - cannot enumerate/load fonts" };
  });
  ok("queryLocalFonts in worker", () => {
    const has = typeof self.queryLocalFonts === "function";
    return { pass: has, note: has ? "present" : "absent (main-thread only)" };
  });
  self.postMessage(R);
};
`;

(async () => {
  const browser = await launchBrowser();
  const page = await (await browser.newContext()).newPage();
  await page.goto("http://localhost:3000", { waitUntil: "domcontentloaded" });
  const rows = await page.evaluate(async (src) => {
    const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
    const w = new Worker(url);
    const res = await new Promise((resolve, reject) => {
      w.onmessage = (e) => resolve(e.data);
      w.onerror = (e) => reject(new Error(e.message));
      w.postMessage("go");
      setTimeout(() => reject(new Error("worker timeout")), 15000);
    });
    w.terminate();
    return res;
  }, WORKER_SRC);
  // main-thread control for transferControlToOffscreen
  const transfer = await page.evaluate(() => {
    try {
      const c = document.createElement("canvas");
      c.width = 32; c.height = 32;
      const off = c.transferControlToOffscreen();
      return { pass: !!off, note: "ok" };
    } catch (e) { return { pass: false, note: String(e).slice(0, 80) }; }
  });
  rows.push({ name: "transferControlToOffscreen (main thread)", ...transfer });
  let fails = 0;
  for (const r of rows) {
    if (!r.pass) fails++;
    console.log(`${r.pass ? "  ok  " : "FAIL  "}${r.name.padEnd(46)}${r.note ? " — " + r.note : ""}`);
  }
  console.log(`\n${rows.length - fails}/${rows.length} capabilities available in a worker`);
  await browser.close();
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
