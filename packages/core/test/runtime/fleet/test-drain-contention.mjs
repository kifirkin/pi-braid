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
 *      at which point the deferral is a journal row (`store_deferred`, with the
 *      attempts and the error) and the asks are drained. While the store is
 *      locked the same fact is on disk beside it (`store-deferred.json`), which
 *      is the only place it can be: a fact about a wedged store is the one fact
 *      the store cannot hold, and a supervisor that dies holding it used to
 *      leave nothing behind at all.
 *   D. the tick's second maintenance pass. The sweep of undeliverable messages
 *      meets the same lock after the drain gave up. It is recorded like the
 *      drain's deferral instead of thrown, so the pass is retried by the next
 *      tick rather than logged and skipped, and the queued message is still
 *      `recorded` (not stamped `undeliverable`) until the store takes it.
 *   E. the operator's command in that state. With the store still locked and
 *      the deferring process already gone, `status` cannot read the journal and
 *      prints the deferral from the file beside it, then exits non-zero: the
 *      reason the fleet is idle survives the thing it is written about.
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
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
import { Supervisor } from "../../../scripts/fleet/supervisor.mjs";

const SELF = fileURLToPath(import.meta.url);
const CLI = fileURLToPath(new URL("../../../scripts/fleet/cli.mjs", import.meta.url));
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
    const sidecar = join(root, "store-deferred.json");
    const late = db.prepare("SELECT state FROM inbox WHERE msg_id = 'm-late'").get() ?? null;
    return {
      meta,
      asks,
      answers,
      duplicatedTokens,
      deferred: json("store_deferred"),
      // The fact a store that cannot be written leaves beside itself.
      onDisk: existsSync(sidecar) ? JSON.parse(readFileSync(sidecar, "utf8")) : null,
      lateState: late?.state ?? null,
      waited: json("drain_contention"),
    };
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
      claimed = (options.maintenance ? supervisor.maintenance() : supervisor.drainExpiredAsks()).length;
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
  check("C: the journal does not claim a deferral while the store is locked", () => {
    assert.equal(during.deferred, null, "nothing could be written to a locked store");
  });
  check(`C: while the store is locked the deferral is beside it, where status reads it (${during.onDisk?.what})`, () => {
    assert.ok(during.onDisk, "a drain that gave up left nothing an operator can read");
    assert.equal(during.onDisk.what, "drain", "the fact names the pass that could not write");
    assert.equal(during.onDisk.attempts, 2, "the fact names the attempts it spent");
    assert.ok(during.onDisk.waitedMs > 0, "the fact names how long it waited");
    assert.match(String(during.onDisk.error), /locked|busy/i, `the fact quotes the error: ${during.onDisk.error}`);
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
    assert.ok(after.deferred, "a drain that could not finish left no store_deferred row behind");
    assert.equal(after.deferred.what, "drain", "the journalled fact still names the pass");
    assert.equal(after.deferred.attempts, 2, "the fact names the attempts the drain spent");
    assert.ok(after.deferred.waitedMs > 0, "the fact names how long it spent");
    assert.match(String(after.deferred.error), /locked|busy/i, `the fact quotes the error: ${after.deferred.error}`);
    assert.ok(after.deferred.recoveredAt > after.deferred.at, "the later drain marked the deferral as recovered");
    assert.equal(after.onDisk, null, "and the file beside the store is gone: the journal holds the fact now");
  });
  rmSync(root, { recursive: true, force: true });
}

