/**
 * Test: an ask that nobody answers resolves to its declared default.
 *
 * A park with no deadline is a worker that looks alive and is not, which is the
 * failure the fleet's own pane model has. So the ask row carries a priority, a
 * proposed default and a deadline, and the deadline is a code path: when it
 * passes, the ask is answered from its own default, the answer is queued for
 * the node as an ordinary message, and the node takes another turn. It does not
 * sit parked.
 *
 * Also pinned: a parked node holds no lease and has no active drive, so the
 * scheduler's cap is spent on nodes that compute, never on nodes that wait.
 *
 * And the deadline is drained from one place, so an ask whose deadline passed
 * while no supervisor was running resolves the same way after a restart as it
 * does under a running one: the default is queued, and the node moves again.
 *
 * Run: node test/runtime/fleet/test-ask-deadline.mjs
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
import { Supervisor } from "../../../scripts/fleet/supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = resolve(HERE, "../../../scripts/fleet/supervisor.mjs");

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

async function waitFor(label, predicate, { timeoutMs = 8000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await sleep(intervalMs);
  }
  throw new Error(`timeout waiting for ${label}`);
}

// ── the journal-level path ──────────────────────────────────────────────────

const journalRoot = mkdtempSync(join(tmpdir(), "fleet-ask-journal-"));
const journal = openJournal(journalRoot, {});
journal.addNode({ nodeId: "n1", parentId: null, projectRoot: journalRoot, charterPath: join(journalRoot, "c.md") });

await check("an ask records a priority, a proposed default and a deadline", async () => {
  const ask = journal.recordAsk({
    token: "ask-priority",
    nodeId: "n1",
    priority: 7,
    question: "which target?",
    defaultAnswer: "target-B",
    deadlineAt: Date.now() + 60_000,
  });
  assert.equal(ask.priority, 7);
  assert.equal(ask.default_answer, "target-B");
  assert.ok(ask.deadline_at > ask.asked_at);
  assert.equal(ask.state, "open");
});

await check("open asks are ordered by priority, most urgent first", async () => {
  journal.recordAsk({
    token: "ask-low",
    nodeId: "n1",
    priority: 0,
    question: "whenever",
    defaultAnswer: "later",
    deadlineAt: Date.now() + 60_000,
  });
  assert.deepEqual(
    journal.openAsks("n1").map((ask) => ask.token),
    ["ask-priority", "ask-low"],
  );
});

await check("an ask past its deadline resolves to its own default and says nobody answered", async () => {
  const late = journal.recordAsk({
    token: "ask-late",
    nodeId: "n1",
    priority: 5,
    question: "which target?",
    defaultAnswer: "target-B",
    deadlineAt: Date.now() - 1000,
  });
  const expired = journal.expireAsks();
  assert.deepEqual(expired.map((ask) => ask.token), ["ask-late"]);
  const resolved = journal.getAsk(late.token);
  assert.equal(resolved.state, "answered");
  assert.equal(resolved.answer_text, "target-B");
  assert.equal(resolved.answer_source, "deadline-default");
  assert.ok(resolved.answered_at >= late.asked_at);
  assert.equal(journal.getAsk("ask-priority").state, "open", "a live ask is not touched");
});

journal.close();

// ── the supervisor-level path ───────────────────────────────────────────────

const root = mkdtempSync(join(tmpdir(), "fleet-ask-supervisor-"));
const worldFile = join(root, "world.log");
const seed = openJournal(root, { driver: "scripted" });
seed.addNode({
  nodeId: "n1",
  parentId: null,
  projectRoot: root,
  charterPath: join(root, "charter.md"),
  driver: "scripted",
  driverConfig: {
    steps: [{ op: "park", question: "Which target should this node write to?", defaultAnswer: "target-B", priority: 3 }],
    worldFile,
  },
});
seed.close();

const log = [];
const supervisor = new Supervisor({
  root,
  driver: "scripted",
  cap: 3,
  tickMs: 20,
  control: false,
  askTtlMs: 400,
  log: (line) => log.push(line),
});
await supervisor.start();

const parkedSample = await waitFor("the node to park on an ask", () => {
  const reopened = openJournal(root, {});
  try {
    const asks = reopened.openAsks("n1");
    if (asks.length === 0) return null;
    return {
      ask: asks[0],
      lease: reopened.liveLease("n1"),
      active: supervisor.active.has("n1"),
      node: reopened.getNode("n1"),
    };
  } finally {
    reopened.close();
  }
});

await check("the ask carries the node's priority and a real deadline", async () => {
  assert.equal(parkedSample.ask.priority, 3);
  assert.equal(parkedSample.ask.default_answer, "target-B");
  assert.ok(parkedSample.ask.deadline_at > Date.now() - 1000);
});

await check("a parked node frees its slot: no lease, no active drive", async () => {
  assert.equal(parkedSample.node.state, "waiting_on_human");
  assert.equal(parkedSample.lease, null);
  assert.equal(parkedSample.active, false);
});

await check("the deadline passes and the default is what the node gets", async () => {
  const answered = await waitFor("the ask to expire", () => {
    const reopened = openJournal(root, {});
    try {
      const ask = reopened.getAsk(parkedSample.ask.token);
      return ask.state === "answered" ? ask : null;
    } finally {
      reopened.close();
    }
  });
  assert.equal(answered.answer_source, "deadline-default");
  assert.equal(answered.answer_text, "target-B");
});

await check("the default is queued as an ordinary message the node then takes", async () => {
  const turns = await waitFor("the node's turn count to advance", () => {
    const reopened = openJournal(root, {});
    try {
      const list = reopened.turnsFor("n1");
      return list.length >= 2 && list.at(-1).state !== "in_progress" ? list : null;
    } finally {
      reopened.close();
    }
  });
  assert.equal(turns[0].state, "parked");
  assert.equal(turns[1].kind, "message");
  assert.match(turns[1].prompt_text, /target-B/, "the default is what the next turn was handed");
});

await supervisor.stop();

// ── a deadline that passed while no supervisor was running ────────────────
//
// A restart resolves an overdue ask to its default. Resolving it is not the
// whole job: unless the default is also queued as a message, the node has no
// open ask, no interrupted turn and no pending message, so the scheduler finds
// nothing to drive and the node stays parked forever.

/** The row shape a park leaves behind, with the deadline already in the past. */
function fabricateParkedNode(label, { deadlineOffsetMs }) {
  const parkedRoot = mkdtempSync(join(tmpdir(), `fleet-ask-${label}-`));
  const seedJournal = openJournal(parkedRoot, { driver: "scripted" });
  seedJournal.addNode({
    nodeId: "n1",
    parentId: null,
    projectRoot: parkedRoot,
    charterPath: join(parkedRoot, "charter.md"),
    driver: "scripted",
    driverConfig: { steps: [{ op: "append", text: "target-B" }, { op: "done" }], worldFile: join(parkedRoot, "world.log") },
  });
  const parkedTurn = seedJournal.beginTurn("n1", {
    kind: "charter",
    promptText: "work until a question stops you",
    sessionId: "fleet-n1-parked",
    supervisorEpoch: 1,
  });
  seedJournal.endTurn(parkedTurn, { state: "parked" });
  seedJournal.recordAsk({
    token: "ask-overdue",
    nodeId: "n1",
    turnId: parkedTurn,
    priority: 3,
    question: "Which target should this node write to?",
    defaultAnswer: "target-B",
    deadlineAt: Date.now() + deadlineOffsetMs,
  });
  seedJournal.setNodeState("n1", "waiting_on_human", { done_reason: "parked on ask-overdue" });
  seedJournal.close();
  return { root: parkedRoot, parkedTurn };
}

