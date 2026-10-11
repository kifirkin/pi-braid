import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createProvider } from "@earendil-works/pi-ai";
// `Type` ships with pi-ai's own typebox re-export, so the tool schema adds no
// dependency to a package that resolves only @earendil-works/* from npm.
import { Type } from "@earendil-works/pi-ai";
import {
  completeSimple,
  openAICompletionsApi,
} from "@earendil-works/pi-ai/compat";
import type { Model, Provider } from "@earendil-works/pi-ai";
import {
  AGENT_ZERO_ID,
  BRAID_AUTO_ID,
  AGENT_ZERO_KEY_PREFIX,
  veniceKeyRing,
  registerRoute,
  clearRouteRegistry,
  installDefaultGatewayRoute,
  createRouteRing,
  registerCatalogRoute,
  handleBeforeProviderRequest,
  handleAfterProviderResponse,
  handleMessageEnd,
  publishKeyRingFeedback,
  resolveKeyRingAuth,
  resolveRingForMessage,
  reportKeyRingFailure,
  reportKeyRingSuccess,
  createRotationEngine,
  readProvidersSettingsFromSettings,
  emitProvidersSettingsDiagnostics,
  FAILBACK_PROBE_TIMEOUT_MS,
  ROTATION_WHISPER_TYPE,
  type MessageEndHooks,
  type RouteConfig,
  type RouteDeathVerdict,
  type RouteProbe,
  type RouteProbeVerdict,
  type RotationProbeDeps,
} from "./ring-lifecycle";
import {
  VENICE_DIRECT_ID,
  VENICE_DIRECT_KEY_PREFIX,
  VENICE_DIRECT_BASE_URL,
  veniceDirectKeyRing,
  directModelConfigs,
} from "./venice-direct";
import { loadVeniceCatalog } from "./venice-catalog.js";
import type { ChatModelConfig } from "./venice-catalog.js";
import { keyRingAuth, withKeyRingAuth } from "./ring-provider";
import { shrinkDoomedPayload, isPresendGuardEnabled } from "./presend-guard";
import { probeRoute } from "./probe.js";
import {
  formatRingHealth,
  routeHealth,
  summarizeRouteHealth,
} from "./ring-health.js";
import { readRouteState, recordDeath, recordProbe } from "./route-state.js";
import { registerAutoRouter, type RouteHealthSnapshot } from "./virtual-router";
import { providerLog, setProvidersLogSink } from "./log";
import {
  createOutageWatch,
  loadOutageConfig,
  withBreakerApi,
  withBreakerStreams,
  type OutageRouteTarget,
} from "./outage-watch";
// Public surface
// The probe and route-state modules stand on their own — re-export their APIs
// here so the extension's entry point is the single import site.
export { probeRoute, DEFAULT_PROBE_TIMEOUT_MS } from "./probe.js";
export type {
  ProbeDescriptor,
  ProbeDeps,
  ProbeFetch,
  ProbeFetchResponse,
  ProbeOutcome,
} from "./probe.js";
export {
  clearFailback,
  readRouteState,
  recordDeath,
  recordFailback,
  recordProbe,
  setWarmModels,
} from "./route-state.js";
export {
  claimNotify,
  classifyConnectivityFailure,
  createOutageWatch,
  DEFAULT_OUTAGE_CONFIG,
  formatOutageClock,
  httpReachable,
  loadOutageConfig,
  PROVIDER_OUTAGE_NOTIFY_KEY,
  readOutageNotifySender,
  releaseNotifyClaim,
  renderBlockedText,
  renderOwnerDownText,
  renderOwnerUpText,
  renderStallText,
  resolveOutageConfig,
  withBreakerApi,
  withBreakerStreams,
} from "./outage-watch";
export type {
  DownFacts,
  NotifyOutcome,
  OutageConfig,
  OutageRouteTarget,
  OutageWatchDeps,
  ProviderCallGuard,
  ProviderOutageNotifySender,
  ProviderOutageWatch,
  StallFacts,
} from "./outage-watch";
export type {
  RouteDeathRecord,
  RouteFailbackRecord,
  RouteProbeRecord,
  RouteState,
  RouteStateEntry,
} from "./route-state.js";
// The read-only health surface over the two state files above: a summary for a
// human or a consumer script, hash-only and never a second writer.
export {
  formatRingHealth,
  ringHealth,
  routeHealth,
  summarizeRouteHealth,
} from "./ring-health.js";
export type {
  DeathFreshness,
  RingEntrySummary,
  RingHealth,
  RingHealthEntry,
  RingHealthOptions,
  RingSummary,
  RouteHealth,
  RouteHealthOptions,
  RouteHealthSummary,
  RouteSummary,
} from "./ring-health.js";
export type { RouteProbe } from "./ring-lifecycle";
// The health-routed virtual model (`braid/auto`): its selection policy is pure and
// re-exported so a consumer script or a test can drive it without pi.
export {
  AUTO_MODEL_ID,
  CANONICAL_THINKING_LEVELS,
  buildRoute,
  registerAutoRouter,
  resolveThinkingLevel,
  routeDead,
  routeHealthy,
  routeServesModelId,
  routeSpent,
  selectAnyRoute,
  selectRetryRoute,
  selectRouteByHealth,
  supportedThinkingLevels,
} from "./virtual-router";
export type {
  AutoRouteState,
  AutoRouterDeps,
  CanonicalThinkingLevel,
  RetryOptions,
  RouteHealthEntry,
  RouteHealthSnapshot,
  RouteRingHealth,
  RouteSelection,
  RouterRequest,
  SelectOptions,
  ThinkingProfile,
} from "./virtual-router";

