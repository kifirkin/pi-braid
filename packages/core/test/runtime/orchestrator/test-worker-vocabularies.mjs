/**
 * Test: the worker vocabularies have one declared source.
 *
 * 1. `workers.ts` exports the accepted spec set and a status-layer table that
 *    names four roles: stored status, close outcome, computed verdict, result
 *    attestation. Each layer carries the values its writer actually accepts.
 * 2. The orchestrate tool schema renders its vocabulary prose from that
 *    export: the spec and outcome enumerations are exactly the exported lists,
 *    and the tool description names all four layers with their values. A
 *    hand-written copy that drifts from the export fails here.
 * 3. The external result validator (`check-result.mjs`, which lives outside
 *    the repo and cannot be imported) carries the same `SPECS` and `STATUSES`
 *    literals. The file is read from the orchestrator workspace; when it is
 *    absent the sync assertions skip with a clear message, so the suite stays
 *    green on a machine without that workspace.
 * 4. The comparator behind the sync assertion is shown to go red on a mutated
 *    copy, so a passing comparison means the lists matched, not that the check
 *    could not fail.
 * 5. The effect-evidence flag phrase is declared once in `workers.ts` and the
 *    close-worker gates prose advertises it by that constant, stating the
 *    flag is advisory: a hand-written copy that drifts fails here.
 *
 * The test reads the real HOME on purpose: the external file is addressed
 * through it. Nothing under HOME is written.
 *
 * Run: node test/runtime/orchestrator/test-worker-vocabularies.mjs (after npm run build)
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const {
  WORKER_SPECS,
  WORKER_STATUS_LAYERS,
  WORKER_STATUSES,
  WORKER_OUTCOMES,
  WORKER_VERDICT_STATUSES,
  RESULT_SCHEMA_STATUSES,
  WORKER_EFFECT_EVIDENCE_FLAG,
} = await import("../../../dist/lib/orchestrator/index.js");
const { default: orchestratorExtension } = await import(
  "../../../dist/extensions/orchestrator/index.js"
);

const CHECK_RESULT_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "braid",
  "orchestrator",
  "scripts",
  "check-result.mjs",
);

let passed = 0;
let failed = 0;
let skipped = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed++;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

/** Null when `actual` equals `expected` element for element; a message otherwise. */
function listMismatch(label, actual, expected) {
  if (!Array.isArray(actual)) return `${label}: not a list (${typeof actual})`;
  if (actual.length !== expected.length || actual.some((value, i) => value !== expected[i])) {
    return `${label}: ${JSON.stringify(actual)} !== ${JSON.stringify(expected)}`;
  }
  return null;
}

/** The string literals of a `const NAME = [...]` declaration, or null when absent. */
function readListLiteral(source, name) {
  const match = source.match(new RegExp(`const ${name} = \\[([^\\]]*)\\]`));
  if (!match) return null;
  return [...match[1].matchAll(/"([^"]+)"/g)].map((literal) => literal[1]);
}

// ── the declared vocabularies ───────────────────────────────────────────────

test("the status-layer table names the four roles, in order, with their values", () => {
  assert.deepEqual(
    WORKER_STATUS_LAYERS.map((layer) => layer.role),
    ["stored status", "close outcome", "computed verdict", "result attestation"],
    "the table must name the four roles",
  );
  const [stored, close, verdict, attestation] = WORKER_STATUS_LAYERS;
  assert.deepEqual(stored.values, WORKER_STATUSES, "stored status renders WORKER_STATUSES");
  assert.deepEqual(close.values, WORKER_OUTCOMES, "close outcome renders WORKER_OUTCOMES");
  assert.deepEqual(verdict.values, WORKER_VERDICT_STATUSES, "computed verdict renders the verdict list");
  assert.deepEqual(attestation.values, RESULT_SCHEMA_STATUSES, "result attestation renders the schema list");
  for (const layer of WORKER_STATUS_LAYERS) {
    assert.ok(layer.owner.length > 0, `${layer.role} must name its writer`);
    assert.ok(layer.states.length > 0, `${layer.role} must state what a value means`);
    assert.ok(layer.values.length > 0, `${layer.role} must carry values`);
  }
});

