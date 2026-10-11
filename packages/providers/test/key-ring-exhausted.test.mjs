#!/usr/bin/env node
/**
 * key-ring-exhausted.test.mjs
 *
 * Revert-proof deterministic regression test for §5b-1 ("agent-zero transient
 * key exhaustion must NOT surface as 'Provider is not configured'").
 *
 * Regression (pre-fix): auth.apiKey.resolve (keyRingAuth in index.ts) returned
 * undefined whenever getActiveKey() was null. pi-core's prepareRequest treats a
 * falsy resolution as genuinely misconfigured and throws
 *   ModelsError: Provider is not configured: agent-zero
 * So when ALL keys were only TRANSIENTLY exhausted (every key in backoff after
 * quota/403) a new turn was cancelled with a config MISLABEL, misleading the
 * owner and any retry logic into believing the config was missing.
 *
 * Fix under test: ring-lifecycle.resolveKeyRingAuth discriminates the two
 * null-key states —
 *   - health().total === 0            -> resolve undefined ("Provider is not
 *     configured" stays ACCURATE for a genuinely unconfigured ring);
 *   - health().total > 0 && isFullyExhausted() -> resolve a TRUTHY sentinel
 *     (TRANSIENT_EXHAUSTION_API_KEY) so prepareRequest proceeds and the
 *     provider's REAL 401/403 reaches ring-lifecycle backoff/rotation, never
 *     the config mislabel — plus a throttled steering whisper through the
 *     existing providerLog / notify channel (mandated open-question 2 = YES).
 *
 * Revert-proof: point PI_BRAID_PROVIDER_SRC_DIR at a PRE-FIX copy (or `git
 * stash` the source files) and resolveKeyRingAuth disappears from the build;
 * the fixture then falls back to a VERBATIM transcription of HEAD's inline
 * keyRingAuth.resolve (returns undefined for null getActiveKey), so the
 * TRANSIENT assertions FAIL (undefined resolution) while the total === 0 and
 * healthy assertions still PASS.
 *
 * Runtime: no npm install, no network. ring-lifecycle.ts (+ deps, no pi-ai
 * runtime import) is compiled with the package's own local tsc (CJS emit) into
 * <repoRoot>/.race-build-exhausted* dirs and loaded via createRequire. HOME
 * is redirected to an isolated temp dir so key-ring persistence never touches
 * the real ~/.pi/agent.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
const buildDir = join(repoRoot, ".race-build-exhausted");
const buildDirNoKeys = join(repoRoot, ".race-build-exhausted-nokeys");

const VENICE_MODEL = "deepseek-v4-pro";

// Redirect HOME so key-ring persisted state (.key-ring-state-agent-zero.json) can
// never touch the real ~/.pi/agent; cleaned after the run.
const scratch = mkdtempSync(join(tmpdir(), "pi-braid-provider-exhausted-"));
process.env.HOME = scratch;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });
  rmSync(buildDirNoKeys, { recursive: true, force: true });
});

/**
 * Compile the handler chain to CJS in a transient build dir and load it plus
 * its log module (the SAME log.js singleton ring-lifecycle.js links to, so a
 * bound sink here captures the steering whisper).
 */
function loadHandlers(dir = buildDir) {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  // Source-directory override lets us run the identical test against a pre-fix
  // copy of the handler module (provider-race style revert-proofness).
  const srcDir = process.env.PI_BRAID_PROVIDER_SRC_DIR || pkgRoot;

  const args = [
    tscBin,
    "--ignoreConfig", // sources passed on CLI; the package tsconfig.json is intentionally bypassed
    join(srcDir, "ring-lifecycle.ts"),
    join(srcDir, "key-ring.ts"),
    join(srcDir, "log.ts"),
    "--outDir",
    dir,
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
    mod: require(join(dir, "ring-lifecycle.js")),
    logMod: require(join(dir, "log.js")),
  };
}

/**
 * Sanitize the provider keyspace so ambient AGENT_ZERO_API_KEY_P* (which the
 * real setup may export) cannot leak into the ring.
 */
function sanitizeEnv() {
  for (const key of Object.keys(process.env)) {
    if (/^AGENT_ZERO_API_KEY(_P\d+)?$/.test(key)) delete process.env[key];
  }
}

