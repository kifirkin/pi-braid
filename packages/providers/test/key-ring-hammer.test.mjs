#!/usr/bin/env node
/**
 * key-ring-hammer.test.mjs
 *
 * Two-process concurrency fixture for the keyring race (owner-flagged HIGH).
 *
 * Live incident: two parallel braid workers hit Venice 403 simultaneously;
 * BOTH wrote "key index 1 exhausted ... ALL KEYS EXHAUSTED (0/2 usable)" to
 * the SAME shared state file, yet an independent read moments later showed
 * entry 0 exhausted:false activeIndex:0 — a stale worker's recover/exhaust
 * write had clobbered (resurrected) a key a peer had just proven dead, because
 * the shared file is read-modify-written per process with no cross-process
 * serialization and no CAS.
 *
 * The fix adds four mechanisms (see packages/providers/key-ring.ts module
 * doc): (1) a per-state-file exclusive lock serializing every read-merge-write
 * mutation across processes; (2) CAS on a monotonic `rev` field, turning a
 * lost update into a bounded retry; (3) persisted per-key cooldown merged into
 * getActiveKey so a worker never SERVES a key a peer just exhausted; (4)
 * served-key pinning + a success-veto guard so a recovery cannot resurrect a
 * key another process exhausted after this process started serving it.
 *
 * This fixture spawns TWO real node child processes sharing ONE state file
 * under a temp HOME and drives the REAL key-ring.ts:
 *   - Scenario A (simultaneous exhaust, barrier-synced): both workers
 *     getActiveKey() and simulate a 403 (exhaustActiveKey) after BOTH have
 *     served, so both 403 on the SAME key. Asserts the file ends with EXACTLY
 *     ONE key exhausted and both workers' next getActiveKey() return the SAME
 *     surviving key. Run N times to exercise the interleaving.
 *   - Scenario B (stale-recovery resurrection gate — the owner symptom): A
 *     exhausts P0 then P1; B (constructed BEFORE A acted) recovers its served
 *     key via markSuccess(). Post-fix B's refresh never serves a dead key (it
 *     serves P2, the survivor) and markSuccess only ever touches the key B was
 *     actually served, so A's P0/P1 exhaustion SURVIVES B's recovery write.
 *     Pre-fix, B's stale snapshot served P0 and markSuccess cleared it —
 *     P0 resurrected, the exact clobber. Also asserts the cooldown-convergence
 *     property: B's activeBefore is P2, never P0/P1.
 *   - Scenario C (direct exhaust-vs-recovery race, no barrier): A exhausts P0
 *     while B marks P0 successful, racing. Asserts the file is never torn, rev
 *     is monotonic, P0 ends EXHAUSTED (the 403's signal wins over a concurrent
 *     success — the success-veto guard), and P1 is never clobbered.
 *   - Scenario D (full-ring burn convergence): both workers independently
 *     serve + 403 through ALL keys until the ring reads null. Asserts the file
 *     converges to every key exhausted (0/N usable), never torn, with a
 *     monotonic CAS rev — the canonical "two workers burned through the whole
 *     ring" state, with no resurrection.
 *
 * Revert-proof:
 *   - Point PI_BRAID_PROVIDER_SRC_DIR at a PRE-FIX copy of key-ring.ts.
 *   - Scenario B fails: A's P0 exhaustion is resurrected by B's stale
 *     recovery (entry 0 usable false -> true).
 *   - Scenario C fails: the stale success can leave P0 usable.
 *   - Scenarios A/D rev asserts fail (pre-fix files carry no `rev`).
 *
 * Runtime: no npm install, no network. key-ring.ts + log.ts are compiled with
 * the package's own local tsc (CJS emit) into <repoRoot>/.race-build-hammer/
 * and loaded via createRequire. HOME is redirected to an isolated temp dir so
 * the real ~/.pi/agent state file is never touched.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
// Built at the repo ROOT (not under packages/providers): that package is
// "type": "module", which would make emitted .js load as ESM and break CJS
// "exports". The repo root has no "type" (CJS default). Transient + cleaned.
const buildDir = join(repoRoot, ".race-build-hammer");

/** Compile key-ring.ts + log.ts to CJS in buildDir; return the key-ring module. */
function loadModules() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  // Source-directory override lets us run the identical fixture against a
  // PRE-FIX copy of key-ring.ts to prove revert-proofness (provider-race style).
  const srcDir = process.env.PI_BRAID_PROVIDER_SRC_DIR || pkgRoot;

  const args = [
    tscBin,
    "--ignoreConfig",
    join(srcDir, "key-ring.ts"),
    join(srcDir, "log.ts"),
    "--outDir",
    buildDir,
    "--module",
    "commonjs",
    "--target",
    "ES2022",
    "--lib",
    "ES2022",
    "--strict",
    "--esModuleInterop",
    "--skipLibCheck",
    "--forceConsistentCasingInFileNames",
    "--types",
    "node",
  ];
  const tsc = spawnSync("node", args, { cwd: pkgRoot, encoding: "utf-8" });
  if (tsc.status !== 0) {
    console.error(
      "tsc emit failed:\n" + (tsc.stdout || "") + (tsc.stderr || ""),
    );
    process.exit(1);
  }
  if (!process.env.PI_BRAID_PROVIDER_QUIET && tsc.stdout)
    console.log(tsc.stdout.trim());
  const require = createRequire(import.meta.url);
  return require(join(buildDir, "key-ring.js"));
}

