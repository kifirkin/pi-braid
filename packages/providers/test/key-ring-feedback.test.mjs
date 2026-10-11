#!/usr/bin/env node
/**
 * key-ring-feedback.test.mjs
 *
 * Revert-proof deterministic regression test for the direct-call feed-back:
 * a 429/403 from a direct LLM call must reach key-ring rotation so vision /
 * utility / max-power self-heal.
 *
 * The defect: exhaustActiveKey()/markSuccess()/the ALL-KEYS-EXHAUSTED warn
 * fire ONLY on agent-loop message_end (handleMessageEnd — the single
 * ring-lifecycle path). Direct extension LLM calls (telegram notify's
 * completeSimple; core callLlm for utility/max-power) never emit message_end,
 * so a 429/403 from them left NO trace in the ring: no exhaust, no rotation,
 * no warn — the ring served the same dead key forever on those paths.
 *
 * Fix under test: ring-lifecycle.ts now exports reportKeyRingFailure() /
 * reportKeyRingSuccess() (+ createKeyRingFeedbackHandler() /
 * publishKeyRingFeedback()), which resolve the ring from the reported
 * model/provider (resolveRingForMessage — per-event attribution, no module
 * global), classify with the SAME predicate as handleMessageEnd
 * (isKeyRotationError), and exhaust / mark-success through the ring's own
 * machinery. The next getActiveKey() (re-resolved per streamSimple) serves the
 * next key.
 *
 * Revert-proof: point PI_BRAID_PROVIDER_SRC_DIR at a PRE-FIX copy of
 * ring-lifecycle.ts (no reportKeyRingFailure export) and the first test FAILS
 * on a TypeError (undefined is not a function).
 *
 * Runtime: no npm install, no network. The handler chain is compiled with the
 * package's own local tsc (CJS emit) into <repoRoot>/.race-build-feedback/ and
 * loaded via createRequire. HOME is redirected to an isolated temp dir so
 * key-ring persistence never touches the real ~/.pi/agent.
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
const buildDir = join(repoRoot, ".race-build-feedback");

const VENICE_MODEL = "deepseek-v4-pro";
// Test-local synthetic secondary provider/ring (registerRoute seam).
const FIXTURE_PROVIDER = "fixture";
const FIXTURE_MODEL = "fixture/model-a";

/** Compile the handler chain to CJS in buildDir and load it. */
function loadHandlers() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  // Source-directory override lets us run the identical test against a pre-fix
  // copy of the handler module to prove revert-proofness (provider-race style).
  const srcDir = process.env.PI_BRAID_PROVIDER_SRC_DIR || pkgRoot;

  const args = [
    tscBin,
    "--ignoreConfig",
    join(srcDir, "ring-lifecycle.ts"),
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
  return require(join(buildDir, "ring-lifecycle.js"));
}

/** Scrub the ambient keyspace so real env vars cannot leak into the rings. */
function scrubProviderEnv() {
  for (const key of Object.keys(process.env)) {
    if (/^(AGENT_ZERO_API_KEY|FIXTURE_API_KEY)(_P\d+)?$/.test(key)) {
      delete process.env[key];
    }
  }
}

let scratch;
const mod = (() => {
  // Env MUST be set before the module loads (the rings read env at import).
  // Isolated key-ring persistence + sanitized keyspace, then load the chain.
  scratch = mkdtempSync(join(tmpdir(), "pi-braid-provider-feedback-"));
  process.env.HOME = scratch;
  scrubProviderEnv();
  // Venice: 3 keys (P0=k0 dedupes with the bare fallback var).
  process.env.AGENT_ZERO_API_KEY = "k0";
  process.env.AGENT_ZERO_API_KEY_P0 = "k0";
  process.env.AGENT_ZERO_API_KEY_P1 = "k1";
  process.env.AGENT_ZERO_API_KEY_P2 = "k2";
  process.env.FIXTURE_API_KEY = "fx-test-key-1";
  return loadHandlers();
})();

// Test-local synthetic second ring: per-event attribution and multi-ring
// isolation keep regression coverage without a second production provider.
const fixtureRing = createRequire(import.meta.url)(
  join(buildDir, "key-ring.js"),
).createKeyRing({
  prefix: "FIXTURE_API_KEY",
  stateFile: "fixture",
  healthInRotationInfo: true,
});
mod.registerRoute({
  providerId: FIXTURE_PROVIDER,
  keys: "FIXTURE_API_KEY",
  modelIds: [FIXTURE_MODEL],
  ring: fixtureRing,
});

