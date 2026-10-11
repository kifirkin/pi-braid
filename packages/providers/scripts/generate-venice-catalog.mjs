// generate-venice-catalog.mjs — generative venice model catalog.
//
// The venice model list is GENERATED from the Venice API
// (https://api.venice.ai/api/v1/models — public, no auth required), never
// hand-maintained. The API is the single source of truth for context windows,
// max completion tokens, pricing, and capability flags — no hard-capped
// context below the reported maximum.
//
// The private gateway base URL is NOT hardcoded here (the public repo must
// not carry it): pass VENICE_CATALOG_BASE_URL (https://...) — required.
//
// Output: { baseUrl, models } written to $VENICE_CATALOG_FILE or
// ~/.pi/agent/venice-models.json (the exact file the runtime seam
// venice-catalog.ts loads), chmod 600.
//
//   VENICE_CATALOG_BASE_URL=https://... node scripts/generate-venice-catalog.mjs
//
// Public-safe: contains no credentials. Optional auth (some proxies mirror the
// API behind auth) via VENICE_API_KEY / AGENT_ZERO_API_KEY env.

import { writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

export const VENICE_MODELS_API = "https://api.venice.ai/api/v1/models";

// Compat overlays: knowledge the Venice API cannot express
// ID-list generation is fully API-driven, but
// per-FAMILY behavioral facts are hard-won empirical knowledge (verified
// against Venice docs + live sessions) and live here as CODE, matched by id
// prefix, not per-model entries. Each entry: { match: id includes this,
// overlay: { thinkingLevelMap?, compat? } } merged over the API mapping.
const FAMILY_OVERLAYS = [
  {
    // DeepSeek V4 family: built-in reasoning (the gateway accepts
    // reasoning_effort on these ids); thinkingLevelMap wires high/xhigh/max
    // and clamps lower levels up to high; assistant bridge required after tool
    // results, reasoning content must ride assistant messages, and no
    // developer role (all verified empirically).
    // off -> "none": probed against the live gateway — with the entry present
    // the request carries reasoning_effort:"none" and usage.reasoning
    // collapses to 0; without it pi's "off" sends no field and the model
    // thinks anyway, burning the classifier's budget before any text.
    match: "deepseek-v4",
    overlay: {
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: null,
        medium: null,
        high: "high",
        xhigh: "xhigh",
        max: "xhigh",
      },
      compat: {
        requiresAssistantAfterToolResult: true,
        requiresReasoningContentOnAssistantMessages: true,
        supportsReasoningEffort: true,
        requiresToolResultName: false,
        supportsDeveloperRole: false,
      },
    },
  },
  {
    // GLM 5.3 Flash via Venice: empirically probed (live agent-zero proxy
    // calls) — accepts none/low/medium/high AND max/xhigh beyond the catalog's
    // stale effort list; 'max' demonstrably scales reasoning depth. pi's xhigh
    // and max both map onto 'max' (the model's real top); minimal maps to
    // Venice's 'none'.
    // off -> "none" verified the same way as the deepseek family.
    match: "glm-5-3-flash",
    overlay: {
      thinkingLevelMap: {
        off: "none",
        minimal: "none",
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "max",
        max: "max",
      },
      compat: { supportsReasoningEffort: true },
    },
  },
  { match: "glm", overlay: { compat: { supportsReasoningEffort: true } } },
  { match: "gemma", overlay: { compat: { supportsReasoningEffort: true } } },
  {
    // Gemini family: built-in thinking, explicitly REJECTS reasoning_effort.
    match: "gemini",
    overlay: {
      compat: { supportsReasoningEffort: false, supportsDeveloperRole: false },
    },
  },
  {
    // Mercury-2: assistant bridge required after tool results (empirical).
    match: "mercury",
    overlay: { compat: { requiresAssistantAfterToolResult: true } },
  },
  {
    match: "uncensored",
    overlay: { compat: { supportsDeveloperRole: false } },
  },
  // Qwen base vs Qwen Coder (instruct-tuned, no dev role) — coder checked
  // before the generic qwen rule.
  { match: "coder", overlay: { compat: { supportsDeveloperRole: false } } },
  { match: "qwen", overlay: { compat: { supportsReasoningEffort: true } } },
];

/** Resolve the family overlay for a model id (pure, prefix-rule). */
export function resolveFamilyOverlay(id) {
  for (const rule of FAMILY_OVERLAYS) {
    if (typeof id === "string" && id.includes(rule.match)) return rule.overlay;
  }
  return undefined;
}

