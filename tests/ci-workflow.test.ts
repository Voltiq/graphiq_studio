/**
 * The CI workflow is a file like any other, and it can break like one.
 *
 * From 2026-08-25 to 2026-10-16 `.github/workflows/ci.yml` did not parse — one
 * step was named `"More space" offers …`, a quoted scalar with text after it —
 * and GitHub does not run a workflow it cannot read. Every push in those seven
 * weeks reported a failure that was about the file, not the code, and no check
 * ran at all. Nothing local noticed, because nothing local reads the file.
 *
 * So `npm run check` reads it: it must parse, and every `npm run X` it names
 * must be a script that exists — the other way a step silently stops testing.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const yaml = createRequire(import.meta.url)("js-yaml") as { load(src: string): unknown };

interface Step {
  name?: string;
  run?: string;
}
interface Workflow {
  jobs: Record<string, { steps: Step[] }>;
}

const src = readFileSync(resolve(process.cwd(), ".github/workflows/ci.yml"), "utf8");
const scripts = Object.keys(
  (JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8")) as { scripts: object })
    .scripts,
);

describe("the CI workflow", () => {
  it("parses as YAML", () => {
    expect(() => yaml.load(src)).not.toThrow();
  });

  it("only runs npm scripts that exist", () => {
    const wf = yaml.load(src) as Workflow;
    const named = Object.values(wf.jobs)
      .flatMap((j) => j.steps)
      .flatMap((s) => [...(s.run ?? "").matchAll(/npm run (?:-s )?([\w:-]+)/g)].map((m) => m[1]));
    /* A truncated file must not pass: the gates by name, now that the old
       browser job's two dozen harness steps are e2e specs under one command. */
    expect(named).toEqual(expect.arrayContaining(["lint", "check", "build", "test:e2e"]));
    expect(named.filter((n) => !scripts.includes(n))).toEqual([]);
  });
});
