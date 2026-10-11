#!/usr/bin/env node
/**
 * providers-log.test.mjs
 *
 * Deterministic regression test: providers' key-ring /
 * ring-lifecycle diagnostics must route through the native notify sink and
 * NEVER console.* — any extension console write in the live pi TUI lands in
 * the owner's INPUT line and corrupts it.
 *
 * Contract under test (packages/providers/log.ts):
 *   - `setProvidersLogSink(fn)` binds a notify-shaped sink (same signature as
 *     pi's ctx.ui.notify — (message, type: "info"|"warning"|"error")).
 *   - `providerLog("info"|"warn"|"error", scope, message)` routes info →
 *     notify "info", warn → notify "warning", error → notify "error",
 *     prefixed `[<scope>] ` (info level).
 *   - With NO sink bound it is a silent no-op — never console.*.
 *   - `createThrottledLogger` (item 22): first occurrence loud, consecutive
 *     repeats inside the window silently dropped, re-loud once per window;
 *     streak()/reset() for recovery; age-out restarts loud.
 *   - Plus a static src scan: zero active console.* call sites in
 *     packages/providers/*.ts (reintroduction guard).
 *
 * Runtime: no npm install, no network. log.ts has zero imports, so it is
 * compiled with the package's own local tsc (CJS emit) into a transient
 * <repoRoot>/.race-build-log/ dir (mirrors the provider-race test pattern)
 * and loaded via createRequire — the module-level sink state is shared across
 * all assertions in this file via that single instance.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  rmSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
const buildDir = join(repoRoot, ".race-build-log");

/** Compile log.ts to CJS in buildDir and load it (single shared module state). */
function loadLogModule() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });
  const srcDir = process.env.PI_BRAID_PROVIDER_SRC_DIR || pkgRoot;
  const args = [
    tscBin,
    "--ignoreConfig",
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
  return require(join(buildDir, "log.js"));
}

const { setProvidersLogSink, providerLog, createThrottledLogger } =
  loadLogModule();

after(() => {
  setProvidersLogSink(undefined);
  rmSync(buildDir, { recursive: true, force: true });
});