const usable = (p) => mod.getKeyRingStatusForTest(p)?.usable;
const nextKey = (p) => mod.getActiveKeyForTest(p);
const fail = (model, provider, err) =>
  mod.reportKeyRingFailure(model, provider, err);
const succeed = (model, provider) => mod.reportKeyRingSuccess(model, provider);

after(async () => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });
  // Restore the ambient keyspace so we never leave sanitized test keys behind.
  scrubProviderEnv();
});

test("fixture env: agent-zero ring has 3 keys, first selectable key is k0", () => {
  assert.equal(usable("agent-zero"), 3);
  assert.equal(nextKey("agent-zero"), "k0");
});

test("REVERT-PROOF: direct 403 feeds back: agent-zero key0 exhausted, next getActiveKey serves k1 (no message_end)", () => {
  // Pre-fix ring-lifecycle.ts has no reportKeyRingFailure export => TypeError.
  assert.equal(typeof mod.reportKeyRingFailure, "function");
  assert.equal(typeof mod.reportKeyRingSuccess, "function");

  const acted = fail(VENICE_MODEL, "agent-zero", "403 User has no quota left");
  assert.equal(acted, true, "rotatable 403 returns true (ring exhausted)");
  // Exactly one of three keys used; the next request would select a DIFFERENT
  // key — the auto-flip, exactly like handleMessageEnd's exhaust path.
  assert.equal(usable("agent-zero"), 2);
  assert.equal(nextKey("agent-zero"), "k1");
});

test("attribution: an agent-zero 403 never touches the fixture ring (per-event, no last-writer-wins)", () => {
  assert.equal(usable(FIXTURE_PROVIDER), 1);
  assert.equal(nextKey(FIXTURE_PROVIDER), "fx-test-key-1");
  // And a non-rotatable error on the fixture model is a lossy-safe no-op.
  assert.equal(
    fail(FIXTURE_MODEL, FIXTURE_PROVIDER, "context length limit exceeded"),
    false,
  );
  assert.equal(usable(FIXTURE_PROVIDER), 1, "fixture key NOT exhausted");
  assert.equal(nextKey(FIXTURE_PROVIDER), "fx-test-key-1");
});

test("guard: foreign-model error returns false and touches no ring", () => {
  const before = usable("agent-zero");
  assert.equal(fail("gpt-4.1", "openai", "403 forbidden"), false);
  assert.equal(
    usable("agent-zero"),
    before,
    "agent-zero ring untouched by foreign model",
  );
  assert.equal(usable(FIXTURE_PROVIDER), 1, "fixture ring untouched");
});

test("guard: empty / non-rotatable error text returns false (lossy-safe)", () => {
  assert.equal(fail(VENICE_MODEL, "agent-zero", ""), false);
  assert.equal(fail(VENICE_MODEL, "agent-zero", undefined), false);
  assert.equal(fail(VENICE_MODEL, "agent-zero", "connection reset"), false);
  assert.equal(usable("agent-zero"), 2, "still 2 usable after no-op failures");
});

test("success feed-back heals the serving key (mirrors handleMessageEnd success)", () => {
  // k1 is the active key (k0 exhausted by the first test); a success heals it.
  succeed(VENICE_MODEL, "agent-zero");
  assert.equal(usable("agent-zero"), 2, "k1 healed back to usable");
  assert.equal(
    nextKey("agent-zero"),
    "k1",
    "active key remains k1 (not exhausted)",
  );
  // k0 stays exhausted — success heals the SERVING key, not a past one.
  assert.equal(usable("agent-zero"), 2);
});

test("direct 403s rotate through k1 -> k2 -> ALL KEYS EXHAUSTED (same warn machinery as handleMessageEnd)", () => {
  // k1 is active: exhaust it, next serves k2.
  assert.equal(
    fail(VENICE_MODEL, "agent-zero", "403 User has no quota left"),
    true,
  );
  assert.equal(usable("agent-zero"), 1);
  assert.equal(nextKey("agent-zero"), "k2");

  // k2 is active: exhaust it — all three keys are now dead.
  assert.equal(
    fail(VENICE_MODEL, "agent-zero", "403 User has no quota left"),
    true,
  );
  assert.equal(usable("agent-zero"), 0);
  // No key is past backoff yet, so the next request gets null (auth fails
  // loudly) instead of looping on a dead key — identical to handleMessageEnd.
  assert.equal(nextKey("agent-zero"), null);
});

