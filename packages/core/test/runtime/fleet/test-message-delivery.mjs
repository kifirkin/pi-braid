/**
 * Test: a message is consumed only if its body was in a prompt.
 *
 * The failure this file exists for: a node with zero turns, one message queued
 * while no supervisor runs, and a supervisor started at cap 1. The node is
 * driven by a `charter` turn, that turn ignored the queue, and the settle
 * retired the message anyway. The journal then said `consumed` for a body no
 * model ever read, and the command that queued it had promised delivery.
 *
 * Two mechanisms, so the arms come in pairs:
 *
 *   charter        a message queued before the first turn rides with it
 *   message        control: the between-turns turn still carries it
 *   recovery       control: a resumed turn still lists it
 *   steer          a tier A steer is retired by the turn it entered, and only
 *                  once the child ran the text: the ack alone records nothing
 *   retired        a message for a node that will never run again gets a
 *                  terminal state instead of sitting in `recorded`
 *   below-bound    control: the same fabricated row, one attempt under the
 *                  bound, is carried by a turn rather than stamped
 *   ghost          a row claiming delivery by a turn whose prompt never named
 *                  it is not retired
 *   refuse         the command that cannot deliver says so when it is asked
 *
 * Every claim about what a model read is checked against `turns.prompt_text` in
 * the store, read with this file's own SQL. A helper's return value would prove
 * the helper; the prompt is the product.
 *
 * Run: node test/runtime/fleet/test-message-delivery.mjs
 */

import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { journalPath, openJournal, resolveFleetRoot } from "../../../scripts/fleet/journal.mjs";
import { RpcDriver } from "../../../scripts/fleet/driver-rpc.mjs";
import { controlSocketPath, Supervisor } from "../../../scripts/fleet/supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../../../scripts/fleet/cli.mjs");
const SUPERVISOR = resolve(HERE, "../../../scripts/fleet/supervisor.mjs");

/** The operator's instruction, distinct enough to find in a prompt. */
const BODY = "the operator says: write the report to target-B, not target-A";

let passed = 0;
let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

/**
 * Wait for a state the arms then assert on.
 *
 * The waiting and the asserting are separate on purpose: a timeout here returns
 * nothing, and the check that follows reports the rows the store actually holds.
 * A timeout that throws would hide every later arm behind one failure.
 */
async function settle(predicate, { timeoutMs = 8_000, intervalMs = 40 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
}

/**
 * A read of the store, not through the journal's own readers.
 *
 * Two reasons: an assertion made by the writer's accessor can agree with a bug
 * in the writer, and a read-only connection costs a read. Every poll in this
 * file goes through here.
 */
function sql(root, query, ...params) {
  const db = new DatabaseSync(journalPath(resolveFleetRoot(root)), { readOnly: true });
  try {
    return db.prepare(query).all(...params);
  } finally {
    db.close();
  }
}

const inboxRow = (root, msgId) => sql(root, "SELECT * FROM inbox WHERE msg_id = ?", msgId)[0] ?? null;
const turnsOf = (root, nodeId) => sql(root, "SELECT * FROM turns WHERE node_id = ? ORDER BY turn_id", nodeId);
const nodeOf = (root, nodeId = "n1") => sql(root, "SELECT * FROM nodes WHERE node_id = ?", nodeId)[0] ?? null;

/** The prompts that carry a body, which is the invariant's own measurement. */
const promptsCarrying = (root, body, nodeId = "n1") => turnsOf(root, nodeId).filter((turn) => turn.prompt_text.includes(body));

const roots = [];
function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `fleet-delivery-${label}-`));
  roots.push(root);
  return root;
}

/** A registered node with no turns, the state `fleet spawn` leaves before a drive. */
function registerNode(root, { steps = [{ op: "done" }], charter = "Work the charter, then finish." } = {}) {
  writeFileSync(join(root, "charter.md"), charter);
  const journal = openJournal(root, { driver: "scripted" });
  try {
    journal.addNode({
      nodeId: "n1",
      parentId: null,
      projectRoot: root,
      charterPath: join(root, "charter.md"),
      driver: "scripted",
      driverConfig: { steps, worldFile: join(root, "world.log") },
    });
  } finally {
    journal.close();
  }
}

