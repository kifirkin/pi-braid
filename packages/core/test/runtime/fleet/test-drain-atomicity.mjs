/**
 * Test: the expired-ask drain is one transaction, so it cannot half-happen.
 *
 * The drain does two things per ask: it claims the row (state becomes
 * `answered`) and it queues the default as an inbox message. A process that dies
 * between the two leaves an ask answered with nothing queued, and the node
 * parked on it has no open ask, no pending message and no ready kind, so nothing
 * ever drives it again. That is the parked-forever state the drain exists to
 * prevent, produced by the drain itself.
 *
 * Why this test exists at all. An earlier test called `journal.transaction()`
 * directly, which proves the helper rolls back but not that the drain uses it.
 * Measured by an independent pass: with the wrapper removed from
 * `drainExpiredAsks` and nothing else changed, that test and all eight other
 * fleet files stayed green across 88 assertions.
 *
 * Why it fails at a seam rather than by racing. The unprotected window is the
 * gap between one ask's claim commit and its message insert, which is
 * microseconds wide per ask. A random SIGKILL almost never lands there, so a
 * kill-based arm passes on both the fixed and the broken code and proves
 * nothing. The teeth have to come from failing the queue step deliberately,
 * which is what a database error in that window would do anyway.
 *
 * The kill arm is kept, at the bottom, as a coarse realistic check, and it is
 * labelled as coarse. It is not the assertion that pins the transaction.
 *
 * Run: node test/runtime/fleet/test-drain-atomicity.mjs
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
const ASK_COUNT = 40;

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
      deadlineAt: Date.now() - 60_000,
    });
  }
  journal.close();
}

/** Straight from SQL, never through the journal's own readers. */
function audit(root) {
  const journal = openJournal(root);
  const asks = journal._stmt("SELECT token, state FROM asks").all();
  const messages = journal._stmt("SELECT token, COUNT(*) AS n FROM inbox WHERE kind = 'answer' GROUP BY token").all();
  journal.close();
  const queued = new Map(messages.map((row) => [row.token, row.n]));
  const answered = asks.filter((ask) => ask.state === "answered").length;
  const open = asks.length - answered;
  const orphaned = asks.filter((ask) => (ask.state === "answered") !== (queued.get(ask.token) ?? 0) > 0);
  return { answered, open, total: asks.length, orphaned: orphaned.map((ask) => ask.token) };
}

if (process.argv[2] === "--drain") {
  const supervisor = new Supervisor({ root: process.argv[3], cap: 0, log: () => {} });
  process.stdout.write("ready\n");
  supervisor.drainExpiredAsks();
  supervisor.journal.close();
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

// ── control: an undisturbed drain answers every ask and queues one message ──
{
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-control-"));
  seed(root, ASK_COUNT);
  const supervisor = new Supervisor({ root, cap: 0, log: () => {} });
  supervisor.drainExpiredAsks();
  supervisor.journal.close();
  const state = audit(root);
  check(`an undisturbed drain answers every ask (${state.answered}/${state.total})`, () => {
    assert.equal(state.answered, ASK_COUNT);
    assert.equal(state.open, 0);
  });
  check("an undisturbed drain leaves no ask half-done", () => assert.deepEqual(state.orphaned, []));
  rmSync(root, { recursive: true, force: true });
}

// ── the teeth: fail the queue step part-way through, then read the store ────
// A throw here is what a busy database, a disk error or a full WAL would do in
// the same window. If the drain is one transaction, the claims made before the
// failure are rolled back with it and every ask is still open and recoverable.
// If it is not, the asks already claimed stay answered with no message and this
// is where the test fails.
{
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-seam-"));
  seed(root, ASK_COUNT);
  const supervisor = new Supervisor({ root, cap: 0, log: () => {} });
  const journal = supervisor.journal;

  const realAddMessage = journal.addMessage.bind(journal);
  let inserts = 0;
  journal.addMessage = (message) => {
    inserts += 1;
    if (inserts === 5) throw new Error("injected queue failure");
    return realAddMessage(message);
  };

  let threw = null;
  try {
    supervisor.drainExpiredAsks();
  } catch (error) {
    threw = error;
  }
  journal.addMessage = realAddMessage;
  const connectionSurvives = (() => {
    try {
      journal._stmt("SELECT COUNT(*) AS n FROM asks").get();
      return true;
    } catch {
      return false;
    }
  })();
  journal.close();

  const state = audit(root);
  check("a queue failure in the middle of the drain propagates", () => {
    assert.ok(threw, "the drain swallowed the failure");
    assert.match(threw.message, /injected queue failure/);
  });
  check("the four claims made before the failure are rolled back", () => {
    assert.equal(state.answered, 0, `${state.answered} ask(s) stayed answered: the drain is not one transaction`);
    assert.equal(state.open, ASK_COUNT);
  });
  check("no ask is left answered without a message", () => assert.deepEqual(state.orphaned, []));
  check("the connection is usable after the rollback", () => assert.equal(connectionSurvives, true));

  // And the evidence the state is recoverable: a fresh drain does the whole job.
  const retry = new Supervisor({ root, cap: 0, log: () => {} });
  retry.drainExpiredAsks();
  retry.journal.close();
  const after = audit(root);
  check(`a retry after the rollback drains everything (${after.answered}/${after.total})`, () => {
    assert.equal(after.answered, ASK_COUNT);
    assert.deepEqual(after.orphaned, []);
  });
  rmSync(root, { recursive: true, force: true });
}

// ── coarse and realistic, and labelled as coarse ────────────────────────────
// A SIGKILL from another process is the failure this subsystem is built around.
// It is kept because it exercises SQLite's own recovery rather than JavaScript
// control flow, but the window it can hit is per ask and microseconds wide, so a
// pass here is not evidence the transaction is in place. The seam arm above is.
{
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-kill-"));
  seed(root, ASK_COUNT);
  const child = spawn(process.execPath, [SELF, "--drain", root], { stdio: ["ignore", "pipe", "inherit"] });
  await new Promise((resolveReady) => {
    child.stdout.on("data", (chunk) => {
      if (chunk.toString("utf8").includes("ready")) resolveReady();
    });
    child.once("exit", resolveReady);
  });
  await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  child.kill("SIGKILL");
  await new Promise((resolveExit) => child.once("exit", () => resolveExit()));
  const state = audit(root);
  console.log(`  SIGKILL mid-drain: answered=${state.answered} open=${state.open}`);
  check("a SIGKILL mid-drain leaves no ask half-done", () => {
    assert.deepEqual(state.orphaned, []);
    assert.equal(state.answered + state.open, ASK_COUNT);
  });
  check("the store is recoverable after the kill: a fresh drain completes", () => {
    const retry = new Supervisor({ root, cap: 0, log: () => {} });
    retry.drainExpiredAsks();
    retry.journal.close();
    const after = audit(root);
    assert.equal(after.answered, ASK_COUNT);
    assert.deepEqual(after.orphaned, []);
  });
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll drain-atomicity assertions passed." : `\n${failures} assertion(s) failed.`);
process.exitCode = failures > 0 ? 1 : 0;
