/**
 * Configured window survives /reload and agrees across surfaces.
 *
 * The plumb (applyConfiguredContextWindow) is applied at session_start, not
 * only at before_agent_start. pi-core's AgentSession.reload() rebuilds
 * the extension runner and re-resolves the session model from the catalog
 * (registerProvider -> _refreshCurrentModelFromRegistry replaces
 * agent.state.model with a fresh object carrying the provider window), then
 * emits session_start with reason "reload" (agent-session.js). A
 * before_agent_start-only plumb therefore leaves the window between reload
 * and the next agent run unguarded: the TUI footer reads its denominator
 * from that model object (footer.js: contextUsage?.contextWindow ??
 * state.model?.contextWindow ?? 0) and shows the native window, while
 * enforcement resolves the configured cap from settings (context-tiers.ts).
 *
 * This fixture runs the REAL dist code on all three surfaces:
 * - wiring: the polyfill default export registered on a fake ExtensionAPI
 *   harness, driving session_start the way pi-core emits it;
 * - display: the real pi-core FooterComponent rendered against a fake
 *   session whose contextWindow reads the live model object (mirroring
 *   agent-session.getContextUsage, which reads this.model);
 * - enforcement: the real shared getContextUsage accessor from
 *   lib/detection/context-tiers (settings-first resolver).
 *
 * Asserts configured == enforced == displayed for the 144k case, for a
 * non-default 111k case, and the fallback invariant when the setting is
 * unset (footer keeps the provider window, plumb is a no-op). Also pins
 * the ceiling invariant: a configured value above the model's true window
 * keeps the true window (never widens it), while an unknown true window
 * takes the configured value.
 *
 * Run: node test/runtime/core/test-configured-window-reload-survival.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_DIST = join(HERE, "..", "..", "..", "dist");
const PICORE_DIST = join(
  HERE, "..", "..", "..", "..", "..", "node_modules", "@earendil-works", "pi-coding-agent", "dist",
);

const CONFIGURED = 144_000;
const NON_DEFAULT = 111_000;
const PROVIDER = 1_000_000;
// A true window below the configured cap: the ceiling case (e.g. an
// openrouter z-ai/glm-4.7 manual pick at 202752).
const SMALLER_TRUE_WINDOW = 202_752;

console.log("=== configured window survives /reload and agrees across surfaces ===\n");

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

// HOME must point at the fixture's temp home before the dist modules
// evaluate SETTINGS_PATH; braid's readSettings re-reads the file per call,
// so scenarios can rewrite settings.json without re-importing.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "reload-t1-home-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });

function writeHomeSettings(braidContext) {
  writeFileSync(
    join(FAKE_HOME, ".pi", "agent", "settings.json"),
    JSON.stringify(braidContext ? { braid: { context: braidContext } } : {}),
  );
}

const settings = await import(`file://${join(REPO_DIST, "lib/config/braid-settings.js")}`);
const contextTiers = await import(`file://${join(REPO_DIST, "lib/detection/context-tiers.js")}`);
const polyfill = await import(`file://${join(REPO_DIST, "extensions/core/polyfill/index.js")}`);
const footerMod = await import(
  `file://${join(PICORE_DIST, "modes/interactive/components/footer.js")}`
);
const themeMod = await import(`file://${join(PICORE_DIST, "modes/interactive/theme/theme.js")}`);
themeMod.initTheme();

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

/**
 * Fake AgentSession with the exact surface FooterComponent.render reads.
 * getContextUsage mirrors agent-session.getContextUsage's contract: the
 * contextWindow comes from the live model object, tokens null until the
 * next LLM response after compaction.
 */
