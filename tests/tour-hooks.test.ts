/**
 * `data-tour` is load-bearing, so renaming one must not be silent.
 *
 * CSS-module class names are hashed, so a stylesheet cannot say `.toolbar` about
 * another module's element. The mobile layout works around that by keying off
 * `data-tour` attributes instead — and the onboarding tour and every browser
 * rail do the same, for the same reason. That makes a plain string in an
 * attribute the joint between four things that never reference each other:
 *
 *   PROVIDERS  the markup, `app/**  /*.tsx`
 *   CONSUMERS  the stylesheets (`app/**  /*.scss`) — the mobile shell's layout
 *              the tour (`app/lib/tour.ts`) — `target: "topbar"`, a bare string
 *              the harness (`tools/*.js`) — 70 files select on these
 *
 * Nothing type-checks across that joint. Renaming `data-tour="toolbar"` in the
 * markup leaves `npm run check` green while the mobile shell loses its layout,
 * the tour spotlights nothing, and every rail that opens the toolbar times out.
 *
 * So the invariant is a containment: everything named by a consumer must be
 * provided by the markup.
 *
 * NOT VACUOUS BY CONSTRUCTION. A containment check passes trivially when both
 * sides are empty, which is exactly what a renamed attribute or a broken regex
 * produces — so each set's size is asserted before the containment is. That
 * failure mode is the one this file would otherwise be most likely to have.
 *
 * KNOWN LIMIT, stated rather than implied: the shell's other hooks —
 * `data-mobile`, `data-touch`, `data-drawer`, `data-tablet` — are written onto
 * the root by script (`el.dataset.drawer = …`), not spelled as attributes in
 * markup, so a text scan cannot pair them up the way it pairs these. They are
 * covered instead by the browser rails that assert the shell's geometry.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { MOBILE_TOUR_STEPS, TOUR_STEPS } from "../app/lib/tour";

const root = process.cwd();

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(resolve(root, dir), { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name.startsWith(".")) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

const read = (p: string) => readFileSync(resolve(root, p), "utf8");

/**
 * Where a hook is RENDERED, versus where it is merely SELECTED.
 *
 * The distinction is the whole test, and getting it wrong made this file pass a
 * break it was written to catch. `Editor.tsx` contains the text
 * `data-tour="canvas"` inside a `closest('[data-tour="canvas"]')` call — a
 * consumer, not a provider — so a single regex counted the app's own selector as
 * proof the markup still rendered the attribute. Renaming the real one in
 * `CanvasArea.tsx` then left every check green. A provider is the attribute
 * without its brackets; a consumer has them.
 */
const PROVIDER = /(?<!\[)data-tour="([a-zA-Z0-9_-]+)"/g;
const SELECTOR = /\[data-tour="([a-zA-Z0-9_-]+)"\]/g;

function scan(files: string[], re: RegExp): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const f of files)
    for (const m of read(f).matchAll(re)) {
      const list = found.get(m[1]) ?? [];
      if (!list.includes(f)) list.push(f);
      found.set(m[1], list);
    }
  return found;
}

const provided = scan(walk("app", /\.tsx$/), PROVIDER);
const byStyles = scan(walk("app", /\.scss$/), SELECTOR);
const byTools = scan(walk("tools", /\.js$/), SELECTOR);
/* The app's own runtime selectors — gesture guards, hit tests, `closest` calls. */
const byApp = scan(walk("app", /\.tsx?$/), SELECTOR);
const byTour = new Map<string, string[]>(
  [...TOUR_STEPS, ...MOBILE_TOUR_STEPS]
    .flatMap((s) => (s.target ? [s.target] : []))
    .map((t) => [t, ["app/lib/tour.ts"]]),
);

describe("the data-tour hooks the mobile shell, the tour and the rails depend on", () => {
  /* The guards against a check that cannot fail. Each is a floor, not an exact
     count, so adding a hook or a rail does not break the suite. */
  it("finds the hooks at all — in the markup, the styles, the tour and the rails", () => {
    expect(provided.size, "no data-tour attributes found in any .tsx").toBeGreaterThanOrEqual(6);
    expect(byStyles.size, "no data-tour selectors found in any .scss").toBeGreaterThanOrEqual(3);
    expect(byTour.size, "the tour spotlights nothing").toBeGreaterThanOrEqual(6);
    expect(byTools.size, "no rail selects on a data-tour hook").toBeGreaterThanOrEqual(6);
    expect(byApp.size, "the app selects on no data-tour hook").toBeGreaterThanOrEqual(1);
  });

  /* Three separate cases, so a failure names the thing that breaks rather than
     "a hook is missing". */
  it("provides every hook the stylesheets lay out the mobile shell with", () => {
    for (const [hook, files] of byStyles)
      expect(
        provided.has(hook),
        `${files.join(", ")} styles [data-tour="${hook}"], which no .tsx renders`,
      ).toBe(true);
  });

  it("provides every hook the tour spotlights", () => {
    for (const hook of byTour.keys())
      expect(
        provided.has(hook),
        `a tour step targets "${hook}", which no .tsx renders — the step would spotlight nothing`,
      ).toBe(true);
  });

  it("provides every hook the browser rails select on", () => {
    for (const [hook, files] of byTools)
      expect(
        provided.has(hook),
        `${files.length} rail(s) select [data-tour="${hook}"], which no .tsx renders ` +
          `(first: ${files[0]})`,
      ).toBe(true);
  });

  it("provides every hook the app's own runtime selectors look for", () => {
    for (const [hook, files] of byApp)
      expect(
        provided.has(hook),
        `${files.join(", ")} selects [data-tour="${hook}"] at runtime, which no .tsx renders`,
      ).toBe(true);
  });

  /* The hooks the mobile layout cannot work without, named outright. The
     containment above only fires while a consumer still mentions the hook — if
     a rename were applied to the markup AND the stylesheet in one sweep, the
     shell would break and the check would stay green. */
  it("keeps the hooks the mobile shell is built out of", () => {
    for (const hook of ["toolbar", "dock", "options", "status", "canvas", "mobilebar"])
      expect(provided.has(hook), `data-tour="${hook}" has gone missing from the markup`).toBe(true);
  });
});
