/**
 * Provider outage watch — out-of-loop connectivity health for the registered
 * routes, the connectivity circuit breaker, and stalled-call visibility.
 *
 * Failure mode this module exists for: a single route's transport path dies
 * (a gateway/tunnel storm or hung requests). pi-core's turn-level retry then
 * re-sends the same request, each attempt hangs for the provider's idle
 * window and fails, and the whole retry budget is spent while nothing tells
 * the owner. The agent loop is held for the duration, so an in-loop watchdog
 * whisper cannot be the notifier; this watcher runs on its own timer and
 * pushes through the Telegram channel's outbound path (the process-global
 * slot the telegram package publishes, same seam pattern as the watchdog
 * tunnel hub and the key-ring feedback handler).
 *
 * Three mechanisms, one state machine:
 *
 *   1. Classification. A failure is connectivity-class when it reports a
 *      transport-level problem (timeouts, socket/DNS idioms, HTTP 5xx from
 *      any hop) and is NOT an outcome another subsystem already owns:
 *      key-style quota/auth/403 (the key ring rotates those), a spent
 *      allowance, a rate limit (429), an edge/WAF page, a payload/context
 *      window rejection, a request-shape refusal that names no transport
 *      idiom, or an abort. Throttle and quota classes keep their existing
 *      behavior; the breaker never touches them.
 *
 *   2. Breaker. K consecutive connectivity failures inside a T-minute window
 *      open the breaker for that route. While open, the provider dispatch
 *      this package registers is wrapped so stream/streamSimple throw an
 *      actionable terminal message instead of re-sending into the outage:
 *      the message names the route, the failure count and first-failure
 *      time, the next probe time, and the owner-alert status. The wording is
 *      deliberately outside pi-core's retryable-provider-error vocabulary,
 *      so pi-core stops retrying the turn instead of running all of its
 *      attempts into the outage. After a cooldown the gate admits ONE call
 *      (half-open); its success closes the breaker, its failure re-arms the
 *      cooldown. A failure class the breaker does not count (a quota death,
 *      a payload rejection) leaves it exactly as it was.
 *
 *   3. Watch and recovery. While a breaker is open the module runs a cheap,
 *      bounded probe of the route's own base URL (one attempt, short
 *      timeout, any answer below 500 counts as reachable) and closes the
 *      breaker on the first success, so nothing needs a manual restart. The
 *      probe cadence and the half-open cooldown are the same interval, so a
 *      recovered route is admitted to a real request within one interval
 *      even when it carries no probe target.
 *
 * Notifications: one transition message per episode (down, up), plus one
 * stall line per session per failing episode. Each transition claims a
 * machine-global floor record first (the same HOME-based state directory the
 * route store uses), so a fleet of pi processes sharing the host produces
 * ONE owner message per transition instead of one per process. A failed send
 * releases the claim so another process or a later episode can deliver.
 *
 * Stall visibility: a tracked session whose LLM attempts have been failing
 * without a success for longer than the stall window produces one log line
 * (through the providers notify sink) and, when a channel is published, one
 * Telegram line. The failure span is keyed by the session's own file path.
 *
 * Placement: this module is mechanism. It names no provider id, no model id,
 * no vendor error string and no host; routes and their probe URLs are handed
 * in by the registration loop, and every threshold is data with a default.
 * It writes one file, the notify floor record (dedupe only), and nothing
 * else. It never writes route state, never touches the key ring, and never
 * retries on its own beyond the one bounded probe.
 *
 * @module
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isWafBlockError, isKeyRotationError } from "./ring-lifecycle";
import { providerLog, type ProvidersLogLevel } from "./log";
import { piAgentDir } from "./state-paths";

// Cross-package notify seam
/**
 * Process-global slot the telegram package writes its outbound sender into
 * and this module reads at transition time (same seam pattern as
 * WATCHDOG_TG_SIGNAL_KEY and KEY_RING_FEEDBACK_KEY). The literal MUST stay in
 * sync with packages/telegram/src/index.ts PROVIDER_OUTAGE_NOTIFY_KEY. An
 * absent slot (telegram not loaded or no token) is not an error: the
 * transition still logs and its message text reports the missing channel.
 */
