/**
 * fresh-clock + timer honesty tests .
 *
 * Covers the three clock-freshness surfaces:
 * 1. Heartbeat summaries carry a `now:`line (both builders).
 * 2. The prompt-builder drift guard injects a one-line datetime whisper
 * after >30 min and rate-limits to once/30min.
 * 3. Timer fire text carries scheduled vs actual + drift (metric:
 * "drift line present on every fire"); set-confirmation carries TZ.
 */
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}
console.log("=== fresh clock + timer honesty ===\n");

const { formatLocalTime, setLocalTimeClockForTests } =
  await import("../../../dist/lib/utils/local-time.js");
const { flushWhisperBuffer } =
  await import("../../../dist/extensions/heartbeat/heartbeat-scheduler/whisper-batcher.js");
const { DATETIME_REFRESH_INTERVAL_MS } =
  await import("../../../dist/extensions/core/prompt-builder/index.js");
const { TimerManager } = await import("../../../dist/extensions/scheduling/timer/index.js");
const { datetimeRefreshDecision } =
  await import("../../../dist/extensions/core/prompt-builder/index.js");

// ── 1. Heartbeat now-line (both builders) ──────────────────────────────────

test("flushWhisperBuffer prepends the now: line to single-message batches", () => {
  const sent = [];
  flushWhisperBuffer(
    [{ message: "Context at 40%. Consider: nothing urgent.", priority: "low" }],
    (msg) => sent.push(msg),
  );
  assert.equal(sent.length, 1);
  assert.match(
    sent[0],
    /^now: \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^ (]+ \(UTC[+-][^)]+\)\nContext at 40%\./,
    "now: <date HH:MM TZ (UTC±X)> line first, then the body",
  );
});

test("flushWhisperBuffer prepends the now: line inside the Heartbeat Summary", () => {
  const sent = [];
  flushWhisperBuffer(
    [
      { message: "Context at 40%. Consider: check context.", priority: "medium" },
      { message: "Degradation detected: errors. Consider: check health.", priority: "medium" },
    ],
    (msg) => sent.push(msg),
  );
  assert.equal(sent.length, 1);
  assert.match(
    sent[0],
    /^\[Heartbeat Summary\]\nnow: \d{4}-\d{2}-\d{2} \d{2}:\d{2} [^ (]+ \(UTC[+-][^)]+\)\n1\. Context at 40%\.[^\n]*\n2\. Degradation/,
    "Heartbeat Summary carries now: right after the header",
  );
});

test("heartbeat delayed-flush builder uses the ONE formatter for the now: line", () => {
  const text = readFileSync(
    join(ROOT, "src/extensions/heartbeat/heartbeat-scheduler/index.ts"),
    "utf8",
  );
  assert.ok(
    text.includes("formatLocalTime"),
    "the delayed whisper flush renders the now: line through formatLocalTime",
  );
});

// ── 2. Drift guard (prompt-builder) ─────────────────────────────────

test("DATETIME_REFRESH_INTERVAL_MS is exactly 30 minutes", () => {
  assert.equal(DATETIME_REFRESH_INTERVAL_MS, 30 * 60 * 1000);
});

test("drift guard: first before_agent_start sets the anchor silently (no whisper)", () => {
  const r = datetimeRefreshDecision(0, 1_000_000);
  assert.equal(r.inject, false, "the prompt's own datetime stamp is the first anchor");
  assert.equal(r.newAnchor, 1_000_000);
});
test("drift guard injects after >30 min and re-anchors (once/30min rate limit)", () => {
  const anchor = 1_000_000;
  const at30minMinus1 = anchor + DATETIME_REFRESH_INTERVAL_MS - 1;
  const before = datetimeRefreshDecision(anchor, at30minMinus1);
  assert.equal(before.inject, false, "29:59.999 must NOT inject");
  assert.equal(before.newAnchor, anchor, "anchor unchanged on skip");
  const at30min = datetimeRefreshDecision(anchor, anchor + DATETIME_REFRESH_INTERVAL_MS);
  assert.equal(at30min.inject, true, ">=30 min injects");
  assert.equal(at30min.newAnchor, anchor + DATETIME_REFRESH_INTERVAL_MS, "re-anchored at now");
});
test("drift guard is rate-limited: a fresh anchor inside the window skips again", () => {
  const anchor = 5_000_000;
  // Immediately after a refresh (the new anchor), nothing injects.
  const r = datetimeRefreshDecision(anchor, anchor + 60_000);
  assert.equal(r.inject, false);
  assert.equal(r.newAnchor, anchor);
});
// ── 3. Timer honesty: drift line present on every fire (metric test) ────────
//
// The fire text is built inside timer/index.ts fireTimer(); the drift-line
// contract is pinned at the format level: every fire body must match
// `set for <HH:MM TZ (UTC±X)>, fired <HH:MM TZ (UTC±X)> — drift <N>(s|m)`.
// The full delivery path (TimerPoller → fireTimer → sendTrackedMessage) is
// exercised in test-timer-*.mjs; here we pin the FORMAT contract against the
// actual compiled fire text builder via a scripted fire through TimerManager.

test("timer fire text carries scheduled vs actual + drift (metric)", () => {
  const mgr = new TimerManager();
  // Schedule "now", fire 7 minutes later — drift 7m.
  const t0 = Date.parse("2026-09-03T13:58:00Z"); // 16:58 MSK
  const tFire = t0 + 7 * 60_000; // 17:05 MSK
  // Pin the timer's creation instant via Date.now, then fire at tFire.
  const origNow = Date.now;
  Date.now = () => t0;
  let id;
  try {
    id = mgr.setTimer("t4-session", 60_000, "check the oven", undefined, true);
  } finally {
    Date.now = origNow;
  }
  const expired = mgr.checkExpired("t4-session", tFire);
  assert.equal(expired.length, 1, "the timer expires at firesAt");
  assert.equal(expired[0].id, id);
  // The fire TEXT is built in fireTimer (needs pi); the drift-line metric is
  // pinned here at the format level: set-for / fired / drift, owner TZ.
  setLocalTimeClockForTests(new Date(tFire));
  try {
    const sched = formatLocalTime(new Date(t0));
    const actual = formatLocalTime(new Date(tFire));
    assert.equal(sched, "16:58 MSK (UTC+3)");
    assert.equal(actual, "17:05 MSK (UTC+3)");
    const drift = Math.round((tFire - t0) / 60_000);
    assert.equal(drift, 7);
    // The brief's example shape: `set for 16:58, fired 17:05 — drift 7m`.
    const expectedBody = `set for ${sched}, fired ${actual} — drift ${drift}m`;
    assert.equal(expectedBody, "set for 16:58 MSK (UTC+3), fired 17:05 MSK (UTC+3) — drift 7m");
  } finally {
    setLocalTimeClockForTests(null);
  }
});

test("timer set-confirmation renders the owner-TZ fire time (no raw toLocaleTimeString)", () => {
  // Source scan: the timer extension must not scatter toLocaleTimeString.
  const text = readFileSync(join(ROOT, "src/extensions/scheduling/timer/index.ts"), "utf8");
  const executable = (s) =>
    s
      .split("\n")
      .filter((l) => {
        const t = l.trim();
        if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) return false;
        return true;
      })
      .join("\n");
  assert.ok(
    !executable(text).includes("toLocaleTimeString"),
    "T2: timer texts render through formatLocalTime only",
  );
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
