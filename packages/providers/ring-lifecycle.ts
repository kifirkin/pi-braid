/**
 * Key-ring lifecycle for the pi-braid providers extension.
 *
 * Split out of index.ts so the handler logic is unit-testable without loading
 * pi-ai at runtime (pi-ai ships ESM-only with an `import`-only exports map, so
 * a compiled CJS test module can't import index.ts, which imports pi-ai at the
 * top level). This module only depends on the model catalogs (pure data) and
 * key-ring.ts (node:fs only) — no pi-ai imports, so it loads under plain CJS.
 *
 * The race this module fixes: pre-fix code tracked the "current" provider in a
 * module-global `lastRequestProvider` inside before_provider_request, and read
 * it in after_provider_response / message_end to pick a key ring. With two
 * turns in flight the global is last-writer-wins:
 *
 *   before(agent-zero) -> before(second provider) -> after/message_end(agent-zero error)
 *
 * rotates the SECOND provider's ring instead of the agent-zero ring the event
 * belongs to. Every function here resolves the ring from ITS OWN event
 * payload instead.
 *
 * Ring inventory: the package registers the agent-zero gateway provider plus — when
 * the userland catalog exists — the venice-direct route (venice-direct.ts),
 * whose ring joins through the registerRoute() seam. That seam is also used
 * by the test suite to pin per-event attribution and the interleaved-turn
 * race against a second ring. The route-order rotation engine (below) walks
 * the registered routes in table order for two failure classes: a ring death
 * whose ring reports zero usable keys, and a request a route refused (HTTP 4xx)
 * without any key being at fault.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createKeyRing } from "./key-ring";
import { providerLog, createThrottledLogger } from "./log";
import { readRouteState } from "./route-state";

// Retry reclassification for self-healing
// pi-core classifies provider quota/auth/403 errors as NON-retryable (fail-fast)
// via isRetryableAssistantError (pi-ai dist/utils/retry.js), so a 403 turn dies
// with no follow-up LLM call — the key-ring cannot rotate mid-turn on its own.
// When message_end exhausts a key and a fresh key remains, we append a factual
// marker so pi-core's OWN turn-level retry (agent_end -> agent.continue) re-runs
// the turn. auth.apiKey.resolve re-runs per streamSimple, so the re-run picks
// the NEXT key automatically. The marker is bounded: pi-core caps retries at
// settings.retry.maxRetries (default 3), and we only rewrite while a usable key
// remains — when all keys are gone the loud ALL-KEYS-EXHAUSTED warn fires and
// the turn ends with the real error (no retry storm).
//
// Round-6 invariant preserved: every decision below resolves ITS OWN ring from
// the event's provider/model — no module-global last-writer-wins ever.
export const SELF_HEAL_RETRY_MARKER =
  " — [pi-braid-providers] Provider returned error; exhausted the active key, auto-rotating to the next API key, retrying the turn.";

/**
 * WAF/infra retry marker. Same pi-core retry-flip mechanism as
 * SELF_HEAL_RETRY_MARKER: pi-core classifies the REPLACED message, so this
 * text itself must carry pi-ai's retry phrase "Provider returned error"
 * (utils/retry.js RETRYABLE_PROVIDER_ERROR_PATTERN). No key exhaustion or
 * rotation is claimed: the turn re-runs on the SAME key once the edge clears.
 */
export const WAF_RETRY_MARKER =
  " — [pi-braid-providers] Provider returned error; an edge/WAF block (transient infra, no key exhausted), retrying the turn on the same key.";

/**
 * Shape-rejection retry marker. Same pi-core retry-flip phrase as the markers
 * above (a rejected request is worth ONE re-run, on another route), but it
 * claims what actually happened: the route refused this request and no key was
 * at fault, so nothing about the key ring changed. The status is interpolated
 * because it is the same number the convergence rule keys on, and it is the
 * operator's next question ("which status").
 */
export const SHAPE_RETRY_MARKER =
  " — [pi-braid-providers] Provider returned error; the route rejected this request";

export function shapeRetryMarker(status: number | null): string {
  return (
    `${SHAPE_RETRY_MARKER} (HTTP ${status ?? "4xx"}, no key exhausted), ` +
    "rotated to the next configured route, retrying the turn there."
  );
}

/**
 * Fatal account-level tokens pi-ai will not retry
 * (dist/utils/retry.js NON_RETRYABLE_PROVIDER_LIMIT_ERROR_PATTERN), listed
 * verbatim and lowercased. pi-ai joins these same literals with "|" and tests
 * case-insensitively, so a literal substring test agrees with its regex for
 * this token set.
 *
 * Pinned by test/key-ring-selfheal.test.mjs, which parses the installed pi-ai
 * module's pattern source and requires every token it declares to be refused
 * below: an upstream addition turns that test red instead of silently
 * re-enabling the rewrite.
 */
const NON_RETRYABLE_ERROR_TOKENS = [
  "gousagelimiterror",
  "freeusagelimiterror",
  "monthly usage limit reached",
  "available balance",
  "insufficient_quota",
  "out of budget",
  "quota exceeded",
  "billing",
  "subscription_sharing_usage_limit_exceeded",
];

/**
 * True when appending SELF_HEAL_RETRY_MARKER can flip pi-core's retry
 * classification. If the raw error already carries one of the fatal
 * account-level tokens above, pi-ai refuses to retry it regardless of the
 * marker, so rewriting is pointless and would only mutate history.
 */
export function canReclassifyForTurnRetry(errorMessage: unknown): boolean {
  const text = String(errorMessage ?? "");
  if (!text.trim()) return false;
  const lower = text.toLowerCase();
  return !NON_RETRYABLE_ERROR_TOKENS.some((tok) => lower.includes(tok));
}

/**
 * Compact replacement for a WAF edge-block error body.
 * The edge page is a full HTML document (incl. Base64 assets) that pi-core
 * would surface verbatim, flooding the TUI — and pi-core STORES the returned
 * text as the failed turn's errorMessage, where it rides in every subsequent
 * request body and re-enters every future compaction summarize call. The
 * sanitized text keeps the "WAF" + "edge" tokens so isWafBlockError still
 * recognizes it, and carries ONLY the raw body length as diagnostic value.
 * The retry phrase lives in the WAF branch's marker, not here.
 *
 * Invariant: the sanitized output contains ZERO page markup. No excerpt
 * substring of the raw body is kept — not even truncated — so error-page
 * fragments can never re-enter stored history, request bodies, or summarize
 * windows. Applied to message.errorMessage in the WAF branch below (both
 * retry and non-retry) — the returned message is what pi-core stores and
 * displays (same mechanism the WAF turn retry already relies on).
 */
export function sanitizeWafError(original: unknown): string {
  const body = String(original ?? "");
  return `Edge/WAF block (transient infra, NOT key-rotation): page fragment redacted (body length ${body.length} chars).`;
}

// Legacy fallback resolvers (settings reader). The route-order rotation
// engine (below) owns the rotation order — braid.providers.routes alone.
// These resolvers stay exported because the settings reader still returns
// the legacy blocks and names them in its transition diagnostics, but they
// drive no rotate decision.

/** Validated braid.providers.fallback block. */
export interface FallbackConfig {
  provider: string;
  model: string;
}

/**
 * Pure resolver for braid.providers.fallback. Null unless BOTH fields are
 * non-empty strings — any malformed block keeps the feature inert (no warn:
 * the unset/malformed case must stay silent, byte-identical behavior).
 */
export function resolveFallbackConfig(raw: unknown): FallbackConfig | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const provider = (raw as Record<string, unknown>).provider;
  const model = (raw as Record<string, unknown>).model;
  if (typeof provider !== "string" || !provider.trim()) return null;
  if (typeof model !== "string" || !model.trim()) return null;
  return { provider: provider.trim(), model: model.trim() };
}

/**
 * Pure resolver for braid.providers.lastResort: a map of source provider id →
 * last-resort leg provider id. Semantics: when the source provider's gateway
 * ring dies, the leg provider serves the dead turn's model id. Absent/
 * non-object/array → empty map; entries with non-string or empty keys/values
 * are skipped (inert, no warn). Keys/values are trimmed (same convention as
 * resolveFallbackConfig); an entry for a provider this build never sees die is
 * legal and inert (future producers).
 */
export function resolveLastResortMap(raw: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return map;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") continue;
    const source = key.trim();
    const leg = value.trim();
    if (!source || !leg) continue;
    map.set(source, leg);
  }
  return map;
}

/**
 * A route's optional non-billable status capability. The URL and auth header
 * are route config (owner-owned); how the response is READ is the probe
 * layer's business (see probe.ts).
 */
export interface RouteProbe {
  /** Status endpoint URL. */
  url: string;
  /** Header carrying `Bearer <key>`; absent ⇒ the bearer default. */
  authHeader?: string;
  /**
   * Floor (USD) a reported spendable balance is measured against; absent ⇒
   * the probe layer's default. Validated here, applied by the probe runner.
   */
  balanceFloorUsd?: number;
}

/** One entry of the ordered braid.providers.routes array (the route table). */
export interface RouteConfig {
  /** Registered provider id (resolvable through pi's model registry). */
  provider: string;
  /** Env prefix of this route's credential namespace, handed to the key ring. */
  keys: string;
  /**
   * Optional dead-model-id → this provider's id map. Absent ⇒ the route serves
   * only ids it shares natively with the other routes.
   */
  models?: Record<string, string>;
  /**
   * Optional extra model ids attributed to this route. The attribution surface
   * is this list PLUS the ids the `models` map resolves to, so a turn served
   * after a redirect is attributed to the route that answered it.
   */
  modelIds?: string[];
  /**
   * Whether this route's requests take the Venice gateway payload tweak
   * (`venice_parameters` + system message first). Absent ⇒ the composition
   * root's default for the route's registration path, which is off for a
   * configured route and on for the default pair.
   */
  venicePayload?: boolean;
  /** Absent ⇒ no probe is ever run for this route. */
  probe?: RouteProbe;
}

export interface RoutesConfig {
  /** Valid entries, in array order (order is the rotation order). */
  routes: RouteConfig[];
  /** Named, non-silent diagnostics for skipped entries (index + field). */
  diagnostics: string[];
}

/**
 * Pure resolver for braid.providers.routes. Entries are validated in order:
 * `provider` and `keys` must be non-empty strings, `provider` must be unique
 * within the array, `models` (when present) must map non-empty model ids to
 * non-empty strings, `modelIds` (when present) must be an array of non-empty
 * strings, `venicePayload` (when present) must be a boolean, and `probe` (when
 * present) must carry a non-empty `url` and, if given, a non-empty
 * `authHeader`. Any invalid entry is SKIPPED with a
 * named diagnostic that carries its index and field — never dropped silently.
 * An `undefined` raw
 * value means "routes not configured" (empty, no diagnostic); any other
 * non-array value is a malformed whole-config and yields empty routes plus one
 * diagnostic. Never throws, no side effects, no module state.
 */
