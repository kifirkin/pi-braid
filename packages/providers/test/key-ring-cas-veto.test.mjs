#!/usr/bin/env node
/**
 * key-ring-cas-veto.test.mjs
 *
 * Deterministic (clock-injected) regression pin for two defects in
 * packages/providers/key-ring.ts.
 *
 * 1. The concurrent-exhaustion veto in markSuccess compared WALL CLOCKS:
 *    `entry.exhaustedAt > servedAt`. `exhaustedAt` is stamped when the
 *    exhaustion is DECIDED, while the snapshot carrying it lands later inside
 *    withLockedMutation (lock -> re-read -> merge -> CAS write). A peer's
 *    snapshot can therefore be strictly newer than the one this ring read at
 *    serve time while carrying an exhaustedAt OLDER than servedAt: the guard
 *    misses and a stale success clears a peer's exhaustion (the "entry 0
 *    usable again" clobber the guard exists to prevent). The snapshot's
 *    monotonic `rev` answers the causal question - did this land after I
 *    started serving? - and is what the guard must consult.
 *
 * 2. acquireStateLock never created its directory. It opens
 *    `<stateFile>.lock` with "wx"; with the parent directory absent that
 *    throws ENOENT, which is not EEXIST, so the pre-fix code logged
 *    "failed to create state lock" and ran the read-merge-write with no
 *    cross-process serialization at all (only the rev CAS behind it).
 *
 * Determinism (defect 1): no timing dependency, no sleep, no statistical
 * argument. Two rings share ONE state file and both take their clock from the
 * injectable `now`:
 *   - the peer (a child process) stamps its 403 at PEER_CLOCK = 1_000_000;
 *   - this process serves at SERVE_CLOCK = 2_000_000.
 * Flag files force the exact order: this ring SERVES first (recording the
 * revision its serve was based on), the peer then EXHAUSTS and writes (snapshot
 * lands strictly AFTER the serve, stamp strictly BEFORE it), and only then does
 * this ring call markSuccess. Pre-fix the peer's exhaustion is cleared (RED);
 * post-fix the newer snapshot vetoes the clear (GREEN).
 *
 * Determinism (defect 2): a mutation over a fresh tree changes nothing, yet the
 * lock path still runs. Pre-fix the state file's parent directory is never
 * created (the ENOENT lock path is taken and the write is skipped because
 * nothing changed); post-fix the lock creates it before opening.
 *
 * Runtime: no npm install, no network. key-ring.ts + log.ts are compiled with
 * the package's own local tsc (CJS emit) into <repoRoot>/.race-build-casveto/
 * and loaded via createRequire; the child loads the same build. HOME is
 * redirected to an isolated temp dir so the real ~/.pi/agent is never touched.
 *
 * Revert-proof: point PI_BRAID_PROVIDER_SRC_DIR at a PRE-FIX copy of key-ring.ts
 * (+ log.ts) and test 1 fails on `expected: true, actual: false` (P0 usable
 * again) and test 4 fails on the missing state directory; against the fixed
 * module both pass.
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
const buildDir = join(repoRoot, ".race-build-casveto");

const PREFIX = "CASVETO_KEY";
const KEY0 = "cas-veto-key-0";
const KEY1 = "cas-veto-key-1";
const KEYS = [KEY0, KEY1];
/** The peer's 403 is DECIDED first; this ring starts serving LATER. */
const PEER_CLOCK = 1_000_000;
const SERVE_CLOCK = 2_000_000;

/** Compile key-ring.ts + log.ts to CJS in buildDir; return both modules. */
function loadModules() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  // Source-directory override lets the identical fixture run against a PRE-FIX
  // copy of key-ring.ts to prove the pin is revert-proof.
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
  return {
    keyRing: require(join(buildDir, "key-ring.js")),
    log: require(join(buildDir, "log.js")),
  };
}

const mods = loadModules();
const { createKeyRing } = mods.keyRing;
const { setProvidersLogSink } = mods.log;

const originalHome = process.env.HOME;
const scratchDirs = [];

after(() => {
  setProvidersLogSink(undefined);
  process.env.HOME = originalHome;
  for (const d of scratchDirs) rmSync(d, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });
});

/** Sanitize the ambient keyspace so real env vars cannot leak into the rings. */
function scrubProviderEnv() {
  const re = new RegExp(`^${PREFIX}(_P\\d+)?$`);
  for (const key of Object.keys(process.env)) {
    if (re.test(key)) delete process.env[key];
  }
}

function freshScratch() {
  const dir = mkdtempSync(join(tmpdir(), "pi-braid-cas-veto-"));
  scratchDirs.push(dir);
  return dir;
}

/** Bind a recording notify sink for fn; returns the recorded (message, type) pairs. */
function withSink(fn) {
  const calls = [];
  setProvidersLogSink((message, type) => calls.push({ message, type }));
  try {
    fn();
    return calls;
  } finally {
    setProvidersLogSink(undefined);
  }
}

