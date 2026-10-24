/**
 * Test: a drain that meets the write lock waits, and a drain that cannot finish
 * is a journal fact rather than an exit code.
 *
 * The failure this pins, measured on `main`: `test-drain-race.mjs` failed once
 * in a full-suite run with `database is locked` and `drainer b exited 1`, then
 * passed twice on immediate re-runs. Two drainers on one store is the ordinary
 * case the drain is built for, so a throw there is a product defect: the
 * journal waited 5s for the write lock, a legitimate drain under load took
 * longer, and the exception reached a caller whose only handling was a log line.
 *
 * Three arms, each with the lock held by a second real process - a same-process
 * lock would be re-entrant and would test nothing:
 *
 *   A. the measured case. The lock is held for longer than the old 5s timeout
 *      and the drain completes after it is released: it waited, and the journal
 *      says how long the wait was (`drain_contention`).
 *   B. contention longer than one bounded attempt. The drain runs out of its
 *      window, backs off, and completes on a later attempt; the fact records
 *      the attempt number, so the retry path is visible rather than inferred.
 *   C. contention for the whole budget. The drain gives up: it returns nothing
 *      and throws nothing, and the store is asked again once the lock is free,
 *      at which point the deferral is a journal row (`drain_deferred`, with the
 *      attempts and the error) and the asks are drained.
 *
 * The facts are read back with raw SQL over the file through `node:sqlite`, not
 * through the journal's own accessors: an instrument that shares the code under
 * test cannot witness that code's silence. The control is the same file run
 * against the pre-fix drain, which throws in arm A - the report carries that
 * run, and the arm asserts on elapsed time as well as on the absence of a
 * throw, so a drain that somehow returned early cannot pass it.
 *
 * Run: node test/runtime/fleet/test-drain-contention.mjs
 */

import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
import { Supervisor } from "../../../scripts/fleet/supervisor.mjs";

const SELF = fileURLToPath(import.meta.url);
/** Enough asks that the drain does real work; the lock, not the count, is the subject. */
const ASK_COUNT = 20;

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
      deadlineAt: Date.now() - 60_000,
    });
  }
  journal.close();
}

/**
 * The facts, straight out of the file: meta rows, the ask states, and the
 * answer rows the drain queues. No journal code is in this path.
 */
function readFacts(root) {
  const db = new DatabaseSync(join(root, "fleet.sqlite"));
  try {
    const meta = Object.fromEntries(
      db
        .prepare("SELECT key, value FROM fleet_meta")
        .all()
        .map((row) => [row.key, row.value]),
    );
    const asks = Object.fromEntries(
      db
        .prepare("SELECT state, COUNT(*) AS n FROM asks GROUP BY state")
        .all()
        .map((row) => [row.state, Number(row.n)]),
    );
    const answers = Number(db.prepare("SELECT COUNT(*) AS n FROM inbox WHERE kind = 'answer'").get().n);
    const duplicatedTokens = Number(
      db.prepare("SELECT COUNT(*) AS n FROM (SELECT token FROM inbox WHERE kind = 'answer' GROUP BY token HAVING COUNT(*) > 1)").get().n,
    );
    const json = (key) => (meta[key] ? JSON.parse(meta[key]) : null);
    return { meta, asks, answers, duplicatedTokens, deferred: json("drain_deferred"), waited: json("drain_contention") };
  } finally {
    db.close();
  }
}

/**
 * A child process whose stdout is read both as text (to sequence the lock) and
 * as JSON report lines (one per drain round). Lines and needles are matched on
 * a raw buffer that is never consumed, so a chunk boundary cannot lose one.
 */
function watchChild(child) {
  let raw = "";
  let pending = "";
  let stderr = "";
  const textWaiters = [];
  const reportWaiters = [];
  const reports = [];
  const scan = () => {
    for (let i = textWaiters.length - 1; i >= 0; i -= 1) {
      if (!raw.includes(textWaiters[i].needle)) continue;
      const [waiter] = textWaiters.splice(i, 1);
      clearTimeout(waiter.timer);
      waiter.resolve();
    }
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index);
      pending = pending.slice(index + 1);
      if (!line.startsWith("{")) continue;
      const report = JSON.parse(line);
      const waiter = reportWaiters.shift();
      if (waiter) waiter(report);
      else reports.push(report);
    }
  };
  child.stdout.on("data", (chunk) => {
    const text = chunk.toString("utf8");
    raw += text;
    pending += text;
    scan();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });
  const exited = new Promise((resolvePromise, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolvePromise({ code, signal }));
  });
  return {
    child,
    exited,
    get text() {
      return raw;
    },
    get stderr() {
      return stderr;
    },
    waitForText(needle, timeoutMs = 20_000) {
      return new Promise((resolvePromise, reject) => {
        if (raw.includes(needle)) {
          resolvePromise();
          return;
        }
        const waiter = { needle, resolve: resolvePromise };
        waiter.timer = setTimeout(() => {
          textWaiters.splice(textWaiters.indexOf(waiter), 1);
          reject(new Error(`timed out waiting for ${JSON.stringify(needle)}; saw: ${JSON.stringify(raw)}`));
        }, timeoutMs);
        textWaiters.push(waiter);
      });
    },
    nextReport() {
      const ready = reports.shift();
      if (ready) return Promise.resolve(ready);
      return new Promise((resolvePromise) => reportWaiters.push(resolvePromise));
    },
  };
}

