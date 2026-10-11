/**
 * Non-billable route probes.
 *
 * A probe reads a route's own status endpoint — never an inference call — so a
 * route's remaining capacity is observable without spending tokens. The module
 * is two layers:
 *
 *   - the RUNNER (`probeRoute`) owns transport, timeout, the HTTP/JSON failure
 *     mapping and the headroom classification. It is provider-agnostic: one
 *     lookup, no provider id and no response field name appears in it;
 *   - the ADAPTER TABLE (`PROBE_ADAPTERS`) is the ONLY place provider ids and
 *     response-shape knowledge live — one small parser per documented shape.
 *
 * The consequence is the placement rule: a provider absent from the table is
 * reported exactly like a provider whose shape is undocumented, and neither
 * the state store nor the descriptor plumbing needs to learn a provider name.
 *
 * A probe NEVER throws, NEVER rotates a key and NEVER starts an inference.
 *
 * @module
 */

/** The recorded result of one probe. */
export interface ProbeOutcome {
  state: "ok" | "degraded" | "unavailable";
  /** Epoch ms the probe ran. */
  at: number;
  /** Remaining capacity as a percentage of the route's own cap. */
  headroomPct?: number;
  /** Observed spend in USD, when the endpoint reports one. */
  spendUsd?: number;
  /** The route's spend cap in USD, when the endpoint reports one. */
  capUsd?: number;
  /**
   * Remaining spend the endpoint reports, in USD: a spendable balance or a
   * cap remainder. The adapter table owns which response field feeds it.
   */
  remainingUsd?: number;
  /** Epoch ms the current window/epoch resets, when the endpoint reports one. */
  resetAt?: number;
  /** Why the probe could not read a healthy state (never a secret). */
  reason?: string;
}

/**
 * A route's status capability, carried by the route descriptor. The URL and
 * auth header are route config (owner-owned); the response SHAPE is the
 * adapter table's business.
 */
export interface ProbeDescriptor {
  url: string;
  /**
   * Header name carrying `Bearer <key>`. Defaults to `Authorization`; every
   * documented endpoint uses the bearer convention.
   */
  authHeader?: string;
  /**
   * Floor for a route whose status document reports a spendable USD balance:
   * above it is `ok`, at or below it (but above zero) is `degraded`, zero or
   * below is `unavailable`. Defaults to DEFAULT_BALANCE_FLOOR_USD. It is route
   * configuration, not a runner constant, so the owner can move it without a
   * code change; a route whose shape reports no balance is unaffected.
   */
  balanceFloorUsd?: number;
}

/** Minimal response surface the runner consumes. */
export interface ProbeFetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * HTTP transport signature. Injectable so tests never touch the network; the
 * default is the global fetch.
 */
export type ProbeFetch = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    signal: AbortSignal;
  },
) => Promise<ProbeFetchResponse>;

export interface ProbeDeps {
  /** Transport; defaults to global fetch. */
  fetch?: ProbeFetch;
  /** Clock; defaults to Date.now. */
  now?: () => number;
  /** Per-probe timeout; defaults to DEFAULT_PROBE_TIMEOUT_MS. */
  timeoutMs?: number;
}

/** Bounded so a hung status endpoint can never stall the caller. */
export const DEFAULT_PROBE_TIMEOUT_MS = 8_000;

/**
 * Default floor (USD) a route's reported spendable balance is measured
 * against when its descriptor names none. One USD is below the cost of a
 * single call on every route this build probes, so the default refuses to
 * call a route healthy when it cannot serve even the next call.
 */
export const DEFAULT_BALANCE_FLOOR_USD = 1;

/** Above this headroom the route is comfortable; at or below it, degraded. */
const HEADROOM_DEGRADED_MAX_PCT = 25;

// Runner (provider-agnostic)

/**
 * Run one probe for `providerId` against `descriptor`, authenticating with
 * `key`. Fire-and-forget safe: every failure mode (unknown provider, absent
 * credential, transport error, non-2xx, unparseable body, shape change) maps
 * to `state: "unavailable"` with a reason — this function never rejects.
 */