// The fixed build exports resolveKeyRingAuth; a pre-fix build (git stash of
// source, or PI_BRAID_PROVIDER_SRC_DIR pointing at HEAD) does NOT. In that
// case fall back to a VERBATIM transcription of HEAD's inline
// keyRingAuth.resolve — returning undefined for a null getActiveKey — so the
// transient assertions FAIL pre-fix while non-transient ones still pass.
function makeResolveAuth(mod) {
  if (typeof mod.resolveKeyRingAuth === "function")
    return mod.resolveKeyRingAuth;
  // Pre-fix (HEAD) semantics — the §5b-1 defect this fixture regresses.
  return (_name, ring) => {
    const key = ring.getActiveKey();
    if (!key) return undefined;
    return { auth: { apiKey: key }, source: "key-ring" };
  };
}

// ── Real-ring module WITH one agent-zero key: healthy + transient integration ────
sanitizeEnv();
process.env.AGENT_ZERO_API_KEY = "venice-test-key-1";
const { mod, logMod } = loadHandlers();
const resolveAuth = makeResolveAuth(mod);

// Bind the notify sink through the SHARED log module before any exhausted
// branch runs, so the throttled steering whisper's first (loud) occurrence is
// captured. providerLog is otherwise a silent no-op without a sink.
const sinkCalls = [];
logMod.setProvidersLogSink((message, type) =>
  sinkCalls.push({ message, type }),
);

// Mock rings: isolate the resolution contract from the real ring wiring.
const transientRing = () => ({
  getActiveKey: () => null,
  health: () => ({ total: 2 }),
  isFullyExhausted: () => true,
});
const emptyRing = () => ({
  getActiveKey: () => null,
  health: () => ({ total: 0 }),
  isFullyExhausted: () => true,
});
const healthyRing = () => ({
  getActiveKey: () => "sk-live-1",
  health: () => ({ total: 1 }),
  isFullyExhausted: () => false,
});

test("(a) all keys transiently exhausted -> truthy resolution, NOT 'Provider is not configured'", () => {
  const r = resolveAuth("Venice API key", transientRing());
  assert.ok(
    r,
    "transiently exhausted ring must resolve truthy — undefined would make pi-core throw the config mislabel",
  );
  assert.equal(r.source, "key-ring");
  assert.equal(
    r.auth.apiKey,
    mod.TRANSIENT_EXHAUSTION_API_KEY ?? "pi-braid-key-ring-exhausted",
  );
});

test("(b) total === 0 -> resolution undefined (config error preserved)", () => {
  assert.equal(resolveAuth("Venice API key", emptyRing()), undefined);
});

test("(c) healthy active key -> normal resolution unchanged", () => {
  assert.deepEqual(resolveAuth("Venice API key", healthyRing()), {
    auth: { apiKey: "sk-live-1" },
    source: "key-ring",
  });
});

test("(d) REAL agent-zero ring resolves the sentinel once its key is transiently exhausted", () => {
  // Drive the REAL ring-lifecycle path to exhaust the single real agent-zero key.
  const msg = mod.handleMessageEnd({
    message: {
      provider: "agent-zero",
      model: VENICE_MODEL,
      stopReason: "error",
      errorMessage: "401 invalid api key",
    },
  });
  assert.equal(msg, undefined); // single key, all gone -> no self-heal retry rewrite
  const status = mod.getKeyRingStatusForTest("agent-zero");
  assert.equal(status.total, 1);
  assert.equal(status.usable, 0, "agent-zero key exhausted by its own 401");

  const r = resolveAuth("Venice API key", mod.veniceKeyRing);
  assert.ok(
    r,
    "fully exhausted REAL ring must still resolve truthy — never the config mislabel",
  );
  assert.equal(r.source, "key-ring");
  assert.equal(
    r.auth.apiKey,
    mod.TRANSIENT_EXHAUSTION_API_KEY ?? "pi-braid-key-ring-exhausted",
  );
});

test("(e) exhausted branch emits a steering whisper via the existing log channel", () => {
  const whispers = sinkCalls.filter((c) =>
    /transiently exhausted/.test(c.message),
  );
  assert.ok(
    whispers.length > 0,
    "expected a steering-whisper warn through providerLog/notify",
  );
  assert.match(whispers[0].message, /NOT a configuration error/);
});

// ── Real-ring module with NO agent-zero keys: genuinely unconfigured ─────────────
test("(f) REAL ring with zero configured keys resolves undefined (accurately 'not configured')", () => {
  sanitizeEnv(); // no AGENT_ZERO_API_KEY* at all
  const { mod: noKeys } = loadHandlers(buildDirNoKeys);
  assert.equal(noKeys.getKeyRingStatusForTest("agent-zero").total, 0);
  const rAuth = makeResolveAuth(noKeys);
  assert.equal(rAuth("Venice API key", noKeys.veniceKeyRing), undefined);
});