test("createKeyRingFeedbackHandler end-to-end on the fixture ring (the exact object callLlm/vision invoke)", () => {
  const handler = mod.createKeyRingFeedbackHandler();
  assert.equal(typeof handler.reportFailure, "function");
  assert.equal(typeof handler.reportSuccess, "function");

  // Healthy ring: success is a no-op (no redundant state write).
  succeed(FIXTURE_MODEL, FIXTURE_PROVIDER);
  assert.equal(usable(FIXTURE_PROVIDER), 1);

  // A 403 via the handler object exhausts the fixture ring.
  handler.reportFailure(FIXTURE_MODEL, FIXTURE_PROVIDER, "403 forbidden");
  assert.equal(usable(FIXTURE_PROVIDER), 0);
  assert.equal(nextKey(FIXTURE_PROVIDER), null);

  // Success via the handler object heals it.
  handler.reportSuccess(FIXTURE_MODEL, FIXTURE_PROVIDER);
  assert.equal(usable(FIXTURE_PROVIDER), 1);
  assert.equal(nextKey(FIXTURE_PROVIDER), "fx-test-key-1");
});

test("publishKeyRingFeedback registers the handler into the process-global seam core/vision read", () => {
  mod.publishKeyRingFeedback();
  const slot = globalThis[mod.KEY_RING_FEEDBACK_KEY];
  assert.ok(
    slot && typeof slot.reportFailure === "function",
    "handler published",
  );
  assert.equal(typeof slot.reportSuccess, "function");
  // The published handler actually drives the ring.
  slot.reportFailure(VENICE_MODEL, "agent-zero", "401 invalid api key");
  assert.equal(
    usable("agent-zero"),
    0,
    "published handler exhausted the agent-zero ring",
  );
});

test("isKeyRotationError: the shared classification predicate (identical to handleMessageEnd)", () => {
  const fn = mod.isKeyRotationError;
  assert.equal(fn("403 user has no quota left"), true);
  assert.equal(fn("402 payment required"), true);
  assert.equal(fn("401 unauthorized"), true);
  assert.equal(fn("invalid api key"), true);
  assert.equal(fn("insufficient balance"), true);
  assert.equal(fn("billing statement"), true);
  // Non-rotatable errors must NOT classify.
  assert.equal(fn("context length limit exceeded"), false);
  assert.equal(fn("connection reset"), false);
  assert.equal(fn(""), false);
});

test("isKeyRotationError: WAF/infra HTML pages are NEVER key-rotation", () => {
  const fn = mod.isKeyRotationError;
  // Real observed bodies: edge/WAF 403 as an HTML page (not a JSON error).
  assert.equal(
    fn(
      '403 <!doctype html> <html lang="en"> <head><meta charset="utf-8" /><title>Access denied</title></head><body>blocked</body></html>',
    ),
    false,
    "edge HTML 403 page must NOT exhaust a healthy key",
  );
  assert.equal(
    fn("403 <html><body>cf-ray: abc123\nCloudflare</body></html>"),
    false,
    "Cloudflare page must NOT exhaust",
  );
  assert.equal(fn("403 just a moment..."), false, "cloudflare challenge page");
  assert.equal(fn("403 attention required"), false, "cloudflare block page");
  // But a REAL JSON quota/auth error with the same status STILL rotates.
  assert.equal(fn('403 {"error":"User has no quota left"}'), true);
  assert.equal(fn('401 {"error":"invalid api key"}'), true);
  assert.equal(fn("403 forbidden"), true); // bare status text, no HTML body
});

test("reportKeyRingFailure: WAF/infra block leaves the key healthy", () => {
  const before = usable("agent-zero");
  const wafBody =
    '403 <!doctype html><html lang="en"><head><title>Access denied</title></head></html>';
  assert.equal(
    fail(VENICE_MODEL, "agent-zero", wafBody),
    false,
    "WAF block returns false (no exhaustion)",
  );
  assert.equal(
    usable("agent-zero"),
    before,
    "healthy keys NOT reduced by an edge/WAF page",
  );
});
