// venice-catalog-gen.test.mjs — generative mapper contract.
//
// The mapper is the only place where raw Venice API entries become provider
// model configs. Contract: API truth in (context/max tokens/pricing/capability
// flags), no below-max context caps, no hand-maintained model lists. Pure
// function — no network, no fs writes.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mapVeniceModel,
  resolveFamilyOverlay,
  VENICE_MODELS_API,
} from "../scripts/generate-venice-catalog.mjs";

// Verbatim-shaped fixture from the live API:
// deepseek-v4-pro-0813 with 1M context / 32k max completion.
const DEEPSEEK = {
  context_length: 1000000,
  created: 1786665600,
  id: "deepseek-v4-pro-0813",
  model_spec: {
    pricing: {
      input: { usd: 1.65 },
      cache_input: { usd: 0.165 },
      output: { usd: 4.95 },
    },
    availableContextTokens: 1000000,
    maxCompletionTokens: 32768,
    capabilities: {
      supportsReasoning: true,
      supportsReasoningEffort: false,
      supportsVision: false,
      supportsMultipleImages: false,
      supportsFunctionCalling: true,
      supportsE2EE: false,
    },
    description: "DeepSeek V4 Pro 0813",
  },
};

test("mapper: context/max come from the API at full value — no below-max caps", () => {
  const m = mapVeniceModel(DEEPSEEK);
  assert.equal(m.id, "deepseek-v4-pro-0813");
  assert.equal(m.name, "DeepSeek V4 Pro 0813");
  assert.equal(
    m.contextWindow,
    1000000,
    "context must be the API-reported 1M, never a hand-capped lower value",
  );
  assert.equal(m.maxTokens, 32768, "maxTokens must be the API-reported value");
  assert.equal(m.reasoning, true);
  assert.deepEqual(m.input, ["text"]);
  assert.deepEqual(m.cost, {
    input: 1.65,
    output: 4.95,
    cacheRead: 0.165,
    cacheWrite: 0,
  });
  assert.ok(
    m.compat,
    "deepseek-v4 family compat block applied (see overlay tests)",
  );
});

test("mapper: vision-capable models get image input", () => {
  const m = mapVeniceModel({
    id: "gemini-3-6-flash",
    model_spec: {
      capabilities: { supportsVision: true, supportsMultipleImages: false },
    },
  });
  assert.deepEqual(m.input, ["text", "image"]);
});

test("mapper: e2ee capability derives the developer-role compat quirk", () => {
  const plain = mapVeniceModel({
    id: "x",
    model_spec: { capabilities: { supportsE2EE: false } },
  });
  assert.equal(plain.compat, undefined);
  const e2ee = mapVeniceModel({
    id: "e2ee-x",
    model_spec: { capabilities: { supportsE2EE: true } },
  });
  assert.deepEqual(e2ee.compat, { supportsDeveloperRole: false });
});

