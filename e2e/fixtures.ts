/**
 * The one way a rail boots and drives Graphiq.
 *
 * Every `tools/verify-*.js` script carried its own copy of this: wait for the
 * canvas, dismiss the delayed tour, hide Next's dev overlay, drive a range input
 * the way React hears it, read pixels back. Copies drifted — one closed dialogs
 * with Escape on ANY role="dialog", which also cleared the selection under test.
 * Here it exists once, and the `app` fixture also fails any test that threw a
 * page error, so no rail has to remember to check.
 */
import { test as base, expect, type Page } from "@playwright/test";
/* window.graphiq is declared (optional) by app/lib/scripting.ts; boot() proves
   it is installed, so page code below asserts it with `!`. */
import type {} from "../app/lib/scripting"; // types only: the global declaration

declare global {
  interface Window {
    /** Dev-only render-cache A/B hook (CanvasArea). Absent in production builds. */
    __gqRenderCache?: {
      enable(): void;
      disable(): void;
      regionOn(): void;
      regionOff(): void;
      stats(): {
        entries: number;
        hits: number;
        misses: number;
        tiles: number;
        regionHits: number;
        liveRegionHits: number;
        liveRegionPx: number;
        workerJobs: number;
        filterWorkerResults: number;
      };
      /** The active layer's cached smart-filter product vs a fresh inline
       *  render of the same stack; null while the cached product is stale. */
      filterAB(id?: string): {
        differing: number;
        worst: number;
        total: number;
        quality: "preview" | "full";
        digest: number;
        sample: { at: number; cached: number[]; inline: number[] } | null;
      } | null;
    };
  }
}

/** Alpha census of an image: distinct alpha levels, partial (0<a<255) and inked pixels, a hash. */
export interface Census {
  levels: number;
  partial: number;
  ink: number;
  hash: string;
  /** Sum of every alpha value — compares coverage as a whole (e.g. an exact inverse). */
  alphaSum: number;
}

export class App {
  readonly errors: string[] = [];
  /** console.error output. Recorded, not asserted by default — a spec that
   *  promises a clean console says so (`expect(app.consoleErrors)…`). */
  readonly consoleErrors: string[] = [];

  constructor(readonly page: Page) {
    page.on("pageerror", (e) => this.errors.push(String(e)));
    page.on("console", (m) => {
      if (m.type() === "error") this.consoleErrors.push(m.text());
    });
  }

  /** Click through the menu bar: `menu("Layer", "New layer")`. */
  async menu(top: string, item: string): Promise<void> {
    await this.page.getByText(top, { exact: true }).first().click();
    await this.settle(200);
    await this.page.getByText(item, { exact: true }).first().click();
    await this.settle(600);
  }

