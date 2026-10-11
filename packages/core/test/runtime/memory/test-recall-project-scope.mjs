/**
 * Regression test: THREE-MEMORY-STORE RECALL FIX — project-scope isolation
 * across the recall pipeline.
 *
 * Documented root cause (refined during the deep-research pass):
 *   1. retrieveByRUMS only applied a soft, UNLABELED cross-project escape
 *      (`score > 0.6`, no penalty) and only when projectScope was EXPLICITLY
 *      "current". The memory-tool recall_search default (projectScope
 *      undefined) therefore ran RUMS with NO project filtering, and
 *      cross-project episodes ranked into results as if they were
 *      current-project memory (observed: a Stripe-payments episode from
 *      another project surfaced at similarity 0.95).
 *   2. `_crossProject` was never set anywhere — cross-project survivors were
 *      indistinguishable from current-project memory.
 *   3. Semantic side: memory.recall got the RAW cwd as currentProject while
 *      memories store the DERIVED id (deriveProjectIdFromCwd, last 2 path
 *      segments), so `projectId !== currentProject` was true for every tagged
 *      memory — the current project's own semantic memories were silently
 *      excluded from default recall_search.
 *   4. finalize.ts stored episodes with the raw cwd as project, making them
 *      look cross-project to every derived-id comparison.
 *
 * FIX behaviors pinned here (each assertion FAILS on the pre-fix code unless
 * noted otherwise as a compat lock):
 *   A. retrieveByRUMS(currentProject, scope="all") labels cross-project
 *      results `_crossProject: true` (pre-fix: undefined — REVERT-PROOF).
 *   B. retrieveByRUMS with scope undefined + currentProject now behaves as
 *      "current" (penalize + filter + label) instead of no-filter — every
 *      result carries a boolean `_crossProject` (pre-fix: undefined —
 *      REVERT-PROOF).
 *   C. retrieveByRUMS scope="current": same-project episode always retained
 *      and ranked above a cross-project episode with identical raw match
 *      (cross-project gets the penalty); any cross-project survivor is labeled.
 *   D. deriveProjectIdFromCwd is the shared convention and is idempotent —
 *      writers must store the derived id, not the raw cwd.
 *   E. CognitiveMemory.recall with currentProject=DERIVED id returns
 *      same-project memories and excludes cross-project ones (compat lock),
 *      and with the RAW cwd it excludes even the current project's own
 *      memories — which is exactly why recall_search must pass the derived id.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: HOME is redirected before the dist imports so the store paths
// below resolve into a throwaway tree. Without it, the persist flows in
// sections E and F append to the live braid memory files.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "recall-scope-test-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), "{}\n");

const { createMemoryStoresState, addEpisode, retrieveByRUMS } =
  await import("../../../dist/extensions/memory/three-memory-stores/index.js");
const { deriveProjectIdFromCwd } = await import("../../../dist/lib/memory/past-insights.js");
const { CognitiveMemory } = await import("../../../dist/lib/memory/index.js");

console.log("=== Recall project-scope isolation (THREE-MEMORY-STORE RECALL FIX) ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failed++;
  }
}

// Shared fixture: two episodes with IDENTICAL high-overlap text, one tagged
// to the "current" project and one to another project. Identical text means
// identical raw RUMS scores, which makes penalty/ordering deterministic.
const CURRENT = "agents/pi-braid";
const OTHER = "agents/vibe-project";
const QUERY = "zorblaxflux checkout session migration";
const EP_TASK = "migrate the zorblaxflux checkout session flow to the new gateway";
const EP_SOLUTION =
  "implement zorblaxflux migration api routes with retargeting handlers and checkpointing";

function makeState() {
  const state = createMemoryStoresState();
  state.currentSessionId = "session-project-scope-test";
  addEpisode(state, EP_TASK, EP_SOLUTION, "success", ["read", "write"], ["migration"], CURRENT);
  addEpisode(state, EP_TASK, EP_SOLUTION, "success", ["read", "write"], ["migration"], OTHER);
  return state;
}

// ── A. scope="all": cross-project labeled, same-project not (REVERT-PROOF) ──
test("scope=all labels cross-project episodes and same-project distinctly", () => {
  const state = makeState();
  const results = retrieveByRUMS(state, QUERY, 3, state.currentSessionId, CURRENT, "all");
  assert.equal(results.length, 2, `expected both episodes, got ${results.length}`);
  const cross = results.find((r) => r.project === OTHER);
  const same = results.find((r) => r.project === CURRENT);
  assert.ok(cross, "cross-project episode should be retrievable in scope=all");
  assert.ok(same, "same-project episode should be retrievable in scope=all");
  // Pre-fix code never set _crossProject: this assert fails with undefined.
  assert.equal(
    cross._crossProject,
    true,
    `cross-project survivor must be labeled _crossProject=true, got ${JSON.stringify(cross._crossProject)}`,
  );
  assert.equal(same._crossProject, false, "same-project episode must not be labeled cross-project");
});

// ── B. scope undefined + currentProject: behaves as "current" (REVERT-PROOF) ──
test("default scope (undefined) with currentProject is project-scoped and boolean-labeled", () => {
  const state = makeState();
  const results = retrieveByRUMS(state, QUERY, 3, state.currentSessionId, CURRENT);
  assert.ok(results.length >= 1, "expected at least the same-project episode");
  for (const r of results) {
    // Pre-fix code left _crossProject undefined; must now be a boolean on
    // every result regardless of how it was retrieved.
    assert.ok(
      typeof r._crossProject === "boolean",
      `every result must carry a boolean _crossProject, got ${JSON.stringify(r._crossProject)} on project=${r.project}`,
    );
  }
});

// ── C. scope="current": same-project wins; cross filtered or labeled ─────────
test("scope=current keeps same-project first and labels any cross-project survivor", () => {
  const state = makeState();
  const results = retrieveByRUMS(state, QUERY, 3, state.currentSessionId, CURRENT, "current");
  assert.ok(results.length >= 1, "same-project episode must never be filtered in current scope");
  const same = results.find((r) => r.project === CURRENT);
  assert.ok(same, "same-project episode must be present in current scope");
  // The same-project episode must rank at the top: the cross-project episode
  // is penalized (CROSS_PROJECT_PENALTY) and identical raw match otherwise.
  assert.equal(
    results[0].project,
    CURRENT,
    `same-project episode must outrank cross-project under penalty, got first project=${results[0].project}`,
  );
  for (const r of results) {
    if (r.project !== CURRENT) {
      assert.equal(
        r._crossProject,
        true,
        `cross-project survivor in current scope must be labeled, got ${JSON.stringify(r._crossProject)}`,
      );
    }
  }
});

// ── D. Shared project-id convention (idempotent derivation) ─────────────────
test("deriveProjectIdFromCwd is the idempotent project convention", () => {
  const cwd = "/tmp/projects/agents/pi-braid";
  const derived = deriveProjectIdFromCwd(cwd);
  assert.equal(derived, "agents/pi-braid", `derived id must be last 2 segments, got ${derived}`);
  // Writers (finalize.ts) must store the derived id; recall compares against
  // the same derived id, so derivation must be idempotent.
  assert.equal(deriveProjectIdFromCwd(derived), derived, "derivation must be idempotent");
  assert.notEqual(derived, cwd, "derived id must differ from the raw cwd path");
});

// ── E. Semantic recall honors the derived-id convention ─────────────────────
test("CognitiveMemory.recall keeps same-project (derived id) and drops cross-project", async () => {
  const cm = new CognitiveMemory();
  const cwd = "/tmp/projects/agents/pi-braid";
  const derived = deriveProjectIdFromCwd(cwd);
  const other = "agents/unrelated-project";
  const sameContent = "zorblaxflux retargeting checkpoint alpha omega";
  const crossContent = "quintessence wraptor ledger beta gamma delta";
  await cm.store(sameContent, "semantic", { projectId: derived });
  await cm.store(crossContent, "semantic", { projectId: other });

  // Derived currentProject: same-project found, cross-project excluded.
  const scoped = await cm.recall("zorblaxflux retargeting", {
    currentProject: derived,
    projectScope: "current",
  });
  assert.ok(
    scoped.some((r) => r.memory.content.includes("zorblaxflux")),
    "same-project semantic memory must be returned with derived currentProject",
  );
  assert.ok(
    !scoped.some((r) => r.memory.content.includes("quintessence")),
    "cross-project semantic memory must be excluded with derived currentProject",
  );

  // RAW cwd (pre-fix caller behavior): the same-project memory is excluded too
  // because projectId "agents/pi-braid" !== raw path. This is the premise the
  // memory-tool fix rests on: recall_search must pass the DERIVED id.
  const rawCwd = await cm.recall("zorblaxflux retargeting", {
    currentProject: cwd,
    projectScope: "current",
  });
  assert.ok(
    !rawCwd.some((r) => r.memory.content.includes("zorblaxflux")),
    "premise lock: raw-cwd currentProject must exclude derived-tagged same-project memories",
  );
});

// ── F. addEpisode stores the provided project (writer-side contract) ────────
test("addEpisode persists the caller-provided project id", () => {
  const state = createMemoryStoresState();
  state.currentSessionId = "session-writer-test";
  const ep = addEpisode(
    state,
    "task with zorblaxflux words",
    "solution text",
    "success",
    [],
    [],
    CURRENT,
  );
  assert.equal(ep.project, CURRENT, "episode project must be the caller-provided derived id");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== Recall project-scope isolation tests passed ===");
