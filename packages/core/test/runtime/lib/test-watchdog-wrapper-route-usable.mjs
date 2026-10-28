/**
 * Test: the watchdog's key-ring wrapper forwards `routeUsable`.
 *
 * The watchdog replaces the process-global key-ring feedback handler for the
 * whole session (session_start .. session_shutdown) to count LLM outcomes.
 * Core's isModelRouteUsable (lib/ai/llm-call.ts) reads `routeUsable` off
 * whatever occupies that slot by structural lookup and fails OPEN when the
 * method is absent, so a wrapper carrying only reportFailure/reportSuccess
 * makes every (provider, model) pair answer "usable" for as long as it holds
 * the slot: tryModelChain issues the auxiliary request to a spent ring instead
 * of skipping the tier.
 *
 * The extension is loaded and driven here through a fake ExtensionAPI + fake
 * ctx (no pi runtime), so the assertions run against the wrapper the real
 * session installs, not a replica of it.
 *
 * Contract pinned:
 *   1. After session_start the slot occupant exposes `routeUsable` and it
 *      answers with the wrapped handler's answer.
 *   2. With the role's ring spent, the chain issues zero requests to the
 *      role's provider (the control below shows the counter sees a contact
 *      when the seam answers usable).
 */
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "..");

// The watchdog reads `broker.watchdog` at import time (config.ts resolves the
// settings path from PI_CODING_AGENT_DIR). Pin a long cadence so the engine's
// real timer cannot fire mid-test; session_shutdown clears it either way.
const configDir = mkdtempSync(join(tmpdir(), "watchdog-wrap-"));
writeFileSync(
  join(configDir, "settings.json"),
  JSON.stringify({ broker: { watchdog: { mode: "on", baseMs: 3_600_000, hotMs: 3_600_000 } } }),
);
process.env.PI_CODING_AGENT_DIR = configDir;

const { tryModelChain } = await import(join(ROOT, "dist", "lib", "ai", "model-resolver.js"));
const { __setCompleteSimpleForTest } = await import(join(ROOT, "dist", "lib", "ai", "llm-call.js"));
const { KEY_RING_FEEDBACK_KEY, setKeyRingFeedbackHandler } = await import(
  join(ROOT, "dist", "lib", "state", "global-state.js")
);
const { formatLogBuffer } = await import(join(ROOT, "dist", "lib", "core", "logger.js"));
const watchdog = (await import(join(ROOT, "dist", "extensions", "self", "watchdog", "index.js")))
  .default;

const ROLE = { id: "role-a", provider: "route-a", api: "anthropic-messages" };
const SESSION = { id: "session-b", provider: "route-b", api: "anthropic-messages" };
const ctx = {
  cwd: ROOT,
  ui: { setStatus() {}, notify() {} },
  modelRegistry: { getApiKeyForProvider: async () => "test-key" },
};

// The published handler mirrors providers/ring-lifecycle.ts
// createKeyRingFeedbackHandler(): two report methods plus the query.
let roleRouteAnswer = true;
const forwardedReports = [];
const providersHandler = {
  reportFailure(modelId, providerId, errText) {
    forwardedReports.push(["failure", modelId, providerId, errText]);
  },
  reportSuccess(modelId, providerId) {
    forwardedReports.push(["success", modelId, providerId]);
  },
  routeUsable: (modelId, providerId) =>
    modelId === ROLE.id && providerId === ROLE.provider ? roleRouteAnswer : true,
};

let requests = [];
__setCompleteSimpleForTest(async (model) => {
  requests.push({ id: model.id, provider: model.provider });
  // What a spent ring does: the request goes out and comes back refused.
  if (model.provider === ROLE.provider) return { errorMessage: "401 invalid api key" };
  return { content: [{ type: "text", text: "session tier answered" }], stopReason: "stop" };
});

async function driveChain() {
  requests = [];
  const result = await tryModelChain(ctx, [() => ROLE, () => SESSION], "sys", "user", {
    maxRetries: 0,
    sdkRetries: 0,
  });
  return { result, requests: [...requests] };
}

const slot = () => globalThis[KEY_RING_FEEDBACK_KEY];

const listeners = new Map();
watchdog({
  on(event, handler) {
    listeners.set(event, handler);
  },
  registerCommand() {},
});

test("control (no wrapper): a usable answer reaches the chain, the role is contacted", async () => {
  setKeyRingFeedbackHandler(providersHandler);
  roleRouteAnswer = true;
  const { result, requests: seen } = await driveChain();
  assert.deepEqual(
    seen,
    [
      { id: ROLE.id, provider: ROLE.provider },
      { id: SESSION.id, provider: SESSION.provider },
    ],
    "the counter must see the role provider's request",
  );
  assert.equal(result.text, "session tier answered");
});

test("session_start installs a wrapper that exposes routeUsable, forwarding the wrapped answer", async () => {
  await listeners.get("session_start")({}, ctx);
  assert.notEqual(
    slot(),
    providersHandler,
    "the watchdog must hold the slot for the rest of the test",
  );
  assert.equal(
    typeof slot().routeUsable,
    "function",
    "core looks up routeUsable structurally; without it the fail-open read answers usable",
  );
  roleRouteAnswer = false;
  assert.equal(slot().routeUsable(ROLE.id, ROLE.provider), false);
  assert.equal(slot().routeUsable(SESSION.id, SESSION.provider), true);
});

test("wrapped: the spent role tier is skipped, zero requests to the role provider", async () => {
  assert.notEqual(slot(), providersHandler, "this assertion is about the wrapper's behaviour");
  roleRouteAnswer = false;
  const { result, requests: seen } = await driveChain();
  assert.deepEqual(
    seen.map((r) => r.provider),
    [SESSION.provider],
    "an unusable tier must not be contacted at all",
  );
  assert.equal(result.text, "session tier answered");
  assert.match(
    formatLogBuffer(),
    /Skipping auxiliary model route-a\/role-a/,
    "the once-per-pair notice the operator reads is written on the skip",
  );
});

test("the wrapper still forwards the two report methods direct extension calls use", async () => {
  // Extension LLM callers reach the same slot for their ring bookkeeping;
  // the wrap must keep those two calls reaching the handler.
  forwardedReports.length = 0;
  slot().reportFailure("probe-model", "probe-provider", "403 quota exceeded");
  slot().reportSuccess("probe-model", "probe-provider");
  assert.deepEqual(forwardedReports, [
    ["failure", "probe-model", "probe-provider", "403 quota exceeded"],
    ["success", "probe-model", "probe-provider"],
  ]);
});

test("session_shutdown restores the handler the session wrapped", async () => {
  await listeners.get("session_shutdown")({}, ctx);
  assert.equal(slot(), providersHandler);
});

after(() => {
  __setCompleteSimpleForTest(null);
  setKeyRingFeedbackHandler(null);
  rmSync(configDir, { recursive: true, force: true });
});
