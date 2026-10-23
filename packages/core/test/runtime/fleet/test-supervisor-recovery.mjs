/**
 * Test: reconciliation after a supervisor dies.
 *
 * A predecessor is fabricated the way a killed process leaves it - a live
 * supervisor row with a dead pid, a turn still marked in progress, its process
 * group still running, one effect completed and one attempted. A fresh
 * supervisor must:
 *
 *   1. fence the process group its predecessor left behind, before it reads
 *      that turn's effects;
 *   2. turn the attempt with no end into `unknown` rather than into a repeat;
 *   3. keep the interrupted turn as the record, and keep the node (not drop it);
 *   4. resume in the same session with a recovery turn whose prompt names the
 *      completed effect and the unknown one, and whose work adds no effect.
 *
 * The same loop must not touch a turn whose owner is still alive: a second
 * supervisor that fences a first one's working child, ends its turn and counts
 * an attempt has killed work that was not residue. And a node that keeps being
 * interrupted is not resumed for ever: at `maxAttempts` it is failed, not
 * settled, so the scheduler never drives it again.
 *
 * The world file is the second instrument: a repeat would show up there even if
 * the journal were talked into forgetting.
 *
 * Run: node test/runtime/fleet/test-supervisor-recovery.mjs
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
import { groupIsAlive, pidIsAlive } from "../../../scripts/fleet/procs.mjs";
import { Supervisor } from "../../../scripts/fleet/supervisor.mjs";

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

async function waitFor(label, predicate, { timeoutMs = 8000, intervalMs = 20 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const root = mkdtempSync(join(tmpdir(), "fleet-recovery-"));
const worldFile = join(root, "world.log");
writeFileSync(worldFile, "effect-1\n");
const DEAD_PID = 2_147_483_600;

// The orphan is started from a throwaway shell so it is not this process's
// child: a real orphan is reparented, and a zombie child of ours would keep its
// group answering long after the kernel killed the process.
const orphanShell = spawn("sh", ["-c", "sleep 30 & echo $!"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
let orphanPid = 0;
await new Promise((resolveLine) => {
  orphanShell.stdout.on("data", (chunk) => {
    orphanPid = Number(chunk.toString("utf8").trim());
    resolveLine();
  });
});
await new Promise((resolveExit) => orphanShell.once("exit", resolveExit));

const journal = openJournal(root, { driver: "scripted" });
const deadEpoch = journal.registerSupervisor({ pid: DEAD_PID, driver: "scripted", childArgs: [], piVersion: "test" });
journal.addNode({
  nodeId: "n1",
  parentId: null,
  projectRoot: root,
  charterPath: join(root, "charter.md"),
  driver: "scripted",
  driverConfig: {
    steps: [
      { op: "append", text: "effect-1" },
      { op: "append", text: "effect-2" },
      { op: "done" },
    ],
    worldFile,
  },
});
const turnId = journal.beginTurn("n1", {
  kind: "charter",
  promptText: "run the two effects",
  sessionId: "fleet-n1-test",
  supervisorEpoch: deadEpoch,
});
journal.setNodeSession("n1", { sessionId: "fleet-n1-test", sessionFile: join(root, "sessions", "fleet-n1-test.jsonl") });
journal.setTurnChild(turnId, { pid: orphanPid, pgid: orphanShell.pid });
journal.effectAttempted({
  turnId,
  nodeId: "n1",
  toolCallId: "call-1",
  toolName: "bash",
  args: { command: "append effect-1" },
  replay: "never",
  seq: 1,
});
journal.effectSettled({ turnId, toolCallId: "call-1", result: { ok: true }, isError: false });
journal.effectAttempted({
  turnId,
  nodeId: "n1",
  toolCallId: "call-2",
  toolName: "bash",
  args: { command: "append effect-2" },
  replay: "never",
  seq: 2,
});
journal.setNodeState("n1", "waiting_on_child");
journal.close();

const orphanGroup = orphanShell.pid;
console.log(`  fabricated predecessor: pid ${DEAD_PID}, orphan group ${orphanGroup}`);
assert.ok(groupIsAlive(orphanGroup), "the orphan group is alive before reconciliation");

const log = [];
const supervisor = new Supervisor({
  root,
  driver: "scripted",
  cap: 3,
  tickMs: 20,
  control: false,
  log: (line) => log.push(line),
});
await supervisor.start();

await check("reconciliation fences the process group the dead predecessor left", async () => {
  const reopened = openJournal(root, {});
  try {
    const fences = JSON.parse(reopened.meta().fences ?? "[]");
    assert.equal(fences.length, 1);
    assert.equal(fences[0].pgid, orphanGroup);
    assert.equal(fences[0].killed, true);
    assert.equal(fences[0].aliveAfter, false);
  } finally {
    reopened.close();
  }
  assert.equal(groupIsAlive(orphanGroup), false, "the group is gone");
});

await check("the interrupted turn keeps its record and its in-flight effect becomes unknown", async () => {
  const reopened = openJournal(root, {});
  try {
    const turn = reopened.turn(turnId);
    assert.equal(turn.state, "interrupted");
    const effects = reopened.effects(turnId);
    assert.deepEqual(
      effects.map((effect) => `${effect.seq}:${effect.state}`),
      ["1:completed", "2:unknown"],
    );
    const predecessor = reopened.supervisors().find((row) => row.epoch === deadEpoch);
    assert.equal(predecessor.state, "dead", "a live row with a dead pid is repaired");
  } finally {
    reopened.close();
  }
});

await check("the node is resumed, not restarted, and adds no effect of its own", async () => {
  const done = await waitFor("the node to finish its recovery turn", () => {
    const reopened = openJournal(root, {});
    try {
      const node = reopened.getNode("n1");
      const turns = reopened.turnsFor("n1");
      return node.state === "done" && turns.length >= 2 ? { node, turns } : null;
    } finally {
      reopened.close();
    }
  });
  assert.equal(done.turns.length, 2, "one interrupted turn, one recovery turn");
  assert.equal(done.turns[1].kind, "recovery");
  assert.equal(done.node.session_id, "fleet-n1-test", "the session id is unchanged");
  assert.equal(readFileSync(worldFile, "utf8").trim(), "effect-1", "no effect is repeated and none is invented");
});

await check("the recovery prompt is built from the journal", async () => {
  const reopened = openJournal(root, {});
  try {
    const turns = reopened.turnsFor("n1");
    const prompt = turns[1].prompt_text;
    assert.match(prompt, /FLEET RESUME/);
    assert.match(prompt, /seq 1 bash completed/);
    assert.match(prompt, /seq 2 bash unknown/);
    assert.match(prompt, /never repeat a completed effect/);
    assert.equal(reopened.effects(turns[1].turn_id).length, 0, "the recovery turn performed no tool call");
  } finally {
    reopened.close();
  }
});

await check("stopping the supervisor releases its leases and marks it stopped", async () => {
  await supervisor.stop();
  const reopened = openJournal(root, {});
  try {
    const rows = reopened.supervisors();
    const mine = rows.at(-1);
    assert.equal(mine.pid, process.pid);
    assert.equal(mine.state, "stopped");
    assert.equal(reopened.liveLeases().length, 0);
  } finally {
    reopened.close();
  }
});

try {
  process.kill(-orphanGroup, "SIGKILL");
} catch (error) {
  if (error.code !== "ESRCH") throw error;
}

// ── a predecessor that is still working ─────────────────────────────────────
//
// Both repair loops in reconciliation have to answer one question the same
// way: is the owner of this row still alive? A live owner's turn is not
// residue, and fencing it kills a child that is still working.

/**
 * A real detached `sleep` in its own process group, started from a throwaway
 * shell that exits immediately. The sleep is reparented to init, so the kernel
 * really removes it: a child of this test would sit in its group as a zombie
 * until reaped, and `groupIsAlive` would keep answering yes for a process the
 * signal already killed.
 */