function inboxView(root) {
  const reopened = openJournal(root, {});
  try {
    return { messages: reopened.messages(), node: reopened.getNode("n1"), asks: reopened.openAsks() };
  } finally {
    reopened.close();
  }
}

const overdue = fabricateParkedNode("overdue", { deadlineOffsetMs: -60_000 });
const restartSupervisor = new Supervisor({
  root: overdue.root,
  driver: "scripted",
  cap: 3,
  tickMs: 20,
  control: false,
  log: () => {},
});
await restartSupervisor.start();

await check("a restart queues the default of an ask whose deadline passed while it was down", () => {
  const view = inboxView(overdue.root);
  assert.equal(view.asks.length, 0, "the ask is resolved");
  const answers = view.messages.filter((message) => message.kind === "answer");
  assert.equal(answers.length, 1, `exactly one answer row, got ${JSON.stringify(view.messages.map((message) => message.kind))}`);
  assert.equal(answers[0].body, "target-B");
  assert.equal(answers[0].token, "ask-overdue");
  assert.notEqual(view.node.state, "waiting_on_human", `the node is runnable again, not ${view.node.state}`);
});

await check("the node moves on its own after the restart", async () => {
  const turns = await waitFor("a message turn driven from the queued default", () => {
    const reopened = openJournal(overdue.root, {});
    try {
      const list = reopened.turnsFor("n1");
      const last = list.at(-1);
      return list.length >= 2 && last.state !== "in_progress" ? list : null;
    } finally {
      reopened.close();
    }
  });
  assert.equal(turns[1].kind, "message");
  assert.match(turns[1].prompt_text, /target-B/, "the queued default is what the next turn was handed");
});
await restartSupervisor.stop();

