/**
 * The configured window reaches the model pi-core's routed threshold reads.
 *
 * braid.context.contextLimitTokens must reach pi-core's OWN routing decision
 * point, not only the session model. On a virtual selection (`braid/auto`)
 * `agent.state.model` is the virtual model: `_compactBeforeNextAssistantResponse`
 * returns early for it and the real check runs against `route.model`, the
 * physical model the router picked. pi-core resolves that model through
 * `getPhysicalModel(provider, id)` -> `models.getModel(provider, id)`. The
 * registry facade an extension receives (`ctx.modelRegistry.find`) calls the
 * identical function, so the object is reachable and writable from a hook:
 * this fixture proves that identity and that the plumb's write is what
 * `route.model.contextWindow` and the footer's denominator then read.
 *
 * The fixture drives the REAL code on every side:
 * - route resolution: pi-core's ModelRuntime.resolveModel with a registered
 *   virtual model whose route returns a builtin catalog model;
 * - threshold decision: pi-core's AgentSession._exceedsCompactionThreshold
 *   (shouldCompact on the routed model's window);
 * - denominator: pi-core's AgentSession._limitsModel + getContextUsage, and
 *   the real FooterComponent rendered from that usage;
 * - the plumb: the repo dist's braid-settings + the polyfill handlers.
 *
 * The catalog provider is registered with an api key so no network and no
 * user config is read (modelsPath: null); the model objects are pi-ai's
 * builtin ones, whose identity is stable across reads. Catalog windows are
 * restored after every scenario because those objects are process-wide.
 *
 * Run: node --test packages/core/test/runtime/core/test-configured-window-routed.mjs
 */

import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIST = join(HERE, "..", "..", "..", "dist");
const PICORE_DIST = join(
  HERE,
  "..",
  "..",
  "..",
  "..",
  "..",
  "node_modules",
  "@earendil-works",
  "pi-coding-agent",
  "dist",
);
const DIST_ROOT = process.env.DIST ?? REPO_DIST;
void homedir;

const CAP = 384_000;
// The coherent reserve for CAP: pi-core's trigger lands at 75% of the window.
const RESERVE = 96_000;
const PROVIDER = "opencode-go";
const MAIN_MODEL = "deepseek-v4.1-flash"; // catalog 1_000_000
const OTHER_MODEL = "gemini-4-argon"; // catalog 1_048_576
const SMALL_MODEL = "hy3"; // catalog 256_000, below CAP

// HOME must point at the fixture's temp home before the dist modules evaluate
// SETTINGS_PATH; braid's readSettings re-reads the file per call.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "routed-window-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
process.on("exit", () => rmSync(FAKE_HOME, { recursive: true, force: true }));

function writeSettings(contextLimitTokens) {
  writeFileSync(
    join(FAKE_HOME, ".pi", "agent", "settings.json"),
    JSON.stringify({
      braid: contextLimitTokens === undefined ? {} : { context: { contextLimitTokens } },
      compaction: { reserveTokens: RESERVE },
    }),
  );
}

const { ModelRuntime } = await import(`file://${join(PICORE_DIST, "core/model-runtime.js")}`);
const { ModelRegistry } = await import(`file://${join(PICORE_DIST, "core/model-registry.js")}`);
const { AgentSession } = await import(`file://${join(PICORE_DIST, "core/agent-session.js")}`);
const { SettingsManager } = await import(`file://${join(PICORE_DIST, "core/settings-manager.js")}`);
const footerMod = await import(`file://${join(PICORE_DIST, "modes/interactive/components/footer.js")}`);
const themeMod = await import(`file://${join(PICORE_DIST, "modes/interactive/theme/theme.js")}`);
themeMod.initTheme();

const settings = await import(`file://${join(DIST_ROOT, "lib/config/braid-settings.js")}`);
const contextUsage = await import(`file://${join(DIST_ROOT, "lib/detection/context-usage.js")}`);
const polyfill = await import(`file://${join(DIST_ROOT, "extensions/core/polyfill/index.js")}`);

console.log("=== the configured window reaches the routed physical model ===\n");

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

/** Fake ExtensionAPI: capture handlers the way pi-core's runner stores them. */
function makePiHarness() {
  const handlers = new Map();
  return {
    pi: {
      on(name, handler) {
        if (!handlers.has(name)) handlers.set(name, []);
        handlers.get(name).push(handler);
      },
      registerCommand() {},
    },
    emit(name, event, ctx) {
      return Promise.all((handlers.get(name) ?? []).map((h) => h(event, ctx)));
    },
  };
}