function makeFakeSession(model) {
  const sessionManager = {
    // Mutable: a test advances this to model the next session append, which
    // is what moves the footer's stats cache key.
    entryCount: 0,
    getEntries: () => [],
    getEntryCount: () => sessionManager.entryCount,
    getSessionId: () => "fixture-session",
    getLeafId: () => null,
    getCwd: () => "/tmp/reload-t1",
    getSessionName: () => null,
  };
  const session = {
    state: { model, thinkingLevel: "off" },
    // AgentSession exposes `model`; the footer's stats cache keys on the
    // model object identity (routedModel?.model ?? model).
    get model() {
      return session.state.model;
    },
    autoCompactionEnabled: false,
    modelRuntime: { isUsingSubscription: () => false },
    sessionManager,
    getContextUsage() {
      if (!session.state.model) return undefined;
      const contextWindow = session.state.model.contextWindow ?? 0;
      if (contextWindow <= 0) return undefined;
      return { tokens: null, contextWindow, percent: null };
    },
  };
  return session;
}

function makeFooterData() {
  return {
    getGitBranch: () => null,
    getAvailableProviderCount: () => 1,
    getExtensionStatuses: () => new Map(),
  };
}

/**
 * Enforcement-side ctx: the duck-typed accessor pi extensions get. Pass
 * accessorWindow to simulate an accessor still reporting the provider
 * window (the un-plumbed state) while the model object is already patched.
 */
function makeEnforcementCtx(model, accessorWindow) {
  const window = accessorWindow ?? model?.contextWindow ?? 0;
  return {
    model,
    getContextUsage: () => ({
      percent: 11.4,
      tokens: 30_000,
      contextWindow: window,
    }),
  };
}

const { formatTokens } = footerMod;

/** FooterComponent.render returns an array of lines; compare as one string. */
function renderFooter(footer, width = 100) {
  return footer.render(width).join("\n");
}

await test("session_start applies the configured 144k window on startup (footer was native before)", async () => {
  writeHomeSettings({ contextLimitTokens: CONFIGURED });
  const harness = makePiHarness();
  polyfill.default(harness.pi);
  const model = { provider: "agent-zero", id: "test-model", contextWindow: PROVIDER };
  const ctx = { model };
  const session = makeFakeSession(model);

  const pre = new footerMod.FooterComponent(session, makeFooterData());
  pre.autoCompactEnabled = false;
  const preRendered = renderFooter(pre);
  assert.ok(
    preRendered.includes(`/${formatTokens(PROVIDER)}`),
    `before session_start the footer shows the native provider window, got: ${preRendered}`,
  );

  await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.equal(
    ctx.model.contextWindow,
    CONFIGURED,
    "session_start wired the plumb: the session model reports the configured window",
  );

  const post = new footerMod.FooterComponent(session, makeFooterData());
  post.autoCompactEnabled = false;
  const postRendered = renderFooter(post);
  assert.ok(
    postRendered.includes(`/${formatTokens(CONFIGURED)}`),
    `after session_start the footer denominator shows the configured window, got: ${postRendered}`,
  );
  assert.ok(
    !postRendered.includes(`/${formatTokens(PROVIDER)}`),
    "the native provider window is gone from the footer",
  );
});

await test("enforcement accessor agrees with the displayed denominator at 144k", async () => {
  const model = { provider: "agent-zero", id: "test-model", contextWindow: CONFIGURED };
  const usage = contextTiers.getContextUsage(makeEnforcementCtx(model, PROVIDER));
  assert.equal(
    usage?.contextWindow,
    CONFIGURED,
    "the enforcement denominator resolves to the configured window",
  );
  assert.equal(
    getConfigured(),
    CONFIGURED,
    "the configured override reads back as configured",
  );
  assert.ok(
    Math.abs(usage.percent - (30_000 / CONFIGURED) * 100) < 1e-9,
    "enforcement percent is recomputed against the resolved window",
  );
});