function stateFileIn(scratch, stateName) {
  return join(scratch, ".pi", "agent", `.key-ring-state-${stateName}.json`);
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

function waitForFile(p, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (!existsSync(p)) {
    if (Date.now() > deadline) throw new Error("timeout waiting for " + p);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

/**
 * Child-process peer. It creates its OWN ring over the shared state file with
 * the injected PEER_CLOCK, waits for the release flag (so the other ring serves
 * first), then simulates a 403 on its served key via exhaustActiveKey().
 */
const PEER_SRC = `"use strict";
const path = require("node:path");
const fs = require("node:fs");

const buildDir = process.env.KR_BUILD_DIR;
const scratch = process.env.KR_SCRATCH;
const stateName = process.env.KR_STATE_NAME;
const prefix = process.env.KR_PREFIX;
const clock = Number(process.env.KR_CLOCK);

const { createKeyRing } = require(path.join(buildDir, "key-ring.js"));

function flag(name) { return path.join(scratch, name); }
function waitFlag(name) {
  const deadline = Date.now() + 20000;
  while (!fs.existsSync(flag(name))) {
    if (Date.now() > deadline) throw new Error("timeout waiting for " + name);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
  }
}

const ring = createKeyRing({ prefix: prefix, stateFile: stateName, now: () => clock });
fs.writeFileSync(flag("peer_ready"), String(clock));

waitFlag("go_peer");
// The peer's 403: decided at ITS clock, which is strictly OLDER than the other
// ring's serve time, while the snapshot lands strictly LATER.
const remaining = ring.exhaustActiveKey();
fs.writeFileSync(flag("peer_done"), "");
console.log("RESULT " + JSON.stringify({ clock: clock, remaining: remaining, health: ring.health() }));
`;

/** Spawn the peer over `scratch`, sharing the compiled build and the state name. */
function spawnPeer(scratch, stateName) {
  const workerPath = join(scratch, "peer.cjs");
  writeFileSync(workerPath, PEER_SRC);
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (k.startsWith(PREFIX)) delete env[k];
  }
  env.HOME = scratch;
  env.KR_BUILD_DIR = buildDir;
  env.KR_SCRATCH = scratch;
  env.KR_STATE_NAME = stateName;
  env.KR_PREFIX = PREFIX;
  env.KR_CLOCK = String(PEER_CLOCK);
  env[`${PREFIX}_P0`] = KEY0;
  env[`${PREFIX}_P1`] = KEY1;

  const child = spawn(process.execPath, [workerPath], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const rec = { code: null, stdout: "", stderr: "" };
  child.stdout.on("data", (d) => (rec.stdout += d));
  child.stderr.on("data", (d) => (rec.stderr += d));
  const done = new Promise((res, rej) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rej(new Error("peer timeout (killed)"));
    }, 40000);
    child.on("error", rej);
    child.on("exit", (code) => {
      clearTimeout(timer);
      rec.code = code;
      res(rec);
    });
  });
  return { done, rec };
}

// ── Defect 1: the veto must be causal (snapshot revision), not wall-clock ──────

test("veto: a peer's exhaustion whose snapshot lands after this ring's serve is not cleared by markSuccess", async () => {
  scrubProviderEnv();
  const scratch = freshScratch();
  process.env.HOME = scratch;
  process.env[`${PREFIX}_P0`] = KEY0;
  process.env[`${PREFIX}_P1`] = KEY1;
  const stateName = `cas-veto-peer-${process.pid}`;
  const stateFile = stateFileIn(scratch, stateName);

  const peer = spawnPeer(scratch, stateName);
  waitForFile(join(scratch, "peer_ready"));

  // This ring serves P0 while the peer is parked. Its serve records both its
  // clock and the state revision it is based on (none yet: rev 0).
  const ring = createKeyRing({
    prefix: PREFIX,
    stateFile: stateName,
    now: () => SERVE_CLOCK,
  });
  assert.equal(ring.getActiveKey(), KEY0, "this ring serves P0");
  assert.equal(
    existsSync(stateFile),
    false,
    "serving alone writes no state file",
  );

  // Release the peer: its exhaustion snapshot lands strictly AFTER our serve,
  // and is stamped PEER_CLOCK (1_000_000), strictly OLDER than SERVE_CLOCK.
  writeFileSync(join(scratch, "go_peer"), "");
  const peerRes = await peer.done;
  assert.equal(
    peerRes.code,
    0,
    `peer exited non-zero\nstdout: ${peerRes.stdout}\nstderr: ${peerRes.stderr}`,
  );

  const before = readState(stateFile);
  assert.equal(before.version, 1, "schema version 1");
  assert.ok(
    Number.isInteger(before.rev) && before.rev >= 1,
    `the peer's write bumped the CAS rev, got ${before.rev}`,
  );
  assert.equal(
    keyState(before, KEYS)[KEY0],
    true,
    "postcondition of the setup: the peer's exhaustion is on disk",
  );

  // The stale success: our serve is older than the snapshot now on disk.
  withSink(() => ring.markSuccess());

  const afterState = readState(stateFile);
  assert.equal(
    keyState(afterState, KEYS)[KEY0],
    true,
    "the peer's exhaustion SURVIVES the stale success (vetoed by snapshot revision)",
  );
  assert.equal(keyState(afterState, KEYS)[KEY1], false, "P1 is untouched");
  assert.equal(
    afterState.rev,
    before.rev,
    "a vetoed markSuccess writes nothing (no rev bump)",
  );
});

