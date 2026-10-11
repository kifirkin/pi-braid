// venice-catalog-cost.test.mjs — generated-catalog cost invariants.
//
// Contract: every catalog entry carries a complete numeric cost shape
// (input/output/cacheRead/cacheWrite). pi-ai's calculateCost dereferences
// model.cost.tiers unconditionally (absent cost -> TypeError) and multiplies
// every rate field unconditionally (absent rate -> NaN into cost.total), so a
// catalog entry that omits rates breaks the usage path at response time. The
// generator fills absent rates with 0 — including for models with no pricing
// at all (they render as $0.00).
//
// The fixture drives the real mapper over representative raw API entries; when
// the owner-private generated catalog is present on this machine, the same
// invariants are checked against it (skipped on CI / public checkouts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { mapVeniceModel } from "../scripts/generate-venice-catalog.mjs";

const RATE_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];

// ── Fixture: representative Venice /models entries, mapped by the real mapper ──

const RAW_FIXTURES = [
  {
    // Full three-rate pricing (live API shape).
    id: "deepseek-v4-pro-0813",
    context_length: 1000000,
    model_spec: {
      pricing: {
        input: { usd: 1.65 },
        cache_input: { usd: 0.165 },
        output: { usd: 4.95 },
      },
      maxCompletionTokens: 32768,
      capabilities: { supportsReasoning: true },
    },
  },
  // No cache-read price — Venice publishes one for some models only.
  {
    id: "qwen-3.6-plus",
    model_spec: { pricing: { input: { usd: 0.2 }, output: { usd: 0.9 } } },
  },
  // Output-only pricing.
  {
    id: "output-only-model",
    model_spec: { pricing: { output: { usd: 1.5 } } },
  },
  // Explicit zero is a present rate, not a missing one.
  {
    id: "zero-priced-model",
    model_spec: {
      pricing: {
        input: { usd: 0 },
        cache_input: { usd: 0 },
        output: { usd: 0 },
      },
    },
  },
  // No pricing at all — the TypeError path this contract closes.
  { id: "free-model", model_spec: {} },
  // A null usd value counts as absent.
  {
    id: "null-rate-model",
    model_spec: { pricing: { input: { usd: null }, output: { usd: 0.5 } } },
  },
];

const catalogModels = RAW_FIXTURES.map((raw) => mapVeniceModel(raw));

function assertCompleteCost(model) {
  assert.ok(
    model.cost,
    `${model.id}: cost must be present — calculateCost dereferences model.cost.tiers`,
  );
  for (const field of RATE_FIELDS) {
    assert.equal(
      typeof model.cost[field],
      "number",
      `${model.id}: cost.${field} must be a number`,
    );
    assert.ok(
      Number.isFinite(model.cost[field]),
      `${model.id}: cost.${field} must be finite`,
    );
  }
}

// Mirror of pi-ai's calculateCost (installed models.js, 0.85.1): tier
// selection over model.cost.tiers, then one product per rate field. A
// re-implementation so the test does not depend on pi-ai internals; the
// arithmetic is exactly what a missing rate turns into NaN.
function piAiStyleCost(model, usage) {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;
  let rates = model.cost;
  let matchedThreshold = -1;
  for (const tier of model.cost.tiers ?? []) {
    if (
      inputTokens > tier.inputTokensAbove &&
      tier.inputTokensAbove > matchedThreshold
    ) {
      rates = tier;
      matchedThreshold = tier.inputTokensAbove;
    }
  }
  const longWrite = usage.cacheWrite1h ?? 0;
  const shortWrite = usage.cacheWrite - longWrite;
  const cost = {
    input: (rates.input / 1000000) * usage.input,
    output: (rates.output / 1000000) * usage.output,
    cacheRead: (rates.cacheRead / 1000000) * usage.cacheRead,
    cacheWrite:
      (rates.cacheWrite * shortWrite + rates.input * 2 * longWrite) / 1000000,
  };
  cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
  return cost;
}

const USAGE = {
  input: 12345,
  output: 678,
  cacheRead: 4321,
  cacheWrite: 100,
  cacheWrite1h: 25,
};

test("catalog: every entry carries cost with all four finite rates", () => {
  assert.equal(catalogModels.length, RAW_FIXTURES.length);
  for (const model of catalogModels) assertCompleteCost(model);
});

test("catalog: unpriced entries get the all-zero shape, not an omission", () => {
  const free = catalogModels.find((m) => m.id === "free-model");
  assert.deepEqual(free.cost, {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  });
  const nullRate = catalogModels.find((m) => m.id === "null-rate-model");
  assert.deepEqual(nullRate.cost, {
    input: 0,
    output: 0.5,
    cacheRead: 0,
    cacheWrite: 0,
  });
});

test("catalog: pi-ai-style arithmetic stays finite for every entry", () => {
  for (const model of catalogModels) {
    const cost = piAiStyleCost(model, { ...USAGE });
    for (const field of [...RATE_FIELDS, "total"]) {
      assert.ok(
        Number.isFinite(cost[field]),
        `${model.id}: cost.${field} must be finite (no NaN)`,
      );
    }
    assert.equal(Number.isNaN(cost.total), false, `${model.id}: NaN total`);
  }
});

test("catalog: priced entry multiplies to the expected total", () => {
  const model = catalogModels.find((m) => m.id === "deepseek-v4-pro-0813");
  const cost = piAiStyleCost(model, {
    input: 1000,
    output: 100,
    cacheRead: 500,
    cacheWrite: 0,
    cost: {},
  });
  assert.ok(
    Math.abs(cost.total - 0.0022275) < 1e-12,
    `expected 0.0022275, got ${cost.total}`,
  );
});

// ── Owner-private generated catalog (present on the owner machine only) ──────

const livePath =
  process.env.VENICE_CATALOG_FILE ??
  join(homedir(), ".pi", "agent", "venice-models.json");
const liveExists = existsSync(livePath);

test(
  "live catalog: cost-complete and chmod 600",
  {
    skip: liveExists
      ? false
      : "owner-private catalog absent (public tree / CI)",
  },
  () => {
    const raw = JSON.parse(readFileSync(livePath, "utf8"));
    assert.ok(
      Array.isArray(raw.models),
      `${livePath}: models must be an array`,
    );
    assert.ok(raw.models.length > 0, `${livePath}: catalog must not be empty`);
    for (const model of raw.models) assertCompleteCost(model);
    const mode = statSync(livePath).mode & 0o777;
    assert.equal(
      mode,
      0o600,
      `${livePath}: expected owner-only permissions (600), got ${mode.toString(8)}`,
    );
  },
);
