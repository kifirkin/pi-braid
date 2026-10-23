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
import { groupIsAlive } from "../../../scripts/fleet/procs.mjs";
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

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
