/**
 * Test: an idle supervisor leaves, and only when it is idle.
 *
 * A supervisor that idles forever holds a journal open, a lease renewal timer
 * and a socket for nothing: the design's "blocked worker that looks alive" one
 * level up. So the fleet has to be able to end. Ending is the dangerous half,
 * though, because a node is registered *before* the supervisor that drives it
 * is started. An exit that fires on one empty sample would orphan that node; an
 * exit that is never checked would never happen.
 *
 * "Idle" is capacity-aware. A runnable node is work only when this process could
 * drive it: at cap 0 the drive loop never runs, so a node the scheduler would
 * name is a node this supervisor is structurally unable to start. Counting it as
 * work is how a cap-0 supervisor outlives its usefulness while holding a journal
 * full of nodes it will never drive. What stays work at any cap is what a cap-0
 * supervisor still does: an open ask (it drains the default), a turn in this
 * process, and a lease this epoch holds.
 *
 * The subject is the process, not a line in its log: every check here reads the
 * pid the kernel holds and the exit code, and the last arm kills a supervisor
 * itself, so the instrument does not share a path with the thing measuring it.
 *
 *   exit: empty          cap 0, empty root, nothing to do
 *   exit: runnable       cap 0, one runnable node it cannot drive
 *   exit: ask            cap 0, one overdue ask: drain the default, queue it, leave
 *   exit: inbox          cap 0, one unread message it cannot deliver
 *   control: open ask    cap 0, a node parked on an ask whose deadline is future
 *   control: inbox       cap 1, an unread message: deliver it, do not leave first
 *   control: turn        cap 1, a turn in flight
 *   control: registered  cap 1, a node registered before the start is driven
 *
 * Run: node test/runtime/fleet/test-supervisor-idle.mjs
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
import { pidIsAlive } from "../../../scripts/fleet/procs.mjs";
import { controlSocketPath } from "../../../scripts/fleet/supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = resolve(HERE, "../../../scripts/fleet/supervisor.mjs");

// Short enough that the arms finish in a few seconds, long enough that a single
// sample of an empty journal is not what decides the exit.
const IDLE_MS = 600;
const ALIVE_PROBE_MS = IDLE_MS * 3;

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

async function waitFor(label, predicate, { timeoutMs = 15_000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

const roots = [];
function freshRoot(label) {
  const root = mkdtempSync(join(tmpdir(), `fleet-idle-${label}-`));
  roots.push(root);
  return root;
}

/** A real supervisor process, spawned the way the CLI spawns one. */
const spawned = [];
function startSupervisor(root, extraArgs = []) {
  const child = spawn(
    process.execPath,
    [SUPERVISOR, "--root", root, "--driver", "scripted", "--idle-exit-ms", String(IDLE_MS), ...extraArgs],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const log = [];
  child.stdout.on("data", (chunk) => log.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => log.push(chunk.toString("utf8")));
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const running = { child, pid: child.pid, exited, log: () => log.join("") };
  spawned.push(running);
  return running;
}

function journalView(root) {
  const journal = openJournal(root, {});
  try {
    return {
      supervisors: journal.supervisors(),
      nodes: journal.listNodes(),
      turns: journal.allOpenTurns(),
      asks: journal.openAsks(),
      messages: journal.messages(),
    };
  } finally {
    journal.close();
  }
}

function seedNode(root, steps, nodeId = "n1") {
  const journal = openJournal(root, { driver: "scripted" });
  try {
    journal.addNode({
      nodeId,
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

/** A node that finished one turn and has a message nobody has read. */
function seedReadInbox(root, steps) {
  seedNode(root, steps);
  const journal = openJournal(root, { driver: "scripted" });
  try {
    const turnId = journal.beginTurn("n1", {
      kind: "charter",
      promptText: "work",
      sessionId: "fleet-n1-inbox",
      supervisorEpoch: 1,
    });
    journal.endTurn(turnId, { state: "done" });
    journal.setNodeState("n1", "settled", { done_reason: "charter reported done" });
    journal.addMessage({ msgId: "m-unread", nodeId: "n1", kind: "user", body: "an instruction nobody has read yet" });
  } finally {
    journal.close();
  }
}

/** A park: a parked turn, a waiting node, and an ask with the given deadline. */
function seedParkedAsk(root, deadlineOffsetMs) {
  seedNode(root, [{ op: "done" }]);
  const journal = openJournal(root, { driver: "scripted" });
  try {
    const turnId = journal.beginTurn("n1", {
      kind: "charter",
      promptText: "park",
      sessionId: "fleet-n1-ask",
      supervisorEpoch: 1,
    });
    journal.endTurn(turnId, { state: "parked" });
    journal.recordAsk({
      token: "ask-open",
      nodeId: "n1",
      turnId,
      priority: 2,
      question: "which target?",
      defaultAnswer: "target-B",
      deadlineAt: Date.now() + deadlineOffsetMs,
    });
    journal.setNodeState("n1", "waiting_on_human");
  } finally {
    journal.close();
  }
}

async function stopSupervisor(running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  running.child.kill("SIGKILL");
  await running.exited;
}

/** The process must end by itself, cleanly, within a bounded time. */
async function expectExit(running, label) {
  const exitedInTime = await Promise.race([running.exited.then(() => true), sleep(8000).then(() => false)]);
  assert.equal(exitedInTime, true, `${label}: still running after 8000 ms (window ${IDLE_MS} ms):\n${running.log()}`);
  await waitFor(`${label}: the kernel to drop the pid`, () => !pidIsAlive(running.pid), { timeoutMs: 2000 });
  assert.equal(pidIsAlive(running.pid), false, `${label}: the process is gone, not merely finished with a line`);
  assert.equal(running.child.exitCode, 0, `${label}: exit code ${running.child.exitCode}\n${running.log()}`);
}

/** The process must still be there after the window, because it has work. */
async function expectAlive(running, label) {
  await sleep(ALIVE_PROBE_MS);
  assert.equal(pidIsAlive(running.pid), true, `${label}: gone after ${ALIVE_PROBE_MS} ms:\n${running.log()}`);
  assert.equal(running.child.exitCode, null);
}

// ── exits: nothing this process can act on ─────────────────────────────────

const emptyRoot = freshRoot("empty");
const empty = startSupervisor(emptyRoot, ["--cap", "0"]);
await waitFor("the supervisor to register", () => journalView(emptyRoot).supervisors.some((row) => row.state === "live"));
await check("empty root, cap 0: the supervisor process ends by itself", async () => {
  await expectExit(empty, "empty root");
});
await check("empty root, cap 0: it stopped cleanly on the way out", () => {
  const view = journalView(emptyRoot);
  assert.equal(view.supervisors.at(-1).state, "stopped", "the journal says stopped, not dead");
  assert.equal(existsSync(controlSocketPath(emptyRoot)), false, "the control socket is removed");
});

// The node is runnable (never driven, so the scheduler would name its charter)
// and this supervisor is incapable of driving it. That is not work.
const runnableRoot = freshRoot("runnable");
seedNode(runnableRoot, [{ op: "done" }]);
const runnable = startSupervisor(runnableRoot, ["--cap", "0"]);
await waitFor("the supervisor to register", () => journalView(runnableRoot).supervisors.some((row) => row.state === "live"));
await check("cap 0 with one runnable node it cannot drive: the supervisor leaves", async () => {
  const view = journalView(runnableRoot);
  assert.equal(view.nodes.length, 1);
  assert.equal(view.nodes[0].turn_count, 0, "the node has never been driven, so its charter is what the scheduler would name");
  await expectExit(runnable, "runnable node at cap 0");
  const after = journalView(runnableRoot);
  assert.equal(after.nodes[0].state, "settled", "the node is left runnable in the journal, for whoever has capacity");
  assert.equal(after.nodes[0].turn_count, 0, "this process never drove it");
});

// A cap-0 supervisor does drain an expired ask, because the drain runs before
// the cap gate. Once the default is queued there is nothing left it can do: the
// queued answer waits for a supervisor that can drive.
const askDrainRoot = freshRoot("ask-drain");
seedParkedAsk(askDrainRoot, -60_000);
const askDrain = startSupervisor(askDrainRoot, ["--cap", "0"]);
await check("cap 0 with one overdue ask: the default is drained, queued, and the supervisor leaves", async () => {
  await expectExit(askDrain, "overdue ask at cap 0");
  const view = journalView(askDrainRoot);
  assert.equal(view.asks.length, 0, "the ask is resolved");
  const answers = view.messages.filter((message) => message.kind === "answer");
  assert.equal(answers.length, 1, `exactly one answer row, got ${JSON.stringify(view.messages.map((message) => message.kind))}`);
  assert.equal(answers[0].body, "target-B");
  assert.equal(answers[0].token, "ask-open");
  assert.equal(answers[0].state, "recorded", "the queued answer waits for a supervisor that can drive");
  assert.notEqual(view.nodes[0].state, "waiting_on_human");
});

// An unread message with no capacity behind it: the journal keeps it, and the
// process that cannot deliver it does not stay to hold the journal open.
const inboxRoot = freshRoot("inbox-exit");
seedReadInbox(inboxRoot, [{ op: "done" }]);
const inboxExit = startSupervisor(inboxRoot, ["--cap", "0"]);
await check("cap 0 with an unread message it cannot deliver: the supervisor leaves", async () => {
  await expectExit(inboxExit, "unread message at cap 0");
  const view = journalView(inboxRoot);
  assert.equal(view.messages.filter((message) => message.state === "recorded").length, 1, "the message waits in the journal");
  assert.equal(view.turns.length, 0, "no turn was started");
});

// ── controls: work keeps it alive ─────────────────────────────────────────

const openAskRoot = freshRoot("open-ask");
seedParkedAsk(openAskRoot, 600_000);
const openAsk = startSupervisor(openAskRoot, ["--cap", "0"]);
await check("control: an open ask whose deadline is future keeps a cap-0 supervisor up", async () => {
  await expectAlive(openAsk, "open ask");
  const view = journalView(openAskRoot);
  assert.equal(view.asks.length, 1, "the ask is still open, so this is the control it claims to be");
});
await stopSupervisor(openAsk);

// Capacity behind the message is the difference: with a slot, the same row is
// deliverable, so the supervisor must deliver it rather than leave first.
const deliverRoot = freshRoot("deliver");
seedReadInbox(deliverRoot, [{ op: "sleep", ms: 3000 }]);
const delivering = startSupervisor(deliverRoot, ["--cap", "1"]);
await check("control: with a slot, an unread message is delivered, not left behind", async () => {
  await expectAlive(delivering, "unread message at cap 1");
  const view = journalView(deliverRoot);
  const turn = view.turns.at(-1);
  assert.ok(turn, "a turn is running");
  assert.equal(turn.state, "in_progress");
  const journal = openJournal(deliverRoot, {});
  try {
    assert.equal(journal.turnsFor("n1").at(-1).kind, "message", "the turn this supervisor started is the delivery");
    assert.match(journal.turnsFor("n1").at(-1).prompt_text, /an instruction nobody has read yet/, "the body reached the node");
  } finally {
    journal.close();
  }
});
await stopSupervisor(delivering);

const turnRoot = freshRoot("turn");
seedNode(turnRoot, [{ op: "sleep", ms: 5000 }]);
const turnInFlight = startSupervisor(turnRoot, ["--cap", "1"]);
await check("control: a turn in flight keeps the supervisor up", async () => {
  await waitFor("a turn to be in flight", () => journalView(turnRoot).turns.some((turn) => turn.state === "in_progress")).catch(
    (error) => {
      throw new Error(`${error.message}\n${turnInFlight.log()}`);
    },
  );
  await expectAlive(turnInFlight, "turn in flight");
  assert.ok(
    journalView(turnRoot).turns.some((turn) => turn.state === "in_progress"),
    `the turn is still running, so this is the control it claims to be:\n${turnInFlight.log()}`,
  );
});
await stopSupervisor(turnInFlight);

// The positive control for the window itself: a node registered before the
// supervisor starts is work the first tick can see, and it must be driven
// rather than exited from.
const spawnRoot = freshRoot("spawn");
const worldFile = join(spawnRoot, "world.log");
writeFileSync(join(spawnRoot, "charter.md"), "appended by the node, not by this test");
seedNode(spawnRoot, [{ op: "append", text: "driven-after-start" }, { op: "done" }]);
const lateStart = startSupervisor(spawnRoot, ["--cap", "1"]);

await check("control: a node registered before the start is driven, then the supervisor leaves", async () => {
  const done = await waitFor("the node to be driven to done", () => {
    const journal = openJournal(spawnRoot, {});
    try {
      const node = journal.getNode("n1");
      return node.state === "done" ? node : null;
    } finally {
      journal.close();
    }
  });
  assert.equal(done.state, "done");
  assert.equal(readFileSync(worldFile, "utf8").trim(), "driven-after-start", "the node performed its effect");
  await expectExit(lateStart, "work done");
});

await stopSupervisor(lateStart);

// A failed arm must not leave a supervisor holding this process's event loop.
for (const running of spawned) await stopSupervisor(running);

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