  async boot(opts: { keepStartCard?: boolean } = {}): Promise<void> {
    const { page } = this;
    /* GQ_THROTTLE=<n>: run the page n× slower (CDP CPU throttling) — a CI runner
       on a fast desk. Load-dependent behaviour (coalesced pointer events, worker
       timing) only shows up there otherwise. */
    const throttle = Number(process.env.GQ_THROTTLE || 0);
    if (throttle > 1) {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.waitForSelector('[data-tour="canvas"]', { timeout: 60_000 });
    await page.waitForFunction(() => typeof window.graphiq === "object", null, { timeout: 30_000 });
    // The tour mounts late and owns the keyboard until it is gone.
    const tour = await page
      .waitForSelector('div[aria-label="Interactive tour"]', { timeout: 8_000 })
      .catch(() => null);
    if (tour) {
      await page.keyboard.press("Escape");
      await page.waitForSelector('div[aria-label="Interactive tour"]', { state: "detached", timeout: 5_000 });
    }
    await page.addStyleTag({ content: "nextjs-portal{display:none!important}" });
    /* A fresh phone opens on the start card, which covers the canvas. Start
       blank, as a user would — unless the spec is about the card itself. */
    const blank = page.locator('[data-start="blank"]');
    if (!opts.keepStartCard && (await blank.count())) await blank.first().click();
    await this.settle(600);
  }

  settle(ms = 800): Promise<void> {
    return this.page.waitForTimeout(ms);
  }

  /** Wait until `sel` has stopped moving: every finite animation on it and in
   *  it has ended. A fixed sleep reads a spring wherever a slow runner has got
   *  to — CI measured a dialog 1px taller, caught in its entrance overshoot. */
  async still(sel: string, timeout = 5_000): Promise<void> {
    await this.page.waitForFunction(
      (sel) => {
        const el = document.querySelector(sel);
        return (
          !!el &&
          el
            .getAnimations({ subtree: true })
            .every((a) => a.playState !== "running" || a.effect?.getComputedTiming().iterations === Infinity)
        );
      },
      sel,
      { timeout },
    );
  }

  /** Run a menu command, then close any MODAL dialog it opened. Modal only: a
   *  popover is a role="dialog" too, and Escape there also deselects. */
  async run(action: string): Promise<void> {
    await this.page.evaluate((a) => window.graphiq!.run(a), action);
    await this.settle();
    for (let i = 0; i < 3 && (await this.page.locator('div[role="dialog"][aria-modal="true"]').count()); i++) {
      await this.page.keyboard.press("Escape");
      await this.settle(300);
    }
  }

  docs() {
    return this.page.evaluate(() => window.graphiq!.docs());
  }

  async activate(id: string): Promise<void> {
    await this.page.evaluate((i) => window.graphiq!.activate(i), id);
    await this.settle();
  }

  /** File ▸ New with the default size; returns the new document's id. */
  async newDoc(): Promise<string> {
    const before = new Set((await this.docs()).map((d) => d.id));
    await this.page.evaluate(() => window.graphiq!.run("new-doc"));
    await this.settle();
    const dlg = this.page.locator('div[role="dialog"][aria-label="New document"]');
    if (await dlg.count()) {
      await dlg.getByText("Create", { exact: true }).click();
      await this.settle();
    }
    const made = (await this.docs()).find((d) => !before.has(d.id));
    if (!made) throw new Error("File ▸ New made no document");
    return made.id;
  }

  layerNames() {
    return this.page.evaluate(() => window.graphiq!.layers().map((l) => l.name));
  }

  async setForeground(hex: string): Promise<void> {
    await this.page.evaluate((h) => window.graphiq!.setForeground(h), hex);
    await this.settle(300);
  }

  /** Set a range input by its aria-label, through React's own value tracker. */
  setRange(label: string, value: number): Promise<boolean> {
    return this.page.evaluate(
      ([l, v]) => {
        const el = document.querySelector<HTMLInputElement>(`input[type="range"][aria-label="${l}"]`);
        if (!el) return false;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, String(v));
        el.dispatchEvent(new Event("input", { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        return true;
      },
      [label, value] as const,
    );
  }

  async canvasBox() {
    const box = await this.page.locator('[data-tour="canvas"] canvas').first().boundingBox();
    if (!box) throw new Error("no canvas on screen");
    return box;
  }

  /** A horizontal drag across the canvas at height `fy` (fractions of the view). */
  async drag(fy: number, x0 = 0.2, x1 = 0.8): Promise<void> {
    const b = await this.canvasBox();
    await this.page.mouse.move(b.x + b.width * x0, b.y + b.height * fy);
    await this.page.mouse.down();
    await this.page.mouse.move(b.x + b.width * x1, b.y + b.height * fy, { steps: 30 });
    await this.page.mouse.up();
    await this.settle();
    await this.parkMouse();
  }

  /** Move the pointer off the artwork, so a cursor ring cannot reach a reading. */
  async parkMouse(): Promise<void> {
    const b = await this.canvasBox();
    await this.page.mouse.move(b.x + 2, b.y + 2);
  }

  async brush(size: number, hardness: number): Promise<void> {
    await this.page.getByRole("button", { name: "Brush", exact: true }).click();
    await this.settle(300);
    await this.setRange("Size", size);
    await this.setRange("Hardness", hardness);
  }

  async key(k: string): Promise<void> {
    await this.page.keyboard.press(k);
    await this.settle();
  }

  /** The exported composite — the document as a file sees it. A pending float
   *  is NOT in it (it is not part of the document yet). */
  exported(): Promise<Census> {
    return this.page.evaluate(async () => {
      const blob = await window.graphiq!.exportPNG();
      if (!blob) throw new Error("exportPNG returned nothing");
      const bmp = await createImageBitmap(blob);
      const c = new OffscreenCanvas(bmp.width, bmp.height);
      const x = c.getContext("2d")!;
      x.drawImage(bmp, 0, 0);
      const d = x.getImageData(0, 0, bmp.width, bmp.height).data;
      const levels = new Set<number>();
      let partial = 0;
      let alphaSum = 0;
      let ink = 0;
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) {
        h = Math.imul(h ^ d[i], 0x01000193);
        if (i % 4 !== 3) continue;
        levels.add(d[i]);
        if (d[i]) ink++;
        if (d[i] > 0 && d[i] < 255) partial++;
        alphaSum += d[i];
      }
      return { levels: levels.size, partial, ink, alphaSum, hash: (h >>> 0).toString(36) };
    });
  }

  /** Size, ink and a byte hash of the on-screen view canvas. */
  viewShot(): Promise<{ hash: string; ink: number; w: number; h: number }> {
    return this.page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let a = 0x811c9dc5;
      let b = 0x9dc5811c;
      let ink = 0;
      for (let i = 0; i < d.length; i++) {
        a = Math.imul(a ^ d[i], 0x01000193);
        b = Math.imul(b ^ d[i], 0x01000197);
        if (i % 4 === 3 && d[i] > 0) ink++;
      }
      return { hash: (a >>> 0).toString(36) + "." + (b >>> 0).toString(36), ink, w: c.width, h: c.height };
    });
  }

