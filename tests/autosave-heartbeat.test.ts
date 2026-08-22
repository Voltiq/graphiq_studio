import { describe, expect, it } from "vitest";
import { heartbeatAfter, type HeartbeatEvent } from "../app/lib/autosave";

/**
 * The crash heartbeat's lifecycle.
 *
 * The flag says "a session is live". If it survives to the next boot, the
 * previous one was killed rather than closed, and the last autosave is worth
 * offering back. What makes this worth a test is that the obvious rule — clear
 * it on `pagehide` — is wrong on a phone: `pagehide` fires on an ordinary tab
 * switch, with the page still alive.
 *
 * These drive SEQUENCES rather than single events, because the failure was
 * never one event behaving oddly; it was a flag that got cleared halfway
 * through a session and never came back.
 */

/** Replay a run of lifecycle events and report whether the flag ends up set. */
const replay = (...events: HeartbeatEvent[]): boolean => {
  let armed = false;
  for (const e of events) {
    const next = heartbeatAfter(e);
    if (next !== null) armed = next;
  }
  return armed;
};

const boot: HeartbeatEvent = { type: "boot" };
const tabAway: HeartbeatEvent = { type: "pagehide", persisted: true };
const backAgain: HeartbeatEvent = { type: "pageshow" };
const shown: HeartbeatEvent = { type: "visible" };
const closed: HeartbeatEvent = { type: "pagehide", persisted: false };

describe("heartbeat lifecycle", () => {
  it("arms on boot", () => {
    expect(replay(boot)).toBe(true);
  });

  it("stays armed across a tab switch, because the page is still alive", () => {
    // The actual bug: this used to end up false, so a later kill looked clean.
    expect(replay(boot, tabAway)).toBe(true);
  });

  it("is still armed after coming back", () => {
    expect(replay(boot, tabAway, backAgain, shown)).toBe(true);
  });

  it("survives a whole afternoon of switching back and forth", () => {
    const day: HeartbeatEvent[] = [boot];
    for (let i = 0; i < 25; i++) day.push(tabAway, backAgain, shown);
    expect(replay(...day)).toBe(true);
  });

  it("disarms when the page really goes away", () => {
    expect(replay(boot, closed)).toBe(false);
  });

  it("re-arms if the page turns out to have survived an unload", () => {
    // Some engines fire an unpersisted pagehide and then keep the page; the
    // session is live again and must be recoverable again.
    expect(replay(boot, closed, backAgain)).toBe(true);
  });

  it("ends disarmed when the last thing that happened was a real close", () => {
    expect(replay(boot, tabAway, backAgain, shown, closed)).toBe(false);
  });

  it("never treats a persisted pagehide as an ending", () => {
    // Property: no run made only of tab switches can leave the flag clear.
    for (let n = 1; n <= 10; n++) {
      const run: HeartbeatEvent[] = [boot];
      for (let i = 0; i < n; i++) run.push(tabAway);
      expect(replay(...run)).toBe(true);
    }
  });
});
