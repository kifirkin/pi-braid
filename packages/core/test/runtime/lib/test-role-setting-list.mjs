/**
 * Role settings accept an ordered list of models.
 *
 * WHY THIS TEST EXISTS:
 *   A role setting (the merged utilityModel, which image analysis also falls
 *   back to) named a single pattern, so a role pinned to one provider was
 *   pinned to that provider's key ring. With the ring spent, a direct-call consumer attempted the spent
 *   provider anyway (one wasted request per call), and a chain consumer's whole
 *   role tier collapsed past the role to the session model — never to another
 *   model that could serve the same role.
 *
 *   An ordered list is the fix: the entries are walked in order and the first
 *   one the provider layer reports usable wins. The single-model resolvers
 *   return that first usable entry, so a one-call consumer cannot address a
 *   spent route; resolveUtilityModels hands every entry to tryModelChain, which
 *   asks the provider layer per tier and skips the ones it refuses.
 *
 * WHAT IS PINNED HERE:
 *   1. A list skips the spent entry and issues its request to the next one,
 *      carrying the role's model id from the other provider — both through the
 *      single-model resolver a one-call consumer uses today and through the
 *      list resolver the chain consumers now use.
 *   2. Negative control: a healthy ring issues exactly one request, to the
 *      role's own provider, with isModelRouteUsable === true.
 *   3. A scalar keeps the pre-list behaviour (resolved, no usability filter).
 *   4. Entries are trimmed; empties and non-strings are dropped; a value with
 *      no usable pattern resolves to nothing.
 *   5. The vision role never selects a text-only entry for an image call.
 *   6. With every entry refused the chain still ends at the session model.
 *
 * Driven through the process-global ring-feedback slot with a stubbed
 * completion call (__setCompleteSimpleForTest): no provider is contacted and
 * the request count is observable.
 */

import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const {
  resolveUtilityModel,
  resolveUtilityModels,
  resolveVisionModel,
  normaliseRoleSetting,
  tryModelChain,
} = await import(join(ROOT, "dist", "lib", "ai", "model-resolver.js"));
const { isModelRouteUsable, __setCompleteSimpleForTest } = await import(
  join(ROOT, "dist", "lib", "ai", "llm-call.js")
);
const {
  getCustomModelKeys,
  setKeyRingFeedbackHandler,
  resetKeyRingFeedbackHandler,
  UTILITY_MODEL_KEY,
} = await import(join(ROOT, "dist", "lib", "state", "global-state.js"));

const ROLE_ID = "role-model";
const ROLE_A = { id: ROLE_ID, provider: "route-a", api: "anthropic-messages", input: ["text"] };
const ROLE_B = { id: ROLE_ID, provider: "route-b", api: "anthropic-messages", input: ["text"] };
const TEXT_ONLY = {
  id: "text-only",
  provider: "route-a",
  api: "anthropic-messages",
  input: ["text"],
};
const VISION = {
  id: "vision-look",
  provider: "route-b",
  api: "anthropic-messages",
  input: ["text", "image"],
};
// Ordered BEFORE VISION so the role's own fall-through (priority 3) picks this
// one: a vision assertion can then tell "the list entry was used" from "the
// setting was dropped and the search fell through".
const FALLBACK_VISION = {
  id: "fallback-vision",
  provider: "route-c",
  api: "anthropic-messages",
  input: ["text", "image"],
};
const SESSION = {
  id: "session-model-x",
  provider: "opencode-go",
  api: "anthropic-messages",
  input: ["text"],
};
const CATALOG = [ROLE_A, ROLE_B, TEXT_ONLY, FALLBACK_VISION, VISION, SESSION];

function makeCtx() {
  return {
    model: SESSION,
    modelRegistry: {
      find: (provider, id) => CATALOG.find((m) => m.provider === provider && m.id === id),
      getAll: () => CATALOG,
      getAvailable: () => CATALOG,
      getApiKeyForProvider: async () => "test-key",
    },
  };
}

/** A ring-feedback handler whose routeUsable decision is supplied per test. */
function ring(decide) {
  return {
    reportFailure() {},
    reportSuccess() {},
    routeUsable: (modelId, providerId) => decide(modelId, providerId),
  };
}