export async function probeRoute(
  providerId: string,
  descriptor: ProbeDescriptor,
  key: string | null,
  deps: ProbeDeps = {},
): Promise<ProbeOutcome> {
  const now = deps.now ?? Date.now;
  const at = now();
  const adapter = PROBE_ADAPTERS[providerId];
  if (adapter === "no-endpoint") {
    return { state: "unavailable", at, reason: "no free endpoint" };
  }
  if (typeof adapter !== "function") {
    return { state: "unavailable", at, reason: "no adapter" };
  }
  if (!key) {
    return { state: "unavailable", at, reason: "no key" };
  }

  const doFetch = deps.fetch ?? (globalThis.fetch as ProbeFetch | undefined);
  if (!doFetch) {
    return { state: "unavailable", at, reason: "no transport" };
  }
  const headers: Record<string, string> = {
    [descriptor.authHeader || "Authorization"]: `Bearer ${key}`,
  };

  let response: ProbeFetchResponse;
  try {
    response = await doFetch(descriptor.url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(deps.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS),
    });
  } catch (err) {
    return { state: "unavailable", at, reason: `network: ${errorText(err)}` };
  }
  if (!response.ok) {
    return { state: "unavailable", at, reason: `http ${response.status}` };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { state: "unavailable", at, reason: "malformed json" };
  }

  let reading: AdapterReading;
  try {
    reading = adapter(body);
  } catch {
    return { state: "unavailable", at, reason: "shape change" };
  }
  return classify(
    reading,
    at,
    descriptor.balanceFloorUsd ?? DEFAULT_BALANCE_FLOOR_USD,
  );
}

/**
 * Turn an adapter reading into an outcome. This is the ONE place a probe
 * becomes a state. An explicit unavailability signal, a zero/negative balance
 * or zero headroom is `unavailable`; a positive balance at or below the
 * route's floor, or a positive headroom at or below the degraded threshold, is
 * `degraded`; anything above is `ok`. The floor governs only a reported
 * spendable balance: a cap remainder (`remainingUsd` with no `balanceUsd`)
 * keeps the headroom rule alone, so a route whose shape carries no balance is
 * classified exactly as before.
 */
