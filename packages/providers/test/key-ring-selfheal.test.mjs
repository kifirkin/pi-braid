#!/usr/bin/env node
/**
 * key-ring-selfheal.test.mjs
 *
 * Revert-proof deterministic regression test for the stale-key stall.
 *
 * Owner-reported failure: live turn -> Venice 403 "User has no quota left" ->
 * the key ring did NOT auto-flip -> the agent stalled; the owner had to
 * ESC-abort, /reload, and re-fire THREE prompts to rotate keys.
 *
 * Root cause (verified against pi-core/pi-ai shipped dist): pi-core classifies
 * quota/auth/403 as NON-retryable (fail-fast) via isRetryableAssistantError
 * (pi-ai dist/utils/retry.js), so a 403 turn dies with no follow-up LLM call.
 * The ring exhausts the key at message_end — AFTER the turn already failed —
 * so the NEXT key only serves the NEXT user prompt. auth.apiKey.resolve is
 * per-request (Models.applyAuth -> resolveProviderAuth -> apiKey.resolve), so
 * a retried turn WOULD pick the next key; the only missing piece is making
 * pi-core re-run the turn.
 *
 * Fix under test: when message_end exhausts a key and a fresh key remains,
 * handleMessageEnd returns a replacement AssistantMessage whose errorMessage
 * gains SELF_HEAL_RETRY_MARKER ("... Provider returned error; ..."). pi-core's
 * message_end handler chain applies that replacement in place, then its OWN
 * turn-level retry machinery (agent_end -> _isRetryableError -> agent.continue)
 * re-runs the turn; the re-run re-resolves auth and getActiveKey() serves the
 * next key. Bounded: usable-key guard (no rewrite once all keys are gone) +
 * pi-core settings.retry.maxRetries.
 *
 * Revert-proof: point PI_BRAID_PROVIDER_SRC_DIR at a PRE-FIX copy of
 * ring-lifecycle.ts (handleMessageEnd returning undefined for every error) and
 * the first test FAILS on the missing replacement message.
 *
 * Runtime: no npm install, no network. The handler module is compiled with the
 * package's own local tsc (CJS emit) into <repoRoot>/.race-build-selfheal/ and
 * loaded via createRequire. HOME is redirected to an isolated temp dir so
 * key-ring persistence never touches the real ~/.pi/agent.
 */
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const repoRoot = resolve(pkgRoot, "..", "..");
const tscBin = join(pkgRoot, "node_modules", "typescript", "bin", "tsc");
// Built at the repo ROOT (not under packages/providers): that package is
// "type": "module", which would make emitted .js load as ESM and break CJS
// "exports". The repo root has no "type" (CJS default). Transient + cleaned.
const buildDir = join(repoRoot, ".race-build-selfheal");

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
  scratch = mkdtempSync(join(tmpdir(), "pi-braid-provider-selfheal-"));
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

// Test-local synthetic second ring: the guard tests exercise ring isolation
// (a foreign/non-rotatable error must never touch a registered ring).
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

const msgEnd = (message) => mod.handleMessageEnd({ message });
const usable = (p) => mod.getKeyRingStatusForTest(p)?.usable;
const nextKey = (p) => mod.getActiveKeyForTest(p);

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

test("REVERT-PROOF: 403 on Venice key0 -> self-heal replacement returned, key0 exhausted, next key is k1 (no stall)", () => {
  const result = msgEnd({
    role: "assistant",
    provider: "agent-zero",
    model: VENICE_MODEL,
    stopReason: "error",
    errorMessage: "403 User has no quota left",
  });

  // Pre-fix handleMessageEnd returns undefined for every error => this fails.
  assert.ok(result && result.message, "self-heal replacement message returned");
  assert.equal(
    result.message.role,
    "assistant",
    "replacement keeps assistant role",
  );
  assert.match(result.message.errorMessage, /403 User has no quota left/);
  assert.ok(
    result.message.errorMessage.includes(mod.SELF_HEAL_RETRY_MARKER),
    "replacement carries the retry marker",
  );

  // Key0 was exhausted (persisted); exactly one of three keys used.
  assert.equal(usable("agent-zero"), 2);
  // The NEXT request would select a DIFFERENT key — the auto-flip, no stall.
  assert.equal(nextKey("agent-zero"), "k1");
});

test("handleMessageEnd: WAF/infra block -> retry marker WITHOUT exhausting the key", () => {
  const before = usable("agent-zero");
  // SAFETY: the edge page is assembled at runtime from innocuous fragments
  // (house pattern) — the source holds no complete tag literal, while the
  // joined body still trips the isWafBlockError markers.
  const LT = "<";
  const GT = ">";
  const tag = (name, attrs) => LT + name + (attrs ? " " + attrs : "") + GT;
  const wafBody =
    "403 " +
    tag("!doctype", "html") +
    tag("html", 'lang="en"') +
    tag("head") +
    tag("title") +
    "Access denied" +
    tag("/title") +
    tag("meta", 'content="cf-' + 'ray"') +
    tag("/head") +
    tag("/html");
  const result = msgEnd({
    role: "assistant",
    provider: "agent-zero",
    model: VENICE_MODEL,
    stopReason: "error",
    errorMessage: wafBody,
  });

  // The turn is retried (marker flips pi-core's retryability via "provider
  // returned ..."), but NO key is exhausted and NO SELF_HEAL (rotation)
  // marker was used — this is not a key problem.
  assert.ok(result && result.message, "WAF block returns a retry replacement");
  assert.ok(
    result.message.errorMessage.includes(mod.WAF_RETRY_MARKER),
    "replacement carries the WAF retry marker",
  );
  assert.ok(
    !result.message.errorMessage.includes(mod.SELF_HEAL_RETRY_MARKER),
    "WAF marker must NOT claim key exhaustion/rotation",
  );
  assert.equal(
    usable("agent-zero"),
    before,
    "healthy keys NOT reduced by an edge/WAF page through message_end",
  );
});