// ── the tool schema rendered from the export ────────────────────────────────

const fakePi = {
  tools: [],
  registerTool(definition) {
    this.tools.push(definition);
  },
  on() {},
};
orchestratorExtension(fakePi);
const orchestrateTool = fakePi.tools.find((tool) => tool.name === "orchestrate");
assert.ok(orchestrateTool, "the extension must register the orchestrate tool");

test("the spec and outcome parameter prose is exactly the exported lists", () => {
  const spec = orchestrateTool.parameters.properties.spec.description;
  const specMatch = spec.match(/^Worker spec \(([^)]*)\)\./);
  assert.ok(specMatch, `spec description must carry one parenthetical list: ${spec}`);
  assert.equal(specMatch[1], WORKER_SPECS.join("|"), "the spec list is rendered from WORKER_SPECS");

  const outcome = orchestrateTool.parameters.properties.outcome.description;
  const outcomeMatch = outcome.match(/^Terminal outcome for close-worker \(([^)]*)\)\./);
  assert.ok(outcomeMatch, `outcome description must carry one parenthetical list: ${outcome}`);
  assert.equal(
    outcomeMatch[1],
    WORKER_OUTCOMES.join("|"),
    "the outcome list is rendered from WORKER_OUTCOMES",
  );
});

test("the tool description names all four layers with their exported values", () => {
  for (const layer of WORKER_STATUS_LAYERS) {
    const clause = `${layer.role} (${layer.values.join("|")}), ${layer.states}`;
    assert.ok(
      orchestrateTool.description.includes(clause),
      `description must render the ${layer.role} layer from the table:\n${orchestrateTool.description}`,
    );
  }
});

// ── the external result validator ───────────────────────────────────────────

test("check-result.mjs carries the exported SPECS and STATUSES", () => {
  if (!existsSync(CHECK_RESULT_PATH)) {
    skipped++;
    console.log(
      `  [skip] external result validator absent at ${CHECK_RESULT_PATH}; the sync assertion is not checked here`,
    );
    return;
  }
  const source = readFileSync(CHECK_RESULT_PATH, "utf8");
  const specs = readListLiteral(source, "SPECS");
  const statuses = readListLiteral(source, "STATUSES");
  assert.ok(specs, "check-result.mjs must declare a const SPECS list");
  assert.ok(statuses, "check-result.mjs must declare a const STATUSES list");
  assert.equal(
    listMismatch("check-result.mjs SPECS", specs, [...WORKER_SPECS]),
    null,
    "the validator's spec enum must match the exported set",
  );
  assert.equal(
    listMismatch("check-result.mjs STATUSES", statuses, [...RESULT_SCHEMA_STATUSES]),
    null,
    "the validator's status enum must match the result attestation layer",
  );
});

test("the effect-evidence flag phrase is declared once and advertised in the gates prose", () => {
  assert.equal(WORKER_EFFECT_EVIDENCE_FLAG, "no effect evidence");
  const gates = orchestrateTool.parameters.properties.gates.description;
  assert.ok(
    gates.includes(WORKER_EFFECT_EVIDENCE_FLAG),
    `the gates description must advertise the flag phrase: ${gates}`,
  );
  assert.match(gates, /advisory, non-blocking/, "the prose must state the flag is non-blocking");
});

test("the sync comparator reports a mutated list as a mismatch", () => {
  assert.equal(
    listMismatch("SPECS", [...WORKER_SPECS], [...WORKER_SPECS]),
    null,
    "equal lists must pass",
  );
  const mutated = [...WORKER_SPECS];
  mutated[0] = `${mutated[0]}-mutated`;
  assert.ok(
    listMismatch("SPECS", mutated, [...WORKER_SPECS]),
    "a mutated list must be reported, or the sync assertion could not fail",
  );
  assert.ok(
    listMismatch("SPECS", WORKER_SPECS.slice(0, -1), [...WORKER_SPECS]),
    "a shorter list must be reported, not read as a prefix match",
  );
});

console.log(`\n📊 Results: ${passed} passed, ${failed} failed, ${skipped} skipped`);
process.exitCode = failed > 0 ? 1 : 0;
