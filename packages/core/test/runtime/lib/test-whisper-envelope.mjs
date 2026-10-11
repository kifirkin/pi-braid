/**
 * EW-7.12+: Universal whisper envelope test (runtime only).
 *
 * HISTORY:
 * The audit's .12 found that ~30% of system-injected messages had no
 * prefix at all ("Context at 80%.", "## Session Size Notice",
 * "VbC correction: ...") and the rest had inconsistent prefixes
 * ("[enforcement]", "[Quality]", "[chains]", "[TIMER FIRED]"). The agent
 * could confuse these with human user input, especially because many
 * use imperative voice ("Consider X", "Run Y").
 *
 * FIX:
 * - Add `lib/utils/whisper-format.ts`with `formatWhisperEnvelope`and
 * `applyWhisperEnvelope`helpers.
 * - `sendTrackedMessage` (the trunk) calls `applyWhisperEnvelope`so
 * every system-injected message gets the universal prefix.
 *
 * `applyWhisperEnvelope`now ALSO appends a trailing
 * `[braid-whisper-end]`marker as the last text element, so multiline
 * and single-line whisper boundaries are unambiguous. The marker is a
 * separate text element (never spliced into the first/prefix element),
 * so the envelope prefix assertions below stay valid unchanged; only the
 * element-count expectations for empty / no-text content grew by one.
 *
 * This test exercises the runtime behavior of formatWhisperEnvelope,
 * formatWhisperEndMarker and applyWhisperEnvelope.
 */

import { strict as assert } from "node:assert";
// Import the runtime helpers from the compiled output
const { formatWhisperEnvelope, formatWhisperEndMarker, applyWhisperEnvelope } =
  await import("../../../dist/lib/utils/whisper-format.js");

// the envelope carries the generation clock `@ HH:MM TZ`. Pin the test
// clock so every exact-string assertion below is deterministic (
// 17:05 Europe/Moscow = 14:05Z). null restores real time.
const { setLocalTimeClockForTests } = await import("../../../dist/lib/utils/local-time.js");
const PINNED_CLOCK = new Date(Date.parse("2026-09-03T14:05:00Z")); // 17:05 MSK
setLocalTimeClockForTests(PINNED_CLOCK);

console.log("=== EW-7.12+: Universal whisper envelope ===\n");

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

// ── Runtime tests ────────────────────────────────────────────────────────────

test("formatWhisperEnvelope uses the source's first segment as subsystem", () => {
  assert.equal(
    formatWhisperEnvelope("enforcement/whisper"),
    "[braid-whisper - enforcement @ 17:05 MSK]",
    "enforcement/whisper should produce the enforcement subsystem tag",
  );
  assert.equal(
    formatWhisperEnvelope("memory/context-manager"),
    "[braid-whisper - memory @ 17:05 MSK]",
    "memory/context-manager should produce the memory subsystem tag",
  );
  assert.equal(
    formatWhisperEnvelope("timer/fire"),
    "[braid-whisper - timer @ 17:05 MSK]",
    "timer/fire should produce the timer subsystem tag",
  );
  assert.equal(
    formatWhisperEnvelope("cognitive/sycophancy-detector"),
    "[braid-whisper - cognitive @ 17:05 MSK]",
    "cognitive/* should produce the cognitive subsystem tag",
  );
});

test("formatWhisperEnvelope falls back to 'system' for empty/bare source", () => {
  assert.equal(formatWhisperEnvelope(""), "[braid-whisper - system @ 17:05 MSK]");
  assert.equal(formatWhisperEnvelope("unknown"), "[braid-whisper - unknown @ 17:05 MSK]");
});

test("applyWhisperEnvelope prepends the envelope to the first text element", () => {
  const content = [{ type: "text", text: "Error burst detected: 3 consecutive errors." }];
  applyWhisperEnvelope(content, "enforcement/whisper");
  assert.equal(
    content[0].text,
    "[braid-whisper - enforcement @ 17:05 MSK]\nError burst detected: 3 consecutive errors.",
  );
});