test("mapper: missing/zero pricing still emits the all-zero cost shape", () => {
  // pi-ai's calculateCost dereferences model.cost.tiers unconditionally, so
  // an omitted cost breaks the usage path at response time. Unpriced models
  // must carry all-zero rates instead (they render as $0.00).
  const m = mapVeniceModel({ id: "free-model", model_spec: {} });
  assert.deepEqual(m.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  const partial = mapVeniceModel({
    id: "partial",
    model_spec: {
      pricing: { input: { usd: 0 }, output: { usd: 0 } },
      capabilities: {},
    },
  });
  assert.deepEqual(partial.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("mapper: cost, when present, is always fully numeric (calculateCost NaN guard)", () => {
  // pi-ai calculateCost reads every rate field unconditionally; any absent
  // rate -> NaN cost.total -> dead session budget. The mapper must emit a
  // complete cost shape whenever it emits cost at all.
  const cacheless = mapVeniceModel({
    id: "no-cache-price",
    model_spec: { pricing: { input: { usd: 0.2 }, output: { usd: 0.9 } } },
  });
  assert.deepEqual(cacheless.cost, {
    input: 0.2,
    output: 0.9,
    cacheRead: 0,
    cacheWrite: 0,
  });
  const onlyOutput = mapVeniceModel({
    id: "output-only",
    model_spec: { pricing: { output: { usd: 1.5 } } },
  });
  assert.deepEqual(onlyOutput.cost, {
    input: 0,
    output: 1.5,
    cacheRead: 0,
    cacheWrite: 0,
  });
  // And the numbers must survive a calculateCost round-trip without NaN.
  const usage = {
    input: 1000,
    output: 100,
    cacheRead: 500,
    cacheWrite: 0,
    cost: {},
  };
  const rates = cacheless.cost;
  const cost =
    (rates.input / 1e6) * usage.input +
    (rates.output / 1e6) * usage.output +
    (rates.cacheRead / 1e6) * usage.cacheRead +
    (rates.cacheWrite * usage.cacheWrite) / 1e6;
  assert.ok(Number.isFinite(cost), "cost arithmetic must stay finite");
  assert.equal(cost, 0.0002 + 0.00009);
});

test("mapper: no description -> humanized id as name; missing context fields omitted", () => {
  const m = mapVeniceModel({ id: "deepseek-v4-flash-0731", model_spec: {} });
  assert.equal(m.name, "Deepseek V4 Flash 0731");
  assert.equal(m.contextWindow, undefined);
  assert.equal(m.maxTokens, undefined);
});

test("endpoint constant points at the public Venice API (public-safe)", () => {
  assert.equal(VENICE_MODELS_API, "https://api.venice.ai/api/v1/models");
});

// ── Family overlays (compat knowledge the API cannot express) ───────────────

test("overlay: deepseek-v4 family gets thinkingLevelMap + verified compat block", () => {
  const m = mapVeniceModel(DEEPSEEK);
  assert.deepEqual(m.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: null,
    medium: null,
    high: "high",
    xhigh: "xhigh",
    max: "xhigh",
  });
  assert.equal(
    m.thinkingLevelMap.max,
    m.thinkingLevelMap.xhigh,
    "the gateway's native top answers to both canonical names",
  );
  assert.equal(m.compat.requiresAssistantAfterToolResult, true);
  assert.equal(m.compat.requiresReasoningContentOnAssistantMessages, true);
  assert.equal(m.compat.supportsReasoningEffort, true);
  assert.equal(m.compat.supportsDeveloperRole, false);
});

test("mapper: API effort options containing none map pi's off onto the wire value", () => {
  const m = mapVeniceModel({
    id: "some-reasoner",
    model_spec: {
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffortOptions: ["none", "low", "high", "max"],
      },
    },
  });
  assert.equal(
    m.thinkingLevelMap.off,
    "none",
    "off must reach the wire as the explicit disable value",
  );
  assert.equal(m.thinkingLevelMap.high, "high");
  assert.equal(
    m.thinkingLevelMap.xhigh,
    "high",
    "xhigh clamps down to the real max",
  );
});

test("mapper: no none option -> no off entry (off stays wire-silent)", () => {
  const m = mapVeniceModel({
    id: "some-reasoner",
    model_spec: {
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffortOptions: ["low", "medium", "high"],
      },
    },
  });
  assert.equal(m.thinkingLevelMap.off, undefined);
});

test("mapper: gemini family keeps no off entry — the gateway rejects reasoning_effort", () => {
  const m = mapVeniceModel({
    id: "gemini-9-flash",
    model_spec: {
      capabilities: {
        supportsReasoning: true,
        supportsReasoningEffort: true,
        reasoningEffortOptions: ["none", "low", "high"],
      },
    },
  });
  assert.equal(m.compat.supportsReasoningEffort, false);
  assert.equal(
    m.thinkingLevelMap?.off,
    undefined,
    "an inert off entry would misrepresent the wire behavior",
  );
});

test("mapper: probed-unhonored ids never carry an off entry", () => {
  // Each id was probed live: the gateway rejects or ignores
  // reasoning_effort:"none" — see OFF_NONE_EXCLUDED in the generator.
  for (const id of [
    "openai-gpt-52-codex",
    "openai-gpt-53-codex",
    "openai-gpt-54-pro",
    "e2ee-glm-5-2-p",
    "e2ee-glm-5-3-p",
    "e2ee-kimi-k3-p",
  ]) {
    const m = mapVeniceModel({
      id,
      model_spec: {
        capabilities: {
          supportsReasoning: true,
          supportsReasoningEffort: true,
          reasoningEffortOptions: ["none", "low", "high"],
        },
      },
    });
    assert.equal(
      m.thinkingLevelMap?.off,
      undefined,
      `${id} must not claim a wire disable`,
    );
  }
});

test("overlay: glm-5-3-flash family maps off/minimal onto Venice's none", () => {
  const m = mapVeniceModel({
    id: "e2ee-glm-5-3-flash",
    model_spec: { capabilities: { supportsReasoning: true } },
  });
  assert.equal(m.thinkingLevelMap.off, "none");
  assert.equal(m.thinkingLevelMap.minimal, "none");
  assert.equal(m.thinkingLevelMap.xhigh, "max");
  assert.equal(
    m.thinkingLevelMap.max,
    m.thinkingLevelMap.xhigh,
    "the gateway's native top answers to both canonical names",
  );
  const stripped = mapVeniceModel({
    id: "z-ai-glm-5-3-flash",
    model_spec: { capabilities: { supportsReasoning: true } },
  });
  assert.equal(
    stripped.thinkingLevelMap.off,
    undefined,
    "the probed sibling never honors the disable, so it keeps no entry",
  );
});

test("overlay: gemini family rejects reasoning_effort + no developer role", () => {
  const m = mapVeniceModel({ id: "gemini-3-6-flash", model_spec: {} });
  assert.equal(m.compat.supportsReasoningEffort, false);
  assert.equal(m.compat.supportsDeveloperRole, false);
});

test("overlay: qwen-coder rule wins over generic qwen base rule", () => {
  const coder = resolveFamilyOverlay("qwen-2.5-coder-turbo");
  assert.equal(coder.compat.supportsDeveloperRole, false);
  const base = resolveFamilyOverlay("qwen-3.6-plus");
  assert.equal(base.compat.supportsReasoningEffort, true);
  assert.equal(base.compat.supportsDeveloperRole, undefined);
});

const effortFixture = (id) => ({
  id,
  model_spec: {
    capabilities: {
      supportsReasoning: true,
      supportsReasoningEffort: true,
      reasoningEffortOptions: ["none", "low", "medium", "high"],
    },
  },
});

test("mapper: developer-role-rejecting qwen backends carry supportsDeveloperRole:false", () => {
  // Probed live: role `developer` -> HTTP 400 "System message
  // must be at the beginning."; the same prompt under role `system` -> HTTP
  // 200. pi-ai only sends `developer` when model.reasoning, so the flag is
  // what removes the 400 (verified end-to-end on the pi path).
  for (const id of [
    "qwen-3-8-27b",
    "qwen3-6-27b",
    "qwen3-6-35b-a3b",
    "qwen3-5-397b-a17b",
  ]) {
    const m = mapVeniceModel(effortFixture(id));
    assert.equal(
      m.compat?.supportsDeveloperRole,
      false,
      `${id} rejects the developer role; the catalog must say so`,
    );
  }
});

test("mapper: developer-role acceptance is per-id, not per-family", () => {
  // qwen3-5-9b, qwen3-5-35b-a3b and qwen-3-7-plus answered HTTP 200 under
  // role `developer` in the same probe run; a family rule would over-broaden
  // the claim and silently drop the developer role for working models.
  for (const id of ["qwen3-5-9b", "qwen3-5-35b-a3b", "qwen-3-7-plus"]) {
    const m = mapVeniceModel(effortFixture(id));
    assert.equal(
      m.compat?.supportsDeveloperRole,
      undefined,
      `${id} accepts the developer role; the flag would be a false claim`,
    );
    assert.equal(m.compat?.supportsReasoningEffort, true);
  }
});

test("overlay: e2ee API flag merges with the family block", () => {
  const m = mapVeniceModel({
    id: "e2ee-deepseek-v4-flash",
    model_spec: { capabilities: { supportsE2EE: true } },
  });
  assert.equal(m.compat.supportsDeveloperRole, false);
  assert.equal(
    m.compat.requiresAssistantAfterToolResult,
    true,
    "family block must survive the merge",
  );
});

test("overlay: unknown families get no fabricated compat", () => {
  const m = mapVeniceModel({ id: "kimi-k2-thinking", model_spec: {} });
  assert.equal(m.compat, undefined);
  assert.equal(resolveFamilyOverlay("kimi-k2-thinking"), undefined);
});

// ── Top-bucket alias: pi's `max` and `xhigh`, one bucket two names ──────────
//
// A session pinned to `max` must keep its ceiling when the route moves between
// agent-zero/venice (whose top is the gateway's native `xhigh`) and a route that names
// its top `max`. pi-ai's clamp resolves a missing name today by searching up
// the level order, but code that pins a level per model (the virtual-model
// router) must not depend on that search direction — so every map that
// declares a non-null `xhigh` declares `max` as well.

// pi's canonical levels, as the generator ranks them.
const ALIAS_LEVELS = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

const aliasFixture = (id, effortOptions) => ({
  id,
  model_spec: {
    capabilities: {
      supportsReasoning: true,
      supportsReasoningEffort: true,
      ...(effortOptions ? { reasoningEffortOptions: effortOptions } : {}),
    },
  },
});

const ALIAS_INPUTS = [
  DEEPSEEK, // family overlay: xhigh -> "xhigh"
  aliasFixture("e2ee-glm-5-3-flash"), // family overlay: xhigh -> "max"
  // Generative path: every non-empty subset of the canonical levels as the
  // model's effort options — the whole input space, not a sample of it.
  ...Array.from({ length: (1 << ALIAS_LEVELS.length) - 1 }, (_, index) => {
    const mask = index + 1;
    return aliasFixture(
      `alias-subset-${mask}`,
      ALIAS_LEVELS.filter((_, bit) => (mask & (1 << bit)) !== 0),
    );
  }),
];

test("catalog: every map declaring xhigh also declares max", () => {
  const mapped = ALIAS_INPUTS.map((raw) => mapVeniceModel(raw));
  const withXhigh = mapped.filter((m) => m.thinkingLevelMap?.xhigh != null);
  assert.equal(
    withXhigh.length,
    ALIAS_INPUTS.length,
    "every fixture must reach a map declaring xhigh, or the sweep proves nothing",
  );
  for (const m of mapped) {
    const map = m.thinkingLevelMap;
    if (map?.xhigh != null) {
      assert.ok(
        map.max != null,
        `${m.id}: a map declaring xhigh must also declare max`,
      );
    }
    if (map && "max" in map) {
      assert.ok(
        map.max != null,
        `${m.id}: max declared null would read as no top bucket at all`,
      );
    }
  }
});

test("mapper: generative map resolves both top names, not just one", () => {
  const topless = mapVeniceModel(
    aliasFixture("alias-generative-tops-at-high", [
      "none",
      "low",
      "medium",
      "high",
    ]),
  ).thinkingLevelMap;
  assert.equal(topless.xhigh, "high", "xhigh clamps down to the real max");
  assert.equal(
    topless.max,
    topless.xhigh,
    "a model whose options top out at high resolves both names to high",
  );
  const withMax = mapVeniceModel(
    aliasFixture("alias-generative-carries-max", [
      "none",
      "low",
      "high",
      "max",
    ]),
  ).thinkingLevelMap;
  assert.equal(withMax.max, "max", "a native max option is reached by name");
  assert.equal(
    withMax.xhigh,
    "high",
    "xhigh absent from the options still clamps down to the nearest",
  );
});