function classify(
  reading: AdapterReading,
  at: number,
  balanceFloorUsd: number,
): ProbeOutcome {
  const outcome: ProbeOutcome = { state: "ok", at };
  if (typeof reading.headroomPct === "number")
    outcome.headroomPct = reading.headroomPct;
  if (typeof reading.spendUsd === "number") outcome.spendUsd = reading.spendUsd;
  if (typeof reading.capUsd === "number") outcome.capUsd = reading.capUsd;
  if (typeof reading.resetAt === "number") outcome.resetAt = reading.resetAt;
  const remaining = reading.remainingUsd ?? reading.balanceUsd;
  if (typeof remaining === "number") outcome.remainingUsd = remaining;

  if (reading.reason) {
    outcome.state = "unavailable";
    outcome.reason = reading.reason;
    return outcome;
  }
  if (reading.available === false) {
    outcome.state = "unavailable";
    outcome.reason = "reported unavailable";
    return outcome;
  }
  const balance = reading.balanceUsd;
  if (typeof balance === "number") {
    if (balance <= 0) {
      outcome.state = "unavailable";
      outcome.reason = "no balance";
      return outcome;
    }
    if (balance <= balanceFloorUsd) outcome.state = "degraded";
  }
  const headroom = reading.headroomPct;
  if (typeof headroom === "number") {
    if (headroom <= 0) {
      outcome.state = "unavailable";
      outcome.reason = "no headroom";
    } else if (headroom <= HEADROOM_DEGRADED_MAX_PCT) {
      outcome.state = "degraded";
    }
  }
  return outcome;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// The ONLY provider ids and response field names in this module. Values:
//   - a parser for a documented shape;
//   - "no-endpoint" when the route has no non-billable endpoint at all;
//   - absent when the documented shape cannot be parsed without guessing
//     (a guessed parser would mislabel a shape change as a provider state).

/** What an adapter extracts from one 2xx body. */
interface AdapterReading {
  headroomPct?: number;
  spendUsd?: number;
  capUsd?: number;
  /** Remaining spend reported directly (a cap's remainder); never floored. */
  remainingUsd?: number;
  /**
   * A spendable USD balance the endpoint reports. Distinct from
   * `remainingUsd`: a balance is governed by the descriptor's
   * `balanceFloorUsd`, a cap remainder is not.
   */
  balanceUsd?: number;
  resetAt?: number;
  /** Explicit provider-level unavailability (false ⇒ unavailable). */
  available?: boolean;
  /** A shape-change reason; the runner maps it straight to unavailable. */
  reason?: string;
}

type ProbeAdapter = (body: unknown) => AdapterReading;
type AdapterEntry = ProbeAdapter | "no-endpoint" | undefined;

const PROBE_ADAPTERS: Record<string, AdapterEntry> = {
  "venice-direct": veniceAdapter,
  openrouter: openrouterAdapter,
  deepseek: deepseekAdapter,
  // Its only known health check is a billed inference call.
  "agent-zero": "no-endpoint",
  // Documented endpoint, undocumented body shape (quota windows / plan names
  // vary by key class and by API generation) — parsing would be a guess.
  zai: undefined,
  minimax: undefined,
};

/**
 * Venice status document: `data.balances` carries the credit balances, the
 * USD balance is the spendable headroom, an epoch allocation pair (`diem` used
 * against `diemEpochAllocation`) yields a headroom percentage, `canConsume`
 * yields availability, and the epoch boundary yields the reset time. Both
 * documented endpoints project this same document, so the descriptor's URL
 * chooses the projection and this parser reads either. The USD balance is
 * reported as `balanceUsd` so the descriptor's floor governs it; the epoch
 * pair is spend/cap in DIEM, not USD, so it never becomes a USD figure.
 */
function veniceAdapter(body: unknown): AdapterReading {
  const data = record(record(body)?.data);
  const balances = record(data?.balances);
  if (!data || !balances) return { reason: "shape change" };
  const reading: AdapterReading = {};
  if (data.canConsume === false) reading.available = false;
  const usd = number(balances.USD);
  const used = number(balances.diem);
  const allocation = number(balances.diemEpochAllocation);
  const hasEpochPair =
    used !== undefined && allocation !== undefined && allocation > 0;
  // A balances object that yields no recognizable figure is a shape change,
  // not a healthy route: reading nothing must never read as ok. An explicit
  // canConsume:false is a state the provider reported, so it is exempt and
  // carries through to the unavailable verdict below.
  if (usd === undefined && !hasEpochPair && data.canConsume !== false) {
    return { reason: "shape change" };
  }
  if (usd !== undefined) reading.balanceUsd = usd;
  if (used !== undefined && allocation !== undefined && allocation > 0) {
    reading.headroomPct = ((allocation - used) / allocation) * 100;
    reading.spendUsd = used;
    reading.capUsd = allocation;
  }
  const resetAt =
    isoMs(data.nextEpochBegins) ?? isoMs(data.keyExpiration) ?? undefined;
  if (resetAt !== undefined) reading.resetAt = resetAt;
  return reading;
}

/**
 * `data.limit` / `data.limit_remaining` / `data.usage_monthly` /
 * `data.is_free_tier`. A null `limit` is an uncapped key (unlimited); a
 * numeric limit yields headroom from the remaining share. `limit_remaining`
 * is a cap remainder, not a spendable balance, so it travels as
 * `remainingUsd` and no floor governs it.
 */
function openrouterAdapter(body: unknown): AdapterReading {
  const data = record(record(body)?.data);
  if (
    !data ||
    !("limit_remaining" in data) ||
    typeof data.is_free_tier !== "boolean"
  ) {
    return { reason: "shape change" };
  }
  const reading: AdapterReading = {};
  const monthly = number(data.usage_monthly);
  if (monthly !== undefined) reading.spendUsd = monthly;
  const remaining = number(data.limit_remaining);
  if (remaining !== undefined) reading.remainingUsd = remaining;
  const resetAt = isoMs(data.limit_reset);
  if (resetAt !== undefined) reading.resetAt = resetAt;
  const cap = number(data.limit);
  if (cap !== undefined && cap > 0) {
    reading.capUsd = cap;
    if (remaining !== undefined) reading.headroomPct = (remaining / cap) * 100;
  }
  return reading;
}

/**
 * `is_available` / `balance_infos[]`. The endpoint reports a remaining balance
 * and an availability flag — no cap — so only availability travels; a missing
 * flag or list is a shape change.
 */
function deepseekAdapter(body: unknown): AdapterReading {
  const data = record(body);
  if (!data || typeof data.is_available !== "boolean") {
    return { reason: "shape change" };
  }
  if (!Array.isArray(data.balance_infos)) return { reason: "shape change" };
  return data.is_available ? {} : { available: false };
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

function isoMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}
