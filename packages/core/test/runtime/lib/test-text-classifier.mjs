/**
 * Regression test for text-classifier.ts
 *
 * Tests:
 * - normalizeLabel(): prefix matching, case insensitivity, edge cases
 * - replacePlaceholders(): single-pass regex, no recursive substitution
 * - classify() tier fallback: utility -> session -> heuristic
 * - classify() budget-exhausted retry: one-shot enlarged-budget retry when a
 *   reasoning-heavy model returns empty text with stopReason=length
 *
 * normalizeLabel()/replacePlaceholders() are pure helpers, tested directly.
 * classify() runs against a stubbed completeSimple (__setCompleteSimpleForTest)
 * and a minimal fake ctx - no provider/network needed.
 */

import { join, dirname } from "node:path";
import { strict as assert } from "node:assert";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = join(__dirname, "..", "..", "..");

console.log("=== text-classifier Regression Tests ===\n");

// ── Import ────────────────────────────────────────────────────────────────────

const { normalizeLabel, replacePlaceholders } = await import(
  join(ROOT, "dist", "lib", "ai", "text-classifier.js")
);

// ─── normalizeLabel() ─────────────────────────────────────────────────────────

console.log("[1] normalizeLabel() - prefix matching...");

// Exact matches
assert.strictEqual(normalizeLabel("yes"), "yes", 'exact "yes"');
assert.strictEqual(normalizeLabel("no"), "no", 'exact "no"');

// Case insensitivity
assert.strictEqual(normalizeLabel("YES"), "yes", '"YES" uppercase');
assert.strictEqual(normalizeLabel("No"), "no", '"No" capitalized');
assert.strictEqual(normalizeLabel("YeS"), "yes", '"YeS" mixed case');

// Prefix matching (the fix for verbose model outputs)
assert.strictEqual(normalizeLabel("Yes, this is code"), "yes", '"Yes, this is code" prefix');
assert.strictEqual(normalizeLabel("No, this is not safe"), "no", '"No, this is not safe" prefix');
assert.strictEqual(normalizeLabel("yes."), "yes", '"yes." with period');
assert.strictEqual(normalizeLabel("no."), "no", '"no." with period');

// Trimming
assert.strictEqual(normalizeLabel("  yes  "), "yes", '"  yes  " trimmed');

// Non-matching cases
assert.strictEqual(normalizeLabel("maybe"), null, '"maybe" null');
assert.strictEqual(normalizeLabel(""), null, "empty string null");
assert.strictEqual(normalizeLabel("YesYes"), null, '"YesYes" - no word boundary after "Yes"');

// Edge: word boundary after "yes"/"no"
assert.strictEqual(normalizeLabel("yesterday"), null, '"yesterday" - "yes" isn\'t a word');
assert.strictEqual(normalizeLabel("notable"), null, '"notable" - "no" isn\'t a word boundary');

// Edge: punctuation after prefix
assert.strictEqual(normalizeLabel("No!"), "no", '"No!" prefix with exclamation');
assert.strictEqual(normalizeLabel("Yes?"), "yes", '"Yes?" prefix with question');

console.log(" [ok] 15/15 normalizeLabel assertions passed");

// ─── normalizeLabel() - multi-class path via validLabels ──────────────────────

console.log("\n[1b] normalizeLabel() - validLabels whitelist (trajectoryPattern case)...");

// regression: trajectoryPattern critic returns hyphenated
// pattern names (Read-Edit-Bash, Repeated-Test, etc.) but the old
// normalizeLabel only accepted yes/no, producing "unparseable label"
// warnings at the end of every session.

// Without validLabels: "Read-Edit-Bash"is unparseable (not yes/no)
assert.strictEqual(
  normalizeLabel("Read-Edit-Bash"),
  null,
  '"Read-Edit-Bash" with no validLabels -> null (multi-class needs whitelist)',
);
assert.strictEqual(
  normalizeLabel("Repeated-Test"),
  null,
  '"Repeated-Test" with no validLabels -> null',
);

// With validLabels: whitelisted labels are accepted
const patternLabels = [
  "Read-Fix-Verify",
  "Read-Fix-Test",
  "Read-Create-Verify",
  "Error-Diagnose-Fix",
  "Read-Test-Fix-Verify",
  "Research-Read-Fix-Verify",
  "Repeated-Test",
  "Multi-Source-Investigation",
  "Iterative-Fix-Verify",
];

