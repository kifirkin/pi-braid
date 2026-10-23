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
 * Run: node test/runtime/fleet/test-ask-deadline.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
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
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
