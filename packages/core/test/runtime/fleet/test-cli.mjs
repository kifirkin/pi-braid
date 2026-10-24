/**
 * Test: the four operator commands, and the delivery tiers they report.
 *
 * The supervisor is started with `--cap 0`, so the node is admitted but never
 * driven: this test is about the command surface and the journal, not about a
 * model. That keeps it hermetic and fast while still exercising the real
 * detached supervisor the commands talk to.
 *
 * Pinned:
 *   - `spawn` registers the node and starts exactly one supervisor;
 *   - `inject` onto a node with no turn in flight reports tier B (queued for the
 *     next drive), never a pretend steer;
 *   - `ask` records priority, default and deadline, and `inject --token` is the
 *     answer path that resolves it;
 *   - with the supervisor killed, `inject` still records the message (tier C)
 *     and `status` still reads the store;
 *   - an unknown node fails loudly instead of recording into nothing;
 *   - `spawn` forwards `--idle-exit-ms` to the supervisor it starts, says so when
 *     it did not start one, and refuses a value it cannot use before it has
 *     registered anything.
 *
 * Run: node test/runtime/fleet/test-cli.mjs
 */

import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openJournal } from "../../../scripts/fleet/journal.mjs";
import { pidIsAlive } from "../../../scripts/fleet/procs.mjs";
import { controlSocketPath } from "../../../scripts/fleet/supervisor.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../../../scripts/fleet/cli.mjs");

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

const sleep = (ms) => new Promise((resolveWait) => setTimeout(resolveWait, ms));

const root = mkdtempSync(join(tmpdir(), "fleet-cli-"));
const charter = join(root, "work.charter.md");
writeFileSync(charter, "Do nothing; this node is admitted and never driven.");

const env = { ...process.env, PI_FLEET_ROOT: root };
function fleet(...args) {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", env, timeout: 30_000 });
}

function journalView() {
  const journal = openJournal(root, {});
  try {
    return {
      nodes: journal.listNodes(),
      supervisors: journal.supervisors(),
      asks: journal.openAsks(),
      messages: journal.messages(),
    };
  } finally {
    journal.close();
  }
}

const spawned = fleet("spawn", "-", charter, "--cap", "0");
console.log(`  spawn: ${spawned.stdout.trim().split("\n").join(" | ")}`);

await check("spawn registers the node and starts one supervisor", () => {
  assert.equal(spawned.status, 0, spawned.stderr);
  assert.match(spawned.stdout, /spawned n1-work/);
  assert.match(spawned.stdout, /supervisor \d+ \(started\)/);
  const view = journalView();
  assert.equal(view.nodes.length, 1);
  assert.equal(view.nodes[0].state, "settled");
  assert.equal(view.supervisors.filter((row) => row.state === "live").length, 1);
});

const supervisorPid = journalView().supervisors.find((row) => row.state === "live").pid;

await check("status reports the node, the supervisor and a resident set", () => {
  const out = fleet("status", "--json");
  assert.equal(out.status, 0, out.stderr);
  const status = JSON.parse(out.stdout);
  assert.equal(status.nodes[0].nodeId, "n1-work");
  assert.equal(status.nodes[0].turns, 0);
  assert.equal(status.cap, 0);
  assert.ok(status.resident.totalMb > 0, "the supervisor's rss is readable");
  assert.ok(status.resident.pids.some((row) => row.pid === supervisorPid));
});

await check("inject with no turn in flight is tier B, recorded, not a pretend steer", () => {
  const out = fleet("inject", "n1-work", "hello from the head");
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /tier B/);
  assert.match(out.stdout, /no turn in flight/);
  const view = journalView();
  const row = view.messages.at(-1);
  assert.equal(row.body, "hello from the head");
  assert.equal(row.state, "recorded");
});

let askToken = null;
await check("ask records priority, default and deadline, and prints the answer command", () => {
  const out = fleet("ask", "n1-work", "Which target should the node write to?", "--priority", "4", "--default", "target-B");
  assert.equal(out.status, 0, out.stderr);
  const match = out.stdout.match(/ask (ask-[0-9a-f]+) for n1-work/);
  assert.ok(match, `token in output: ${out.stdout}`);
  askToken = match[1];
  assert.match(out.stdout, /priority: 4/);
  assert.match(out.stdout, /default:\s+target-B/);
  assert.match(out.stdout, new RegExp(`--token ${askToken}`));
  const view = journalView();
  assert.equal(view.asks.length, 1);
  assert.equal(view.asks[0].priority, 4);
  assert.equal(view.asks[0].default_answer, "target-B");
  assert.ok(view.asks[0].deadline_at > Date.now());
  assert.equal(view.nodes[0].state, "waiting_on_human");
});

