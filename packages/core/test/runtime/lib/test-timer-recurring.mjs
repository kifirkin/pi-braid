/**
 * Behavioral test: cron-like recurrent timers (intervalMs re-arm).
 *
 * Feature: a ScheduledTimer may carry an `intervalMs` recurrence
 * interval. On expiry, `TimerManager.checkExpired` does NOT delete it — it
 * re-arms the live map entry to the next cadence
 * (`Math.max(prev firesAt + intervalMs, now + intervalMs)` — anti-catch-up)
 * and returns a delivered snapshot. Cancellation removes it, stopping the
 * recurrence. The default (no intervalMs) is unchanged: exactly-once
 * delete-on-detection.
 *
 * The dual fire path (poller setTimeout(0) OR fireExpired from
 * TOOL_EXECUTION_END/TURN_END) cannot double-advance a re-arming timer
 * because checkExpired re-arms synchronously/in-place inside the shared
 * TimerManager store: a second checkExpired in the same tick reads the
 * already-bumped future firesAt and returns nothing. This test pins that
 * atomicity invariant directly.
 *
 * Mirrors the fake-now injection pattern of test-timer-fire-suppression.mjs:
 * checkExpired(sessionId, nowMs) is driven with controlled wall-clock values
 * derived from the timer's real firesAt rather than real elapsed time.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin braid's persistent tree into a private tmpdir: fixture timers must
// never write the live store (braidDir() honors BRAID_HOME per call).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-home-recurring-"));
process.env.BRAID_HOME = BRAID_HOME;

const { TimerManager } = await import("../../../dist/extensions/scheduling/timer/timer-manager.js");

describe("Recurring timers (intervalMs re-arm)", () => {
  it("re-arms in place: fires once, stays in the map, next firesAt bumped", () => {
    const m = new TimerManager();
    const id = m.setTimer("s1", 100000, "recur", undefined, false, 1000);
    // listTimers returns LIVE map references, so snapshot the firesAt before
    // checkExpired mutates it in place during re-arm.
    const originalFiresAt = m.listTimers("s1")[0].firesAt;

    const ex = m.checkExpired("s1", originalFiresAt);
    assert.equal(ex.length, 1, "expired tick is returned so the caller fires it");
    assert.equal(ex[0].id, id);
    assert.equal(ex[0].intervalMs, 1000);
    assert.equal(
      ex[0].firesAt,
      originalFiresAt,
      "delivered snapshot keeps ORIGINAL firesAt (fire time)",
    );

    const rearmed = m.listTimers("s1")[0];
    assert.equal(rearmed.id, id, "re-armed timer stays in the session map");
    assert.equal(
      rearmed.firesAt,
      originalFiresAt + 1000,
      "next firesAt = prev + interval (no lag)",
    );
  });

  it("ATOMICITY: a second checkExpired at the SAME now cannot double-fire", () => {
    const m = new TimerManager();
    const id = m.setTimer("s2", 100000, "recur", undefined, false, 1000);
    const originalFiresAt = m.listTimers("s2")[0].firesAt;

    m.checkExpired("s2", originalFiresAt); // first path fires + re-arms atomically
    const second = m.checkExpired("s2", originalFiresAt); // second path, SAME now
    assert.equal(second.length, 0, "re-armed firesAt is in the future -> no double fire");
    assert.equal(m.listTimers("s2")[0].id, id);
    assert.equal(
      m.listTimers("s2")[0].firesAt,
      originalFiresAt + 1000,
      "re-arm advanced exactly once",
    );
  });

  it("fires >= 2 times as the clock advances (cadence maintained)", () => {
    const m = new TimerManager();
    m.setTimer("s3", 100000, "cadence", undefined, false, 30);
    let t = m.listTimers("s3")[0];
    let fired = 0;
    for (let i = 0; i < 3; i++) {
      fired += m.checkExpired("s3", t.firesAt + 1).length; // just past this period
      t = m.listTimers("s3")[0];
    }
    assert.ok(fired >= 2, `expected >= 2 fires over 3 periods, got ${fired}`);
    assert.equal(m.listTimers("s3").length, 1, "still recurring after N fires");
  });

  it("ANTI-CATCH-UP: a vastly-overdue timer fires exactly once, re-arms from now", () => {
    const m = new TimerManager();
    m.setTimer("s4", 100000, "overdue", undefined, false, 30);
    const t = m.listTimers("s4")[0];
    const farNow = t.firesAt + 30000; // ~1000 missed 30ms periods

    const ex = m.checkExpired("s4", farNow);
    assert.equal(ex.length, 1, "one fire, no catch-up burst of missed ticks");
    const rearmed = m.listTimers("s4")[0];
    assert.equal(rearmed.firesAt, farNow + 30, "re-armed from now + interval (no burst)");
    assert.equal(m.checkExpired("s4", farNow).length, 0, "same now cannot fire again");
  });

  it("cancel stops the recurrence permanently", () => {
    const m = new TimerManager();
    const id = m.setTimer("s5", 100000, "recur", undefined, false, 30);
    const t = m.listTimers("s5")[0];

    m.checkExpired("s5", t.firesAt);
    const rearmed = m.listTimers("s5")[0];
    assert.equal(rearmed.id, id);

    m.cancelTimer("s5", id);
    assert.equal(m.listTimers("s5").length, 0, "cancelled -> removed from map");
    assert.equal(
      m.checkExpired("s5", rearmed.firesAt + 5000).length,
      0,
      "no further fires after cancel",
    );
  });

  it("REGRESSION: one-shot (no intervalMs) fires exactly once and is removed", () => {
    const m = new TimerManager();
    const id = m.setTimer("s6", 100000, "one-shot");
    const t = m.listTimers("s6")[0];

    const ex = m.checkExpired("s6", t.firesAt);
    assert.equal(ex.length, 1);
    assert.equal(ex[0].id, id);
    assert.equal(ex[0].intervalMs, undefined, "no recurrence default");
    assert.equal(m.listTimers("s6").length, 0, "one-shot removed from map (delete-on-detection)");
    assert.equal(
      m.checkExpired("s6", t.firesAt + 100000).length,
      0,
      "no re-fire after the single removal",
    );
  });

  it("intervalMs round-trips through setTimer -> listTimers (persist surface)", () => {
    const m = new TimerManager();
    m.setTimer("s7", 5000, "surface", "babysit", false, 420000);
    const t = m.listTimers("s7")[0];
    assert.equal(t.intervalMs, 420000, "intervalMs survives the store write");
    assert.equal(t.tag, "babysit");
    assert.equal(t.wake, false, "advisory wakeless recurring timer");
    m.clearSession("s7");
  });
});