for (const label of patternLabels) {
  assert.strictEqual(
    normalizeLabel(label, patternLabels),
    label.toLowerCase(),
    `"${label}" in validLabels -> accepted (lowercased)`,
  );
}

// Case insensitivity: mistral-small often returns lowercase versions
// of labels that ARE in the whitelist. We test with a whitelisted label.
assert.strictEqual(
  normalizeLabel("repeated-test", patternLabels),
  "repeated-test",
  '"repeated-test" (lowercase, in validLabels) -> accepted',
);
assert.strictEqual(
  normalizeLabel("REPEATED-TEST", patternLabels),
  "repeated-test",
  '"REPEATED-TEST" (uppercase, in validLabels) -> accepted (lowercased)',
);

// Non-whitelisted hyphenated label: not in the list, not yes/no
assert.strictEqual(
  normalizeLabel("Read-Edit-Bash", patternLabels.slice(0, 5)),
  null,
  '"Read-Edit-Bash" NOT in narrower validLabels -> null (whitelist enforced)',
);

// Trailing punctuation: model sometimes adds "."or ","
assert.strictEqual(
  normalizeLabel("Repeated-Test.", patternLabels),
  null,
  '"Repeated-Test." with trailing period -> null (whitelist is exact-match)',
);

// yes/no still work in the multi-class path (defensive fallback for
// uncertain model responses)
assert.strictEqual(
  normalizeLabel("yes", patternLabels),
  "yes",
  '"yes" in multi-class path -> still accepted (yes/no fallback)',
);
assert.strictEqual(
  normalizeLabel("no", patternLabels),
  "no",
  '"no" in multi-class path -> still accepted (yes/no fallback)',
);

// Empty validLabels array: behave like no validLabels (binary fallback)
assert.strictEqual(
  normalizeLabel("Read-Edit-Bash", []),
  null,
  "empty validLabels array -> binary fallback (Read-Edit-Bash -> null)",
);

console.log(" [ok] validLabels whitelist verified for trajectoryPattern critic");

// ─── replacePlaceholders() ────────────────────────────────────────────────────

console.log("\n[2] replacePlaceholders() - template interpolation...");

// Basic substitution
assert.strictEqual(
  replacePlaceholders("Is this {{text}}?", { text: "code" }),
  "Is this code?",
  '{{text}} -> "code"',
);

// Multiple placeholders
assert.strictEqual(
  replacePlaceholders("{{claim}} vs {{context}}", { claim: "A", context: "B" }),
  "A vs B",
  "{{claim}} + {{context}}",
);

// No placeholders - passthrough
assert.strictEqual(replacePlaceholders("Hello world", {}), "Hello world", "no placeholders");

// Unrecognized placeholder - preserved literally
assert.strictEqual(
  replacePlaceholders("{{unknown}} here", {}),
  "{{unknown}} here",
  "unknown placeholder preserved",
);

// Single-pass: injected value containing {{otherKey}} NOT re-substituted
const result = replacePlaceholders("{{a}}", {
  a: "contains {{b}}",
  b: "should not appear",
});
assert.strictEqual(result, "contains {{b}}", "single-pass: {{b}} inside value not re-parsed");

// Multiple occurrences of same key
assert.strictEqual(
  replacePlaceholders("{{x}} and {{x}}", { x: "same" }),
  "same and same",
  "same key multiple times",
);

// Keys with numbers
assert.strictEqual(replacePlaceholders("{{var1}}", { var1: "value" }), "value", "key with numbers");

// Empty value
assert.strictEqual(
  replacePlaceholders("before{{mid}}after", { mid: "" }),
  "beforeafter",
  "empty substitution value",
);

console.log(" [ok] 9/9 replacePlaceholders assertions passed");

// ─── classify() exports ───────────────────────────────────────────────────────

console.log("\n[3] classify() - API surface...");

const { classify } = await import(join(ROOT, "dist", "lib", "ai", "text-classifier.js"));
assert.strictEqual(typeof classify, "function", "classify() is a function");

console.log("\n[4] classify() - budget-exhausted one-shot retry (behavioral)...");