// ── D. the tick's second maintenance pass: recorded, not thrown ─────────
//
// The measured tick deferred its drain and then died throwing `database is
// locked` from the sweep after it, which left an overdue ask open with nothing
// saying why. The sweep has the same budget as the drain now, and meeting the
// lock is a fact rather than an exception: the next tick retries the pass.
{
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-sweep-"));
  seed(root, 3);
  // A message queued for a node that is done can never be carried, so the sweep
  // has a write of its own to make after the drain has given up on one.
  {
    const journal = openJournal(root);
    journal.addNode({
      nodeId: "late",
      parentId: null,
      projectRoot: root,
      charterPath: join(root, "charter.md"),
      driver: "scripted",
      driverConfig: "{}",
    });
    journal.setNodeState("late", "done");
    journal.addMessage({ msgId: "m-late", nodeId: "late", kind: "user", body: "too late to matter" });
    journal.close();
  }
  const holdMs = 1_200;
  const run = await drainWhileLocked(root, holdMs, {
    drainBusyTimeoutMs: 200,
    drainAttempts: 1,
    drainBackoffMs: 100,
    maintenance: true,
    rounds: 2,
  });
  const during = readFacts(root);

  check("D: a maintenance pass that cannot write does not throw", () => {
    assert.equal(run.report.threw, null, `the pass threw: ${run.report.threw}`);
  });
  check(`D: the deferral names the pass that met the lock (${during.onDisk?.what})`, () => {
    assert.equal(during.deferred, null, "the journal could not take it either");
    assert.ok(during.onDisk, "the pass that could not write left nothing behind");
    assert.equal(during.onDisk.what, "undeliverable sweep", "the fact names the sweep, not the drain before it");
    assert.match(String(during.onDisk.error), /locked|busy/i, `the fact quotes the error: ${during.onDisk.error}`);
  });
  check("D: the work is still open and the message is not yet stamped", () => {
    assert.equal(during.answers, 0, "no answer row was queued");
    assert.equal(during.asks.open ?? 0, 3, `open asks: ${JSON.stringify(during.asks)}`);
    assert.equal(during.lateState, "recorded", "the sweep did not run, so the message is not stamped undeliverable");
  });

  assert.equal((await exitWithin(run.holder, 10_000, "the lock holder")).code, 0, `the holder exits: ${run.holder.stderr}`);
  run.drainer.child.stdin.write("go\n");
  const second = await run.drainer.nextReport();
  const secondExit = await exitWithin(run.drainer, 10_000, "the maintenance process");
  const after = readFacts(root);
  check(`D: the next pass does both halves of the work (drain ${second.claimed}, exit ${secondExit.code})`, () => {
    assert.equal(second.threw, null, `the retried pass threw: ${second.threw}`);
    assert.equal(second.claimed, 3);
    assert.equal(after.asks.open ?? 0, 0);
    assert.equal(after.lateState, "undeliverable", "the retried sweep stamped the message no turn can carry");
  });
  check("D: the deferral ends up in the journal, with the file beside the store gone", () => {
    assert.ok(after.deferred, "the retried pass journalled nothing");
    assert.equal(after.deferred.what, "undeliverable sweep");
    assert.ok(after.deferred.recoveredAt > after.deferred.at, "the later pass marked it recovered");
    assert.equal(after.onDisk, null, "the file is removed once the journal holds the fact");
  });
  rmSync(root, { recursive: true, force: true });
}

// ── E. the operator's command while the store is still unreadable ────────
//
// The fact exists to be read in exactly this state: another process holds the
// write lock, the pass that could not write is gone, and `status` cannot open
// the journal. It still has to say why nothing moved.
{
  const root = mkdtempSync(join(tmpdir(), "fleet-drain-status-"));
  seed(root, 1);
  const holdMs = 13_000;
  const run = await drainWhileLocked(root, holdMs, {
    drainBusyTimeoutMs: 200,
    drainAttempts: 1,
    drainBackoffMs: 100,
    maintenance: true,
    rounds: 1,
  });
  // The measured death: one pass, then the process ends holding nothing but the
  // file it wrote.
  const drainerExit = await exitWithin(run.drainer, 10_000, "the maintenance process");
  const started = Date.now();
  const status = spawnSync(process.execPath, [CLI, "status", "--root", root], { encoding: "utf8", timeout: 30_000 });
  const elapsedMs = Date.now() - started;

  check(`E: status names the deferral while the store is unreadable (exit ${status.status}, ${elapsedMs}ms)`, () => {
    assert.equal(drainerExit.code, 0, `the deferring process exits 0: ${run.drainer.stderr}`);
    assert.equal(status.status, 1, `status exits non-zero when its report is partial: ${status.stdout}`);
    assert.match(String(status.stdout), /store unreadable: /, `status does not say the store could not be read: ${status.stdout}`);
    assert.match(String(status.stdout), /deferred \d{4}-/, `status printed no deferral: ${status.stdout}`);
    assert.ok(elapsedMs > holdMs - 3_000, `status returned after ${elapsedMs}ms, before the ${holdMs}ms lock: it did not wait`);
  });
  assert.equal((await exitWithin(run.holder, 10_000, "the lock holder")).code, 0, `the holder exits: ${run.holder.stderr}`);
  rmSync(root, { recursive: true, force: true });
}

console.log(failures === 0 ? "\nAll drain-contention assertions passed." : `\n${failures} assertion(s) failed.`);
process.exitCode = failures > 0 ? 1 : 0;
