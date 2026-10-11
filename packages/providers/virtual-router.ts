/**
 * `braid/auto`: one selectable model whose router reads braid's existing health
 * surface and answers each request with a physical model and a thinking level.
 *
 * Why a virtual model: without one, the per-spawn route decision (which
 * provider this turn runs on) is made by hand against the same ring/route
 * state this package persists. A virtual model moves that decision to the
 * one place pi asks for it — a `ModelRouteRequest` — so the route order, the
 * ring health and the recorded route deaths decide per request instead of
 * per spawn.
 *
 * Placement: the selection policy (order, ring, death, level) lives here as
 * pure functions over an injected `RouteHealthSnapshot`; this module reads no
 * file, owns no state and names no provider. The composition root (index.ts)
 * builds the snapshot from the readers this package already ships
 * (`readRouteState`, `routeHealth`) and hands it over as data, so the policy is
 * testable offline and the I/O stays in one place. Provider ids, the route
 * table and the logical base model all arrive through `AutoRouterDeps`.
 *
 * Three invariants the policy enforces:
 *  - The logical base model id is never the virtual model's own id: a request
 *    with no previous physical model resolves its base through
 *    `resolveLogicalBaseModelId`, which derives one from the route table.
 *  - A route is picked only when its ring reports a usable key AND its recorded
 *    route state is not a fresh death. A route whose ring state file is absent
 *    has never recorded an exhaustion, so it fails open (matching the auxiliary
 *    path's `routeUsable`).
 *  - The thinking level is resolved against the TARGET model's own
 *    `thinkingLevelMap`, never by comparing the mapped provider strings. pi's
 *    two canonical names for the top bucket (`xhigh`, `max`) are treated as one
 *    bucket, so a pinned ceiling survives a route switch onto a model that
 *    spells that bucket with the other name.
 *
 * @module
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { Api, Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

// Thinking levels

/**
 * pi's extended level ladder, lowest effort first. The order IS the capability
 * order: a level's index is its effort rank.
 */
export const CANONICAL_THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type CanonicalThinkingLevel = (typeof CANONICAL_THINKING_LEVELS)[number];

/** pi's two canonical names for the top effort bucket. */
const TOP_LEVELS: readonly CanonicalThinkingLevel[] = ["xhigh", "max"];

/**
 * The subset of a `Model` the level resolver reads. Stated structurally so the
 * resolver is testable without a registry or pi-ai at runtime.
 */
export interface ThinkingProfile {
  reasoning?: boolean;
  thinkingLevelMap?: Partial<
    Record<CanonicalThinkingLevel, string | null>
  > | null;
}

/**
 * The levels a target model can accept, using pi's own support rule
 * (`getSupportedThinkingLevels`): a non-reasoning model offers `off` alone; a
 * level mapped to `null` is unsupported; `xhigh`/`max` are unsupported unless
 * the map names them explicitly (they sit beyond most catalogs' declared
 * range, so silence is not a claim).
 */
export function supportedThinkingLevels(
  profile: ThinkingProfile | undefined,
): CanonicalThinkingLevel[] {
  if (!profile?.reasoning) return ["off"];
  const map = profile.thinkingLevelMap ?? null;
  return CANONICAL_THINKING_LEVELS.filter((level) => {
    const mapped = map ? map[level] : undefined;
    if (mapped === null) return false;
    if (level === "xhigh" || level === "max") return mapped !== undefined;
    return true;
  });
}

/**
 * Resolve one requested level against one target model.
 *
 * Order of decisions:
 *   1. the model supports the requested level — take it;
 *   2. the request is a top name (`xhigh`/`max`) and the model declares the
 *      other top name — take that: they are pi's two spellings of one bucket,
 *      so a pinned ceiling does not drop to `high` on a route switch;
 *   3. otherwise the highest level the model supports AT OR BELOW the request,
 *      which keeps the switch from raising effort the caller did not ask for;
 *   4. otherwise the lowest level the model supports above the request (a model
 *      whose floor is above the request still has to answer);
 *   5. otherwise `off`.
 * An unknown level name (never produced by pi) falls to the model's floor.
 */
