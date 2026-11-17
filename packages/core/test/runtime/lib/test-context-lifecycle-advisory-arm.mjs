/**
 * The context-lifecycle advisory channel: what it says, and when it may say it.
 *
 * WHY THIS EXISTS:
 *   A measured 15-hour seat heard 90 lifecycle advisories across ~830 turns
 *   (one every nine turns, about thirteen per context tool the agent actually
 *   called) and 10 of them read "Navigation proposals were ignored 3 times".
 *   The counter behind that sentence was "turns since a context-management
 *   tool", so three turns of reading, testing or writing code were counted as
 *   non-compliance, and the escalation arm sat below the act arm - the band a
 *   live seat legitimately occupies for hours and cannot leave.
 *
 * WHAT THIS PINS (the compiled extension, its real handlers):
 *   - at or above the act arm, three turns without a context tool escalate
 *     once, as an observation that names the two tools which reset it, and
 *     names no cold tool and no intent;
 *   - below the act arm the same turns never escalate (case 1);
 *   - below the act arm the light advisory repeats at most once per
 *     CONTEXT_LIFECYCLE_ADVISORY_REPEAT_TURNS (case 3), and the same harness
 *     delivering an advisory on two consecutive turns at the arm (case 4) is
 *     the control that pacing, not the delivery lane, holds case 3 to one.
 *
 * HOW THIS DRIVES THE RUNTIME: the real extension factory over a fake pi/ctx.
 * `turn()` does what the loop boundary does - it resets the turn-scoped whisper
 * dedup and the policy cooldowns, moves the injection clock past the reprime
 * window, and settles the macrotask a `triggerTurn` send defers into - so
 * every silence observed below comes from the code under test.
 *
 * The window is pinned to 256k in a throwaway settings file so act is
 * min(0.60W, 130k) = 130k, and the sub-arm / at-arm payloads are derived from
 * tokenArms(W) rather than restated here.
 *
 * Run: node test/runtime/lib/test-context-lifecycle-advisory-arm.mjs
 * (built first: npm run build)
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Redirect HOME and BRAID_HOME before any dist module evaluates a path: the
// effective window is resolved from <homedir()>/.pi/agent/settings.json and the
// log/state writers go under BRAID_HOME.
const W = 256_000;
const FAKE_HOME = mkdtempSync(join(tmpdir(), "lifecycle-advisory-arm-"));
const FAKE_BRAID = mkdtempSync(join(tmpdir(), "lifecycle-advisory-braid-"));
process.env.HOME = FAKE_HOME;
process.env.BRAID_HOME = FAKE_BRAID;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(
  join(FAKE_HOME, ".pi", "agent", "settings.json"),
  JSON.stringify({ braid: { context: { contextLimitTokens: W } } }),
);
process.on("exit", () => {
  rmSync(FAKE_HOME, { recursive: true, force: true });
  rmSync(FAKE_BRAID, { recursive: true, force: true });
});

const load = (rel) => import("file://" + join(ROOT, "dist", rel));
const { clearAllBuckets, _setReprimeClockForTests, REPRIME_COOLDOWN_MS } = await load(
  "lib/utils/injection-tracker.js",
);
const { _resetForTests } = await load("lib/enforcement/turn-dedup.js");
const { _getState } = await load("extensions/memory/context-lifecycle/state.js");
const { default: contextLifecycleExtension } = await load(
  "extensions/memory/context-lifecycle/index.js",
);
const { tokenArms } = await load("lib/detection/context-usage.js");
const { CONTEXT_LIFECYCLE_ADVISORY_REPEAT_TURNS } = await load(
  "lib/detection/context-thresholds.js",
);

const ARMS = tokenArms(W);
/** Under the act arm and above soft: the band a working seat legitimately sits in. */
const BELOW_ACT = Math.round(ARMS.act * 0.75);
/** Over the act arm, under the escalate wording arm. */
const AT_ACT = ARMS.act + 5_000;

const COLD_CONTEXT_TOOLS = ["context_inspect", "context_proposals"];

/** Clock origin for the reprime override; each turn moves past the window. */
const CLOCK_BASE = Date.now();
let seq = 0;

after(() => {
  _setReprimeClockForTests(null);
});

/**
 * One lifecycle session: the real extension over a fake pi/ctx, driven a turn
 * at a time. A `triggerTurn` send is deferred into a macrotask by the delivery
 * funnel, so every turn settles before the next one starts.
 */