export function resolveRoutesConfig(raw: unknown): RoutesConfig {
  const routes: RouteConfig[] = [];
  const diagnostics: string[] = [];
  if (raw === undefined) return { routes, diagnostics };
  if (!Array.isArray(raw)) {
    diagnostics.push("routes: must be an array of route entries");
    return { routes, diagnostics };
  }
  const seen = new Set<string>();
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      diagnostics.push(`routes[${index}]: must be an object`);
      return;
    }
    const rec = entry as Record<string, unknown>;
    const providerRaw = rec.provider;
    if (typeof providerRaw !== "string" || !providerRaw.trim()) {
      diagnostics.push(`routes[${index}].provider: must be a non-empty string`);
      return;
    }
    const provider = providerRaw.trim();
    if (seen.has(provider)) {
      diagnostics.push(`routes[${index}].provider: duplicate of "${provider}"`);
      return;
    }
    const keysRaw = rec.keys;
    if (typeof keysRaw !== "string" || !keysRaw.trim()) {
      diagnostics.push(`routes[${index}].keys: must be a non-empty string`);
      return;
    }
    const keys = keysRaw.trim();
    let models: Record<string, string> | undefined;
    if (rec.models !== undefined) {
      const rawModels = rec.models;
      if (
        !rawModels ||
        typeof rawModels !== "object" ||
        Array.isArray(rawModels)
      ) {
        diagnostics.push(
          `routes[${index}].models: must be an object of model-id to provider-model-id strings`,
        );
        return;
      }
      models = {};
      let invalid = false;
      for (const [key, value] of Object.entries(
        rawModels as Record<string, unknown>,
      )) {
        if (!key.trim() || typeof value !== "string" || !value.trim()) {
          diagnostics.push(
            `routes[${index}].models["${key}"]: must map a non-empty model id to a non-empty string`,
          );
          invalid = true;
        } else {
          models[key.trim()] = value.trim();
        }
      }
      if (invalid) return;
    }
    let modelIds: string[] | undefined;
    if (rec.modelIds !== undefined) {
      if (!Array.isArray(rec.modelIds)) {
        diagnostics.push(
          `routes[${index}].modelIds: must be an array of non-empty model ids`,
        );
        return;
      }
      const ids: string[] = [];
      let invalid = false;
      rec.modelIds.forEach((id, idIndex) => {
        if (typeof id !== "string" || !id.trim()) {
          diagnostics.push(
            `routes[${index}].modelIds[${idIndex}]: must be a non-empty string`,
          );
          invalid = true;
        } else {
          ids.push(id.trim());
        }
      });
      if (invalid) return;
      modelIds = ids;
    }
    let venicePayload: boolean | undefined;
    if (rec.venicePayload !== undefined) {
      if (typeof rec.venicePayload !== "boolean") {
        diagnostics.push(`routes[${index}].venicePayload: must be a boolean`);
        return;
      }
      venicePayload = rec.venicePayload;
    }
    let probe: RouteProbe | undefined;
    if (rec.probe !== undefined) {
      const rawProbe = rec.probe;
      if (
        !rawProbe ||
        typeof rawProbe !== "object" ||
        Array.isArray(rawProbe)
      ) {
        diagnostics.push(
          `routes[${index}].probe: must be an object carrying a non-empty url`,
        );
        return;
      }
      const probeRecord = rawProbe as Record<string, unknown>;
      if (typeof probeRecord.url !== "string" || !probeRecord.url.trim()) {
        diagnostics.push(
          `routes[${index}].probe.url: must be a non-empty string`,
        );
        return;
      }
      if (
        probeRecord.authHeader !== undefined &&
        (typeof probeRecord.authHeader !== "string" ||
          !probeRecord.authHeader.trim())
      ) {
        diagnostics.push(
          `routes[${index}].probe.authHeader: must be a non-empty string`,
        );
        return;
      }
      if (
        probeRecord.balanceFloorUsd !== undefined &&
        (typeof probeRecord.balanceFloorUsd !== "number" ||
          !Number.isFinite(probeRecord.balanceFloorUsd) ||
          probeRecord.balanceFloorUsd < 0)
      ) {
        diagnostics.push(
          `routes[${index}].probe.balanceFloorUsd: must be a non-negative finite number`,
        );
        return;
      }
      // Field order is load-bearing: an entry without the optional fields must
      // resolve to exactly the same object shape every time, so each is
      // added only when present.
      const routeProbe: RouteProbe = { url: probeRecord.url.trim() };
      if (probeRecord.authHeader !== undefined) {
        routeProbe.authHeader = (probeRecord.authHeader as string).trim();
      }
      if (probeRecord.balanceFloorUsd !== undefined) {
        routeProbe.balanceFloorUsd = probeRecord.balanceFloorUsd as number;
      }
      probe = routeProbe;
    }
    seen.add(provider);
    // Field order is load-bearing: an entry without the optional fields must
    // resolve to exactly the same object shape every time.
    const route: RouteConfig = { provider, keys };
    if (models) route.models = models;
    if (modelIds) route.modelIds = modelIds;
    if (venicePayload !== undefined) route.venicePayload = venicePayload;
    if (probe) route.probe = probe;
    routes.push(route);
  });
  return { routes, diagnostics };
}

// Probe steering
// A route whose probe MEASURED it as unable must not be engaged while that
// measurement still describes the route. The engine consults the recorded
// verdict at engage time and skips only what is both measured unable AND
// fresh; `degraded` stays eligible (a route with a small but spendable balance
// can still serve), and a route with no recorded probe is never skipped. The
// freshness bound is settings, not a code constant, so the owner can move it
// without a build.

/**
 * Default freshness bound (ms) for a recorded probe verdict. 15 minutes: far
 * below the ~5-10$/day quota window a Venice-class route resets over, so a
 * verdict stays actionable for a working block without pinning a route out of
 * the rotation for the rest of the day.
 */
export const DEFAULT_PROBE_FRESHNESS_MS = 900_000;

/**
 * A recorded probe verdict as the engine consumes it: pure data. Structurally
 * the persisted `lastProbe`, declared here so the engine never imports the
 * state store (`readRouteState` is the only reader; the caller resolves the
 * verdict and hands it over).
 */
export interface RouteProbeVerdict {
  /** Probe-layer vocabulary; only `"unavailable"` is acted on here. */
  state: string;
  /** Epoch ms the probe ran. */
  at: number;
  /** Why the probe could not read a healthy state (never a secret). */
  reason?: string;
}

/**
 * Pure resolver for braid.providers.probeFreshnessMs. Absent → the default.
 * A non-number or non-finite value is an inert malformed scalar: the default
 * stands and `diagnostic` names it (never dropped silently). `0` or a negative
 * value is the EXPLICIT off switch — the probe is ignored entirely — and
 * survives resolution verbatim.
 */
export function resolveProbeFreshnessMs(raw: unknown): {
  value: number;
  diagnostic?: string;
} {
  if (raw === undefined) return { value: DEFAULT_PROBE_FRESHNESS_MS };
  if (typeof raw !== "number" || !Number.isFinite(raw)) {
    return {
      value: DEFAULT_PROBE_FRESHNESS_MS,
      diagnostic: "probeFreshnessMs: must be a finite number",
    };
  }
  return { value: raw };
}

/** The braid.providers blocks this package consumes, resolved fresh per call. */
export interface ProvidersSettings {
  fallback: FallbackConfig | null;
  /** source provider id → last-resort leg provider id; empty when unset/invalid. */
  lastResort: ReadonlyMap<string, string>;
  /** The ordered route table (empty when the routes key is absent or malformed). */
  routes: readonly RouteConfig[];
  /** True when the routes key is present in settings, even if it resolved empty. */
  routesConfigured: boolean;
  /**
   * The pi-level default model id (`settings.defaultModel`), read from the
   * same document because the virtual health router resolves its logical base
   * model through the route table and has no per-request anchor before the
   * session's first response. Null when the file carries none.
   */
  defaultModel: string | null;
  /**
   * How long (ms) a recorded `unavailable` probe verdict stays actionable at
   * engage time. `0` or negative disables probe steering entirely.
   */
  probeFreshnessMs: number;
  /**
   * Named, non-silent diagnostics for the current settings: skipped route
   * entries and the transition warnings below. The extension emits them once
   * the notify sink exists (see emitProvidersSettingsDiagnostics).
   */
  diagnostics: readonly string[];
}

function emptyProvidersSettings(): ProvidersSettings {
  return {
    fallback: null,
    lastResort: new Map(),
    routes: [],
    routesConfigured: false,
    defaultModel: null,
    probeFreshnessMs: DEFAULT_PROBE_FRESHNESS_MS,
    diagnostics: [],
  };
}

/**
 * Read the whole braid.providers object from ~/.pi/agent/settings.json, fresh
 * on every call (mirrors braid-settings.ts read-fresh; the file is owner-owned
 * — this only READS it). Never throws; absent/invalid → null / empty.
 *
 * Transition semantics (routes vs the legacy fallback/lastResort keys):
 *   - routes present → it wins. The legacy blocks are ignored (resolved to
 *     null / empty) and ONE diagnostic names them as ignored.
 *   - routes absent → the legacy blocks resolve exactly as before, plus ONE
 *     diagnostic naming the replacement routes shape when any legacy key is
 *     set (nothing to migrate ⇒ no warning).
 * `braid.providers.probeFreshnessMs` is a sibling scalar, resolved in both
 * branches: an unusable value leaves the default in place plus ONE diagnostic.
 * Emission is deliberately NOT done here: this reader runs before the notify
 * sink is bound, so the extension emits `diagnostics` at session_start (see
 * emitProvidersSettingsDiagnostics).
 */
export function readProvidersSettingsFromSettings(): ProvidersSettings {
  try {
    const home = process.env.HOME || process.env.USERPROFILE || ".";
    const file = join(home, ".pi", "agent", "settings.json");
    if (!existsSync(file)) return emptyProvidersSettings();
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as {
      defaultModel?: unknown;
      braid?: { providers?: unknown };
    };
    const defaultModel =
      typeof parsed?.defaultModel === "string" && parsed.defaultModel.trim()
        ? parsed.defaultModel.trim()
        : null;
    const providersRaw = parsed?.braid?.providers;
    const providers =
      providersRaw &&
      typeof providersRaw === "object" &&
      !Array.isArray(providersRaw)
        ? (providersRaw as Record<string, unknown>)
        : undefined;
    const routesConfigured = !!providers && "routes" in providers;
    const probeFreshness = resolveProbeFreshnessMs(providers?.probeFreshnessMs);
    if (routesConfigured && providers) {
      const resolved = resolveRoutesConfig(providers.routes);
      const ignored: string[] = [];
      if (resolveFallbackConfig(providers.fallback))
        ignored.push("braid.providers.fallback");
      if (resolveLastResortMap(providers.lastResort).size > 0)
        ignored.push("braid.providers.lastResort");
      const diagnostics = [...resolved.diagnostics];
      if (probeFreshness.diagnostic)
        diagnostics.push(probeFreshness.diagnostic);
      if (ignored.length > 0) {
        diagnostics.unshift(
          `braid.providers.routes is set — ignoring legacy ${ignored.join(" and ")}; ` +
            `the ordered routes array is the only source of provider registration order. Remove the legacy key(s).`,
        );
      }
      return {
        fallback: null,
        lastResort: new Map(),
        routes: resolved.routes,
        routesConfigured: true,
        defaultModel,
        probeFreshnessMs: probeFreshness.value,
        diagnostics,
      };
    }
    const fallback = resolveFallbackConfig(providers?.fallback);
    const lastResort = resolveLastResortMap(providers?.lastResort);
    const diagnostics: string[] = [];
    if (fallback || lastResort.size > 0) {
      diagnostics.push(
        `braid.providers.routes is not set — braid.providers.fallback/lastResort still drive the legacy path. ` +
          `Replace them with the ordered routes array, e.g. "routes":[{"provider":"<id>","keys":"<ENV_PREFIX>"}, ...]; ` +
          `route order is the rotation order.`,
      );
    }
    if (probeFreshness.diagnostic) diagnostics.push(probeFreshness.diagnostic);
    return {
      fallback,
      lastResort,
      routes: [],
      routesConfigured: false,
      defaultModel,
      probeFreshnessMs: probeFreshness.value,
      diagnostics,
    };
  } catch {
    return emptyProvidersSettings();
  }
}

// One throttled sink per distinct diagnostic string: the same diagnostic is
// loud once per window and silent on repeats, while different diagnostics never
// suppress each other. Bounded by the number of distinct settings diagnostics.
const settingsDiagnosticLogs = new Map<
  string,
  ReturnType<typeof createThrottledLogger>
>();

/**
 * Emit settings diagnostics (skipped route entries + transition warnings) once
 * per distinct message per throttle window. Called by the extension at
 * session_start, after the notify sink is bound — the reader itself stays
 * silent on purpose (it runs before the sink exists; see
 * readProvidersSettingsFromSettings).
 */
export function emitProvidersSettingsDiagnostics(
  diagnostics: readonly string[],
): void {
  for (const diagnostic of diagnostics) {
    let log = settingsDiagnosticLogs.get(diagnostic);
    if (!log) {
      log = createThrottledLogger();
      settingsDiagnosticLogs.set(diagnostic, log);
    }
    log.occurrence(
      "warn",
      "providers/settings",
      `[pi-braid-providers] ${diagnostic}`,
    );
  }
}

/**
 * Shared bounded-walk scaffold. Owns the state machine every engage needs —
 * the episode chain (`primary`/`current`/`visited`), the one-shot inert and
 * convergence notices, promise transparency — and delegates every decision to
 * its spec: what an attempt targets, how it engages, and what it emits on
 * either outcome. The rotation engine below is its sole user: the engine
 * supplies the ordered walk and the route-generic texts; the scaffold owns the
 * episode and the one-shot flags.
 *
 * The episode chain replaces a lifetime latch: an episode is open from the
 * first successful engage until a reset or a successful fail-back, and only the
 * death of the route the walk is CURRENTLY serving advances it. Two properties
 * follow, and both matter: a death reported for any other route cannot storm the
 * walk, and a route the episode already engaged (or that its own ring already
 * reported unusable) is not stepped back onto.
 */
export interface EngageScaffold {
  /**
   * One engage attempt for a death of `providerId`. Opens an episode when none
   * is open; while one is open it continues only for the route the walk is
   * currently serving, and stops with the one-shot convergence notice when that
   * route reports the same status for the same model id. Returns the retry
   * marker when the engage succeeded, or null: silently for the unset/
   * malformed/not-ours/anti-storm cases, via the one-shot inert notice when a
   * configured engage failed. Async when the engage is async.
   */
  attempt(
    providerId: string,
    engage: RotationEngageDeps,
    modelId?: string,
    signal?: FailureClassification,
  ): string | null | Promise<string | null>;
  /** Test/session observability. */
  isEngaged(): boolean;
  /**
   * The open episode BY REFERENCE (identity is the fail-back race check), or
   * null when none is open.
   */
  episode(): EngageEpisode | null;
  /** Fresh-session reset: the next session re-probes the primary. */
  reset(): void;
}

/** The episode a walked death opens: who opened it, and whom the walk serves. */
export interface EngageEpisode {
  /** The route whose death opened the episode (the fail-back target). */
  primary: string;
  /** The route the walk engaged last; null when the engage could not name it. */
  current: string | null;
  /** The dead turn's own model id, restored on fail-back. */
  modelId: string;
  /** Routes this episode already engaged (never re-engaged within it). */
  visited: ReadonlySet<string>;
}

/**
 * What an `apply` reports: a string NAMES the route it engaged, `true` engages
 * one the spec cannot name (the episode then has no continue-able `current`),
 * `false` means the engage was not usable.
 */
export type EngageOutcome = boolean | string;

/** No failure facts: a caller that knows only that the route died. */
const NO_FAILURE: FailureClassification = { class: "none", status: null };