// A reasoning-capable session model that defaults to thinking on the
// agent-zero gateway (thinkingLevelMap has no "off" entry) - the shape that
// produced "unparseable label: \"\" (stopReason=length, used 1000 tokens)".
const fakeCtx = {
  model: {
    id: "deepseek-v4-1-flash",
    provider: "agent-zero",
    api: "openai-completions",
    reasoning: true,
    thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "xhigh" },
  },
  modelRegistry: { getApiKeyForProvider: async () => "fake-key" },
};

function stubAssistantMessage({ text, stopReason, outputTokens }) {
  return {
    role: "assistant",
    content: text ? [{ type: "text", text }] : [],
    api: "openai-completions",
    provider: "agent-zero",
    model: "stub",
    usage: { input: 10, output: outputTokens ?? (text ? 2 : 1000), totalTokens: 0 },
    stopReason,
    timestamp: Date.now(),
  };
}

// Runs classify() once with the stub installed; returns the result plus every
// completeSimple call's options (so maxTokens/reasoning per attempt is pinned).
async function classifyWithStub(stub, extraOptions = {}) {
  const { __setCompleteSimpleForTest } = await import(
    join(ROOT, "dist", "lib", "ai", "llm-call.js")
  );
  const calls = [];
  __setCompleteSimpleForTest(async (_model, _context, options) => {
    calls.push({ maxTokens: options.maxTokens, reasoning: options.reasoning });
    return stub(calls.length);
  });
  try {
    const result = await classify(
      fakeCtx,
      { systemPrompt: "sys", userPrompt: "{{x}}" },
      { x: "test" },
      // Isolate the LLM tier: the binary gate is its own 1-token path.
      { binaryGate: false, ...extraOptions },
    );
    return { result, calls };
  } finally {
    __setCompleteSimpleForTest(null);
  }
}

// (a) Empty text + stopReason=length on the first attempt, label on the retry.
{
  const { result, calls } = await classifyWithStub((n) =>
    n === 1
      ? stubAssistantMessage({ text: "", stopReason: "length", outputTokens: 1000 })
      : stubAssistantMessage({ text: "yes", stopReason: "stop" }),
  );
  assert.strictEqual(result.label, "yes", "retry after budget exhaustion recovers the label");
  assert.strictEqual(result.tier, "session", "recovered label keeps the tier attribution");
  assert.strictEqual(calls.length, 2, "exactly one retry fires for the length+empty signature");
  assert.strictEqual(calls[0].maxTokens, 1000, "first attempt keeps callLlm's computed budget");
  assert.strictEqual(calls[1].maxTokens, 8192, "retry uses the enlarged budget");
  assert.strictEqual(calls[1].reasoning, "off", "retry still requests reasoning off");
}

// (b) Both attempts exhausted -> exactly one retry, then the failure surfaces.
{
  const { result, calls } = await classifyWithStub(() =>
    stubAssistantMessage({ text: "", stopReason: "length", outputTokens: 8192 }),
  );
  assert.strictEqual(calls.length, 2, "retry is bounded to one attempt");
  assert.strictEqual(result.label, "unknown", "two exhaustions still fail the tier");
  assert.strictEqual(result.tier, "failed", "tier is 'failed' after the retry also fails");
}

// (c) Non-empty unparseable answer: a format problem, no retry.
{
  const { result, calls } = await classifyWithStub(() =>
    stubAssistantMessage({ text: "maybe", stopReason: "stop" }),
  );
  assert.strictEqual(calls.length, 1, "format failures are not retried");
  assert.strictEqual(result.tier, "failed", "format failure still fails the tier");
}

// (d) Empty text without stopReason=length: no retry (signature is precise).
{
  const { result, calls } = await classifyWithStub(() =>
    stubAssistantMessage({ text: "", stopReason: "stop" }),
  );
  assert.strictEqual(calls.length, 1, "empty stop is not treated as budget exhaustion");
  assert.strictEqual(result.tier, "failed", "non-length empty still fails the tier");
}

// (e) Clean GLM-style answer: single call, unchanged behavior.
{
  const { result, calls } = await classifyWithStub(() =>
    stubAssistantMessage({ text: "no", stopReason: "stop" }),
  );
  assert.strictEqual(calls.length, 1, "clean answers keep the single-call path");
  assert.strictEqual(result.label, "no", "clean answer label is parsed");
  assert.strictEqual(result.tier, "session", "clean answer tier is session");
}