await test("reload: pi-core re-resolves the model object, session_start re-applies the configured window", async () => {
  const harness = makePiHarness();
  polyfill.default(harness.pi);
  // Post-reload state: pi-core replaced agent.state.model with a fresh
  // catalog object carrying the provider window.
  const freshModel = { provider: "agent-zero", id: "test-model", contextWindow: PROVIDER };
  const ctx = { model: freshModel };
  const session = makeFakeSession(freshModel);
  const footer = new footerMod.FooterComponent(session, makeFooterData());
  footer.autoCompactEnabled = false;
  assert.ok(
    renderFooter(footer).includes(`/${formatTokens(PROVIDER)}`),
    "post-reload, pre-handler the footer shows the native window (the regression)",
  );

  await harness.emit("session_start", { type: "session_start", reason: "reload" }, ctx);
  assert.equal(
    freshModel.contextWindow,
    CONFIGURED,
    "session_start re-applied the configured window to the re-resolved model object",
  );

  // pi-core's FooterComponent.getSessionStats() memoizes the per-session
  // stats - contextUsage included - keyed on (session, sessionId, leafId,
  // entryCount, limitsModel), where limitsModel is the model OBJECT identity.
  // applyConfiguredContextWindow patches that same object in place, so the
  // key does not move and the pending render is still the cached pre-patch
  // value: the display lag is bounded by the next session append. Enforcement
  // is not memoized and agrees at once.
  const usage = contextTiers.getContextUsage(makeEnforcementCtx(freshModel, PROVIDER));
  assert.equal(
    usage?.contextWindow,
    CONFIGURED,
    "enforcement resolves the configured window immediately after the reload handler",
  );

  session.sessionManager.entryCount += 1;
  assert.ok(
    renderFooter(footer).includes(`/${formatTokens(CONFIGURED)}`),
    "once a session entry lands, the footer's stats cache recomputes and shows the configured window",
  );
  assert.ok(
    !renderFooter(footer).includes(`/${formatTokens(PROVIDER)}`),
    "the native provider window is gone from the footer once the cache recomputes",
  );
});

await test("before_agent_start re-applies the window after a mid-session model switch", async () => {
  const harness = makePiHarness();
  polyfill.default(harness.pi);
  const switchedModel = { provider: "agent-zero", id: "other-model", contextWindow: PROVIDER };
  const ctx = { model: switchedModel, sessionManager: undefined };
  await harness.emit("before_agent_start", { type: "before_agent_start" }, ctx);
  assert.equal(
    switchedModel.contextWindow,
    CONFIGURED,
    "before_agent_start re-plumbed the freshly selected model",
  );
});

await test("non-default window (111k) is picked up identically on all surfaces", async () => {
  writeHomeSettings({ contextLimitTokens: NON_DEFAULT });
  const harness = makePiHarness();
  polyfill.default(harness.pi);
  const model = { provider: "agent-zero", id: "test-model", contextWindow: PROVIDER };
  const ctx = { model };
  const session = makeFakeSession(model);
  await harness.emit("session_start", { type: "session_start", reason: "reload" }, ctx);

  assert.equal(ctx.model.contextWindow, NON_DEFAULT, "plumb applied the non-default value");
  const usage = contextTiers.getContextUsage(makeEnforcementCtx(model));
  assert.equal(usage?.contextWindow, NON_DEFAULT, "enforcement resolves the non-default value");
  // The recompute path: an accessor still reporting the provider window
  // (enforcement before the plumb reaches it) is overridden to the
  // configured value and its percent recomputed against it.
  const unresolved = contextTiers.getContextUsage(
    makeEnforcementCtx(model, PROVIDER),
  );
  assert.equal(unresolved?.contextWindow, NON_DEFAULT, "provider-window accessor is overridden");
  assert.ok(
    Math.abs(unresolved.percent - (30_000 / NON_DEFAULT) * 100) < 1e-9,
    "percent is recomputed against the resolved window",
  );
  const footer = new footerMod.FooterComponent(session, makeFooterData());
  footer.autoCompactEnabled = false;
  const rendered = renderFooter(footer);
  assert.ok(
    rendered.includes(`/${formatTokens(NON_DEFAULT)}`),
    `footer displays the non-default window, got: ${rendered}`,
  );
});

