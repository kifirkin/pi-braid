/**
 * Whisper delivery invariants, asserted against rendered strings.
 *
 * Each of the seven checks below is one assertion about text the shipped
 * code produced in this run: the emitter (createDefaultPolicies) writes the
 * bodies, the renderer (renderDelayedDelivery) assembles the delivery, and the
 * sample (getSelfStateSample) supplies the measurement. No expected prose is
 * hand-written here, so a copy change cannot make a test agree with a stale
 * string; a change that breaks an invariant fails instead.
 *
 *   one snapshot   count and percent are one reading, taken at delivery, and
 *                  the arm named in the instruction is that reading's
 *   label bound    a collapsed family is re-labelled from the surviving
 *                  measurement, and arrival order cannot change the text
 *   actionable     a metric that names no action is absent, not zeroed
 *   one action     the instruction names one chain, not a menu
 *   provenance     every percentage carries the meter's provenance word
 *   one clock      the body clock is read through the seam, once
 *   silence        a family that has nothing to say delivers nothing
 *
 * Run: node test/runtime/heartbeat/test-whisper-invariants.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// Settings resolve from os.homedir() at module eval: keep the run off the
// owner's settings.json (the default owner time zone is what the clock check
// compares against, and it must be the same source the formatter reads).
const tmpBase = mkdtempSync(join(tmpdir(), "whisper-invariants-"));
process.env.HOME = tmpBase;

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const D = join(ROOT, "dist");

const { createDefaultPolicies } = await import(
  "file://" + join(D, "extensions/heartbeat/heartbeat-scheduler/policies.js")
);
const { renderDelayedDelivery, buildSelfStateLine } = await import(
  "file://" + join(D, "extensions/heartbeat/heartbeat-scheduler/whisper-batcher.js")
);
const { getSelfStateSample } = await import("file://" + join(D, "lib/telemetry/context-heartbeat.js"));
const { setLocalTimeClockForTests, formatLocalTime } = await import(
  "file://" + join(D, "lib/utils/local-time.js")
);
const {
  USAGE_WHISPER_SOFT,
  USAGE_WHISPER_ADVISORY,
  USAGE_WHISPER_WARNING,
  USAGE_WHISPER_CRITICAL,
} = await import("file://" + join(D, "lib/detection/context-thresholds.js"));

console.log("=== whisper delivery invariants ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

// ── Fixtures ────────────────────────────────────────────────────────────────

const WINDOW = 1_000_000;
/** A distinctive instant, far from any real run: a renderer that reads the
 * wall clock instead of the seam cannot print this date. */
const PINNED = new Date(Date.UTC(2026, 2, 4, 5, 6));

/**
 * A context whose session tree carries one provider-anchored assistant
 * message, so the meter produces a real reading: `tokens` in, percent out.
 */
function ctxWithTokens(tokens) {
  return {
    sessionManager: {
      getSessionId: () => `invariants-${tokens}`,
      getEntries: () => [],
      getBranch: () => [
        { type: "message", message: { role: "user", content: "go" } },
        {
          type: "message",
          message: {
            role: "assistant",
            content: "ok",
            stopReason: "end_turn",
            usage: { totalTokens: tokens },
          },
        },
      ],
    },
    model: { contextWindow: WINDOW },
  };
}

/** The emitter: one policy invocation at `percent`, whispers collected. */
async function emitAt(percent, buckets = { whispers: [], steers: [] }) {
  const policies = createDefaultPolicies(
    () => ({ lastVerificationTurn: 0, totalToolsUsed: 0 }),
    () => {},
    (message, family) => buckets.whispers.push({ message, priority: "medium", family }),
    (message) => buckets.steers.push(message),
  );
  const monitor = policies.find((p) => p.id === "context-monitor");
  assert.ok(monitor, "context-monitor policy exists");
  await monitor.action({
    sessionId: "whisper-invariants",
    turnNumber: 1,
    toolStats: new Map(),
    cwd: "/tmp",
    getContextUsage: () => ({
      percent,
      tokens: Math.round((percent / 100) * WINDOW),
      contextWindow: WINDOW,
    }),
  });
  return buckets;
}

/** Clear the fired ladder: below the reset bar, nothing fires and the set empties. */
async function resetLadder() {
  await emitAt(1);
}

/** The verification family's body, emitted by its own policy action. */
async function verifyHint() {
  const bodies = [];
  await createDefaultPolicies(
    () => ({ lastVerificationTurn: 0, totalToolsUsed: 0 }),
    () => {},
    (message) => bodies.push({ message, priority: "medium" }),
    () => {},
  )
    .find((p) => p.id === "verify-hint")
    .action({ sessionId: "whisper-invariants", turnNumber: 12, toolStats: new Map(), cwd: "/tmp" });
  return bodies;
}