test("applyWhisperEnvelope mutates the existing text in place", () => {
  const content = [{ type: "text", text: "memory recall" }];
  const before = content;
  applyWhisperEnvelope(content, "memory/three-memory-stores");
  assert.strictEqual(content, before, "should mutate the same array reference");
  assert.match(content[0].text, /^\[braid-whisper - memory @ 17:05 MSK\]\n/);
});

test("applyWhisperEnvelope handles empty content array", () => {
  const content = [];
  applyWhisperEnvelope(content, "enforcement/whisper");
  assert.equal(content.length, 2, "should prepend envelope + append end-marker");
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "[braid-whisper - enforcement @ 17:05 MSK]\n");
  assert.equal(content[1].type, "text");
  assert.equal(
    content[1].text,
    "[braid-whisper-end]",
    "empty whisper still closes with the end-marker",
  );
});

test("applyWhisperEnvelope handles content with no text element", () => {
  const content = [{ type: "image", data: "fake" }];
  applyWhisperEnvelope(content, "memory/context-manager");
  assert.equal(content.length, 3, "should prepend envelope text + append end-marker");
  assert.equal(content[0].type, "text");
  assert.equal(content[0].text, "[braid-whisper - memory @ 17:05 MSK]\n");
  assert.equal(content[1].type, "image");
  assert.equal(content[2].type, "text");
  assert.equal(
    content[2].text,
    "[braid-whisper-end]",
    "no-text content still closes with the end-marker",
  );
});

// ── End-marker coverage ─────────────────────────────────────────────────────

test("formatWhisperEndMarker returns the canonical end-marker", () => {
  assert.equal(formatWhisperEndMarker(), "[braid-whisper-end]");
});

test("applyWhisperEnvelope appends the end-marker last for a single text element", () => {
  const content = [{ type: "text", text: "Error burst detected" }];
  applyWhisperEnvelope(content, "enforcement/whisper");
  assert.equal(content.length, 2);
  assert.equal(content[0].text, "[braid-whisper - enforcement @ 17:05 MSK]\nError burst detected");
  assert.equal(content[1].type, "text");
  assert.equal(content[1].text, "[braid-whisper-end]", "marker must be the last element");
});

test("applyWhisperEnvelope appends the end-marker after the last of multiple text elements", () => {
  const content = [
    { type: "text", text: "line one" },
    { type: "text", text: "line two" },
  ];
  applyWhisperEnvelope(content, "dreamer/whisper");
  assert.equal(content.length, 3);
  assert.equal(content[0].text, "[braid-whisper - dreamer @ 17:05 MSK]\nline one");
  assert.equal(content[1].text, "line two");
  assert.equal(content[2].type, "text");
  assert.equal(content[2].text, "[braid-whisper-end]", "marker must be the very last element");
});

test("applyWhisperEnvelope renders the documented output shape with a newline before the end-marker", () => {
  const content = [
    { type: "text", text: "whisper text here..." },
    { type: "text", text: "could be multiline..." },
  ];
  applyWhisperEnvelope(content, "enforcement/whisper");
  const rendered = content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  assert.equal(
    rendered,
    "[braid-whisper - enforcement @ 17:05 MSK]\nwhisper text here...\ncould be multiline...\n[braid-whisper-end]",
  );
});

test("opening tag line carries nothing after ] — body starts on the next line", () => {
  const content = [{ type: "text", text: "Error burst detected" }];
  applyWhisperEnvelope(content, "enforcement/whisper");
  const tagLine = content[0].text.split("\n")[0];
  assert.equal(
    tagLine,
    "[braid-whisper - enforcement @ 17:05 MSK]",
    "line 1 is the tag alone (no body, no trailing space)",
  );
  assert.equal(content[0].text.split("\n")[1], "Error burst detected", "body starts on line 2");
  assert.equal(content[1].text, "[braid-whisper-end]", "end marker is its own element");
});

