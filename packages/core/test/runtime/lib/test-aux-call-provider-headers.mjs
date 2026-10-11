/**
 * Test: auxiliary LLM calls reach a provider that requires per-request
 * context.
 *
 * BACKGROUND
 * Braid's auxiliary roles (classifier, critic, heartbeat, memory
 * summarizer, vision) call `callLlm`, which dispatched to pi-ai's compat
 * `completeSimple` directly. That path resolves an api key from the model and
 * nothing else: no registry-resolved headers, no `sessionId`, no config
 * headers declared in `models.json`. A model on a provider that derives
 * routing from the request (opencode-go's `x-opencode-session`, per
 * `PAI/providers/opencode-headers.js`) therefore fails every auxiliary call
 * while session calls to the same model succeed.
 *
 * WHAT THIS FILE PROVES
 * The completion goes through `ctx.modelRegistry`, the same path the session's
 * own requests take, and the session id travels with it. The assertions are
 * behavioural and wire-level: a fake registry proves the dispatch and the
 * session-id plumbing, and a `node:http` server on 127.0.0.1 captures the real
 * request headers a real registry sends.
 *
 * Both halves were RED against the pre-change build (no registry dispatch, no
 * session header on the wire); the RED transcript is in the accompanying
 * report.
 *
 * WHY THE UBIQUITOUS @earendil-works DEPENDENCIES APPEAR HERE
 * The wire cases must run the real registry and a real builtin provider
 * object; a hand-rolled stand-in would prove nothing about the mechanism. The
 * stub server is on 127.0.0.1, the api keys are fakes, and no request leaves
 * the machine.
 */

import { strict as assert } from "node:assert";
import http from "node:http";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const { callLlm } = await import(join(ROOT, "dist", "lib", "ai", "llm-call.js"));
const globalState = await import(join(ROOT, "dist", "lib", "state", "global-state.js"));
// The in-memory log buffer is the only sink that is populated without a bound
// extension context, so it is where the degraded-transport warning is asserted.
const logger = await import(join(ROOT, "dist", "lib", "core", "logger.js"));
const { ModelRuntime, ModelRegistry } = await import("@earendil-works/pi-coding-agent");

// The context slot was generalized by this change; the emergency-named
// accessor is the same slot (pinned by the alias case below) and exists on
// both sides of the change, so the pre-change run of this file reaches the
// behavioural assertions instead of dying on a missing export.
const publishCtx = globalState.setContextEmergencyCtxProvider;
const clearCtx = globalState.resetContextEmergencyCtxProvider;

// Fake credentials. They are only ever sent to 127.0.0.1 (the stub server) or
// to the real gateway in the one case that asserts an auth failure, where the
// key is deliberately absent.
const WIRE_KEY = "aux-registry-wire-test-key";
const SESSION_A = "aux-plumbing-session-1";
const SESSION_B = "aux-wire-session-2";
const SESSION_C = "aux-wire-session-3";

// ── Stub HTTP server ─────────────────────────────────────────────────────────

/** Minimal OpenAI-completions SSE stream: one text delta and a stop chunk. */
function startStubServer() {
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, headers: { ...req.headers } });
    res.writeHead(200, { "content-type": "text/event-stream" });
    const chunk = (delta, finish) =>
      `data: ${JSON.stringify({
        id: "stub",
        object: "chat.completion.chunk",
        created: 0,
        model: "stub",
        choices: [{ index: 0, delta, finish_reason: finish }],
      })}\n\n`;
    res.write(chunk({ role: "assistant", content: "stub-ok" }, null));
    res.write(chunk({}, "stop"));
    res.write("data: [DONE]\n\n");
    res.end();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        requests,
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        port: server.address().port,
        close: () => server.close(),
      });
    });
  });
}

// ── Registry fixtures ────────────────────────────────────────────────────────

const tmp = mkdtempSync(path.join(os.tmpdir(), "aux-registry-test-"));

