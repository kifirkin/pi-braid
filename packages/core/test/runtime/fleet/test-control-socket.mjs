/**
 * Test: the control channel tells the truth about who owns it.
 *
 * Two supervisors on one root used to end with a live supervisor that nothing
 * could reach. The channel had two mechanisms and they failed in opposite
 * directions, so this file tests them apart:
 *
 *   arrival    binding unlinked the path unconditionally, so a second
 *              supervisor took the channel from a live first one;
 *   departure  stopping unlinked the path unconditionally, so a departing
 *              supervisor deleted the path a survivor was listening on.
 *
 * Nothing here reads the code's own bookkeeping for the answer: every arm asks
 * the channel with a real ping, reads the filesystem, or runs `fleet status` as
 * an operator would. The pins:
 *
 *   arrival    a second supervisor refuses, names the incumbent's pid and
 *              epoch, exits non-zero, and leaves the first one answering;
 *   incumbent  status still says up, inject still reaches it (tier B, never C);
 *   refused    the process that declined does not stay in the journal as live;
 *   departure  a path taken out from under a supervisor is claimed by the next
 *              one, and the old supervisor's clean stop leaves it alone: the
 *              socket is still there and the successor still answers;
 *   stale      a socket file a SIGKILLed supervisor left behind is reclaimed,
 *              so a crash does not retire a root's channel for good;
 *   single     one supervisor starts, reports up, exits cleanly, and its socket
 *              is gone afterwards: the fix must not leave stale files behind.
 *
 * Run: node test/runtime/fleet/test-control-socket.mjs
 */

import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
import { pidIsAlive } from "../../../scripts/fleet/procs.mjs";
import { controlRequest } from "../../../scripts/fleet/cli.mjs";
import { controlSocketPath } from "../../../scripts/fleet/supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = resolve(HERE, "../../../scripts/fleet/supervisor.mjs");
const CLI = resolve(HERE, "../../../scripts/fleet/cli.mjs");

/**
 * Where this file puts its fleet roots. A fleet root is scratch, and a unix
 * socket path is capped at ~100 bytes, so the roots live on the machine's
 * scratch volume: /private/tmp where it exists (macOS), the platform temp
 * directory otherwise.
 */
const SCRATCH = existsSync("/private/tmp") ? "/private/tmp" : tmpdir();

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

/**
 * `promise`, or null once `ms` has passed. The timer is cleared on the way out:
 * a bare Promise.race with a sleep leaves that timer pending, and a pending
 * timer holds this process open for its whole duration after the last check.
 */
function within(promise, ms) {
  return new Promise((resolveWait) => {
    const timer = setTimeout(() => resolveWait(null), ms);
    promise.then((value) => {
      clearTimeout(timer);
      resolveWait(value);
    });
  });
}

const roots = [];
function freshRoot(label) {
  const root = mkdtempSync(join(SCRATCH, `fleet-control-${label}-`));
  roots.push(root);
  return root;
}

/** A node that is registered and never driven: inject needs one to talk about. */
function seedNode(root) {
  writeFileSync(join(root, "charter.md"), "nothing to do\n");
  const journal = openJournal(root, { driver: "scripted" });
  try {
    journal.addNode({
      nodeId: "n1",
      parentId: null,
      projectRoot: root,
      charterPath: join(root, "charter.md"),
      driver: "scripted",
      driverConfig: { steps: [{ op: "done" }], worldFile: join(root, "world.log") },
    });
  } finally {
    journal.close();
  }
}

const spawned = [];
/**
 * A real supervisor process, started the way the CLI starts one. `--idle-exit-ms
 * 0` disables the idle exit: these arms are about the channel, and a supervisor
 * that leaves on its own would end an arm in the middle.
 */