// Model Conversion
// The catalog's chat model config is missing `api`, `provider`, and `baseUrl`
// (required by Model<TApi>). createProvider fills `baseUrl` from its own field,
// but Model still requires it. We add the provider id and baseUrl here.

function toModels(
  providerId: string,
  baseUrl: string,
  configs: readonly ChatModelConfig[],
): Model<"openai-completions">[] {
  return configs.map((c) => ({
    id: c.id,
    name: c.name,
    api: (c.api ?? "openai-completions") as "openai-completions",
    provider: providerId,
    baseUrl: c.baseUrl ?? baseUrl,
    reasoning: c.reasoning,
    thinkingLevelMap: c.thinkingLevelMap,
    input: c.input,
    cost: c.cost,
    contextWindow: c.contextWindow,
    maxTokens: c.maxTokens,
    headers: c.headers,
    compat: c.compat as Model<"openai-completions">["compat"],
  }));
}

// The route table when settings carry no `routes` key: today's pair (the agent-zero
// gateway and the venice-direct route), in that order. A configured `routes`
// array supersedes it entirely.
const DEFAULT_ROUTES: readonly RouteConfig[] = [
  { provider: AGENT_ZERO_ID, keys: AGENT_ZERO_KEY_PREFIX },
  { provider: VENICE_DIRECT_ID, keys: VENICE_DIRECT_KEY_PREFIX },
];

// Provider id of the health-routed virtual entry (`opencode-go/auto`). Unlike
// the route ids this package owns, the
// provider definition is pi-ai's and this build re-points its auth at the
// route's ring, so the literal sits with the composition root's own table
// handling rather than in a route module: the entry exists only when
// `braid.providers.routes` names a provider pi-ai ships, and every physical
// model id the entry's collision check reads comes from that definition,
// never from this file.
const OPENCODE_GO_ID = "opencode-go";

// Key Ring Auth
// auth.apiKey.resolve is called by pi-ai's Models.getAuth() at request time,
// BEFORE before_provider_request fires. This is the correct interception point
// for dynamic key selection — the resolved key goes into the request's auth
// header, not the request body. keyRingAuth (and the re-pointing of a pi-ai
// provider definition onto a ring) lives in ring-provider.ts.

/**
 * pi-ai's provider catalog, resolved only when a route needs it. A route whose
 * provider this package does not build itself is served by pi-ai's own
 * definition, which the ring has to be re-pointed at (ring-provider.ts).
 * Importing the catalog pulls in every provider module, so the default pair —
 * which needs none of it — pays nothing for it.
 */
async function loadBuiltinProviderCatalog(): Promise<Map<string, Provider>> {
  const { builtinProviders } =
    await import("@earendil-works/pi-ai/providers/all");
  return new Map(builtinProviders().map((provider) => [provider.id, provider]));
}

// rotation glue
// The engine (state + walk + decision) lives in ring-lifecycle.ts; this glue
// binds it to pi-core mechanics: model lookup via the event ctx's
// modelRegistry, the session-only switch via ExtensionAPI.setModel (returns
// false when the model is unknown or auth is unconfigured → the walk skips the
// route), and the ONE whisper via ExtensionAPI.sendMessage (customType
// "provider-rotation", deliverAs nextTurn — non-waking, mirrors the
// watchdog-recovery family; providers cannot import core's sendTrackedMessage;
// the engine's one-shot flags guarantee exactly-once). The engine is created in
// the factory closure (one rotation episode per extension load; /reload re-runs
// the factory → fresh state) and reset on session_start so a fresh session
// re-probes from the top of the order. The fail-back probe rides the same
// seams at turn_end (buildRotationProbeDeps below).

