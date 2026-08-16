import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

/**
 * Unit tests for the pure libs.
 *
 * These run in plain Node, not jsdom: the modules under test are deliberately
 * DOM-free (tone/filters/gradient/render-graph/layers/view do arithmetic on
 * numbers and trees), so a browser environment would only add startup cost and
 * hide accidental DOM dependencies instead of failing on them. The one exception
 * is `ImageData`, which filters.ts constructs — `tests/setup.ts` provides it.
 *
 * Anything needing a real canvas is covered by the Playwright drivers instead.
 */
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
  },
  resolve: {
    // Mirrors tsconfig's `"@/*": ["./*"]` so tests can import either way.
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
});