function startSupervisor(root) {
  const child = spawn(
    process.execPath,
    [SUPERVISOR, "--root", root, "--driver", "scripted", "--cap", "0", "--idle-exit-ms", "0"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const chunks = [];
  child.stdout.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  child.stderr.on("data", (chunk) => chunks.push(chunk.toString("utf8")));
  const exited = new Promise((resolveExit) => {
    child.once("exit", (code, signal) => resolveExit({ code, signal }));
  });
  const running = { child, pid: child.pid, exited, log: () => chunks.join("") };
  spawned.push(running);
  return running;
}

/** The channel's answer, once `predicate` holds for it, or a failure naming the wait. */
async function waitAnswer(root, predicate, label) {
  const deadline = Date.now() + 20_000;
  let last = null;
  while (Date.now() < deadline) {
    const reply = await controlRequest(root, { op: "ping" }, { timeoutMs: 500 });
    last = reply?.ok ? reply.data : null;
    if (last && predicate(last)) return last;
    await sleep(50);
  }
  throw new Error(`no answer from ${label} on ${controlSocketPath(root)} (last reply ${JSON.stringify(last)})`);
}

function fleet(root, ...args) {
  return spawnSync(process.execPath, [CLI, ...args, "--root", root], { encoding: "utf8", timeout: 30_000 });
}

const output = (result) => `${result.stdout ?? ""} ${result.stderr ?? ""}`.trim();

async function stopClean(running) {
  if (running.child.exitCode !== null || running.child.signalCode !== null) return;
  running.child.kill("SIGTERM");
  await running.exited;
}

function supervisorsOf(root, pid) {
  const journal = openJournal(root, {});
  try {
    return journal.supervisors().filter((row) => row.pid === pid);
  } finally {
    journal.close();
  }
}

// ── arrival: a live channel is not taken ───────────────────────────────────

const arrivalRoot = freshRoot("arrival");
seedNode(arrivalRoot);
const first = startSupervisor(arrivalRoot);

let firstEpoch = null;
await check("the first supervisor serves the channel", async () => {
  const data = await waitAnswer(arrivalRoot, (row) => row.pid === first.pid, "the first supervisor");
  firstEpoch = data.epoch;
  assert.equal(data.pid, first.pid, "the pid that answers is the process that started");
  assert.equal(existsSync(controlSocketPath(arrivalRoot)), true, "the socket file exists");
});

const second = startSupervisor(arrivalRoot);
let secondExit = null;
await check("a second supervisor on one root refuses the live channel and names its owner", async () => {
  secondExit = await within(second.exited, 20_000);
  assert.ok(secondExit, `the second supervisor exited instead of binding over a live channel (log: ${second.log()})`);
  assert.notEqual(secondExit.code, 0, `a refusal is not a success: exit code ${secondExit.code}\n${second.log()}`);
  const said = second.log();
  assert.match(said, new RegExp(`pid ${first.pid}`), `the refusal names the incumbent's pid ${first.pid}: ${said}`);
  assert.match(said, /refusing to bind/, `the refusal says what it will not do: ${said}`);
});

await check("the first supervisor is still the one the channel reaches", async () => {
  const data = await waitAnswer(arrivalRoot, (row) => row.pid === first.pid, "the first supervisor");
  assert.equal(data.pid, first.pid, "ping answers with the first supervisor's pid");
  assert.equal(data.epoch, firstEpoch, "and with the epoch it registered");
  assert.equal(existsSync(controlSocketPath(arrivalRoot)), true, "the socket file the first one bound is still there");
});

await check("status reports the surviving supervisor up, and inject does not claim tier C", () => {
  const status = fleet(arrivalRoot, "status");
  assert.equal(status.status, 0, output(status));
  assert.match(status.stdout, /supervisor up/, `status says up: ${output(status)}`);
  assert.match(status.stdout, new RegExp(`epoch ${firstEpoch}`), `status reports the supervisor's own epoch: ${status.stdout}`);

  const injected = fleet(arrivalRoot, "inject", "n1", "an instruction for the supervisor that is up");
  assert.equal(injected.status, 0, output(injected));
  assert.match(injected.stdout, /tier B/, `the message reached a supervisor: ${output(injected)}`);
  assert.doesNotMatch(injected.stdout, /tier C/, "no supervisor-running lie");
});

await check("the process that refused does not stay in the journal as live", () => {
  const rows = supervisorsOf(arrivalRoot, second.pid);
  assert.equal(rows.length, 1, "the refused process has a row of its own");
  assert.equal(rows[0].state, "refused", "the row says it refused rather than claiming to serve");
  assert.equal(pidIsAlive(second.pid), false, "and the pid is gone");
});

await stopClean(first);

// ── departure: a path that is no longer ours is left alone ─────────────────

const departureRoot = freshRoot("departure");
seedNode(departureRoot);
const old = startSupervisor(departureRoot);

await check("the old supervisor serves the channel", async () => {
  const data = await waitAnswer(departureRoot, (row) => row.pid === old.pid, "the old supervisor");
  assert.equal(data.pid, old.pid, "the pid that answers is the old supervisor");
});

const departurePath = controlSocketPath(departureRoot);
unlinkSync(departurePath);
const successor = startSupervisor(departureRoot);

await check("a path nobody answers is claimed by the next supervisor", async () => {
  const data = await waitAnswer(departureRoot, (row) => row.pid === successor.pid, "the successor");
  assert.equal(data.pid, successor.pid, "the successor serves it now");
  assert.equal(old.child.exitCode, null, "the old supervisor is still running, which is what the next check needs");
});

await check("the departing supervisor leaves a path it no longer owns", async () => {
  old.child.kill("SIGTERM");
  const exit = await old.exited;
  assert.equal(exit.code, 0, `the old supervisor exits cleanly: ${old.log()}`);
  assert.equal(pidIsAlive(old.pid), false, "the old process is gone, so nothing of it can answer");
  assert.equal(existsSync(departurePath), true, "the socket file the successor bound survived the departure");
  const data = await waitAnswer(departureRoot, (row) => row.pid === successor.pid, "the successor after the departure");
  assert.equal(data.pid, successor.pid, "and the successor still answers");
});

await check("after the departure the successor is the supervisor the operator sees", () => {
  const status = fleet(departureRoot, "status");
  assert.equal(status.status, 0, output(status));
  assert.match(status.stdout, /supervisor up/, `status says up: ${output(status)}`);
  const injected = fleet(departureRoot, "inject", "n1", "an instruction for the successor");
  assert.equal(injected.status, 0, output(injected));
  assert.match(injected.stdout, /tier B/, `the successor takes the message: ${output(injected)}`);
});

await stopClean(successor);

// ── stale: a killed supervisor's socket file is reclaimed ──────────────────

const staleRoot = freshRoot("stale");
seedNode(staleRoot);
const killed = startSupervisor(staleRoot);
await check("a socket file left by a killed supervisor is reclaimed, not inherited", async () => {
  await waitAnswer(staleRoot, (row) => row.pid === killed.pid, "the supervisor about to be killed");
  const stalePath = controlSocketPath(staleRoot);
  killed.child.kill("SIGKILL");
  await killed.exited;
  assert.equal(existsSync(stalePath), true, "the killed process leaves its socket file behind");

  const replacement = startSupervisor(staleRoot);
  const data = await waitAnswer(staleRoot, (row) => row.pid === replacement.pid, "the replacement");
  assert.equal(data.pid, replacement.pid, "the replacement serves the dead supervisor's path");
  await stopClean(replacement);
});

// ── control: one supervisor still ends with no socket behind ───────────────

const singleRoot = freshRoot("single");
seedNode(singleRoot);
const only = startSupervisor(singleRoot);
await check("one supervisor starts and reports up", async () => {
  const data = await waitAnswer(singleRoot, (row) => row.pid === only.pid, "the only supervisor");
  assert.equal(data.pid, only.pid, "the pid that answers is the process that started");
  const status = fleet(singleRoot, "status");
  assert.equal(status.status, 0, output(status));
  assert.match(status.stdout, /supervisor up/, `status says up: ${output(status)}`);
});

await check("it exits cleanly and its socket is gone afterwards", async () => {
  only.child.kill("SIGTERM");
  const exit = await only.exited;
  assert.equal(exit.code, 0, `clean exit: ${only.log()}`);
  assert.equal(existsSync(controlSocketPath(singleRoot)), false, "the socket file is removed, not merely unanswered");
  const rows = supervisorsOf(singleRoot, only.pid);
  assert.equal(rows.at(-1).state, "stopped", "the journal says stopped, not dead");
  const status = fleet(singleRoot, "status");
  assert.match(status.stdout, /supervisor down/, `status says down: ${output(status)}`);
});

// A failed arm must not leave a supervisor holding this process's terminal.
for (const running of spawned) {
  if (running.child.exitCode === null && running.child.signalCode === null) running.child.kill("SIGKILL");
}

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
