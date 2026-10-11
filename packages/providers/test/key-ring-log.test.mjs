#!/usr/bin/env node
/**
 * key-ring-log.test.mjs
 *
 * Deterministic regression test (key-ring exhaustion must
 * produce a CLEAR user-facing WARN, not a silent 403 flood):
 *   - rotation events (key switched / backoff-reenabled) surface at INFO via
 *     the native notify sink;
 *   - exhaustion of the LAST key emits ONE loud, human-readable
 *     "ALL KEYS EXHAUSTED" warn carrying the provider's exhaustionNotice
 *     (e.g. "daily quota ~5-10$/day ... resets 00:00 UTC / 3am local.");
 *   - per-key + all-exhausted warns are THROTTLED (first loud, repeats silent
 *     inside the window, re-loud once per window) so a 403 flood yields no
 *     per-call spam;
 *   - markSuccess() on a healed key emits one INFO recovery line and RESETS
 *     the throttlers so the next burst starts loud again.
 *
 * Runtime: no npm install, no network. key-ring.ts + log.ts are compiled with
 * the package's own local tsc (CJS emit) into <repoRoot>/.race-build-ringlog/
 * (cleaned afterwards). Rings are created WITHOUT a stateFile, so no state is
 * persisted and HOME never needs redirecting. The injectable `now` clock keeps
 * the 5-min throttle windows deterministic with a fake clock.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { rmSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const buildDir = join(repoRoot, ".race-build-ringlog");

/** Sanitize the ambient keyspace so real env vars cannot leak into the rings. */
function scrubProviderEnv() {
  for (const key of Object.keys(process.env)) {
    if (/^(AGENT_ZERO_API_KEY|LOGTEST_API_KEY)(_P\d+)?$/.test(key)) {
      delete process.env[key];
    }
  }
}

/** Compile key-ring.ts + log.ts to CJS in buildDir; return both modules (same sink). */
function loadModules() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
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

const VENICE_NOTICE =
  "Venice account daily quota ~5-10$/day spent — resets 00:00 UTC / 3am local.";

after(() => {
  setProvidersLogSink(undefined);
  rmSync(buildDir, { recursive: true, force: true });
});

test("rotation: switching to a fresh key logs ONE info line, steady key stays quiet (item 22)", () => {
  scrubProviderEnv();
  process.env.AGENT_ZERO_API_KEY = "k0";
  process.env.AGENT_ZERO_API_KEY_P0 = "k0";
  process.env.AGENT_ZERO_API_KEY_P1 = "k1";
  process.env.AGENT_ZERO_API_KEY_P2 = "k2";
  const clock = { t: 0 };
  const ring = createKeyRing({
    prefix: "AGENT_ZERO_API_KEY",
    exhaustionNotice: VENICE_NOTICE,
    exhaustWarnWindowMs: 100,
    now: () => clock.t,
  });

  const calls = withSink(() => {
    // Active key 0: no rotation, no line.
    assert.equal(ring.getActiveKey(), "k0");
    // Exhaust key 0 -> next getActiveKey rotates to key 1.
    assert.equal(ring.exhaustActiveKey(), true);
    ring.getActiveKey();
    assert.equal(ring.getActiveKey(), "k1", "active is now k1");
  });

  const infos = calls.filter((c) => c.type === "info");
  assert.equal(infos.length, 1, "exactly one rotation info");
  assert.match(infos[0].message, /Rotating to key index 1 \(was 0\)\./);
  assert.equal(
    infos[0].message,
    "[providers/key-ring] [key-ring:AGENT_ZERO_API_KEY] Rotating to key index 1 (was 0).",
  );
});