// ── The guard's legitimate case: a same-process heal must still work ───────────

test("heal: this process's own exhaustion is still cleared by a later success", () => {
  scrubProviderEnv();
  const scratch = freshScratch();
  process.env.HOME = scratch;
  process.env[`${PREFIX}_P0`] = KEY0;
  process.env[`${PREFIX}_P1`] = KEY1;
  const stateName = `cas-veto-selfheal-${process.pid}`;
  const stateFile = stateFileIn(scratch, stateName);

  const ring = createKeyRing({
    prefix: PREFIX,
    stateFile: stateName,
    now: () => SERVE_CLOCK,
  });
  assert.equal(ring.getActiveKey(), KEY0, "serve P0");
  assert.equal(
    ring.exhaustActiveKey(),
    true,
    "one key still usable after the 403",
  );
  assert.equal(ring.health().usable, 1, "P0 exhausted");

  // Our own exhaustion bumped the rev past the serve revision; the pid check
  // must win over the revision comparison, or recovery would be deadlocked.
  ring.markSuccess();

  assert.equal(ring.health().usable, 2, "the ring healed");
  assert.equal(
    keyState(readState(stateFile), KEYS)[KEY0],
    false,
    "the persisted state records the heal",
  );
});

// ── The direct-call case (never served) keeps its pre-existing semantics ──────

test("direct call: markSuccess that was never preceded by a serve still clears the active entry", () => {
  scrubProviderEnv();
  const scratch = freshScratch();
  process.env.HOME = scratch;
  process.env[`${PREFIX}_P0`] = KEY0;
  process.env[`${PREFIX}_P1`] = KEY1;
  const stateName = `cas-veto-direct-${process.pid}`;
  const stateFile = stateFileIn(scratch, stateName);

  // A peer-written snapshot with BOTH keys exhausted: all-exhausted keeps
  // activeIndex at 0, so markSuccess targets P0 without any serve ever having
  // happened (lastServed === null), which is the servedAt === 0 case.
  mkdirSync(dirname(stateFile), { recursive: true });
  writeFileSync(
    stateFile,
    JSON.stringify({
      version: 1,
      rev: 1,
      savedAt: Date.now(),
      activeIndex: 0,
      entries: KEYS.map((key) => ({
        hash: hashKey(key),
        exhausted: true,
        exhaustedAt: SERVE_CLOCK - 10,
        retryCount: 1,
        exhaustedBy: process.pid + 1,
      })),
    }),
  );

  const ring = createKeyRing({
    prefix: PREFIX,
    stateFile: stateName,
    now: () => SERVE_CLOCK,
  });
  assert.equal(ring.health().usable, 0, "both keys exhausted on disk");

  ring.markSuccess();

  assert.equal(
    ring.health().usable,
    1,
    "a direct-call recovery still clears the active entry (guard disabled: never served)",
  );
});

// ── Defect 2: the state lock must create its directory, never skip itself ─────

test("state lock: a mutation on a fresh tree creates the state directory instead of skipping the lock", () => {
  scrubProviderEnv();
  const scratch = freshScratch();
  process.env.HOME = scratch;
  process.env[`${PREFIX}_P0`] = KEY0;
  process.env[`${PREFIX}_P1`] = KEY1;
  const stateName = `cas-veto-lockdir-${process.pid}`;
  const stateFile = stateFileIn(scratch, stateName);
  const stateDir = dirname(stateFile);

  assert.equal(existsSync(stateDir), false, "precondition: no state directory");

  const ring = createKeyRing({
    prefix: PREFIX,
    stateFile: stateName,
    now: () => SERVE_CLOCK,
  });
  assert.equal(ring.getActiveKey(), KEY0, "serve P0 (no write, no directory)");

  // A mutation that changes nothing still runs the lock path. With the parent
  // directory absent, open(..., "wx") throws ENOENT - not EEXIST - and the
  // pre-fix code read that as an unavailable lock, logged, and proceeded with
  // NO cross-process serialization.
  const calls = withSink(() => ring.markSuccess());

  assert.ok(
    existsSync(stateDir),
    "the state directory exists: the lock created it before opening",
  );
  assert.equal(
    calls.filter((c) => /failed to create state lock/.test(c.message)).length,
    0,
    "no lock-creation failure was logged",
  );
  assert.equal(existsSync(stateFile + ".lock"), false, "the lock was released");
});