/** Record every provider request the chain makes, and answer it with text. */
function recordRequests() {
  const requests = [];
  __setCompleteSimpleForTest(async (model) => {
    requests.push({ id: model.id, provider: model.provider });
    return {
      content: [{ type: "text", text: "ok" }],
      stopReason: "stop",
      usage: { input: 1, output: 1, totalTokens: 2 },
    };
  });
  return requests;
}

/** The chain a consumer builds from a role setting: the list, then the session. */
function chainFor(ctx) {
  return [...resolveUtilityModels(ctx).map((model) => () => model), () => ctx.model];
}

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failed++;
  } finally {
    __setCompleteSimpleForTest(null);
    resetKeyRingFeedbackHandler();
    getCustomModelKeys().clear();
  }
}

console.log("=== Role settings as an ordered model list ===\n");

await test("a list setting: the first request reaches the other provider", async () => {
  // The chain a consumer builds from the main-present symbol, so the assertion
  // is about behaviour and not about a new export. On unmodified main the list
  // is dropped and the chain's first request is the session model.
  const ctx = makeCtx();
  getCustomModelKeys().set(UTILITY_MODEL_KEY, ["route-a/role-model", "route-b/role-model"]);
  const requests = recordRequests();
  setKeyRingFeedbackHandler(ring((_id, provider) => provider !== "route-a"));

  const result = await tryModelChain(
    ctx,
    [() => resolveUtilityModel(ctx), () => ctx.model],
    "sys",
    "user",
    { maxRetries: 0, sdkRetries: 0 },
  );

  assert.equal("error" in result, false, `the chain must succeed; got ${JSON.stringify(result)}`);
  assert.deepEqual(
    requests,
    [{ id: ROLE_ID, provider: "route-b" }],
    "the first request must reach the other provider, carrying the role's model id",
  );
});

await test("an ordered list skips the spent entry and calls the next provider", async () => {
  assert.equal(
    typeof resolveUtilityModels,
    "function",
    "resolveUtilityModels is missing: this revision has no ordered-list role resolver",
  );
  const ctx = makeCtx();
  getCustomModelKeys().set(UTILITY_MODEL_KEY, ["route-a/role-model", "route-b/role-model"]);
  const requests = recordRequests();
  setKeyRingFeedbackHandler(ring((_id, provider) => provider !== "route-a"));

  const entries = resolveUtilityModels(ctx);
  assert.equal(entries.length, 2, "both configured entries must resolve for the chain");
  const chain = [...entries.map((model) => () => model), () => ctx.model];

  const result = await tryModelChain(ctx, chain, "sys", "user", { maxRetries: 0, sdkRetries: 0 });

  assert.equal("error" in result, false, `the chain must succeed; got ${JSON.stringify(result)}`);
  assert.deepEqual(
    requests,
    [{ id: ROLE_ID, provider: "route-b" }],
    "the first request must go to the other provider, carrying the role's model id",
  );
});

await test("negative control: a scalar and a healthy ring call the role's own provider once", async () => {
  const ctx = makeCtx();
  getCustomModelKeys().set(UTILITY_MODEL_KEY, "route-a/role-model");
  const requests = recordRequests();
  setKeyRingFeedbackHandler(ring(() => true));

  const model = resolveUtilityModel(ctx);
  assert.equal(model, ROLE_A, "a scalar resolves to the configured model, unfiltered");
  assert.equal(isModelRouteUsable(model), true, "the healthy ring reports the pair usable");

  await tryModelChain(ctx, [() => model, () => ctx.model], "sys", "user", {
    maxRetries: 0,
    sdkRetries: 0,
  });

  assert.deepEqual(
    requests,
    [{ id: ROLE_ID, provider: "route-a" }],
    "exactly one request, to the role's own provider",
  );
});

await test("a healthy ring keeps the first list entry", async () => {
  const ctx = makeCtx();
  getCustomModelKeys().set(UTILITY_MODEL_KEY, ["route-a/role-model", "route-b/role-model"]);
  const requests = recordRequests();
  setKeyRingFeedbackHandler(ring(() => true));

  await tryModelChain(ctx, chainFor(ctx), "sys", "user", { maxRetries: 0, sdkRetries: 0 });

  assert.deepEqual(
    requests,
    [{ id: ROLE_ID, provider: "route-a" }],
    "the first entry wins while the provider layer has nothing against it",
  );
});