test("all-exhausted: LAST key emits loud human-readable warn with the provider notice (item 22)", () => {
  scrubProviderEnv();
  process.env.LOGTEST_API_KEY = "only";
  const clock = { t: 0 };
  const ring = createKeyRing({
    prefix: "LOGTEST_API_KEY",
    exhaustionNotice:
      "Logtest credits spent or key revoked — top up in the console.",
    exhaustWarnWindowMs: 100,
    now: () => clock.t,
  });

  const calls = withSink(() => {
    assert.equal(ring.exhaustActiveKey(), false, "single key fully exhausted");
  });

  const warns = calls.filter((c) => c.type === "warning");
  assert.equal(warns.length, 2, "per-key warn + loud all-exhausted warn");
  const allExhausted = warns.find((c) => /ALL KEYS EXHAUSTED/.test(c.message));
  assert.ok(allExhausted, "ALL KEYS EXHAUSTED line present");
  assert.match(allExhausted.message, /0\/1 usable/);
  assert.match(allExhausted.message, /Next retry in \d+ms/);
  assert.match(allExhausted.message, /LOGTEST_API_KEY_P0/);
  assert.match(allExhausted.message, /Logtest credits spent or key revoked/);
});

test("all-exhausted: throttled — repeats inside the window silent, re-loud after (item 22)", () => {
  scrubProviderEnv();
  process.env.AGENT_ZERO_API_KEY = "only";
  const clock = { t: 0 };
  const ring = createKeyRing({
    prefix: "AGENT_ZERO_API_KEY",
    exhaustionNotice: VENICE_NOTICE,
    exhaustWarnWindowMs: 100,
    now: () => clock.t,
  });

  // First burst (t=0): per-key warn + loud all-exhausted warn.
  const first = withSink(() => ring.exhaustActiveKey());
  assert.equal(first.filter((c) => c.type === "warning").length, 2);
  assert.match(
    first.find((c) => /ALL KEYS EXHAUSTED/.test(c.message)).message,
    /daily quota ~5-10\$\/day spent — resets 00:00 UTC \/ 3am local\./,
  );

  // Same window (t=10): repeat exhausts produce ZERO new lines (no 403 flood spam).
  clock.t = 10;
  const repeat = withSink(() => {
    ring.exhaustActiveKey();
    ring.exhaustActiveKey();
  });
  assert.equal(
    repeat.length,
    0,
    "repeats inside the window are completely silent",
  );

  // Window elapsed (t=100): re-loud exactly once.
  clock.t = 100;
  const reloud = withSink(() => ring.exhaustActiveKey());
  assert.equal(
    reloud.filter((c) => c.type === "warning").length,
    2,
    "re-louds once per window",
  );
});

test("recovery: markSuccess on a healed key logs info and resets throttlers (item 22)", () => {
  scrubProviderEnv();
  process.env.AGENT_ZERO_API_KEY = "only";
  const clock = { t: 0 };
  const ring = createKeyRing({
    prefix: "AGENT_ZERO_API_KEY",
    exhaustionNotice: VENICE_NOTICE,
    exhaustWarnWindowMs: 100,
    now: () => clock.t,
  });

  const calls = withSink(() => {
    assert.equal(ring.exhaustActiveKey(), false, "fully exhausted");
    // Heal the key: recovery info expected.
    ring.markSuccess();
    // Reset proved: the next burst starts loud again even inside the old window.
    const afterReset = withSink(() => ring.exhaustActiveKey());
    assert.equal(
      afterReset.filter((c) => c.type === "warning").length,
      2,
      "next burst loud after markSuccess",
    );
  });

  const infos = calls.filter((c) => c.type === "info");
  assert.equal(infos.length, 1, "one recovery info");
  assert.match(infos[0].message, /Key index 0 succeeded — backoff cleared\./);
});

