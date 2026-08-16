/**
 * crash.ts — the recovery registry and the crash report.
 *
 * This code only ever runs when something has already gone wrong, which makes
 * the usual failure mode a nasty one: a recovery path that throws takes the
 * user's last chance at their work with it. So the tests lean on the awkward
 * inputs — a collector that throws, one that returns nothing, a thrown string
 * instead of an Error, a document named `../../etc/passwd` — rather than on the
 * happy path.
 */
import { beforeEach, describe, expect, it } from "vitest";
import {
  clearRecentErrors,
  collectRecovery,
  describeAge,
  formatBytes,
  formatReport,
  hasRecoverySource,
  noteRuntimeError,
  recentErrors,
  recoveryFilename,
  registerRecovery,
  toCrashInfo,
  trimStack,
} from "@/app/lib/crash";

const doc = (name: string, json = '{"format":"graphiq"}') => ({ name, json });

beforeEach(() => {
  registerRecovery(null);
  clearRecentErrors();
});

describe("the recovery registry", () => {
  it("reports nothing when no collector was ever registered", () => {
    expect(hasRecoverySource()).toBe(false);
    const r = collectRecovery();
    expect(r.origin).toBe("none");
    expect(r.docs).toEqual([]);
    expect(r.problem).toMatch(/no collector/);
  });

  it("returns what the collector gives it", () => {
    registerRecovery(() => [doc("Untitled-1"), doc("Photo")]);
    const r = collectRecovery();
    expect(r.origin).toBe("live");
    expect(r.docs.map((d) => d.name)).toEqual(["Untitled-1", "Photo"]);
  });

  it("survives a collector that throws — that is the whole point", () => {
    registerRecovery(() => {
      throw new TypeError("engine is gone");
    });
    const r = collectRecovery();
    expect(r.origin).toBe("none");
    expect(r.problem).toBe("TypeError: engine is gone");
  });

  it("treats an empty or junk result as nothing to save", () => {
    registerRecovery(() => []);
    expect(collectRecovery().problem).toMatch(/no documents/);
    // A document whose serialization failed comes back with an empty string;
    // offering to "save" it would hand the user an empty file.
    registerRecovery(() => [doc("Broken", ""), doc("Good")]);
    const r = collectRecovery();
    expect(r.docs.map((d) => d.name)).toEqual(["Good"]);
  });

  it("unregisters", () => {
    registerRecovery(() => [doc("A")]);
    expect(hasRecoverySource()).toBe(true);
    registerRecovery(null);
    expect(hasRecoverySource()).toBe(false);
  });
});

describe("toCrashInfo", () => {
  it("keeps an Error's name, message and stack", () => {
    const e = new RangeError("out of range");
    const info = toCrashInfo(e, "  at Editor");
    expect(info.message).toBe("RangeError: out of range");
    expect(info.stack).toContain("out of range");
    expect(info.componentStack).toBe("  at Editor");
  });

  it("copes with the things that are thrown but are not Errors", () => {
    expect(toCrashInfo("just a string").message).toBe("just a string");
    expect(toCrashInfo({ code: 7 }).message).toBe('{"code":7}');
    expect(toCrashInfo(undefined).message).toBeTypeOf("string");
  });
});

describe("trimStack", () => {
  const long = Array.from({ length: 40 }, (_, i) => `  at frame${i} (file.js:${i})`).join("\n");

  it("keeps the top frames and says how many it dropped", () => {
    const t = trimStack(long, 12);
    expect(t.split("\n")).toHaveLength(13);
    expect(t).toContain("frame0");
    expect(t).not.toContain("frame12");
    expect(t).toContain("28 more");
  });

  it("leaves a short stack alone", () => {
    expect(trimStack("a\nb")).toBe("a\nb");
    expect(trimStack(undefined)).toBe("");
  });
});