export function resolveThinkingLevel(
  profile: ThinkingProfile | undefined,
  requested: string,
): ModelThinkingLevel {
  const supported = supportedThinkingLevels(profile);
  const wanted = requested as CanonicalThinkingLevel;
  if (supported.includes(wanted)) return wanted;
  const requestedIndex = CANONICAL_THINKING_LEVELS.indexOf(wanted);
  if (requestedIndex === -1) return supported[0] ?? "off";
  if (TOP_LEVELS.includes(wanted)) {
    const other = wanted === "xhigh" ? "max" : "xhigh";
    if (supported.includes(other)) return other;
  }
  for (let i = requestedIndex; i >= 0; i--) {
    if (supported.includes(CANONICAL_THINKING_LEVELS[i])) {
      return CANONICAL_THINKING_LEVELS[i];
    }
  }
  for (let i = requestedIndex + 1; i < CANONICAL_THINKING_LEVELS.length; i++) {
    if (supported.includes(CANONICAL_THINKING_LEVELS[i])) {
      return CANONICAL_THINKING_LEVELS[i];
    }
  }
  return supported[0] ?? "off";
}

// Health snapshot

/** A ring's persisted counts, or null when no state file exists (fail-open). */
export interface RouteRingHealth {
  usable: number;
  total: number;
}

/** One route as the policy sees it: identity, ring counts and route state. */
export interface RouteHealthEntry {
  provider: string;
  /** `null` ⇒ no ring state file: the route has recorded no exhaustion. */
  ring: RouteRingHealth | null;
  deathClass: string | null;
  deathAt: number;
  /** Model id of a request-scoped death; null when the death was not one. */
  deathModelId: string | null;
  /** Extra ids the route serves; the `models` map's keys and values count too. */
  modelIds: readonly string[];
  /** Dead-model-id → this route's own model id. */
  models: Readonly<Record<string, string>>;
}

/** The routes the policy walks, in the configured order (order IS preference). */
export interface RouteHealthSnapshot {
  routes: readonly RouteHealthEntry[];
}

export interface RouteHealthOptions {
  now?: number;
  /** How long a recorded death stays actionable; `<= 0` ignores deaths. */
  freshnessMs?: number;
  /** The model id the death must name to apply, when the death is scoped. */
  modelId?: string | null;
}

/** Whether a route's ring reports no usable key (an absent ring never does). */
export function routeSpent(entry: RouteHealthEntry): boolean {
  return entry.ring !== null && entry.ring.usable <= 0;
}

/**
 * Whether a recorded death still describes its route: a recorded class, a
 * recorded time, a live bound, and an age INSIDE that bound (a death exactly at
 * the bound is out). `freshnessMs <= 0` is the shared off switch (no recorded
 * death acts) and an untimed death (`deathAt <= 0`, the state files' absence)
 * is never in force. Exported because the health renderer (ring-health.ts)
 * marks a route's death with this same rule rather than re-deriving it: a
 * surface and a gate that disagree about which deaths act is the failure this
 * predicate exists to rule out.
 */
export function deathInForce(
  deathClass: string | null,
  deathAt: number,
  options: RouteHealthOptions = {},
): boolean {
  if (deathClass === null || deathAt <= 0) return false;
  const freshnessMs = options.freshnessMs ?? 0;
  if (freshnessMs <= 0) return false;
  const now = options.now ?? Date.now();
  return now - deathAt < freshnessMs;
}

/**
 * Whether a route carries a death that still describes it: in force by
 * `deathInForce`, and, when the death named a model, about the model in hand.
 * `freshnessMs <= 0` is the shared off switch.
 */
export function routeDead(
  entry: RouteHealthEntry,
  options: RouteHealthOptions = {},
): boolean {
  if (!deathInForce(entry.deathClass, entry.deathAt, options)) return false;
  if (
    entry.deathModelId &&
    options.modelId &&
    entry.deathModelId !== options.modelId
  ) {
    return false;
  }
  return true;
}

/** A route the policy will dispatch on: usable key and no fresh death. */
export function routeHealthy(
  entry: RouteHealthEntry,
  options: RouteHealthOptions = {},
): boolean {
  return !routeSpent(entry) && !routeDead(entry, options);
}

/**
 * Whether a route serves a model id, mirroring ring-lifecycle's attribution:
 * an explicitly listed id, a `models` map key (a dead id it can translate) or a
 * `models` map value (the id it served after a redirect).
 */
export function routeServesModelId(
  entry: RouteHealthEntry,
  modelId: string,
): boolean {
  if (!modelId) return false;
  if (entry.modelIds.includes(modelId)) return true;
  return (
    Object.hasOwn(entry.models, modelId) ||
    Object.values(entry.models).includes(modelId)
  );
}