/** message_end hooks: the engine's death entry point (key, shape and WAF-repeat classes). */
function rotationMessageEndHooks(
  engine: ReturnType<typeof createRotationEngine>,
  pi: ExtensionAPI,
  ctx: any,
): MessageEndHooks {
  return {
    rotation: {
      onRingExhausted: (providerId: string, errText: string, modelId: string) =>
        engine.maybeEngage(
          providerId,
          errText,
          modelId,
          rotationEngageDeps(pi, ctx),
        ),
      noteWafBlock: (providerId: string, modelId: string) =>
        engine.noteWafBlock(providerId, modelId),
    },
  };
}

/** The rotation whisper sink — the engine's ONE owner-visible message channel. */
function rotationWhisperSink(pi: ExtensionAPI): (text: string) => void {
  return (text: string) => {
    try {
      pi.sendMessage(
        {
          customType: ROTATION_WHISPER_TYPE,
          content: [{ type: "text", text }],
          display: true,
        },
        { deliverAs: "nextTurn" },
      );
    } catch {
      // The whisper channel must never break the LLM path.
    }
  };
}

/**
 * Session-model swap shared by the engage and the fail-back.
 * modelRegistry.find scopes by provider, so the same model id resolves per
 * route. Unknown model id → inert; a rejected setModel (rare: listener errors)
 * maps to the inert path too — a failed engage must degrade to today's
 * behavior, never surface as an unhandled extension error.
 */
function rotationSetModel(
  pi: ExtensionAPI,
  ctx: any,
): (provider: string, model: string) => Promise<boolean> {
  return async (provider: string, model: string) => {
    const modelObj = ctx?.modelRegistry?.find(provider, model);
    if (!modelObj) return false; // unknown model id → inert
    return pi.setModel(modelObj).catch(() => false);
  };
}

/** Engage deps for the engine, built from the event's own ctx. */
function rotationEngageDeps(pi: ExtensionAPI, ctx: any) {
  return {
    setModel: rotationSetModel(pi, ctx),
    notify: rotationWhisperSink(pi),
  };
}

// Fail-back probe glue (guard G1: one-way latch)
// The engine owns the decision and the cadence (ring-lifecycle.ts); this glue
// supplies the mechanics. The probe is ONE minimal completion on the PRIMARY
// route's model object (same Model the registry serves, same auth resolution
// as any direct LLM call), so success is meaningful: auth, quota and model
// availability all verified on the exact production path. Its outcome feeds
// the direct-call ring-feedback path (reportKeyRing*), so the key ring stays
// honest: success heals backoff, a key-rotation failure exhausts + persists
// (hash-only), a WAF/edge block leaves the key alone. The probe writes NO
// history, emits NO marker, and is bounded by the engine's interval + its own
// timeout — nothing else in the session sees it.
function buildRotationProbeDeps(pi: ExtensionAPI, ctx: any): RotationProbeDeps {
  // A one-word prompt capped at a tiny completion: the probe tests the
  // ROUTE, not the model — a length/aborted-capped stop proves it as well
  // as a full answer would.
  const PROBE_PROMPT = "ping";
  const PROBE_MAX_TOKENS = 16;
  return {
    probe: async (source: string, modelId: string): Promise<boolean> => {
      const modelObj = ctx?.modelRegistry?.find(source, modelId);
      if (!modelObj) return false; // primary model vanished from the registry
      const ring = resolveRingForMessage(source, modelId);
      const auth = ring ? resolveKeyRingAuth(source, ring) : undefined;
      try {
        const msg = await completeSimple(
          modelObj,
          {
            messages: [
              { role: "user", content: PROBE_PROMPT, timestamp: Date.now() },
            ],
          },
          {
            apiKey: auth?.auth.apiKey,
            maxTokens: PROBE_MAX_TOKENS,
            temperature: 0,
            maxRetries: 0, // single-shot: the probe's own interval is the retry budget
            signal: AbortSignal.timeout(FAILBACK_PROBE_TIMEOUT_MS),
          },
        );
        const errText =
          msg?.stopReason === "error" ? String(msg.errorMessage ?? "") : "";
        if (errText) {
          reportKeyRingFailure(modelId, source, errText);
          return false;
        }
        reportKeyRingSuccess(modelId, source);
        return true;
      } catch (err) {
        reportKeyRingFailure(
          modelId,
          source,
          err instanceof Error ? err.message : String(err),
        );
        return false;
      }
    },
    setModel: rotationSetModel(pi, ctx),
    notify: rotationWhisperSink(pi),
  };
}