/** Isolated runtime: no user models.json, no stored credentials. */
async function makeRuntime(modelsJson) {
  let modelsPath = null;
  if (modelsJson) {
    modelsPath = path.join(tmp, `models-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(modelsPath, JSON.stringify(modelsJson));
  }
  return ModelRuntime.create({
    modelsPath,
    authPath: path.join(tmp, "auth.json"),
    refreshOnCreate: false,
  });
}

const runtime = await makeRuntime(null);
const registry = new ModelRegistry(runtime);

// A builtin model on the one provider that translates a request-level session
// id into a header. Picked from the catalog rather than hardcoded: model ids
// move with the catalog.
const builtinModel = registry
  .getAll()
  .find((m) => m.provider === "opencode-go" && m.api === "openai-completions");
assert.ok(builtinModel, "the installed catalog must contain an opencode-go completions model");

/** A model whose baseUrl points at the stub server. */
const wireModel = (server) => ({ ...builtinModel, baseUrl: server.baseUrl });

async function withCtx(ctx, fn) {
  publishCtx(() => ctx);
  try {
    return await fn();
  } finally {
    clearCtx();
  }
}

/** call options every case shares: no retries, no SDK retries, short timeout. */
const CALL = { maxRetries: 0, sdkRetries: 0, timeoutMs: 10_000 };

// ── Test runner ──────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

console.log("=== auxiliary calls via the model registry ===\n");
console.log(` (builtin model under test: ${builtinModel.provider}/${builtinModel.id})\n`);

// ── The published context slot ────────────────────────────────────────────────

await test("context slot: the general accessor and the emergency alias are one slot", () => {
  assert.equal(
    typeof globalState.setExtensionCtxProvider,
    "function",
    "global-state must export setExtensionCtxProvider (lib/ai reads the session ctx through it)",
  );
  const sentinel = () => ({ marker: "slot-identity" });
  globalState.setExtensionCtxProvider(sentinel);
  try {
    assert.equal(
      globalState.getContextEmergencyCtxProvider(),
      sentinel,
      "the emergency-named reader must see a provider published under the general name",
    );
    const other = () => ({ marker: "alias-write" });
    globalState.setContextEmergencyCtxProvider(other);
    assert.equal(
      globalState.getExtensionCtxProvider(),
      other,
      "the general reader must see a provider published under the emergency name",
    );
  } finally {
    clearCtx();
  }
});

// ── 1. Dispatch + session id (fake registry) ─────────────────────────────────

/** A registry stand-in that records the call it receives. */
function recordingRegistry() {
  const calls = [];
  return {
    calls,
    streamSimple(model, context, options) {
      calls.push({ model, context, options });
      return {
        result: async () => ({
          role: "assistant",
          content: [{ type: "text", text: "registry-plumbing-ok" }],
          api: builtinModel.api,
          provider: builtinModel.provider,
          model: builtinModel.id,
          usage: { input: 1, output: 1, totalTokens: 2 },
          stopReason: "stop",
          timestamp: Date.now(),
        }),
      };
    },
  };
}

await test("callLlm: dispatches through ctx.modelRegistry and passes the session id", async () => {
  const fake = recordingRegistry();
  const result = await withCtx(
    { modelRegistry: fake, sessionManager: { getSessionId: () => SESSION_A } },
    () => callLlm(builtinModel, WIRE_KEY, "sys", "user", CALL),
  );
  assert.equal(fake.calls.length, 1, "callLlm must dispatch exactly once through the registry");
  assert.equal(
    result.text,
    "registry-plumbing-ok",
    `the registry's completion must be returned to the caller, got ${JSON.stringify(result)}`,
  );
  const { options, model, context } = fake.calls[0];
  assert.equal(options.sessionId, SESSION_A, "the registry call must carry the session's id");
  assert.ok(
    typeof options.sessionId === "string" && options.sessionId.length > 0,
    "the session id must be non-empty",
  );
  assert.equal(model.id, builtinModel.id, "the registry must receive the caller's model");
  assert.ok(context?.messages?.length > 0, "the registry must receive the built transcript");
});

await test("callLlm: a distinct session produces a distinct id (not a constant)", async () => {
  const fake = recordingRegistry();
  const seen = [];
  for (const id of [SESSION_A, SESSION_B, SESSION_C]) {
    await withCtx({ modelRegistry: fake, sessionManager: { getSessionId: () => id } }, () =>
      callLlm(builtinModel, WIRE_KEY, "sys", "user", CALL),
    );
    seen.push(fake.calls.at(-1).options.sessionId);
  }
  assert.deepEqual(seen, [SESSION_A, SESSION_B, SESSION_C], "each call must carry its session id");
});

await test("callLlm: an unreadable session id degrades to absent, never to a sentinel", async () => {
  const fake = recordingRegistry();
  const cases = [
    { name: "no session manager", ctx: { modelRegistry: fake } },
    { name: "no getSessionId", ctx: { modelRegistry: fake, sessionManager: {} } },
    {
      name: "getSessionId throws",
      ctx: {
        modelRegistry: fake,
        sessionManager: {
          getSessionId: () => {
            throw new Error("session not started");
          },
        },
      },
    },
    {
      name: "empty id",
      ctx: { modelRegistry: fake, sessionManager: { getSessionId: () => "" } },
    },
  ];
  for (const c of cases) {
    const result = await withCtx(c.ctx, () => callLlm(builtinModel, WIRE_KEY, "sys", "user", CALL));
    assert.equal(
      result.text,
      "registry-plumbing-ok",
      `${c.name}: the call must still succeed, got ${JSON.stringify(result)}`,
    );
    assert.equal(
      fake.calls.at(-1).options.sessionId,
      undefined,
      `${c.name}: sessionId must be omitted rather than fabricated`,
    );
  }
});