// The compiled module is loaded once (validates it loads); the fixture itself
// drives the module through child processes that require the same build.
loadModules();

/** Duplicate of key-ring.ts hashKey (stable persisted-file identity). */
function hashKey(key) {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < key.length; i++) {
    const ch = key.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507);
  h1 ^= Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507);
  h2 ^= Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * Child-process worker. Requires the compiled key-ring.js, creates its OWN
 * ring over the shared state file (env-injected fake keys), and drives the
 * scenario with flag-file barriers so the parent can force the exact
 * interleaving (both construct before either mutates; scenario A syncs both
 * serves before either exhausts; scenario B has B act only after A).
 */
const WORKER_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");

const buildDir = process.env.KR_BUILD_DIR;
const scratch = process.env.KR_SCRATCH;
const role = process.env.KR_ROLE;
const scenario = process.env.KR_SCENARIO;
const stateName = process.env.KR_STATE_NAME;
const prefix = process.env.KR_PREFIX;

const { createKeyRing } = require(path.join(buildDir, "key-ring.js"));

function flag(name) { return path.join(scratch, name); }
function touch(name) { fs.writeFileSync(flag(name), String(Date.now())); }
function waitFlag(name, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (!fs.existsSync(flag(name))) {
    if (Date.now() > deadline) throw new Error("timeout waiting for " + name);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

const ring = createKeyRing({ prefix: prefix, stateFile: stateName });
touch("ready." + role);

const out = { role: role, scenario: scenario, activeBefore: null, survivor: null, usable: null, served: [] };

if (scenario === "A") {
  waitFlag("go");
  out.activeBefore = ring.getActiveKey();
  touch("served." + role);
  // Both workers have served (the state file is untouched until here), so both
  // 403 on the SAME active key — the exact simultaneous-exhaust interleaving.
  waitFlag("all_served");
  ring.exhaustActiveKey();            // simulate 403 on the active key
  out.survivor = ring.getActiveKey();
  out.usable = ring.health().usable;
} else if (scenario === "B") {
  waitFlag("go");
  if (role === "A") {
    out.activeBefore = ring.getActiveKey();   // P0
    ring.exhaustActiveKey();                   // 403 on P0
    const second = ring.getActiveKey();        // rotates to P1
    ring.exhaustActiveKey();                   // 403 on P1
    out.survivor = second;
    touch("a_done");
  } else {
    waitFlag("b_go");                          // B CONSTRUCTED before A acted
    out.activeBefore = ring.getActiveKey();    // post-fix: refresh -> P2 (never a dead key)
    ring.markSuccess();                        // recovery on the key B was served
    out.survivor = ring.getActiveKey();
  }
  out.usable = ring.health().usable;
} else if (scenario === "C") {
  waitFlag("go");
  out.activeBefore = ring.getActiveKey();      // both serve P0
  if (role === "A") ring.exhaustActiveKey();   // 403 on P0
  else ring.markSuccess();                     // concurrent success on P0
  out.survivor = ring.getActiveKey();
  out.usable = ring.health().usable;
} else if (scenario === "D") {
  waitFlag("go");
  // Burn through EVERY key: serve + simulate 403 until the ring reads null.
  for (let i = 0; i < 10; i++) {
    const k = ring.getActiveKey();
    if (k === null) break;
    out.served.push(k);
    ring.exhaustActiveKey();
  }
  out.usable = ring.health().usable;
}

console.log("RESULT " + JSON.stringify(out));
`;

const originalHome = process.env.HOME;
const scratchDirs = [];

after(() => {
  if (process.env.HOME !== originalHome) process.env.HOME = originalHome;
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });
});

function waitForFile(p, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (!existsSync(p)) {
    if (Date.now() > deadline) throw new Error("timeout waiting for " + p);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

function spawnWorker(workerPath, env) {
  const child = spawn(process.execPath, [workerPath], {
    env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  const rec = { code: null, stdout: "" };
  child.stdout.on("data", (d) => (rec.stdout += d));
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("worker timeout (killed)"));
    }, 40000);
    child.on("error", reject);
    child.on("exit", (code) => {
      clearTimeout(timer);
      rec.code = code;
      resolve(rec);
    });
  });
  return { done, rec };
}

/**
 * Spawn A+B sharing one state file, force the scenario's interleaving, wait
 * for both to exit, and return the final state file path + both workers' JSON.
 */
async function runScenario(scenario, keys, opts = {}) {
  const scratch = mkdtempSync(join(tmpdir(), "pi-braid-keyring-hammer-"));
  scratchDirs.push(scratch);
  const stateName = `hammer-${scenario}-${opts.run ?? 0}-${process.pid}`;
  const stateFile = join(
    scratch,
    ".pi",
    "agent",
    `.key-ring-state-${stateName}.json`,
  );
  const workerPath = join(scratch, "worker.cjs");
  writeFileSync(workerPath, WORKER_SRC);

  const baseEnv = {
    ...process.env,
    HOME: scratch,
    KR_BUILD_DIR: buildDir,
    KR_SCRATCH: scratch,
    KR_STATE_NAME: stateName,
    KR_PREFIX: "HAMMER_KEY",
  };
  // Sanitize the keyspace so ambient provider keys cannot leak into the rings.
  for (const k of Object.keys(baseEnv)) {
    if (/^(AGENT_ZERO_API_KEY|LOGTEST_API_KEY|HAMMER_KEY)(_P\d+)?$/.test(k)) {
      delete baseEnv[k];
    }
  }
  keys.forEach((k, i) => {
    baseEnv[`HAMMER_KEY_P${i}`] = k;
  });

  const wA = spawnWorker(workerPath, {
    ...baseEnv,
    KR_ROLE: "A",
    KR_SCENARIO: scenario,
  });
  const wB = spawnWorker(workerPath, {
    ...baseEnv,
    KR_ROLE: "B",
    KR_SCENARIO: scenario,
  });

  // Both workers construct (and read the state file) before either mutates.
  waitForFile(join(scratch, "ready.A"));
  waitForFile(join(scratch, "ready.B"));
  writeFileSync(join(scratch, "go"), String(Date.now()));

  // Scenario A: sync both workers' SERVES before either exhausts, so both 403
  // on the same key (the task's literal simultaneous-exhaust fixture).
  if (scenario === "A") {
    waitForFile(join(scratch, "served.A"));
    waitForFile(join(scratch, "served.B"));
    writeFileSync(join(scratch, "all_served"), String(Date.now()));
  }

  // Scenario B: B acts only after A finished its writes, so B's construction
  // snapshot predates A's exhaustion (the stale-snapshot interleaving).
  if (scenario === "B") {
    waitForFile(join(scratch, "a_done"));
    writeFileSync(join(scratch, "b_go"), String(Date.now()));
  }

  const [resA, resB] = await Promise.all([wA.done, wB.done]);
  if (resA.code !== 0 || resB.code !== 0) {
    throw new Error(
      `worker failed (A=${resA.code}, B=${resB.code})\nA: ${resA.stdout}\nB: ${resB.stdout}`,
    );
  }
  const parse = (rec) => {
    const line = rec.stdout.split("\n").find((l) => l.startsWith("RESULT "));
    return line ? JSON.parse(line.slice("RESULT ".length)) : null;
  };
  return { stateFile, rA: parse(resA), rB: parse(resB) };
}

function readState(stateFile) {
  return JSON.parse(readFileSync(stateFile, "utf8")); // throws on torn JSON
}

/** Map each known key to its persisted exhausted flag (by hash). */
function keyState(state, keys) {
  const byHash = {};
  for (const e of state.entries) byHash[e.hash] = e;
  const map = {};
  for (const k of keys) {
    const e = byHash[hashKey(k)];
    map[k] = e ? e.exhausted : null;
  }
  return map;
}

/** Assert the persisted file is schema-valid and carries a monotonic CAS rev. */
function assertValidState(state, label) {
  assert.equal(state.version, 1, `${label}: schema version 1 preserved`);
  assert.ok(
    Number.isInteger(state.rev) && state.rev >= 1,
    `${label}: rev is a monotonic CAS counter, got ${state.rev}`,
  );
  assert.ok(Array.isArray(state.entries), `${label}: entries array present`);
}

// ── Scenario A: barrier-synced simultaneous exhaust (the task's literal fixture) ─

test("hammer A: simultaneous exhaust on the same key converges — one key exhausted, both workers agree on the survivor (N runs)", async () => {
  const N = 8;
  const keys = ["hammer-key-0", "hammer-key-1"];
  for (let run = 0; run < N; run++) {
    const { stateFile, rA, rB } = await runScenario("A", keys, { run });
    const state = readState(stateFile);
    assertValidState(state, `run ${run}`);
    const exhausted = state.entries.filter((e) => e.exhausted);
    assert.equal(
      exhausted.length,
      1,
      `run ${run}: exactly ONE key exhausted, got ${exhausted.length}`,
    );
    assert.equal(rA.activeBefore, keys[0], `run ${run}: A started on P0`);
    assert.equal(rB.activeBefore, keys[0], `run ${run}: B started on P0`);
    assert.ok(
      rA.survivor && rB.survivor,
      `run ${run}: both workers have a surviving key`,
    );
    assert.equal(
      rA.survivor,
      rB.survivor,
      `run ${run}: both workers converge on the same surviving key`,
    );
  }
});

// ── Scenario B: stale recovery must NOT resurrect a concurrently-exhausted key ──
// (the owner's "entry 0 usable again" clobber; pre-fix reverts P0 to usable)

test("hammer B: stale worker's recovery cannot resurrect A's exhaustion; cooldown-aware serve never hands out a dead key", async () => {
  const keys = ["hammer-key-0", "hammer-key-1", "hammer-key-2"];
  const { stateFile, rB } = await runScenario("B", keys);
  const state = readState(stateFile);
  assertValidState(state, "B");
  const ks = keyState(state, keys);
  assert.equal(
    ks[keys[0]],
    true,
    "P0 stays exhausted — A's exhaustion survived B's recovery write",
  );
  assert.equal(
    ks[keys[1]],
    true,
    "P1 stays exhausted — A's second exhaustion survived B's recovery write",
  );
  assert.equal(ks[keys[2]], false, "P2 remains usable");
  // Cooldown convergence: post-fix B (stale construction snapshot) never SERVED
  // a dead key — it served the survivor P2, so its recovery wrote nothing over
  // A's exhaustion. Pre-fix it served stale P0 and cleared it (the clobber).
  assert.equal(
    rB.activeBefore,
    keys[2],
    "B was served the survivor (P2), never a dead key",
  );
});

// ── Scenario C: direct exhaust-vs-recovery race (no barrier) ──────────────────
// The 403's signal must win over a concurrent success: P0 ends exhausted, P1
// never clobbered, file never torn, rev monotonic.

test("hammer C: concurrent exhaust-vs-recovery race — P0 ends exhausted (403 wins), P1 unclobbered, no torn file (N runs)", async () => {
  const N = 6;
  const keys = ["hammer-key-0", "hammer-key-1"];
  for (let run = 0; run < N; run++) {
    const { stateFile } = await runScenario("C", keys, { run });
    const state = readState(stateFile); // throws on torn JSON
    assertValidState(state, `run ${run}`);
    const ks = keyState(state, keys);
    assert.equal(
      ks[keys[0]],
      true,
      `run ${run}: P0 ends EXHAUSTED — a concurrent 403 wins over a concurrent success (no resurrection)`,
    );
    assert.equal(ks[keys[1]], false, `run ${run}: P1 never clobbered`);
  }
});

// ── Scenario D: full-ring burn convergence (the whole incident, N keys) ───────
// Two workers each serve + 403 through every key; the file must converge to
// all-exhausted with a monotonic CAS rev and no resurrection.

test("hammer D: two workers burning the whole ring converge — every key exhausted, monotonic CAS rev, no resurrection", async () => {
  const keys = ["hammer-key-0", "hammer-key-1", "hammer-key-2"];
  const { stateFile } = await runScenario("D", keys);
  const state = readState(stateFile);
  assertValidState(state, "D");
  const ks = keyState(state, keys);
  for (const k of keys) {
    assert.equal(
      ks[k],
      true,
      `${k} exhausted — no key resurrected after both workers burned the ring`,
    );
  }
  const usable = state.entries.filter((e) => !e.exhausted).length;
  assert.equal(
    usable,
    0,
    "0/N usable — the canonical all-exhausted terminal state",
  );
  assert.ok(
    state.rev >= 2,
    `D: multiple locked writes bumped the CAS rev (got ${state.rev})`,
  );
});
