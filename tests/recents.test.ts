import { describe, expect, it } from "vitest";
import { RECENT_IMAGE_BYTES, trimRecents, type RecentMeta } from "../app/lib/recents";

/**
 * What survives a trim of the recent-files list.
 *
 * The list used to hold only projects, where a count limit was the whole story.
 * It now also holds pictures, which are three orders of magnitude larger, so a
 * second cap on bytes joined it — and two caps that can disagree is exactly the
 * kind of arithmetic worth pinning down away from IndexedDB.
 *
 * The case that matters most is `keepId`: the entry just added is never the one
 * trimmed away. Without it, opening a photograph bigger than the whole budget
 * forgets it immediately and keeps older, smaller pictures instead — the one
 * outcome nobody would predict from "recent files".
 */

let seq = 0;
const MB = 1024 * 1024;

const project = (name: string, savedAt: number): RecentMeta => ({
  id: `p${seq++}`,
  name,
  savedAt,
  kind: "data",
});
const picture = (name: string, savedAt: number, bytes: number): RecentMeta => ({
  id: `i${seq++}`,
  name,
  savedAt,
  kind: "image",
  width: 100,
  height: 80,
  type: "image/jpeg",
  bytes,
  thumb: new Blob([new Uint8Array(1000)]),
});
const names = (l: RecentMeta[]) => l.map((m) => m.name);

describe("trimRecents", () => {
  it("keeps the newest first", () => {
    const list = trimRecents([project("a", 100), project("b", 300), project("c", 200)], 8);
    expect(names(list)).toEqual(["b", "c", "a"]);
  });

  it("caps by count, dropping the oldest", () => {
    const list = trimRecents(
      [project("a", 1), project("b", 2), project("c", 3), project("d", 4)],
      2,
    );
    expect(names(list)).toEqual(["d", "c"]);
  });

  it("caps pictures by total bytes as well", () => {
    const list = trimRecents(
      [picture("p1", 1, 10 * MB), picture("p2", 2, 10 * MB), picture("p3", 3, 10 * MB)],
      8,
      25 * MB,
    );
    /* Three would be 30MB; only the two newest fit. */
    expect(names(list)).toEqual(["p3", "p2"]);
  });

  it("does not count projects against the picture budget", () => {
    /* A project is a few hundred kilobytes of JSON and, more to the point,
       somebody's work. It must not be evicted to make room for a photograph. */
    const list = trimRecents(
      [project("work", 1), picture("p1", 2, 40 * MB), picture("p2", 3, 40 * MB)],
      8,
      60 * MB,
    );
    expect(names(list)).toContain("work");
    expect(names(list)).toContain("p2");
    expect(names(list)).not.toContain("p1");
  });

  it("never trims the entry it was just asked to remember", () => {
    const huge = picture("huge", 500, 90 * MB);
    const list = trimRecents([picture("small", 100, 1 * MB), huge], 8, 60 * MB, huge.id);
    expect(names(list)).toContain("huge");
  });

  it("…even when the count limit is already full", () => {
    const fresh = project("fresh", 0); // oldest by timestamp, but just added
    const list = trimRecents([project("a", 5), project("b", 6), fresh], 2, RECENT_IMAGE_BYTES, fresh.id);
    expect(names(list)).toContain("fresh");
  });

  it("counts a picture's thumbnail against the budget too", () => {
    /* Small, but "the file fits" and "the row fits" are different questions,
       and only one of them is the one being asked. */
    const a = picture("a", 1, 1000);
    const b = picture("b", 2, 1000);
    const list = trimRecents([a, b], 8, 2500);
    expect(names(list)).toEqual(["b"]); // 2000 + 2000 > 2500
  });

  it("leaves a list that already fits completely alone", () => {
    const input = [project("a", 1), picture("p", 2, 1 * MB)];
    expect(names(trimRecents(input, 8))).toEqual(["p", "a"]);
  });
});