// Exact ids where the API advertises an effort "none" but the gateway was
// probed live to reject or ignore the explicit disable:
//   openai-gpt-52-codex -> HTTP 400 "Reasoning is mandatory ... cannot be disabled"
//   openai-gpt-53-codex -> disable ignored, still ~330 reasoning tokens
//   openai-gpt-54-pro   -> connection error in both states, unverifiable
//   e2ee-glm-5-2-p, e2ee-glm-5-3-p, e2ee-kimi-k3-p
//                       -> HTTP 400 "reasoning.max_tokens must be positive"
//   z-ai-glm-5-3-flash -> disable ignored, still ~2.2k reasoning tokens
// They keep the pre-existing behavior: pi's "off" sends no effort field.
const OFF_NONE_EXCLUDED = new Set([
  "openai-gpt-52-codex",
  "openai-gpt-53-codex",
  "openai-gpt-54-pro",
  "e2ee-glm-5-2-p",
  "e2ee-glm-5-3-p",
  "e2ee-kimi-k3-p",
  "z-ai-glm-5-3-flash",
]);

// Exact ids whose backend rejects the `developer` role pi-ai sends for
// reasoning models (probed live): HTTP 400 "System message must be
// at the beginning." for role `developer`, HTTP 200 for the same prompt under
// role `system`. compat.supportsDeveloperRole:false flips pi-ai to `system`.
// Per-id, not per-family: qwen3-5-9b, qwen3-5-35b-a3b and the qwen-3-8/3-7
// non-NL ids accept `developer`, so a family rule would be a false claim.
// qwen3-5-397b-a17b rejects intermittently (raw probe and pre-fix pi-path run
// 400'd, one pi-path run passed); the flag removes the failure mode either
// way. The e2ee qwen ids (e2ee-qwen3-6-35b-a3b, e2ee-qwen3-8-27b) reject too
// but already carry the flag through the supportsE2EE capability branch.
const DEVELOPER_ROLE_REJECTED = new Set([
  "qwen-3-8-27b",
  "qwen3-6-27b",
  "qwen3-6-35b-a3b",
  "qwen3-5-397b-a17b",
]);

/**
 * Map one raw Venice /models entry to the provider's model config shape
 * (ProviderModelConfig-compatible JSON). API truth in, no below-max limits;
 * family overlays add the compat knowledge the API cannot express.
 */