// The control: a deadline in the future is not a deadline that passed, so a
// restart must leave the ask open and the node parked.
const stillWaiting = fabricateParkedNode("future", { deadlineOffsetMs: 600_000 });
const patientSupervisor = new Supervisor({
  root: stillWaiting.root,
  driver: "scripted",
  cap: 3,
  tickMs: 20,
  control: false,
  log: () => {},
});
await patientSupervisor.start();
await sleep(200);

await check("control: a deadline in the future queues nothing and the node stays parked", () => {
  const view = inboxView(stillWaiting.root);
  assert.equal(view.asks.length, 1, "the ask is still open");
  assert.equal(view.messages.filter((message) => message.kind === "answer").length, 0, "no default is queued");
  assert.equal(view.node.state, "waiting_on_human");
});
await patientSupervisor.stop();

// One overdue ask, drained by more than one reconciler: the second drain must
// find the ask already resolved, so the default is queued once, not twice.
const sharedPark = fabricateParkedNode("shared", { deadlineOffsetMs: -60_000 });
const sharedSupervisor = new Supervisor({
  root: sharedPark.root,
  driver: "scripted",
  cap: 0,
  tickMs: 60_000,
  control: false,
  log: () => {},
});
await sharedSupervisor.start();
const secondDrainer = spawn(
  process.execPath,
  [SUPERVISOR, "--root", sharedPark.root, "--cap", "0", "--driver", "scripted"],
  { stdio: ["ignore", "ignore", "ignore"] },
);
await waitFor("a second supervisor process to register", () => {
  const reopened = openJournal(sharedPark.root, {});
  try {
    return reopened.supervisors().filter((row) => row.state === "live").length === 2;
  } finally {
    reopened.close();
  }
});
await sleep(400);
await sharedSupervisor.drainExpiredAsks();

await check("one overdue ask, three drains, one queued default", () => {
  const view = inboxView(sharedPark.root);
  assert.equal(view.messages.filter((message) => message.kind === "answer").length, 1);
});

secondDrainer.kill("SIGKILL");
await new Promise((resolveExit) => {
  if (secondDrainer.exitCode !== null || secondDrainer.signalCode !== null) resolveExit();
  else secondDrainer.once("exit", resolveExit);
});
await sharedSupervisor.stop();

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