/**
 * The id to dispatch on this route for a logical model id, or null when the
 * route does not serve it. A `models` map translates a shared (dead) id to this
 * route's own id; a route that natively owns the id serves it unchanged.
 */
export function resolveRouteModelId(
  entry: RouteHealthEntry,
  logicalModelId: string | null,
): string | null {
  if (!logicalModelId) return null;
  if (Object.hasOwn(entry.models, logicalModelId)) {
    return entry.models[logicalModelId];
  }
  if (routeServesModelId(entry, logicalModelId)) return logicalModelId;
  return null;
}

/** What the policy picked: the route and the exact id to dispatch on it. */
export interface RouteSelection {
  provider: string;
  modelId: string;
}

export interface SelectOptions extends RouteHealthOptions {
  logicalModelId: string | null;
  /**
   * Registry probe for the (provider, model) pair. Absent ⇒ structural
   * selection only (tests, or a caller with no registry).
   */
  canResolve?: (provider: string, modelId: string) => boolean;
}

function resolvable(
  entry: RouteHealthEntry,
  modelId: string,
  canResolve?: SelectOptions["canResolve"],
): boolean {
  return !canResolve || canResolve(entry.provider, modelId);
}

/**
 * The first route, in configured order, whose ring reports a usable key, whose
 * route state is not a fresh death, and that can serve the logical model id.
 * Null when no route qualifies — the caller decides the last-resort behavior.
 */
export function selectRouteByHealth(
  snapshot: RouteHealthSnapshot,
  options: SelectOptions,
): RouteSelection | null {
  for (const entry of snapshot.routes) {
    const modelId = resolveRouteModelId(entry, options.logicalModelId);
    if (!modelId) continue;
    // The death is scoped by the id this route would be asked for: a route that
    // translates the logical id records the death under the translated id.
    if (!routeHealthy(entry, { ...options, modelId })) continue;
    if (!resolvable(entry, modelId, options.canResolve)) continue;
    return { provider: entry.provider, modelId };
  }
  return null;
}

/**
 * The first route that can resolve the logical model id at all, ignoring health.
 * The last resort when every route reports spent/dead: a dispatch somewhere is
 * more truthful than refusing to route, and the failure then names the real
 * condition instead of the router.
 */
export function selectAnyRoute(
  snapshot: RouteHealthSnapshot,
  options: SelectOptions,
): RouteSelection | null {
  for (const entry of snapshot.routes) {
    const modelId =
      resolveRouteModelId(entry, options.logicalModelId) ??
      options.logicalModelId;
    if (!modelId) continue;
    if (!resolvable(entry, modelId, options.canResolve)) continue;
    return { provider: entry.provider, modelId };
  }
  return null;
}

export interface RetryOptions extends SelectOptions {
  failedProvider: string | null;
  failedModelId: string;
}

/**
 * Retry selection: stay put unless the failed model's route is now spent or
 * dead. When it is, pick the first HEALTHY route (never the failed one) that can
 * serve the failed model id — the same id, translated through that route's
 * `models` map. Null means "stay on the failed model": either its route is
 * healthy again, or no other route can serve it, or the route is unknown.
 */
export function selectRetryRoute(
  snapshot: RouteHealthSnapshot,
  options: RetryOptions,
): RouteSelection | null {
  const failed =
    snapshot.routes.find((r) => r.provider === options.failedProvider) ??
    snapshot.routes.find((r) => routeServesModelId(r, options.failedModelId)) ??
    null;
  if (!failed) return null; // unknown route: nothing observed says move
  if (routeHealthy(failed, { ...options, modelId: options.failedModelId })) {
    return null;
  }
  for (const entry of snapshot.routes) {
    if (entry.provider === failed.provider) continue;
    const modelId = resolveRouteModelId(entry, options.failedModelId);
    if (!modelId) continue;
    if (!routeHealthy(entry, { ...options, modelId: options.failedModelId })) {
      continue;
    }
    if (!resolvable(entry, modelId, options.canResolve)) continue;
    return { provider: entry.provider, modelId };
  }
  return null;
}

// Registration

/** Model id of the virtual entry. Also the collision key checked at load. */
export const AUTO_MODEL_ID = "auto";

/** How long a health snapshot is reused before the next request re-reads it. */
export const HEALTH_CACHE_MS = 5_000;