export function mapVeniceModel(raw, overlay = resolveFamilyOverlay(raw?.id)) {
  const spec = raw?.model_spec ?? {};
  const caps = spec.capabilities ?? {};
  const pricing = spec.pricing ?? {};

  const input = ["text"];
  if (caps.supportsVision || caps.supportsMultipleImages) input.push("image");

  // Name: short description wins; Venice's long-form marketing description
  // (1.6T-parameter … 1M-token …) falls back to the humanized id — never a
  // paragraph in the catalog.
  const desc = (spec.description || "").trim();
  const shortDesc = desc.split(". ")[0].trim();
  const name =
    shortDesc.length > 2 && shortDesc.length <= 80
      ? shortDesc
      : raw.id.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  const model = {
    id: raw.id,
    name,
    reasoning: !!caps.supportsReasoning,
    input,
  };
  // Generative extended-thinking map: when the API reports supported reasoning
  // efforts, derive thinkingLevelMap from them so pi's extended levels clamp
  // to the model's real max (e.g. GLM 5.3 Flash via Venice: none/low/medium/
  // high — xhigh clamps to high) instead of a raw unmapped effort Venice
  // rejects. Empirically-verified family overlays (applied later) keep
  // priority over this generative map.
  if (
    caps.supportsReasoningEffort === true &&
    Array.isArray(caps.reasoningEffortOptions) &&
    caps.reasoningEffortOptions.length > 0
  ) {
    // Canonical effort rank for clamping pi's levels onto the model's real
    // options (string comparison is meaningless here — "max" < "none" would
    // sort wrong). pi's extended levels clamp DOWN to the model's max.
    const RANK = {
      none: 0,
      minimal: 1,
      low: 2,
      medium: 3,
      high: 4,
      xhigh: 5,
      max: 6,
    };
    const opts = caps.reasoningEffortOptions
      .filter((e) => typeof e === "string" && e in RANK)
      .sort((a, b) => RANK[a] - RANK[b]);
    if (opts.length > 0) {
      const nearest = (target) => {
        if (opts.includes(target)) return target;
        const below = opts.filter((e) => RANK[e] <= RANK[target]);
        return below.length ? below[below.length - 1] : opts[0];
      };
      // pi's "off" only disables thinking when the request carries an explicit
      // disable value; the API listing "none" among the effort options is that
      // value. Families whose overlay declares reasoning_effort unsupported
      // (gemini: the gateway rejects it) get no entry — it would never reach
      // the wire.
      const offDisable =
        opts.includes("none") &&
        overlay?.compat?.supportsReasoningEffort !== false;
      // pi's `max` and `xhigh` are two canonical names for one top bucket;
      // emitting both keeps a pinned session's ceiling across a route switch
      // instead of leaning on the clamp's upward search to find the alias.
      model.thinkingLevelMap = {
        ...(offDisable ? { off: "none" } : {}),
        minimal: nearest("minimal"),
        low: nearest("low"),
        medium: nearest("medium"),
        high: nearest("high"),
        xhigh: nearest("xhigh"),
        max: nearest("max"),
      };
    }
  }
  if (raw.context_length != null) model.contextWindow = raw.context_length;
  if (spec.maxCompletionTokens != null)
    model.maxTokens = spec.maxCompletionTokens;

  const cost = {};
  if (pricing.input?.usd != null) cost.input = pricing.input.usd;
  if (pricing.output?.usd != null) cost.output = pricing.output.usd;
  if (pricing.cache_input?.usd != null)
    cost.cacheRead = pricing.cache_input.usd;
  // pi-ai's calculateCost dereferences model.cost.tiers unconditionally
  // (TypeError: reading 'tiers' of undefined when cost is absent) and
  // multiplies every rate field unconditionally (an absent rate yields NaN,
  // which propagates into usage.cost.total — models.js 0.84.4 and 0.85.1;
  // the native-provider registration path does not default a missing cost).
  // The catalog therefore always carries the complete numeric shape.
  // Venice publishes no cache-write price and may omit others: absent rates
  // fill with 0. Unpriced models show $0.00 in listings — cosmetics lose to
  // a working usage path.
  cost.input ??= 0;
  cost.output ??= 0;
  cost.cacheRead ??= 0;
  cost.cacheWrite = 0;
  model.cost = cost;

  // e2ee-flagged models refuse the developer role (API capability flag).
  const e2eeCompat =
    caps.supportsE2EE === true ? { supportsDeveloperRole: false } : undefined;
  // Probed developer-role rejection overrides the overlay (empirical beats
  // the family compat block).
  const developerRoleCompat = DEVELOPER_ROLE_REJECTED.has(model.id)
    ? { supportsDeveloperRole: false }
    : undefined;
  const { thinkingLevelMap: overlayMap, compat } = overlay ?? {};
  // Overlay (empirically verified) wins over the generative effort map.
  if (overlayMap) model.thinkingLevelMap = overlayMap;
  // An off entry is a claim that the gateway honors the disable value; strip
  // it from models probed to reject or ignore that value (OFF_NONE_EXCLUDED).
  if (model.thinkingLevelMap && OFF_NONE_EXCLUDED.has(model.id)) {
    const map = { ...model.thinkingLevelMap };
    delete map.off;
    model.thinkingLevelMap = map;
  }
  if (compat || e2eeCompat || developerRoleCompat) {
    model.compat = { ...compat, ...developerRoleCompat, ...e2eeCompat };
  }
  return model;
}

export function defaultCatalogPath() {
  return (
    process.env.VENICE_CATALOG_FILE ??
    join(homedir(), ".pi", "agent", "venice-models.json")
  );
}

async function main() {
  const baseUrl = process.env.VENICE_CATALOG_BASE_URL;
  if (!baseUrl || !baseUrl.startsWith("https://")) {
    console.error(
      "[generate-venice-catalog] VENICE_CATALOG_BASE_URL (https://…) is required — the private gateway URL must come from env, not the public repo.",
    );
    process.exit(1);
  }
  const apiKey = process.env.VENICE_API_KEY ?? process.env.AGENT_ZERO_API_KEY;
  const res = await fetch(VENICE_MODELS_API, {
    headers: apiKey ? { authorization: `Bearer ${apiKey}` } : {},
  });
  if (!res.ok) {
    console.error(
      `[generate-venice-catalog] GET ${VENICE_MODELS_API} -> HTTP ${res.status}`,
    );
    process.exit(1);
  }
  const data = await res.json();
  // NOTE: never pass mapVeniceModel directly to .map() — the index argument
  // would land in the overlay slot and silently drop family overlays.
  const models = (Array.isArray(data.data) ? data.data : []).map((raw) =>
    mapVeniceModel(raw),
  );
  const out = defaultCatalogPath();
  writeFileSync(out, JSON.stringify({ baseUrl, models }, null, 2) + "\n");
  chmodSync(out, 0o600);
  console.log(`[generate-venice-catalog] ${models.length} models -> ${out}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