await test("the single-model resolver returns the first usable entry", async () => {
  const ctx = makeCtx();
  getCustomModelKeys().set(UTILITY_MODEL_KEY, ["route-a/role-model", "route-b/role-model"]);
  setKeyRingFeedbackHandler(ring((_id, provider) => provider === "route-b"));

  assert.equal(
    resolveUtilityModel(ctx),
    ROLE_B,
    "a one-call consumer must not be handed the spent route",
  );
});

await test("every entry refused: the chain falls to the session model", async () => {
  const ctx = makeCtx();
  getCustomModelKeys().set(UTILITY_MODEL_KEY, ["route-a/role-model", "route-b/role-model"]);
  const requests = recordRequests();
  setKeyRingFeedbackHandler(
    ring((_id, provider) => provider !== "route-a" && provider !== "route-b"),
  );

  await tryModelChain(ctx, chainFor(ctx), "sys", "user", { maxRetries: 0, sdkRetries: 0 });

  assert.deepEqual(
    requests,
    [{ id: "session-model-x", provider: "opencode-go" }],
    "the session model stays last in the chain",
  );
});

await test("list entries are trimmed and non-strings are dropped", async () => {
  assert.equal(
    typeof normaliseRoleSetting,
    "function",
    "normaliseRoleSetting is missing: this revision cannot carry a list setting",
  );
  const ctx = makeCtx();
  getCustomModelKeys().set(UTILITY_MODEL_KEY, [
    "  route-a/role-model  ",
    "",
    42,
    null,
    "route-b/role-model",
  ]);
  setKeyRingFeedbackHandler(ring(() => true));

  assert.deepEqual(normaliseRoleSetting(getCustomModelKeys().get(UTILITY_MODEL_KEY)), [
    "route-a/role-model",
    "route-b/role-model",
  ]);
  assert.equal(resolveUtilityModel(ctx), ROLE_A, "the trimmed first entry must resolve");
});

await test("a value with no usable pattern resolves to nothing", async () => {
  const ctx = makeCtx();
  getCustomModelKeys().set(UTILITY_MODEL_KEY, []);
  assert.equal(resolveUtilityModel(ctx), undefined, "an empty list means unset");
  assert.deepEqual(resolveUtilityModels(ctx), [], "an empty list offers no chain tiers");

  getCustomModelKeys().set(UTILITY_MODEL_KEY, "   ");
  assert.equal(resolveUtilityModel(ctx), undefined, "a blank pattern means unset");
});

await test("with no role configured the chain still ends at the session model", async () => {
  const ctx = makeCtx();
  const requests = recordRequests();
  setKeyRingFeedbackHandler(ring(() => true));

  assert.deepEqual(resolveUtilityModels(ctx), []);
  await tryModelChain(ctx, chainFor(ctx), "sys", "user", { maxRetries: 0, sdkRetries: 0 });

  assert.deepEqual(requests, [{ id: "session-model-x", provider: "opencode-go" }]);
});

await test("the merged role supplies the image-capable entry", async () => {
  const ctx = makeCtx();
  getCustomModelKeys().set(UTILITY_MODEL_KEY, ["route-a/text-only", "route-b/vision-look"]);
  setKeyRingFeedbackHandler(ring(() => true));

  assert.equal(
    resolveVisionModel(ctx),
    VISION,
    "the utility list's first image-capable entry must win; a text-only entry is skipped",
  );
});

await test("a spent utility route falls to the next usable image-capable entry", async () => {
  const ctx = makeCtx();
  getCustomModelKeys().set(UTILITY_MODEL_KEY, [
    "route-b/vision-look",
    "route-c/fallback-vision",
  ]);
  setKeyRingFeedbackHandler(ring((_id, provider) => provider !== "route-b"));

  assert.equal(
    resolveVisionModel(ctx),
    FALLBACK_VISION,
    "an entry whose route the provider layer refuses must not be selected",
  );
});

await test("with no role configured, the session model decides, then the first available", async () => {
  const imageSession = { ...SESSION, input: ["text", "image"] };
  const visionCtx = { ...makeCtx(), model: imageSession };
  setKeyRingFeedbackHandler(ring(() => true));

  assert.equal(
    resolveVisionModel(visionCtx),
    imageSession,
    "an image-capable session model is the first fallback",
  );
  assert.equal(
    resolveVisionModel(makeCtx()),
    FALLBACK_VISION,
    "a text-only session falls through to the first available image-capable model",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== ordered role-list tests passed ===");