describe("formatReport", () => {
  const info = toCrashInfo(new Error("boom"), "  at Canvas", new Date("2026-08-16T12:00:00Z"));

  it("carries the error, the environment and the document shape", () => {
    const r = formatReport(info, { version: "0.62.0", userAgent: "TestBrowser/1" }, [
      doc("Untitled-1", "x".repeat(2048)),
    ]);
    expect(r).toContain("Error: boom");
    expect(r).toContain("0.62.0");
    expect(r).toContain("TestBrowser/1");
    expect(r).toContain("2026-08-16T12:00:00.000Z");
    expect(r).toContain("Untitled-1 (2.0 KB)");
  });

  it("never carries image data — the report is meant to be pasted in public", () => {
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUg" + "A".repeat(4000);
    const r = formatReport(info, {}, [doc("Photo", JSON.stringify({ images: [{ data: png }] }))]);
    expect(r).not.toContain("data:image/png");
    expect(r).not.toContain("iVBORw0KG");
    expect(r).toContain("Photo (");
    expect(r).toContain("No image data");
  });

  it("omits the sections it has nothing for", () => {
    const bare = formatReport({ message: "x", at: new Date() });
    expect(bare).not.toContain("component stack");
    expect(bare).not.toContain("documents open");
    expect(bare).not.toContain("earlier runtime errors");
  });

  it("includes earlier runtime errors, which no boundary would have seen", () => {
    noteRuntimeError("pointer handler blew up");
    const r = formatReport(info, {}, []);
    expect(r).toContain("earlier runtime errors (1)");
    expect(r).toContain("pointer handler blew up");
  });
});

describe("the runtime-error log", () => {
  it("keeps at most ten, newest last", () => {
    for (let i = 0; i < 15; i++) noteRuntimeError(`err ${i}`);
    const errs = recentErrors();
    expect(errs).toHaveLength(10);
    expect(errs[0]).toContain("err 5");
    expect(errs[9]).toContain("err 14");
  });

  it("collapses an error repeating every frame", () => {
    // A throw inside a pointer handler fires on every move; without this the
    // log would be ten copies of one line and no history at all.
    for (let i = 0; i < 5; i++) noteRuntimeError("same failure", new Date("2026-08-16T12:00:00Z"));
    expect(recentErrors()).toHaveLength(1);
  });

  it("truncates a huge message instead of holding onto it", () => {
    noteRuntimeError("x".repeat(5000));
    expect(recentErrors()[0].length).toBeLessThan(400);
  });

  it("hands back a copy, not the live array", () => {
    noteRuntimeError("one");
    recentErrors().push("forged");
    expect(recentErrors()).toHaveLength(1);
  });
});

describe("recoveryFilename", () => {
  const at = new Date(2026, 7, 16, 18, 5); // 2026-08-16 18:05, local

  it("names the file after the document, with a timestamp", () => {
    expect(recoveryFilename("Untitled-1", "gproj", at)).toBe("Untitled-1-recovered-2026-08-16-1805.gproj");
  });

  it("drops an existing extension rather than stacking two", () => {
    expect(recoveryFilename("Holiday.gproj", "gproj", at)).toBe("Holiday-recovered-2026-08-16-1805.gproj");
  });

  it("scrubs anything that would confuse a filesystem", () => {
    // A document name is user input, and it ends up in a download attribute.
    const n = recoveryFilename("../../etc/passwd", "gproj", at);
    expect(n).not.toContain("/");
    expect(n).not.toContain("..");
    expect(recoveryFilename('a:b*c?"d<e>f|g', "gproj", at)).toMatch(/^a-b-c-d-e-f-g-recovered/);
  });

  it("falls back to a name when there is nothing usable left", () => {
    expect(recoveryFilename("", "gproj", at)).toMatch(/^Untitled-recovered/);
    expect(recoveryFilename("///", "gproj", at)).toMatch(/^Untitled-recovered/);
  });

  it("keeps the name to a sane length", () => {
    expect(recoveryFilename("z".repeat(500), "gproj", at).length).toBeLessThan(100);
  });
});

describe("small formatters", () => {
  it("formats bytes at each scale", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
  });

  it("describes an age the way a person would say it", () => {
    expect(describeAge(1000)).toBe("moments ago");
    expect(describeAge(60_000)).toBe("1 minute ago");
    expect(describeAge(4 * 60_000)).toBe("4 minutes ago");
    expect(describeAge(2 * 3600_000)).toBe("2 hours ago");
    expect(describeAge(-5)).toBe("moments ago"); // a clock that went backwards
  });
});
