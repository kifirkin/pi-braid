/**
 * One whisper envelope per tick: the context-lifecycle proposal channel.
 *
 * WHY THIS EXISTS:
 *   A measured session shows the defect as pairs of envelopes milliseconds
 *   apart: "Context at ~357K tokens. Consider compacting old tool results"
 *   beside "Context grew past 357K tokens. Tag your position..." (10 ms), and
 *   "Dense decision-making detected (28 high-stakes actions)" beside
 *   "7 near-duplicate messages" (10 ms). Every member of every pair is a
 *   `context-lifecycle:proposal` custom_message, so both come from ONE queue
 *   (`queueProposal`) called once per evaluated policy: the token ladder and
 *   the density signals raise their proposals in the same tick, and the tick
 *   delivered one envelope per policy. The agent reads two events where the
 *   system observed one situation.
 *
 * WHAT THIS PINS (the compiled extension, its real handlers):
 *   1. a tick that raises two proposals emits exactly ONE envelope, naming both
 *      actions and both figures;
 *   2. a one-proposal tick keeps the pre-merge bytes exactly;
 *   3. past the body budget the lead stays whole and the tail is named by its
 *      action without its figure - nothing is dropped;
 *   4. a class suppressed before delivery never enters the merged body;
 *   5. a tick that admits one class prints the single-clause body.
 *
 * HOW THIS DRIVES THE RUNTIME: the real extension factory over a fake pi/ctx,
 * one `before_agent_start` per tick, with the window pinned to 1M so the token
 * ladder is the only shipped thing firing (soft 0.18W, advisory 0.30W, warning
 * 0.45W). A count between advisory and warning raises exactly the two proposals
 * of case 1; between soft and advisory, exactly one. Case 3 replaces the policy
 * catalog in extension state with two long propose policies, so the budget is
 * exercised as data rather than by inflating a shipped message.
 *
 * Run: node test/runtime/lib/test-context-lifecycle-tick-merge.mjs
 * (built first: npm run build)
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Redirect HOME before any dist module resolves a path: the effective window is
// read from <homedir()>/.pi/agent/settings.json at call time, and the log/state
// writers go under BRAID_HOME.
const W = 1_000_000;
const FAKE_HOME = mkdtempSync(join(tmpdir(), "lifecycle-tick-merge-"));
const FAKE_BRAID = mkdtempSync(join(tmpdir(), "lifecycle-tick-merge-braid-"));
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
const { clearAllBuckets } = await load("lib/utils/injection-tracker.js");
const { _resetForTests } = await load("lib/enforcement/turn-dedup.js");
const { clearExtensionState } = await load("lib/state/extension-state.js");
const { _getState } = await load("extensions/memory/context-lifecycle/state.js");
const { proposalKeyFor } = await load("extensions/memory/context-lifecycle/helpers.js");
const { default: contextLifecycleExtension } = await load(
  "extensions/memory/context-lifecycle/index.js",
);
const { formatTokensK, tokenArms } = await load("lib/detection/context-usage.js");

const ARMS = tokenArms(W);
/** Above soft, below advisory: the ladder raises exactly one proposal. */
const TOKENS_ONE = Math.round((ARMS.soft + ARMS.advisory) / 2);
/** Above advisory, below warning: the ladder raises exactly two. */
const TOKENS_TWO = Math.round((ARMS.advisory + ARMS.warning) / 2);
/** Above the act-arm gate floor, below soft: only a replaced catalog fires. */
const TOKENS_CATALOG = Math.round((ARMS.act + ARMS.soft) / 2);

const ENVELOPE = /\[braid-whisper - context-lifecycle @ [0-9]{2}:[0-9]{2} [A-Z]{3}\]/g;
const END_MARKER = "[braid-whisper-end]";

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

let seq = 0;

/**
 * One lifecycle session: the real extension over a fake pi/ctx. `tick()` is one
 * `before_agent_start`, which is what the loop boundary emits per turn.
 */