await test("unset contextLimitTokens: plumb is a no-op, all surfaces keep the provider window", async () => {
  writeHomeSettings(undefined);
  const harness = makePiHarness();
  polyfill.default(harness.pi);
  const model = { provider: "agent-zero", id: "test-model", contextWindow: PROVIDER };
  const ctx = { model };
  const session = makeFakeSession(model);
  await harness.emit("session_start", { type: "session_start", reason: "reload" }, ctx);

  assert.equal(ctx.model.contextWindow, PROVIDER, "no configured limit: model unchanged");
  const usage = contextTiers.getContextUsage(makeEnforcementCtx(model));
  assert.equal(usage?.contextWindow, PROVIDER, "enforcement keeps provider semantics");
  const footer = new footerMod.FooterComponent(session, makeFooterData());
  footer.autoCompactEnabled = false;
  assert.ok(
    renderFooter(footer).includes(`/${formatTokens(PROVIDER)}`),
    "footer keeps the provider window",
  );
});

await test("model_select re-plumbs the configured window onto a freshly switched model", async () => {
  // Mid-session switch (rotation or /model) installs a brand-new catalog
  // model object that carries the PROVIDER window. Without the model_select
  // hook the configured cap is not re-applied until the next
  // before_agent_start: pi-core's threshold compaction and the usage display
  // read the provider window in between. Regression: pre-fix builds left
  // modelB at PROVIDER here.
  writeHomeSettings({ contextLimitTokens: CONFIGURED });
  const harness = makePiHarness();
  polyfill.default(harness.pi);
  const modelA = { provider: "agent-zero", id: "primary-model", contextWindow: PROVIDER };
  const ctx = { model: modelA };
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.equal(modelA.contextWindow, CONFIGURED, "startup plumb applied to the first model");

  const modelB = {
    provider: "openrouter",
    id: "deepseek/deepseek-v4.1-flash",
    contextWindow: PROVIDER,
  };
  ctx.model = modelB;
  await harness.emit(
    "model_select",
    { type: "model_select", model: modelB, previousModel: modelA, source: "set" },
    ctx,
  );
  assert.equal(
    modelB.contextWindow,
    CONFIGURED,
    "model_select re-applied the configured window onto the switched model",
  );
  const usage = contextTiers.getContextUsage(makeEnforcementCtx(modelB));
  assert.equal(
    usage?.contextWindow,
    CONFIGURED,
    "enforcement resolves the switched model against the configured window",
  );
});

await test("ceiling: a configured cap above the true window keeps the true window", async () => {
  // Pre-change (blind overwrite) this wrote the 1M cap onto the 202752
  // model: the RED assertion is the first assert.equal below.
  writeHomeSettings({ contextLimitTokens: PROVIDER });
  const harness = makePiHarness();
  polyfill.default(harness.pi);
  const model = { provider: "openrouter", id: "z-ai/glm-4.7", contextWindow: SMALLER_TRUE_WINDOW };
  const ctx = { model };
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.equal(
    model.contextWindow,
    SMALLER_TRUE_WINDOW,
    "the plumb is a ceiling: a cap above the true window must not widen the model",
  );
  const usage = contextTiers.getContextUsage(makeEnforcementCtx(model));
  assert.equal(
    usage?.contextWindow,
    SMALLER_TRUE_WINDOW,
    "enforcement resolves the true window, not the cap above it",
  );
  const footer = new footerMod.FooterComponent(makeFakeSession(model), makeFooterData());
  footer.autoCompactEnabled = false;
  assert.ok(
    renderFooter(footer).includes(`/${formatTokens(SMALLER_TRUE_WINDOW)}`),
    "the footer denominator stays the true window",
  );
});

await test("ceiling: configured above an unknown true window applies the configured cap", async () => {
  writeHomeSettings({ contextLimitTokens: PROVIDER });
  const harness = makePiHarness();
  polyfill.default(harness.pi);
  const model = { provider: "agent-zero", id: "window-unknown" };
  const ctx = { model };
  await harness.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
  assert.equal(
    model.contextWindow,
    PROVIDER,
    "no known true window: the configured cap stands alone",
  );
});

function getConfigured() {
  return settings.getConfiguredContextLimitTokens();
}

rmSync(FAKE_HOME, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