export const PROVIDER_OUTAGE_NOTIFY_KEY = "__braid_provider_outage_notify";

/** Send one plain-text line to the owner. Returns false when not delivered. */
export type ProviderOutageNotifySender = (
  text: string,
) => boolean | Promise<boolean>;

// Config

export interface OutageConfig {
  /** Master switch; false makes the watcher an inert no-op. */
  enabled: boolean;
  /** Consecutive connectivity failures needed to open the breaker. */
  failureThreshold: number;
  /** The failure streak must fit inside this window, else it restarts. */
  failureWindowMs: number;
  /** Probe cadence while open; also the half-open cooldown for real calls. */
  probeIntervalMs: number;
  /** One probe attempt must answer within this budget. */
  probeTimeoutMs: number;
  /** A session failing for at least this long gets one stall line. */
  stallThresholdMs: number;
  /** Per-route per-status floor for the machine-global notify record. */
  notifyFloorMs: number;
}

export const DEFAULT_OUTAGE_CONFIG: OutageConfig = {
  enabled: true,
  failureThreshold: 3,
  failureWindowMs: 5 * 60 * 1000,
  probeIntervalMs: 60 * 1000,
  probeTimeoutMs: 3 * 1000,
  stallThresholdMs: 10 * 60 * 1000,
  notifyFloorMs: 60 * 1000,
};

/** One route the watcher may open a breaker for (URL is optional). */
export interface OutageRouteTarget {
  readonly providerId: string;
  /** Base URL a bounded probe can reach; absent means real-call half-open only. */
  readonly url?: string;
}

/** Settings file location, mirroring the watchdog config convention. */
export function defaultOutageSettingsPath(): string {
  const dir =
    process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
  return join(dir, "settings.json");
}

/** The machine-global notify floor record (dedupe only, never state-of-truth),
 *  or `null` when no absolute state directory can be resolved: the watcher
 *  then notifies without a claim file rather than writing one beside the cwd. */
export function defaultOutageClaimPath(): string | null {
  const dir = piAgentDir();
  return dir ? join(dir, ".provider-outage-notify.json") : null;
}

function positiveFinite(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
}