/** Swap console methods with recorders for fn; returns recorded calls. */
function withConsole(fn) {
  const calls = [];
  const record =
    (method) =>
    (...args) =>
      calls.push({ method, args });
  const saved = {
    debug: console.debug,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.debug = record("debug");
  console.info = record("info");
  console.warn = record("warn");
  console.error = record("error");
  try {
    fn();
    return calls;
  } finally {
    console.debug = saved.debug;
    console.info = saved.info;
    console.warn = saved.warn;
    console.error = saved.error;
  }
}

/** Run fn with a recording notify sink bound; restores (clears) the sink after. */
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

test("log: NO console.* with no sink bound — warn/error are silent (16g)", () => {
  setProvidersLogSink(undefined);
  const calls = withConsole(() => {
    providerLog(
      "warn",
      "providers/key-ring",
      "[key-ring:AGENT_ZERO_API_KEY] Key index 0 exhausted (retry 1, backoff 20000ms, 0/1 usable)",
    );
    providerLog(
      "warn",
      "providers/ring-lifecycle",
      '[pi-braid-providers] Agent LLM error (agent-zero): "403 User has no quota left" — exhausting active key + persisting state.',
    );
    providerLog(
      "error",
      "providers/key-ring",
      "[key-ring:AGENT_ZERO_API_KEY] failed to persist state: boom",
    );
  });
  assert.equal(
    calls.length,
    0,
    "no sink => zero console output, even for warn/error",
  );
});

test("log: warn + error route to the notify sink with warning/error level (never console)", () => {
  const consoleCalls = withConsole(() => {
    const sinkCalls = withSink(() => {
      providerLog(
        "warn",
        "providers/key-ring",
        "[key-ring:AGENT_ZERO_API_KEY] Key index 0 exhausted (retry 1, backoff 20000ms, 0/1 usable)",
      );
      providerLog(
        "warn",
        "providers/ring-lifecycle",
        '[pi-braid-providers] Agent LLM error (agent-zero): "403" — exhausting active key + persisting state.',
      );
      providerLog(
        "error",
        "providers/key-ring",
        "[key-ring:AGENT_ZERO_API_KEY] failed to persist state: boom",
      );
    });
    assert.equal(sinkCalls.length, 3);
    assert.equal(sinkCalls[0].type, "warning");
    assert.equal(
      sinkCalls[0].message,
      "[providers/key-ring] [key-ring:AGENT_ZERO_API_KEY] Key index 0 exhausted (retry 1, backoff 20000ms, 0/1 usable)",
    );
    assert.equal(sinkCalls[1].type, "warning");
    assert.match(
      sinkCalls[1].message,
      /^\[providers\/ring-lifecycle\] \[pi-braid-providers\] Agent LLM error \(agent-zero\):/,
    );
    assert.equal(sinkCalls[2].type, "error");
    assert.match(sinkCalls[2].message, /^\[providers\/key-ring\]/);
  });
  assert.equal(
    consoleCalls.length,
    0,
    "sink route never touches console.* — the TUI is not polluted",
  );
});

test("log: setProvidersLogSink(undefined) clears the sink — silent again", () => {
  let sinkCalls = 0;
  setProvidersLogSink(() => {
    sinkCalls++;
  });
  providerLog("warn", "providers/key-ring", "boom");
  assert.equal(sinkCalls, 1, "bound sink receives the warn");
  setProvidersLogSink(undefined);
  const consoleCalls = withConsole(() => {
    providerLog("warn", "providers/key-ring", "boom again");
    providerLog("error", "providers/key-ring", "nope");
  });
  assert.equal(sinkCalls, 1, "cleared sink receives nothing");
  assert.equal(consoleCalls.length, 0, "cleared sink still never console.*");
});

test("log: info level routes to the notify sink as type info (item 22 rotation surfacing)", () => {
  const consoleCalls = withConsole(() => {
    const sinkCalls = withSink(() => {
      providerLog(
        "info",
        "providers/key-ring",
        "[key-ring:AGENT_ZERO_API_KEY] Rotating to key index 1 (was 0).",
      );
    });
    assert.equal(sinkCalls.length, 1);
    assert.equal(sinkCalls[0].type, "info");
    assert.equal(
      sinkCalls[0].message,
      "[providers/key-ring] [key-ring:AGENT_ZERO_API_KEY] Rotating to key index 1 (was 0).",
    );
  });
  assert.equal(
    consoleCalls.length,
    0,
    "info route never touches console.* — the TUI is not polluted",
  );
});

test("throttle: first occurrence loud, repeats silent inside window, re-loud after window (item 22)", () => {
  let clock = 0;
  const logs = createThrottledLogger(100, () => clock);
  const sinkCalls = withSink(() => {
    // t=0: first occurrence is loud.
    assert.equal(
      logs.occurrence("warn", "providers/ring-lifecycle", "flush"),
      true,
      "first is loud",
    );
    assert.equal(logs.streak(), 1);
    // t=10: repeat within window is silent.
    clock = 10;
    assert.equal(
      logs.occurrence("warn", "providers/ring-lifecycle", "flush"),
      false,
      "repeat inside window is silent",
    );
    assert.equal(logs.streak(), 2);
    // t=99: still inside the window (99-0 < 100) — silent.
    clock = 99;
    assert.equal(
      logs.occurrence("warn", "providers/ring-lifecycle", "flush"),
      false,
      "still inside window is silent",
    );
    // t=100: window elapsed since last LOUD -> re-loud exactly once.
    clock = 100;
    assert.equal(
      logs.occurrence("warn", "providers/ring-lifecycle", "flush"),
      true,
      "re-louds once the window passes",
    );
  });
  assert.equal(
    sinkCalls.length,
    2,
    "exactly two loud lines across the burst — no per-occurrence spam",
  );
  assert.equal(sinkCalls[0].type, "warning");
  assert.equal(sinkCalls[1].type, "warning");
});

test("throttle: reset clears state so the next burst starts loud; streak 0 after reset (item 22)", () => {
  const logs = createThrottledLogger(100, () => 0);
  const sinkCalls = withSink(() => {
    assert.equal(logs.occurrence("warn", "providers/key-ring", "one"), true);
    assert.equal(
      logs.occurrence("warn", "providers/key-ring", "two"),
      false,
      "repeat silent",
    );
    logs.reset();
    assert.equal(logs.streak(), 0, "reset zeroes the streak");
    assert.equal(
      logs.occurrence("warn", "providers/key-ring", "three"),
      true,
      "next burst starts loud",
    );
  });
  assert.equal(sinkCalls.length, 2, "reset allows one loud per burst");
});

test("throttle: burst that ages out past a full window starts loud again (16d semantics)", () => {
  let clock = 0;
  const logs = createThrottledLogger(100, () => clock);
  const sinkCalls = withSink(() => {
    assert.equal(logs.occurrence("error", "providers/key-ring", "a"), true);
    // 150ms later with NO further occurrences: burst has aged out.
    clock = 150;
    assert.equal(
      logs.occurrence("error", "providers/key-ring", "b"),
      true,
      "aged-out burst starts loud",
    );
  });
  assert.equal(sinkCalls.length, 2);
  assert.equal(sinkCalls[0].type, "error");
  assert.equal(sinkCalls[1].type, "error");
});

test("src: no console.* call sites anywhere in packages/providers (TUI can never be polluted)", () => {
  const offenders = [];
  for (const name of readdirSync(pkgRoot)) {
    if (!name.endsWith(".ts")) continue;
    const p = join(pkgRoot, name);
    if (statSync(p).isDirectory()) continue;
    // Strip comments so doc prose mentioning console is ignored.
    const stripped = readFileSync(p, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    stripped.split("\n").forEach((line, i) => {
      if (/console\.(log|warn|error|info|debug)\s*\(/.test(line)) {
        offenders.push(`${name}:${i + 1}`);
      }
    });
  }
  assert.deepEqual(offenders, [], "no active console.* call in providers src");
});