/** The route the registered virtual model returns for the next request. */
let nextRoute = { provider: PROVIDER, id: MAIN_MODEL };

/**
 * A real ModelRuntime over pi's builtin catalog only (no models.json, no
 * network, no in-memory store), with the physical provider marked configured
 * and a virtual selection that routes to `nextRoute`.
 */
async function makeRuntime() {
  const runtime = await ModelRuntime.create({
    refreshOnCreate: false,
    allowModelNetwork: false,
    modelsPath: null,
  });
  // An api key marks the provider configured without a network check and
  // without replacing its catalog models (no models/baseUrl override).
  runtime.registerProvider(PROVIDER, { apiKey: "fixture-key" });
  nextRoute = { provider: PROVIDER, id: MAIN_MODEL };
  runtime.registerVirtualModel({
    provider: "fixture-braid",
    id: "auto",
    name: "Auto (fixture)",
    thinkingLevels: ["off", "low", "medium", "high", "max"],
    route: () => ({ model: nextRoute, thinkingLevel: "high" }),
  });
  // Settle the registration-triggered refreshes before any object is compared.
  await runtime.refresh({ allowNetwork: false });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return runtime;
}

/** The catalog window of every model this fixture writes to. */
const catalogWindows = new Map();
function rememberCatalogWindow(runtime, modelId) {
  const window = runtime.getPhysicalModel(PROVIDER, modelId)?.contextWindow;
  if (typeof window === "number") catalogWindows.set(modelId, window);
}
function restoreCatalogWindows(runtime) {
  for (const [modelId, window] of catalogWindows) {
    const model = runtime.getPhysicalModel(PROVIDER, modelId);
    if (model) model.contextWindow = window;
  }
}