await test("fallback: with no context published the call completes on the compat transport, and says so once", async () => {
  // The registry is the primary path; this case pins the degraded path that
  // keeps auxiliary calls working when nothing published the session context.
  // The publisher is the enforcement extension's session-start handler, and
  // enforcement is disableable, so the publisher can legitimately never run.
  const server = await startStubServer();
  const warnings = () =>
    logger.getLogBuffer().filter((e) => e.level === "warn" && e.source === "llm-call");
  globalState.resetAuxDegradedTransportWarning?.();
  logger.clearLogBuffer();
  try {
    const first = await callLlm(wireModel(server), WIRE_KEY, "sys", "user", CALL);
    assert.ok(
      !("error" in first),
      `the degraded call must still complete, got ${JSON.stringify(first)}`,
    );
    assert.equal(first.text, "stub-ok", "the compat transport's text must reach the caller");
    assert.equal(server.requests.length, 1, "the compat transport must have sent the request");
    const headers = server.requests[0].headers;
    assert.equal(
      headers["x-opencode-session"],
      undefined,
      `the degraded transport must not carry a session header it cannot resolve: ${JSON.stringify(headers)}`,
    );
    assert.equal(
      warnings().length,
      1,
      `expected exactly one degraded-transport warning; buffer:\n${logger.formatLogBuffer()}`,
    );
    assert.match(
      warnings()[0].message,
      /no session context published/i,
      "the warning must name the missing publisher",
    );

    // Second call in the same process: same degraded transport, no second warning.
    const second = await callLlm(wireModel(server), WIRE_KEY, "sys", "user", CALL);
    assert.ok(
      !("error" in second),
      `the second degraded call must also complete, got ${JSON.stringify(second)}`,
    );
    assert.equal(server.requests.length, 2, "the second call must have sent the request too");
    assert.equal(warnings().length, 1, "the warning must be emitted once per process, not per call");
  } finally {
    server.close();
    globalState.resetAuxDegradedTransportWarning?.();
  }
});

// ── 2. Wire: the session header ──────────────────────────────────────────────

await test("wire: the aux request carries x-opencode-session from the session id", async () => {
  const server = await startStubServer();
  try {
    const result = await withCtx(
      { modelRegistry: registry, sessionManager: { getSessionId: () => SESSION_B } },
      () => callLlm(wireModel(server), WIRE_KEY, "sys", "user", CALL),
    );
    assert.ok(!("error" in result), `the stubbed call must succeed, got ${JSON.stringify(result)}`);
    assert.equal(result.text, "stub-ok", "the stub's text must reach the caller");
    assert.ok(server.requests.length >= 1, "the stub server must have received the request");
    assert.equal(
      server.requests[0].headers["x-opencode-session"],
      SESSION_B,
      `captured headers: ${JSON.stringify(server.requests[0].headers)}`,
    );
  } finally {
    server.close();
  }
});

// ── 3. Wire: a models.json-declared header ──────────────────────────────────

await test("wire: a models.json-declared header reaches the aux request", async () => {
  const server = await startStubServer();
  const configured = await makeRuntime({
    providers: {
      "opencode-go": {
        modelOverrides: { [builtinModel.id]: { headers: { "x-braid-test-configured": "yes" } } },
      },
    },
  });
  const configuredRegistry = new ModelRegistry(configured);
  const model = { ...configuredRegistry.find("opencode-go", builtinModel.id), baseUrl: server.baseUrl };
  try {
    const result = await withCtx(
      { modelRegistry: configuredRegistry, sessionManager: { getSessionId: () => SESSION_C } },
      () => callLlm(model, WIRE_KEY, "sys", "user", CALL),
    );
    assert.ok(!("error" in result), `the stubbed call must succeed, got ${JSON.stringify(result)}`);
    const headers = server.requests[0]?.headers ?? {};
    assert.equal(headers["x-braid-test-configured"], "yes", `captured headers: ${JSON.stringify(headers)}`);
    assert.equal(
      headers["x-opencode-session"],
      SESSION_C,
      "the configured header must not displace the session header",
    );
  } finally {
    server.close();
  }
});

// ── 4. Behaviour delta: unconfigured provider auth ──────────────────────────