test("rotation: backoff-elapsed key is re-enabled with an info line (item 22)", () => {
  scrubProviderEnv();
  process.env.AGENT_ZERO_API_KEY = "only";
  const clock = { t: 0 };
  const ring = createKeyRing({
    prefix: "AGENT_ZERO_API_KEY",
    exhaustionNotice: VENICE_NOTICE,
    exhaustWarnWindowMs: 100,
    now: () => clock.t,
  });

  const calls = withSink(() => {
    // Fully exhaust the only key at t=0 (backoff for retry 1 = 20s).
    assert.equal(ring.exhaustActiveKey(), false);
    assert.equal(ring.getActiveKey(), null, "no key past backoff yet");
    // Advance past the 20s backoff: the key is re-enabled and served.
    clock.t = 20_001;
    assert.equal(ring.getActiveKey(), "only", "key re-enabled after backoff");
  });

  const infos = calls.filter((c) => c.type === "info");
  assert.ok(
    infos.some((c) =>
      /Key index 0 retry backoff elapsed \(20000ms\) — re-enabling\./.test(
        c.message,
      ),
    ),
    "backoff re-enable info emitted",
  );
});

test("health: snapshot tracks usable/exhausted/activeIndex through rotation (item 25)", () => {
  scrubProviderEnv();
  process.env.AGENT_ZERO_API_KEY_P0 = "k0";
  process.env.AGENT_ZERO_API_KEY_P1 = "k1";
  process.env.AGENT_ZERO_API_KEY_P2 = "k2";
  const ring = createKeyRing({ prefix: "AGENT_ZERO_API_KEY" });

  assert.deepEqual(ring.health(), {
    total: 3,
    usable: 3,
    exhausted: 0,
    activeIndex: 0,
  });
  assert.equal(ring.getActiveKey(), "k0");
  assert.equal(ring.exhaustActiveKey(), true);
  assert.deepEqual(ring.health(), {
    total: 3,
    usable: 2,
    exhausted: 1,
    activeIndex: 0,
  });
  // Next getActiveKey skips the exhausted k0 -> rotates to k1 (active index 1).
  assert.equal(ring.getActiveKey(), "k1");
  assert.deepEqual(ring.health(), {
    total: 3,
    usable: 2,
    exhausted: 1,
    activeIndex: 1,
  });
});

test("warnBelowKeyCount: configured low-key ring emits ONE creation warn with the add-keys hint (item 25)", () => {
  scrubProviderEnv();
  process.env.AGENT_ZERO_API_KEY = "solo";
  const clock = { t: 0 };

  const calls = withSink(() => {
    const ring = createKeyRing({
      prefix: "AGENT_ZERO_API_KEY",
      warnBelowKeyCount: 4,
      exhaustWarnWindowMs: 100,
      now: () => clock.t,
    });
    assert.equal(ring.size, 1, "single key created");
  });

  const warns = calls.filter((c) => c.type === "warning");
  assert.equal(warns.length, 1, "exactly one creation warn");
  assert.match(
    warns[0].message,
    /Only 1 key\(s\) configured — add AGENT_ZERO_API_KEY_P0\.\.P3/,
  );
  assert.match(warns[0].message, /so the ring survives a daily-quota window\./);
});

test("healthInRotationInfo: rotation info line carries keys-remaining when configured (item 25)", () => {
  scrubProviderEnv();
  process.env.AGENT_ZERO_API_KEY_P0 = "k0";
  process.env.AGENT_ZERO_API_KEY_P1 = "k1";
  const clock = { t: 0 };
  const ring = createKeyRing({
    prefix: "AGENT_ZERO_API_KEY",
    healthInRotationInfo: true,
    exhaustWarnWindowMs: 100,
    now: () => clock.t,
  });

  const calls = withSink(() => {
    assert.equal(ring.getActiveKey(), "k0");
    assert.equal(ring.exhaustActiveKey(), true);
    assert.equal(ring.getActiveKey(), "k1");
  });

  const infos = calls.filter((c) => c.type === "info");
  assert.equal(infos.length, 1, "exactly one rotation info");
  assert.match(infos[0].message, /Rotating to key index 1 \(was 0\)\./);
  assert.match(infos[0].message, /health: 1\/2 usable, 1 exhausted, active 1/);
});
