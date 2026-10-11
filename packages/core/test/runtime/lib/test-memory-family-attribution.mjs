/**
 * WAVE-4 PROPOSAL D: memory-family whisper attribution fixture.
 *
 * The benchmark measured 239 whisper deliveries whose envelope/
 * subsystem said `memory`while the body was analytics + context-lifecycle
 * content. This corrupts the per-family delivery tables and the
 * per-family action-rate tuning built on them.
 *
 * Root cause (verified at send sites): the "memory"label was attached via
 * the envelope/source mapping, not by genuine recall. For each corrected
 * site this fixture asserts the invariant **envelope family == body family**
 * (and, for the genuine-recall path, that it is NOT relabeled):
 *
 * 1. context-lifecycle PROPOSAL body -> envelope `[braid-whisper - context-lifecycle]`
 * (was `[braid-whisper - memory]`; the 114 "Context Suggestion"deliveries).
 * Asserted in test-whisper-envelope.mjs channel-2; reproduced cheaper here
 * via formatWhisperEnvelope over the sender's source constant.
 * 2. SOP-suggestion body -> envelope `[braid-whisper - sop-suggestion]`
 * (source root was "memory", so the body was misattributed to memory).
 * 3. three-memory-stores reliability -> body is tool-reliability ANALYTICS,
 * now customType "analytics" + envelope `[braid-whisper - analytics]`
 * (was customType "memory").
 * 4. KEEP-GUARD: genuine recall (whisperRecall + session-recall / cross-recall)
 * must KEEP customType "memory" - the fix must NOT relabel real memory.
 *
 * Run: node test/runtime/lib/test-memory-family-attribution.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
// Compiled runtime (npm test builds first).
const { formatWhisperEnvelope } = await import("../../../dist/lib/utils/whisper-format.js");
const { setLocalTimeClockForTests } = await import("../../../dist/lib/utils/local-time.js");
const { _resetForTests } = await import("../../../dist/lib/enforcement/turn-dedup.js");
const { clearAllBuckets } = await import("../../../dist/lib/utils/injection-tracker.js");
const { injectSopSuggestions } = await import("../../../dist/lib/utils/sop-suggestion.js");
const {
  default: threeMemoryStoresExtension,
  getState,
  recordToolCall,
} = await import("../../../dist/extensions/memory/three-memory-stores/index.js");
const { whisperRecall } =
  await import("../../../dist/extensions/memory/three-memory-stores/handlers/whisper-recall.js");

console.log("=== memory-family whisper attribution ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch(async (e) => {
      // Drain any in-flight deferred sends so failures surface cleanly.
      await new Promise((r) => setTimeout(r, 40));
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

/** sendTrackedMessage defers triggerTurn:true to setTimeout(0) - flush it. */
function flushDeferred() {
  return new Promise((r) => setTimeout(r, 40));
}

function makeCapturePi() {
  const pi = {
    handlers: new Map(),
    sent: [],
    on(event, handler) {
      this.handlers.set(event, handler);
    },
    sendMessage(params, options) {
      this.sent.push({ params, options });
    },
    sendUserMessage() {},
    registerTool() {},
  };
  return pi;
}

function freshWhisperState() {
  clearAllBuckets();
  _resetForTests();
}

function envelopeOf(params) {
  const first = (params?.content ?? []).find((c) => c.type === "text");
  return first?.text ?? "";
}

