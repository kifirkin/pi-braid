/**
 * Regression test: the context estimate is calibrated against the provider's
 * own count, and every rendered number says which one it is.
 *
 * The estimator is chars/4. Its error is not a constant: it depends on the
 * content. This fixture states the two reference points it was built from and
 * then checks each one separately, so a future change that fixes one and
 * breaks another cannot pass.
 *
 * Reference: an incident session's status line read 534,000 tokens against a
 * measured 1,147,001 on the wire (ratio 2.148). The same project's tree, fitted
 * over 453 completed calls, gives measured = 1.5714 x estimate + 101,675: the
 * provider charges ~2.55 chars/token on this content (not 4), and the request
 * carries ~100K tokens the tree walk never sees (system prompt, tool schemas,
 * attached content). The fixture below exercises the multiplier and the
 * zero-char content separately.
 *
 * Run: node test/runtime/lib/test-context-usage-calibration.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = join(__dirname, "..", "..", "..");

const {
  calibrateEstimate,
  calibrationRatio,
  describeUsage,
  describeUsagePercent,
  estimateMessagesTokens,
  estimatePayloadTokens,
  measureLiveUsage,
  recordCalibrationSample,
  resetCalibrationForTests,
} = await import(join(ROOT, "dist", "lib", "detection", "context-usage.js"));

let passed = 0;
const failures = [];
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}`);
  }
}

const within = (actual, expected, tolerance) => {
  const delta = Math.abs(actual - expected) / expected;
  assert.ok(
    delta <= tolerance,
    `expected ${actual} within ${(tolerance * 100).toFixed(0)}% of ${expected} (off by ${(delta * 100).toFixed(1)}%)`,
  );
};

// A message whose payload the provider counts at a KNOWN chars/token. The
// fixture never asks the estimator to be a tokenizer; it asks it to be
// measurable against one.
function textMessage(text, role = "user") {
  return { role, content: [{ type: "text", text }] };
}
function toolCallMessage(argsJson) {
  return {
    role: "assistant",
    content: [{ type: "toolCall", name: "read", arguments: argsJson }],
  };
}

console.log("=== context-usage calibration ===\n");

// ── The under-count, reproduced as a number ──────────────────────────────────

test("dense structured JSON: chars/4 reports about half the truth", () => {
  // 4,000 chars of tool-call JSON. Measured at 2.0 chars/token (the shape the
  // fitted session shows for tool-call args: 689,686 of 1,039,640 walked chars,
  // 66% of the payload, at ~2 chars/token).
  const json = `{"path":"${"a/".repeat(990)}","limit":2000}`;
  const raw = estimateMessagesTokens([toolCallMessage(json)]);
  const truth = Math.round(JSON.stringify(json).length / 2);
  const ratio = truth / raw;
  assert.ok(ratio > 1.8 && ratio < 2.2, `estimate must be ~half the truth, got ratio ${ratio.toFixed(2)}`);
  console.log(`      estimate=${raw} truth=${truth} ratio=${ratio.toFixed(2)}`);
});

test("Cyrillic text: the same divisor is blind to the script", () => {
  // The brief's original carrier: ~2 chars/token for Cyrillic. Kept in the
  // fixture because the estimator cannot distinguish this from the JSON case
  // above, and the fix has to cover both without knowing which it is looking at.
  const cyrillic = "Проверка контекста и оценка токенов. ".repeat(40);
  const raw = estimateMessagesTokens([textMessage(cyrillic)]);
  const truth = Math.round(cyrillic.length / 2);
  assert.ok(truth / raw > 1.8, `ratio ${(truth / raw).toFixed(2)} should be near 2`);
  console.log(`      estimate=${raw} truth=${truth} ratio=${(truth / raw).toFixed(2)}`);
});

// ── The calibrated estimate lands within a stated tolerance ──────────────────

test("a recorded pair calibrates the next estimate to within 10%", () => {
  resetCalibrationForTests();
  assert.equal(calibrationRatio(), null, "no ratio before the first pair");

  // The JSON span above, scaled past the harness floor (a pair from a span
  // smaller than the fixed request part measures the harness, not the divisor).
  const json = `{"path":"${"a/".repeat(8000)}","limit":2000}`;
  const raw = estimateMessagesTokens([toolCallMessage(json)]);
  const truth = Math.round(JSON.stringify(json).length / 2);
  recordCalibrationSample(raw, truth, "probe-json");

  const calibrated = calibrateEstimate(raw);
  assert.equal(calibrated.calibrated, true, "a pair exists, so the estimate is calibrated");
  assert.ok(calibrated.ratio > 1.8 && calibrated.ratio < 2.2, `ratio ${calibrated.ratio}`);
  within(calibrated.tokens, truth, 0.1);
  console.log(`      estimate=${raw} truth=${truth} calibrated=${calibrated.tokens} (x${calibrated.ratio.toFixed(2)})`);
});

test("the calibration does not invent a number before it has a pair", () => {
  resetCalibrationForTests();
  const calibrated = calibrateEstimate(1000);
  assert.equal(calibrated.calibrated, false);
  assert.equal(calibrated.ratio, null);
  assert.equal(calibrated.tokens, 1000, "an unpaired estimate stays the estimate");
});

test("a duplicate pair weights the median once", () => {
  resetCalibrationForTests();
  recordCalibrationSample(4000, 12_000, "same-span");
  recordCalibrationSample(4000, 12_000, "same-span");
  assert.equal(calibrationRatio(), 3, "the same span must not enter twice");
  recordCalibrationSample(4000, 8000, "other-span");
  assert.equal(calibrationRatio(), 2.5, "median of 3.0 and 2.0");
});

test("the ratio is clamped: a pair outside the band cannot drive the number", () => {
  resetCalibrationForTests();
  recordCalibrationSample(4000, 1000, "tiny");
  assert.equal(calibrationRatio(), 0.5, "clamped up to the floor");
  resetCalibrationForTests();
  recordCalibrationSample(4000, 99_000, "huge");
  assert.equal(calibrationRatio(), 6, "clamped down to the ceiling");
});

// ── What the request carries that the walk never sees ────────────────────────

test("estimatePayloadTokens counts the system prompt and tool schemas", () => {
  const messages = [textMessage("x".repeat(400))];
  const withoutHarness = estimateMessagesTokens(messages);
  const withHarness = estimatePayloadTokens({
    systemPrompt: "s".repeat(4000),
    messages,
    tools: [{ name: "read", description: "d".repeat(4000) }],
  });
  assert.ok(withHarness > withoutHarness * 10, `${withHarness} should dwarf ${withoutHarness}`);
  assert.equal(withHarness - withoutHarness, Math.ceil(4000 / 4) + Math.ceil(JSON.stringify([{ name: "read", description: "d".repeat(4000) }]).length / 4));
});

// ── Measured vs estimated: the walk labels its own source ───────────────────

function fakeCtx(branch, modelWindow) {
  return {
    sessionManager: { getBranch: () => branch },
    model: modelWindow ? { contextWindow: modelWindow } : undefined,
  };
}
function usageEntry(totalTokens, role = "assistant") {
  return {
    type: "message",
    message: { role, usage: { totalTokens, input: totalTokens - 10, output: 10 }, stopReason: "stop" },
  };
}

test("no measured usage anywhere means the number is estimated", () => {
  resetCalibrationForTests();
  const branch = [usageEntry(0, "user"), textMessage("hello ".repeat(100))];
  branch[0] = { type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } };
  const live = measureLiveUsage(fakeCtx(branch));
  assert.equal(live.source, "estimated");
  assert.equal(live.tokens, live.estimatedTokens, "no ratio yet, so the estimate is unchanged");
  assert.match(describeUsage(live), /^estimated/);
});

test("a provider-counted request makes the rendered number measured", () => {
  resetCalibrationForTests();
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    usageEntry(500_000),
  ];
  const live = measureLiveUsage(fakeCtx(branch));
  assert.equal(live.source, "measured", "the anchor came from an API response");
  assert.equal(live.tokens, 500_000, "the measured count is the number, not the walk");
  assert.equal(live.estimatedTrailingTokens, 0);
  assert.equal(describeUsage(live), "measured");
});

test("trailing entries behind a measured anchor are estimated, and said so", () => {
  resetCalibrationForTests();
  const branch = [
    // A span large enough to calibrate on: 200,000 chars -> 50,000 estimate,
    // measured at 105,000 (the fitted shape of a real request).
    { type: "message", message: role0("user", 200_000) },
    usageEntry(105_000),
    { type: "message", message: role0("user", 4000) },
  ];
  const live = measureLiveUsage(fakeCtx(branch));
  assert.equal(live.source, "measured");
  assert.ok(live.estimatedTrailingTokens > 0, "the trailing walk is the estimate");
  assert.equal(live.tokens, 105_000 + live.estimatedTrailingTokens);
  assert.ok(live.calibrationRatio > 2 && live.calibrationRatio < 2.2, `ratio ${live.calibrationRatio}`);
  assert.match(describeUsage(live), /^measured \+ \d+K estimated x2\.\d\d$/);
  assert.match(describeUsagePercent(live), /^[\d.]+% measured \+ \d+K estimated/);
});

test("a pair from a span smaller than the harness is discarded", () => {
  resetCalibrationForTests();
  // A handful of estimated tokens against 500,000 measured is a statement
  // about the system prompt, not about chars/token: it must not enter the ratio.
  const branch = [
    { type: "message", message: { role: "user", content: [{ type: "text", text: "go" }] } },
    usageEntry(500_000),
  ];
  const live = measureLiveUsage(fakeCtx(branch));
  assert.equal(live.source, "measured");
  assert.equal(calibrationRatio(), null, "no ratio from a harness-dominated pair");
});

function role0(role, chars) {
  return { role, content: [{ type: "text", text: "x".repeat(chars) }] };
}

test("the calibration factor is named when one was applied", () => {
  resetCalibrationForTests();
  recordCalibrationSample(4000, 8000, "pair");
  const label = describeUsage({ source: "estimated", calibrationRatio: 2 });
  assert.equal(label, "estimated x2.00");
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`FAILED: ${f}`);
  process.exit(1);
}