test("every content shape closes with exactly one end-marker on the last element", () => {
  const shapes = [
    [],
    [{ type: "image", data: "fake" }],
    [{ type: "text", text: "solo" }],
    [
      { type: "text", text: "a" },
      { type: "text", text: "b" },
    ],
    [
      { type: "image", data: "x" },
      { type: "text", text: "mid" },
    ],
  ];
  for (const shape of shapes) {
    const content = shape.slice();
    applyWhisperEnvelope(content, "enforcement/whisper");
    const last = content[content.length - 1];
    assert.equal(last.type, "text", "last element must be text");
    assert.equal(last.text, "[braid-whisper-end]", "last element must be the end-marker");
    const markers = content.filter((c) => c.type === "text" && c.text === "[braid-whisper-end]");
    assert.equal(markers.length, 1, "exactly one end-marker per whisper");
    const firstText = content.find((c) => c.type === "text");
    assert.equal(
      firstText.text.split("\n")[0],
      "[braid-whisper - enforcement @ 17:05 MSK]",
      "opening tag line carries nothing after ] in every content shape",
    );
  }
});

test("applyWhisperEnvelope preserves body-level sub-tags like [dream] or [recall]", () => {
  const content = [{ type: "text", text: "[dream] Likely to get stuck in edit loop." }];
  applyWhisperEnvelope(content, "enforcement/dreamer");
  assert.equal(
    content[0].text,
    "[braid-whisper - enforcement @ 17:05 MSK]\n[dream] Likely to get stuck in edit loop.",
    "sub-tag should be preserved after the universal envelope",
  );
});

// ── Bypass-channel regression: SOP coach whisper ────────────────────────────
//
// Audit: the heartbeat SOP coach used
// `ctx.whisper?.()`, which is a type-only augmentation with no runtime
// implementation (the old monkey-patch was removed) - the whisper silently
// never fired, and had it fired it would have bypassed the trunk envelope.
// The fix routes it through sendTrackedMessage via `sendSopCoachWhisper`.
//
// This test FAILS without the fix: `sendSopCoachWhisper`does not exist in
// the compiled output when the call site still uses `ctx.whisper` (the
// dynamic import throws), and even if the export existed, the delivered
// content would not carry the [braid-whisper - heartbeat] envelope.
//
// NOTE: like test-whisper-trigger-turn.mjs, this depends on
// braid.suppressNudges not being true in ~/.pi/agent/settings.json
// (sendTrackedMessage bails when cognitive nudges are disabled globally).

let sopCoachCaptured = null;
const sopCoachPi = {
  handlers: new Map(),
  on() {},
  sendMessage(params, options) {
    sopCoachCaptured = { params, options };
  },
  sendUserMessage() {},
};

// Compiled runtime (npm test builds first).
const { sendSopCoachWhisper } =
  await import("../../../dist/extensions/heartbeat/heartbeat-scheduler/index.js");

const { _resetForTests } = await import("../../../dist/lib/enforcement/turn-dedup.js");
const { clearAllBuckets, sendTrackedMessage } =
  await import("../../../dist/lib/utils/injection-tracker.js");