function makeHarness({ tokens }) {
  const entries = [];
  const sent = [];
  const labels = [];
  const handlers = new Map();
  const sessionId = `lifecycle-advisory-${seq++}-${Date.now()}`;
  let turnIndex = 0;

  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    sendMessage(params, options) {
      const text = (params?.content ?? []).map((part) => part?.text ?? "").join("\n");
      sent.push({ text, params, options });
    },
    sendUserMessage() {},
    setLabel(_id, label) {
      labels.push(label);
    },
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  };

  const ctx = {
    cwd: "/tmp/lifecycle-advisory-fixture",
    sessionManager: {
      getSessionFile: () => `fake-${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getEntries: () => entries.slice(),
      getBranch: () => [],
      getLeafId: () => "leaf-1",
      getLabel: () => undefined,
      appendCustomMessageEntry: (type, content, persistent, meta) => {
        const id = `e${entries.length}`;
        entries.push({
          id,
          type: "custom_message",
          customType: type,
          content,
          persistent,
          details: meta,
        });
        return id;
      },
    },
    getContextUsage: () => ({
      percent: (tokens / W) * 100,
      tokens,
      contextWindow: W,
    }),
    compact() {},
  };

  contextLifecycleExtension(pi);

  const harness = {
    sent,
    labels,
    state: () => _getState(ctx),
    async emit(event, payload) {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
    /**
     * One turn. `tag` emits the tool call that queues a task_boundary signal
     * (context_navigate tag), so the phase-boundary advisory is armed for this
     * turn exactly as a real tag arms it.
     */
    async turn({ tag = false } = {}) {
      _resetForTests();
      _setReprimeClockForTests(CLOCK_BASE + ++turnIndex * (REPRIME_COOLDOWN_MS + 1000));
      harness.state().policyEngine.cooldowns.clear();
      if (tag) {
        await harness.emit("tool_call", { toolName: "context_navigate", input: { action: "tag" } });
      }
      await harness.emit("before_agent_start", { prompt: "lifecycle advisory fixture" });
      // A `triggerTurn` send is deferred into a macrotask; a steer/nextTurn send
      // is synchronous. Settle so both are visible to the assertions.
      await new Promise((resolve) => setTimeout(resolve, 10));
    },
    advisories() {
      return sent.filter(
        (m) => m.text.includes("Task boundary detected") || m.text.includes("Phase transition"),
      );
    },
    escalations() {
      return sent.filter((m) => m.text.includes("no context tool in the last"));
    },
  };

  // Session start clears injection tracking; nothing else in the fixture does.
  clearAllBuckets();
  return harness;
}

test("below the act arm, turns without a context tool never escalate", async () => {
  const h = makeHarness({ tokens: BELOW_ACT });
  await h.turn({ tag: true });
  assert.equal(h.advisories().length, 1, "the phase-boundary advisory anchors the counter");

  // Six empty turns: 2x the escalation threshold, at a band the seat can sit
  // in for hours. Nothing here is a refusal, so nothing may be called one.
  for (let i = 0; i < 6; i++) await h.turn();

  assert.equal(
    h.escalations().length,
    0,
    `a sub-arm seat must not escalate on turn count: ${h.sent.map((m) => m.text).join(" | ")}`,
  );
});

test("at the act arm, three turns without a context tool escalate once, as observation", async () => {
  const h = makeHarness({ tokens: AT_ACT });
  await h.turn({ tag: true });
  assert.equal(h.advisories().length, 1, "the phase-boundary advisory anchors the counter");

  for (let i = 0; i < 3; i++) await h.turn();
  const escalations = h.escalations();
  assert.equal(escalations.length, 1, "three turns at the arm escalate exactly once");

  const text = escalations[0].text;
  assert.match(text, /no context tool in the last 3 turns/i, "states the observation");
  assert.match(text, /context_compress\(action="archive"\)/, "names a tool that resets it");
  assert.match(text, /context_navigate\(action="checkout"/, "names the second reset");
  assert.doesNotMatch(text, /ignor/i, "asserts nothing about the agent's intent");
  for (const cold of COLD_CONTEXT_TOOLS) {
    assert.ok(
      !text.includes(cold),
      `${cold} is a cold tool (deferred until tool_search); the escalation must not name it bare`,
    );
  }
  assert.ok(
    h.labels.some((label) => label.startsWith("auto-tag-")),
    "the auto-tag stays: it costs nothing and it makes a recovery point",
  );
});

test("below the act arm the light advisory repeats at most once per repeat window", async () => {
  const h = makeHarness({ tokens: BELOW_ACT });
  const turns = CONTEXT_LIFECYCLE_ADVISORY_REPEAT_TURNS - 8;
  for (let i = 0; i < turns; i++) await h.turn({ tag: true });

  assert.ok(turns > 2, "the fixture must cover more than one turn");
  assert.equal(
    h.advisories().length,
    1,
    `${turns} tagged turns inside a ${CONTEXT_LIFECYCLE_ADVISORY_REPEAT_TURNS}-turn window must carry one advisory, got ${h.advisories().length}`,
  );

  // Cross the window boundary: the turn that clears it may repeat the advisory.
  for (let i = turns; i < CONTEXT_LIFECYCLE_ADVISORY_REPEAT_TURNS; i++) await h.turn({ tag: true });
  await h.turn({ tag: true });
  assert.equal(h.advisories().length, 2, "the turn that clears the window repeats the advisory");
});

test("at the act arm the same harness delivers an advisory on consecutive turns", async () => {
  const h = makeHarness({ tokens: AT_ACT });
  await h.turn({ tag: true });
  await h.turn({ tag: true });
  assert.equal(
    h.advisories().length,
    2,
    "pacing is off at the arm: the control that case 3's one advisory is pacing, not the lane",
  );
});
