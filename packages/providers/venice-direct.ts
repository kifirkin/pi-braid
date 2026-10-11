/**
 * Direct-Venice route.
 *
 * The `agent-zero` provider serves Venice's models through the owner's agent-zero gateway
 * (baseUrl from the userland catalog, keys from the AGENT_ZERO_API_KEY ring).
 * The same models are also reachable through a second, independent route:
 * Venice's own API (https://api.venice.ai/api/v1) with the owner's direct
 * VENICE_API_KEY. This module contributes that route's constants, its key ring
 * and its model configs; index.ts registers the provider, and the route table
 * decides the rotation order.
 *
 * Layering: constants, key ring and model configs live here — no pi-ai import,
 * so the module compiles and unit-tests like ring-lifecycle.ts (CJS, no
 * runtime pi-ai). index.ts binds the route to pi-core mechanics.
 *
 * Secret discipline: the direct ring reuses createKeyRing verbatim — keys are
 * identified by hash only, in logs and in its own persisted state file.
 * Nothing here ever logs, whispers or throws key material.
 */

import type { ChatModelConfig } from "./venice-catalog";

import { createKeyRing } from "./key-ring";

/** Registered provider id for the direct route. */
export const VENICE_DIRECT_ID = "venice-direct";

/** Env prefix of the direct route's credential namespace (a route's `keys`). */
export const VENICE_DIRECT_KEY_PREFIX = "VENICE_API_KEY";

/** Venice's own API base — independent of the agent-zero gateway baseUrl. */
export const VENICE_DIRECT_BASE_URL = "https://api.venice.ai/api/v1";

/**
 * Key ring for the direct route. Same mechanism, different credential
 * namespace: scans VENICE_API_KEY_P0..P9 with fallback to VENICE_API_KEY, and
 * persists exhausted-key state (hash-only) to its own state file — the
 * gateway ring's AGENT_ZERO_API_KEY prefix and persistence are untouched.
 * No warnBelowKeyCount: the direct route is optional; a missing or
 * single direct key must stay silent, not warn.
 */
export const veniceDirectKeyRing = createKeyRing({
  prefix: VENICE_DIRECT_KEY_PREFIX,
  stateFile: "venice-direct",
});

/**
 * Model configs for the direct route, derived from the userland catalog (the
 * same data source the gateway provider uses). Gateway model ids and Venice's
 * own ids are identical — the gateway proxies Venice — so no mapping table is
 * needed. Per-model `baseUrl` overrides are stripped so the provider's
 * direct base URL applies to every model (a catalog entry pinning the gateway
 * URL would otherwise leak into this route).
 */
export function directModelConfigs(
  models: readonly ChatModelConfig[],
): ChatModelConfig[] {
  return models.map((m) => ({ ...m, baseUrl: undefined }));
}