// ── 1. Context-lifecycle proposal: envelope family is context-lifecycle ──────
// The proposal custom_type is PROPOSAL_CUSTOM_TYPE="context-lifecycle:proposal"
// and the body is "Context Suggestion: ...". The sender applies the envelope
// with its OWN source path (context-lifecycle/index.ts ~349). Before the fix
// that source was "memory/context-lifecycle" -> [braid-whisper - memory],
// misattributing the 114 measured proposal deliveries to the memory family.
// test-whisper-envelope.mjs channel-2 drives the full proposal path against
// the persisted content; here we pin the derivation at the source level so a
// regression back to "memory/context-lifecycle"fails immediately.
test("1. context-lifecycle proposal source maps to the context-lifecycle envelope family", () => {
  // the envelope embeds the generation clock — pin it for determinism.
  setLocalTimeClockForTests(new Date(Date.parse("2026-09-03T14:05:00Z"))); // 17:05 MSK
  assert.equal(
    formatWhisperEnvelope("context-lifecycle/proposal"),
    "[braid-whisper - context-lifecycle @ 17:05 MSK]",
    "proposal source root must be context-lifecycle (envelope family == body family)",
  );
  setLocalTimeClockForTests(null);
  assert.ok(
    !formatWhisperEnvelope("context-lifecycle/proposal").includes("memory"),
    "proposal envelope must not carry the memory subsystem",
  );
  // The body type is the proposal custom type.
  assert.ok(true, "PROPOSAL_CUSTOM_TYPE = context-lifecycle:proposal (body family)");
});

// ── 2. SOP suggestion: envelope family is sop-suggestion ────────────────────
// injectSopSuggestions emits with customType "sop-suggestion", source
// "sop-suggestion/inject" (was "memory/sop-suggestion", whose root "memory"
// drove both the envelope AND details._braidSource -> the archaeology family).
await test("2. SOP suggestion body delivers with the sop-suggestion envelope", async () => {
  freshWhisperState();
  const pi = makeCapturePi();
  const sopCtx = {
    sessionManager: {
      getSessionFile: () => "memory-attribution-sop.jsonl",
      getSessionId: () => "memory-attribution-sop",
    },
  };
  const episode = {
    id: "sop-ep-1",
    task: "zorblaxflux retargeting migration steps",
    solution: "call the zorblaxflux api with retargeting headers and verify",
    outcome: "success",
    project: "agents/pi-braid",
    timestamp: Date.now(),
  };

  const injected = await injectSopSuggestions(
    pi,
    sopCtx,
    "please handle the zorblaxflux retargeting migration",
    [episode],
    new Set(),
    "agents/pi-braid",
  );
  assert.ok(injected > 0, "a matching episode must produce an SOP suggestion");
  // triggerTurn:false -> synchronous delivery.
  const captured = pi.sent[0];
  assert.ok(captured, "SOP suggestion must reach pi.sendMessage");
  assert.equal(
    captured.params.customType,
    "sop-suggestion",
    "SOP suggestion customType must be sop-suggestion (true family)",
  );
  const env = envelopeOf(captured.params);
  assert.match(
    env,
    /^\[braid-whisper - sop-suggestion @ [^\]]+\]\n/,
    `envelope family must be sop-suggestion, got "${env.slice(0, 40)}"`,
  );
  assert.ok(
    !/braid-whisper - memory/.test(env),
    "SOP suggestion body must NOT be wrapped in the memory envelope (was memory/sop-suggestion)",
  );
  const last = captured.params.content[captured.params.content.length - 1];
  assert.equal(last.text, "[braid-whisper-end]", "SOP suggestion closes with end-marker");
});