function positiveInteger(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * Resolve `braid.providers.outage` from a settings.json document. Every
 * field is optional and validated on its own; an absent/invalid file or
 * block, or an invalid field, falls back to the code default. No env vars.
 */
export function resolveOutageConfig(raw: unknown): OutageConfig {
  const block = (raw as { braid?: { providers?: { outage?: unknown } } } | null)
    ?.braid?.providers?.outage;
  if (!block || typeof block !== "object" || Array.isArray(block)) {
    return { ...DEFAULT_OUTAGE_CONFIG };
  }
  const b = block as Record<string, unknown>;
  const cfg: OutageConfig = { ...DEFAULT_OUTAGE_CONFIG };
  if (typeof b.enabled === "boolean") cfg.enabled = b.enabled;
  const failures = positiveInteger(b.failures);
  const windowMs = positiveFinite(b.windowMs);
  const probeIntervalMs = positiveFinite(b.probeIntervalMs);
  const probeTimeoutMs = positiveFinite(b.probeTimeoutMs);
  const stallMs = positiveFinite(b.stallMs);
  const notifyFloorMs = positiveFinite(b.notifyFloorMs);
  if (failures !== undefined) cfg.failureThreshold = failures;
  if (windowMs !== undefined) cfg.failureWindowMs = windowMs;
  if (probeIntervalMs !== undefined) cfg.probeIntervalMs = probeIntervalMs;
  if (probeTimeoutMs !== undefined) cfg.probeTimeoutMs = probeTimeoutMs;
  if (stallMs !== undefined) cfg.stallThresholdMs = stallMs;
  if (notifyFloorMs !== undefined) cfg.notifyFloorMs = notifyFloorMs;
  return cfg;
}

/** Read and resolve the settings file; never throws, absent file is defaults. */
export function loadOutageConfig(
  settingsPath: string = defaultOutageSettingsPath(),
): OutageConfig {
  let raw: unknown;
  try {
    if (existsSync(settingsPath)) {
      raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    }
  } catch {
    // Non-fatal: a corrupt settings file resolves to the defaults, exactly
    // as the other provider settings readers treat it.
  }
  return resolveOutageConfig(raw);
}

// Failure classification

/**
 * Outcomes another subsystem already owns. They keep their existing retry
 * behavior and never open the breaker; the key/quota/auth branch is
 * delegated to the key ring's own predicate so the two layers cannot drift.
 */
const RATE_LIMIT_EXCLUSION = /429|rate[_ ]?limit|too many requests|throttl/;
const PAYLOAD_EXCLUSION =
  /413|context[_ ]length[_ ]exceeded|context[_ ]window|maximum[_ ]context|prompt[_ ]is[_ ]too[_ ]long|payload too large|request entity too large/;
const ABORT_EXCLUSION =
  /aborterror|operation was aborted|signal is aborted|user abort|aborted by user|cancelled by user/;

/** HTTP status literals named in the text (3-digit 5xx runs only). */
const STATUS_5XX = /\b5\d{2}\b/;

/**
 * Transport-level idioms. Positive vocabulary only: the caller's exclusions
 * run first, so a bare "5xx" in a quota body cannot reach here.
 */
const CONNECTIVITY_PATTERNS: RegExp[] = [
  /timed? out|timeout|etimedout|connect[_ ]timeout/,
  /econnreset|econnrefused|econnaborted|enotfound|eai_again|epipe|enetunreach|ehostunreach|ehostdown|enetdown/,
  /network is unreachable|network error|socket hang up|fetch failed|other side closed|connection refused|connection reset|connection closed|connection lost|premature close|getaddrinfo|upstream connect|reset before headers|stream ended before|ended without|http2 request did not get a response/,
  /overloaded|service unavailable|server error|internal error|bad gateway|gateway time-?out|temporarily unavailable|high demand|at capacity|exceeded request buffer/,
];

/**
 * True when the text reports a transport-level (connectivity) failure the
 * breaker owns. Evaluation order is deliberate: outcomes owned by another
 * subsystem are excluded FIRST (their retry semantics stay untouched), then
 * the transport vocabulary is matched. `isKeyRotationError` covers quota
 * (402/billing/spent allowance), auth (401) and 403; `isWafBlockError`
 * covers edge-block pages. Text is lowercased once for those predicates.
 */
export function classifyConnectivityFailure(errText: unknown): boolean {
  const raw = String(errText ?? "");
  if (!raw.trim()) return false;
  const text = raw.toLowerCase();
  if (isWafBlockError(raw) || isWafBlockError(text)) return false;
  if (RATE_LIMIT_EXCLUSION.test(text)) return false;
  if (PAYLOAD_EXCLUSION.test(text)) return false;
  if (ABORT_EXCLUSION.test(text)) return false;
  if (isKeyRotationError(text)) return false;
  if (STATUS_5XX.test(text)) return true;
  return CONNECTIVITY_PATTERNS.some((p) => p.test(text));
}

// Message rendering (pure)

/** Notifier outcome carried into the breaker's terminal text. */
export type NotifyOutcome = "pending" | "sent" | "recent" | "failed" | "absent";

const NOTIFY_LABEL: Record<NotifyOutcome, string> = {
  pending: "Owner alert pending",
  sent: "Owner alert sent",
  recent: "Owner alert already sent on this host",
  failed: "Owner alert failed",
  absent: "No owner alert channel (Telegram not configured)",
};

/** Local wall-clock HH:MM:SS. Tests pin TZ when they compare text. */
export function formatOutageClock(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

function humanizeDuration(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} min`;
}

function excerpt(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** The observable facts a down transition carries (all caller-supplied). */
export interface DownFacts {
  providerId: string;
  failures: number;
  firstFailureAt: number;
  openedAt: number;
  nextProbeAt: number;
  lastError?: string;
  notify: NotifyOutcome;
  /** Sessions with at least one failure and no success since. */
  sessionsFailing: number;
}

/**
 * The terminal text a blocked provider call throws. It MUST stay outside
 * pi-core's retryable-provider-error vocabulary (network/5xx/throttle words)
 * so the turn ends here instead of re-running into the outage; the guard
 * test and the live proof both assert that property.
 */
export function renderBlockedText(facts: DownFacts): string {
  const since = formatOutageClock(facts.firstFailureAt);
  const next = formatOutageClock(facts.nextProbeAt);
  return (
    `Provider route "${facts.providerId}" is paused by the connectivity ` +
    `watchdog: ${facts.failures} consecutive transport failures since ${since}. ` +
    `Attempts are paused until the next health check at ${next}. ` +
    `${NOTIFY_LABEL[facts.notify]}. ` +
    `This is a watchdog decision, not a request rejection; a later turn ` +
    `retries automatically once the route answers again.`
  );
}

/** The owner-facing down message (Telegram plain text). */
export function renderOwnerDownText(facts: DownFacts): string {
  const since = formatOutageClock(facts.firstFailureAt);
  const next = formatOutageClock(facts.nextProbeAt);
  const hint = facts.lastError
    ? ` Last failure: ${excerpt(facts.lastError)}.`
    : "";
  const sessions =
    facts.sessionsFailing > 0
      ? ` Sessions failing right now: ${facts.sessionsFailing}.`
      : "";
  return (
    `[braid] Provider route "${facts.providerId}" DOWN since ${since} ` +
    `(${facts.failures} consecutive transport failures).${hint}${sessions} ` +
    `Attempts to this route fail fast until it answers again; next check ` +
    `~${next}. No restart needed: recovery is automatic.`
  );
}

/** The owner-facing recovery message. */
export function renderOwnerUpText(facts: {
  providerId: string;
  downSince: number;
  recoveredAt: number;
}): string {
  return (
    `[braid] Provider route "${facts.providerId}" RECOVERED at ` +
    `${formatOutageClock(facts.recoveredAt)} (was down ` +
    `${humanizeDuration(facts.recoveredAt - facts.downSince)}). ` +
    `The health check passed; retries resume automatically.`
  );
}

/** One session's stall fact. */
export interface StallFacts {
  sessionLabel: string;
  providerId: string;
  failingForMs: number;
  consecutive: number;
}

/** The stall log line (and Telegram line) for one session. */
export function renderStallText(facts: StallFacts): string {
  const consecutive =
    facts.consecutive > 0
      ? `, ${facts.consecutive} consecutive on the route`
      : "";
  return (
    `[braid] Session ${facts.sessionLabel}: LLM attempts failing for ` +
    `${humanizeDuration(facts.failingForMs)} (route "${facts.providerId}"` +
    `${consecutive}). The outage watchdog is tracking it; no action needed ` +
    `yet.`
  );
}

// Machine-global notify floor

interface ClaimFile {
  [providerId: string]: { status: string; at: number; pid: number };
}

function readClaims(path: string): ClaimFile {
  try {
    if (!existsSync(path)) return {};
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return parsed as ClaimFile;
  } catch {
    return {};
  }
}

function writeClaims(path: string, claims: ClaimFile, now: number): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp-${process.pid}-${now}`;
    writeFileSync(tmp, JSON.stringify(claims), "utf-8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Claim the right to send one transition for a route. Returns false when a
 * record for the same route+status is younger than the floor (some process
 * on this host already told the owner). The write is a same-directory
 * temp+rename; a failed write still returns true (an owner alert outranks a
 * dedupe record that cannot be written).
 */
export function claimNotify(
  path: string,
  providerId: string,
  status: "down" | "up" | "stall",
  at: number,
  floorMs: number,
): boolean {
  const claims = readClaims(path);
  const prev = claims[providerId];
  if (prev && prev.status === status && at - prev.at < floorMs) return false;
  claims[providerId] = { status, at, pid: process.pid };
  writeClaims(path, claims, at);
  return true;
}

/** Release a claim this process just made (a failed send must not silence peers). */
export function releaseNotifyClaim(
  path: string,
  providerId: string,
  at: number,
): void {
  const claims = readClaims(path);
  const prev = claims[providerId];
  if (!prev || prev.at !== at) return;
  delete claims[providerId];
  writeClaims(path, claims, at);
}

// Breaker state

interface RouteState {
  consecutive: number;
  firstFailureAt: number;
  lastFailureAt: number;
  lastError: string;
  open: boolean;
  openedAt: number;
  nextProbeAt: number;
  notify: NotifyOutcome;
}

interface SessionSpan {
  providerId: string;
  firstFailureAt: number;
  lastFailureAt: number;
  consecutiveErrors: number;
  logged: boolean;
}

interface TransitionDown {
  kind: "down";
  providerId: string;
  failures: number;
  firstFailureAt: number;
  openedAt: number;
  nextProbeAt: number;
  lastError: string;
}

interface TransitionUp {
  kind: "up";
  providerId: string;
  downSince: number;
  recoveredAt: number;
  /** What proved recovery: a real call or the bounded probe. */
  via: "call" | "probe";
}

type Transition = TransitionDown | TransitionUp;

/** Read the published notifier, if any. */
export function readOutageNotifySender(): ProviderOutageNotifySender | null {
  const fn = (globalThis as Record<string, unknown>)[
    PROVIDER_OUTAGE_NOTIFY_KEY
  ];
  return typeof fn === "function" ? (fn as ProviderOutageNotifySender) : null;
}

/** Default bounded probe: one GET, short timeout, any answer below 500 is up. */
export async function httpReachable(
  url: string,
  timeoutMs: number,
): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "GET",
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Release the socket body without reading it; the status is the signal.
    void res.body?.cancel().catch(() => {});
    return res.status < 500;
  } catch {
    return false;
  }
}

export interface OutageWatchDeps {
  targets: readonly OutageRouteTarget[];
  config?: OutageConfig;
  now?: () => number;
  /** Notifier override (tests); default reads the process-global slot. */
  sender?: ProviderOutageNotifySender | null;
  /** Probe override (tests); default is the bounded HTTP probe. */
  probe?: (url: string, timeoutMs: number) => Promise<boolean>;
  claimPath?: string;
  /** Log sink override (tests); default routes through providerLog. */
  log?: (level: ProvidersLogLevel, scope: string, message: string) => void;
  /** Timer injection (tests); default is setInterval/unref. */
  scheduleTick?: (fn: () => void, ms: number) => () => void;
}

export interface ProviderOutageWatch {
  /** Gate for one route's provider dispatch. */
  guard(providerId: string): ProviderCallGuard;
  /** True when the provider call may proceed (consumes a half-open slot). */
  admit(providerId: string, at?: number): boolean;
  /** The terminal text for a call the gate refused. */
  blockedText(providerId: string, at?: number): string;
  /** message_end feed: one call per assistant message of a tracked route. */
  observe(
    message: {
      provider?: unknown;
      stopReason?: unknown;
      errorMessage?: unknown;
    },
    sessionKey: string,
    at?: number,
  ): void;
  /** Snapshot for diagnostics/tests: open routes and their facts. */
  openRoutes(): DownFacts[];
  stop(): void;
}

const TICK_MS = 5_000;
const LOG_SCOPE = "providers/outage";

/**
 * Build the watcher. All state is closure-local (never module-level: the
 * extension factory re-runs on reload and a fresh watcher must not inherit a
 * dead one's episodes).
 */
export function createOutageWatch(deps: OutageWatchDeps): ProviderOutageWatch {
  const config: OutageConfig = { ...DEFAULT_OUTAGE_CONFIG, ...deps.config };
  const now = deps.now ?? (() => Date.now());
  const log =
    deps.log ??
    ((level: ProvidersLogLevel, scope: string, message: string) =>
      providerLog(level, scope, message));
  const probe = deps.probe ?? httpReachable;
  const claimPath = deps.claimPath ?? defaultOutageClaimPath();
  if (!claimPath) {
    log(
      "warn",
      LOG_SCOPE,
      "no absolute state directory (PI_CODING_AGENT_DIR / os.homedir()): outage notifications run without the notify-floor claim file",
    );
  }
  const targets = new Map<string, OutageRouteTarget>();
  for (const t of deps.targets) targets.set(t.providerId, t);

  const routes = new Map<string, RouteState>();
  const sessions = new Map<string, SessionSpan>();
  const probing = new Set<string>();
  let timerStop: (() => void) | undefined;

  function stateOf(providerId: string): RouteState {
    let s = routes.get(providerId);
    if (!s) {
      s = {
        consecutive: 0,
        firstFailureAt: 0,
        lastFailureAt: 0,
        lastError: "",
        open: false,
        openedAt: 0,
        nextProbeAt: 0,
        notify: "pending",
      };
      routes.set(providerId, s);
    }
    return s;
  }

  function downFacts(providerId: string): DownFacts {
    const s = stateOf(providerId);
    return {
      providerId,
      failures: s.consecutive,
      firstFailureAt: s.firstFailureAt,
      openedAt: s.openedAt,
      nextProbeAt: s.nextProbeAt,
      lastError: s.lastError,
      notify: s.notify,
      sessionsFailing: activeSessionCount(),
    };
  }

  function activeSessionCount(): number {
    return sessions.size;
  }

  // notification

  function sender(): ProviderOutageNotifySender | null {
    if (deps.sender !== undefined) return deps.sender;
    return readOutageNotifySender();
  }

  /**
   * Send one transition line. Claim first so a fleet on one host produces
   * one message; a failed or refused send releases the claim. Returns the
   * notify outcome the breaker text should carry.
   */
  function publishTransition(
    kind: "down" | "up",
    text: string,
    providerId: string,
    at: number,
  ): NotifyOutcome {
    const send = sender();
    if (!send) {
      log(
        "warn",
        LOG_SCOPE,
        `provider route "${providerId}" ${kind}: no owner alert channel`,
      );
      return "absent";
    }
    if (
      claimPath &&
      !claimNotify(claimPath, providerId, kind, at, config.notifyFloorMs)
    ) {
      return "recent";
    }
    /** Release a claim: a no-op when there is no claim file to release. */
    const releaseClaim = (): void => {
      if (claimPath) releaseNotifyClaim(claimPath, providerId, at);
    };
    try {
      const delivered = send(text);
      if (delivered instanceof Promise) {
        // Fire-and-forget: the blocked text reads "pending" until it settles.
        void delivered
          .then((ok) => {
            const s = routes.get(providerId);
            if (s) s.notify = ok ? "sent" : "failed";
            if (!ok) releaseClaim();
          })
          .catch(() => {
            releaseClaim();
          });
        return "pending";
      }
      if (delivered) return "sent";
      releaseClaim();
      return "failed";
    } catch {
      releaseClaim();
      return "failed";
    }
  }

  function handleTransition(t: Transition): void {
    if (t.kind === "down") {
      const s = stateOf(t.providerId);
      const facts = downFacts(t.providerId);
      log(
        "warn",
        LOG_SCOPE,
        `provider route "${t.providerId}" DOWN: ${t.failures} consecutive ` +
          `transport failures since ${formatOutageClock(t.firstFailureAt)}; ` +
          `next probe ${formatOutageClock(t.nextProbeAt)}`,
      );
      s.notify = publishTransition(
        "down",
        renderOwnerDownText(facts),
        t.providerId,
        t.openedAt,
      );
      return;
    }
    const s = stateOf(t.providerId);
    log(
      "info",
      LOG_SCOPE,
      `provider route "${t.providerId}" recovered via ${t.via} after ` +
        `${humanizeDuration(t.recoveredAt - t.downSince)}`,
    );
    s.notify = publishTransition(
      "up",
      renderOwnerUpText(t),
      t.providerId,
      t.recoveredAt,
    );
  }

  // failure / success feed

  function recordConnectivityFailure(
    providerId: string,
    errText: string,
    at: number,
  ): void {
    const s = stateOf(providerId);
    s.lastError = excerpt(errText, 300);
    if (s.open) {
      // Cap the counter while open: it is informational by then, and a
      // three-digit display must never read as an HTTP status to pi-core's
      // classifiers (a "500 consecutive" would re-arm the retry pattern).
      s.consecutive = Math.min(s.consecutive + 1, 99);
      s.lastFailureAt = at;
      // Backoff: a failed half-open attempt moves the next probe out.
      s.nextProbeAt = Math.max(s.nextProbeAt, at + config.probeIntervalMs);
      return;
    }
    if (s.consecutive > 0 && at - s.firstFailureAt > config.failureWindowMs) {
      s.consecutive = 0; // a streak older than the window is not one streak
    }
    s.consecutive++;
    if (s.consecutive === 1) s.firstFailureAt = at;
    s.lastFailureAt = at;
    if (s.consecutive >= config.failureThreshold) {
      s.open = true;
      s.openedAt = at;
      s.nextProbeAt = at + config.probeIntervalMs;
      handleTransition({
        kind: "down",
        providerId,
        failures: s.consecutive,
        firstFailureAt: s.firstFailureAt,
        openedAt: s.openedAt,
        nextProbeAt: s.nextProbeAt,
        lastError: s.lastError,
      });
    }
  }

  function recordSuccess(
    providerId: string,
    at: number,
    via: "call" | "probe",
  ): void {
    const s = routes.get(providerId);
    if (!s) return;
    s.consecutive = 0;
    s.firstFailureAt = 0;
    s.lastError = "";
    if (!s.open) return;
    s.open = false;
    handleTransition({
      kind: "up",
      providerId,
      downSince: s.openedAt,
      recoveredAt: at,
      via,
    });
  }

  // sessions (stall visibility)

  function observeSession(
    sessionKey: string,
    providerId: string,
    ok: boolean,
    at: number,
  ): void {
    if (ok) {
      sessions.delete(sessionKey);
      return;
    }
    let span = sessions.get(sessionKey);
    if (!span) {
      span = {
        providerId,
        firstFailureAt: at,
        lastFailureAt: at,
        consecutiveErrors: 0,
        logged: false,
      };
      sessions.set(sessionKey, span);
    }
    span.providerId = providerId;
    span.lastFailureAt = at;
    span.consecutiveErrors++;
  }

  function scanStalls(at: number): void {
    const senderFn = sender();
    for (const [key, span] of [...sessions.entries()]) {
      const failingForMs = at - span.firstFailureAt;
      if (failingForMs >= config.stallThresholdMs && !span.logged) {
        span.logged = true;
        const facts: StallFacts = {
          sessionLabel: sessionLabel(key),
          providerId: span.providerId,
          failingForMs,
          consecutive: routes.get(span.providerId)?.consecutive ?? 0,
        };
        const text = renderStallText(facts);
        log("warn", LOG_SCOPE, text);
        if (senderFn) {
          try {
            const sent = senderFn(text);
            if (sent instanceof Promise) void sent.catch(() => {});
          } catch {
            // A stalled-session line is best effort; never break the tick.
          }
        }
      }
      // Forgettable once a full stall window passed without a new failure.
      if (at - span.lastFailureAt > config.stallThresholdMs) {
        sessions.delete(key);
      }
    }
  }

  // probe loop

  function hasWork(at: number): boolean {
    for (const s of routes.values()) if (s.open) return true;
    for (const span of sessions.values()) {
      if (at - span.lastFailureAt <= config.stallThresholdMs) return true;
    }
    return false;
  }

  function ensureTick(): void {
    if (timerStop || !config.enabled) return;
    const schedule =
      deps.scheduleTick ??
      ((fn: () => void, ms: number) => {
        const handle = setInterval(fn, ms);
        handle.unref?.();
        return () => clearInterval(handle);
      });
    timerStop = schedule(() => tick(), TICK_MS);
  }

  function tick(): void {
    const at = now();
    scanStalls(at);
    for (const [providerId, s] of routes.entries()) {
      if (!s.open || at < s.nextProbeAt || probing.has(providerId)) continue;
      const target = targets.get(providerId);
      if (!target?.url) continue;
      probing.add(providerId);
      void probe(target.url, config.probeTimeoutMs)
        .then((up) => {
          const doneAt = now();
          if (up) {
            recordSuccess(providerId, doneAt, "probe");
          } else {
            const cur = routes.get(providerId);
            if (cur?.open) {
              cur.nextProbeAt = doneAt + config.probeIntervalMs;
            }
          }
        })
        .catch(() => {
          const cur = routes.get(providerId);
          if (cur?.open) cur.nextProbeAt = now() + config.probeIntervalMs;
        })
        .finally(() => {
          probing.delete(providerId);
        });
    }
    if (!hasWork(at)) {
      timerStop?.();
      timerStop = undefined;
    }
  }

  function guardOf(providerId: string): ProviderCallGuard {
    return {
      admit: (at?: number) => admitRoute(providerId, at),
      blockedText: (at?: number) => blockedTextOf(providerId, at),
    };
  }

  function admitRoute(providerId: string, at?: number): boolean {
    if (!config.enabled) return true;
    const s = routes.get(providerId);
    if (!s || !s.open) return true;
    const t = at ?? now();
    if (t >= s.nextProbeAt) {
      s.nextProbeAt = t + config.probeIntervalMs; // consume the half-open slot
      return true;
    }
    return false;
  }

  function blockedTextOf(providerId: string, at?: number): string {
    const facts = downFacts(providerId);
    if (at !== undefined && facts.nextProbeAt < at) facts.nextProbeAt = at;
    return renderBlockedText(facts);
  }

  return {
    guard: guardOf,

    admit: admitRoute,

    blockedText: blockedTextOf,

    observe(message, sessionKey, at?): void {
      if (!config.enabled) return;
      const providerId =
        typeof message?.provider === "string" ? message.provider : "";
      if (!providerId || !targets.has(providerId)) return;
      const t = at ?? now();
      const ok = message?.stopReason !== "error";
      observeSession(sessionKey, providerId, ok, t);
      if (ok) {
        recordSuccess(providerId, t, "call");
        return;
      }
      const errText = String(message?.errorMessage ?? "");
      if (classifyConnectivityFailure(errText)) {
        recordConnectivityFailure(providerId, errText, t);
        ensureTick();
      }
    },

    openRoutes(): DownFacts[] {
      const out: DownFacts[] = [];
      for (const [providerId, s] of routes.entries()) {
        if (s.open) out.push(downFacts(providerId));
      }
      return out;
    },

    stop(): void {
      timerStop?.();
      timerStop = undefined;
    },
  };
}

/** Basename of a session file, trimmed; falls back to the raw key. */
export function sessionLabel(key: string): string {
  const base = key.split(/[\\/]/).pop() ?? key;
  const trimmed = base.replace(/\.jsonl$/, "");
  return trimmed.length > 32 ? `${trimmed.slice(0, 31)}…` : trimmed;
}

// Provider dispatch guard

/** Minimal function shape a wrapped dispatch must answer; see guardStreams. */
type AnyFn = (...args: never[]) => unknown;

function asFn(value: unknown): AnyFn | undefined {
  return typeof value === "function" ? (value as AnyFn) : undefined;
}

export interface ProviderCallGuard {
  admit(at?: number): boolean;
  blockedText(at?: number): string;
}

/** Copy one dispatch object, gating its stream/streamSimple calls. */
function guardStreams(streams: object, guard: ProviderCallGuard): object {
  const wrapped: Record<string, unknown> = {
    ...(streams as Record<string, unknown>),
  };
  for (const method of ["stream", "streamSimple"] as const) {
    const original = asFn(wrapped[method]);
    if (!original) continue;
    wrapped[method] = (...args: never[]): unknown => {
      if (!guard.admit()) throw new Error(guard.blockedText());
      return original(...args);
    };
  }
  return wrapped;
}

/** One call-dispatch object (pi-ai's ProviderStreams) with its chat calls gated. */
export function withBreakerStreams<T extends object>(
  streams: T,
  guard: ProviderCallGuard,
): T {
  return guardStreams(streams, guard) as T;
}

/**
 * The same provider with its chat dispatch gated. `api` is either one
 * ProviderStreams object or a map of api id to ProviderStreams (pi-ai's
 * Provider.api union); both shapes are handled, every other field is carried
 * through untouched, and deferred/cancel paths deliberately stay unwrapped
 * (the agent loop never uses them).
 */
export function withBreakerApi<P extends object>(
  provider: P,
  guard: ProviderCallGuard,
): P {
  const api = (provider as { api?: unknown }).api;
  if (!api || typeof api !== "object") return provider;
  const record = api as Record<string, unknown>;
  if (
    typeof record.stream === "function" ||
    typeof record.streamSimple === "function"
  ) {
    return { ...provider, api: guardStreams(record, guard) } as P;
  }
  const wrapped: Record<string, unknown> = {};
  for (const [apiId, streams] of Object.entries(record)) {
    wrapped[apiId] =
      streams && typeof streams === "object"
        ? guardStreams(streams, guard)
        : streams;
  }
  return { ...provider, api: wrapped } as P;
}
