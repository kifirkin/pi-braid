#!/usr/bin/env node
// test-chain-lock.mjs - the chain lock's decisions, driven through its CLI.
//
// Every case spawns the real script with BRAID_CHAIN_LOCK_FILE pointed at a
// temporary file, so no case can refuse, reclaim or release a chain another
// process is running on this machine. The lock's own path is a home directory
// on purpose; this file is the seam that makes the instrument testable without
// letting a fixture near the real one.
//
// What the cases pin down, in the order the instrument's rules appear in it:
// a record names the parent (the process that will outlive the helper), a live
// holder is never taken, a dead pid or an unreadable file is reclaimed with a
// line naming the rule that fired, a pid the kernel reused is cleared by the
// ceiling, a foreign host is never judged, release only removes what this tree
// of processes holds, and eight simultaneous acquires leave exactly one winner.
//
// Two cases exist for the wiring rather than the lock. One runs the exit-trap
// shape the manifest uses and asserts a failing leg keeps its status and a
// passing leg leaves nothing behind; the other reads `ci:check` in the manifest
// and asserts the shape is still there, because a lock nobody takes is a rule
// with a file next to it.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir, homedir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const SCRIPT = join(import.meta.dirname, "..", "..", "..", "scripts", "chain-lock.mjs");
const MANIFEST = join(import.meta.dirname, "..", "..", "..", "..", "..", "package.json");
const THIS_HOST = hostname();

const root = mkdtempSync(join(tmpdir(), "chain-lock-test-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

/** A lock file name unique to one case, so cases cannot collide. */
function lockPath(name) {
  return join(root, `${name}.lock`);
}

/** The environment one spawned helper reads: this case's file, nothing inherited. */
function envFor(file) {
  return { ...process.env, BRAID_CHAIN_LOCK_FILE: file };
}

/** One verb of the real script, run the way the manifest runs it. */
function run(file, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8", env: envFor(file) });
}

/** A record in the shape this instrument writes, for a case that needs a given one. */
function record(overrides = {}) {
  const startedAtMs = Date.now();
  return {
    pid: process.pid,
    host: THIS_HOST,
    startedAt: new Date(startedAtMs).toISOString(),
    startedAtMs,
    reason: "fixture",
    command: "fixture",
    cwd: process.cwd(),
    token: `fixture-${startedAtMs}`,
    ...overrides,
  };
}

/** Write a record without going through acquire, for the states acquire cannot produce. */
function plant(file, value) {
  writeFileSync(file, typeof value === "string" ? value : `${JSON.stringify(value, null, 2)}\n`);
}

/** A pid the kernel no longer has: spawned to completion, then reaped. */
function deadPid() {
  return spawnSync(process.execPath, ["-e", ""]).pid;
}

test("acquire records the process that will run the chain, not the helper", () => {
  const file = lockPath("acquire");
  const result = run(file, "acquire", "--reason", "fixture acquire");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^chain-lock: acquired /);
  const written = JSON.parse(readFileSync(file, "utf8"));
  // The helper exits before the next line runs, so a record carrying its own pid
  // would name a dead process. The parent is the shell that holds the chain.
  assert.equal(written.pid, process.pid);
  assert.equal(written.host, THIS_HOST);
  assert.equal(written.reason, "fixture acquire");
  assert.equal(written.cwd, process.cwd());
  assert.match(written.command, /chain-lock\.mjs acquire --reason fixture acquire$/);
  assert.ok(Number.isFinite(written.startedAtMs));
  assert.equal(new Date(written.startedAt).getTime(), written.startedAtMs);
  assert.equal(typeof written.token, "string");
});

test("an acquire without a reason records that none was given", () => {
  const file = lockPath("no-reason");
  const result = run(file, "acquire");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reason \(unstated\)/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).reason, null);
});