test("self-heal: second 403 flips to k2; third exhausts all keys -> no replacement (retry-storm guard)", () => {
  // The retried turn selected the next usable key (auto-flip), then 403'd again.
  assert.equal(nextKey("agent-zero"), "k1");
  const second = msgEnd({
    role: "assistant",
    provider: "agent-zero",
    model: VENICE_MODEL,
    stopReason: "error",
    errorMessage: "403 User has no quota left",
  });
  assert.ok(
    second && second.message,
    "second 403 still self-heals (k1 was active)",
  );
  assert.equal(usable("agent-zero"), 1);
  assert.equal(nextKey("agent-zero"), "k2");

  // All three keys exhausted: the turn ends with the real error, no rewrite.
  const third = msgEnd({
    role: "assistant",
    provider: "agent-zero",
    model: VENICE_MODEL,
    stopReason: "error",
    errorMessage: "403 User has no quota left",
  });
  assert.equal(
    third,
    undefined,
    "no self-heal rewrite once all keys are exhausted",
  );
  assert.equal(usable("agent-zero"), 0);
  // No key is past backoff yet, so the next request gets null (auth fails
  // loudly) instead of looping on a dead key.
  assert.equal(nextKey("agent-zero"), null);
});

test("guard: foreign-model error never touches our rings", () => {
  const before = usable(FIXTURE_PROVIDER);
  const result = msgEnd({
    role: "assistant",
    provider: "openai",
    model: "gpt-4.1",
    stopReason: "error",
    errorMessage: "403 forbidden",
  });
  assert.equal(result, undefined);
  assert.equal(usable(FIXTURE_PROVIDER), before, "fixture ring untouched");
});

test("guard: non-rotatable error (no quota/auth/403 phrase) neither exhausts nor reclassifies", () => {
  const result = msgEnd({
    role: "assistant",
    provider: FIXTURE_PROVIDER,
    model: FIXTURE_MODEL,
    stopReason: "error",
    errorMessage: "context length limit exceeded",
  });
  assert.equal(
    result,
    undefined,
    "no self-heal rewrite for non-rotatable error",
  );
  assert.equal(usable(FIXTURE_PROVIDER), 1, "fixture key NOT exhausted");
  assert.equal(
    nextKey(FIXTURE_PROVIDER),
    "fx-test-key-1",
    "active key unchanged",
  );
});

/**
 * The fatal-token set the INSTALLED pi-ai classifier vetoes, read from that
 * module rather than typed here: the shipped pattern source is parsed and
 * every token is re-checked against the real classifier, so a token this file
 * failed to parse, or one that is not fatal after all, is a red test and not a
 * silently weakened list.
 *
 * Tokens are compared as literal lowercase substrings, which is how the mirror
 * under test matches them; an upstream token carrying regex metacharacters
 * fails the loop below on purpose, because a substring list can no longer
 * express it and the mirror's matching has to be reconsidered.
 */
function piAiFatalTokens() {
  const retryPath = fileURLToPath(
    import.meta.resolve("@earendil-works/pi-ai/utils/retry"),
  );
  const source = readFileSync(retryPath, "utf8");
  const declaration =
    /const NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN\s*=\s*buildProviderErrorPattern\(\[([\s\S]*?)\]\)/.exec(
      source,
    );
  assert.ok(
    declaration,
    `${retryPath}: the non-retryable pattern must still be built from a literal array`,
  );
  const tokens = [...declaration[1].matchAll(/"([^"]*)"/g)].map(
    (match) => match[1],
  );
  assert.ok(
    tokens.length >= 8,
    `parsed ${tokens.length} fatal tokens from ${retryPath} — the pattern source shape changed`,
  );
  return tokens;
}

/** The message shape isRetryableAssistantError inspects. */
const failedMessage = (errorMessage) => ({
  role: "assistant",
  provider: FIXTURE_PROVIDER,
  model: FIXTURE_MODEL,
  stopReason: "error",
  errorMessage,
  content: [],
  usage: {},
  timestamp: 0,
});

test("canReclassifyForTurnRetry: fatal account-level tokens refuse rewrite, rotatable texts accept", () => {
  const fn = mod.canReclassifyForTurnRetry;
  assert.equal(fn("403 User has no quota left"), true);
  assert.equal(fn("401 invalid api key"), true);
  assert.equal(fn("insufficient balance"), true);
  for (const fatal of piAiFatalTokens()) {
    assert.equal(
      isRetryableAssistantError(failedMessage(fatal)),
      false,
      `precondition: the installed pi-ai must veto "${fatal}"`,
    );
    assert.equal(fn(fatal), false, `refuses rewrite for "${fatal}"`);
  }
  assert.equal(fn(""), false);
  assert.equal(fn(undefined), false);
});