function startOrphanGroup() {
  const shell = spawn("sh", ["-c", "sleep 30 & echo $!"], { detached: true, stdio: ["ignore", "pipe", "ignore"] });
  return new Promise((resolveLine) => {
    let buffer = "";
    shell.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (!buffer.includes("\n")) return;
      resolveLine({ pid: Number(buffer.trim()), pgid: shell.pid });
    });
  });
}

/**
 * The row shape a supervisor leaves behind when it dies mid-turn, with one
 * detail decided by the caller: `ownerPid`. A pid nothing owns is a crash; a
 * pid that answers is a predecessor that is still driving its own child.
 */
async function fabricatePredecessor(label, { ownerPid }) {
  const caseRoot = mkdtempSync(join(tmpdir(), `fleet-${label}-`));
  const group = await startOrphanGroup();
  const seed = openJournal(caseRoot, { driver: "scripted" });
  const epoch = seed.registerSupervisor({ pid: ownerPid, driver: "scripted", childArgs: [], piVersion: "test" });
  seed.addNode({
    nodeId: "n1",
    parentId: null,
    projectRoot: caseRoot,
    charterPath: join(caseRoot, "charter.md"),
    driver: "scripted",
    driverConfig: { steps: [{ op: "done" }], worldFile: join(caseRoot, "world.log") },
  });
  const lease = seed.acquireLease({ nodeId: "n1", ownerPid, epoch, ttlMs: 600_000 });
  const turnId = seed.beginTurn("n1", {
    kind: "charter",
    promptText: "a turn its owner is still running",
    sessionId: "fleet-n1-predecessor",
    supervisorEpoch: epoch,
  });
  seed.setTurnChild(turnId, { pid: group.pid, pgid: group.pgid });
  seed.effectAttempted({
    turnId,
    nodeId: "n1",
    toolCallId: "call-1",
    toolName: "bash",
    args: { command: "sleep 30" },
    replay: "never",
    seq: 1,
  });
  seed.setNodeState("n1", "waiting_on_child");
  seed.close();
  assert.ok(lease, "the fabricated lease is live");
  assert.ok(groupIsAlive(group.pgid), "the fabricated child group is alive before the supervisor starts");
  return { root: caseRoot, epoch, turnId, group };
}

