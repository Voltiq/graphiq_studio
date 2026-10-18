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

/** Alpha census of an image: distinct alpha levels, partial (0<a<255) and inked pixels, a hash. */
export interface Census {
  levels: number;
  partial: number;
  ink: number;
  hash: string;
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
    await this.page.getByRole("button", { name: "Brush" }).first().click();
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
      let ink = 0;
      let h = 0x811c9dc5;
      for (let i = 0; i < d.length; i++) {
        h = Math.imul(h ^ d[i], 0x01000193);
        if (i % 4 !== 3) continue;
        levels.add(d[i]);
        if (d[i]) ink++;
        if (d[i] > 0 && d[i] < 255) partial++;
      }
      return { levels: levels.size, partial, ink, hash: (h >>> 0).toString(36) };
    });
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

  /** Open a dock panel that starts collapsed (its rows only render while open). */
  async expandPanel(name: string): Promise<void> {
    const panel = this.page.locator(`[data-panel-id="${name.toLowerCase()}"]`);
    if ((await panel.getAttribute("data-open")) !== "true") {
      await this.page.getByRole("button", { name: `Expand ${name}` }).first().click();
      await this.settle(400);
    }
  }

  historyRows(): Promise<string[]> {
    return this.page.evaluate(() =>
      [...document.querySelectorAll('[data-panel-id="history"] ol[class*="history"] > li')].map((li) =>
        (li.textContent ?? "").trim(),
      ),
    );
  }
}

export const test = base.extend<{ app: App; keepStartCard: boolean }>({
  /** `test.use({ keepStartCard: true })` for a spec about the phone's start card. */
  keepStartCard: [false, { option: true }],
  // `provide` is Playwright's `use` — renamed, or the React-hooks lint takes it for a hook.
  app: async ({ page, keepStartCard }, provide) => {
    const app = new App(page);
    await app.boot({ keepStartCard });
    await provide(app);
    expect(app.errors, "page errors during the test").toEqual([]);
  },
});

/** Device profiles for `test.use(...)`: the ones the mobile rails are written against. */
export const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
export const SHORT_PHONE = { viewport: { width: 375, height: 667 }, hasTouch: true, isMobile: true };

export { expect };