await check("inject --token is the answer path: it resolves the ask and queues the answer", () => {
  const out = fleet("inject", "n1-work", "write to target B", "--token", askToken);
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /tier B/);
  const view = journalView();
  assert.equal(view.asks.length, 0, "no open ask is left behind");
  const journal = openJournal(root, {});
  try {
    const ask = journal.getAsk(askToken);
    assert.equal(ask.state, "answered");
    assert.equal(ask.answer_text, "write to target B");
    assert.equal(ask.answer_source, "fleet-inject");
    assert.equal(journal.getNode("n1-work").state, "settled", "the node is runnable again");
  } finally {
    journal.close();
  }
});

await check("an unknown node fails loudly and records nothing", () => {
  const out = fleet("inject", "n9-missing", "into the void");
  assert.equal(out.status, 1);
  assert.match(out.stderr, /no such node: n9-missing/);
});

await check("with the supervisor killed, inject still records (tier C) and status still reads", async () => {
  process.kill(supervisorPid, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (pidIsAlive(supervisorPid) && Date.now() < deadline) await sleep(50);
  assert.equal(pidIsAlive(supervisorPid), false, "the supervisor is gone");

  const injected = fleet("inject", "n1-work", "recorded while the supervisor was down");
  assert.equal(injected.status, 0, injected.stderr);
  assert.match(injected.stdout, /tier C/);
  assert.match(injected.stdout, /no supervisor running/);
  const view = journalView();
  assert.equal(view.messages.at(-1).state, "recorded");

  const status = fleet("status");
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /supervisor down/);
  assert.match(status.stdout, /n1-work/);
  assert.match(status.stdout, /fleet store/);
});
await check("a fleet root deeper than the socket path limit still gets a control channel", async () => {
  const deepRoot = join(root, ...Array.from({ length: 12 }, (_, index) => `level-${index}`));
  mkdirSync(deepRoot, { recursive: true });
  const deepCharter = join(deepRoot, "deep.charter.md");
  writeFileSync(deepCharter, "nothing to do here either");
  const out = spawnSync(process.execPath, [CLI, "spawn", "-", deepCharter, "--cap", "0", "--root", deepRoot], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.match(out.stdout, /supervisor \d+ \(started\)/);
  const socketPath = controlSocketPath(deepRoot);
  console.log(`  deep root ${deepRoot.length} chars -> socket ${socketPath}`);
  assert.ok(Buffer.byteLength(socketPath) <= 100, "the socket path fits the platform limit");
  assert.ok(socketPath.startsWith(tmpdir()), "the socket fell back to the short temp path");

  const status = spawnSync(process.execPath, [CLI, "status", "--json", "--root", deepRoot], {
    encoding: "utf8",
    env,
    timeout: 30_000,
  });
  assert.equal(status.status, 0, status.stderr);
  const parsed = JSON.parse(status.stdout);
  assert.equal(parsed.nodes[0].nodeId, "n1-deep");
  assert.equal(parsed.meta.control_socket, socketPath, "the chosen socket is journalled");

  const journal = openJournal(deepRoot, {});
  const pid = (() => {
    try {
      return journal.supervisors().find((row) => row.state === "live").pid;
    } finally {
      journal.close();
    }
  })();
  process.kill(pid, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (pidIsAlive(pid) && Date.now() < deadline) await sleep(50);
  assert.equal(pidIsAlive(pid), false);
});

// ── spawn's supervisor flags reach the process they configure ───────────────
//
// `fleet spawn` once accepted `--idle-exit-ms`, registered the node, started a
// supervisor, and never passed the flag on. The instrument here is the kernel's
// view of that supervisor's argv, not this file's account of what it asked for:
// an arm that rebuilt the same string on both sides would pass either way.

function psCommand(pid) {
  return execFileSync("ps", ["-ww", "-p", String(pid), "-o", "command="], { encoding: "utf8" }).trim();
}

const idleRoot = mkdtempSync(join(tmpdir(), "fleet-cli-idle-"));
const idleCharter = join(idleRoot, "idle.charter.md");
writeFileSync(idleCharter, "Wait for work that never comes.");
const idleEnv = { ...process.env, PI_FLEET_ROOT: idleRoot };
const idleSpawn = spawnSync(
  process.execPath,
  [CLI, "spawn", "-", idleCharter, "--cap", "0", "--idle-exit-ms", "4321"],
  { encoding: "utf8", env: idleEnv, timeout: 30_000 },
);
const idlePid = Number(idleSpawn.stdout.match(/supervisor (\d+) \(started\)/)?.[1] ?? 0);

await check("spawn forwards --idle-exit-ms to the supervisor process it starts", () => {
  assert.equal(idleSpawn.status, 0, idleSpawn.stderr);
  assert.ok(idlePid > 0, `the started supervisor is named: ${idleSpawn.stdout}`);
  assert.match(psCommand(idlePid), /--idle-exit-ms 4321/, psCommand(idlePid));
});

await check("a flag for a supervisor this command did not start is reported, not swallowed", () => {
  const again = spawnSync(
    process.execPath,
    [CLI, "spawn", "-", idleCharter, "--cap", "0", "--idle-exit-ms", "999999"],
    { encoding: "utf8", env: idleEnv, timeout: 30_000 },
  );
  assert.equal(again.status, 0, again.stderr);
  assert.match(again.stdout, /already running/);
  assert.match(again.stdout, /--idle-exit-ms 999999 was not applied/);
  assert.match(psCommand(idlePid), /--idle-exit-ms 4321/, "the incumbent keeps the flag it was started with");
  const journal = openJournal(idleRoot, {});
  try {
    assert.equal(journal.supervisors().length, 1, "no second supervisor was started");
  } finally {
    journal.close();
  }
});

await check("a value the supervisor cannot use is refused before anything is registered", () => {
  const refuseRoot = mkdtempSync(join(tmpdir(), "fleet-cli-refuse-"));
  const refuseCharter = join(refuseRoot, "refuse.charter.md");
  writeFileSync(refuseCharter, "Never driven: the command refuses first.");
  const refuseEnv = { ...process.env, PI_FLEET_ROOT: refuseRoot };
  for (const [value, why] of [
    ["soon", "not a number"],
    ["0", "not a duration"],
    [null, "the flag with no value at all"],
  ]) {
    const argv = [CLI, "spawn", "-", refuseCharter, "--cap", "0"];
    if (value == null) argv.push("--idle-exit-ms");
    else argv.push("--idle-exit-ms", value);
    const out = spawnSync(process.execPath, argv, { encoding: "utf8", env: refuseEnv, timeout: 30_000 });
    assert.equal(out.status, 1, `${why}: it fails (${out.stdout}${out.stderr})`);
    assert.match(out.stderr, /--idle-exit-ms needs a whole number of milliseconds greater than 0/, why);
    assert.doesNotMatch(out.stdout, /spawned/, `${why}: nothing was spawned before the refusal`);
  }
  const journal = openJournal(refuseRoot, {});
  try {
    assert.equal(journal.listNodes().length, 0, "a command that refused registered no node");
    assert.equal(journal.supervisors().length, 0, "and started no supervisor");
  } finally {
    journal.close();
  }
});

// The value governs the exit, measured on the process rather than on the log: a
// supervisor told to wait 1200 ms for work leaves on its own, and one told
// nothing does not leave inside that window. Together with the argv arm above,
// this is the difference between the flag reaching the process and the process
// understanding it.

async function waitForExit(pid, { timeoutMs = 12_000 } = {}) {
  const started = Date.now();
  while (pidIsAlive(pid) && Date.now() - started < timeoutMs) await sleep(50);
  return Date.now() - started;
}

await check("the forwarded value is the idle window the supervisor actually waits", async () => {
  const windowRoot = mkdtempSync(join(tmpdir(), "fleet-cli-window-"));
  const windowCharter = join(windowRoot, "window.charter.md");
  writeFileSync(windowCharter, "Nothing here is work at cap 0.");
  const windowEnv = { ...process.env, PI_FLEET_ROOT: windowRoot };
  const out = spawnSync(
    process.execPath,
    [CLI, "spawn", "-", windowCharter, "--cap", "0", "--idle-exit-ms", "1200"],
    { encoding: "utf8", env: windowEnv, timeout: 30_000 },
  );
  assert.equal(out.status, 0, out.stderr);
  const pid = Number(out.stdout.match(/supervisor (\d+) \(started\)/)?.[1] ?? 0);
  assert.ok(pid > 0, out.stdout);
  const elapsed = await waitForExit(pid);
  assert.equal(pidIsAlive(pid), false, `the supervisor left inside ${elapsed} ms`);
  assert.ok(elapsed >= 1000, `it waited the window it was given, not less: ${elapsed} ms`);
  assert.ok(elapsed < 8000, `and not the default five seconds: ${elapsed} ms`);
});

await check("without the flag a spawn keeps the default window, not a leak of the last one", async () => {
  const defaultRoot = mkdtempSync(join(tmpdir(), "fleet-cli-default-"));
  const defaultCharter = join(defaultRoot, "default.charter.md");
  writeFileSync(defaultCharter, "Nothing here is work at cap 0.");
  const defaultEnv = { ...process.env, PI_FLEET_ROOT: defaultRoot };
  const out = spawnSync(process.execPath, [CLI, "spawn", "-", defaultCharter, "--cap", "0"], {
    encoding: "utf8",
    env: defaultEnv,
    timeout: 30_000,
  });
  assert.equal(out.status, 0, out.stderr);
  assert.doesNotMatch(psCommand(Number(out.stdout.match(/supervisor (\d+) \(started\)/)?.[1] ?? 0)), /--idle-exit-ms/);
  const pid = Number(out.stdout.match(/supervisor (\d+) \(started\)/)?.[1] ?? 0);
  assert.ok(pid > 0, out.stdout);
  await sleep(2000);
  assert.equal(pidIsAlive(pid), true, "the default window is longer than the 1200 ms an arm asked for");
  process.kill(pid, "SIGKILL");
  await waitForExit(pid, { timeoutMs: 5000 });
});

// Guarded: `process.kill(0, ...)` signals this process's own group, so a pid
// that failed to parse must never reach the kill.
if (idlePid > 0) {
  process.kill(idlePid, "SIGKILL");
  const deadline = Date.now() + 5000;
  while (pidIsAlive(idlePid) && Date.now() < deadline) await sleep(50);
  assert.equal(pidIsAlive(idlePid), false, "the arm leaves no supervisor behind");
}

// ── the help path ──────────────────────────────────────────────────────────
// `--help` used to print the usage on stderr and exit 2, which reads as a
// refusal: an installed user asking the command what it does got an error code
// from a shell that treats non-zero as failure. A help request is an answer, so
// it goes to stdout and exits 0; only an unknown command stays a refusal.
for (const spelling of ["--help", "-h", "help"]) {
  await check(`${spelling} prints the usage on stdout and exits 0`, () => {
    const out = fleet(spelling);
    assert.equal(out.status, 0, `exit ${out.status}: ${out.stderr}`);
    assert.equal(out.stderr.trim(), "", "the help goes to stdout, where a pager and a pipe read it");
    assert.match(out.stdout, /^pi-braid-fleet: /m, "the help names the command it belongs to");
    for (const command of ["spawn", "status", "inject", "ask"]) {
      assert.match(out.stdout, new RegExp(`^  ${command} `, "m"), `the help lists ${command}`);
    }
    assert.match(out.stdout, /supervisor fleet/, "the help says which fleet this is");
    assert.match(out.stdout, /docs\/FLEET\.md/, "the help points at the guide");
  });
}

await check("a bare invocation is the help path, not a usage error", () => {
  const out = fleet();
  assert.equal(out.status, 0, `exit ${out.status}: ${out.stderr}`);
  assert.match(out.stdout, /^pi-braid-fleet: /m);
});

await check("an unknown command is refused on stderr with exit 2", () => {
  const out = fleet("bogus");
  assert.equal(out.status, 2, `exit ${out.status}`);
  assert.match(out.stderr, /unknown command "bogus"/, "the refusal names the word it did not understand");
  assert.equal(out.stdout.trim(), "", "a refusal does not write the answer stream");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