  /** A viewShot taken once the canvas has STOPPED changing: two equal hashes
   *  250 ms apart. Opening a document decodes and composites asynchronously, so
   *  one read after a fixed wait can catch a half-drawn frame — which once read
   *  as a colour difference in a recovery check whose pixels were identical. */
  async stableViewShot(tries = 20) {
    let prev = await this.viewShot();
    for (let i = 0; i < tries; i++) {
      await this.settle(250);
      const next = await this.viewShot();
      if (next.hash === prev.hash) return next;
      prev = next;
    }
    return prev;
  }

  /** Painted pixels on the on-screen view canvas — what the user sees, floats included. */
  viewInk(): Promise<number> {
    return this.page.evaluate(() => {
      const c = document.querySelector<HTMLCanvasElement>('[data-tour="canvas"] canvas')!;
      const d = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
      let n = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i]) n++;
      return n;
    });
  }

  /** Open the command palette the way a user of this shell would: the search
   *  field in the top bar, or — on the phone, whose header has none — the
   *  "Search all commands" row that leads the menu sheet. */
  async openPalette(): Promise<void> {
    const { page } = this;
    const field = page.locator('button[aria-label="Open the command palette"]');
    if (await field.count()) {
      await field.first().click();
    } else {
      await page.locator('button[aria-label="Menu"]').first().click();
      await page.locator("[data-sheet-search]").first().click();
    }
    await this.settle(400);
  }

  /** Choose a tool on the desktop rail: its slot button if the slot is showing
   *  it, otherwise from the flyout of the slot that holds it (right-click opens
   *  one; each is tried until the tool turns up). */
  async pickTool(name: string): Promise<void> {
    const { page } = this;
    const rail = page.locator('[data-tour="toolbar"]');
    const direct = rail.getByRole("button", { name: new RegExp(`^${name}\\b`) });
    if (await direct.count()) {
      await direct.first().click();
      await this.settle(300);
      return;
    }
    const slots = rail.locator('button[aria-haspopup="menu"]');
    for (let i = 0; i < (await slots.count()); i++) {
      await slots.nth(i).click({ button: "right" });
      const item = page.getByRole("menuitemradio", { name: new RegExp(`^${name}\\b`) });
      if (await item.count()) {
        await item.first().click();
        await this.settle(300);
        return;
      }
      await page.keyboard.press("Escape");
    }
    throw new Error(`no rail slot holds a tool named ${name}`);
  }

  /** Open a dock panel that starts collapsed (its rows only render while open). */
  async expandPanel(name: string): Promise<void> {
    await this.openPanelById(name.toLowerCase());
  }

  /** Give the display unusable edges, the way a notch and a home indicator
   *  do, so `env(safe-area-inset-*)` resolves for real (CDP). All zeros clears. */
  async setSafeArea(insets: { top: number; right: number; bottom: number; left: number }): Promise<void> {
    await this.cdp("Emulation.setSafeAreaInsetsOverride", { insets });
    await this.settle(300);
  }

  /** A Chrome DevTools Protocol call on this page (one session, reused). */
  async cdp(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.cdpSession ??= await this.page.context().newCDPSession(this.page);
    // The protocol's method map is typed per name; these specs call a handful by string.
    const send = this.cdpSession.send as (this: unknown, m: string, p: object) => Promise<unknown>;
    return send.call(this.cdpSession, method, params);
  }
  private cdpSession: import("@playwright/test").CDPSession | null = null;

  /* A REAL finger. In a `hasTouch` context `page.mouse` still delivers
     `pointerType: "mouse"`, and Playwright's touchscreen only taps, so a drag
     goes through CDP. The point carries a radius and force like a finger. */
  private finger: { x: number; y: number } | null = null;
  private touchAt = (x: number, y: number) => [{ x, y, radiusX: 12, radiusY: 12, force: 1, id: 1 }];
  async touchDown(x: number, y: number): Promise<void> {
    this.finger = { x, y };
    await this.cdp("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: this.touchAt(x, y) });
  }
  /** Move the finger down to (x, y) in `steps`, so the app sees moves, not a teleport. */
  async touchMove(x: number, y: number, steps = 6): Promise<void> {
    const from = this.finger ?? { x, y };
    for (let i = 1; i <= steps; i++) {
      const at = { x: from.x + ((x - from.x) * i) / steps, y: from.y + ((y - from.y) * i) / steps };
      await this.cdp("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: this.touchAt(at.x, at.y) });
    }
    this.finger = { x, y };
  }
  async touchUp(): Promise<void> {
    await this.cdp("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
    this.finger = null;
  }

  /** A raw multi-finger touch event: every point currently down, in order.
   *  For gestures the single-finger helpers cannot express (a pinch). */
  async touches(type: "touchStart" | "touchMove" | "touchEnd", points: { x: number; y: number }[]): Promise<void> {
    await this.cdp("Input.dispatchTouchEvent", {
      type,
      touchPoints: points.map((p, i) => ({ x: Math.round(p.x), y: Math.round(p.y), radiusX: 12, radiusY: 12, force: 1, id: i + 1 })),
    });
  }

  /** Open a panel by its `data-panel-id`, whichever shell it is in: the
   *  phone's sheet picks a panel from its chip strip, a dock unfolds it. */
  async openPanelById(id: string): Promise<boolean> {
    const section = this.page.locator(`[data-panel-id="${id}"]`);
    if (!(await section.count())) return false;
    if ((await section.first().getAttribute("data-open")) === "true") return true;
    const chip = this.page.locator(`[data-panel-chip="${id}"]`);
    if (await chip.count()) await chip.first().click();
    else await section.locator('button[class*="panelCaret"]').first().click();
    await this.settle(650);
    return (await section.first().getAttribute("data-open")) === "true";
  }

  /** Phone: step the panels sheet's handle until it rests at `want` ("peek" | "half" | "full"). */
  async setSheetDetent(want: string): Promise<boolean> {
    const handle = this.page.locator("[data-sheet-handle]");
    if (!(await handle.count())) return false;
    for (let i = 0; i < 4; i++) {
      if ((await this.page.evaluate(() => document.documentElement.dataset.sheet)) === want) return true;
      await handle.first().click();
      await this.settle(420);
    }
    return (await this.page.evaluate(() => document.documentElement.dataset.sheet)) === want;
  }

  historyRows(): Promise<string[]> {
    return this.page.evaluate(() =>
      [...document.querySelectorAll('[data-panel-id="history"] ol[class*="history"] > li')].map((li) =>
        (li.textContent ?? "").trim(),
      ),
    );
  }
}

/** The hardware the page is told it runs on. */
export interface Hardware {
  cores: number;
  memoryGB: number;
}

export const test = base.extend<{
  app: App;
  keepStartCard: boolean;
  hardware: Hardware | null;
  filePickers: boolean;
  storage: Record<string, string> | null;
}>({
  /** `test.use({ keepStartCard: true })` for a spec about the phone's start card. */
  keepStartCard: [false, { option: true }],
  /* `test.use({ filePickers: false })` removes the File System Access pickers
     before the app boots. With them, Save and Open raise a native dialog no
     automation can reach; without them the app takes its download and
     <input type=file> route — the one every browser lacking the API uses. */
  filePickers: [true, { option: true }],
  /** `test.use({ storage: { "pe-colorspace": "display-p3" } })`: localStorage
   *  the session starts with, written before any app code runs. */
  storage: [null, { option: true }],
  /* Pinned by default, so no test depends on the machine running it. The app
     sizes its budgets from `hardwareConcurrency` / `deviceMemory`, and a 4-core
     GitHub runner halves the live-filter frame: the region-scope live test's
     "full-resolution" reference quietly became a 72%-scale draft there and
     failed for two days of wrong diagnoses (Linux rounding, un-premultiply,
     canvas copies) before it was reproduced here by reporting 4 cores.
     `test.use({ hardware: null })` lets a spec about the hints see the host. */
  hardware: [{ cores: 16, memoryGB: 8 }, { option: true }],
  // `provide` is Playwright's `use` — renamed, or the React-hooks lint takes it for a hook.
  app: async ({ page, keepStartCard, hardware, filePickers, storage }, provide) => {
    const app = await bootApp(page, { keepStartCard, hardware, filePickers, storage: storage ?? undefined });
    await provide(app);
    expect(app.errors, "page errors during the test").toEqual([]);
  },
});

export interface BootOptions {
  keepStartCard?: boolean;
  hardware?: Hardware | null;
  filePickers?: boolean;
  /** localStorage entries written before any app code runs — a preference the
   *  session should start with (e.g. `{ "pe-colorspace": "display-p3" }`). */
  storage?: Record<string, string>;
}

/** Boot Graphiq on any page, the way the `app` fixture does. For a test that
 *  needs a SECOND, independent session (its own context, its own storage):
 *  `bootApp(await (await browser.newContext({ baseURL })).newPage(), …)`.
 *  The defaults match the fixture's: hardware pinned, pickers present. */
export async function bootApp(page: Page, opts: BootOptions = {}): Promise<App> {
  const { keepStartCard = false, hardware = { cores: 16, memoryGB: 8 }, filePickers = true, storage } = opts;
  if (storage) {
    await page.addInitScript((entries) => {
      for (const [k, v] of Object.entries(entries)) localStorage.setItem(k, v);
    }, storage);
  }
  if (!filePickers) {
    await page.addInitScript(() => {
      const w = window as unknown as Record<string, unknown>;
      delete w.showSaveFilePicker;
      delete w.showOpenFilePicker;
    });
  }
  if (hardware) {
    await page.addInitScript((hw) => {
      Object.defineProperty(navigator, "hardwareConcurrency", { get: () => hw.cores, configurable: true });
      Object.defineProperty(navigator, "deviceMemory", { get: () => hw.memoryGB, configurable: true });
    }, hardware);
  }
  const app = new App(page);
  await app.boot({ keepStartCard });
  return app;
}

/** Device profiles for `test.use(...)`: the ones the mobile rails are written against. */
export const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
export const SHORT_PHONE = { viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true };

export { expect };