// Virtual health router snapshot
// The ONE fs read behind `braid/auto`: the route store's facts joined with each
// route's ring summary, projected into the pure shape virtual-router.ts walks.
// A route whose ring file is absent reports `ring: null` (never exhausted), so
// the policy fails open exactly as the auxiliary path's `routeUsable` does. The
// route config supplies attribution (modelIds + models map); nothing here names
// a provider or a model.
function buildAutoRouteSnapshot(
  routes: readonly RouteConfig[],
): RouteHealthSnapshot {
  const routeState = readRouteState();
  const health = routeHealth({
    providers: routes.map((route) => route.provider),
    routeState,
  });
  const byProvider = new Map(health.map((h) => [h.provider, h] as const));
  return {
    routes: routes.map((route) => {
      const summary = byProvider.get(route.provider);
      const entry = routeState.routes[route.provider];
      const ring =
        summary && summary.ring.present
          ? {
              usable: summary.ring.entries.filter((e) => !e.exhausted).length,
              total: summary.ring.entries.length,
            }
          : null;
      return {
        provider: route.provider,
        ring,
        deathClass: entry?.deathClass ?? null,
        deathAt: entry?.deathAt ?? 0,
        deathModelId: entry?.deathModelId ?? null,
        modelIds: route.modelIds ?? [],
        models: route.models ?? {},
      };
    }),
  };
}