const deadOwnerCase = await fabricatePredecessor("dead-owner", { ownerPid: DEAD_PID });
const deadOwnerSupervisor = new Supervisor({
  root: deadOwnerCase.root,
  driver: "scripted",
  cap: 3,
  tickMs: 20,
  control: false,
  log: () => {},
});
await deadOwnerSupervisor.start();

await check("control: a dead predecessor's live child group is fenced and its turn interrupted", async () => {
  const reopened = openJournal(deadOwnerCase.root, {});
  try {
    const fences = JSON.parse(reopened.meta().fences ?? "[]");
    assert.equal(fences.length, 1);
    assert.equal(fences[0].pgid, deadOwnerCase.group.pgid);
    assert.equal(fences[0].killed, true);
    assert.equal(fences[0].aliveAfter, false);
    assert.equal(reopened.turn(deadOwnerCase.turnId).state, "interrupted");
    assert.deepEqual(
      reopened.effects(deadOwnerCase.turnId).map((effect) => effect.state),
      ["unknown"],
    );
    assert.equal(reopened.getNode("n1").attempts, 1);
  } finally {
    reopened.close();
  }
  assert.equal(groupIsAlive(deadOwnerCase.group.pgid), false, "the group is gone");
});
await deadOwnerSupervisor.stop();

const liveOwner = spawn("sleep", ["30"], { detached: true, stdio: "ignore" });
liveOwner.unref();
assert.ok(pidIsAlive(liveOwner.pid), "the fabricated owner is a live process");
const liveOwnerCase = await fabricatePredecessor("live-owner", { ownerPid: liveOwner.pid });
const liveOwnerSupervisor = new Supervisor({
  root: liveOwnerCase.root,
  driver: "scripted",
  cap: 3,
  tickMs: 20,
  control: false,
  log: () => {},
});
await liveOwnerSupervisor.start();
// Reconciliation runs inside start(). A tick's worth of waiting is added so a
// fence that happened late would still be seen.
await sleep(150);

await check("a live owner's turn is left completely alone", async () => {
  const reopened = openJournal(liveOwnerCase.root, {});
  try {
    assert.equal(reopened.turn(liveOwnerCase.turnId).state, "in_progress", "the turn is not ended");
    assert.deepEqual(
      reopened.effects(liveOwnerCase.turnId).map((effect) => effect.state),
      ["attempted"],
      "the in-flight effect is not marked unknown",
    );
    assert.equal(reopened.getNode("n1").attempts, 0, "no attempt is counted");
    assert.equal(reopened.getNode("n1").state, "waiting_on_child", "the node state is untouched");
    assert.equal(reopened.liveLease("n1").epoch, liveOwnerCase.epoch, "the predecessor's lease is still live");
    assert.deepEqual(JSON.parse(reopened.meta().fences ?? "[]"), [], "nothing was fenced");
  } finally {
    reopened.close();
  }
  assert.equal(groupIsAlive(liveOwnerCase.group.pgid), true, "the live owner's child group is still running");
  assert.equal(pidIsAlive(liveOwner.pid), true, "the live owner is still running");
});

await check("surviving the check is recorded as a count, not only logged", async () => {
  const reopened = openJournal(liveOwnerCase.root, {});
  try {
    assert.equal(Number(reopened.meta().reconcile_skipped_turns), 1);
  } finally {
    reopened.close();
  }
});
await liveOwnerSupervisor.stop();