test("sendSopCoachWhisper delivers via pi.sendMessage with the [braid-whisper - heartbeat] envelope", () => {
  clearAllBuckets(); // fresh per-source flood cap state for this process
  _resetForTests(); // reset per-turn whisper caps (WHISPER_CAPS.low == 1)
  sopCoachCaptured = null;
  sendSopCoachWhisper(sopCoachPi, "Coach: reuse the edit-verify loop from the previous episode.");
  assert.ok(
    sopCoachCaptured,
    "sendTrackedMessage must reach pi.sendMessage (whisper actually delivers)",
  );
  assert.equal(
    sopCoachCaptured.params.content[0].text,
    "[braid-whisper - heartbeat @ 17:05 MSK]\nCoach: reuse the edit-verify loop from the previous episode.",
    "the SOP coach whisper must carry the universal envelope with the heartbeat subsystem",
  );
  const lastContent = sopCoachCaptured.params.content[sopCoachCaptured.params.content.length - 1];
  assert.equal(lastContent.type, "text", "SOP coach whisper must be closed by a text end-marker");
  assert.equal(
    lastContent.text,
    "[braid-whisper-end]",
    "SOP coach whisper must carry the end-marker",
  );
  const details = sopCoachCaptured.params.details ?? {};
  assert.equal(
    details._braidSource,
    "heartbeat/sop-coach",
    "source must be tagged for compaction/analytics",
  );
  assert.equal(
    sopCoachCaptured.options.deliverAs,
    "steer",
    "coach whisper must be delivered as a steer",
  );
  assert.equal(sopCoachCaptured.options.triggerTurn, false, "coach whisper must not force a turn");
});

// ── Task B: Channel audit — end-marker across every agent-visible system-message channel ──
//
// Exhaustive audit (round-2 completion). A "channel"here is any way pi-braid
// can place a system message into the agent's LLM context. The contract:
// EVERY agent-visible system message must carry BOTH the
// [braid-whisper - <subsystem>] prefix AND a terminal [braid-whisper-end]
// marker (applied centrally by applyWhisperEnvelope).
//
// CHANNEL TABLE (verified against packages/core/src, 2026-08):
//
// | # | Channel | Agent-visible? | Prefix + end-marker? | Status / routing |
// |---|---------|----------------|-----------------------|------------------|
// | 1 | sendTrackedMessage (injection-tracker.ts trunk) — the ONLY delivery
// | | path for pi.sendMessage in pi-braid (20+ call sites across enforcement,
// | | timer, context-manager, context-lifecycle, heartbeat, memory, drift,
// | | auto-recovery, skills, prompt-builder, sop-suggestion, analytics) | yes |
// | | yes — applyWhisperEnvelope runs at the top of sendTrackedMessage
// | | (injection-tracker.ts ~246) | ENVELOPED — verified below (channel-1
// | | test) + existing SOP-coach test |
// | 2 | appendCustomMessageEntry — persistent custom_message session entries
// | | replayed into agent context on resume/compaction (pi-core
// | | session-manager.js appendCustomMessageEntry -> sessionEntryToContextMessages) |
// | | yes | yes (after this commit) | MANUAL-ENVELOPED — the ONLY
// | | appendCustomMessageEntry call site in packages/core/src is the
// | | context-lifecycle proposal (index.ts:338-356). Before this commit it
// | | applied the prefix by hand and MISSED the end-marker; now the content
// | | array is built then passed through applyWhisperEnvelope so both prefix
// | | AND end-marker persist with the entry. Verified below (channel-2 test). |
// | 3 | ctx.whisper / context.whisper (heartbeat module legacy surface) | yes
// | | (had it fired) | n/a — no runtime implementation | HUMAN-ONLY / DEAD —
// | | ctx.whisper is a type-only augmentation with no runtime backing (old
// | | monkey-patch removed, see heartbeat-scheduler/index.ts:361). Zero live
// | | ctx.whisper call sites remain (all heartbeat modules call
// | | moduleContext.whisper -> whisperBuffer -> flushWhisperBuffer ->
// | | sendTrackedMessage via heartbeat/whisper-batcher or heartbeat/delayed). |
// | 4 | ui.notify / ctx.ui.notify (incl. log.* routed via logger.ts when ctx
// | | is bound) | NO — TUI-only | n/a | HUMAN-ONLY — user-facing TUI
// | | notifications (AGENTS.md:104), never enter LLM context. |
// | 5 | direct pi.sendMessage / pi.sendCustomMessage / pi.sendUserMessage
// | | outside injection-tracker | yes (had any existed) | n/a — zero call
// | | sites | NONE — every `.sendMessage(`/`sendUserMessage(`match in
// | | packages/core/src is a comment/doc. Timer wake:true and wake:false
// | | paths both call sendTrackedMessage (timer/index.ts:300,329). |
// | 6 | appendCustomEntry (type:"custom") — context-compress.ts:437,562 | NO —
// | | "plain custom entries are display/state entries and do not participate
// | | in context" (pi-core session-manager.js sessionEntryToContextMessages) |
// | | n/a | NOT-A-MESSAGE — compression archive records only. |
// | 7 | before_agent_start hook returning { messages } (pi-core injects them
// | | as role:"custom"messages) | yes (had any injected) | n/a — no
// | | injection call site | NONE — the only `return { messages }`in the tree
// | | is events.ts:376 on the compaction "context"event, which only
// | | sanitizes/cleans EXISTING messages, never adds new content. No
// | | before_agent_start hook returns messages. |
// | 8 | historic pre-fix persisted proposals (created before this commit) |
// | | yes (replay on resume) | prefix only, no end-marker | NEEDS-FOLLOW-UP —
// | | custom_message entries already persisted in session JSONL before this
// | | fix replay without the end-marker on session resume/compaction. Not a
// | | wiring channel (no code change retro-fits persisted bytes); a backfill/
// | | migration would rewrite old entries. Out of scope this round. |
//
// The two code-level channels that actually reach the agent (1 and 2) are
// exercised below; the rest are human-only, dead, or non-message channels and
// are documented above by design.