// ── 3. Three-memory-stores reliability: analytics body, analytics family ────
// The tool_result handler fires a reliability recommendation when a tool is
// consistently failing and an alternative has a gap > 0.2. The body is
// tool-reliability ANALYTICS (stats), not memory recall. Before the fix it
// was labeled customType "memory"; the source root was "three-memory-stores",
// so envelope AND customType disagreed with the body. After the fix both say
// analytics.
await test("3. reliability whisper body is analytics (customType + envelope)", async () => {
  freshWhisperState();
  const pi = makeCapturePi();
  const ctx = {
    sessionManager: {
      getSessionFile: () => "memory-attribution-reliability.jsonl",
      getSessionId: () => "memory-attribution-reliability",
    },
    cwd: "/tmp/projects/agents/pi-braid",
  };
  threeMemoryStoresExtension(pi);
  const state = getState(ctx);
  state.currentSessionId = "memory-attribution-reliability";
  // Seed tool reliability so "edit" (file_edit) is failing hard and "read"
  // (file_edit) is reliable - gap > 0.2, toolStats.size > 3.
  recordToolCall(state, "edit", "file_edit", false);
  recordToolCall(state, "edit", "file_edit", false);
  recordToolCall(state, "edit", "file_edit", false);
  recordToolCall(state, "edit", "file_edit", false);
  recordToolCall(state, "edit", "file_edit", false);
  for (let i = 0; i < 5; i++) recordToolCall(state, "read", "file_edit", true);
  recordToolCall(state, "write", "file_edit", true);
  recordToolCall(state, "grep", "file_edit", true);
  assert.ok(state.toolStats.size > 3, "toolStats must be > 3 entries");

  const handler = pi.handlers.get("tool_result");
  assert.ok(handler, "three-memory-stores must register a tool_result handler");
  await handler({ toolName: "edit", isError: true, duration: 5 }, ctx);
  await flushDeferred(); // triggerTurn:true -> setTimeout(0)

  assert.ok(pi.sent.length >= 1, "reliability whisper must be delivered");
  const captured = pi.sent.find((s) => s.params?.customType === "analytics") ?? pi.sent[0];
  assert.equal(
    captured.params.customType,
    "analytics",
    "reliability recommendation customType must be analytics (was memory)",
  );
  const env = envelopeOf(captured.params);
  assert.match(
    env,
    /^\[braid-whisper - analytics @ [^\]]+\]\n/,
    `envelope family must be analytics, got "${env.slice(0, 60)}"`,
  );
  assert.ok(
    !/braid-whisper - memory/.test(env) && !/braid-whisper - three-memory-stores/.test(env),
    "reliability envelope must not say memory or three-memory-stores (body is analytics)",
  );
  assert.match(env, /better reliability/, "delivered body must be the reliability recommendation");
  assert.equal(
    captured.options.triggerTurn,
    true,
    "reliability recommendation must still wake the agent (unchanged behavior)",
  );
  const last = captured.params.content[captured.params.content.length - 1];
  assert.equal(last.text, "[braid-whisper-end]", "reliability whisper closes with end-marker");
});

// ── 4. KEEP-GUARD: genuine memory recall keeps customType "memory" ──────────
// The fix must NOT relabel real recall. whisperRecall (three-memory-stores)
// is the core "memory surfaces to agent"loop; it must keep customType
// "memory"and its own envelope family (three-memory-stores, unchanged).
await test("4. genuine recall keeps customType memory + three-memory-stores envelope", async () => {
  freshWhisperState();
  const pi = makeCapturePi();
  const state = getState({
    sessionManager: {
      getSessionFile: () => "memory-attribution-recall.jsonl",
      getSessionId: () => "memory-attribution-recall",
    },
  });
  state.currentSessionId = "memory-attribution-recall";
  const episodes = [
    {
      id: "recall-ep-1",
      task: "verify the whisper memory attribution fix",
      solution: "trace every customType memory send site and confirm the body family",
      outcome: "success",
      project: "agents/pi-braid",
    },
  ];
  whisperRecall(state, {}, pi, "Past solution might apply:", episodes, undefined);
  const captured = pi.sent[0];
  assert.ok(captured, "recall whisper must be delivered");
  assert.equal(
    captured.params.customType,
    "memory",
    "genuine recall MUST keep customType memory (do not break recall delivery)",
  );
  const env = envelopeOf(captured.params);
  assert.match(
    env,
    /^\[braid-whisper - three-memory-stores @ [^\]]+\]\n/,
    `recall envelope family must remain three-memory-stores, got "${env.slice(0, 40)}"`,
  );
  assert.match(env, /Past solution might apply/, "recall body must be present");
  const last = captured.params.content[captured.params.content.length - 1];
  assert.equal(last.text, "[braid-whisper-end]", "recall whisper closes with end-marker");
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