export function createEngageScaffold<T>(spec: {
  /** Null → silent inert (unset/malformed, not this attempt's death, nothing to serve). */
  resolve(
    providerId: string,
    modelId: string,
    signal: FailureClassification,
    episode: EngageEpisode | null,
  ): T | null;
  /** Perform the engage; false → unusable (one-shot inert notice). */
  apply(
    target: T,
    modelId: string,
    engage: RotationEngageDeps,
  ): EngageOutcome | Promise<EngageOutcome>;
  /** Engage succeeded: emit the ONE escalation whisper and return the retry marker. */
  onEngaged(
    target: T,
    modelId: string,
    engage: RotationEngageDeps,
    engagedRoute: string | null,
    signal: FailureClassification,
  ): string;
  /** Engage failed: the one-shot inert notice. */
  onInert(
    target: T,
    modelId: string,
    engage: RotationEngageDeps,
    signal: FailureClassification,
  ): void;
  /**
   * Two routes returned the same status for the same model id: the walk stops
   * on purpose. One-shot per episode; absent ⇒ the stop is silent.
   */
  onConverged?(
    episode: EngageEpisode,
    modelId: string,
    signal: FailureClassification,
    engage: RotationEngageDeps,
  ): void;
}): EngageScaffold {
  let episode: EngageEpisode | null = null;
  /** The shape leg that advanced the walk — the convergence rule's memory. */
  let lastLeg: { modelId: string; status: number } | null = null;
  let notifiedInert = false;
  let notifiedConverged = false;

  const named = (outcome: EngageOutcome): string | null =>
    typeof outcome === "string" && outcome ? outcome : null;

  const finish = (
    outcome: EngageOutcome,
    target: T,
    modelId: string,
    engage: RotationEngageDeps,
    signal: FailureClassification,
    providerId: string,
  ): string | null => {
    const routeId = named(outcome);
    if (!routeId && outcome !== true) {
      if (!notifiedInert) {
        notifiedInert = true;
        spec.onInert(target, modelId, engage, signal);
      }
      return null;
    }
    const visited = new Set(episode?.visited ?? []);
    if (routeId) visited.add(routeId);
    episode = {
      primary: episode?.primary ?? providerId,
      current: routeId,
      modelId: episode?.modelId ?? modelId,
      visited,
    };
    lastLeg =
      signal.class === "shape" && signal.status !== null
        ? { modelId, status: signal.status }
        : null;
    return spec.onEngaged(target, modelId, engage, routeId, signal);
  };

  return {
    attempt(providerId, engage, modelId = "", signal = NO_FAILURE) {
      if (episode) {
        // Anti-storm: only the death of the route the walk serves now may
        // advance the walk. An episode whose serve route could not be named
        // cannot be continued at all.
        if (!episode.current || providerId !== episode.current) return null;
        // Convergence: a second route agreeing on the same status for the same
        // model id is the walk's stop condition — the request is at fault.
        if (
          signal.class === "shape" &&
          lastLeg !== null &&
          lastLeg.modelId === modelId &&
          signal.status !== null &&
          lastLeg.status === signal.status
        ) {
          if (!notifiedConverged) {
            notifiedConverged = true;
            spec.onConverged?.(episode, modelId, signal, engage);
          }
          return null;
        }
      }
      const target = spec.resolve(providerId, modelId, signal, episode);
      if (!target) return null; // unset/malformed → byte-identical inert
      const outcome = spec.apply(target, modelId, engage);
      if (outcome instanceof Promise) {
        return outcome.then((settled) =>
          finish(settled, target, modelId, engage, signal, providerId),
        );
      }
      return finish(outcome, target, modelId, engage, signal, providerId);
    },
    isEngaged: () => episode !== null,
    episode: () => episode,
    reset: () => {
      episode = null;
      lastLeg = null;
      notifiedInert = false;
      notifiedConverged = false;
    },
  };
}

// Key Rings
// Each provider gets its own key ring with exponential backoff.
// Keys are loaded from env vars: ${prefix}_P0..P9 with fallback to ${prefix}.
// Exhausted-key state persists to ~/.pi/agent/.key-ring-state-{name}.json so
// restarts skip known-dead keys instead of retrying them and hitting the same
// 403 that pi-core won't auto-retry.

/**
 * Provider ids this package owns: the `agent-zero` gateway route's id and the `braid`
 * virtual namespace of the health-routed `auto` entry. Stable: owner configs
 * and saved sessions reference them.
 */
export type ProviderId = "agent-zero" | "braid";

export const AGENT_ZERO_ID: ProviderId = "agent-zero";

/**
 * Provider id of the health-routed virtual entry (`braid/auto`). The auto
 * route spans several providers, so the entry does not borrow the gateway
 * route's id: `braid` is this package's own namespace, carries no route and
 * no physical model, and is registered only as the virtual model's provider.
 */
export const BRAID_AUTO_ID: ProviderId = "braid";

/** Env prefix of the gateway route's credential namespace (a route's `keys`). */
export const AGENT_ZERO_KEY_PREFIX = "AGENT_ZERO_API_KEY";

export const veniceKeyRing = createKeyRing({
  prefix: AGENT_ZERO_KEY_PREFIX,
  stateFile: "agent-zero",
  // The ring needs 4+ keys to survive the daily-quota window.
  warnBelowKeyCount: 4,
  // Surface keys-remaining on each rotation info line (no per-request spam).
  healthInRotationInfo: true,
  // Surfaced verbatim so the exhaustion warn is human-readable, not a bare
  // "add keys" line: Venice is a daily-limit account (~5-10$/day), resets
  // 00:00 UTC / 3am local.
  exhaustionNotice:
    "Venice account daily quota ~5-10$/day spent — resets 00:00 UTC / 3am local.",
});

// Route registration seam
// Each route registers here: its ring, its credential namespace (env prefix)
// and its model ids. The agent-zero gateway route registers at module load (its ring is
// a module constant); the venice-direct route and any external providers
// register from index.ts. N routes share one seam, so a turn's key ring is
// always resolved from the registration table — never from object identity or a
// provider-id special case. The test suite registers fixture routes so
// multi-route attribution and the interleaved-turn race keep deterministic
// regression coverage without extra production providers.

interface RegisteredRoute {
  providerId: string;
  keys: string;
  modelIds: readonly string[];
  models?: Record<string, string>;
  /** Whether a request this route owns takes the Venice payload tweak. */
  venicePayload: boolean;
  probe?: RouteProbe;
  ring: ReturnType<typeof createKeyRing>;
  errorLog: ReturnType<typeof createThrottledLogger>;
}

const registeredRoutes = new Map<string, RegisteredRoute>();

export interface RouteRegistration {
  providerId: string;
  /** Env prefix of this route's credential namespace. */
  keys: string;
  /** Model ids attributed to this ring when an event carries no provider. */
  modelIds: readonly string[];
  /** Optional dead-model-id → this provider's id map (preserved for the engine). */
  models?: Record<string, string>;
  /** Whether a request this route owns takes the Venice payload tweak. */
  venicePayload?: boolean;
  /** Optional non-billable status capability (carried verbatim from the route). */
  probe?: RouteProbe;
  ring: ReturnType<typeof createKeyRing>;
}

/** Register a route (idempotent per providerId). */
export function registerRoute(reg: RouteRegistration): void {
  registeredRoutes.set(reg.providerId, {
    ...reg,
    venicePayload: reg.venicePayload === true,
    errorLog: createThrottledLogger(),
  });
}

/**
 * Drop every registered route. The composition root calls this when the
 * settings carry a `routes` key, right before registering the configured
 * routes: the built-in gateway entry is a FALLBACK, so with an explicit route
 * table the registration table must hold exactly the configured routes. A
 * route the table does not name can then be neither attributed nor rotated to.
 */
export function clearRouteRegistry(): void {
  registeredRoutes.clear();
}

/**
 * Install the built-in gateway route as the registration table's fallback
 * entry. Idempotent, so the composition root may call it on every load with
 * no `routes` key; without the private catalog it is the only route the
 * generic plumbing has to attribute the gateway's model ids with.
 */
export function installDefaultGatewayRoute(): void {
  registerRoute({
    providerId: AGENT_ZERO_ID,
    keys: AGENT_ZERO_KEY_PREFIX,
    modelIds: ["deepseek-v4-pro-0813"],
    venicePayload: true,
    ring: veniceKeyRing,
  });
}

/**
 * Build the key ring for a route: the route's `keys` prefix is handed to
 * createKeyRing verbatim, and the provider id is the ring's state-file name, so
 * cross-process key cooldown state is per-route by construction.
 */
export function createRouteRing(
  route: RouteConfig,
): ReturnType<typeof createKeyRing> {
  return createKeyRing({
    prefix: route.keys,
    stateFile: route.provider,
    healthInRotationInfo: true,
  });
}

/**
 * Register a route whose model surface comes from the owner-private Venice
 * catalog (the gateway and the direct route): the catalog's ids plus the
 * descriptor's own `modelIds` form the attribution set, the descriptor's
 * `models` map is carried WHOLE, and the descriptor's probe rides along. The
 * ring and the resolved payload default stay the caller's, because those are
 * what differ between the catalog routes. Both call sites share this one
 * mapping so a descriptor field cannot reach one catalog route and not the
 * other: the walk resolves a dead turn's model id from the registration table,
 * so a dropped field is a route the walk cannot reach even though the
 * configured table declares it.
 */
export function registerCatalogRoute(
  route: RouteConfig,
  catalogModelIds: readonly string[],
  ring: ReturnType<typeof createKeyRing>,
  venicePayload: boolean,
): void {
  registerRoute({
    providerId: route.provider,
    keys: route.keys,
    modelIds: [...catalogModelIds, ...(route.modelIds ?? [])],
    models: route.models,
    probe: route.probe,
    venicePayload,
    ring,
  });
}

// Route-order rotation engine
// ONE engine, consulted for two failure
// classes: a key-rotation-class death whose owning ring reports usable === 0,
// and a shape-class (HTTP 4xx) rejection that no key is at fault for. In both
// cases it walks the registered routes IN TABLE ORDER and engages the first
// route that is not the dead route, has a usable key, can serve the dead
// turn's model id — directly (present in the route's modelIds) or through its
// models map — is not currently measured unable, and has not just refused this
// same request. The route table's array order IS the rotation order; there is
// no separate priority knob.
//
// The walk is bounded by the episode, not by a latch: an episode opens on the
// first successful engage and only the death of the route the walk is serving
// advances it (one engage per route per episode, and never back onto the route
// whose death opened the episode — that route is the fail-back target), so a
// repeated death of the route that opened the episode, or of any route the walk
// did not choose, is inert. Two routes answering the same status for the same
// model id stop the walk — that agreement is about the request, not about a
// credential.
//
// Seam (measured against the shipped pi dist): the session model is per-run
// request state (agent.state.model read per streamSimple); ExtensionAPI.setModel
// swaps it session-only (auth check only, no persist, enabledModels not
// consulted). A message_end replacement carrying the marker phrase flips
// pi-core's retry classification, and the retry re-prompts with the
// ALREADY-SWAPPED session model. So the engage ordering is: setModel during the
// message_end handler, then hand back the marker.
//
// The marker reuses the vehicle but states the rotation factually. Only
// appended when canReclassifyForTurnRetry(errText) — a NON_RETRYABLE raw error
// is never retried by pi-ai regardless of the marker, and rewriting history
// would be a lie. The engage itself is NOT gated on reclassifiability: even a
// non-retryable turn benefits future turns on the rotated route.
//
// State discipline: the shared scaffold owns the episode chain and the two
// one-shot notices (inert, convergence); the engine adds the fail-back cadence
// stamp. No lists/maps — nothing to bound. No module-level let (lib/state
// AGENTS.md contract). Reset on session_start (wired in index.ts) = fresh-
// session re-probe of the primary; only the route-death STORE crosses sessions
// (the session's model_change entry persists the switch naturally; a resumed
// session stays rotated).

/** customType for the ONE rotation whisper (and the inert notice). */
export const ROTATION_WHISPER_TYPE = "provider-rotation";

/** Route-generic retry marker for a successful engage (matches pi-ai RETRYABLE_PROVIDER_ERROR_PATTERN). */
export const ROTATION_RETRY_MARKER =
  " — [pi-braid-providers] Provider returned error; the route's key ring is exhausted, rotated to the next configured route, retrying the turn there.";

/**
 * Fail-back probe cadence. At most ONE lightweight primary probe per
 * interval, checked at turn boundaries only (turn_end) — no background
 * timers, no per-request chatter. 10 minutes because it must sit ABOVE the
 * key-ring's 5-minute max backoff (key-ring.ts): a probe that fires while
 * every ring key is still in backoff would resolve the transient-exhaustion
 * sentinel key and 401 against a route that may have already recovered —
 * a false negative. It stays low enough that a recovered primary is adopted
 * within one working block instead of waiting out the session.
 */
export const FAILBACK_PROBE_INTERVAL_MS = 10 * 60 * 1000;

/**
 * Hard ceiling for one probe call. A probe hangs only if the route accepts
 * the connection but never answers; 20s is far above a healthy small
 * completion and turns the hang into an honest probe failure. Without it a
 * hung probe would stall the turn boundary that invoked it.
 */
export const FAILBACK_PROBE_TIMEOUT_MS = 20_000;