// Async-capable assertion helper for the integration tests below.
async function atest(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

// Channel 1 (trunk): a generic sendTrackedMessage must deliver BOTH the
// envelope prefix derived from its source AND the end-marker, for an arbitrary
// source. Every source-routed channel (timer, heartbeat, enforcement, skills,
// etc.) inherits this centrally.
let trunkCaptured = null;
const trunkPi = {
  handlers: new Map(),
  on() {},
  sendMessage(params, options) {
    trunkCaptured = { params, options };
  },
  sendUserMessage() {},
};

test("channel 1/trunk: sendTrackedMessage wraps any source with prefix AND end-marker", () => {
  clearAllBuckets(); // fresh per-source flood-cap state
  _resetForTests(); // reset per-turn whisper caps (WHISPER_CAPS.low == 1)
  trunkCaptured = null;
  sendTrackedMessage(
    trunkPi,
    {
      customType: "envelope-audit",
      content: [{ type: "text", text: "body" }],
      display: true,
    },
    { deliverAs: "steer" },
    { type: "context", source: "envelope-audit/trunk" },
  );
  assert.ok(trunkCaptured, "trunk must reach pi.sendMessage");
  assert.equal(
    trunkCaptured.params.content[0].text,
    "[braid-whisper - envelope-audit @ 17:05 MSK]\nbody",
    "first element must carry the envelope prefix for the source subsystem",
  );
  const last = trunkCaptured.params.content[trunkCaptured.params.content.length - 1];
  assert.equal(last.type, "text", "last element must be text");
  assert.equal(
    last.text,
    "[braid-whisper-end]",
    "every trunk envelope must close with the end-marker",
  );
});

// Channel 2 (appendCustomMessageEntry): the ONLY non-trunk agent-visible
// channel. Drive the REAL compiled context-lifecycle before_agent_start hook
// with a fake pi + fake sessionManager, seed a task_completion_candidate
// signal (policy finalize-suggestion -> propose), and assert the persisted
// proposal content carries BOTH the [braid-whisper - context-lifecycle]
// prefix and the [braid-whisper-end] marker.
//
// WAVE-4 PROPOSAL D: the envelope source was "memory/context-lifecycle"
// (first segment "memory" => [braid-whisper - memory]), which misattributed
// these proposal bodies to the memory family. Now the source is
// "context-lifecycle/proposal", so the envelope family == body family.
//
// FAILS WITHOUT THE FIX: before this commit the proposal was built by hand as
// `...${formatWhisperEnvelope(...)} Context Suggestion: ...` (a single text
// element) so content.length would be 1 and the end-marker assertion below
// would fail.
const proposedEntries = [];
const proposalSessionId = "envelope-audit-proposal-session";
const proposalCtx = {
  sessionManager: {
    getSessionFile: () => `fake-${proposalSessionId}.jsonl`,
    getSessionId: () => proposalSessionId,
    getEntries: () => [],
    getBranch: () => [],
    appendCustomMessageEntry: (type, content, persistent, meta) => {
      proposedEntries.push({ type, content, persistent, meta });
      return "entry-envelope-audit";
    },
  },
  getContextUsage: () => ({ percent: 0, tokens: 0 }),
};
const proposalPi = {
  handlers: new Map(),
  on(event, handler) {
    this.handlers.set(event, handler);
  },
  registerTool() {},
  sendMessage() {},
  sendUserMessage() {},
};

await atest(
  "channel 2/proposal: persisted proposal gets prefix + end-marker via appendCustomMessageEntry",
  async () => {
    const { _getState } =
      await import("../../../dist/extensions/memory/context-lifecycle/state.js");
    const { clearExtensionState } = await import("../../../dist/lib/state/extension-state.js");
    const { default: contextLifecycleExtension } =
      await import("../../../dist/extensions/memory/context-lifecycle/index.js");

    proposedEntries.length = 0;
    clearExtensionState(proposalCtx, "context-lifecycle"); // fresh per-session state
    const s = _getState(proposalCtx);
    // Seed exactly one propose-producing signal. With fresh detector state and
    // empty entries, detectSignals() returns pendingSignals as-is, and only the
    // finalize-suggestion policy matches task_completion_candidate (all other
    // default policies need context_usage >= 50, redundant messages, or a
    // different signal), so exactly one proposal is emitted.
    s.detector.pendingSignals.push({
      id: "sig-envelope-audit",
      type: "task_completion_candidate",
      timestamp: Date.now(),
      turn: 1,
      data: { topicHistory: [], uniqueTools: 3 },
      confidence: 0.9,
    });

    contextLifecycleExtension(proposalPi);
    await proposalPi.handlers.get("before_agent_start")(
      { prompt: "run the envelope channel audit" },
      proposalCtx,
    );

    assert.ok(
      proposedEntries.length >= 1,
      "task_completion_candidate signal must produce at least one proposal",
    );
    for (const captured of proposedEntries) {
      assert.equal(
        captured.type,
        "context-lifecycle:proposal",
        "custom type must be PROPOSAL_CUSTOM_TYPE",
      );
      assert.equal(captured.persistent, true, "proposal entries are persisted");
      assert.ok(captured.meta && captured.meta.id, "proposal meta must pass through unchanged");
      assert.equal(
        captured.content.length,
        2,
        "exactly envelope-first + end-marker-last (no hand-built single element)",
      );
      assert.match(
        captured.content[0].text,
        /^\[braid-whisper - context-lifecycle @ 17:05 MSK\]\nContext Suggestion: /,
        "first text element must carry the [braid-whisper - context-lifecycle] prefix + body",
      );
      assert.ok(
        !/braid-whisper - memory/.test(captured.content[0].text),
        "proposal body must NOT be wrapped in the memory envelope",
      );
      const last = captured.content[captured.content.length - 1];
      assert.equal(last.type, "text", "last element must be text");
      assert.equal(last.text, "[braid-whisper-end]", "proposal must close with the end-marker");
      const markers = captured.content.filter(
        (c) => c.type === "text" && c.text === "[braid-whisper-end]",
      );
      assert.equal(markers.length, 1, "exactly one end-marker per proposal");
    }
  },
);

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