/** An assistant entry naming the model that answered, as pi-core persists it. */
function assistantEntry(provider, model, stopReason = "stop") {
  return {
    type: "message",
    id: `entry-${provider}-${model}-${stopReason}`,
    timestamp: Date.now(),
    message: {
      role: "assistant",
      provider,
      model,
      stopReason,
      content: [{ type: "text", text: "ok" }],
      usage: {
        input: 1_000,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 1_010,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    },
  };
}

/** A user message of `tokens` estimated tokens (pi's estimateTokens: chars/4). */
function userMessage(tokens) {
  return { role: "user", content: [{ type: "text", text: "x".repeat(tokens * 4) }] };
}

/**
 * The session surface pi-core's own methods read. `_limitsModel`,
 * `getContextUsage` and `_exceedsCompactionThreshold` are the real
 * AgentSession prototype methods; only the plumbing around them is local.
 * `routedModel` mirrors agent-session.js:1119-1125 (latest successful
 * response -> getPhysicalModel), which is what _limitsModel() prefers.
 */
function makeSession({ runtime, branch, projection }) {
  const virtual = runtime.getModel("fixture-braid", "auto");
  const session = {
    state: { model: virtual, thinkingLevel: "high" },
    autoCompactionEnabled: false,
    settingsManager: SettingsManager.inMemory({ compaction: { reserveTokens: RESERVE } }),
    sessionManager: {
      getEntries: () => branch,
      getEntryCount: () => branch.length,
      getSessionId: () => "fixture-routed",
      getLeafId: () => branch.at(-1)?.id ?? null,
      getCwd: () => "/tmp/routed-fixture",
      getSessionName: () => null,
      buildSessionProjection: () => projection,
      getBranch: () => branch,
    },
    modelRuntime: { isUsingSubscription: () => false },
    get model() {
      return session.state.model;
    },
    get routedModel() {
      const latest = [...branch]
        .reverse()
        .find(
          (entry) =>
            entry.type === "message" &&
            entry.message?.role === "assistant" &&
            entry.message.stopReason !== "error" &&
            entry.message.stopReason !== "aborted",
        );
      const model = latest && runtime.getPhysicalModel(latest.message.provider, latest.message.model);
      return model && { model, thinkingLevel: "high" };
    },
    _limitsModel: AgentSession.prototype._limitsModel,
    getContextUsage: AgentSession.prototype.getContextUsage,
  };
  return session;
}

/** The ctx surface the polyfill's plumb reads (model, branch, registry). */
function makeCtx({ runtime, branch, model }) {
  return {
    model: model ?? runtime.getModel("fixture-braid", "auto"),
    sessionManager: { getBranch: () => branch },
    modelRegistry: new ModelRegistry(runtime),
  };
}

function routeRequest(runtime) {
  return runtime.resolveModel(runtime.getModel("fixture-braid", "auto"), [], {
    reason: "user",
    thinkingLevel: "high",
  });
}

/** pi-core's own threshold decision for one routed model and projection. */
function exceedsThreshold(session, model, projection) {
  return AgentSession.prototype._exceedsCompactionThreshold.call(session, model, projection);
}

function makeFooterData() {
  return {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map(),
  };
}

const { formatTokens } = footerMod;

// ── measurement: the routed object is the object the registry hands out ──

await test("measurement: route.model IS ctx.modelRegistry.find(provider, id)", async () => {
  const runtime = await makeRuntime();
  try {
    rememberCatalogWindow(runtime, MAIN_MODEL);
    const ctx = makeCtx({ runtime, branch: [assistantEntry(PROVIDER, MAIN_MODEL)] });
    const route = await routeRequest(runtime);
    assert.equal(
      route.model,
      ctx.modelRegistry.find(PROVIDER, MAIN_MODEL),
      "the routed model and the registry handle are one object",
    );
    assert.equal(
      route.model,
      runtime.getPhysicalModel(PROVIDER, MAIN_MODEL),
      "the routed model is the object getPhysicalModel returns (model-runtime.js:769-772)",
    );
  } finally {
    restoreCatalogWindows(runtime);
  }
});

// ── the threshold the routed request is checked against ──

await test("the hook writes the window onto route.model and pi-core's threshold fires", async () => {
  writeSettings(CAP);
  const runtime = await makeRuntime();
  try {
    rememberCatalogWindow(runtime, MAIN_MODEL);
    const branch = [assistantEntry(PROVIDER, MAIN_MODEL)];
    // 300k tokens: above 384k - 96k = 288k (fires), below 1M - 96k = 904k.
    const projection = { messages: [userMessage(300_000)], entries: [] };
    const session = makeSession({ runtime, branch, projection });

    const before = await routeRequest(runtime);
    assert.equal(before.model.contextWindow, 1_000_000, "catalog window before the plumb");
    assert.equal(
      exceedsThreshold(session, before.model, projection),
      false,
      "at the catalog window 300k tokens do not reach the threshold",
    );

    const harness = makePiHarness();
    polyfill.default(harness.pi);
    const ctx = makeCtx({ runtime, branch });
    await harness.emit(
      "session_start",
      { type: "session_start", reason: "startup" },
      ctx,
    );

    const after = await routeRequest(runtime);
    assert.equal(
      after.model.contextWindow,
      CAP,
      "the routed physical model now reports the configured window",
    );
    assert.equal(after.model, before.model, "the same catalog object was written in place");
    assert.equal(
      exceedsThreshold(session, after.model, projection),
      true,
      "pi-core's threshold now fires for the routed request",
    );
  } finally {
    restoreCatalogWindows(runtime);
  }
});

await test("the plumb reports the routed write and writes the same target", async () => {
  writeSettings(CAP);
  const runtime = await makeRuntime();
  try {
    rememberCatalogWindow(runtime, MAIN_MODEL);
    const branch = [assistantEntry(PROVIDER, MAIN_MODEL)];
    const ctx = makeCtx({ runtime, branch });
    const result = settings.applyConfiguredContextWindow(ctx);
    assert.equal(result.applied, true, "the virtual session model was written");
    assert.equal(result.contextWindow, CAP);
    assert.equal(result.routed?.provider, PROVIDER);
    assert.equal(result.routed?.modelId, MAIN_MODEL);
    assert.equal(result.routed?.applied, true, "the routed physical model was written");
    assert.equal(result.routed?.contextWindow, CAP);
    assert.equal(
      ctx.modelRegistry.find(PROVIDER, MAIN_MODEL)?.contextWindow,
      CAP,
      "the registry reports the written window",
    );
  } finally {
    restoreCatalogWindows(runtime);
  }
});

// ── the number the footer prints ──

await test("the session's own getContextUsage() divides by the configured window", async () => {
  writeSettings(CAP);
  const runtime = await makeRuntime();
  try {
    rememberCatalogWindow(runtime, MAIN_MODEL);
    const branch = [assistantEntry(PROVIDER, MAIN_MODEL)];
    const projection = { messages: [userMessage(300_000)], entries: [] };
    const session = makeSession({ runtime, branch, projection });

    const pre = session.getContextUsage();
    assert.equal(pre.contextWindow, 1_000_000, "before the plumb: _limitsModel() is the catalog object");

    const harness = makePiHarness();
    polyfill.default(harness.pi);
    await harness.emit("session_start", { type: "session_start", reason: "startup" }, makeCtx({ runtime, branch }));

    const usage = session.getContextUsage();
    assert.equal(
      usage.contextWindow,
      CAP,
      "getContextUsage().contextWindow is the footer's denominator (agent-session.js:3608)",
    );
    assert.ok(
      Math.abs(usage.percent - (300_000 / CAP) * 100) < 1e-9,
      `percent is recomputed against the configured window, got ${usage.percent}`,
    );

    const footer = new footerMod.FooterComponent(session, makeFooterData());
    footer.autoCompactEnabled = false;
    const rendered = footer.render(100).join("\n");
    assert.ok(
      rendered.includes(`/${formatTokens(CAP)}`),
      `the footer prints the configured window, got: ${rendered}`,
    );
    assert.ok(
      !rendered.includes(`/${formatTokens(1_000_000)}`),
      "the footer no longer prints the catalog window",
    );
  } finally {
    restoreCatalogWindows(runtime);
  }
});

// ── a route taken inside a run ──

await test("turn_end: a model routed mid-run is plumbed before the next request", async () => {
  writeSettings(CAP);
  const runtime = await makeRuntime();
  try {
    rememberCatalogWindow(runtime, OTHER_MODEL);
    const branch = [assistantEntry(PROVIDER, MAIN_MODEL)];
    const harness = makePiHarness();
    polyfill.default(harness.pi);
    const ctx = makeCtx({ runtime, branch });

    nextRoute = { provider: PROVIDER, id: OTHER_MODEL };
    const switched = await routeRequest(runtime);
    assert.equal(
      switched.model.contextWindow,
      1_048_576,
      "a route taken for the first time still carries its catalog window",
    );

    // The turn ends: pi-core persists the response naming the new model first.
    branch.push(assistantEntry(PROVIDER, OTHER_MODEL));
    await harness.emit("turn_end", { type: "turn_end", turnIndex: 1, message: {}, toolResults: [] }, ctx);

    const after = await routeRequest(runtime);
    assert.equal(after.model.contextWindow, CAP, "the next request is checked against the configured window");
    assert.equal(switched.model, after.model, "the same catalog object was written in place");
  } finally {
    restoreCatalogWindows(runtime);
  }
});

await test("the routed model is the latest SUCCESSFUL response, not an error after it", async () => {
  writeSettings(CAP);
  const runtime = await makeRuntime();
  try {
    rememberCatalogWindow(runtime, MAIN_MODEL);
    rememberCatalogWindow(runtime, OTHER_MODEL);
    const branch = [assistantEntry(PROVIDER, MAIN_MODEL), assistantEntry(PROVIDER, OTHER_MODEL, "error")];
    nextRoute = { provider: PROVIDER, id: OTHER_MODEL };
    const ctx = makeCtx({ runtime, branch });
    settings.applyConfiguredContextWindow(ctx);
    assert.equal(
      ctx.modelRegistry.find(PROVIDER, MAIN_MODEL)?.contextWindow,
      CAP,
      "the model of the last successful response is written",
    );
    assert.equal(
      ctx.modelRegistry.find(PROVIDER, OTHER_MODEL)?.contextWindow,
      1_048_576,
      "an error response names no routed model; it is not the one _limitsModel() returns",
    );
  } finally {
    restoreCatalogWindows(runtime);
  }
});

// ── a pinned selection (ctx.model IS the catalog object) ──

await test("a pinned model below the cap keeps its own window; above the cap it is clamped", async () => {
  const runtime = await makeRuntime();
  try {
    rememberCatalogWindow(runtime, SMALL_MODEL);
    const pinned = runtime.getPhysicalModel(PROVIDER, SMALL_MODEL);
    assert.equal(pinned.contextWindow, 256_000, "the pinned catalog window");

    writeSettings(1_500_000);
    const above = settings.applyConfiguredContextWindow({ model: pinned, modelRegistry: new ModelRegistry(runtime), sessionManager: { getBranch: () => [] } });
    assert.equal(above.applied, false, "a cap above the true window widens nothing");
    assert.equal(pinned.contextWindow, 256_000, "the pinned model keeps its own window");
    assert.equal(above.routed, undefined, "a pinned selection has no separate routed object");

    writeSettings(100_000);
    const below = settings.applyConfiguredContextWindow({ model: pinned, modelRegistry: new ModelRegistry(runtime), sessionManager: { getBranch: () => [] } });
    assert.equal(below.applied, true);
    assert.equal(pinned.contextWindow, 100_000, "a cap below the true window binds");

    writeSettings(500_000);
    settings.applyConfiguredContextWindow({ model: pinned, modelRegistry: new ModelRegistry(runtime), sessionManager: { getBranch: () => [] } });
    assert.equal(
      pinned.contextWindow,
      256_000,
      "raising the cap past the catalog window restores the true ceiling, not the previous cap",
    );
  } finally {
    restoreCatalogWindows(runtime);
  }
});

// ── no cap, nothing written ──

await test("unset cap: provider window used, nothing written on either object", async () => {
  writeSettings(undefined);
  const runtime = await makeRuntime();
  try {
    rememberCatalogWindow(runtime, MAIN_MODEL);
    const branch = [assistantEntry(PROVIDER, MAIN_MODEL)];
    const ctx = makeCtx({ runtime, branch });
    const result = settings.applyConfiguredContextWindow(ctx);
    assert.equal(result.applied, false);
    assert.equal(result.reason, "unset");
    assert.equal(result.routed, undefined, "no routed lookup happens when the cap is unset");
    assert.equal(ctx.model.contextWindow, 0, "the virtual model keeps its deliberately unset window");
    assert.equal(
      ctx.modelRegistry.find(PROVIDER, MAIN_MODEL)?.contextWindow,
      1_000_000,
      "the routed model keeps its catalog window",
    );
    const route = await routeRequest(runtime);
    assert.equal(route.model.contextWindow, 1_000_000, "provider-window semantics hold");
  } finally {
    restoreCatalogWindows(runtime);
  }
});

// ── the label names the binding bound ──

await test("windowSource is configured only when the cap binds", async () => {
  const runtime = await makeRuntime();
  try {
    rememberCatalogWindow(runtime, MAIN_MODEL);
    rememberCatalogWindow(runtime, SMALL_MODEL);
    const bigWindow = runtime.getPhysicalModel(PROVIDER, MAIN_MODEL).contextWindow;
    const smallWindow = runtime.getPhysicalModel(PROVIDER, SMALL_MODEL).contextWindow;

    writeSettings(CAP);
    const bound = contextUsage.resolveWindow(bigWindow);
    assert.equal(bound.contextWindow, CAP);
    assert.equal(bound.windowSource, "configured", "the cap lowers the window: it binds");

    writeSettings(1_500_000);
    const ceiling = contextUsage.resolveWindow(smallWindow);
    assert.equal(ceiling.contextWindow, 256_000);
    assert.equal(ceiling.windowSource, "provider", "the ceiling clamped the cap: the provider binds");

    // After the plumb writes the cap, the object reports it; the label stays honest.
    writeSettings(CAP);
    settings.applyConfiguredContextWindow({
      model: runtime.getModel("fixture-braid", "auto"),
      sessionManager: { getBranch: () => [assistantEntry(PROVIDER, MAIN_MODEL)] },
      modelRegistry: new ModelRegistry(runtime),
    });
    const plumbed = contextUsage.resolveWindow(runtime.getPhysicalModel(PROVIDER, MAIN_MODEL).contextWindow);
    assert.equal(plumbed.contextWindow, CAP);
    assert.equal(plumbed.windowSource, "configured");
  } finally {
    restoreCatalogWindows(runtime);
  }
});

// ── idempotence and re-application ──

await test("re-applying with a raised cap widens the same object back (the true window is remembered)", async () => {
  writeSettings(CAP);
  const runtime = await makeRuntime();
  try {
    rememberCatalogWindow(runtime, MAIN_MODEL);
    const branch = [assistantEntry(PROVIDER, MAIN_MODEL)];
    const ctx = makeCtx({ runtime, branch });
    settings.applyConfiguredContextWindow(ctx);
    assert.equal(ctx.modelRegistry.find(PROVIDER, MAIN_MODEL).contextWindow, CAP);

    writeSettings(500_000);
    settings.applyConfiguredContextWindow(ctx);
    assert.equal(
      ctx.modelRegistry.find(PROVIDER, MAIN_MODEL).contextWindow,
      500_000,
      "the raised cap widens the object: 1,000,000 is still its true window",
    );

    settings.applyConfiguredContextWindow(ctx);
    assert.equal(
      ctx.modelRegistry.find(PROVIDER, MAIN_MODEL).contextWindow,
      500_000,
      "a second application is idempotent",
    );
  } finally {
    restoreCatalogWindows(runtime);
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