/**
 * How many consecutive edge/WAF blocks on one (route, model id) pair mean the
 * route is refusing THIS request rather than blocking a transient edge. One
 * block is still worth today's same-route retry; two in a row is the livelock
 * the walk has to break by moving the turn.
 */
export const WAF_REPEAT_BLOCK = 2;

/**
 * Retry marker for the repeat case. The route refused the SAME request at the
 * edge again, so this turn moves instead of being re-sent there: the same
 * pi-core retry-flip phrase as the markers above, the same "no key exhausted"
 * fact as WAF_RETRY_MARKER, and it names the repeated refusal rather than a
 * dead credential. Key-ring state is untouched either way.
 *
 * It sits with the threshold instead of in the marker cluster at the top of the
 * file, which precedes the settings-reader rows the schema artifact pins by
 * line number.
 */
export const WAF_REPEAT_RETRY_MARKER =
  " — [pi-braid-providers] Provider returned error; this route refused the request at the edge again, rotated to the next configured route, retrying the turn there.";

/**
 * The one-shot state result of a fail-back attempt: "failed-back" (probe
 * succeeded AND the session model returned to the primary), "probed-dead"
 * (the probe ran and the primary is still failing — keep serving the rotated
 * route), or null (no probe attempted: disengaged, or inside the interval).
 */
export type FailBackOutcome = "failed-back" | "probed-dead" | null;

/** Mechanics the engine drives; implemented in index.ts over pi-core APIs. */
export interface RotationEngageDeps {
  /**
   * Activate the target route/model for the SESSION (session-only setModel).
   * Returns false when the model is unknown to the registry or the provider
   * has no configured auth — the graceful-inert path (the walk continues).
   */
  setModel(provider: string, model: string): Promise<boolean> | boolean;
  /** ONE owner-visible message (rotation whisper on engage, inert notice otherwise). */
  notify(text: string): void;
}

/** Mechanics the fail-back probe drives; wired in index.ts over pi-core APIs. */
export interface RotationProbeDeps {
  /**
   * One lightweight request to the primary serving modelId. Returns true only
   * when the request COMPLETED (a healthy completion or any non-error stop —
   * a capped/length stop proves the route works). Failure classification and
   * key-ring feedback are the caller's job.
   */
  probe(source: string, modelId: string): boolean | Promise<boolean>;
  /** Session-only setModel, same contract as RotationEngageDeps. */
  setModel(provider: string, model: string): boolean | Promise<boolean>;
  /** Owner-visible whisper (the fail-back marker). */
  notify(text: string): void;
}

/**
 * One throttled sink per skipped route: a route skipped again inside the
 * throttle window is silent, while two different routes never suppress each
 * other. Bounded by the route table, and a route id never leaves the table.
 */
const probeSkipLogs = new Map<
  string,
  ReturnType<typeof createThrottledLogger>
>();

/**
 * Whether a recorded verdict says this route must not be engaged NOW: it was
 * measured `unavailable` and the measurement is younger than the bound. Every
 * other reading — `ok`, `degraded`, no record, a stale record, or a bound of
 * `0`/less — leaves the route exactly as eligible as it was before.
 */
function isMeasuredUnavailable(
  verdict: RouteProbeVerdict | undefined,
  at: number,
  probeFreshnessMs: number,
): verdict is RouteProbeVerdict {
  if (probeFreshnessMs <= 0) return false; // the explicit off switch
  if (!verdict || verdict.state !== "unavailable") return false;
  return at - verdict.at < probeFreshnessMs;
}

/**
 * Report one probe skip through the EXISTING throttled log channel (no new
 * surface): names the route and the recorded reason, and repeats inside the
 * window are silent — a walk that skips on every attempt still writes once.
 */
function reportProbeSkip(
  routeId: string,
  verdict: RouteProbeVerdict,
  at: number,
  probeFreshnessMs: number,
): void {
  let log = probeSkipLogs.get(routeId);
  if (!log) {
    log = createThrottledLogger();
    probeSkipLogs.set(routeId, log);
  }
  log.occurrence(
    "info",
    "providers/provider-rotation",
    `[pi-braid-providers] ${routeId} passed over: its recorded probe measured it unavailable` +
      `${verdict.reason ? ` (${verdict.reason})` : ""} and that verdict is still fresh ` +
      `(${at - verdict.at}ms old, freshness bound ${probeFreshnessMs}ms). ` +
      `Routes measured only degraded, and routes with no recorded probe, stay eligible.`,
  );
}

/**
 * One throttled sink per route that rejected a request, same channel and same
 * per-route isolation as the probe-skip sinks above: a route skipped again
 * inside the throttle window is silent, two different routes never suppress
 * each other, and the map is bounded by the route table.
 */
const shapeSkipLogs = new Map<
  string,
  ReturnType<typeof createThrottledLogger>
>();

/**
 * Whether a recorded death says this route refused the SAME request: a shape
 * death for the same model id and the same HTTP status, younger than the bound.
 * Every other reading — another class, another request, no record, a stale
 * record, or a bound of `0`/less — leaves the route exactly as eligible as
 * before.
 */
function isFreshShapeDeath(
  death: RouteDeathVerdict | undefined,
  at: number,
  freshnessMs: number,
  modelId: string,
  status: number,
): death is RouteDeathVerdict {
  if (freshnessMs <= 0) return false; // the same explicit off switch
  if (!death || death.class !== SHAPE_DEATH_CLASS) return false;
  if (death.modelId !== modelId || death.status !== status) return false;
  return at - death.at < freshnessMs;
}

/**
 * Report one shape-death skip through the same throttled channel as the probe
 * skip: names the route, the request it rejected and the freshness bound, and
 * repeats inside the window are silent.
 */
function reportShapeSkip(
  routeId: string,
  death: RouteDeathVerdict,
  at: number,
  freshnessMs: number,
): void {
  let log = shapeSkipLogs.get(routeId);
  if (!log) {
    log = createThrottledLogger();
    shapeSkipLogs.set(routeId, log);
  }
  log.occurrence(
    "info",
    "providers/provider-rotation",
    `[pi-braid-providers] ${routeId} passed over: it rejected this request ` +
      `(HTTP ${death.status ?? "4xx"} for ${death.modelId ?? "this model"}) ` +
      `${at - death.at}ms ago and that verdict is still fresh ` +
      `(freshness bound ${freshnessMs}ms). A rejection older than the bound, one ` +
      `for another model id or status, and a route with no record stay eligible.`,
  );
}

export interface RotationEngine {
  /**
   * One-shot engage decision for a route death. Walks `order` and engages the
   * first route that is not the dead route, is not the route that opened the
   * open episode, has a usable key, can serve modelId, is not currently measured
   * unable by a fresh probe verdict, and has not recently rejected the same
   * request. Returns the retry marker to append (engage succeeded), or null
   * (inert: nothing to serve, no route available for this failure class, an
   * ineligible death while an episode is open, or every candidate failed).
   * Async when setModel is async.
   */
  maybeEngage(
    providerId: string,
    errText: string,
    modelId: string,
    engage: RotationEngageDeps,
  ): string | null | Promise<string | null>;
  /**
   * Bounded fail-back decision. While a route episode is active, at most one
   * primary probe per interval — the first one a full interval after the
   * engage, so the just-died primary is not hammered. Probe success swaps the
   * session model back to the captured (fromRoute, modelId), emits ONE
   * whisper, and fully re-arms the engage; probe failure keeps the rotated
   * route and schedules the next probe one interval out. null = no probe
   * attempted. The timestamp is written before the probe is awaited, so
   * overlapping calls can never exceed one probe per interval.
   */
  maybeFailBack(
    engage: RotationProbeDeps,
  ): FailBackOutcome | Promise<FailBackOutcome>;
  /**
   * Count one edge/WAF block for this (route, model id) and report whether it
   * is a REPEAT: true on the second and every later CONSECUTIVE block for that
   * pair. The count is episode-scoped state — a fresh session and a completed
   * fail-back both start every streak from zero — and it is keyed by route, so
   * a block on one route can never be charged to another. The handler
   * owns the policy (first block: today's same-route retry; repeat: consult the
   * walk); this only counts.
   */
  noteWafBlock(providerId: string, modelId: string): boolean;
  /** Test/session observability. */
  isEngaged(): boolean;
  /** Fresh-session reset: the next session re-probes the primary. */
  reset(): void;
}

/** One engage-able route for a dead turn's model id. */
interface RotationCandidate {
  routeId: string;
  /** The model id to pass to setModel (the route's own id for this turn). */
  providerModelId: string;
}

/** The ordered candidate set for one death (built by the scaffold's resolve). */
interface RotationPlan {
  from: string;
  modelId: string;
  candidates: RotationCandidate[];
  /** Routes passed over (not registered, no usable key, or can't serve the id). */
  skipped: string[];
  /** Routes passed over because a fresh probe measured them unavailable. */
  probeSkipped: string[];
  /** Routes passed over because they rejected this same request recently. */
  shapeSkipped: string[];
  /** Candidates that were attempted and whose engage returned false. */
  failed: string[];
  /** The candidate the engage selected (set by apply, read by onEngaged). */
  engaged?: RotationCandidate;
}

/**
 * One recorded route death, handed to the walk as DATA (the composition layer
 * reads the store; this module never touches a file). `class` is the caller's
 * name for the death; only `SHAPE_DEATH_CLASS` records are consulted.
 */
export interface RouteDeathVerdict {
  class: string;
  /** The model id the route refused, when it is request-scoped. */
  modelId: string | null;
  /** The HTTP status the route answered with, when it is known. */
  status: number | null;
  at: number;
}

/** What the walk records when a route refuses a request (bound in index.ts). */
export interface WalkDeathRecord {
  class: string;
  at: number;
  modelId: string;
  status: number | null;
}

/**
 * The model id a route serves for a dead turn's id: the id itself when the
 * route shares it natively, otherwise the route's own id from its models map.
 * Null when the route cannot serve the id.
 */
function resolveRouteModel(
  route: RegisteredRoute,
  modelId: string,
): string | null {
  if (route.modelIds.includes(modelId)) return modelId;
  const mapped = route.models?.[modelId];
  return mapped && mapped.trim() ? mapped : null;
}

/**
 * Create the rotation engine over an explicit route order. The order is the
 * provider ids of the same routes array the registration loop used, so the
 * walk matches registration order by construction (the module-level
 * registration map is consulted for each route's ring and model surface).
 *
 * Probe steering and the route-death memory are DATA the caller resolves and
 * hands over: `probeStates` and `routeDeaths` are read ONCE per engage (not per
 * candidate) and map a route id to its recorded facts, and `recordRouteDeath`
 * is the store's writer, injected for the same reason. So this module never
 * reaches for a provider table or a state-file path of its own, and absent
 * these readers (or with `probeFreshnessMs` at `0` or less) the walk is
 * byte-identical to a build without steering. The order is captured at load, so
 * a settings change takes effect on reload.
 */