await test("delta: unconfigured provider auth surfaces as an error result, not a throw", async () => {
  const previousKey = process.env.OPENCODE_API_KEY;
  delete process.env.OPENCODE_API_KEY;
  const unattached = await makeRuntime(null);
  const unattachedRegistry = new ModelRegistry(unattached);
  const calls = [];
  const spy = {
    streamSimple(model, context, options) {
      calls.push({ model, context, options });
      return unattachedRegistry.streamSimple(model, context, options);
    },
  };
  try {
    // Port 9 is the discard port: the call must never get that far.
    const model = { ...builtinModel, baseUrl: "http://127.0.0.1:9" };
    const result = await withCtx({ modelRegistry: spy }, () =>
      // Two retries allowed on purpose: an auth failure must not be classified
      // as transient and burned through the ladder.
      callLlm(model, undefined, "sys", "user", { ...CALL, maxRetries: 2 }),
    );
    assert.ok("error" in result, `expected { error }, got ${JSON.stringify(result)}`);
    assert.match(result.error, /not configured/i, `error text: ${result.error}`);
    assert.equal(calls.length, 1, "an auth failure must not be retried");
  } finally {
    if (previousKey === undefined) delete process.env.OPENCODE_API_KEY;
    else process.env.OPENCODE_API_KEY = previousKey;
  }
});

// ── 5. Behaviour delta: baseUrl ownership ───────────────────────────────────

await test("delta: resolved auth owns baseUrl only when it declares one", async () => {
  const primary = await startStubServer();
  const override = await startStubServer();
  let declaredBaseUrl;
  const provider = {
    id: "braid-test-native",
    name: "Braid test native provider",
    auth: {
      apiKey: {
        name: "Probe key",
        // Braid's ring resolver returns { auth: { apiKey }, source } and no
        // baseUrl (packages/providers/index.ts keyRingAuth ->
        // resolveKeyRingAuth); the declared form exists to pin the branch.
        resolve: async () => ({
          auth: { apiKey: WIRE_KEY, ...(declaredBaseUrl ? { baseUrl: declaredBaseUrl } : {}) },
          source: "probe",
        }),
      },
    },
    getModels: () => [
      { ...builtinModel, id: "native-model", provider: "braid-test-native", baseUrl: primary.baseUrl },
    ],
    stream: (m, c, o) => runtime.getProvider("opencode-go").stream(m, c, o),
    streamSimple: (m, c, o) => runtime.getProvider("opencode-go").streamSimple(m, c, o),
  };
  runtime.registerNativeProvider(provider);
  await runtime.refresh({ allowNetwork: false });
  const model = registry.find("braid-test-native", "native-model");
  assert.ok(model, "the native provider's model must be registered");
  try {
    const before = { p: primary.requests.length, o: override.requests.length };
    const first = await withCtx({ modelRegistry: registry }, () =>
      callLlm(model, undefined, "sys", "user", CALL),
    );
    assert.ok(!("error" in first), `registered-baseUrl call must succeed, got ${JSON.stringify(first)}`);
    assert.equal(
      primary.requests.length - before.p,
      1,
      "with no baseUrl in the auth resolution the model's registered baseUrl must win",
    );
    assert.equal(override.requests.length - before.o, 0, "the override server must not be touched");

    declaredBaseUrl = override.baseUrl;
    const second = await withCtx({ modelRegistry: registry }, () =>
      callLlm(model, undefined, "sys", "user", CALL),
    );
    assert.ok(!("error" in second), `declared-baseUrl call must succeed, got ${JSON.stringify(second)}`);
    assert.equal(
      override.requests.length - before.o,
      1,
      "when the auth resolution declares a baseUrl it must win over the model's",
    );
  } finally {
    primary.close();
    override.close();
  }
});

// ── 6. Layering guard ───────────────────────────────────────────────────────

await test("layering: no provider-specific header literal under lib/ai/", () => {
  const dir = join(ROOT, "src", "lib", "ai");
  const files = readdirSync(dir, { recursive: true })
    .filter((f) => String(f).endsWith(".ts"))
    .map((f) => join(dir, String(f)));
  assert.ok(files.length > 0, "the guard must scan at least one file");
  const offenders = files.filter((f) => /x-opencode-/i.test(readFileSync(f, "utf-8")));
  assert.deepEqual(
    offenders,
    [],
    "a provider-specific header name must not enter the generic LLM layer (which header a session id becomes is the provider's business)",
  );
});

// ── Summary ─────────────────────────────────────────────────────────────────

console.log(`\n\uD83D\uDCCA ${passed} passed, ${failed} failed`);
if (failed > 0) process.exitCode = 1;