function makeHarness({ tokens }) {
  const entries = [];
  const sent = [];
  const handlers = new Map();
  const tools = new Map();
  const sessionId = `lifecycle-tick-merge-${seq++}-${Date.now()}`;

  const pi = {
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(tool) {
      tools.set(tool.name, tool);
    },
    sendMessage(params, options) {
      sent.push({ text: (params?.content ?? []).map((part) => part?.text ?? "").join("\n"), options });
    },
    sendUserMessage() {},
    appendEntry() {},
    setLabel() {},
    getAllTools() {
      return [];
    },
    getActiveTools() {
      return [];
    },
    setActiveTools() {},
  };

  const ctx = {
    cwd: "/tmp/lifecycle-tick-merge-fixture",
    sessionManager: {
      getSessionFile: () => `fake-${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getEntries: () => entries.slice(),
      getBranch: () => [],
      getLeafId: () => "leaf-1",
      getLabel: () => undefined,
      appendCustomMessageEntry: (type, content, persistent, meta) => {
        const id = `e${entries.length}`;
        entries.push({ id, type: "custom_message", customType: type, content, persistent, details: meta });
        return id;
      },
    },
    getContextUsage: () => ({ percent: (tokens / W) * 100, tokens, contextWindow: W }),
    compact() {},
  };

  contextLifecycleExtension(pi);

  const harness = {
    sent,
    entries,
    ctx,
    state: () => _getState(ctx),
    async tick() {
      for (const handler of handlers.get("before_agent_start") ?? []) {
        await handler({ prompt: "lifecycle tick merge fixture" }, ctx);
      }
    },
    /** Run a registered tool by name, as the agent would. */
    async callTool(name, params) {
      const tool = tools.get(name);
      assert.ok(tool, `${name} must be registered`);
      return tool.execute(`call-${name}`, params, undefined, undefined, ctx);
    },
    /** Drop the policy cooldowns so the GATE/DEDUPE, not a cooldown, decides. */
    rearm(...policyIds) {
      const cooldowns = harness.state().policyEngine.cooldowns;
      if (policyIds.length === 0) cooldowns.clear();
      else for (const id of policyIds) cooldowns.delete(id);
    },
    /** The delivered proposal entries (the only channel this fixture asserts). */
    proposals() {
      return entries.filter((e) => e.customType === "context-lifecycle:proposal");
    },
  };

  // Session start clears injection tracking; nothing else in the fixture does.
  clearAllBuckets();
  _resetForTests();
  clearExtensionState(ctx, "context-lifecycle");
  return harness;
}

/** The shipped soft-arm body for a token count, rendered by the policy itself. */
const softBody = (tokens) =>
  `Context at ~${formatTokensK(tokens)} tokens. Consider compacting old tool results (context_compress action='compact').`;
/** The shipped advisory-arm body for a token count. */
const advisoryBody = (tokens) =>
  `Context grew past ${formatTokensK(tokens)} tokens. Tag your position with context_navigate(action="tag"), then consider context_compress(action="archive") or context_navigate(action="checkout") to branch.`;

test("a tick that raises two proposals leaves as one envelope, both actions and figures named", async () => {
  const h = makeHarness({ tokens: TOKENS_TWO });
  await h.tick();

  const proposals = h.proposals();
  assert.equal(proposals.length, 1, `one tick, one proposal entry: ${JSON.stringify(proposals)}`);

  const content = proposals[0].content;
  assert.equal(typeof content, "string", "the proposal is stored as text, so an export renders it");
  assert.equal(countOf(content, "[braid-whisper - context-lifecycle"), 1, "exactly one envelope");
  assert.equal(countOf(content, END_MARKER), 1, "exactly one end-marker");

  // Both clauses, each with its own figure: the soft arm's "at ~<K>" and the
  // advisory arm's "past <K>". Neither would be missing from a two-envelope
  // delivery; both must survive the merge.
  assert.ok(content.includes(softBody(TOKENS_TWO)), "the higher-priority body is delivered whole");
  assert.ok(content.includes(advisoryBody(TOKENS_TWO)), "the second body survives as a clause");
  for (const action of ["context_compress", 'context_navigate(action="tag")']) {
    assert.ok(content.includes(action), `the merged body names ${action}`);
  }

  const details = proposals[0].details;
  assert.equal(details.policy_id, "tokens-soft", "the highest-priority policy leads the body");
  assert.deepEqual(
    (details.merged_proposals ?? []).map((p) => p.policy_id),
    ["tokens-advisory"],
    "the entry records the proposals it carries, so the second class is not lost from the record",
  );
  assert.equal(
    h.state().proposalKeys.size,
    2,
    "both delivered classes are in the dedupe map, not only the lead",
  );
});

test("a one-proposal tick keeps the pre-merge bytes exactly", async () => {
  const h = makeHarness({ tokens: TOKENS_ONE });
  await h.tick();

  const proposals = h.proposals();
  assert.equal(proposals.length, 1, "one proposal, one entry");
  const content = proposals[0].content;
  assert.equal(
    content.replace(ENVELOPE, "ENV"),
    `ENV\nContext Suggestion: ${softBody(TOKENS_ONE)}\n${END_MARKER}`,
    "a single proposal renders exactly as it did before the merge",
  );
  assert.equal(proposals[0].details.merged_proposals, undefined, "a single proposal has no siblings");
});

test("past the budget the lead stays whole and the tail is named by action only", async () => {
  const h = makeHarness({ tokens: TOKENS_CATALOG });
  const leadFigure = 111_111;
  const tailFigure = 222_222;
  const leadMessage = `${"Detailed lead observation. ".repeat(12)}(${leadFigure} actions).`;
  const tailMessage = `${"Detailed tail observation. ".repeat(12)}(${tailFigure} actions).`;
  const policy = (id, priority, message, action) => ({
    id,
    name: id,
    priority,
    cooldown_ms: 0,
    trigger: { type: "context_usage_tokens", threshold: ARMS.act },
    action: { type: "propose", message, priority: "medium" },
    suggested_action: action,
  });
  h.state().policyEngine.policies = [
    policy("budget-lead", 90, leadMessage, "context_compress"),
    policy("budget-tail", 80, tailMessage, "context_navigate"),
  ];
  h.rearm();
  await h.tick();

  const proposals = h.proposals();
  assert.equal(proposals.length, 1, `both over-budget proposals leave as one entry`);
  const content = proposals[0].content;
  assert.equal(countOf(content, "[braid-whisper - context-lifecycle"), 1, "one envelope");
  assert.ok(content.includes(leadMessage), "the lead is delivered whole, figure included");
  assert.ok(String(content).includes(String(leadFigure)), "the lead keeps its figure");
  assert.ok(
    content.includes("action only: context_navigate"),
    "the tail that cannot fit names the action it would have demanded",
  );
  assert.ok(
    !content.includes(tailMessage) && !content.includes(String(tailFigure)),
    "the tail's clause is dropped for length, not its proposal",
  );
  assert.deepEqual(
    (proposals[0].details.merged_proposals ?? []).map((p) => p.message),
    [tailMessage],
    "the tail is still in the record: it lost its detail, never itself",
  );
});

test("a class suppressed before delivery never enters the merged body", async () => {
  const h = makeHarness({ tokens: TOKENS_TWO });
  await h.tick();
  assert.equal(h.proposals().length, 1, "the first tick delivers both classes as one envelope");

  h.rearm(); // the policies re-evaluate; dedupe decides
  await h.tick();

  const proposals = h.proposals();
  assert.equal(
    proposals.length,
    1,
    `a tick whose classes are all suppressed adds no envelope: ${JSON.stringify(proposals.map((p) => p.content))}`,
  );
  assert.equal(countOf(proposals[0].content, "[braid-whisper - context-lifecycle"), 1);
});

test("a tick that admits one class prints the single-clause body", async () => {
  const h = makeHarness({ tokens: TOKENS_TWO });
  await h.tick();
  assert.equal(h.proposals().length, 1, "the first tick merges both classes");

  // Mark the merged body handled (a pending entry of the same class blocks a
  // re-delivery on its own), clear only the soft class, and leave the advisory
  // class hot: the next tick admits exactly one proposal.
  h.entries[0].details.resolution = "action_taken";
  h.state().proposalKeys.delete(proposalKeyFor(softBody(TOKENS_TWO), "context_compress"));
  h.rearm();
  await h.tick();

  const proposals = h.proposals();
  assert.equal(proposals.length, 2, "the admitted class leaves as its own entry");
  const content = proposals[1].content;
  assert.equal(
    content.replace(ENVELOPE, "ENV"),
    `ENV\nContext Suggestion: ${softBody(TOKENS_TWO)}\n${END_MARKER}`,
    "a one-class tick renders the single-clause body, not a one-item list",
  );
  assert.ok(!content.includes("grew past"), "the suppressed class is nowhere in the body");
  assert.equal(proposals[1].details.merged_proposals, undefined, "a single admit has no siblings");
});

test("rejecting a merged proposal declines every class it named", async () => {
  const h = makeHarness({ tokens: TOKENS_TWO });
  await h.tick();

  const lead = h.proposals()[0].details;
  assert.equal(h.state().declinedKeys.size, 0, "nothing is declined before the rejection");

  const result = await h.callTool("context_proposals", { action: "reject", id: lead.id });
  assert.ok(
    String(result.content?.[0]?.text ?? "").includes("Rejected"),
    "the proposals tool resolves the merged entry",
  );

  assert.equal(
    h.state().declinedKeys.size,
    2,
    "both classes the merged body named are declined, not only the lead",
  );
  assert.deepEqual(
    (lead.merged_proposals ?? []).map((p) => p.resolution),
    ["rejected"],
    "a sibling closes with the body it rode in instead of ageing into an implicit approval",
  );
});