// (f) Explicit caller budget: a hard cap is never exceeded by the retry.
{
  const { result, calls } = await classifyWithStub(
    () => stubAssistantMessage({ text: "", stopReason: "length", outputTokens: 64 }),
    { maxTokens: 64 },
  );
  assert.strictEqual(calls.length, 1, "an explicit budget disables the retry");
  assert.strictEqual(calls[0].maxTokens, 64, "the caller's cap is preserved");
  assert.strictEqual(result.tier, "failed", "explicitly capped exhaustion still fails the tier");
}

console.log(" [ok] budget-exhausted retry verified (recovery, bound, no-retry boundaries)");

// ─── classify() - merged role tier order (call-count probe) ──────────────────

console.log("\n[5] classify() - merged role tier order (call-count probe)...");

{
  const { getCustomModelKeys, setCustomModelKey, UTILITY_MODEL_KEY, MAX_POWER_MODEL_KEY } =
    await import(join(ROOT, "dist", "lib", "state", "global-state.js"));
  const { classify: classifyForTiers } = await import(
    join(ROOT, "dist", "lib", "ai", "text-classifier.js")
  );
  const { __setCompleteSimpleForTest } = await import(join(ROOT, "dist", "lib", "ai", "llm-call.js"));

  const ROLE_TIER = {
    id: "role-model",
    provider: "route-a",
    api: "openai-completions",
    input: ["text"],
  };
  const SESSION_TIER = {
    id: "session-model",
    provider: "route-b",
    api: "openai-completions",
    input: ["text"],
  };
  const TIER_CATALOG = [ROLE_TIER, SESSION_TIER];
  const tierCtx = {
    model: SESSION_TIER,
    modelRegistry: {
      find: (provider, id) => TIER_CATALOG.find((m) => m.provider === provider && m.id === id),
      getAll: () => TIER_CATALOG,
      getAvailable: () => TIER_CATALOG,
      getApiKeyForProvider: async () => "test-key",
    },
  };

  function tierStub() {
    return {
      role: "assistant",
      content: [{ type: "text", text: "maybe" }],
      api: "openai-completions",
      provider: "route-a",
      model: "stub",
      usage: { input: 1, output: 1, totalTokens: 2 },
      stopReason: "stop",
      timestamp: Date.now(),
    };
  }

  /** Run one classify() call and return the tier attempts in order. */
  async function probeTierOrder(modelPreference) {
    const calls = [];
    __setCompleteSimpleForTest(async (model) => {
      calls.push(`${model.provider}/${model.id}`);
      return tierStub();
    });
    try {
      await classifyForTiers(
        tierCtx,
        { systemPrompt: "sys", userPrompt: "{{x}}" },
        { x: "test" },
        { binaryGate: false, modelPreference },
      );
    } finally {
      __setCompleteSimpleForTest(null);
    }
    return calls;
  }

  // The merged role is configured once; the legacy maxPowerModel key is also
  // set to prove it no longer contributes a second tier. An unparseable
  // answer fails every tier, so the probe observes the full order.
  setCustomModelKey(UTILITY_MODEL_KEY, "route-a/role-model");
  setCustomModelKey(MAX_POWER_MODEL_KEY, "route-a/role-model");

  const balancedCalls = await probeTierOrder("balanced");
  assert.deepEqual(
    balancedCalls,
    ["route-a/role-model", "route-b/session-model"],
    "balanced must try the merged role once, then the session model",
  );
  assert.strictEqual(
    balancedCalls.filter((c) => c === "route-a/role-model").length,
    1,
    "the merged role must be attempted once per call",
  );

  const qualityCalls = await probeTierOrder("quality");
  assert.deepEqual(
    qualityCalls,
    ["route-b/session-model", "route-a/role-model"],
    "quality must keep the session model first",
  );

  const maxCalls = await probeTierOrder("max");
  assert.deepEqual(maxCalls, balancedCalls, "max collapses to the balanced order");
  const speedCalls = await probeTierOrder("speed");
  assert.deepEqual(speedCalls, balancedCalls, "speed is the balanced order");

  getCustomModelKeys().clear();
}
console.log(
  " [ok] merged role order verified (balanced/speed/max role-first, quality session-first)",
);

// ─── Summary ───────────────────────────────────────────────────────────────────────

console.log("\n======================================================");
console.log("All text-classifier regression tests passed");
console.log("======================================================");

process.exit(0);
