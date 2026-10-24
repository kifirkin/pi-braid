/**
 * Test: the effect lifecycle a crash resumes from.
 *
 * An effect is recorded before the tool runs and settled after it. The states
 * that matter are `attempted` (the tool started and the process went away),
 * `unknown` (reconciliation looked at that attempt and refused to call it
 * either done or not done), and `completed`. A settled effect is never
 * reopened, which is what keeps a replayed event stream from inventing a
 * second attempt at work that already happened.
 *
 * Also pinned here: budgets refuse rather than warn, a lease is exclusive per
 * node, and a delivered inbox row keeps its tier.
 *
 * Run: node test/runtime/fleet/test-effects-lifecycle.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal } from "../../../scripts/fleet/journal.mjs";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "fleet-effects-"));
const journal = openJournal(root, {});
journal.db.prepare("INSERT OR IGNORE INTO projects(project_root, created_at) VALUES (?, ?)").run(root, Date.now());

const node = journal.addNode({
  nodeId: "n1",
  parentId: null,
  projectRoot: root,
  charterPath: join(root, "charter.md"),
  tokenCap: 1000,
});
const turnId = journal.beginTurn("n1", { kind: "charter", promptText: "do the work" });

check("a recorded attempt is not yet an effect that happened", () => {
  journal.effectAttempted({
    turnId,
    nodeId: "n1",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "printf one >> world" },
    replay: "never",
    seq: 1,
  });
  const [row] = journal.effects(turnId);
  assert.equal(row.state, "attempted");
  assert.equal(row.replay, "never");
  assert.ok(row.idempotency_key, "the key exists before the tool runs");
  assert.equal(row.ended_at, null);
  assert.equal(journal.settledEffects(turnId).length, 0, "an attempt is not a completed effect");
});

check("the end event settles the attempt with its result", () => {
  journal.effectSettled({ turnId, toolCallId: "call-1", result: { appended: 1 }, isError: false });
  const [row] = journal.effects(turnId);
  assert.equal(row.state, "completed");
  assert.match(row.result_json, /appended/);
  assert.equal(row.is_error, 0);
  assert.ok(row.ended_at);
});

check("a settled effect is never reopened by a repeated attempt event", () => {
  journal.effectAttempted({
    turnId,
    nodeId: "n1",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "printf one >> world" },
    replay: "never",
    seq: 1,
  });
  const [row] = journal.effects(turnId);
  assert.equal(row.state, "completed");
  assert.match(row.result_json, /appended/, "the result survives the replay");
});

check("an attempt with no end becomes unknown, and reconciliation says which ones", () => {
  journal.effectAttempted({
    turnId,
    nodeId: "n1",
    toolCallId: "call-2",
    toolName: "bash",
    args: { command: "printf two >> world" },
    replay: "never",
    seq: 2,
  });
  const attempted = journal.attemptedEffects(turnId);
  assert.equal(attempted.length, 1);
  assert.equal(attempted[0].tool_call_id, "call-2");
  const marked = journal.markUnknownEffects(turnId);
  assert.equal(marked.length, 1);
  const rows = journal.effects(turnId);
  assert.deepEqual(
    rows.map((row) => `${row.seq}:${row.state}`),
    ["1:completed", "2:unknown"],
    "order and state are both readable after reconciliation",
  );
  assert.equal(journal.settledEffects(turnId).length, 1, "unknown is not completed");
});

check("a safe read is recorded as replayable, an effect never is", () => {
  const readTurn = journal.beginTurn("n1", { kind: "message", promptText: "look around" });
  journal.effectAttempted({
    turnId: readTurn,
    nodeId: "n1",
    toolCallId: "call-read",
    toolName: "read",
    args: { path: "x" },
    replay: "safe",
    seq: 1,
  });
  journal.effectSettled({ turnId: readTurn, toolCallId: "call-read", result: { text: "x" }, isError: false });
  assert.equal(journal.effects(readTurn)[0].replay, "safe");
});

check("a node budget refuses the next turn instead of warning about it", () => {
  assert.equal(journal.budgetRefusal(root, "n1"), null, "under budget the refusal is null");
  journal.addNodeUsage("n1", { tokensIn: 900, tokensOut: 200, projectRoot: root });
  assert.match(journal.budgetRefusal(root, "n1"), /node tokens spent 1100 of cap 1000/);
  const project = journal.project(root);
  assert.equal(project.tokens_in, 900, "project usage is accumulated too");
});

check("a lease is exclusive per node and epoch", () => {
  const first = journal.acquireLease({ nodeId: "n1", ownerPid: process.pid, epoch: 1 });
  assert.ok(first);
  assert.equal(journal.acquireLease({ nodeId: "n1", ownerPid: process.pid, epoch: 2 }), null);
  assert.equal(journal.liveLease("n1").epoch, 1);
  journal.releaseLease("n1", 1);
  assert.equal(journal.liveLease("n1"), null);
  assert.ok(journal.acquireLease({ nodeId: "n1", ownerPid: process.pid, epoch: 2 }));
  journal.releaseLease("n1", 2);
});

check("a lease is held until its owner lets go, not until a clock says so", () => {
  journal.acquireLease({ nodeId: "n2", ownerPid: process.pid, epoch: 1 });
  // An hour of no heartbeat is a lease nothing has refreshed, and a long-past
  // expiry is a value the build that shipped the column would have written, and
  // it still holds: exclusivity is the owner answering for the node, and
  // reconciliation ends a lease by asking whether that owner is still there. The
  // column is written here by the test alone - nothing in the fleet reads it - so
  // a wall-clock bound would free a node whose child is still running.
  journal.db.exec(
    "UPDATE leases SET heartbeat_at = heartbeat_at - 3600000, expires_at = 1000 WHERE node_id = 'n2'",
  );
  assert.equal(journal.liveLease("n2")?.epoch, 1, "the stale lease is still the live one");
  assert.equal(journal.acquireLease({ nodeId: "n2", ownerPid: process.pid, epoch: 2 }), null, "a second epoch is refused");
  journal.releaseLease("n2", 1);
  assert.equal(journal.liveLease("n2"), null, "and it is gone when its owner releases it");
});

check("a delivered message keeps the tier it was delivered at", () => {
  const message = journal.addMessage({ msgId: "m1", nodeId: "n1", kind: "user", body: "hello" });
  assert.equal(message.state, "recorded");
  assert.equal(journal.pendingMessages("n1").length, 1);
  journal.markMessageDelivered("m1", { tier: "A", turnId, afterEffectSeq: 2, beforeRequestSeq: 3 });
  assert.equal(journal.pendingMessages("n1").length, 0);
  const [row] = journal.messages("n1");
  assert.equal(row.delivered_tier, "A");
  assert.equal(row.delivered_turn_id, turnId);
  assert.equal(row.delivered_after_effect_seq, 2);
  const route = journal.db.prepare("SELECT * FROM routes WHERE msg_id = ?").get("m1");
  assert.equal(route.delivery_state, "steered");
  journal.markMessagesConsumed("n1");
  assert.equal(journal.messages("n1")[0].state, "consumed");
});

check("a supervisor epoch increments and its state is writable", () => {
  const first = journal.registerSupervisor({ pid: process.pid, driver: "scripted", childArgs: [] });
  const second = journal.registerSupervisor({ pid: process.pid + 1, driver: "scripted", childArgs: [] });
  assert.equal(second, first + 1);
  journal.setSupervisorState(process.pid + 1, "dead");
  const rows = journal.supervisors();
  assert.equal(rows.find((row) => row.epoch === second).state, "dead");
  assert.equal(journal.getNode("n1").node_id, node.node_id);
});

journal.close();
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
