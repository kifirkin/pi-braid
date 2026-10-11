#!/usr/bin/env node
/**
 * ring-provider.test.mjs
 *
 * Suite for `ring-provider.ts`: the api-key auth that resolves a route's key
 * from its key ring, and the re-pointing of a pi-ai provider definition onto
 * that ring.
 *
 * The behaviour under test is the one the route table promises for every
 * configured route: the ring is the ONE key source, so a key a provider has
 * just spent (401/403/429) walks the ring on the next request — no reload, no
 * bare env var, no second secret in the shell.
 *
 * Covered:
 *   1. `keyRingAuth` resolves the ring's active key on every call.
 *   2. A spent key walks the ring on the NEXT call (the rotation proof).
 *   3. Every key in backoff resolves the transient-exhaustion sentinel, not
 *      undefined — the config-mislabel regression (`Provider is not
 *      configured`) stays fixed for a ring-backed provider.
 *   4. A ring with no keys at all resolves undefined (a genuine config error
 *      stays accurate), and a stored credential is honoured instead — the
 *      `/login` path must survive being re-pointed at a ring.
 *   5. A ring WITH keys outranks a stored credential: the ring owns the key.
 *   6. `withKeyRingAuth` replaces only the api-key auth — id, name, baseUrl,
 *      headers, models and the stream dispatch come through untouched, and the
 *      input definition is not mutated.
 *   7. `withKeyRingAuth` returns null for a definition with no api-key auth to
 *      re-point (OAuth-only), so the caller leaves it alone.
 *   8. The auth display name comes from the definition's own auth, with the
 *      provider name and id as fallbacks — this module invents no name.
 *   9. End to end through the provider object: the wrapped provider's own
 *      `auth.apiKey.resolve` serves key 0, then key 1 once key 0 is exhausted.
 *
 * Harness: the real modules (ring-provider, ring-lifecycle, key-ring, log) are
 * compiled with the package's local tsc (CJS emit) into
 * <repoRoot>/.ring-provider-build and loaded with require — no network, no
 * pi-ai import. HOME is redirected to an isolated temp dir so key-ring
 * persistence never touches the real ~/.pi/agent, and the keyspace is
 * sanitized so ambient keys cannot leak into the rings.
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
// Built at the repo ROOT: packages/providers is "type": "module", which would
// make the emitted .js load as ESM and break CJS "exports".
const buildDir = join(repoRoot, ".ring-provider-build");

const PREFIX = "RING_PROVIDER_TEST_API_KEY";
const KEYS = ["ring-key-0", "ring-key-1", "ring-key-2"];
const EMPTY_PREFIX = "RING_PROVIDER_TEST_EMPTY_KEY";

const scratch = mkdtempSync(join(tmpdir(), "pi-braid-ring-provider-"));
process.env.HOME = scratch;

after(() => {
  rmSync(scratch, { recursive: true, force: true });
  rmSync(buildDir, { recursive: true, force: true });
});

/** Compile the four modules to CJS and load them. */
function loadModules() {
  rmSync(buildDir, { recursive: true, force: true });
  mkdirSync(buildDir, { recursive: true });

  const args = [
    tscBin,
    "--ignoreConfig", // sources passed on CLI; the package tsconfig.json is intentionally bypassed
    join(pkgRoot, "ring-provider.ts"),
    join(pkgRoot, "ring-lifecycle.ts"),
    join(pkgRoot, "key-ring.ts"),
    join(pkgRoot, "log.ts"),
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

  const require = createRequire(import.meta.url);
  return {
    ringProvider: require(join(buildDir, "ring-provider.js")),
    ringLifecycle: require(join(buildDir, "ring-lifecycle.js")),
    keyRing: require(join(buildDir, "key-ring.js")),
  };
}

// Sanitize the keyspace before any ring is created, so ambient keys cannot
// leak in, then plant this suite's own keys.
for (const key of Object.keys(process.env)) {
  if (/^(AGENT_ZERO_API_KEY|RING_PROVIDER_TEST_[A-Z_]+)(_P\d+)?$/.test(key)) {
    delete process.env[key];
  }
}
KEYS.forEach((value, index) => {
  process.env[`${PREFIX}_P${index}`] = value;
});

mkdirSync(join(scratch, ".pi", "agent"), { recursive: true });

const { ringProvider, keyRing, ringLifecycle } = loadModules();
const { keyRingAuth, withKeyRingAuth } = ringProvider;

/** A fresh ring over this suite's keys, with its own state file. */
function makeRing(suffix, prefix = PREFIX) {
  return keyRing.createKeyRing({
    prefix,
    stateFile: `ring-provider-test-${suffix}`,
  });
}

/** A pi-ai-shaped provider definition: identity, auth, models, dispatch. */
function makeDefinition(overrides = {}) {
  const models = [
    { id: "model-a", provider: "route-x", api: "openai-completions" },
    { id: "model-b", provider: "route-x", api: "openai-completions" },
  ];
  return {
    id: "route-x",
    name: "Route X",
    baseUrl: "https://route-x.example/v1",
    headers: { "x-route": "route-x" },
    auth: { apiKey: { name: "Route X API key" } },
    getModels: () => models,
    stream: () => "streamed",
    ...overrides,
  };
}

test("keyRingAuth resolves the ring's active key", async () => {
  const ring = makeRing("active");
  const auth = keyRingAuth("Test API key", ring);
  const first = await auth.resolve({});
  assert.equal(first.auth.apiKey, KEYS[0]);
  assert.equal(first.source, "key-ring");
  // Repeated calls keep serving the same key: resolution is not a rotation.
  const second = await auth.resolve({});
  assert.equal(second.auth.apiKey, KEYS[0]);
});

test("a spent key walks the ring on the next call", async () => {
  const ring = makeRing("walk");
  const auth = keyRingAuth("Test API key", ring);
  assert.equal((await auth.resolve({})).auth.apiKey, KEYS[0]);

  ring.exhaustActiveKey();

  const next = await auth.resolve({});
  assert.equal(
    next.auth.apiKey,
    KEYS[1],
    "the next call must serve the next key",
  );
  assert.notEqual(next.auth.apiKey, KEYS[0]);
});

test("a ring whose keys are all in backoff resolves the transient sentinel", async () => {
  const ring = makeRing("transient");
  const auth = keyRingAuth("Test API key", ring);
  // Serve-then-spend, the production sequence: exhaustActiveKey marks the key
  // getActiveKey() just served, so each key has to be served before it is spent.
  for (let i = 0; i < KEYS.length; i++) {
    assert.equal(ring.getActiveKey(), KEYS[i]);
    ring.exhaustActiveKey();
  }
  assert.equal(ring.isFullyExhausted(), true);

  const resolution = await auth.resolve({});
  assert.ok(
    resolution,
    "a transiently exhausted ring must not resolve undefined",
  );
  assert.equal(
    resolution.auth.apiKey,
    ringLifecycle.TRANSIENT_EXHAUSTION_API_KEY,
  );
  assert.equal(ring.health().total, KEYS.length);
});

test("a ring with no keys resolves undefined, and a stored credential serves instead", async () => {
  const ring = makeRing("empty", EMPTY_PREFIX);
  const auth = keyRingAuth("Test API key", ring);

  assert.equal(await auth.resolve({}), undefined);

  const stored = await auth.resolve({
    credential: { key: "stored-login-key", env: { ROUTE_ACCOUNT: "acct" } },
  });
  assert.equal(stored.auth.apiKey, "stored-login-key");
  assert.equal(stored.source, "stored credential");
  assert.deepEqual(stored.env, { ROUTE_ACCOUNT: "acct" });
});

test("a ring with keys outranks a stored credential", async () => {
  const ring = makeRing("precedence");
  const auth = keyRingAuth("Test API key", ring);
  const resolution = await auth.resolve({
    credential: { key: "stored-login-key" },
  });
  assert.equal(resolution.auth.apiKey, KEYS[0]);
  assert.equal(resolution.source, "key-ring");
});

test("withKeyRingAuth replaces only the api-key auth", () => {
  const ring = makeRing("wrap");
  const definition = makeDefinition();
  const wrapped = withKeyRingAuth(definition, ring);

  assert.ok(wrapped, "a definition with api-key auth must be re-pointable");
  assert.equal(wrapped.id, definition.id);
  assert.equal(wrapped.name, definition.name);
  assert.equal(wrapped.baseUrl, definition.baseUrl);
  assert.equal(wrapped.headers, definition.headers);
  assert.equal(wrapped.getModels, definition.getModels);
  assert.equal(wrapped.stream, definition.stream);
  assert.deepEqual(wrapped.getModels(), definition.getModels());
  assert.equal(wrapped.auth.apiKey.name, "Route X API key");
  assert.notEqual(wrapped.auth.apiKey, definition.auth.apiKey);

  // The definition is not mutated: the caller's object is left as it was.
  assert.equal(definition.auth.apiKey.resolve, undefined);
  assert.equal(wrapped.auth.apiKey.resolve !== undefined, true);
});

test("withKeyRingAuth leaves a definition with no api-key auth alone", () => {
  const ring = makeRing("oauth-only");
  assert.equal(
    withKeyRingAuth(
      makeDefinition({ auth: { oauth: { name: "Route X OAuth" } } }),
      ring,
    ),
    null,
  );
  assert.equal(withKeyRingAuth(makeDefinition({ auth: {} }), ring), null);
  assert.equal(
    withKeyRingAuth(makeDefinition({ auth: undefined }), ring),
    null,
  );
});

test("the auth name comes from the definition, with name and id as fallbacks", () => {
  const ring = makeRing("naming");
  assert.equal(
    withKeyRingAuth(makeDefinition(), ring).auth.apiKey.name,
    "Route X API key",
  );
  assert.equal(
    withKeyRingAuth(makeDefinition({ auth: { apiKey: {} } }), ring).auth.apiKey
      .name,
    "Route X",
  );
  assert.equal(
    withKeyRingAuth(
      makeDefinition({ name: undefined, auth: { apiKey: {} } }),
      ring,
    ).auth.apiKey.name,
    "route-x",
  );
});

test("end to end: the wrapped provider's own resolve walks the ring", async () => {
  const ring = makeRing("e2e");
  const definition = makeDefinition();
  const wrapped = withKeyRingAuth(definition, ring);

  const served = await wrapped.auth.apiKey.resolve({
    ctx: {},
    signal: undefined,
  });
  assert.equal(served.auth.apiKey, KEYS[0]);
  assert.equal(wrapped.auth.apiKey.name, definition.auth.apiKey.name);

  // The provider spent that key: the next request must not be served it again.
  ring.exhaustActiveKey();
  const afterSpend = await wrapped.auth.apiKey.resolve({
    ctx: {},
    signal: undefined,
  });
  assert.equal(afterSpend.auth.apiKey, KEYS[1]);
  // The definition the wrapper replaced is still untouched.
  assert.equal(definition.auth.apiKey.resolve, undefined);
});