test("a second acquire is refused and names the holder, leaving the record alone", () => {
  const file = lockPath("refused");
  assert.equal(run(file, "acquire", "--reason", "the first chain").status, 0);
  const before = readFileSync(file, "utf8");
  const second = run(file, "acquire", "--reason", "the second chain");
  assert.equal(second.status, 1);
  assert.match(second.stderr, /^chain-lock: refused - .* is held by pid \d+ on /);
  assert.match(second.stderr, /reason "the first chain"/);
  assert.match(second.stderr, new RegExp(`cat ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.equal(readFileSync(file, "utf8"), before);
  assert.equal(run(file, "release").status, 0);
});

test("a live pid is never stolen, even when it is not this process's", () => {
  const file = lockPath("live-pid");
  // The fixture process itself is the unrelated live holder: alive, on this host,
  // and not the spawned helper's parent unless the helper were its child.
  plant(file, record({ pid: process.pid, reason: "someone else's chain" }));
  const result = run(file, "acquire", "--reason", "a second chain");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /reason "someone else's chain"/);
  assert.ok(existsSync(file));
});

test("a lock whose pid is gone is reclaimed, and the line says which rule fired", () => {
  const file = lockPath("dead-pid");
  const gone = deadPid();
  plant(file, record({ pid: gone, reason: "a chain that was killed" }));
  const result = run(file, "acquire", "--reason", "the next chain");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`reclaimed .* - its pid ${gone} is gone on this host`));
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.pid, process.pid);
  assert.equal(written.reason, "the next chain");
});

test("a file that is not a lock record is reclaimed, and the line says so", () => {
  const file = lockPath("corrupt");
  plant(file, "{ this is not json");
  const result = run(file, "acquire", "--reason", "after a corrupt file");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reclaimed .* - it is not a lock record/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).reason, "after a corrupt file");
});

test("a lock past the ceiling is reclaimed even though its pid is alive", () => {
  const file = lockPath("ceiling");
  // Two hours is the constant, so three hours is past it: the case is the pid
  // the kernel handed to an unrelated process, which no pid check can see.
  plant(file, record({ pid: process.pid, startedAtMs: Date.now() - 3 * 60 * 60 * 1000 }));
  const result = run(file, "acquire", "--reason", "after the ceiling");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /reclaimed .* - it is 3h old, past the 2h ceiling/);
});

test("a record from another host is never reclaimed", () => {
  const file = lockPath("foreign");
  plant(file, record({ host: "another-machine.test", pid: 999_999 }));
  const result = run(file, "acquire", "--reason", "a local chain");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /on another-machine\.test since /);
  assert.ok(existsSync(file));
});

test("release removes the holder's lock and reports what it removed", () => {
  const file = lockPath("release");
  assert.equal(run(file, "acquire", "--reason", "to be released").status, 0);
  const result = run(file, "release");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`released ${file} - held by this chain \\(pid ${process.pid}\\)`));
  assert.equal(existsSync(file), false);
});

test("release from another process tree is refused while the holder is alive", () => {
  const file = lockPath("foreign-release");
  assert.equal(run(file, "acquire", "--reason", "held by the outer process").status, 0);
  // The release runs one node deeper than the fixture, so its parent is not the
  // recorded holder: this is the second-shell case, refused on purpose.
  const deeper = spawnSync(
    process.execPath,
    [
      "-e",
      "const { spawnSync } = require('node:child_process');" +
        "const r = spawnSync(process.execPath, [process.argv[1], 'release']," +
        " { encoding: 'utf8', env: process.env });" +
        "process.stdout.write(r.stdout ?? '');process.stderr.write(r.stderr ?? '');" +
        "process.exit(r.status ?? 1);",
      SCRIPT,
    ],
    { encoding: "utf8", env: envFor(file) },
  );
  assert.equal(deeper.status, 1);
  assert.match(deeper.stderr, /only its holder or a dead pid may release it/);
  assert.ok(existsSync(file));
});

test("release of a dead holder's lock is allowed, and says the holder is gone", () => {
  const file = lockPath("release-stale");
  const gone = deadPid();
  plant(file, record({ pid: gone }));
  const result = run(file, "release");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`its holder pid ${gone} is gone on this host`));
  assert.equal(existsSync(file), false);
});

test("release refuses a file it cannot read, and leaves it for the next acquire", () => {
  const file = lockPath("release-corrupt");
  plant(file, "[]");
  const result = run(file, "release");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /is not a lock record \(not a lock record\); it is left for the next acquire/);
  assert.ok(existsSync(file));
});

test("release with nothing held says free and exits 0", () => {
  const result = run(lockPath("never-taken"), "release");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^chain-lock: free - nothing was held at /);
});

test("status reports the holder, then free, without judging either one", () => {
  const file = lockPath("status");
  const free = run(file, "status");
  assert.equal(free.status, 0);
  assert.match(free.stdout, /^chain-lock: free - nothing is held at /);
  assert.equal(run(file, "acquire", "--reason", "the status chain").status, 0);
  const held = run(file, "status");
  assert.equal(held.status, 0);
  assert.match(held.stdout, /^chain-lock: held - .* by pid \d+ on /);
  assert.match(held.stdout, /reason "the status chain"/);
  // A status read never moves the file, so the holder still has it afterwards.
  assert.equal(JSON.parse(readFileSync(file, "utf8")).reason, "the status chain");
  assert.equal(run(file, "release").status, 0);
});

test("status names a stale record as stale", () => {
  const file = lockPath("status-stale");
  plant(file, record({ pid: deadPid() }));
  const result = run(file, "status");
  assert.equal(result.status, 0);
  assert.match(result.stdout, /^chain-lock: stale \(its pid \d+ is gone on this host\)/);
});

test("eight simultaneous acquires leave exactly one winner", async () => {
  const file = lockPath("race");
  const go = join(root, "race-go");
  // The children spin on a file until every one of them is running, then acquire
  // together. Spawning them one after another would let the first finish before
  // the last started, and the case would then pass on any create at all rather
  // than on one that refuses a name already taken. Each child stays alive after
  // its helper returns, because the record its helper writes names this process:
  // a parent that exits first makes the winner look dead and the next racer is
  // right to reclaim it.
  const child = (index) => `
    const { existsSync, writeFileSync } = require("node:fs");
    const { spawnSync } = require("node:child_process");
    writeFileSync(${JSON.stringify(join(root, `race-ready-${index}`))}, "ready");
    while (!existsSync(${JSON.stringify(go)})) {}
    const result = spawnSync(process.execPath, [process.argv[1], "acquire", "--reason", "the race"],
      { encoding: "utf8", env: process.env });
    process.stdout.write(result.stdout ?? "");
    process.stderr.write(result.stderr ?? "");
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
    process.exit(result.status ?? 1);
  `;
  const attempts = Array.from({ length: 8 }, (_, index) => {
    return new Promise((settle) => {
      const running = spawn(process.execPath, ["-e", child(index), SCRIPT], {
        env: envFor(file),
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "";
      let err = "";
      running.stdout.on("data", (chunk) => (out += chunk));
      running.stderr.on("data", (chunk) => (err += chunk));
      running.on("close", (code) => settle({ code, out, err }));
    });
  });
  const ready = Array.from({ length: 8 }, (_, index) => join(root, `race-ready-${index}`));
  for (let waited = 0; !ready.every((path) => existsSync(path)); waited++) {
    assert.ok(waited < 500, "a race child never reached the barrier");
    await new Promise((settle) => setTimeout(settle, 10));
  }
  writeFileSync(go, "go\n");
  const results = await Promise.all(attempts);
  const winners = results.filter((result) => result.code === 0);
  const losers = results.filter((result) => result.code === 1);
  assert.equal(winners.length, 1, `expected one winner, got ${winners.length}: ${JSON.stringify(results)}`);
  assert.equal(losers.length, 7);
  // A loser that reclaimed is not a loser that ran: every refusal names a holder.
  for (const loser of losers) assert.match(loser.err, /chain-lock: refused - /);
  const held = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(held.reason, "the race");
  assert.equal(run(file, "release").status, 0);
});

test("an unwritable lock path lets the chain run and says what it lost", () => {
  const blocker = join(root, "blocked");
  writeFileSync(blocker, "a file where the lock directory would be\n");
  const result = run(join(blocker, "full-chain.lock"), "acquire", "--reason", "no room");
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /^chain-lock: unguarded - .* cannot be created \(/);
});

test("an unknown verb is a usage error, not a refusal", () => {
  const result = run(lockPath("usage"), "take");
  assert.equal(result.status, 64);
  assert.match(result.stderr, /unknown verb "take"/);
});

test("the exit-trap shape keeps a failing leg's status and leaves nothing behind", () => {
  const file = lockPath("trap-shape");
  const shape = (leg) =>
    `node "${SCRIPT}" acquire --reason chain-shape && ` +
    `trap 'rc=$?; node "${SCRIPT}" release; exit $rc' 0 && ${leg}`;
  // `npm run` hands the script to a POSIX shell; on this platform that is bash in
  // sh mode, and on the machines that run the suite it is dash. Both are run
  // here when both exist, because the status the chain exits with is the only
  // thing the gate's verdict reads.
  const shells = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));
  assert.ok(shells.length > 0);
  for (const shell of shells) {
    // A leg that fails the way a real one does: no explicit exit, just a non-zero
    // status at the end of the list, which is what `npm run` hands back.
    const failed = spawnSync(shell, ["-c", shape("(exit 3)")], {
      encoding: "utf8",
      env: envFor(file),
    });
    assert.equal(
      failed.status,
      3,
      `${shell} masked a failing leg: ${failed.stdout}${failed.stderr}`,
    );
    assert.match(failed.stdout, /chain-lock: released /);
    assert.equal(existsSync(file), false);
    const passed = spawnSync(shell, ["-c", shape("true")], { encoding: "utf8", env: envFor(file) });
    assert.equal(passed.status, 0, `${shell}: ${passed.stderr}`);
    assert.match(passed.stdout, /chain-lock: released /);
    assert.equal(existsSync(file), false);
  }
  // A refused acquire runs no leg at all, so nothing is installed to release.
  assert.equal(run(file, "acquire", "--reason", "the standing chain").status, 0);
  const refused = spawnSync(shells[0], ["-c", shape("echo LEG-RAN")], {
    encoding: "utf8",
    env: envFor(file),
  });
  assert.equal(refused.status, 1);
  assert.doesNotMatch(refused.stdout, /LEG-RAN/);
  assert.match(refused.stderr, /chain-lock: refused - /);
  // Nothing was installed, so nothing released: the standing holder keeps it.
  assert.doesNotMatch(`${refused.stdout}${refused.stderr}`, /chain-lock: released/);
  assert.equal(JSON.parse(readFileSync(file, "utf8")).reason, "the standing chain");
  assert.equal(run(file, "release").status, 0);
});

test("without the override the lock lives under the braid home, not in a tree", () => {
  // A status read never writes, so this case pins the default path without
  // touching the machine's real lock file - and without depending on what that
  // file holds right now: this suite runs inside a chain that holds exactly this
  // lock, so the line it prints here is the held one, not the free one.
  const env = { ...process.env };
  delete env.BRAID_CHAIN_LOCK_FILE;
  const result = spawnSync(process.execPath, [SCRIPT, "status"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^chain-lock: /);
  assert.ok(
    result.stdout.includes(join(homedir(), ".pi", "agent", "braid", "locks", "full-chain.lock")),
    result.stdout,
  );
});

test("the manifest's ci:check still takes the lock and still runs every leg", () => {
  const body = JSON.parse(readFileSync(MANIFEST, "utf8")).scripts["ci:check"];
  const segments = body.split(" && ").map((segment) => segment.trim());
  assert.equal(segments[0], "node packages/core/scripts/chain-lock.mjs acquire --reason ci:check");
  const trap = segments[1];
  assert.match(trap, /^trap '/);
  assert.match(trap, /chain-lock\.mjs release/);
  assert.match(trap, /rc=\$\?/);
  assert.match(trap, /exit \$rc' 0$/);
  // The chain itself is untouched: the nine workspace suites and the gates are
  // still segments of the manifest's own body, which is what the chain gate reads.
  for (const leg of ["npm run check:docs", "npm run check:ci-chain", "npm test", "npm run test -w packages/skills"]) {
    assert.ok(segments.includes(leg), `${leg} is no longer a segment of ci:check`);
  }
});
