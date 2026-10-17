import { defineConfig } from "@playwright/test";

/**
 * Browser rails, under Playwright Test (TODO 2.1).
 *
 * These are moving here from `tools/verify-*.js` — 75 hand-rolled scripts that
 * each launched their own browser and re-implemented booting the app — one at a
 * time. What this runner adds: one shared fixture (`e2e/fixtures.ts`), parallel
 * workers, CI sharding, and a trace on every failure (the CI job uploads it), so
 * a red run can be diagnosed without reading raw logs.
 *
 *   npm run test:e2e                       uses the dev server on :3000, or starts one
 *   GQ_URL=http://host:port npm run test:e2e   drives a server you started elsewhere
 *   GQ_CHANNEL=chrome | msedge | chromium      which installed browser (default msedge)
 *   GQ_HEADFUL=1                               watch it run
 */
const channel = process.env.GQ_CHANNEL ?? "msedge";
const baseURL = process.env.GQ_URL ?? "http://localhost:3000";

export default defineConfig({
  testDir: "e2e",
  timeout: 180_000,
  expect: { timeout: 10_000 },
  /* No retries, deliberately. Every flake chased down in these rails so far was
     a real timing bug in the rail (a fixed sleep racing a worker) or in the
     product; a retry would have hidden each one. */
  retries: 0,
  /* Every test boots its own page (the `app` fixture), so tests — not just
     files — can run in parallel and be split across CI shards. */
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  /* `github` turns each failure into an annotation on the run, which the public
     API serves without the admin rights raw logs need. */
  reporter: process.env.CI ? [["list"], ["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    // "chromium" = Playwright's own build, which is chosen by naming NO channel.
    channel: channel === "chromium" ? undefined : channel,
    headless: !process.env.GQ_HEADFUL,
    viewport: { width: 1400, height: 900 },
    trace: "retain-on-failure",
  },
  webServer: process.env.GQ_URL
    ? undefined
    : {
        command: "npm run dev",
        url: baseURL,
        reuseExistingServer: true,
        timeout: 180_000,
      },
});