/**
 * The delivery: one sample, taken once, exactly as the flush wires it (the
 * self-state line and the context family's arm both read this object).
 */
function deliver(sessionId, tokens, extraEntries = []) {
  const sample = getSelfStateSample(ctxWithTokens(tokens));
  const text = renderDelayedDelivery(extraEntries, {
    at: PINNED,
    contextPercent: sample.contextPercent,
    selfState: buildSelfStateLine(sample),
  });
  assert.equal(text.length, 1, `one delivery for one priority tier (${sessionId})`);
  return text[0];
}

/** The arm word the copy uses for a percent, derived from the bars themselves. */
function armFor(percent) {
  if (percent >= USAGE_WHISPER_CRITICAL) return "critical";
  if (percent >= USAGE_WHISPER_WARNING) return "warning";
  if (percent >= USAGE_WHISPER_ADVISORY) return "advisory";
  if (percent >= USAGE_WHISPER_SOFT) return "soft";
  return null;
}

const percentages = (text) => [...text.matchAll(/(\d+(?:\.\d+)?)%/g)].map((m) => Number(m[1]));

// ── one snapshot per delivery ───────────────────────────────────────────

await test("one snapshot: the delivery prints one percentage, taken at delivery, and names that reading's arm", async () => {
  await resetLadder();
  const { whispers } = await emitAt(USAGE_WHISPER_SOFT + 1);
  const delivered = deliver("v1", 413_000, whispers);
  const measured = (413_000 / WINDOW) * 100;

  assert.match(delivered, /self-state: .*\(41\.3% /, delivered);
  assert.deepEqual(percentages(delivered), [Number(measured.toFixed(1))], delivered);
  assert.ok(
    delivered.includes(`above the ${armFor(measured)} arm`),
    `the arm named is the delivered reading's (${armFor(measured)}): ${delivered}`,
  );
  for (const bar of [
    USAGE_WHISPER_SOFT,
    USAGE_WHISPER_ADVISORY,
    USAGE_WHISPER_WARNING,
    USAGE_WHISPER_CRITICAL,
  ]) {
    assert.ok(!percentages(delivered).includes(bar), `bar ${bar} printed as a reading`);
  }
});

// ── a label does not outlive its measurement ────────────────────────────

await test("label bound: the newest arrival is what a reader is told, and a measurement re-labels it in either order", async () => {
  await resetLadder();
  const soft = (await emitAt(USAGE_WHISPER_SOFT + 1)).whispers;
  const advisory = (await emitAt(USAGE_WHISPER_ADVISORY + 1)).whispers;
  assert.equal(advisory.length, 1, "the second rung fires one message");

  // (a) With no measurement at delivery nothing can be re-labelled, so the
  // collapse's winner is what a reader is told: the newest arrival, never the
  // first. This is the rule that printed the oldest label beside the newest
  // numbers.
  const unmeasured = getSelfStateSample({});
  const renderUnmeasured = (batch) =>
    renderDelayedDelivery(batch, {
      at: PINNED,
      contextPercent: null,
      selfState: buildSelfStateLine(unmeasured),
    })[0];
  const newestIsAdvisory = renderUnmeasured([...soft, ...advisory]);
  const newestIsSoft = renderUnmeasured([...advisory, ...soft]);
  assert.ok(newestIsAdvisory.includes("above the advisory arm"), newestIsAdvisory);
  assert.ok(newestIsSoft.includes("above the soft arm"), newestIsSoft);

  // (b) With a measurement, the label is re-derived from it: at 51.0% the soft
  // arm's advice no longer applies, and arrival order cannot change the text.
  const forward = deliver("v2-forward", 510_000, [...soft, ...advisory]);
  const reverse = deliver("v2-reverse", 510_000, [...advisory, ...soft]);
  assert.equal(forward, reverse, "arrival order cannot change what a reader is told");
  assert.ok(forward.includes("above the advisory arm"), forward);
  assert.ok(!forward.includes("above the soft arm"), forward);
  assert.match(forward, /self-state: .*\(51\.0% measured\)/, forward);
});

// ── a number is actionable or absent ────────────────────────────────────

await test("actionable: no metric that names no action reaches the delivery", async () => {
  await resetLadder();
  const { whispers } = await emitAt(USAGE_WHISPER_SOFT + 1);
  const delivered = deliver("v3", 413_000, whispers);
  assert.doesNotMatch(delivered, /\b(?:cache|dup|tps-ema|acts)\b/, delivered);
});

// ── one instruction, not a menu ─────────────────────────────────────────

await test("one action: the context instruction names one chain", async () => {
  await resetLadder();
  const { whispers } = await emitAt(USAGE_WHISPER_SOFT + 1);
  const delivered = deliver("v4", 413_000, whispers);
  const line = delivered.split("\n").find((l) => l.includes("Context is above the"));
  assert.ok(line, `context instruction present: ${delivered}`);
  assert.doesNotMatch(line, /\bor\b|Consider:/, `no alternative offered: ${line}`);
  assert.match(line, /context_inspect\(detail="prune"\)[^.]*then tag with context_navigate/, line);
});

// ── provenance on every percentage ──────────────────────────────────────

await test("provenance: every percentage carries the meter's provenance word", async () => {
  await resetLadder();
  const { whispers } = await emitAt(USAGE_WHISPER_ADVISORY + 1);
  const delivered = deliver("v5", 510_000, whispers);
  const found = percentages(delivered);
  assert.ok(found.length > 0, `the delivery prints a percentage to check: ${delivered}`);
  for (const match of delivered.matchAll(/\d+(?:\.\d+)?%/g)) {
    const tail = delivered.slice(match.index + match[0].length, match.index + match[0].length + 12);
    assert.match(tail, /^\s+(measured|estimated)\b/, `unprovenanced "${match[0]}" in: ${delivered}`);
  }
});

// ── one clock, read through the seam ────────────────────────────────────

await test("one clock: the body clock is the seam's instant, and there is one of it", async () => {
  setLocalTimeClockForTests(PINNED);
  try {
    await resetLadder();
    const { whispers } = await emitAt(USAGE_WHISPER_SOFT + 1);
    const sample = getSelfStateSample(ctxWithTokens(413_000));
    // No `at`: the renderer must read the seam itself.
    const [delivered] = renderDelayedDelivery(whispers, {
      contextPercent: sample.contextPercent,
      selfState: buildSelfStateLine(sample),
    });
    const expected = `now: ${formatLocalTime(PINNED, true)}`;
    assert.ok(delivered.includes(expected), `body clock is the seam's: ${delivered}`);
    assert.equal(
      [...delivered.matchAll(/\d{2}:\d{2}/g)].length,
      1,
      `exactly one clock in the delivery: ${delivered}`,
    );
  } finally {
    setLocalTimeClockForTests(null);
  }
});

// ── silence is the default ──────────────────────────────────────────────

await test("silence: nothing fires below the arm, and advice whose condition has passed is dropped", async () => {
  await resetLadder();
  const below = await emitAt(USAGE_WHISPER_SOFT - 0.1);
  assert.equal(below.whispers.length, 0, `no whisper below the soft arm: ${below.whispers}`);
  const at = await emitAt(USAGE_WHISPER_SOFT + 0.1);
  assert.equal(at.whispers.length, 1, `one whisper at the arm: ${at.whispers}`);

  // The same advice flushed after usage fell back below the arm is silence:
  // the entry is dropped, and a delivery with nothing left to say is not sent.
  const lone = getSelfStateSample(ctxWithTokens(100_000));
  const empty = renderDelayedDelivery(at.whispers, {
    at: PINNED,
    contextPercent: lone.contextPercent,
    selfState: buildSelfStateLine(lone),
  });
  assert.deepEqual(empty, [], "no delivery when every body has been dropped");

  // A sibling family still lands, without the passed advice.
  const delivered = deliver("v7-sibling", 100_000, [...at.whispers, ...(await verifyHint())]);
  assert.ok(!delivered.includes("Context is above the"), delivered);
  assert.match(delivered, /self-state: ctx 100K tok/, delivered);
  assert.match(delivered, /No verification \(grep\/read\/search\)/, delivered);
});

// ── The owner's delivery, rendered ──────────────────────────────────────────
// The scenario that produced the original message: a soft-tier crossing, a
// higher tier behind it, an unverified run, then a flush with a fresh sample.

await resetLadder();
const contextBodies = [
  ...(await emitAt(USAGE_WHISPER_SOFT + 1)).whispers,
  ...(await emitAt(USAGE_WHISPER_ADVISORY + 1)).whispers,
];
const witness = deliver("owner", 510_000, [...contextBodies, ...(await verifyHint())]);

console.log("\n--- owner delivery, rendered by the shipped code ---");
console.log(witness);
console.log("--- end ---\n");

console.log(`${passed} passed, ${failed} failed`);
rmSync(tmpBase, { recursive: true, force: true });
process.exit(failed > 0 ? 1 : 0);
