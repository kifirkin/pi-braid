/**
 * Test: two supervisors draining the same overdue asks must not duplicate one.
 *
 * An ask whose deadline passes is answered from its own default, and that
 * default is queued as an ordinary message so the node moves again. The drain
 * therefore has two halves that must not both be done twice: the row must be
 * claimed once, and exactly one message must be queued for it.
 *
 * `expireAsks()` used to return the set it READ rather than the set it CLAIMED.
 * One drainer is indistinguishable either way. Two supervisors starting
 * together on a root that lost its supervisor mid-park are not: each read the
 * same overdue rows before the other had resolved them, and each queued a copy,
 * so a node's next prompt carried its default twice. Measured before the fix:
 * 200 overdue asks, two processes started together, 400 answer rows and 200
 * duplicated tokens in four runs of five.
 *
 * The claim is now the conditional UPDATE, and only what `changes` reports is
 * returned, so the loser of the race queues nothing.
 *
 * Both halves are asserted, because a fix that stops duplicates by losing asks
 * is not a fix: no token may appear twice, AND every ask must be queued exactly
 * once. The interleaving is real rather than hypothetical, so the arms repeat
 * and the split between the two drainers is reported: a run where one drainer
 * takes everything is a legitimate sample, not a vacuous one, and the totals are
 * what the assertions rest on.
 *
 * Run: node test/runtime/fleet/test-drain-race.mjs
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
import { Supervisor } from "../../../scripts/fleet/supervisor.mjs";

const SELF = fileURLToPath(import.meta.url);
const ASK_COUNT = 200;
const RUNS = 3;

/** Park `count` nodes, each with one ask whose deadline is a minute past. */
function seed(root, count) {
  const journal = openJournal(root);
  for (let i = 1; i <= count; i += 1) {
    const nodeId = `n${i}`;
    journal.addNode({
      nodeId,
      parentId: null,
      projectRoot: root,
      charterPath: join(root, "charter.md"),
      driver: "scripted",
      driverConfig: "{}",
    });
    journal.setNodeState(nodeId, "waiting_on_human");
    journal.recordAsk({
      token: `ask-${nodeId}`,
      nodeId,
      turnId: null,
      priority: 3,
      question: "which target?",
      defaultAnswer: `DEFAULT-${i}`,
      // A number, because that is what the CLI stores: `Date.now() + ttlMs`.
      deadlineAt: Date.now() - 60_000,
    });
  }
  journal.close();
}

/** One drainer, in its own process: claim, then queue exactly what was claimed. */
function drain(root, tag) {
  const journal = openJournal(root);
  let claimed = 0;
  for (const ask of journal.expireAsks()) {
    journal.addMessage({
      msgId: `m-${tag}-${ask.token}`,
      nodeId: ask.node_id,
      kind: "answer",
      body: ask.default_answer,
      token: ask.token,
    });
    claimed += 1;
  }
  journal.close();
  process.stdout.write(`${claimed}\n`);
}

function readTotals(root) {
  const journal = openJournal(root);
  const rows = journal.messages().filter((message) => message.kind === "answer");
  const byToken = new Map();
  for (const row of rows) byToken.set(row.token, (byToken.get(row.token) ?? 0) + 1);
  const duplicated = [...byToken.values()].filter((count) => count > 1).length;
  const open = journal.openAsks().length;
  journal.close();
  return { rows: rows.length, distinct: byToken.size, duplicated, open };
}

/** Run one child drainer and resolve with how many asks it claimed. */
function runDrainer(root, tag) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [SELF, "--drain", root, tag], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    child.stdout.on("data", (chunk) => {
      out += chunk.toString("utf8");
    });
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code !== 0) reject(new Error(`drainer ${tag} exited ${code}`));
      else resolvePromise(Number(out.trim()) || 0);
    });
  });
}

if (process.argv[2] === "--drain") {
  drain(process.argv[3], process.argv[4]);
  process.exit(0);
}

let failures = 0;
function check(name, body) {
  try {
    body();
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`  [FAIL] ${name}\n         ${error.message}`);
  }
}

// ── one drainer: the control, which was never the broken case ───────────────
{
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-single-"));
  seed(root, ASK_COUNT);
  const claimed = await runDrainer(root, "solo");
  const totals = readTotals(root);
  check(`one drainer claims every overdue ask (${claimed}/${ASK_COUNT})`, () => {
    assert.equal(claimed, ASK_COUNT);
  });
  check(`one drainer queues exactly one message per ask (${totals.rows} rows, ${totals.distinct} tokens)`, () => {
    assert.equal(totals.rows, ASK_COUNT);
    assert.equal(totals.distinct, ASK_COUNT);
    assert.equal(totals.duplicated, 0);
  });
  check("one drainer leaves no ask open", () => assert.equal(totals.open, 0));
  rmSync(root, { recursive: true, force: true });
}

// ── two drainers: the arm that failed before the fix ────────────────────────
for (let run = 1; run <= RUNS; run += 1) {
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-race-"));
  seed(root, ASK_COUNT);
  const [a, b] = await Promise.all([runDrainer(root, "a"), runDrainer(root, "b")]);
  const totals = readTotals(root);

  check(`run ${run}: two drainers split the claims without overlap (a=${a} b=${b})`, () => {
    // The split varies with scheduling; the invariants are the total and the
    // absence of overlap. A drainer that loses the race legitimately claims 0.
    assert.equal(a + b, ASK_COUNT);
  });
  check(`run ${run}: no ask is queued twice (${totals.rows} rows, ${totals.distinct} tokens)`, () => {
    assert.equal(totals.duplicated, 0);
    assert.equal(totals.rows, totals.distinct);
  });
  check(`run ${run}: no ask is lost (${totals.rows}/${ASK_COUNT})`, () => {
    assert.equal(totals.rows, ASK_COUNT);
  });
  check(`run ${run}: every ask is answered`, () => assert.equal(totals.open, 0));
  rmSync(root, { recursive: true, force: true });
}

// ── the second half: a drain must not resurrect a finished node ─────────────
// This arm drives the SUPERVISOR's drain, not the journal's claim: the guard
// lives in `drainExpiredAsks`, and a test that queues from the journal directly
// would assert against its own helper.
{
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-done-"));
  const journal = openJournal(root);
  journal.addNode({
    nodeId: "n-done",
    parentId: null,
    projectRoot: root,
    charterPath: join(root, "charter.md"),
    driver: "scripted",
    driverConfig: "{}",
  });
  journal.setNodeState("n-done", "done", { done_reason: "finished" });
  journal.recordAsk({
    token: "ask-done",
    nodeId: "n-done",
    turnId: null,
    priority: 3,
    question: "late question",
    defaultAnswer: "DEFAULT-DONE",
    deadlineAt: Date.now() - 60_000,
  });
  journal.close();

  const supervisor = new Supervisor({ root, cap: 0 });
  const claimed = supervisor.drainExpiredAsks();
  supervisor.journal.close();

  const after = openJournal(root);
  const node = after.getNode("n-done");
  const answers = after.messages("n-done").filter((message) => message.kind === "answer");
  const stillOpen = after.openAsks().length;
  after.close();

  check(`the supervisor drain claims the overdue ask on a done node (${claimed.length})`, () => {
    assert.equal(claimed.length, 1);
    assert.equal(stillOpen, 0, "the ask is answered rather than left open");
  });
  check("a done node stays done", () => assert.equal(node.state, "done"));
  check("no default is queued for a done node", () => assert.equal(answers.length, 0));
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll drain-race assertions passed." : `\n${failures} assertion(s) failed.`);
process.exitCode = failures > 0 ? 1 : 0;