/**
 * The logical model id a request with no previous physical model is asking for.
 *
 * A configured id is taken as it stands, with ONE exception: the virtual
 * model's own id. `auto` names this router, not a model any route can
 * dispatch, so using it as the base makes every route fail to translate it and
 * leaves the request on the virtual model itself (pi: "routed to
 * <provider>/auto, which is not a physical model"). The base is then derived
 * from the route table rather than hardcoded: the candidates are each route's
 * declared `modelIds` and `models` map keys, in table order, and the winner is
 * the id the most routes serve (ties: first appearance), so the base stays
 * dispatchable after a rotation. A route that declares one id twice serves it
 * once. Null when the table carries no id at all - the caller's last resort is
 * the request's own model.
 */
export function resolveLogicalBaseModelId(
  configured: string | null | undefined,
  snapshot: RouteHealthSnapshot,
): string | null {
  if (configured && configured !== AUTO_MODEL_ID) return configured;
  const coverage = new Map<string, number>();
  for (const entry of snapshot.routes) {
    const seenHere = new Set<string>();
    for (const id of [...entry.modelIds, ...Object.keys(entry.models)]) {
      if (!id || seenHere.has(id)) continue;
      seenHere.add(id);
      coverage.set(id, (coverage.get(id) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestCount = 0;
  for (const [id, count] of coverage) {
    if (count > bestCount) {
      best = id;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The router's JSON-serializable session state: the route it last chose and
 * why. Stored on the session branch by pi, so a resumed session can be read
 * back; the policy itself never depends on it (every request re-derives from
 * the live snapshot), which keeps a stale state a description, not a decision.
 */
export interface AutoRouteState {
  route: string;
  model: string;
  why: string;
}

/**
 * Everything the glue needs from the composition root. No provider id, no file
 * path and no model id is hardcoded here: all arrive as data.
 */
export interface AutoRouterDeps {
  /**
   * Provider the virtual model is listed under. It may carry physical models
   * and credentials, or be a virtual-only namespace (pi marks the latter
   * configured, so the entry lists without a credential of its own).
   */
  provider: string;
  /** Whether a physical model of this provider already owns the virtual id. */
  hasPhysicalModel: (modelId: string) => boolean;
  /** Build the health snapshot; the root binds the readers (fs I/O lives there). */
  readSnapshot: () => RouteHealthSnapshot;
  /** The logical base model id for a request with no previous physical model,
   *  as configured (settings `defaultModel`). Normalized by
   *  `resolveLogicalBaseModelId` before use: the virtual id is never a base. */
  logicalModelId: () => string | null;
  /** How long a recorded route death stays actionable (settings knob). */
  freshnessMs: number;
  /** Reuse window for the snapshot; `<= 0` disables caching. */
  cacheTtlMs?: number;
  now?: () => number;
  /** One warn line when registration is skipped (the root routes it to the sink). */
  log?: (message: string) => void;
}

/**
 * The request fields the router reads. Structural so the policy is testable
 * without pi-ai's `ModelRouteRequest` at runtime.
 */
export interface RouterRequest {
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  reason: string;
  previous?:
    | { model: Model<Api>; thinkingLevel?: ModelThinkingLevel }
    | undefined;
  failed?:
    | { model: Model<Api>; thinkingLevel?: ModelThinkingLevel }
    | undefined;
  state?: unknown;
}

/** The thinking level to resolve: the failed request's own level for a retry. */
export function requestedLevel(request: RouterRequest): ModelThinkingLevel {
  return request.failed?.thinkingLevel ?? request.thinkingLevel;
}

/**
 * Turn the chosen physical model into pi's `ModelRoute`: the registry's own
 * object is returned when one was found (so pi reads the target's real limits
 * and input types), the level is resolved against that same object, and the
 * session state is reported only when the choice changed. When nothing physical
 * is resolvable the request's own model is returned, which ends the request
 * with an honest routing failure instead of a throw.
 */
export function buildRoute(
  request: RouterRequest,
  model: Model<Api> | undefined,
  why: string,
): {
  model: Model<Api>;
  thinkingLevel: ModelThinkingLevel;
  state?: AutoRouteState;
} {
  const resolved =
    model ?? request.previous?.model ?? request.failed?.model ?? request.model;
  const thinkingLevel = resolveThinkingLevel(resolved, requestedLevel(request));
  const state: AutoRouteState = {
    route: resolved.provider,
    model: resolved.id,
    why,
  };
  const previousState = request.state as AutoRouteState | undefined;
  if (
    previousState &&
    previousState.route === state.route &&
    previousState.model === state.model &&
    previousState.why === state.why
  ) {
    return { model: resolved, thinkingLevel };
  }
  return { model: resolved, thinkingLevel, state };
}

/**
 * Register the `auto` virtual model on `pi` and wire the route function to the
 * injected readers. Registration is skipped — with ONE log line — when the
 * provider already ships a physical model under the virtual id, because a
 * virtual entry would hide it and a later catalog refresh could make the two
 * collide under pi's feet. Skipping is deliberate: the physical model is the
 * truth, and this router must never shadow it.
 */
export function registerAutoRouter(
  pi: ExtensionAPI,
  deps: AutoRouterDeps,
): void {
  if (deps.hasPhysicalModel(AUTO_MODEL_ID)) {
    deps.log?.(
      `[pi-braid-providers] a physical model already uses id "${AUTO_MODEL_ID}" ` +
        `for provider "${deps.provider}"; the virtual health router is not registered`,
    );
    return;
  }
  const now = deps.now ?? Date.now;
  const cacheTtlMs = deps.cacheTtlMs ?? HEALTH_CACHE_MS;
  let cache: { at: number; snapshot: RouteHealthSnapshot } | null = null;
  const readSnapshot = (fresh: boolean): RouteHealthSnapshot => {
    const at = now();
    if (!fresh && cacheTtlMs > 0 && cache && at - cache.at < cacheTtlMs) {
      return cache.snapshot;
    }
    const snapshot = deps.readSnapshot();
    cache = { at, snapshot };
    return snapshot;
  };

  pi.registerVirtualModel<AutoRouteState>({
    provider: deps.provider,
    id: AUTO_MODEL_ID,
    name: "Auto (health-routed)",
    thinkingLevels: [...CANONICAL_THINKING_LEVELS],
    // contextWindow/maxTokens/input are deliberately unset: pi then uses the
    // limits and input types of the physical model that answered this request.
    // Declaring them here would risk advertising a capability the target route
    // lacks, which is exactly what a route switch must never do.
    route: (request: RouterRequest, ctx: ExtensionContext) => {
      const at = now();
      try {
        const canResolve = (provider: string, modelId: string): boolean =>
          !!ctx?.modelRegistry?.find(provider, modelId);
        const findModel = (selection: RouteSelection): Model<Api> | undefined =>
          ctx?.modelRegistry?.find(selection.provider, selection.modelId) ??
          undefined;
        // A retry must see the death the failed request just recorded, so it
        // bypasses the reuse window; every other reason may reuse it.
        const snapshot = readSnapshot(request.reason === "retry");
        // The logical model the user is asking for: the physical model the
        // session was on, else the configured base id, normalized so the
        // router never translates its own id (a route cannot serve `auto`).
        const logicalModelId =
          request.previous?.model.id ??
          resolveLogicalBaseModelId(deps.logicalModelId(), snapshot);
        const base: SelectOptions = {
          logicalModelId,
          now: at,
          freshnessMs: deps.freshnessMs,
          canResolve,
        };

        if (request.reason === "retry" && request.failed) {
          const failed = request.failed.model;
          const moved = selectRetryRoute(snapshot, {
            ...base,
            failedProvider: failed?.provider ?? null,
            failedModelId: failed?.id ?? "",
          });
          if (moved) {
            return buildRoute(request, findModel(moved), "retry-moved");
          }
          return buildRoute(request, failed, "retry-stayed");
        }

        if (request.reason === "continuation" && request.previous) {
          // Tool follow-ups and steering stay on the physical model that
          // answered last: a mid-turn switch would split one turn across two
          // models and re-send the transcript to a cold cache.
          return buildRoute(request, request.previous.model, "continuation");
        }

        const picked = selectRouteByHealth(snapshot, base);
        if (picked) {
          return buildRoute(
            request,
            findModel(picked),
            request.reason === "user" ? "user-health" : "direct-health",
          );
        }
        const anyRoute = selectAnyRoute(snapshot, base);
        if (anyRoute) {
          return buildRoute(request, findModel(anyRoute), "fallback-unhealthy");
        }
      } catch {
        // Routing must never end a request by throwing; fall through to the
        // best physical model the request itself carries.
      }
      return buildRoute(request, undefined, "passthrough");
    },
  });
}