export default async function (pi: ExtensionAPI) {
  // Direct-call feed-back
  // Publish the ring-feedback handler into the process-global slot core's
  // callLlm and contrib's vision wrapper read, so a direct (non-message_end)
  // 429/403 exhausts + rotates the correct ring (see ring-lifecycle.ts). Done
  // at factory load so it is available before any session runs; the notify
  // sink is only bound at session_start, so pre-session warns stay silent
  // (consistent with existing providerLog behavior).
  publishKeyRingFeedback();

  // Read-only ring/route health tool
  // The durable answer to "how many keys has each ring got left, and when
  // does the exhausted one come back?" without opening the state files by
  // hand. Read-only by construction, in three layers: ring-health.ts reads and
  // never writes (no lock, no temp file, no migration), the handler adds no
  // probe, no rotation and no provider request, and the rendered text comes
  // from a summary that copies counts and timestamps only - a key hash has no
  // seat in the output, so it cannot leak into the session log. The death
  // marker is no second opinion either: the window is the resolved setting the
  // router is built with, and the age rule is the router's own predicate.
  pi.registerTool({
    name: "ring_health",
    label: "Ring health",
    promptSnippet: "Show key-ring and route health (read-only)",
    description:
      "Report the health of the LLM key rings and routes: per provider, the " +
      "ring revision, save time, active key index, usable/total key counts " +
      "and each key's exhausted/usable state with its exhaustion time and " +
      "retry count, plus the route's last recorded probe state, headroom, " +
      "remaining balance and reset time, and a recorded death with whether " +
      "the freshness window still makes it act, plus the configured route " +
      "order (preference), first to last. Counts and timestamps only - " +
      "never key material. Strictly read-only: no probe, no rotation, no " +
      "provider request, no write to any state file.",
    parameters: Type.Object({}),
    execute: async () => {
      const health = routeHealth();
      // The same resolved window the rotation engine's death gate walks with
      // (see registerAutoRouter below), so the surface and the gate agree.
      const freshness = { freshnessMs: providersSettings.probeFreshnessMs };
      // The order line states the configured route table - the array the
      // rotation engine is built from (array order IS the rotation order,
      // see registerAutoRouter below). The report's own order is a union of
      // route-state keys and ring files, which is not a preference order.
      const order = routes.map((route) => route.provider);
      return {
        content: [
          {
            type: "text" as const,
            text: formatRingHealth(health, freshness, order),
          },
        ],
        details: { routes: summarizeRouteHealth(health, freshness) },
      };
    },
  });

  // Register Providers via createProvider
  // createProvider builds a full Provider object with auth.apiKey.resolve that
  // runs at request time. pi.registerProvider(provider) routes through
  // registerNativeProvider, which uses the provider's auth resolution directly.
  // The key ring (veniceKeyRing) lives in ring-lifecycle.ts.

  // Venice (userland catalog seam)
  // The venice model catalog + gateway URL are owner-private and live in the
  // userland catalog file (see venice-catalog.ts). Without the file the
  // provider is not registered — the key-ring plumbing still attributes any
  // venice model ids that appear in events, which is all it needs.
  const veniceCatalog = loadVeniceCatalog();
  // Route registration is settings-driven. With no `routes` key, today's pair
  // is the default (byte-identical to a build without routes); a configured
  // array supersedes it, in array order.
  const providersSettings = readProvidersSettingsFromSettings();
  const routes: readonly RouteConfig[] = providersSettings.routesConfigured
    ? providersSettings.routes
    : DEFAULT_ROUTES;
  // The built-in gateway entry is a fallback, not a constant: with an explicit
  // route table the registration table is rebuilt from the configured routes
  // alone, so a route the table does not name is neither attributed nor rotated
  // to. Without one the fallback is (re)installed — the default pair's
  // behavior.
  if (providersSettings.routesConfigured) clearRouteRegistry();
  else installDefaultGatewayRoute();
  // A configured route opts into the Venice payload tweak through its own
  // descriptor; the default pair IS the Venice pair, so it keeps the tweak.
  const defaultVenicePayload = !providersSettings.routesConfigured;
  const catalogModelIds = (veniceCatalog?.models ?? []).map((m) => m.id);

  // A route whose provider is built from the Venice catalog (agent-zero, venice-direct)
  // registers its provider here. A route for any other provider is
  // served by pi-ai's own first-party definition, which stays resolvable
  // through pi's model registry (ctx.modelRegistry.find) — but that definition
  // resolves its key from a bare env var, a key source beside the ring. So the
  // definition is re-registered with its api-key auth re-pointed at the route's
  // ring (ring-provider.ts): one key source per route, and a spent key walks
  // the ring on the next request. Either way the route enters the registration
  // table with its keys prefix, its model ids (the catalog's own ids for the
  // Venice routes, plus the descriptor's) and its model map. Attribution and
  // the payload tweak follow the owning route's descriptor; no route is
  // recognized by a built-in model-id literal.
  //
  // The venice-direct route is registered whenever the catalog exists; without
  // a VENICE_API_KEY credential its auth resolver stays unconfigured and an
  // engage degrades to the one-shot inert notice.
  //
  // The pi-ai catalog is fetched only when a route actually needs it (a route
  // this package does not build itself); the default pair pays nothing for it.
  // A route pi-ai does not ship either is left exactly as it was: another
  // extension may own that provider, and this package has nothing to re-point.
  const needsBuiltinCatalog = routes.some(
    (route) =>
      route.provider !== AGENT_ZERO_ID && route.provider !== VENICE_DIRECT_ID,
  );
  const builtinCatalog = needsBuiltinCatalog
    ? await loadBuiltinProviderCatalog()
    : new Map<string, Provider>();

  // Outage watch
  // One watcher per extension load. Its targets are the configured routes'
  // own base URLs (a bounded reachability probe), read from the descriptors
  // this loop is about to register; no provider id or host literal lives in
  // the watcher. Load-time settings, read once like the route order itself:
  // braid.providers.outage. The watcher is out-of-loop (its timer does not
  // depend on a turn), which is what lets it alert the owner while a session
  // is held in a retry storm.
  const outageTargets: OutageRouteTarget[] = [];
  for (const route of routes) {
    if (route.provider === AGENT_ZERO_ID) {
      if (veniceCatalog)
        outageTargets.push({
          providerId: AGENT_ZERO_ID,
          url: veniceCatalog.baseUrl,
        });
      continue;
    }
    if (route.provider === VENICE_DIRECT_ID) {
      if (veniceCatalog)
        outageTargets.push({
          providerId: VENICE_DIRECT_ID,
          url: VENICE_DIRECT_BASE_URL,
        });
      continue;
    }
    const builtin = builtinCatalog.get(route.provider);
    outageTargets.push({ providerId: route.provider, url: builtin?.baseUrl });
  }
  const outage = createOutageWatch({
    targets: outageTargets,
    config: loadOutageConfig(),
  });

  // Diagnostics that need the notify sink, which only exists from the first
  // session_start (the same channel the settings and router diagnostics use).
  const ringProviderDiagnostics: string[] = [];

  // Probe collection: a route that declares a status capability is probed
  // once below, after registration. Routes without one are never probed.
  const probeJobs: Array<{
    providerId: string;
    descriptor: RouteProbe;
    ring: ReturnType<typeof createRouteRing>;
  }> = [];

  for (const route of routes) {
    if (route.provider === AGENT_ZERO_ID) {
      if (!veniceCatalog) continue; // no catalog ⇒ nothing to register (the fallback entry stands).
      pi.registerProvider(
        createProvider({
          id: AGENT_ZERO_ID,
          name: "Venice (agent-zero proxy)",
          baseUrl: veniceCatalog.baseUrl,
          auth: { apiKey: keyRingAuth("Venice API key", veniceKeyRing) },
          models: toModels(
            AGENT_ZERO_ID,
            veniceCatalog.baseUrl,
            veniceCatalog.models,
          ),
          api: withBreakerStreams(
            openAICompletionsApi(),
            outage.guard(AGENT_ZERO_ID),
          ),
        }),
      );
      registerCatalogRoute(
        route,
        catalogModelIds,
        veniceKeyRing,
        route.venicePayload ?? defaultVenicePayload,
      );
      if (route.probe) {
        probeJobs.push({
          providerId: route.provider,
          descriptor: route.probe,
          ring: veniceKeyRing,
        });
      }
      continue;
    }
    if (route.provider === VENICE_DIRECT_ID) {
      if (!veniceCatalog) continue;
      pi.registerProvider(
        createProvider({
          id: VENICE_DIRECT_ID,
          name: "Venice (direct)",
          baseUrl: VENICE_DIRECT_BASE_URL,
          auth: {
            apiKey: keyRingAuth("Venice API key", veniceDirectKeyRing),
          },
          models: toModels(
            VENICE_DIRECT_ID,
            VENICE_DIRECT_BASE_URL,
            directModelConfigs(veniceCatalog.models),
          ),
          api: withBreakerStreams(
            openAICompletionsApi(),
            outage.guard(VENICE_DIRECT_ID),
          ),
        }),
      );
      registerCatalogRoute(
        route,
        catalogModelIds,
        veniceDirectKeyRing,
        route.venicePayload ?? defaultVenicePayload,
      );
      if (route.probe) {
        probeJobs.push({
          providerId: route.provider,
          descriptor: route.probe,
          ring: veniceDirectKeyRing,
        });
      }
      continue;
    }
    const ring = createRouteRing(route);
    const builtin = builtinCatalog.get(route.provider);
    const ringProvider = builtin ? withKeyRingAuth(builtin, ring) : null;
    if (ringProvider) {
      pi.registerProvider(
        withBreakerApi(ringProvider, outage.guard(route.provider)),
      );
    } else if (builtin) {
      // The definition exists but carries no api-key auth to back with the ring
      // (an OAuth-only provider). Leaving it alone is correct — pi resolves its
      // OAuth credential — but a route the ring cannot serve is a fact the owner
      // should hear, because key exhaustion on it is not something rotation can
      // repair.
      ringProviderDiagnostics.push(
        `route "${route.provider}" keeps pi-ai's own auth: its provider ` +
          `definition has no api-key auth to back with the ring (prefix ` +
          `${route.keys})`,
      );
    }
    registerRoute({
      providerId: route.provider,
      keys: route.keys,
      modelIds: route.modelIds ?? [],
      models: route.models,
      probe: route.probe,
      venicePayload: route.venicePayload ?? defaultVenicePayload,
      ring,
    });
    if (route.probe) {
      probeJobs.push({
        providerId: route.provider,
        descriptor: route.probe,
        ring,
      });
    }
  }

  // Session-start probe (fire-and-forget)
  // ONE non-billable status read per route that declares a probe capability,
  // recorded so the next session inherits what this one observed. Deliberately
  // not awaited (registration must never block on the network) and never
  // fatal (probeRoute rejects on nothing). With no probe descriptors — the
  // default routes carry none — this loop body never runs and registration is
  // byte-identical to a build without the feature.
  for (const job of probeJobs) {
    const providerId = job.providerId;
    void probeRoute(providerId, job.descriptor, job.ring.getActiveKey())
      .then((outcome) => recordProbe(providerId, outcome))
      .catch(() => {
        // A probe is diagnostics; it must never surface as an unhandled
        // rejection or change the registration outcome.
      });
  }

  // Route-order rotation engine
  // Created AFTER registration completes: the walk consults the registration
  // table for each route's ring, model ids and model map, and the order is the
  // same routes array the registration loop just used (array order IS the
  // rotation order). One engine per extension load (/reload re-runs the
  // factory → fresh state); session_start resets it so a fresh session re-probes
  // the primary. In-memory only: no rotation state crosses sessions (the
  // session's own model_change entry persists the switch naturally).
  //
  // Probe steering and the route-death memory are handed in as DATA: this
  // closure resolves the recorded verdicts through readRouteState (the state
  // store's only reader) once per engage, so the engine stays provider-blind
  // and never touches the file, and it binds the store's own writer so a shape
  // rejection (a (route, request) fact, no key at fault) is persisted hash-free
  // and outlives the session. The freshness bound is settings, read at load
  // like the order itself.
  const engine = createRotationEngine({
    order: routes.map((route) => route.provider),
    probeFreshnessMs: providersSettings.probeFreshnessMs,
    probeStates: () => {
      const states = new Map<string, RouteProbeVerdict>();
      for (const [routeId, entry] of Object.entries(readRouteState().routes)) {
        if (entry.lastProbe) states.set(routeId, entry.lastProbe);
      }
      return states;
    },
    routeDeaths: () => {
      const deaths = new Map<string, RouteDeathVerdict>();
      for (const [routeId, entry] of Object.entries(readRouteState().routes)) {
        if (entry.deathClass === null) continue;
        deaths.set(routeId, {
          class: entry.deathClass,
          modelId: entry.deathModelId,
          status: entry.deathStatus,
          at: entry.deathAt,
        });
      }
      return deaths;
    },
    recordRouteDeath: (providerId, death) => recordDeath(providerId, death),
  });

  // Health-routed virtual model (`braid/auto`)
  // One selectable model that answers each request with the first healthy route
  // in the configured order, so the per-spawn route decision moves to the one
  // seam pi asks for it. The entry lives under the package's own `braid`
  // namespace because the auto route spans several providers (opencode-go, agent-zero,
  // venice-direct, openrouter); the gateway route keeps its `agent-zero` id
  // for itself. Registered only when this build actually carries the agent-zero route (its
  // catalog exists and the route table names it); the virtual model
  // definition itself carries no limits or input types, so pi reads the
  // physical model it routed to. The skip diagnostics are emitted at
  // session_start, where the notify sink exists.
  const virtualRouterDiagnostics: string[] = [];
  const agentZeroRoutePresent = routes.some(
    (route) => route.provider === AGENT_ZERO_ID,
  );
  if (veniceCatalog && agentZeroRoutePresent) {
    registerAutoRouter(pi, {
      provider: BRAID_AUTO_ID,
      // `braid` is a virtual-only namespace: this package registers no physical
      // model under it, so there is no physical list to consult and nothing
      // this entry could shadow. pi-core itself throws when a virtual id
      // collides with a physical model of the same provider at registration
      // time, so an existing `braid/auto` would fail loudly, never be hidden.
      hasPhysicalModel: () => false,
      readSnapshot: () => buildAutoRouteSnapshot(routes),
      logicalModelId: () => providersSettings.defaultModel,
      freshnessMs: providersSettings.probeFreshnessMs,
      log: (message) => virtualRouterDiagnostics.push(message),
    });
  }

  // Health-routed virtual model (`opencode-go/auto`)
  // The same router, a second seat: a session pinned to a concrete
  // opencode-go model has no failover path while that route keeps rejecting
  // its requests. The entry is registered under the route table's own id
  // and only when that table names the route; the collision check reads the
  // model list of the pi-ai definition this build re-points at the route's
  // ring, so a physical `auto` added upstream would win and this entry skips
  // itself with one diagnostic - the same rule the braid entry follows.
  const opencodeGoDefinition = builtinCatalog.get(OPENCODE_GO_ID);
  if (
    opencodeGoDefinition &&
    routes.some((route) => route.provider === OPENCODE_GO_ID)
  ) {
    const physicalModelIds = new Set(
      opencodeGoDefinition.getModels().map((m) => m.id),
    );
    registerAutoRouter(pi, {
      provider: OPENCODE_GO_ID,
      hasPhysicalModel: (modelId) => physicalModelIds.has(modelId),
      readSnapshot: () => buildAutoRouteSnapshot(routes),
      logicalModelId: () => providersSettings.defaultModel,
      freshnessMs: providersSettings.probeFreshnessMs,
      log: (message) => virtualRouterDiagnostics.push(message),
    });
  }

  // TUI notify sink (native pi-core pattern)
  // The factory's ExtensionAPI has no `ui`; the session_start handler is the
  // first context carrying ctx.ui.notify. In RPC/print/headless runs pi hands
  // notify a no-op, so these lines are inert there; cleared on shutdown so no
  // stale reference outlives the session. All provider diagnostics (key-ring
  // + ring-lifecycle warns) route through this sink — never console.* (see
  // log.ts).
  pi.on("session_start", (_event, _ctx) => {
    engine.reset();
    setProvidersLogSink(
      _ctx?.ui?.notify ? _ctx.ui.notify.bind(_ctx.ui) : undefined,
    );
    // Settings diagnostics need the notify sink, which only exists from here
    // (the reader runs before the first session_start). Throttled, so a
    // resumed session does not repeat them within the window.
    emitProvidersSettingsDiagnostics(
      readProvidersSettingsFromSettings().diagnostics,
    );
    for (const diagnostic of virtualRouterDiagnostics) {
      providerLog("warn", "providers/virtual-router", diagnostic);
    }
    for (const diagnostic of ringProviderDiagnostics) {
      providerLog("warn", "providers/ring-provider", diagnostic);
    }
  });
  pi.on("session_shutdown", (_event, _ctx) => {
    setProvidersLogSink(undefined);
  });

  // Event Wiring
  // All handler logic (including per-event key-ring attribution) lives in
  // ring-lifecycle.ts so it can be tested without loading pi-ai at runtime.

  /** Session identity for the outage watcher's stall spans; never throws. */
  function outageSessionKey(ctx: any): string {
    try {
      const file = ctx?.sessionManager?.getSessionFile?.();
      if (typeof file === "string" && file) return file;
    } catch {
      // A replaced session context can throw on access; cwd is the fallback.
    }
    return typeof ctx?.cwd === "string" && ctx.cwd ? ctx.cwd : "unknown";
  }

  // Model-id → catalog context window for the pre-send guard.
  // Built once at factory load from the catalog this package owns (venice-catalog.ts).
  const presendContextWindows = new Map<string, number>();
  for (const m of veniceCatalog?.models ?? []) {
    if (typeof m.contextWindow === "number" && m.contextWindow > 0) {
      presendContextWindows.set(m.id, m.contextWindow);
    }
  }

  pi.on("before_provider_request", async (event: any) => {
    // Ring-lifecycle first (WAF/key shaping), then the pre-send guard on
    // the (possibly reshaped) payload. The guard no-ops unless the payload is
    // DOOMED for a KNOWN model; its returned payload (when present) replaces
    // the outgoing body per pi-core's emitBeforeProviderRequest semantics.
    const shaped = handleBeforeProviderRequest(event.payload);
    const outgoing = shaped ?? event.payload;
    try {
      if (!isPresendGuardEnabled()) return shaped;
      const guard = shrinkDoomedPayload(outgoing, {
        resolveContextWindow: (modelId) => presendContextWindows.get(modelId),
      });
      return guard?.payload ?? shaped;
    } catch {
      // The guard must never break the send path.
      return shaped;
    }
  });

  pi.on("after_provider_response", async (event: any) =>
    handleAfterProviderResponse(event),
  );

  pi.on("message_end", async (event: any, ctx: any) => {
    // Order matters: the outage feed reads the ORIGINAL error text (a
    // ring-lifecycle replacement can rewrite it), and a watcher fault must
    // never break the key-ring path it sits beside.
    try {
      outage.observe(event?.message, outageSessionKey(ctx));
    } catch {
      // The feed is observability; the ring path below owns the event.
    }
    return handleMessageEnd(event, rotationMessageEndHooks(engine, pi, ctx));
  });

  // Fail-back at the turn boundary (guard G1)
  // The ONLY trigger the fail-back uses: no background timer, no per-request
  // hook. While a rotation episode is active, each settled turn gives the
  // engine one chance to probe the primary (interval-bounded inside the
  // engine); an inert engine (no engage this session) returns null before
  // touching anything, so sessions that never rotate are byte-identical to a
  // build without the feature.
  pi.on("turn_end", async (_event: unknown, ctx: any) => {
    try {
      await engine.maybeFailBack(buildRotationProbeDeps(pi, ctx));
    } catch {
      // A probe failure must never break the turn boundary.
    }
  });
}