/** A supervisor this process drives directly, so an arm can stop it on cue. */
function supervisorFor(root, options = {}) {
  return new Supervisor({
    root,
    driver: "scripted",
    cap: 1,
    tickMs: 20,
    // Long enough that no arm races an exit it did not ask for.
    idleExitMs: 600_000,
    control: false,
    log: () => {},
    ...options,
  });
}

function fleet(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8", timeout: 30_000 });
}

/**
 * A supervisor in its own process, for the arms where a command has to reach it.
 *
 * `spawnSync` blocks this process's event loop, so an in-process supervisor
 * cannot answer a command this file runs: the connection lands in the listen
 * backlog and the command times out into the no-supervisor path, which would
 * make the arm assert the opposite of what it means to. The channel needs a
 * process that is free to answer while this one waits.
 */
const spawnedSupervisors = [];
function spawnSupervisor(root, extraArgs = []) {
  const child = spawn(
    process.execPath,
    [SUPERVISOR, "--root", root, "--driver", "scripted", "--cap", "1", "--idle-exit-ms", "600000", ...extraArgs],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = [];
  child.stdout.on("data", (chunk) => log.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => log.push(chunk.toString("utf8")));
  const exited = new Promise((resolveExit) => child.once("exit", resolveExit));
  const running = { child, pid: child.pid, exited, log: () => log.join("") };
  spawnedSupervisors.push(running);
  return running;
}

async function stopSpawned(running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  running.child.kill("SIGTERM");
  const exitedInTime = await Promise.race([running.exited.then(() => true), sleep(10_000).then(() => false)]);
  if (!exitedInTime) {
    running.child.kill("SIGKILL");
    await running.exited;
  }
}

// ── arm: the defect itself ──────────────────────────────────────────────────
//
// Zero turns, one message queued with no supervisor running, then a supervisor
// at cap 1. The node used to be driven by a charter turn that ignored
// the queue and the message was retired anyway.

const charterRoot = freshRoot("charter");
registerNode(charterRoot, { charter: "Read the operator's instruction, then finish." });
const queued = fleet(charterRoot, "inject", "n1", BODY);

await check("the command that queues without a supervisor does not claim a delivery", () => {
  assert.equal(queued.status, 0, queued.stderr);
  assert.match(queued.stdout, /tier C/, `the tier is named: ${queued.stdout}`);
  assert.match(queued.stdout, /no supervisor running/, `the reason is named: ${queued.stdout}`);
  assert.doesNotMatch(queued.stdout, /delivered/, `nothing was delivered, so the word is not used: ${queued.stdout}`);
  assert.match(queued.stdout, /carries it/, `the promise is the one the code keeps: ${queued.stdout}`);
});

const queuedId = queued.stdout.match(/recorded (\S+)/)?.[1] ?? "";

await check("queueing records the message and consumes nothing", () => {
  assert.ok(queuedId, `the message id is printed: ${queued.stdout}`);
  const row = inboxRow(charterRoot, queuedId);
  assert.equal(row.state, "recorded");
  assert.equal(row.delivered_tier, null);
  assert.equal(turnsOf(charterRoot, "n1").length, 0, "no turn has run yet");
});

const charterSupervisor = supervisorFor(charterRoot);
await charterSupervisor.start();

await check("charter: the first turn's prompt carries the queued message", async () => {
  await settle(() => nodeOf(charterRoot)?.state === "done");
  const turns = turnsOf(charterRoot, "n1");
  assert.equal(turns.length, 1, `one turn, the charter: ${turns.map((turn) => turn.kind).join(", ")}`);
  assert.equal(turns[0].kind, "charter");
  assert.equal(promptsCarrying(charterRoot, BODY).length, 1, "exactly one prompt names the message");
  // The turn keeps its shape: the charter is still a charter, and the queue is
  // a section of it rather than a replacement for it.
  assert.match(turns[0].prompt_text, /CHARTER:/);
  assert.match(turns[0].prompt_text, /Read the operator's instruction, then finish\./);
});
await charterSupervisor.stop();

await check("charter: the message is retired, and against the turn that carried it", () => {
  const [turn] = turnsOf(charterRoot, "n1");
  const row = inboxRow(charterRoot, queuedId);
  assert.equal(row.state, "consumed", "a prompt carried the body, so the row may be retired");
  assert.equal(row.delivered_tier, "B");
  assert.equal(row.delivered_turn_id, turn.turn_id, "the record names the turn whose prompt carried it");
});

// ── control: the between-turns turn ─────────────────────────────────────────
//
// A node that already finished a turn and has an unread message is driven by a
// `message` turn. That path predates the queue's new reach and has to keep working,
// including the retirement that follows it.

const messageRoot = freshRoot("message");
registerNode(messageRoot);
{
  const journal = openJournal(messageRoot, { driver: "scripted" });
  try {
    const turnId = journal.beginTurn("n1", {
      kind: "charter",
      promptText: "a first turn that read no message",
      sessionId: "fleet-n1-message",
      supervisorEpoch: 0,
    });
    journal.endTurn(turnId, { state: "done" });
    journal.setNodeState("n1", "settled", { done_reason: "charter reported done" });
  } finally {
    journal.close();
  }
}
const messageQueued = fleet(messageRoot, "inject", "n1", BODY);
const messageId = messageQueued.stdout.match(/recorded (\S+)/)?.[1] ?? "";
const messageSupervisor = supervisorFor(messageRoot);
await messageSupervisor.start();
await settle(() => turnsOf(messageRoot, "n1").length >= 2 && nodeOf(messageRoot)?.state === "done");
await messageSupervisor.stop();

await check("control: a message waiting between turns is carried by a message turn", () => {
  assert.ok(messageId, `the message id is printed: ${messageQueued.stdout}`);
  const turns = turnsOf(messageRoot, "n1");
  assert.equal(turns.length, 2, "one finished turn, one delivery");
  assert.equal(turns[1].kind, "message");
  assert.equal(promptsCarrying(messageRoot, BODY).length, 1);
  assert.ok(turns[1].prompt_text.includes(BODY), "the body is in the delivery turn's prompt");
  const row = inboxRow(messageRoot, messageId);
  assert.equal(row.state, "consumed");
  assert.equal(row.delivered_turn_id, turns[1].turn_id);
});

// ── control: the recovery turn ──────────────────────────────────────────────
//
// A predecessor died mid-turn. The resumed turn lists the queued messages, and
// the settle retires them against itself.

const recoveryRoot = freshRoot("recovery");
registerNode(recoveryRoot);
{
  const journal = openJournal(recoveryRoot, { driver: "scripted" });
  try {
    const deadEpoch = journal.registerSupervisor({
      pid: 2_147_483_600,
      driver: "scripted",
      childArgs: [],
      piVersion: "test",
    });
    journal.beginTurn("n1", {
      kind: "charter",
      promptText: "a turn its owner never finished",
      sessionId: "fleet-n1-recovery",
      supervisorEpoch: deadEpoch,
    });
    journal.setNodeState("n1", "waiting_on_child");
    journal.addMessage({ msgId: "m-recovery", nodeId: "n1", kind: "user", body: BODY });
  } finally {
    journal.close();
  }
}
const recoverySupervisor = supervisorFor(recoveryRoot);
await recoverySupervisor.start();
await settle(() => turnsOf(recoveryRoot, "n1").length >= 2 && nodeOf(recoveryRoot)?.state === "done");
await recoverySupervisor.stop();

await check("control: the resumed turn still lists the queued message, and retires it", () => {
  const turns = turnsOf(recoveryRoot, "n1");
  assert.equal(turns.length, 2, "one interrupted turn, one recovery turn");
  assert.equal(turns[1].kind, "recovery");
  assert.match(turns[1].prompt_text, /FLEET RESUME/);
  assert.match(turns[1].prompt_text, /Messages waiting for you:/);
  assert.equal(promptsCarrying(recoveryRoot, BODY).length, 1);
  const row = inboxRow(recoveryRoot, "m-recovery");
  assert.equal(row.state, "consumed");
  assert.equal(row.delivered_turn_id, turns[1].turn_id);
});

// ── control: a tier A steer ─────────────────────────────────────────────────
//
// A steer enters the running conversation rather than a turn's prompt, so its
// body is not in `prompt_text` by construction. It is still retired, and by the
// turn it entered: the alternative is a `delivered` row nothing ever reads again.
//
// Two moments, and the difference between them is the whole arm. When `inject`
// returns, the child has *queued* the text: pi answers a steer request there,
// and a queue is not a delivery, so the row must still be `recorded`. The row
// becomes tier A only when the child runs the text, which is the one moment the
// fleet can testify to.

const steerRoot = freshRoot("steer");
registerNode(steerRoot, { steps: [{ op: "sleep", ms: 3000 }, { op: "done" }] });
const steerSupervisor = spawnSupervisor(steerRoot);
await settle(() => turnsOf(steerRoot, "n1").some((turn) => turn.state === "in_progress"));
const steered = fleet(steerRoot, "inject", "n1", BODY);
const steeredId = steered.stdout.match(/steered (\S+) into n1/)?.[1] ?? "";
const midTurn = { turn: turnsOf(steerRoot, "n1")[0], row: steeredId ? inboxRow(steerRoot, steeredId) : null };
await settle(() => nodeOf(steerRoot)?.state === "done");
await stopSpawned(steerSupervisor);

await check("a steer's ack is not a delivery: the row is still recorded while the turn runs", () => {
  assert.equal(steered.status, 0, steered.stderr);
  assert.doesNotMatch(steered.stdout, /delivered/, `the command does not claim a delivery: ${steered.stdout}`);
  assert.match(steered.stdout, /steered \S+ into n1 turn \d+/, `it names the steer and the turn: ${steered.stdout}`);
  assert.ok(steeredId, `the message id is printed: ${steered.stdout}`);
  assert.equal(midTurn.turn.state, "in_progress", "the turn was still running when the row was read");
  assert.equal(midTurn.row.state, "recorded", "an ack leaves the message waiting, not delivered");
  assert.equal(midTurn.row.delivered_tier, null, "no tier is written for a request");
  assert.equal(midTurn.row.delivered_turn_id, null);
});

await check("control: the delivery event retires it, against the turn that ran the text", () => {
  const [turn] = turnsOf(steerRoot, "n1");
  assert.equal(promptsCarrying(steerRoot, BODY).length, 0, "a steer is not part of the turn's prompt text");
  const row = inboxRow(steerRoot, steeredId);
  assert.equal(row.state, "consumed", "the turn it entered settled, so it is not left in delivered");
  assert.equal(row.delivered_tier, "A", "the tier is written by the child's delivery event");
  assert.equal(row.delivered_turn_id, turn.turn_id);
  assert.equal(row.delivered_after_effect_seq, 1, "it landed after the tool call that was in flight");
});

// ── the driver's own account of a steer ─────────────────────────────────────
//
// The supervisor writes tier A from `steer_delivered`, so that event is the
// claim and this is where it comes from. pi queues a steering message and hands
// it to the model later, so the observable moment is the user message carrying
// that text arriving on the child's stream. The RpcDriver is driven here the way
// its child drives it - JSON lines in, events out - with no model and no child.

function feed(driver, record) {
  driver._read(Buffer.from(`${JSON.stringify(record)}\n`, "utf8"));
}

await check("the driver reports a steer delivered only when the text comes back as a user message", () => {
  const driver = new RpcDriver({});
  const events = [];
  driver.onEvent((event) => events.push(event));
  const text = "the operator says: stop, the target moved";
  driver.request = async () => ({ type: "response", data: { disposition: "queued" } });

  feed(driver, { type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "sleep 1" } });
  feed(driver, { type: "message_end", message: { role: "user", content: [{ type: "text", text: "something else" }] } });
  assert.equal(events.filter((event) => event.type === "steer_delivered").length, 0, "an unrelated message is not a delivery");

  return driver.steer(text).then(() => {
    assert.equal(driver.pendingSteers.length, 1, "a queued steer is remembered for the message that carries it");
    feed(driver, { type: "message_end", message: { role: "user", content: [{ type: "text", text }] } });
    const delivered = events.filter((event) => event.type === "steer_delivered");
    assert.equal(delivered.length, 1, JSON.stringify(events.map((event) => event.type)));
    assert.equal(delivered[0].text, text);
    assert.equal(delivered[0].afterEffectSeq, 1, "it is placed after the tool call in flight");
    assert.deepEqual(driver.pendingSteers, [], "the text is not delivered twice");
  });
});

await check("a steer the child's handler consumes is never awaited as a delivery", () => {
  const driver = new RpcDriver({});
  driver.onEvent(() => {});
  driver.request = async () => ({ type: "response", data: { disposition: "handled" } });
  return driver.steer("do this").then(() => {
    assert.deepEqual(driver.pendingSteers, [], "no user message will carry it, so none is expected");
  });
});

// ── arm: a message no turn will ever carry ──────────────────────────────────
//
// The node is failed at its attempt bound: the scheduler never drives it again,
// so `recorded` is a promise that cannot be kept. The row gets a terminal state
// of its own, the status output counts it, and no turn is invented to carry it.

const retiredRoot = freshRoot("retired");
registerNode(retiredRoot);
{
  const journal = openJournal(retiredRoot, { driver: "scripted" });
  try {
    // What reconcile leaves behind when the attempt bound closes the crash
    // loop, plus the message an operator queued while it was still running.
    journal.setNodeState("n1", "failed", {
      attempts: 3,
      done_reason: "attempt bound: 3 failed or interrupted attempts reached maxAttempts 3",
    });
    journal.addMessage({ msgId: "m-strand", nodeId: "n1", kind: "user", body: BODY });
  } finally {
    journal.close();
  }
}
const retiredLog = [];
const retiredSupervisor = supervisorFor(retiredRoot, { log: (line) => retiredLog.push(line) });
await retiredSupervisor.start();
await settle(() => inboxRow(retiredRoot, "m-strand")?.state === "undeliverable", {
  timeoutMs: 5000,
});
await retiredSupervisor.stop();

await check("a message for a node at its attempt bound ends undeliverable, not recorded", () => {
  const row = inboxRow(retiredRoot, "m-strand");
  assert.equal(row.state, "undeliverable");
  assert.equal(row.delivered_tier, null, "it was never delivered, and the row does not say it was");
  assert.equal(turnsOf(retiredRoot, "n1").length, 0, "no turn was invented to carry it");
  assert.ok(
    retiredLog.some((line) => /can never be delivered/.test(line) && line.includes("m-strand")),
    `the supervisor says so: ${retiredLog.join(" | ")}`,
  );
});

await check("status reports the undeliverable message as a count", () => {
  const status = fleet(retiredRoot, "status", "--json");
  assert.equal(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.nodes[0].undeliverable, 1);
  assert.equal(parsed.nodes[0].pending, 0, "it is not still promised as pending");
  const plain = fleet(retiredRoot, "status");
  assert.equal(plain.status, 0, plain.stderr);
  assert.match(plain.stdout, /undeliverable 1/, `the human output names it: ${plain.stdout}`);
});

// ── control: the same row, one attempt under the bound ──────────────────────
//
// The sweep and the scheduler have to answer the same question the same way.
// Below the bound the node is drivable, so the message is carried by a turn and
// retired there, and nothing is stamped.

const belowRoot = freshRoot("below-bound");
registerNode(belowRoot);
{
  const journal = openJournal(belowRoot, { driver: "scripted" });
  try {
    journal.setNodeState("n1", "failed", { attempts: 2, done_reason: "one attempt under the bound" });
    journal.addMessage({ msgId: "m-due", nodeId: "n1", kind: "user", body: BODY });
  } finally {
    journal.close();
  }
}
const belowSupervisor = supervisorFor(belowRoot, { maxAttempts: 3 });
await belowSupervisor.start();
await settle(() => nodeOf(belowRoot)?.state === "done", { timeoutMs: 5000 });
await belowSupervisor.stop();

await check("control: below the bound the message is carried by a turn, not stamped", () => {
  const row = inboxRow(belowRoot, "m-due");
  assert.equal(row.state, "consumed", `the message was delivered: ${JSON.stringify(row)}`);
  assert.equal(promptsCarrying(belowRoot, BODY).length, 1);
  assert.equal(row.delivered_tier, "B");
});

// ── arm: a delivery the prompt does not back ────────────────────────────────
//
// The shape the old settle rule retired: a row marked delivered against a turn
// whose prompt never named it. Consumption is per carried message now, so a turn
// that carries one message does not launder the other.

const ghostRoot = freshRoot("ghost");
registerNode(ghostRoot);
{
  const journal = openJournal(ghostRoot, { driver: "scripted" });
  try {
    const turnId = journal.beginTurn("n1", {
      kind: "charter",
      promptText: "a turn whose prompt named no message",
      sessionId: "fleet-n1-ghost",
      supervisorEpoch: 0,
    });
    journal.endTurn(turnId, { state: "done" });
    journal.setNodeState("n1", "settled", {});
    journal.addMessage({ msgId: "m-ghost", nodeId: "n1", kind: "user", body: "a body no prompt ever carried" });
    journal.markMessageDelivered("m-ghost", { tier: "B", turnId });
    journal.addMessage({ msgId: "m-real", nodeId: "n1", kind: "user", body: BODY });
  } finally {
    journal.close();
  }
}
const ghostSupervisor = supervisorFor(ghostRoot);
await ghostSupervisor.start();
await settle(() => nodeOf(ghostRoot)?.state === "done", { timeoutMs: 5000 });
await ghostSupervisor.stop();

await check("a row whose body was in no prompt is not retired by a turn that carried another", () => {
  const turns = turnsOf(ghostRoot, "n1");
  assert.equal(turns.length, 2, "the fabricated turn and the delivery turn");
  assert.equal(promptsCarrying(ghostRoot, "a body no prompt ever carried").length, 0);
  assert.equal(inboxRow(ghostRoot, "m-ghost").state, "delivered", "still not consumed, because no prompt carried it");
  const carried = inboxRow(ghostRoot, "m-real");
  assert.equal(carried.state, "consumed");
  assert.equal(carried.delivered_turn_id, turns[1].turn_id);
});

// ── arm: a delivery whose turn died goes back in the queue ──────────────────
//
// A predecessor was killed after its prompt carried the message: the row says
// `delivered` against a turn that never settled. The message reached a model and
// nothing acted on it, so reconciliation puts it back and the recovery turn
// carries it again. At-least-once is the choice; losing it silently is the
// failure this arm rules out.

const requeueRoot = freshRoot("requeue");
registerNode(requeueRoot);
{
  const journal = openJournal(requeueRoot, { driver: "scripted" });
  try {
    const deadEpoch = journal.registerSupervisor({
      pid: 2_147_483_600,
      driver: "scripted",
      childArgs: [],
      piVersion: "test",
    });
    const turnId = journal.beginTurn("n1", {
      kind: "charter",
      promptText: `the predecessor's prompt carried this: ${BODY}`,
      sessionId: "fleet-n1-requeue",
      supervisorEpoch: deadEpoch,
    });
    journal.addMessage({ msgId: "m-abandoned", nodeId: "n1", kind: "user", body: BODY });
    journal.markMessageDelivered("m-abandoned", { tier: "B", turnId });
    journal.setNodeState("n1", "waiting_on_child");
  } finally {
    journal.close();
  }
}
const requeueSupervisor = supervisorFor(requeueRoot);
await requeueSupervisor.start();
await settle(() => nodeOf(requeueRoot)?.state === "done");
await requeueSupervisor.stop();

await check("a message carried by a turn that was killed is queued again, not left in delivered", () => {
  const turns = turnsOf(requeueRoot, "n1");
  assert.equal(turns.length, 2, "the interrupted turn and the recovery turn");
  assert.equal(turns[1].kind, "recovery");
  assert.equal(promptsCarrying(requeueRoot, BODY).length, 2, "both prompts name the body");
  const row = inboxRow(requeueRoot, "m-abandoned");
  assert.equal(row.state, "consumed");
  assert.equal(row.delivered_turn_id, turns[1].turn_id, "the row ends up delivered by the turn that finished");
});

// ── arm: a turn that fails does not consume what it carried ─────────────────
//
// The scripted driver throws on an unknown step, so every turn for this node
// fails after its prompt went out. The message must not be retired by a turn
// that never settled: it goes back to the queue each time, and when the failures
// reach the bound the sweep stamps what is left. The final row carries no
// delivery columns at all, which is only true if the last failure released it.

const failingRoot = freshRoot("failing");
registerNode(failingRoot, { steps: [{ op: "explode" }] });
const failingQueued = fleet(failingRoot, "inject", "n1", BODY);
const failingId = failingQueued.stdout.match(/recorded (\S+)/)?.[1] ?? "";
const failingSupervisor = supervisorFor(failingRoot);
await failingSupervisor.start();
await settle(() => inboxRow(failingRoot, failingId)?.state === "undeliverable", { timeoutMs: 10_000 });
await failingSupervisor.stop();

await check("a failing turn releases its messages instead of consuming them", () => {
  assert.ok(failingId, `the message id is printed: ${failingQueued.stdout}`);
  const turns = turnsOf(failingRoot, "n1");
  assert.equal(turns.length, 3, `three attempts at the bound: ${turns.map((turn) => `${turn.kind}:${turn.state}`).join(", ")}`);
  assert.ok(
    turns.every((turn) => turn.state === "failed"),
    `every turn failed: ${turns.map((turn) => `${turn.kind}:${turn.state}`).join(", ")}`,
  );
  assert.equal(promptsCarrying(failingRoot, BODY).length, turns.length, "every attempt's prompt named the body");
  const row = inboxRow(failingRoot, failingId);
  assert.equal(row.state, "undeliverable", "the node is at its bound, so the sweep takes it");
  assert.equal(row.delivered_tier, null, "the last failure released the delivery columns");
  assert.equal(row.delivered_turn_id, null);
});

// ── arm: the command refuses what it cannot deliver ─────────────────────────
//
// A message for a node that will never run again must not be recorded with a
// promise. The command says so at the moment it is asked, on both paths: with no
// supervisor, from the journal alone, and with one, from the supervisor.

const refuseRoot = freshRoot("refuse");
registerNode(refuseRoot);
const refuseSupervisor = supervisorFor(refuseRoot);
await refuseSupervisor.start();
await settle(() => nodeOf(refuseRoot)?.state === "done");
await refuseSupervisor.stop();

const refusedOffline = fleet(refuseRoot, "inject", "n1", BODY);

await check("a message for a done node is refused, not queued and forgotten", () => {
  assert.equal(refusedOffline.status, 1, `the command fails: ${refusedOffline.stdout}${refusedOffline.stderr}`);
  assert.match(refusedOffline.stderr, /the node is done/);
  assert.match(refusedOffline.stderr, /no turn will ever carry it/);
  assert.equal(sql(refuseRoot, "SELECT * FROM inbox").length, 0, "nothing is recorded");
});

// The same refusal over the control channel: a supervisor is up, and it is the
// one that owns the answer.
const refuseChannelSupervisor = spawnSupervisor(refuseRoot);
await settle(() => existsSync(controlSocketPath(refuseRoot)));
const refusedLive = fleet(refuseRoot, "inject", "n1", BODY);
await stopSpawned(refuseChannelSupervisor);

await check("the control channel refuses it too, rather than reporting a delivery", () => {
  assert.equal(refusedLive.status, 1, `the command fails: ${refusedLive.stdout}${refusedLive.stderr}`);
  assert.match(refusedLive.stderr, /no turn will ever carry it/);
  assert.doesNotMatch(refusedLive.stdout, /tier [ABC]/);
  assert.equal(sql(refuseRoot, "SELECT * FROM inbox").length, 0, "nothing is recorded");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
