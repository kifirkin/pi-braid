/**
 * Regression test: durable-write gate — review-before-write quality gate on
 * the durable episode writers.
 *
 * The original pilot covered the heartbeat session_outcome sender (writer of
 * 89% sentinel junk). The gate now carries per-site policies for every
 * episode writer, exposed via settings.json (`braid.memory.writeGate`):
 *
 *   L0  placeholder/short task                      -> reject (all sites)
 *   L1  dead solution field:
 *         heartbeat                                  -> reject (both-fields rule)
 *         every other site                           -> repair from the tool
 *                                                       sequence (>= 3 tools,
 *                                                       solution := what ran);
 *                                                       no evidence -> reject
 *   L2  exact pair, or task-token Jaccard >= 0.85 against the last 20
 *       same-project episodes                        -> skip-dup (explicit
 *                                                       sites report the id)
 *
 * Behaviors pinned here:
 *   A. hasSignal rejects the metrics-only sentinel forms and short content.
 *   B. Junk outcome -> NOT written (gate before addEpisode).
 *   C. Signal-bearing outcome -> written (heartbeat writer contract).
 *   D. Toggle OFF -> PRIOR behavior: literal sentinel kill only.
 *   E. Heartbeat cooldown works.
 *   F. Settings resolver defaults + partial merge.
 *   G. isWriteWorthy is the hasSignal pair check.
 *   H. Per-site decision table: L0 reject, L1 repair/heartbeat-reject/evidence
 *      accept, repair keeps the write (store gains a self-contained record).
 *   I. L2 dedupe: exact match, near match (Jaccard), window/project scoping,
 *      and no match below the threshold (false-positive guard).
 *   J. applyWriteGate: enforce vs warn (log-and-write) vs per-site opt-out vs
 *      toggle OFF; resolver mode/sites merge.
 *   K. Writer handlers: episodes_add reject-with-reason and duplicate-id
 *      response; memory_store episodic twin repair/duplicate note with the
 *      semantic write never lost.
 *
 * Hermetic: HOME is redirected to a temp dir before the dist imports, so the
 * live settings.json cannot change the gate defaults this suite pins.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "write-gate-test-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), "{}\n");

const {
  hasSignal,
  isWriteWorthy,
  shouldWriteOutcomeEpisode,
  decideWrite,
  applyWriteGate,
  isGateActive,
  findDuplicateEpisode,
  selectRecentEpisodes,
  MEMORY_WRITE_GATE_DEFAULTS,
  WRITE_GATE_SITES,
  NEAR_DUPLICATE_JACCARD,
  REASONING_SUMMARY_MIN_CHARS,
} = await import("../../../dist/lib/memory/write-quality.js");
const { resolveMemoryWriteGateConfig, getMemoryWriteGateConfig } =
  await import("../../../dist/lib/config/braid-settings.js");
const { createMemoryStoresState, addEpisode } =
  await import("../../../dist/extensions/memory/three-memory-stores/index.js");
const { getExtensionState } = await import("../../../dist/lib/state/extension-state.js");
const { createMemoryTool } =
  await import("../../../dist/extensions/memory/memory-agent-bridge/memory-tool.js");
const { createMemoryStoreTool } =
  await import("../../../dist/extensions/memory/memory-agent-bridge/memory-store-tool.js");

console.log("=== durable-write gate — episode writers ===\n");

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
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

const JUNK_TASK = "session_outcome";
const JUNK_SOLUTION = "Complete task: session_outcome";
const SIGNAL_TASK = "Built complete Chinese tea sourcing system with supplier scoring";
const SIGNAL_SOLUTION = "implement supplier ranking api with region filtering and clearance checks";
// A generic short task: has a task string but carries no signal (< 15 chars).
const GENERIC_TASK = "ok";
const GENERIC_SOLUTION = "done";

// Dead solution template written by the finalize path, and a long but still
// signal-free reasoning summary (sentinel prefix, over the site floor).
const DEAD_SOLUTION = "Outcome: success";
const LONG_SENTINEL_SUMMARY = "outcome: " + "metric ".repeat(8);

// Near-duplicate task pair (same tokens, different order/punctuation) and an
// unrelated task for the below-threshold guard.
const TASK_NEAR_A = "Implemented durable write gate predicate for episode writers";
const TASK_NEAR_B = "Predicate for episode writers: implemented durable write gate";
const TASK_OTHER = "Reworked the agent-zero provider cost table for tier pricing";

// The default gate config exercised by the heartbeat sender.
const DEFAULT_CFG = {
  enabled: true,
  cooldownMs: MEMORY_WRITE_GATE_DEFAULTS.cooldownMs,
  mode: MEMORY_WRITE_GATE_DEFAULTS.mode,
  sites: {},
};

// Realistic epoch-millis base so a first write (lastWriteAt=0) is always past
// the cooldown window — matching production where Date.now() is ~1.7e12.
const T0 = 1_700_000_000_000;

// ── A. Shared suppressor (hasSignal) ──────────────────────────────────────────
test("hasSignal rejects metrics-only sentinel forms and short content", () => {
  assert.equal(hasSignal("session_outcome"), false, "bare sentinel rejected");
  assert.equal(hasSignal("session_outcome: success"), false, "colon sentinel rejected");
  assert.equal(hasSignal("[ok] session_outcome"), false, "bracketed-tag sentinel rejected");
  assert.equal(hasSignal("[ok] outcome: some metric"), false, "outcome colon form rejected");
  assert.equal(hasSignal("short"), false, "content under 15 chars rejected");
  assert.equal(hasSignal("   "), false, "whitespace rejected");
});

test("hasSignal accepts substantive content", () => {
  assert.equal(hasSignal(SIGNAL_TASK), true);
  assert.equal(hasSignal(SIGNAL_SOLUTION), true);
  assert.equal(hasSignal(`${JUNK_TASK}: ${JUNK_SOLUTION}`), false, "junk pair still rejected");
});

// ── B. Junk outcome → NOT written ────────────────────────────────────────────
test("junk outcome is not written (writer contract: gate before addEpisode)", () => {
  const state = createMemoryStoresState();
  let lastWriteAt = 0;
  const write = shouldWriteOutcomeEpisode(DEFAULT_CFG, JUNK_TASK, JUNK_SOLUTION, lastWriteAt, T0);
  assert.equal(write, false, "gate rejects the sentinel write");
  if (write) {
    addEpisode(state, JUNK_TASK, JUNK_SOLUTION, "success", [], ["session", "outcome"]);
  }
  assert.equal(state.episodes.length, 0, "store must be unchanged after a junk outcome");
});

test("short generic task is not written when gate is ON", () => {
  const write = shouldWriteOutcomeEpisode(DEFAULT_CFG, GENERIC_TASK, GENERIC_SOLUTION, 0, T0);
  assert.equal(write, false, "gate rejects < 15-char generic task");
});

// ── C. Signal-bearing outcome → written ──────────────────────────────────────
test("signal-bearing outcome is written (writer contract)", () => {
  const state = createMemoryStoresState();
  let lastWriteAt = 0;
  const write = shouldWriteOutcomeEpisode(
    DEFAULT_CFG,
    SIGNAL_TASK,
    SIGNAL_SOLUTION,
    lastWriteAt,
    T0,
  );
  assert.equal(write, true, "gate accepts a substantive task+solution");
  if (write) {
    addEpisode(
      state,
      SIGNAL_TASK,
      SIGNAL_SOLUTION,
      "success",
      ["read", "write"],
      ["session", "outcome"],
      "agents/pi-braid",
    );
  }
  assert.equal(state.episodes.length, 1, "store must gain the substantive episode");
  assert.equal(state.episodes[0].task, SIGNAL_TASK);
});

// ── D. Toggle OFF → prior behavior unchanged ─────────────────────────────────
test("toggle OFF: prior behavior — literal sentinel kill only ('ok' generic still written)", () => {
  const off = { enabled: false, cooldownMs: MEMORY_WRITE_GATE_DEFAULTS.cooldownMs };
  // A generic short task that the ON gate would reject is still written pre-M2.
  assert.equal(
    shouldWriteOutcomeEpisode(off, GENERIC_TASK, GENERIC_SOLUTION, 0, T0),
    true,
    "disabled gate must not reject a generic task",
  );
  // The literal sentinel kill is preserved.
  assert.equal(
    shouldWriteOutcomeEpisode(off, JUNK_TASK, JUNK_SOLUTION, 0, T0),
    false,
    "disabled gate still kills the literal 'session_outcome' sentinel",
  );
  // And the cooldown is NOT applied when disabled (prior behavior wrote freely).
  assert.equal(
    shouldWriteOutcomeEpisode(off, SIGNAL_TASK, SIGNAL_SOLUTION, 0, T0),
    true,
    "disabled gate is not subject to the cooldown",
  );
});

// ── E. Cooldown ──────────────────────────────────────────────────────────────
test("cooldown suppresses a second write within cooldownMs, resumes after", () => {
  const cooldownMs = 60_000;
  const cfg = { enabled: true, cooldownMs };
  let lastWriteAt = 0;
  const now0 = T0;

  // First gated write succeeds and stamps lastWriteAt (caller's job).
  assert.equal(
    shouldWriteOutcomeEpisode(cfg, SIGNAL_TASK, SIGNAL_SOLUTION, lastWriteAt, now0),
    true,
  );
  lastWriteAt = now0;

  // A second signal-bearing write inside the window is suppressed (never thrashes).
  const nowMid = now0 + cooldownMs - 1;
  assert.equal(
    shouldWriteOutcomeEpisode(cfg, SIGNAL_TASK, SIGNAL_SOLUTION, lastWriteAt, nowMid),
    false,
    "write inside cooldown window must be suppressed",
  );

  // Exactly at cooldownMs the write is allowed again.
  const nowBoundary = now0 + cooldownMs;
  assert.equal(
    shouldWriteOutcomeEpisode(cfg, SIGNAL_TASK, SIGNAL_SOLUTION, lastWriteAt, nowBoundary),
    true,
    "write at cooldown boundary must be allowed",
  );
});

// ── F. Settings resolver defaults (no live settings.json coupling) ───────────
test("settings resolver: absent/invalid block → defaults (enabled, enforce, all sites)", () => {
  const d = resolveMemoryWriteGateConfig(undefined);
  assert.deepEqual(
    d,
    { enabled: true, cooldownMs: 1_200_000, mode: "enforce", sites: {} },
    "MEMORY_WRITE_GATE_DEFAULTS",
  );
  assert.equal(
    MEMORY_WRITE_GATE_DEFAULTS.enabled,
    true,
    "default gate must be ON (no-write for junk)",
  );
  assert.equal(MEMORY_WRITE_GATE_DEFAULTS.cooldownMs, 20 * 60 * 1000, "20-min cooldown precedent");
  assert.equal(MEMORY_WRITE_GATE_DEFAULTS.mode, "enforce", "default mode enforces decisions");
});

test("settings resolver: partial/invalid fields merge onto defaults", () => {
  assert.deepEqual(resolveMemoryWriteGateConfig({ enabled: false }), {
    enabled: false,
    cooldownMs: 1_200_000,
    mode: "enforce",
    sites: {},
  });
  assert.deepEqual(resolveMemoryWriteGateConfig({ cooldownMs: 30_000 }), {
    enabled: true,
    cooldownMs: 30_000,
    mode: "enforce",
    sites: {},
  });
  assert.deepEqual(
    resolveMemoryWriteGateConfig({
      enabled: "yes",
      cooldownMs: -5,
      mode: "loud",
      sites: { finalize: false, heartbeat: true, bogus: true, mars: "yes" },
    }),
    {
      enabled: true,
      cooldownMs: 1_200_000,
      mode: "enforce",
      sites: { finalize: false, heartbeat: true },
    },
    "invalid types fall back; unknown/non-boolean sites are dropped",
  );
});

test("settings resolver reads the settings file through the default path", () => {
  // The temp HOME has an empty settings.json; the reader must fall back to
  // the gate defaults (settings-over-env, no live-settings coupling).
  assert.deepEqual(getMemoryWriteGateConfig(), resolveMemoryWriteGateConfig(undefined));
});

// ── G. isWriteWorthy purity pin ──────────────────────────────────────────────
test("isWriteWorthy is the hasSignal pair check", () => {
  assert.equal(isWriteWorthy(JUNK_TASK, JUNK_SOLUTION), false);
  assert.equal(isWriteWorthy(JUNK_TASK, SIGNAL_SOLUTION), false, "sentinel task always junk");
  assert.equal(isWriteWorthy(SIGNAL_TASK, SIGNAL_SOLUTION), true);
});

// ── H. Decision table: L0 + L1 per-site policy ───────────────────────────────
test("L0: placeholder tasks are rejected at every site", () => {
  for (const site of WRITE_GATE_SITES) {
    const decision = decideWrite({ site, task: JUNK_TASK, solution: SIGNAL_SOLUTION });
    assert.equal(decision.action, "reject", `${site} must reject a sentinel task`);
  }
});

test("L1: dead solution repaired from the tool sequence at the repair sites", () => {
  const tools = ["read", "grep", "edit", "bash"];
  const decision = decideWrite({
    site: "finalize",
    task: SIGNAL_TASK,
    solution: DEAD_SOLUTION,
    toolSequence: tools,
  });
  assert.equal(decision.action, "repair");
  assert.equal(
    decision.solution,
    "Ran: read -> grep -> edit -> bash",
    "solution becomes what actually ran",
  );
});

test("L1: dead solution without tool evidence is rejected, never task-echoed", () => {
  const decision = decideWrite({ site: "finalize", task: SIGNAL_TASK, solution: DEAD_SOLUTION });
  assert.equal(decision.action, "reject");
  assert.match(decision.reason, /no signal and no evidence/);
});

test("L1: repair keeps the write — the store gains a self-contained episode", () => {
  const state = createMemoryStoresState();
  const gate = applyWriteGate(DEFAULT_CFG, {
    site: "finalize",
    task: SIGNAL_TASK,
    solution: DEAD_SOLUTION,
    toolSequence: ["read", "grep", "edit", "bash"],
  });
  assert.equal(gate.write, true, "repair never drops the write");
  assert.equal(gate.decision.action, "repair");
  if (gate.write) {
    addEpisode(state, SIGNAL_TASK, gate.solution, "success", [], [], "agents/pi-braid");
  }
  assert.equal(state.episodes.length, 1);
  assert.equal(state.episodes[0].task, SIGNAL_TASK);
  assert.equal(
    state.episodes[0].solution,
    "Ran: read -> grep -> edit -> bash",
    "dead solution field is never stored",
  );
});

test("L1: every repair site repairs with evidence; heartbeat keeps the both-fields reject", () => {
  const tools = ["read", "edit", "bash"];
  for (const site of ["finalize", "memoryStoreTwin", "episodesAdd"]) {
    const decision = decideWrite({
      site,
      task: SIGNAL_TASK,
      solution: DEAD_SOLUTION,
      toolSequence: tools,
    });
    assert.equal(decision.action, "repair", `${site} must repair a dead solution`);
    assert.equal(decision.solution, "Ran: read -> edit -> bash");
  }
  const heartbeat = decideWrite({
    site: "heartbeat",
    task: SIGNAL_TASK,
    solution: DEAD_SOLUTION,
  });
  assert.equal(heartbeat.action, "reject", "heartbeat keeps the existing both-fields rule");
  // Same input through the heartbeat predicate agrees (the mirror pin).
  assert.equal(shouldWriteOutcomeEpisode(DEFAULT_CFG, SIGNAL_TASK, DEAD_SOLUTION, 0, T0), false);
});

test("L1: every site repairs a dead solution from tools or rejects without evidence", () => {
  const tools = ["read", "edit", "bash"];
  assert.equal(
    decideWrite({
      site: "mars",
      task: SIGNAL_TASK,
      solution: DEAD_SOLUTION,
      toolSequence: tools,
    }).action,
    "repair",
    "tool evidence repopulates the field instead of storing the dead template",
  );
  assert.equal(
    decideWrite({ site: "mars", task: SIGNAL_TASK, solution: DEAD_SOLUTION }).action,
    "reject",
    "no evidence and a dead solution is not storable",
  );
});

test("L1: reasoning summaries below the site floor are rejected", () => {
  const decision = decideWrite({
    site: "reasoningChains",
    task: SIGNAL_TASK,
    solution: "too short",
    toolSequence: ["read", "edit", "bash"],
  });
  assert.equal(decision.action, "reject", `floor is ${REASONING_SUMMARY_MIN_CHARS} chars`);
});

test("per-site policy table (dead solution)", () => {
  const tools = ["read", "edit", "bash"];
  const cases = [
    { site: "finalize", solution: DEAD_SOLUTION, toolSequence: tools, expected: "repair" },
    { site: "memoryStoreTwin", solution: DEAD_SOLUTION, toolSequence: tools, expected: "repair" },
    { site: "episodesAdd", solution: DEAD_SOLUTION, toolSequence: tools, expected: "repair" },
    { site: "finalize", solution: DEAD_SOLUTION, expected: "reject" },
    { site: "heartbeat", solution: DEAD_SOLUTION, toolSequence: tools, expected: "reject" },
    { site: "mars", solution: DEAD_SOLUTION, expected: "reject" },
    { site: "mars", solution: DEAD_SOLUTION, toolSequence: tools, expected: "repair" },
    { site: "reasoningChains", solution: "short", expected: "reject" },
    {
      site: "reasoningChains",
      solution: LONG_SENTINEL_SUMMARY,
      toolSequence: tools,
      expected: "repair",
    },
  ];
  for (const c of cases) {
    const decision = decideWrite({
      site: c.site,
      task: SIGNAL_TASK,
      solution: c.solution,
      toolSequence: c.toolSequence,
    });
    assert.equal(decision.action, c.expected, `${c.site} + ${c.solution.slice(0, 20)}`);
  }
});

// ── I. L2 dedupe ─────────────────────────────────────────────────────────────
test("L2: exact (task, solution) pair is a duplicate", () => {
  const recent = [{ id: "ep_exact", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION }];
  const decision = decideWrite({
    site: "finalize",
    task: SIGNAL_TASK,
    solution: SIGNAL_SOLUTION,
    recent,
  });
  assert.equal(decision.action, "skip-dup");
  assert.equal(decision.match, "exact");
  assert.equal(decision.existingId, "ep_exact");
});

test("L2: a repaired finalize repeat matches the earlier repaired episode", () => {
  // First write through the gate stores (task, repaired-from-tools); the
  // second finalize with the same summary and the same tools must dedupe
  // against it even though its raw candidate was the dead template.
  const state = createMemoryStoresState();
  const gateInput = {
    site: "finalize",
    task: SIGNAL_TASK,
    solution: DEAD_SOLUTION,
    toolSequence: ["read", "edit", "bash"],
  };
  const first = applyWriteGate(DEFAULT_CFG, gateInput);
  assert.equal(first.write, true);
  if (first.write)
    addEpisode(state, SIGNAL_TASK, first.solution, "success", [], [], "agents/pi-braid");

  const recent = selectRecentEpisodes(state.episodes, "agents/pi-braid");
  const second = applyWriteGate(DEFAULT_CFG, { ...gateInput, recent });
  assert.equal(second.write, false, "duplicate finalize summary is not written twice");
  assert.equal(second.decision.action, "skip-dup");
  assert.equal(state.episodes.length, 1);
});

test("L2: near-duplicate tasks (token Jaccard >= 0.85) are duplicates", () => {
  const decision = decideWrite({
    site: "mars",
    task: TASK_NEAR_A,
    solution: SIGNAL_SOLUTION,
    recent: [{ id: "ep_near", task: TASK_NEAR_B, solution: "other" }],
  });
  assert.equal(decision.action, "skip-dup");
  assert.equal(decision.match, "near");
  assert.equal(decision.existingId, "ep_near");
  assert.ok(
    decision.similarity >= NEAR_DUPLICATE_JACCARD,
    `similarity ${decision.similarity} >= ${NEAR_DUPLICATE_JACCARD}`,
  );
});

test("L2: unrelated tasks are not duplicates (below-threshold guard)", () => {
  const decision = decideWrite({
    site: "mars",
    task: TASK_NEAR_A,
    solution: SIGNAL_SOLUTION,
    recent: [{ id: "ep_other", task: TASK_OTHER, solution: SIGNAL_SOLUTION }],
  });
  assert.equal(decision.action, "accept");
  const found = findDuplicateEpisode(
    [{ id: "ep_other", task: TASK_OTHER, solution: SIGNAL_SOLUTION }],
    TASK_NEAR_A,
    SIGNAL_SOLUTION,
  );
  assert.equal(found, null);
});

test("L2: dedupe window is bounded to the last 20 same-project episodes", () => {
  const episodes = [];
  for (let i = 0; i < 24; i++) {
    episodes.push({
      id: `ep_filler_${i}`,
      task: `task number ${i} with distinct content`,
      solution: "s",
      project: "p",
    });
  }
  // Duplicate pair sits first, so it falls out of the last-20 window.
  episodes.unshift({
    id: "ep_old_dup",
    task: SIGNAL_TASK,
    solution: SIGNAL_SOLUTION,
    project: "p",
  });
  // Same task, different project: not in the window for project "p" either way.
  episodes.push({
    id: "ep_other_project",
    task: SIGNAL_TASK,
    solution: SIGNAL_SOLUTION,
    project: "q",
  });

  const window = selectRecentEpisodes(episodes, "p");
  assert.equal(window.length, 20, "window caps at 20");
  assert.equal(
    window.some((e) => e.id === "ep_old_dup"),
    false,
    "the old duplicate fell out of the window",
  );
  const decision = decideWrite({
    site: "mars",
    task: SIGNAL_TASK,
    solution: SIGNAL_SOLUTION,
    recent: window,
  });
  assert.equal(decision.action, "accept", "outside the window it is not a duplicate");

  // With the full set (small stores) the duplicate is still detected.
  const full = selectRecentEpisodes(episodes, "p", 100);
  assert.equal(
    decideWrite({ site: "mars", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION, recent: full })
      .action,
    "skip-dup",
  );
  // Episodes without a project count as "unknown"; project "p" never sees them.
  const unknown = selectRecentEpisodes(
    [{ id: "ep_unknown", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION }],
    "p",
  );
  assert.equal(unknown.length, 0);
});

// ── J. applyWriteGate: enforce / warn / opt-out / toggle OFF ─────────────────
test("applyWriteGate enforce: reject and skip-dup suppress the write", () => {
  const rejected = applyWriteGate(DEFAULT_CFG, {
    site: "finalize",
    task: JUNK_TASK,
    solution: SIGNAL_SOLUTION,
  });
  assert.equal(rejected.write, false);
  assert.equal(rejected.decision.action, "reject");

  const duplicate = applyWriteGate(DEFAULT_CFG, {
    site: "episodesAdd",
    task: SIGNAL_TASK,
    solution: SIGNAL_SOLUTION,
    recent: [{ id: "ep_dup", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION }],
  });
  assert.equal(duplicate.write, false);
  assert.equal(duplicate.decision.existingId, "ep_dup", "explicit sites can report the id");
});

test("mode warn: decisions are logged-and-written, original fields untouched", () => {
  const warn = { ...DEFAULT_CFG, mode: "warn" };
  const rejected = applyWriteGate(warn, {
    site: "finalize",
    task: JUNK_TASK,
    solution: DEAD_SOLUTION,
  });
  assert.equal(rejected.write, true, "warn writes anyway");
  assert.equal(rejected.decision.action, "reject", "the decision is still computed for logging");
  assert.equal(rejected.solution, DEAD_SOLUTION, "warn does not rewrite the field");

  const duplicate = applyWriteGate(warn, {
    site: "episodesAdd",
    task: SIGNAL_TASK,
    solution: SIGNAL_SOLUTION,
    recent: [{ id: "ep_dup", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION }],
  });
  assert.equal(duplicate.write, true, "warn writes duplicate candidates too");
  assert.equal(duplicate.decision.action, "skip-dup");
});

test("sites opt-out: pre-gate behavior for that writer only", () => {
  const cfg = { ...DEFAULT_CFG, sites: { finalize: false } };
  assert.equal(isGateActive(cfg, "finalize"), false);
  assert.equal(isGateActive(cfg, "mars"), true);

  const optOut = applyWriteGate(cfg, {
    site: "finalize",
    task: JUNK_TASK,
    solution: DEAD_SOLUTION,
  });
  assert.equal(optOut.write, true, "opted-out writer keeps writing");
  assert.equal(optOut.solution, DEAD_SOLUTION, "original field values are restored");

  // Heartbeat opt-out restores its pre-gate semantics: sentinel kill only,
  // no cooldown (tested through the heartbeat predicate).
  const heartbeatOff = { ...DEFAULT_CFG, sites: { heartbeat: false } };
  assert.equal(
    shouldWriteOutcomeEpisode(heartbeatOff, GENERIC_TASK, GENERIC_SOLUTION, T0, T0),
    true,
    "no quality/cooldown gate when opted out",
  );
  assert.equal(
    shouldWriteOutcomeEpisode(heartbeatOff, JUNK_TASK, JUNK_SOLUTION, 0, T0),
    false,
    "literal sentinel kill survives the opt-out",
  );
});

test("toggle OFF: applyWriteGate writes original fields at every site", () => {
  const off = { ...DEFAULT_CFG, enabled: false };
  for (const site of WRITE_GATE_SITES) {
    const outcome = applyWriteGate(off, { site, task: JUNK_TASK, solution: DEAD_SOLUTION });
    assert.equal(outcome.write, true, `${site} must write when the gate is off`);
    assert.equal(outcome.solution, DEAD_SOLUTION);
    assert.equal(outcome.decision.action, "accept");
  }
});

// ── K. Writer handlers ───────────────────────────────────────────────────────
await testAsync(
  "episodes_add: substantive pair stored, duplicate id reported, reject-with-reason",
  async () => {
    const memoryTool = createMemoryTool({}, null, () => {});
    const ctx = { cwd: "/tmp/projects/agents/pi-braid" };

    const first = await memoryTool.execute(
      "t1",
      { action: "episodes_add", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION, outcome: "partial" },
      null,
      null,
      ctx,
    );
    assert.match(first.content[0].text, /Episode added/, "substantive pair is stored");

    const duplicate = await memoryTool.execute(
      "t2",
      { action: "episodes_add", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION, outcome: "partial" },
      null,
      null,
      ctx,
    );
    assert.match(
      duplicate.content[0].text,
      /Episode already stored: \[ep-[^\]]+\] \(exact match\)/,
      "explicit site reports the existing episode id",
    );

    const deadSolution = await memoryTool.execute(
      "t3",
      {
        action: "episodes_add",
        task: "Investigate the slow episode recall path in the session search",
        solution: DEAD_SOLUTION,
        outcome: "partial",
      },
      null,
      null,
      ctx,
    );
    assert.match(
      deadSolution.content[0].text,
      /Episode not stored: solution carries no signal and no evidence/,
      "a dead solution field without tool evidence is not stored",
    );

    const rejected = await memoryTool.execute(
      "t4",
      { action: "episodes_add", task: JUNK_TASK, solution: DEAD_SOLUTION, outcome: "partial" },
      null,
      null,
      ctx,
    );
    assert.match(
      rejected.content[0].text,
      /Episode not stored: task carries no signal/,
      "reject-with-reason response text",
    );

    const state = getExtensionState(ctx, "three-memory-stores", createMemoryStoresState);
    assert.equal(
      state.episodes.length,
      1,
      "duplicate, dead-solution, and rejected candidates are not stored",
    );
  },
);

await testAsync(
  "memory_store episodic twin: dedupe note, repair, and the semantic write survives",
  async () => {
    let storeCalls = 0;
    const memory = {
      store: async () => {
        storeCalls++;
        return { id: `mem_${storeCalls.toString().padStart(3, "0")}` };
      },
      getByIdSync: () => undefined,
      deleteById: () => {},
      findCrossProjectConflicts: () => [],
    };
    const tool = createMemoryStoreTool(memory, null, () => {});
    const ctx = { cwd: "/tmp/projects/agents/pi-braid" };
    const content =
      "Durable write gate: repair dead solution fields, dedupe repeats, keep explicit writes visible";

    const first = await tool.execute(
      "t1",
      { content, memoryType: "episodic", tags: ["gate"] },
      null,
      null,
      ctx,
    );
    assert.match(first.content[0].text, /Stored memory mem_001/);

    const duplicate = await tool.execute(
      "t2",
      { content, memoryType: "episodic" },
      null,
      null,
      ctx,
    );
    assert.match(
      duplicate.content[0].text,
      /Episodic twin not written: skipped duplicate of ep-/,
      "twin duplicate is reported, not silent",
    );

    const rejected = await tool.execute(
      "t3",
      { content: JUNK_TASK, memoryType: "episodic" },
      null,
      null,
      ctx,
    );
    assert.match(rejected.content[0].text, /Stored memory mem_003/);
    assert.match(
      rejected.content[0].text,
      /Episodic twin not written: rejected/,
      "twin rejection is reported while the semantic write lands",
    );
    assert.equal(storeCalls, 3, "every semantic write happened regardless of twin gating");

    const state = getExtensionState(ctx, "three-memory-stores", createMemoryStoresState);
    assert.equal(state.episodes.length, 1, "only the first twin reached the episode store");
  },
);

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== durable-write gate tests passed ===");