/**
 * The choreography every arm uses: a drainer that is already open and waiting,
 * then a lock holder that answers `locked`, then the drainer's go.
 *
 * The drainer has to open the store before the lock is taken: opening writes
 * the journal's own seed rows, and a child that cannot open would be measuring
 * its own startup rather than the drain.
 */
async function drainWhileLocked(root, holdMs, options) {
  const drainer = watchChild(spawn(process.execPath, [SELF, "--drain", root, JSON.stringify(options)], { stdio: ["pipe", "pipe", "pipe"] }));
  await drainer.waitForText("ready\n");
  const holder = watchChild(spawn(process.execPath, [SELF, "--hold", root, String(holdMs)], { stdio: ["ignore", "pipe", "pipe"] }));
  await holder.waitForText("locked\n");

  const started = Date.now();
  drainer.child.stdin.write("go\n");
  const report = await drainer.nextReport();
  return { drainer, holder, report, elapsedMs: Date.now() - started };
}

/** Wait for a child to exit, bounded, and return its exit record. */
function exitWithin(watcher, ms, what) {
  return Promise.race([
    watcher.exited,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} did not exit within ${ms}ms`)), ms)),
  ]);
}

// ── child modes ────────────────────────────────────────────────────────────

if (process.argv[2] === "--hold") {
  const [, , , root, ms] = process.argv;
  const journal = openJournal(root);
  journal.db.exec("BEGIN IMMEDIATE");
  // A real write inside the transaction: a lock with nothing pending behind it
  // is not the state a concurrent drainer meets.
  journal.setMeta("lock_probe", String(Date.now()));
  process.stdout.write("locked\n");
  await new Promise((resolveWait) => setTimeout(resolveWait, Number(ms)));
  journal.db.exec("COMMIT");
  journal.close();
  process.stdout.write("released\n");
  process.exit(0);
}

if (process.argv[2] === "--drain") {
  const [, , , root, optionsJson] = process.argv;
  const options = JSON.parse(optionsJson ?? "{}");
  const rounds = Math.max(1, Number(options.rounds ?? 1));
  delete options.rounds;
  const supervisor = new Supervisor({ root, cap: 0, log: () => {}, ...options });
  process.stdout.write("ready\n");
  // One report per round, each after its own go: a drain that gave up is
  // followed by another one in the same process, the way a tick would.
  for (let round = 1; round <= rounds; round += 1) {
    await new Promise((resolveWait) => {
      process.stdin.resume();
      process.stdin.once("data", resolveWait);
    });
    const started = Date.now();
    let claimed = null;
    let threw = null;
    try {
      claimed = supervisor.drainExpiredAsks().length;
    } catch (error) {
      threw = error.message;
    }
    const waitedMs = Date.now() - started;
    process.stdout.write(`${JSON.stringify({ round, claimed, threw, waitedMs })}\n`);
  }
  supervisor.journal.close();
  process.exit(0);
}

// ── the arms ───────────────────────────────────────────────────────────────

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

// ── A. the measured case: contention past the old timeout, waited out ──────
// 6200 ms is 1.2s beyond the 5s window that used to end in
// `database is locked`, so the arm cannot pass by being fast.
{
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-contention-"));
  seed(root, ASK_COUNT);
  const holdMs = 6_200;
  const run = await drainWhileLocked(root, holdMs, {});
  const result = run.report;
  const drainerExit = await exitWithin(run.drainer, 10_000, "the drainer");
  assert.equal((await exitWithin(run.holder, 10_000, "the lock holder")).code, 0, `the holder exits 0: ${run.holder.stderr}`);
  const facts = readFacts(root);

  check(`A: the drain waits out a ${holdMs}ms lock instead of throwing (waited ${result.waitedMs}ms, exit ${drainerExit.code})`, () => {
    assert.equal(result.threw, null, `the drain threw: ${result.threw}`);
    assert.equal(drainerExit.code, 0, "the drainer process exits 0");
    assert.ok(
      result.waitedMs >= holdMs - 100,
      `the drain returned after ${result.waitedMs}ms, before the ${holdMs}ms lock was released: it did not wait`,
    );
  });
  check(`A: the drain claims and queues every overdue ask (${result.claimed}/${ASK_COUNT})`, () => {
    assert.equal(result.claimed, ASK_COUNT);
    assert.equal(facts.answers, ASK_COUNT, "one answer row per claimed ask");
    assert.equal(facts.duplicatedTokens, 0, "no ask is queued twice");
    assert.equal(facts.asks.open ?? 0, 0, "no ask is left open");
  });
  check(`A: the journal records the wait (attempt ${facts.waited?.attempts}, ${facts.waited?.waitedMs}ms)`, () => {
    assert.ok(facts.waited, "the drain left no drain_contention row behind");
    assert.equal(facts.waited.attempts, 1, "a wait inside the first window is one attempt");
    assert.ok(facts.waited.waitedMs >= holdMs - 100, `the recorded wait is ${facts.waited.waitedMs}ms`);
    assert.equal(facts.deferred, null, "a drain that completed is not recorded as deferred");
  });
  rmSync(root, { recursive: true, force: true });
}

// ── B. contention past one attempt: the retry path completes the drain ─────
{
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-retry-"));
  seed(root, ASK_COUNT);
  const holdMs = 1_200;
  const run = await drainWhileLocked(root, holdMs, {
    drainBusyTimeoutMs: 250,
    drainAttempts: 10,
    drainBackoffMs: 100,
  });
  const result = run.report;
  await exitWithin(run.drainer, 10_000, "the drainer");
  await exitWithin(run.holder, 10_000, "the lock holder");
  const facts = readFacts(root);

  check(`B: a drain that runs out of its window retries and completes (${result.claimed}/${ASK_COUNT})`, () => {
    assert.equal(result.threw, null, `the drain threw: ${result.threw}`);
    assert.equal(result.claimed, ASK_COUNT);
    assert.equal(facts.asks.open ?? 0, 0);
  });
  check(`B: the journal records how many attempts it took (${facts.waited?.attempts})`, () => {
    assert.ok(facts.waited, "the retried drain left no drain_contention row behind");
    assert.ok(
      facts.waited.attempts >= 2,
      `the fact says ${facts.waited.attempts} attempt(s), so the retry path was not the one that completed`,
    );
    assert.ok(facts.waited.waitedMs >= holdMs - 100, `the recorded wait is only ${facts.waited.waitedMs}ms`);
  });
  rmSync(root, { recursive: true, force: true });
}

// ── C. contention for the whole budget: a fact, not an exit code ───────────
{
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-deferred-"));
  seed(root, ASK_COUNT);
  const holdMs = 2_500;
  const run = await drainWhileLocked(root, holdMs, {
    drainBusyTimeoutMs: 200,
    drainAttempts: 2,
    drainBackoffMs: 100,
    rounds: 2,
  });
  const first = run.report;
  const during = readFacts(root);

  check(`C: a drain that cannot finish returns nothing and throws nothing (claimed ${first.claimed})`, () => {
    assert.equal(first.threw, null, `the drain threw instead of giving up: ${first.threw}`);
    assert.equal(first.claimed, 0, "nothing was claimed");
    assert.ok(first.waitedMs < holdMs, `the drain gave up after ${first.waitedMs}ms, which is not inside the ${holdMs}ms lock`);
  });
  check("C: a rolled-back drain leaves every ask open and nothing queued", () => {
    assert.equal(during.answers, 0, "no answer row was queued");
    assert.equal(during.asks.open ?? 0, ASK_COUNT, `open asks: ${JSON.stringify(during.asks)}`);
  });
  check("C: the deferral is not claimed to be on disk while the store is locked", () => {
    assert.equal(during.deferred, null, "nothing could be written to a locked store");
  });

  assert.equal((await exitWithin(run.holder, 10_000, "the lock holder")).code, 0, `the holder exits: ${run.holder.stderr}`);
  // The store is writable again. The same process drains once more, the way a
  // tick would, and the deferral becomes a journal row.
  run.drainer.child.stdin.write("go\n");
  const second = await run.drainer.nextReport();
  const secondExit = await exitWithin(run.drainer, 10_000, "the drainer");
  const after = readFacts(root);
  check(`C: the next drain in the same process completes the work (${second.claimed}/${ASK_COUNT}, exit ${secondExit.code})`, () => {
    assert.equal(second.threw, null);
    assert.equal(second.claimed, ASK_COUNT);
    assert.equal(after.asks.open ?? 0, 0);
    assert.equal(after.answers, ASK_COUNT, "one answer row per ask");
    assert.equal(secondExit.code, 0, "the process that gave up and then recovered exits 0: a deferral is not a crash");
  });
  check(`C: the deferral is journalled once the store accepts a write (attempts ${after.deferred?.attempts})`, () => {
    assert.ok(after.deferred, "a drain that could not finish left no drain_deferred row behind");
    assert.equal(after.deferred.attempts, 2, "the fact names the attempts the drain spent");
    assert.ok(after.deferred.waitedMs > 0, "the fact names how long it spent");
    assert.match(String(after.deferred.error), /locked|busy/i, `the fact quotes the error: ${after.deferred.error}`);
    assert.ok(after.deferred.recoveredAt > after.deferred.at, "the later drain marked the deferral as recovered");
  });
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll drain-contention assertions passed." : `\n${failures} assertion(s) failed.`);
process.exitCode = failures > 0 ? 1 : 0;