for (const cleanup of [
  () => process.kill(-liveOwnerCase.group.pgid, "SIGKILL"),
  () => process.kill(liveOwner.pid, "SIGKILL"),
]) {
  try {
    cleanup();
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
}

// ── the attempt bound ─────────────────────────────────────────────────────
//
// A node whose supervisor keeps being killed is resumed for ever: every
// reconcile bumps the attempt counter and settles the node, and `maxAttempts`
// is only read for nodes already marked failed. The bound has to close that
// loop, or a node that crashes its supervisor every time is an infinite crash.

/** A turn an owner that is gone was running, with no child process group. */
function interruptNewTurn(root, { ownerPid, label }) {
  const seed = openJournal(root, { driver: "scripted" });
  try {
    const epoch = seed.registerSupervisor({ pid: ownerPid, driver: "scripted", childArgs: [], piVersion: "test" });
    seed.acquireLease({ nodeId: "n1", ownerPid, epoch, ttlMs: 600_000 });
    const turnId = seed.beginTurn("n1", {
      kind: "charter",
      promptText: `a turn ${label}`,
      sessionId: "fleet-n1-bound",
      supervisorEpoch: epoch,
    });
    seed.setNodeState("n1", "waiting_on_child");
    return { epoch, turnId };
  } finally {
    seed.close();
  }
}

function seedBoundNode(root) {
  const seed = openJournal(root, { driver: "scripted" });
  try {
    seed.addNode({
      nodeId: "n1",
      parentId: null,
      projectRoot: root,
      charterPath: join(root, "charter.md"),
      driver: "scripted",
      driverConfig: { steps: [{ op: "done" }], worldFile: join(root, "world.log") },
    });
  } finally {
    seed.close();
  }
}

function nodeView(root) {
  const reopened = openJournal(root, {});
  try {
    return { node: reopened.getNode("n1"), turns: reopened.turnsFor("n1") };
  } finally {
    reopened.close();
  }
}

const boundRoot = mkdtempSync(join(tmpdir(), "fleet-attempt-bound-"));
seedBoundNode(boundRoot);
const boundSupervisor = new Supervisor({
  root: boundRoot,
  driver: "scripted",
  cap: 3,
  tickMs: 60_000,
  control: false,
  maxAttempts: 3,
  log: () => {},
});
await boundSupervisor.start();

for (let attempt = 1; attempt <= 3; attempt += 1) {
  interruptNewTurn(boundRoot, { ownerPid: DEAD_PID + attempt, label: `interrupted on restart ${attempt}` });
  await boundSupervisor.reconcile();
  const view = nodeView(boundRoot);
  await check(`restart ${attempt}: the interrupted attempt is counted`, () => {
    assert.equal(view.node.attempts, attempt);
    assert.equal(view.turns.at(-1).state, "interrupted");
  });
}

await check("three interrupted attempts at a bound of three leave the node failed", () => {
  const { node } = nodeView(boundRoot);
  assert.equal(node.state, "failed", `node state ${node.state} after ${node.attempts} interrupted attempts`);
  assert.match(String(node.done_reason), /\b3\b/, `done_reason names the count: ${node.done_reason}`);
});

await check("a fourth restart does not drive a node that reached the bound", async () => {
  await boundSupervisor.reconcile();
  await boundSupervisor.tick();
  const { node, turns } = nodeView(boundRoot);
  assert.equal(turns.length, 3, `turn count ${turns.length}: a fourth turn was started`);
  assert.equal(node.state, "failed");
  assert.equal(boundSupervisor.active.size, 0, "nothing is driving the node");
});
await boundSupervisor.stop();

// The control: one interrupted turn, well below the bound, is resumed. The
// bound must not turn the ordinary crash recovery into a failure.
const resumeRoot = mkdtempSync(join(tmpdir(), "fleet-attempt-resume-"));
seedBoundNode(resumeRoot);
interruptNewTurn(resumeRoot, { ownerPid: DEAD_PID, label: "the only interruption" });
const resumeSupervisor = new Supervisor({
  root: resumeRoot,
  driver: "scripted",
  cap: 3,
  tickMs: 20,
  control: false,
  maxAttempts: 3,
  log: () => {},
});
await resumeSupervisor.start();

await check("control: one interruption below the bound is resumed, not failed", async () => {
  const done = await waitFor("the resumed node to finish", () => {
    const view = nodeView(resumeRoot);
    return view.turns.length >= 2 && view.turns.at(-1).state !== "in_progress" ? view : null;
  });
  assert.equal(done.node.attempts, 1);
  assert.equal(done.turns[1].kind, "recovery");
  assert.equal(done.node.state, "done");
});
await resumeSupervisor.stop();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