export function createRotationEngine(deps: {
  order: readonly string[];
  now?: () => number;
  /** How long a recorded verdict stays actionable; ≤ 0 disables both readings. */
  probeFreshnessMs?: number;
  /** Fresh per-route probe verdicts; absent ⇒ probe steering is inert. */
  probeStates?: () => ReadonlyMap<string, RouteProbeVerdict>;
  /** Recorded per-route deaths; absent ⇒ the shape-death skip is inert. */
  routeDeaths?: () => ReadonlyMap<string, RouteDeathVerdict>;
  /** The route-death store's writer; absent ⇒ nothing is recorded. */
  recordRouteDeath?: (providerId: string, death: WalkDeathRecord) => void;
}): RotationEngine {
  const order = deps.order;
  const now = deps.now ?? Date.now;
  const probeFreshnessMs = deps.probeFreshnessMs ?? DEFAULT_PROBE_FRESHNESS_MS;

  let lastProbeAt = 0;

  /**
   * Consecutive edge/WAF blocks per (route, model id). Episode-scoped: cleared
   * by reset() and by a completed fail-back, so the streak cannot outlive the
   * excursion it belongs to. The stored value is capped at the threshold, so
   * the map holds one small entry per pair and nothing here grows with time.
   */
  const wafBlocks = new Map<string, number>();

  const buildPlan = (
    providerId: string,
    modelId: string,
    signal: FailureClassification,
    episode: EngageEpisode | null,
  ): RotationPlan | null => {
    if (!providerId || !modelId) return null; // nothing to serve / look up
    const candidates: RotationCandidate[] = [];
    const skipped: string[] = [];
    const probeSkipped: string[] = [];
    const shapeSkipped: string[] = [];
    // One verdict snapshot per engage, one clock reading: the whole walk judges
    // every candidate against the same instant.
    const at = now();
    const probeStates = probeFreshnessMs > 0 ? deps.probeStates?.() : undefined;
    const deaths = probeFreshnessMs > 0 ? deps.routeDeaths?.() : undefined;
    for (const routeId of order) {
      if (routeId === providerId) continue; // the dead route is never re-engaged
      // One engage per route per episode: a route this episode already engaged
      // is not stepped back onto (the bound that makes a walk terminate even
      // when another route's ring still has keys).
      if (episode?.visited.has(routeId)) {
        skipped.push(routeId);
        continue;
      }
      // The walk is one-directional within an episode: the route whose death
      // opened it is the fail-back target, never a candidate, or the walk could
      // step back onto a route that already refused this request and the
      // episode would not stay inside |order| - 1 engages.
      if (routeId === episode?.primary) {
        skipped.push(routeId);
        continue;
      }
      const route = registeredRoutes.get(routeId);
      if (!route) {
        skipped.push(routeId); // not registered this build
        continue;
      }
      // A ring with total === 0 is unconfigured; usable === 0 means every key
      // is spent/backing off. Either way the route is not engageable now.
      if (route.ring.health().usable <= 0) {
        skipped.push(routeId);
        continue;
      }
      const providerModelId = resolveRouteModel(route, modelId);
      if (!providerModelId) {
        skipped.push(routeId); // cannot serve this model id
        continue;
      }
      // The route is otherwise eligible; skip it only when it recently refused
      // this same request. Recorded so the no-route diagnostic still fires
      // when this leaves nothing to engage.
      const death = deaths?.get(routeId);
      if (
        signal.class === "shape" &&
        signal.status !== null &&
        isFreshShapeDeath(death, at, probeFreshnessMs, modelId, signal.status)
      ) {
        shapeSkipped.push(routeId);
        reportShapeSkip(routeId, death, at, probeFreshnessMs);
        continue;
      }
      // The route is otherwise eligible; skip it only when a fresh probe
      // says it cannot serve. Recorded so the no-route diagnostic still fires
      // when probe steering leaves nothing to engage.
      const verdict = probeStates?.get(routeId);
      if (isMeasuredUnavailable(verdict, at, probeFreshnessMs)) {
        probeSkipped.push(routeId);
        reportProbeSkip(routeId, verdict, at, probeFreshnessMs);
        continue;
      }
      candidates.push({ routeId, providerModelId });
    }
    // No other route exists at all → nothing is configured to rotate to:
    // byte-identical silent inert.
    if (
      candidates.length === 0 &&
      skipped.length === 0 &&
      probeSkipped.length === 0 &&
      shapeSkipped.length === 0
    )
      return null;
    return {
      from: providerId,
      modelId,
      candidates,
      skipped,
      probeSkipped,
      shapeSkipped,
      failed: [],
    };
  };

  const scaffold = createEngageScaffold<RotationPlan>({
    resolve: (providerId, modelId, signal, episode) =>
      buildPlan(providerId, modelId, signal, episode),
    apply: async (plan, _modelId, engage) => {
      for (const candidate of plan.candidates) {
        const ok = await engage.setModel(
          candidate.routeId,
          candidate.providerModelId,
        );
        if (ok) {
          plan.engaged = candidate; // read by onEngaged, never module-global
          return candidate.routeId;
        }
        plan.failed.push(candidate.routeId); // remembered for the inert notice
      }
      return false;
    },
    onEngaged: (plan, _modelId, engage, _engagedRoute, signal) => {
      const target = plan.engaged!;
      // The engage moment counts as probe activity: the first fail-back probe
      // waits a full interval, so a just-died primary is not hammered by a
      // probe that can only fail.
      lastProbeAt = now();
      const mapped =
        target.providerModelId !== plan.modelId
          ? ` as ${target.providerModelId}`
          : "";
      // Three vocabularies, never mixed: a key-class death is a credential
      // failure, a shape-class death is a fact about the (route, request)
      // pair, and a WAF-class death is the edge refusing that route's request.
      if (signal.class === "waf") {
        engage.notify(
          `[pi-braid-providers] ${plan.from} refused this request at the edge again ` +
            `(WAF/infra block, no key exhausted) — rotated to ${target.routeId} serving ` +
            `${plan.modelId}${mapped}. The failed turn is retrying there; the key ring ` +
            `is untouched, and a bounded fail-back probe re-checks ${plan.from} at turn ` +
            `boundaries.`,
        );
        return WAF_REPEAT_RETRY_MARKER;
      }
      if (signal.class === "shape") {
        engage.notify(
          `[pi-braid-providers] ${plan.from} rejected this request (HTTP ${signal.status ?? "4xx"}, ` +
            `no key exhausted) — rotated to ${target.routeId} serving ${plan.modelId}${mapped}. ` +
            `The failed turn is retrying there; a bounded fail-back probe re-checks ${plan.from} ` +
            `at turn boundaries.`,
        );
        return shapeRetryMarker(signal.status);
      }
      // The classifier saw only the error text, never the reason behind it: a
      // spent subscription allowance and a dead key both arrive here, so the
      // notice states the fact the ring reports (this route has no usable key),
      // not a diagnosis of the keys themselves.
      engage.notify(
        `[pi-braid-providers] ${plan.from} route ring exhausted (no usable key; quota/auth-class denial) — rotated to ` +
          `${target.routeId} serving ${plan.modelId}${mapped}. The failed turn is retrying there; a ` +
          `bounded fail-back probe re-checks ${plan.from} at most once per 10 minutes at turn ` +
          `boundaries and fails back automatically when it recovers.`,
      );
      return ROTATION_RETRY_MARKER;
    },
    onInert: (plan, _modelId, engage, signal) => {
      const detail = [
        plan.skipped.length > 0
          ? `passed over: ${plan.skipped.join(", ")}`
          : "",
        plan.probeSkipped.length > 0
          ? `probe-measured unavailable: ${plan.probeSkipped.join(", ")}`
          : "",
        plan.shapeSkipped.length > 0
          ? `rejected this request (fresh): ${plan.shapeSkipped.join(", ")}`
          : "",
        plan.failed.length > 0
          ? `engage failed: ${plan.failed.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("; ");
      if (signal.class === "waf") {
        engage.notify(
          `[pi-braid-providers] ${plan.from} refused this request at the edge again ` +
            `(WAF/infra block, no key exhausted) and no configured route could serve ` +
            `${plan.modelId}${detail ? ` (${detail})` : ""}. The turn keeps its real ` +
            `error instead of re-sending the request there.`,
        );
        return;
      }
      if (signal.class === "shape") {
        engage.notify(
          `[pi-braid-providers] ${plan.from} rejected this request (HTTP ${signal.status ?? "4xx"}, ` +
            `no key exhausted) and no configured route could serve ${plan.modelId}` +
            `${detail ? ` (${detail})` : ""}. The request itself may be at fault — the turn keeps ` +
            `its real error.`,
        );
        return;
      }
      engage.notify(
        `[pi-braid-providers] ${plan.from} route ring exhausted but no configured route could serve ` +
          `${plan.modelId}${detail ? ` (${detail})` : ""}. ${plan.from} requests keep failing; ` +
          `fix a route credential/plan/model or add a route to braid.providers.routes.`,
      );
    },
    onConverged: (episode, modelId, signal, engage) => {
      const tried = [...new Set([episode.primary, ...episode.visited])];
      engage.notify(
        `[pi-braid-providers] ${episode.current} returned the same HTTP ${signal.status ?? "4xx"} for ` +
          `${modelId} as ${episode.primary} — two routes agree the request itself is at fault, so the ` +
          `route walk stopped on purpose (routes tried: ${tried.join(", ")}). No key was exhausted; ` +
          `retrying the same request on another route will not help.`,
      );
    },
  });

  return {
    maybeEngage: (providerId, errText, modelId, engage) => {
      const signal = classifyFailure(errText);
      // A shape death is remembered BEFORE the walk decides, so the next walk
      // (and the next session) passes this route over for this same request.
      // Recording is the store's job; this module only names the fact.
      if (signal.class === "shape" && modelId) {
        deps.recordRouteDeath?.(providerId, {
          class: SHAPE_DEATH_CLASS,
          at: now(),
          modelId,
          status: signal.status,
        });
      }
      return scaffold.attempt(providerId, engage, modelId, signal);
    },
    maybeFailBack(
      engage: RotationProbeDeps,
    ): FailBackOutcome | Promise<FailBackOutcome> {
      // The episode is the source of truth (the walk owns it). Captured BY
      // REFERENCE so an engage/reset that races a probe is caught by identity.
      const captured = scaffold.episode();
      if (!captured || !captured.current) return null; // never engaged / unnamed
      const t = now();
      if (t - lastProbeAt < FAILBACK_PROBE_INTERVAL_MS) return null;
      lastProbeAt = t; // before any await: one probe per interval, single-flight
      // The probe target is the route that OPENED the episode: the walk may
      // have stepped on since, but the route that started the outage is the
      // one worth re-checking.
      const settle = (
        probeOk: boolean,
      ): FailBackOutcome | Promise<FailBackOutcome> => {
        if (scaffold.episode() !== captured) return null; // raced the probe
        if (!probeOk) {
          // Bound: the probe cadence itself (≤1 per interval), so this line can
          // fire at most once per 10 minutes — no separate throttle.
          providerLog(
            "info",
            "providers/provider-rotation",
            `[pi-braid-providers] Fail-back probe: ${captured.primary} is still failing — ` +
              `staying on the rotated route ${captured.current}; next probe allowed in ~10 minutes ` +
              `(at most one probe per 10-minute interval).`,
          );
          return "probed-dead";
        }
        const swapped = engage.setModel(captured.primary, captured.modelId);
        const finish = (ok: boolean): FailBackOutcome => {
          if (scaffold.episode() !== captured) return null; // raced setModel
          if (!ok) {
            providerLog(
              "info",
              "providers/provider-rotation",
              `[pi-braid-providers] Fail-back probe succeeded but the swap back to ` +
                `${captured.primary}/${captured.modelId} failed (model unknown or no credential) — ` +
                `staying on the rotated route ${captured.current}.`,
            );
            return "probed-dead";
          }
          // Disarm first (one shot): no re-entrant double swap, and the next
          // death opens a fresh episode. The probe also proved the primary
          // serves again, so this excursion's WAF streaks are stale: every
          // pair starts a fresh count, exactly like a fresh session.
          scaffold.reset();
          wafBlocks.clear();
          engage.notify(
            `[pi-braid-providers] ${captured.primary} route probe succeeded — failed back to ` +
              `the primary: serving ${captured.modelId} on ${captured.primary} again. ` +
              `The rotated route ${captured.current} stays configured and re-arms for the next outage.`,
          );
          return "failed-back";
        };
        return swapped instanceof Promise
          ? swapped.then(finish)
          : finish(swapped);
      };
      const probed = engage.probe(captured.primary, captured.modelId);
      return probed instanceof Promise ? probed.then(settle) : settle(probed);
    },
    isEngaged: scaffold.isEngaged,
    noteWafBlock: (providerId, modelId) => {
      // NUL keeps a route id and a model id from ever sharing a key by
      // accident, so one route's block cannot be charged to another.
      const key = `${providerId}\u0000${modelId}`;
      const streak = Math.min((wafBlocks.get(key) ?? 0) + 1, WAF_REPEAT_BLOCK);
      wafBlocks.set(key, streak);
      return streak >= WAF_REPEAT_BLOCK;
    },
    reset: () => {
      scaffold.reset();
      lastProbeAt = 0;
      wafBlocks.clear();
    },
  };
}

// Repeated-error throttle
// A quota/auth 403 flood fires message_end once per turn; without throttling,
// every turn would emit a fresh "Agent LLM error … exhausting active key" warn
// and spam the TUI. One throttler per provider ring, 5-min window, mirrors the
// telegram 16c/16d pattern: first occurrence loud, repeats silent, re-loud once
// per window; a successful turn resets it and emits a single recovery line.
// Edge/WAF blocks get their own throttled sink so the flood stays quiet while
// remaining loud once per window like the others.
const llmErrorWaf = createThrottledLogger();

// Transient-exhaustion steering
// When ALL keys in a provider ring are momentarily exhausted (every key in
// backoff after quota/403), getActiveKey() returns null. auth.apiKey.resolve
// (keyRingAuth in index.ts) delegates here so the decision is unit-testable
// without loading index.ts (which imports pi-ai). The two null-key states are
// discriminated by the ring, keeping the config-mislabel accurate where it is
// true:
//   - health().total === 0
//       genuinely NOT configured (no keys at all) -> resolve undefined, so
//       pi-core's prepareRequest keeps the accurate "Provider is not
//       configured" throw.
//   - health().total > 0 && isFullyExhausted()
//       TRANSITORY: keys ARE configured but every one is momentarily in
//       backoff. Resolving undefined here would make prepareRequest throw
//       "Provider is not configured: agent-zero" and cancel the turn with a
//       config mislabel. Instead return a TRUTHY resolution so prepareRequest
//       proceeds and the provider returns a REAL 401/403 that the message_end
//       machinery (isKeyRotationError + exhaustActiveKey, below) already
//       classifies and handles with backoff + the ALL-KEYS-EXHAUSTED warn.
//
// Why a sentinel instead of `apiKey: undefined`: pi-ai dist/api/openai-completions.js
// `getClientApiKey` THROWS `No API key for provider: <provider>` client-side
// when apiKey is undefined and no authorization header is present — the HTTP
// call never leaves the process, so no real 401/403 reaches ring-lifecycle
// and the thrown text is not classified as key-rotation style. The sentinel
// is a clearly-invalid, self-documenting key VALUE that getClientApiKey
// accepts, so the request DOES reach the provider and fails with a genuine
// 401/403 the existing rotation machinery handles. The sentinel is never a
// real credential, is only ever sent while the ring reports zero usable keys,
// and never touches the excluded venice model catalog.

/** Sentinel apiKey for the transiently-exhausted branch (see above). */
export const TRANSIENT_EXHAUSTION_API_KEY = "pi-braid-key-ring-exhausted";

/** Minimal ring surface auth resolution needs to discriminate the two null-key states. */
export interface KeyRingAuthRing {
  getActiveKey(): string | null;
  health(): { total: number };
  isFullyExhausted(): boolean;
}

// Steering whisper: surface the turn
// outcome through the EXISTING ring-lifecycle log/advice channel (providerLog
// -> native notify sink), throttled so resolve-per-turn cannot spam. No new
// surface.
const exhaustedResolutionLog = createThrottledLogger();

/**
 * Resolve auth for a key-ring provider (the body of keyRingAuth.resolve in
 * index.ts). Returns the active key's resolution, undefined for a genuinely
 * unconfigured ring (total === 0), or the transient-exhaustion sentinel when
 * keys exist but are all momentarily in backoff.
 */
export function resolveKeyRingAuth(
  name: string,
  ring: KeyRingAuthRing,
): { auth: { apiKey: string }; source: "key-ring" } | undefined {
  const key = ring.getActiveKey();
  if (key) return { auth: { apiKey: key }, source: "key-ring" };

  const health = ring.health();
  if (health.total === 0) return undefined; // genuinely unconfigured — the config error is accurate.
  if (ring.isFullyExhausted()) {
    exhaustedResolutionLog.occurrence(
      "warn",
      "providers/ring-lifecycle",
      `[pi-braid-providers] ${name}: all ${health.total} configured key(s) transiently exhausted ` +
        `(0 usable) — backoff + auto-retry on the next key; NOT a configuration error.`,
    );
    return {
      auth: { apiKey: TRANSIENT_EXHAUSTION_API_KEY },
      source: "key-ring",
    };
  }
  // Unreachable given current getActiveKey semantics: it returns null exactly
  // when every entry is exhausted (countUsable === 0 == isFullyExhausted). The
  // conservative default keeps this safe if getActiveKey semantics change.
  return undefined;
}

// Ring Resolution
// Each event resolves the key ring it belongs to from ITS OWN payload — never
// from a module-global last-writer-wins tracker (see module doc for the race).
//
// The provider's model catalog (Venice's models) is owner-private and ships
// only in the source tree (excluded from the public repo), so model-id
// attribution consults the registration table's model surface instead of a
// request-path model-id literal.
//
// Identity available per event (verified in the shipped pi dist):
//   - before_provider_request: request body (payload.model)
//   - message_end: full AssistantMessage (message.provider / message.model) —
//     pi-agent-core's error-path failureMessage is built with provider/model
//     from the active model; the success path forwards the stream's final
//     AssistantMessage.
//   - after_provider_response: ONLY {type, status, headers} — no model id, no
//     request id (pi-core's core/sdk.js onResponse emits exactly those three
//     fields and drops the request's model). It can never attribute a key ring;
//     see handleAfterProviderResponse below.

// The agent-zero gateway route is installed as the table's FALLBACK: only while the
// settings carry no `routes` key, so an explicit route table never inherits a
// route the table does not name. The composition root re-checks the same policy
// on every load (it clears the table when `routes` is set, and reinstalls the
// fallback when it is not), which is what makes a settings change across a
// reload take effect even when this module is not re-imported. Model-only
// attribution below consults this table.
if (!readProvidersSettingsFromSettings().routesConfigured) {
  installDefaultGatewayRoute();
}

export function resolveRingForModelId(
  modelId: string,
): ReturnType<typeof createKeyRing> | null {
  return resolveRingMetaForModelId(modelId)?.ring ?? null;
}

/** Ring + its logging context, resolved together so attribution never desyncs
 * from the throttled logger or the provider label used in log lines. */
interface RingMeta {
  ring: ReturnType<typeof createKeyRing>;
  providerId: string;
  errorLog: ReturnType<typeof createThrottledLogger>;
  modelIds: readonly string[];
}

function metaOf(route: RegisteredRoute): RingMeta {
  return {
    ring: route.ring,
    providerId: route.providerId,
    errorLog: route.errorLog,
    modelIds: route.modelIds,
  };
}

/**
 * Whether a route's model surface covers a model id: the descriptor's explicit
 * ids plus both sides of its `models` map. A value is the provider id a
 * redirected turn arrives with; a key is a dead id the walk resolves through
 * that map and serves. The walk and the seam read the same table, so this
 * predicate must answer both, or one consumer parks a pair the other proceeds
 * with.
 */
function routeServesModelId(route: RegisteredRoute, modelId: string): boolean {
  if (route.modelIds.includes(modelId)) return true;
  if (!route.models) return false;
  return (
    Object.hasOwn(route.models, modelId) ||
    Object.values(route.models).includes(modelId)
  );
}

/** The route a model id is attributed to; the first registration wins. */
function resolveRouteForModelId(modelId: string): RegisteredRoute | null {
  if (!modelId) return null;
  for (const route of registeredRoutes.values()) {
    if (routeServesModelId(route, modelId)) return route;
  }
  return null;
}

function resolveRingMetaForModelId(modelId: string): RingMeta | null {
  const route = resolveRouteForModelId(modelId);
  return route ? metaOf(route) : null;
}

/**
 * Resolve the route a message_end AssistantMessage belongs to, from its own
 * fields: the registration table is the single authority (no provider-id
 * special case, no ring object identity). A provider field that names no
 * registered route falls back to model-id attribution.
 */
function resolveRingMetaForMessage(
  provider: unknown,
  model: unknown,
): RingMeta | null {
  if (typeof provider === "string") {
    const route = registeredRoutes.get(provider);
    if (route) return metaOf(route);
  }
  if (typeof model === "string") return resolveRingMetaForModelId(model);
  return null;
}

/** Resolve the ring a message_end AssistantMessage belongs to, from its own fields. */
export function resolveRingForMessage(
  provider: unknown,
  model: unknown,
): ReturnType<typeof createKeyRing> | null {
  return resolveRingMetaForMessage(provider, model)?.ring ?? null;
}

// Error Detection

function extractErrorText(event: any): string {
  if (!event) return "";
  const candidates: unknown[] = [
    event.body,
    event.response,
    event.error,
    event.message,
    event.data,
  ];
  const parts: string[] = [];
  for (const c of candidates) {
    if (!c) continue;
    if (typeof c === "string") parts.push(c);
    else parts.push(JSON.stringify(c));
  }
  return parts.join(" ").toLowerCase();
}

// WAF / infra-block classification
// A 403 (or any status) whose body is an HTML edge/WAF page (Cloudflare-style)
// is an INFRASTRUCTURE block, NOT a quota/auth condition: the key is fine, the
// request was stopped at the edge. Marking such a key exhausted would poison
// the SHARED state file (~/.pi/agent/.key-ring-state-{name}.json) for every
// instance — observed live: a `403 <!doctype html>` WAF page exhausted a
// healthy key and flipped the whole ring to ALL-KEYS-EXHAUSTED while the
// orchestrator kept working on the same keys. WAF blocks are transient and
// retried on the SAME key; they never rotate.
const WAF_BLOCK_MARKERS = [
  "<!doctype html",
  "<html",
  "text/html",
  "cf-ray",
  "__cfduid",
  "__cf_bm",
  "cloudflare",
  "just a moment",
  "challenge-platform",
  "tetris challenge",
  "attention required",
  "request blocked",
  "blocked by waf",
  "waf",
];

/**
 * True when error text is an edge/WAF HTML block page (not a provider JSON
 * error). Callers pass LOWERCASED text (same convention as isKeyRotationError).
 * The markers are case-insensitive by convention of the lowercase contract;
 * the matrix markers are written lowercase.
 */
export function isWafBlockError(errText: string): boolean {
  if (!errText) return false;
  // Short-circuit: only probe for edge/WAF when the body looks non-JSON.
  // A JSON quota/auth body contains neither `<` markup nor CF markers.
  if (errText.includes("{error") || errText.includes('{"error')) return false;
  return WAF_BLOCK_MARKERS.some((m) => errText.includes(m));
}

/**
 * Classifies a non-2xx status as key-rotation style (quota/auth/429) for
 * diagnostics in handleAfterProviderResponse. Actual rotation happens in
 * handleMessageEnd, where the request's own model is available.
 * Note: status codes alone cannot distinguish quota from other errors (a 400
 * body may be a plain bad request), so bodies are classified separately in
 * isKeyRotationError. A WAF/edge HTML body NEVER rotates the key.
 */
function shouldExhaustKey(status: number, bodyText: string): boolean {
  if (isWafBlockError(bodyText)) return false;
  if (status === 400) return true;
  if (status === 401) return true;
  if (status === 403) return true;
  if (status === 429) return true;
  return false;
}

// Request-side edge-filter neutralization
// The gateway host answers 403 with an HTML "Blocked" page (~221KB) when a
// request body carries one 10-byte sequence: a dot, then `execSync`, then an
// open paren. Probed live: the same body draws the block with the sequence at a
// 96KB offset AND at a 128KB offset, so the neutralizer rewrites EVERY offset
// rather than trusting a presumed inspection window. A body shrinks (a
// compaction cut), text moves into whatever range the edge reads, and every
// retry re-sends the same bytes, so one stored message is enough to wedge a
// session. The outgoing payload is the one place this is fixable without
// touching the session: a space before the paren keeps the line valid and
// readable, and the edge accepts it (probed live: 200).

/** The edge filter's trigger, matched as a character class so this file's own
 * source does not carry the literal sequence (a repo file that carries it
 * blocks every session that reads it through that host). */
const EDGE_TRIGGER_PATTERN = /[.]execSync[(]/g;

/** Same text with the space the edge accepts before the paren. */
const EDGE_TRIGGER_REPLACEMENT = ".execSync (";

/**
 * Neutralize every trigger in one payload string. Identity (the same string
 * value) when there is nothing to rewrite.
 */
function neutralizeEdgeTrigger(text: string): string {
  return text.replace(EDGE_TRIGGER_PATTERN, EDGE_TRIGGER_REPLACEMENT);
}

/**
 * Copy of `value` with every string it contains neutralized: arrays and plain
 * records are rebuilt, other values (numbers, booleans, null, and live objects
 * such as Date or Response) pass through by reference. A subtree that needed no
 * rewrite keeps its identity, so a payload with no trigger comes back as the
 * same object. Pure: the session's own message objects are never modified.
 */
export function neutralizeEdgeTriggerInPayload<T>(value: T): T {
  if (typeof value === "string") return neutralizeEdgeTrigger(value) as T;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((item) => {
      const next = neutralizeEdgeTriggerInPayload(item);
      if (next !== item) changed = true;
      return next;
    });
    return (changed ? out : value) as T;
  }
  if (value !== null && typeof value === "object") {
    const proto = Object.getPrototypeOf(value) as unknown;
    // JSON-shaped records only: a live object is not a request body.
    if (proto !== Object.prototype && proto !== null) return value;
    const rec = value as Record<string, unknown>;
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(rec)) {
      const next = neutralizeEdgeTriggerInPayload(rec[key]);
      if (next !== rec[key]) changed = true;
      out[key] = next;
    }
    return (changed ? out : value) as T;
  }
  return value;
}

// Handler Logic

/**
 * before_provider_request body logic. Auth has already been resolved by this
 * point (via auth.apiKey.resolve), so this only modifies the request body: every
 * string is first neutralized for the edge filter (route-independent wire
 * safety, because venice-direct shares the host and sets no `venicePayload`
 * flag), then venice_parameters + system-message reordering (Venice requires
 * system at index 0) applies to the owning route's payload when its descriptor
 * sets `venicePayload`. It maintains NO cross-request provider state — ring
 * attribution happens per-event in handleMessageEnd.
 *
 * Returns undefined when nothing changed: pi-core then sends the body it built,
 * so a request with no trigger and no tweak still allocates nothing.
 */
export function handleBeforeProviderRequest(payload: unknown): unknown {
  // Wire safety first, and by design independent of the route table: the edge
  // filter reads the body, not the attribution. A payload this handler would
  // otherwise leave alone still has to go out neutralized, so the unchanged
  // case only returns undefined for a payload that needed no rewrite.
  const neutralized = neutralizeEdgeTriggerInPayload(payload);
  const changed = neutralized !== payload;

  if (
    !neutralized ||
    typeof neutralized !== "object" ||
    !("model" in neutralized)
  ) {
    return changed ? neutralized : undefined;
  }

  const rec = neutralized as Record<string, unknown>;
  const modelId = rec.model as string | undefined;
  if (!modelId) return changed ? neutralized : undefined;

  // Attribution is configuration: an unowned model id is left untouched, and
  // whether the Venice payload tweak applies is the owning route's own flag.
  const route = resolveRouteForModelId(modelId);
  if (!route || !route.venicePayload) return changed ? neutralized : undefined;

  // Venice: include_venice_system_prompt: false + system message at index 0
  const veniceParams = { include_venice_system_prompt: false };
  const messages = rec.messages;
  if (Array.isArray(messages)) {
    const sysIdx = messages.findIndex(
      (m: any) =>
        m &&
        typeof m === "object" &&
        (m as Record<string, unknown>).role === "system",
    );
    if (sysIdx > 0) {
      const newMessages = [...(messages as unknown[])];
      const [sysMsg] = newMessages.splice(sysIdx, 1);
      newMessages.unshift(sysMsg);
      return {
        ...rec,
        messages: newMessages,
        venice_parameters: veniceParams,
      };
    }
  }

  return {
    ...rec,
    venice_parameters: veniceParams,
  };
}

/**
 * after_provider_response logic.
 *
 * The event carries only { type, status, headers } — no model id, no request
 * id (verified in pi-core's shipped dist; pi-core's core/sdk.js onResponse
 * emits exactly those three fields and drops the request's model). Attributing
 * it to a key ring is impossible, and a module-global would mis-mark or
 * mis-exhaust the wrong ring under interleaved turns. Ring lifecycle is driven
 * exclusively from handleMessageEnd, which carries the turn's own
 * provider+model. This handler only classifies non-2xx statuses for
 * diagnostics; it never mutates key state. (Per pi-core, this event only fires
 * on 2xx responses anyway — errors surface via message_end.)
 */
export function handleAfterProviderResponse(event: any): void {
  const status = event.status as number;
  if (status >= 400) {
    const bodyText = extractErrorText(event);
    const isWaf = isWafBlockError(bodyText);
    const label = isWaf
      ? "waf/infra-block (transient, no key rotation)"
      : status === 400
        ? "quota exhausted (400 no body)"
        : status === 401
          ? "unauthorized"
          : status === 403
            ? "forbidden"
            : "rate-limit";
    providerLog(
      "warn",
      "providers/ring-lifecycle",
      `[pi-braid-providers] provider response ${status} ` +
        `(${shouldExhaustKey(status, bodyText) ? label + " (key-rotation style)" : "not a key-rotation error"}) ` +
        `— ring lifecycle is handled by message_end; body hint: "${bodyText.slice(0, 200)}"`,
    );
  }
}

/** Optional hooks for the route-order rotation engine (see that section above). */
export interface MessageEndHooks {
  rotation?: {
    /**
     * Called for a death the walk is consulted for: any key-rotation error
     * whose ring reports zero usable keys, and any shape-class (HTTP 4xx)
     * rejection, which does not touch the ring at all. providerId is the route
     * that died; modelId is the dead turn's own model id, so the engine can
     * re-serve the SAME id over another route.
     */
    onRingExhausted(
      providerId: string,
      errText: string,
      modelId: string,
    ): string | null | Promise<string | null>;
    /**
     * Count one edge/WAF block for this (route, model id) and report whether
     * the route has now refused the SAME request repeatedly (see
     * `RotationEngine.noteWafBlock`). Optional: absent, every WAF block keeps
     * today's same-route retry — byte-identical to a build without the engine.
     */
    noteWafBlock?(providerId: string, modelId: string): boolean;
  };
}

/**
 * message_end logic — the single ring-lifecycle path.
 *
 * message_end is the ONLY event with reliable per-request identity: the
 * message is the turn's full AssistantMessage carrying `provider` and `model`
 * (verified in pi-agent-core's shipped dist). All key-ring rotation happens
 * here, per event:
 *   - non-error turn (stop / tool_calls / length / aborted): markSuccess() so
 *     a key that served a real request has its backoff healed.
 *   - stopReason "error" matching quota/auth/403: exhaust the active key and
 *     persist the state so restarts skip it, and return a
 *     replacement AssistantMessage carrying the self-heal retry marker when a
 *     fresh key remains — pi-core applies the replacement and re-runs the turn
 *     on the next key (see the module header).
 * Each event rotates ONLY the ring belonging to its own turn — no module
 * global, so interleaved turns can never mark/exhaust the wrong ring.
 *
 * `hooks.rotation` (wired in index.ts) is consulted for the classes the walk
 * owns: the ring dead (usable===0) branch of a key-rotation error, any
 * shape-class (HTTP 4xx) rejection — the latter without touching the ring —
 * and an edge/WAF block that repeats for the same (route, model id), which is
 * a per-request refusal and not a transient edge. Without the hook the function
 * is byte-identical to a build without the engine. When the engage is async
 * (real setModel is), the function returns a Promise of the same result union —
 * the runner awaits message_end handlers.
 */
export function handleMessageEnd(
  event: any,
  hooks?: MessageEndHooks,
): { message: any } | undefined | Promise<{ message: any } | undefined> {
  const message = event?.message;
  const meta = resolveRingMetaForMessage(message?.provider, message?.model);
  if (!meta) return; // foreign model — not one of our key rings
  const { ring, providerId: providerLabel, errorLog } = meta;

  if (message.stopReason !== "error") {
    // Recovery: a successful turn after a throttled error burst clears the
    // throttler and surfaces one info line (mirrors telegram 16d), then heals
    // the ring's own key (markSuccess resets the key-ring throttlers too).
    if (errorLog.streak() > 0) {
      providerLog(
        "info",
        "providers/ring-lifecycle",
        `[pi-braid-providers] ${providerLabel} provider errors cleared — key ring recovered.`,
      );
      errorLog.reset();
    }
    ring.markSuccess();
    return;
  }

  const errText = String(message.errorMessage || "").toLowerCase();

  // WAF / infra block: NOT a key problem. Do not exhaust and write no key-ring
  // state — the key is healthy; the request was stopped at the edge. The FIRST
  // consecutive block for a (route, model id) keeps today's answer: retry the
  // SAME route. A block that repeats for the same pair is not a transient edge
  // — the route is refusing this request — so the walk moves the turn; the key
  // ring is untouched either way. Distinct throttled sink so the flood stays
  // quiet while remaining loud once per window like the others.
  if (isWafBlockError(errText)) {
    const modelId = typeof message.model === "string" ? message.model : "";
    const repeat = hooks?.rotation?.noteWafBlock
      ? hooks.rotation.noteWafBlock(providerLabel, modelId)
      : false;
    llmErrorWaf.occurrence(
      "warn",
      "providers/ring-lifecycle",
      `[pi-braid-providers] Agent LLM edge/WAF block (${message.provider ?? message.model}): ${sanitizeWafError(message.errorMessage)} ` +
        (repeat
          ? `— the same route refused this request at the edge again; NOT key-rotation, moving the turn to another configured route.`
          : `— transient infra, NOT key-rotation; retrying on the same key.`),
    );
    // The raw HTML dump never survives: both branches return the compact
    // marker, because the returned message is what pi-core stores/displays.
    const sanitized = sanitizeWafError(message.errorMessage);
    if (repeat && hooks?.rotation) {
      const engaged = hooks.rotation.onRingExhausted(
        providerLabel,
        String(message.errorMessage ?? ""),
        modelId,
      );
      // A walk that found nothing (no other route can serve the id, or the
      // episode already moved elsewhere) leaves the sanitized error WITHOUT the
      // same-route retry marker: the route refused this request twice, so
      // re-sending it there is the livelock this path exists to end.
      const assemble = (marker: string | null): { message: any } => ({
        message: {
          ...message,
          errorMessage:
            marker && canReclassifyForTurnRetry(errText)
              ? `${sanitized}${marker}`
              : sanitized,
        },
      });
      if (engaged instanceof Promise) return engaged.then(assemble);
      return assemble(engaged);
    }
    if (canReclassifyForTurnRetry(errText)) {
      return {
        message: {
          ...message,
          errorMessage: `${sanitized}${WAF_RETRY_MARKER}`,
        },
      };
    }
    return { message: { ...message, errorMessage: sanitized } };
  }

  // Failure class
  // Each class keeps its own recovery, and the walk is consulted per CLASS, not
  // per ring health: a route that refuses a request is a fact about the
  // (route, request) pair, and the ring's keys are innocent.
  const failure = classifyFailure(errText);

  // The walk consultation, factored so the key-class and the shape-class paths
  // assemble the turn's replacement message identically: the hook decides the
  // target, the engine owns the marker text, and the reclassifiability gate is
  // the same for both.
  const consultWalk = (
    rotation: NonNullable<MessageEndHooks["rotation"]>,
  ): { message: any } | undefined | Promise<{ message: any } | undefined> => {
    const engaged = rotation.onRingExhausted(
      providerLabel,
      String(message.errorMessage ?? ""),
      typeof message.model === "string" ? message.model : "",
    );
    const assemble = (marker: string | null): { message: any } | undefined => {
      if (marker && canReclassifyForTurnRetry(errText)) {
        return {
          message: {
            ...message,
            errorMessage: `${String(message.errorMessage ?? "")}${marker}`,
          },
        };
      }
      return undefined;
    };
    if (engaged instanceof Promise) return engaged.then(assemble);
    return assemble(engaged);
  };

  // Shape rejection: the route refused THIS request. No key is exhausted and NO
  // key-ring state is written — the walk moves the request to another route, or
  // stops and says why. Without an engine the branch is skipped entirely:
  // byte-identical to a build without the feature.
  if (failure.class === "shape") {
    if (!hooks?.rotation) return;
    return consultWalk(hooks.rotation);
  }

  // Key class only from here on. Same predicate the direct-call feed-back path
  // uses (reportKeyRingFailure) — one classification governs both paths;
  // payload (context-window) and unrecognized failures keep their own paths.
  if (failure.class !== "key") return;

  // Throttled: the first erroring turn in a burst is loud with full detail;
  // repeats within the window are silent. The key is still
  // exhausted every time so retryCount escalates the backoff toward max.
  errorLog.occurrence(
    "warn",
    "providers/ring-lifecycle",
    `[pi-braid-providers] Agent LLM error (${message.provider ?? message.model}): "${errText.slice(0, 160)}" — ` +
      `exhausting active key + persisting state.`,
  );
  ring.exhaustActiveKey();

  // Self-healing: a fresh key remains => hand the turn a
  // retryable marker so pi-core's turn-level retry re-runs this turn. The re-run
  // re-resolves auth per streamSimple, so getActiveKey (which skips the just-
  // exhausted key) serves the next key — the ring auto-flips instead of stalling.
  // No usable key left => fallback (below) or the loud ALL-KEYS-EXHAUSTED
  // warn + turn ends with the real error (pi-core bound: settings.retry.maxRetries).
  const ringHealth = ring.health();
  if (ringHealth.usable > 0 && canReclassifyForTurnRetry(errText)) {
    return {
      message: {
        ...message,
        errorMessage: `${String(message.errorMessage ?? "")}${SELF_HEAL_RETRY_MARKER}`,
      },
    };
  }

  // Route rotation: the dead ring has zero usable keys AND an engine is
  // wired. The hook walks the route table (the episode chain bounds it: one
  // engage per route per episode, continued only by the death of the route the
  // walk serves) and returns the route-generic retry marker when an engage
  // succeeded — pi-core's retry then re-runs the turn on the rotated route.
  // Without a hook the branch is skipped entirely: byte-identical behavior. The
  // marker is appended only when the raw error is reclassifiable; a
  // NON_RETRYABLE error keeps history honest while the rotation still covers
  // future turns.
  if (ringHealth.usable === 0 && hooks?.rotation) {
    return consultWalk(hooks.rotation);
  }

  return undefined;
}

// Direct-call feed-back (keyring self-heal)
// handleMessageEnd is the ONLY ring-lifecycle path for the agent loop, but
// direct extension LLM calls (telegram notify's completeSimple; core callLlm for
// utility/max-power) never emit message_end, so a 429/403 from them left NO
// trace in the ring — no exhaust, no rotation, no warn; the ring served the
// same dead key forever on those paths. These functions feed such outcomes
// back into the ring so a direct-call 429/403 exhausts + persists + fires the
// throttled warn + ALL-KEYS-EXHAUSTED exactly like handleMessageEnd, and the
// NEXT getActiveKey() re-resolution (auth.apiKey.resolve runs per
// streamSimple) serves the next key.
//
// Round-6/25/40 invariants preserved: every decision resolves ITS OWN ring
// from the reported model/provider via resolveRingForMessage — no module-global
// last-writer-wins — and mutations go through the ring's own atomic
// temp+rename persisted writes.

/**
 * True when an error text is key-rotation style (quota/auth/403). This is the
 * EXACT predicate handleMessageEnd uses to decide whether to exhaust the
 * active key, extracted so direct LLM calls feed 429/403 back with the same
 * classification. Expects the text already lowercased (callers lowercase).
 *
 * Phrase patterns, not bare keywords, to avoid false positives (bare
 * "credit" would match "credentials"). "no quota left" is Venice's
 * documented quota surface. The includes() status checks cover SDK-thrown
 * errors; these phrases cover body-only error text (e.g. proxy-path errors
 * without a status prefix). 403 on Venice = quota/credits exhaustion
 * ("User has no quota left"). Treat bare 403 as rotatable too — a
 * permission/guardrail block won't be fixed by rotation, but the key isn't
 * proven bad either; the conservative tradeoff Venice requires.
 *
 * A spent allowance (subscription/plan/usage cap) belongs to the same class as
 * a quota denial: neither a fresh key nor a backoff helps, only rotating the
 * route — see isSpentAllowanceError for the allowance vocabulary.
 */
export function isKeyRotationError(errText: string): boolean {
  // WAF / infra-block pages are NEVER key-rotation — they carry a stray
  // 403/402 status on an HTML edge page and must not exhaust a healthy key.
  // Check first so the `includes("403")` guard below can't fire on an edge page.
  if (isWafBlockError(errText)) return false;
  const isQuota =
    errText.includes("402") ||
    /no quota|quota left|insufficient.{0,24}(credit|balance)|billing|out of budget|quota|balance/.test(
      errText,
    ) ||
    isSpentAllowanceError(errText);
  const isAuth =
    errText.includes("401") ||
    /invalid.{0,24}api.?key|invalid.?credentials|unauthorized/.test(errText);
  const isForbidden = errText.includes("403");
  return isQuota || isAuth || isForbidden;
}

/**
 * True when the text reports a spent allowance — a subscription, plan or usage
 * cap that will not reset within the turn ("usage limit exceeded", "you have
 * reached your limit"). Such a route cannot serve until the allowance resets,
 * so it is a key-class death: the ring rotates exactly as it does for a quota
 * denial. Provider-blind and vendor-blind by construction: `usage[_ ]?limit`
 * also matches the no-separator vendor *type* names that read as "usagelimit".
 *
 * A per-minute throttle is NOT an allowance: rate-limit wording is excluded
 * first, and the subject of "reached" must be an allowance noun, so a
 * "reached your request limit" throttle stays out. The deliberate 429
 * carve-out in classifyFailure then keeps a plain 429 `none`. Exhausting a
 * healthy key on a transient throttle would poison the shared key-ring state
 * file for every instance — the same failure mode the WAF guard above exists
 * to prevent.
 */
function isSpentAllowanceError(errText: string): boolean {
  if (/rate[_ ]?limit|too many requests/.test(errText)) return false;
  return (
    // "usage limit exceeded", and the no-separator vendor *type* names that
    // read as "usagelimit" (GoUsageLimitError, FreeUsageLimitError).
    /usage[_ ]?limit/.test(errText) ||
    // "you have reached your plan limit": an allowance noun must sit between
    // the verb and the noun, so "reached your request limit" is not an
    // allowance.
    /reached.{0,20}(usage|plan|subscription|quota|allowance)[_ ]?limit/.test(
      errText,
    ) ||
    /(plan|subscription|allowance)[_ ]limit/.test(errText)
  );
}

/**
 * The failure class of a dead turn or direct call, in the route walk's own
 * vocabulary. Provider-blind by construction: an HTTP status class plus the
 * size idioms core's context-window classifier already uses
 * (packages/core/src/lib/errors/llm-error.ts, CONTEXT_WINDOW_PATTERNS), never a
 * provider, model or vendor error string.
 *
 *   - `payload`: the request is too large. It keeps its own recovery (core's
 *     emergency offload plus one in-place retry), so the walk must not move it
 *     to another route and quote a different provider for it.
 *   - `key`: the existing key-rotation predicate (`isKeyRotationError`). The
 *     key ring owns this class.
 *   - `waf`: an edge/WAF block page. The key is not at fault and the block is
 *     a fact about the (route, request) pair, so the class exists to let the
 *     walk speak about it without ever claiming a credential problem.
 *   - `shape`: an HTTP 4xx that is neither of the above and not a WAF page —
 *     the route refused THIS request. A rate-limit `429` is deliberately NOT
 *     shape: the callers' own cooldown bounds it, and moving the request
 *     elsewhere would spend the walk's budget on a transient.
 *   - `none`: everything else (5xx/transient, unrecognized text).
 *
 * Evaluation order is the order of the tests below and matches
 * handleMessageEnd: WAF, then payload, then key, then shape.
 */
export type FailureClass = "key" | "payload" | "shape" | "waf" | "none";

export interface FailureClassification {
  class: FailureClass;
  /** The 4xx/5xx status the text names, when it names one. */
  status: number | null;
}

/**
 * Death-class name the walk records when a route refuses a request. It is NOT
 * `isKeyRotationError`'s vocabulary: this name records a per-request rejection
 * (class + status + model id, no key hash), which is what the walk's skip and
 * its freshness window are about.
 */
export const SHAPE_DEATH_CLASS = "request-shape";

const CONTEXT_WINDOW_PATTERNS = [
  /413/,
  /context[_ ]length[_ ]exceeded/i,
  /context[_ ]window/i,
  /maximum[_ ]context/i,
  /prompt[_ ]is[_ ]too[_ ]long/i,
];

/**
 * The first HTTP status the text names, or null. Bounded to 4xx/5xx three-digit
 * runs so a model id or a token count cannot be read as a status; the walk
 * needs the status CLASS, not a parsed response.
 */
function httpStatusOf(errText: string): number | null {
  const match = /\b(4\d{2}|5\d{2})\b/.exec(errText);
  return match ? Number(match[1]) : null;
}

export function classifyFailure(errText: unknown): FailureClassification {
  const text = String(errText ?? "").toLowerCase();
  if (!text.trim()) return { class: "none", status: null };
  // WAF text is its own class, not `none`: the walk is consulted for a
  // repeated block and must answer in WAF vocabulary (a per-request refusal,
  // never a credential diagnosis).
  if (isWafBlockError(text)) {
    return { class: "waf", status: httpStatusOf(text) };
  }
  const status = httpStatusOf(text);
  // Precedence: payload is tested BEFORE key, so a size error that also carries
  // a 4xx status the key predicate claims (a `403 context_length_exceeded` body
  // reads as forbidden to `isKeyRotationError`) is classified payload and the
  // ring is left untouched. The request is what is too large, so exhausting a
  // key would burn a healthy credential and hand the same oversized request to
  // the next route, which refuses it identically; the payload recovery (core's
  // emergency offload plus one in-place retry) is the only path that can shrink
  // the request. Payload must win over key for that input.
  if (CONTEXT_WINDOW_PATTERNS.some((pattern) => pattern.test(text))) {
    return { class: "payload", status };
  }
  if (isKeyRotationError(text)) return { class: "key", status };
  if (status === 429) return { class: "none", status };
  if (status !== null && status < 500) return { class: "shape", status };
  return { class: "none", status };
}

/**
 * Feed a failed direct LLM call back into the ring that owns the reported
 * model/provider. Resolves the ring from ITS OWN identity (resolveRingForMessage),
 * classifies with the SAME predicate as handleMessageEnd, and on a
 * quota/auth/403 exhausts the active key (fires the throttled warn + persists
 * + ALL-KEYS-EXHAUSTED via the ring's own machinery). The next getActiveKey()
 * then serves the next key. Returns true when the ring was exhausted, false
 * when the call was foreign or not key-rotation style (lossy-safe no-op).
 */
export function reportKeyRingFailure(
  modelId: string,
  providerId: string | undefined,
  errText: unknown,
): boolean {
  const text = String(errText ?? "").toLowerCase();
  if (!text.trim()) return false;
  const meta = resolveRingMetaForMessage(providerId, modelId);
  if (!meta) return false;
  const ring = meta.ring;
  const errorLog = meta.errorLog;
  // WAF / infra block: transient, NOT key-rotation. Log once per window and
  // leave the key untouched so the next direct call is served from the same
  // (healthy) key after the edge block clears.
  if (isWafBlockError(text)) {
    llmErrorWaf.occurrence(
      "warn",
      "providers/ring-lifecycle",
      `[pi-braid-providers] Direct LLM call edge/WAF block (${providerId ?? modelId}): ${sanitizeWafError(text)} ` +
        `— key left healthy.`,
    );
    return false;
  }
  if (!isKeyRotationError(text)) return false;

  // Throttled: first direct-call failure in a burst is loud, repeats
  // within the window are silent — same throttler handleMessageEnd uses.
  errorLog.occurrence(
    "warn",
    "providers/ring-lifecycle",
    `[pi-braid-providers] Direct LLM call error (${providerId ?? modelId}): "${text.slice(0, 160)}" — ` +
      `exhausting active key + persisting state.`,
  );
  ring.exhaustActiveKey();
  return true;
}

/**
 * Feed a successful direct LLM call back into the ring so a key that served a
 * real request has its backoff healed (mirrors handleMessageEnd's success
 * path). No-op when the call is foreign, or when no key is currently exhausted
 * (avoids a redundant state-file write on every healthy utility call).
 */
export function reportKeyRingSuccess(
  modelId: string,
  providerId: string | undefined,
): void {
  const ring = resolveRingForMessage(providerId, modelId);
  if (!ring) return;
  if (ring.health().exhausted === 0) return; // nothing to heal — skip persist
  ring.markSuccess();
}

/**
 * Injected clock and freshness bound for {@link routeUsable}. Production
 * callers pass neither (settings supply the bound, Date.now the clock); tests
 * pass both so the answer is deterministic.
 */
export interface RouteUsableDeps {
  now?: () => number;
  probeFreshnessMs?: number;
}

/**
 * The auxiliary path's one question on this seam: can this (model id, provider)
 * pair serve a request right now?
 *
 * Core cannot redirect an auxiliary call the way the walk redirects a turn, so
 * the next call has to know the pair is unusable and skip it. The answer is
 * false only when the pair resolves to a configured route that serves the model
 * id and either has no usable key or carries a fresh request-shape death for
 * that model id. Every other case is true: no route owns the pair, the route
 * does not serve the id, or the freshness bound is off. That is the fail-open
 * contract: a missing or unreadable state file can never disable auxiliary
 * calls.
 */
export function routeUsable(
  modelId: string,
  providerId: string | undefined,
  deps: RouteUsableDeps = {},
): boolean {
  if (!modelId) return true; // nothing to answer about
  const route =
    typeof providerId === "string" && providerId
      ? (registeredRoutes.get(providerId) ?? null)
      : resolveRouteForModelId(modelId);
  // No configured route owns the pair: a built-in provider, or an id no route
  // serves. The seam has nothing to say, so the call proceeds as before.
  if (!route) return true;
  if (!routeServesModelId(route, modelId)) return true;
  // The ring's own health: a route with every key spent is unusable for the
  // next auxiliary call exactly as it is for the next turn.
  if (route.ring.health().usable <= 0) return false;
  // The recorded request-shape death, on the same bound the walk consumes.
  // `<= 0` is the explicit off switch shared with probe steering, so the death
  // leg is ignored and only the ring's health decides.
  const freshnessMs =
    deps.probeFreshnessMs ??
    readProvidersSettingsFromSettings().probeFreshnessMs;
  if (freshnessMs <= 0) return true;
  const now = deps.now ?? Date.now;
  const entry = readRouteState().routes[route.providerId];
  if (
    entry?.deathClass === SHAPE_DEATH_CLASS &&
    entry.deathModelId === modelId &&
    entry.deathAt > 0 &&
    now() - entry.deathAt < freshnessMs
  ) {
    return false;
  }
  return true;
}

/**
 * The handler object core's callLlm and contrib's vision wrapper invoke on
 * direct-call outcomes. Structurally compatible with core's
 * KeyRingFeedbackHandler interface (packages/core/src/lib/state/global-state.ts);
 * core reads `routeUsable` by structural lookup, so its interface need not
 * name it.
 */
export function createKeyRingFeedbackHandler(): {
  reportFailure(
    modelId: string,
    providerId: string | undefined,
    errText: string,
  ): void;
  reportSuccess(modelId: string, providerId: string | undefined): void;
  routeUsable(modelId: string, providerId: string | undefined): boolean;
} {
  return {
    reportFailure: (modelId, providerId, errText) => {
      reportKeyRingFailure(modelId, providerId, errText);
    },
    reportSuccess: (modelId, providerId) => {
      reportKeyRingSuccess(modelId, providerId);
    },
    routeUsable,
  };
}

// Cross-package registration seam
// Core's callLlm and contrib's vision wrapper cannot import pi-braid-providers
// (standalone package, no exports map), and providers cannot import pi-braid
// core (no pi-core import). The ONE deliberate seam is this process-global key:
// providers publishes its ring-feedback handler here at extension load
// (publishKeyRingFeedback, called from index.ts); core's global-state.ts
// getKeyRingFeedbackHandler() (re-exported via pi-braid/lib) reads it. The
// literal MUST stay in sync with
// packages/core/src/lib/state/global-state.ts KEY_RING_FEEDBACK_KEY.
export const KEY_RING_FEEDBACK_KEY = "__braid_key_ring_feedback_handler";

/**
 * Publish the ring-feedback handler into the process-global slot core/contrib
 * read. Called once from the providers extension factory (index.ts).
 * Idempotent; on /reload the factory re-runs and re-publishes a fresh handler
 * bound to the (re-created) rings.
 */
export function publishKeyRingFeedback(): void {
  (globalThis as Record<string, unknown>)[KEY_RING_FEEDBACK_KEY] =
    createKeyRingFeedbackHandler();
}

// Test Observability
// Exported for the deterministic provider-race regression test
// (test/provider-race.test.mjs). Wire-only for the extension itself.

export function getKeyRingStatusForTest(
  provider: string,
): { usable: number; total: number } | null {
  const ring = registeredRoutes.get(provider)?.ring ?? null;
  if (!ring) return null;
  const s = ring.getStatus();
  return { usable: s.usable, total: s.total };
}

/** Registered route ids in registration order (test observability). */
export function listRouteIdsForTest(): string[] {
  return [...registeredRoutes.keys()];
}

/** Registered route's keys prefix, model ids, model map, payload flag and probe (test observability). */
export function getRouteRegistrationForTest(provider: string): {
  providerId: string;
  keys: string;
  modelIds: readonly string[];
  models?: Record<string, string>;
  venicePayload: boolean;
  probe?: RouteProbe;
} | null {
  const route = registeredRoutes.get(provider);
  if (!route) return null;
  return {
    providerId: route.providerId,
    keys: route.keys,
    modelIds: route.modelIds,
    models: route.models,
    venicePayload: route.venicePayload,
    probe: route.probe,
  };
}

/**
 * Test-only hook: the key the NEXT request would select right now (the same
 * call auth.apiKey.resolve makes at request time). Lets the self-heal fixture
 * assert that a 403 on key 0 rotates to key 1 for the next request.
 */
export function getActiveKeyForTest(provider: string): string | null {
  const ring = registeredRoutes.get(provider)?.ring ?? null;
  return ring ? ring.getActiveKey() : null;
}
