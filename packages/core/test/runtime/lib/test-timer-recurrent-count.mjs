/**
 * Behavioral test: bounded recurrent timers (intervalMs + count self-removal).
 *
 * Feature: a recurring timer may carry an OPTIONAL `count` = total
 * number of fires before it removes itself. The recurrence primitive itself
 * (`intervalMs` re-arm) is the base primitive; this change adds the lifetime bound
 * so a finite baby-sit window can be expressed natively ("check every 60s, 5
 * times, then stop") instead of the agent manually cancelling, or stacking
 * one-shots that die with the agentic turn.
 *
 * Semantics (see src/lib/events/timer-types.ts):
 *   - `count` undefined (default) -> unbounded recurrence, as without `count`.
 *   - `count = N` + intervalMs -> fires N times total; on the N-th fire the
 *     timer is REMOVED (same delete-on-detection as a one-shot), the delivered
 *     snapshot carries `fires = N`, and no further tick can return it.
 *   - `fires` is a running counter: 0 at creation, incremented per fire,
 *     delivered on the snapshot, persisted so a bounded recurrence resumes
 *     mid-cadence after a reload (restoreTimer threads count + firedCount).
 *   - cancelTimer/cancelTimersByTag stop a bounded recurrence early.
 *
 * This test FAILS on pre-fix code: setTimer ignored the extra
 * `count` argument and checkExpired treated the timer as unbounded, so after
 * 3 fires the timer was still in the map and the exhaustion assertions fail.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Pin braid's persistent tree into a private tmpdir: fixture timers must
// never write the live store (braidDir() honors BRAID_HOME per call).
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-timer-home-recurrent-count-"));
process.env.BRAID_HOME = BRAID_HOME;

const { TimerManager } = await import("../../../dist/extensions/scheduling/timer/timer-manager.js");

describe("Bounded recurring timers (intervalMs + count)", () => {
  it("removes itself after exactly N fires (count exhaustion)", () => {
    const m = new TimerManager();
    m.setTimer("s1", 100000, "bounded", undefined, false, 1000, 3);
    let live = m.listTimers("s1")[0];

    const fired = [];
    for (let i = 0; i < 4; i++) {
      const ex = m.checkExpired("s1", live ? live.firesAt : Date.now() + 1e9);
      fired.push(...ex);
      const remaining = m.listTimers("s1");
      live = remaining[0];
      if (!live) break;
    }

    assert.equal(fired.length, 3, "exactly 3 fires, then the timer stops itself");
    assert.deepEqual(
      fired.map((f) => f.fires),
      [1, 2, 3],
      "delivered snapshots carry the fire number for each delivery (1..N)",
    );
    assert.equal(m.listTimers("s1").length, 0, "map empty after count exhaustion");
  });

  it("no fire tick after exhaustion (completed timer cannot return)", () => {
    const m = new TimerManager();
    m.setTimer("s2", 100000, "bounded", undefined, false, 1000, 2);
    const t = m.listTimers("s2")[0];

    m.checkExpired("s2", t.firesAt); // fire 1/2 -> re-arm
    const live = m.listTimers("s2")[0];
    assert.equal(m.listTimers("s2").length, 1, "mid-cadence: still recurring");
    m.checkExpired("s2", live.firesAt); // fire 2/2 -> completed
    assert.equal(m.listTimers("s2").length, 0, "removed on final fire");

    const after = m.checkExpired("s2", live.firesAt + 100000);
    assert.equal(after.length, 0, "exhausted timer never fires again");
  });

  it("count exhaustion through the ANTI-CATCH-UP path: a vastly-overdue bounded timer completes (no burst, no re-arm)", () => {
    const m = new TimerManager();
    // Restored mid-cadence: 1 of 2 fires already delivered; next fire completes it.
    m.setTimer("s3", 100000, "overdue", undefined, false, 30, 2, 1);
    const t = m.listTimers("s3")[0];
    const farNow = t.firesAt + 30000; // ~1000 missed periods

    const ex = m.checkExpired("s3", farNow);
    assert.equal(ex.length, 1, "one fire, no catch-up burst even when completing");
    assert.equal(ex[0].fires, 2, "delivered snapshot carries the completing fire number");
    assert.equal(m.listTimers("s3").length, 0, "overdue bounded timer completed -> removed");
    assert.equal(
      m.checkExpired("s3", farNow + 100000).length,
      0,
      "nothing to fire after completion",
    );
  });

  it("cancel stops a bounded recurrence permanently (even mid-cadence)", () => {
    const m = new TimerManager();
    const id = m.setTimer("s4", 100000, "cancel-me", undefined, false, 30, 5);
    const t = m.listTimers("s4")[0];

    m.checkExpired("s4", t.firesAt); // 1/5 -> re-armed
    const live = m.listTimers("s4")[0];
    assert.equal(live.fires, 1, "fires counter advanced on re-arm");
    m.cancelTimer("s4", id);
    assert.equal(m.listTimers("s4").length, 0, "cancelled -> removed from map");
    assert.equal(
      m.checkExpired("s4", live.firesAt + 5000).length,
      0,
      "no further fires after cancel",
    );
  });

  it("REGRESSION: unbounded recurrence (intervalMs, no count) still repeats forever", () => {
    const m = new TimerManager();
    m.setTimer("s5", 100000, "unbounded", undefined, false, 1000, undefined);
    let t = m.listTimers("s5")[0];
    let fired = 0;
    for (let i = 0; i < 3; i++) {
      fired += m.checkExpired("s5", t.firesAt + 1).length;
      t = m.listTimers("s5")[0];
    }
    assert.ok(fired >= 2, `unbounded keeps firing, got ${fired}`);
    assert.equal(t.fires, fired, "live entry exposed via list carries the running fire count");
    assert.equal(m.listTimers("s5").length, 1, "still recurring after N fires (not exhausted)");
    m.clearSession("s5");
  });

  it("REGRESSION: one-shot (no intervalMs, no count) fires once and is removed", () => {
    const m = new TimerManager();
    m.setTimer("s6", 100000, "one-shot");
    const t = m.listTimers("s6")[0];

    const ex = m.checkExpired("s6", t.firesAt);
    assert.equal(ex.length, 1);
    assert.equal(ex[0].intervalMs, undefined, "no recurrence default");
    assert.equal(ex[0].count, undefined, "no count on a one-shot");
    assert.equal(ex[0].fires, undefined, "no fires counter on a one-shot (struct unchanged)");
    assert.equal(m.listTimers("s6").length, 0, "one-shot removed (delete-on-detection)");
    assert.equal(m.checkExpired("s6", t.firesAt + 100000).length, 0, "no re-fire");
  });

  it("setTimer count + fires round-trip through listTimers (persist surface)", () => {
    const m = new TimerManager();
    m.setTimer("s7", 5000, "surface", "babysit", false, 420000, 8);
    const t = m.listTimers("s7")[0];
    assert.equal(t.intervalMs, 420000);
    assert.equal(t.count, 8, "count bound survives the store write");
    assert.equal(t.fires, 0, "fires starts at 0");
    assert.equal(t.tag, "babysit");
    assert.equal(t.wake, false, "advisory wakeless recurring timer");
    m.clearSession("s7");
  });

  it("restoreTimer threads count + firedCount so a bounded recurrence resumes mid-cadence", () => {
    const m = new TimerManager();
    // Simulate a reload: 1 of 3 fires already delivered, persisted with count=3, fires=1.
    m.setTimer("s8", 5000, "resume", "babysit", false, 1000, 3, 1);
    let t = m.listTimers("s8")[0];
    assert.equal(t.count, 3, "count restored");
    assert.equal(t.fires, 1, "mid-cadence fire counter restored");

    let lastFires = 1;
    while (m.listTimers("s8").length > 0 && lastFires < 3) {
      const live = m.listTimers("s8")[0];
      const ex = m.checkExpired("s8", live.firesAt);
      if (ex.length) lastFires = ex[0].fires;
    }
    assert.equal(lastFires, 3, "2 more fires complete the restored 3-fire bound");
    assert.equal(m.listTimers("s8").length, 0, "completed after exhaustion from restored state");
  });
});
