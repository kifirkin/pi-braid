/**
 * Watchdog Engine — pure liveness/stall state machine.
 *
 * monitor → detect → escalate:
 *   - MONITOR: turn progress (session-start / message_end / agent_start /
 *     agent_end / tool_call hooks → observeX), the keyring LLM feedback feed
 *     (reportFailure/reportSuccess → recordLlmX), and tunnel liveness
 *     transitions (telegram → core hub → subscribeTunnel).
 *   - DETECT: a small matrix, all local and zero-LLM:
 *       1. turn-stall: an active turn with no tool-call AND no turn-complete
 *                        for > stallMult × baseMs since last activity
 *                        (activity = last tool-call or last progress, NOT wall
 *                        clock — quiet by construction while tool-calling).
 *       2. quota-loop: ≥ quotaErrors consecutive quota-class LLM failures
 *                        (rate-limit/balance/auth/key-ring exhaustion) with no
 *                        success. Failures are classified via
 *                        classifyLlmError (lib/errors/llm-error); transient,
 *                        abort, and unknown failures never count — they get a
 *                        separate log-only streak (no escalation from it).
 *       3. tunnel-down: ≥ tunnelFailures consecutive getUpdates failures
 *                        (telegram emits the transition; this engine hosts the
 *                        confirmation gate + escalation).
 *   - ESCALATE: waking whisper (wakeWhisper) + optional 1-line tg signal
 *     (tgSignal). The FIRST escalation of an open condition always fires
 *     (threshold crossing). Repeats while the condition stays continuously
 *     open are milestone-throttled so one long outage cannot flood the owner
 *     with duplicate barks (outage: dozens of near-identical
 *     barks from concurrent pi processes): quota/tunnel re-warn only when
 *     their failure count crosses one of REWARN_MILESTONES (the ladder
 *     resets on close, so each outage gets its own milestone set), and
 *     turn-stall (no natural counter) falls back to a LONG cooldown
 *     (STALL_REWARN_COOLDOWN_MULT × cooldownMs). The normal cooldown
 *     remains as a second gate — strictly-fewer barks, never more. Tunnel
 *     recovery emits a quiet recovery whisper.
 *
 * Soft backoff: base cadence (baseMs) while clean, hot cadence (hotMs) while at
 * least one issue is open, back to base when all clear.
 *
 * Bounded stall ladder (the actuation half of turn-stall): the predicate keeps
 * its first bark; an episode classifies before it actuates.
 * The classification is a conjunction — the session is streaming, no provider
 * stream activity for streamSilenceMs (wire heartbeat, tracked separately
 * from tool-call silence), the transcript's last event is a tool result or a
 * provider error with no continuation, and no timer/wake is due. The first
 * fire of an episode stays advisory; a later confirmed-dead fire persists a
 * resume marker (pending tool call + partial output) to a durable seat,
 * aborts the dead turn once, pages the owner, and stops the ladder. Without a
 * durable seat the turn is marked unready and surfaced, never killed and
 * forgotten. Counter-less re-warns keep their long cooldown while the episode
 * has not reached a terminal hand-back.
 *
 * Pure + fully injectable (fake timers/now/whispers, no network) so fixture
 * tests drive the whole matrix deterministically. State lives in the factory
 * closure (never a module-level let — src/lib/state/AGENTS.md contract).
 *
 * Owns liveness/stall/escalation only. The heartbeat-scheduler owns cognitive
 * interventions (silence/context/error-accumulation triggers, meta-learning,
 * whisper-batcher) — this engine does NOT re-emit those events.
 */

import { classifyLlmError, extractHttpCodeFromText } from "../../../lib/errors/llm-error.js";
import { WATCHDOG_ESCALATION_BUDGET_PER_SESSION } from "../../../lib/detection/context-thresholds.js";
import { formatLocalTime } from "../../../lib/utils/local-time.js";

export type WatchdogMode = "on" | "off";

export interface WatchdogConfig {
  mode: WatchdogMode;
  /** BASE cadence (ms) — healthy recheck interval, resurrection target. */
  baseMs: number;
  /** HOT cadence (ms) — recheck interval while ≥1 issue is open. */
  hotMs: number;
  /** Turn-stall threshold as a multiple of baseMs (5 × 15min = 75min). */
  stallMult: number;
  /** Provider stream-silence threshold (ms): a streaming turn with no wire
   *  activity for longer than this is silent, not slow. */
  streamSilenceMs: number;
  /** Consecutive quota-class LLM failures (rate-limit/balance/auth/ring exhaustion, no success since) that trip quota-loop. */
  quotaErrors: number;
  /** Consecutive getUpdates failures (telegram confirmation gate) that trip tunnel-down. */
  tunnelFailures: number;
}

/** Code-constant defaults — `broker.watchdog` in settings.json overrides. */
export const DEFAULT_WATCHDOG_CONFIG: WatchdogConfig = {
  mode: "on",
  baseMs: 15 * 60 * 1000, // 15 min (healthy)
  hotMs: 3 * 60 * 1000, // 3 min (≥1 open issue)
  stallMult: 5,
  streamSilenceMs: 10 * 60 * 1000, // 10 min of wire silence while streaming
  quotaErrors: 3,
  tunnelFailures: 5, // gate raised from 3: sibling canaries colliding with this poller's long-poll caused false tunnel-down floods
};

/** Per-condition re-escalation cooldown = this × hotMs (2 HOT periods). */
export const WATCHDOG_COOLDOWN_MULT = 2;

/**
 * Sparse re-warn milestones for continuously-open conditions that have a
 * natural failure counter (quota-loop: quotaConsecutive; tunnel-down:
 * tunnel.failures). A repeat escalation fires only when the count CROSSES one
 * of these from below; the first bark at threshold crossing is unaffected.
 * Per-condition fired-state resets ONLY when the episode latch re-arms
 * (success streak) — NOT on every transient close (the close→open re-fire
 * produced the measured 143-escalation flap storm,).
 */
const REWARN_MILESTONES = [20, 50, 100, 200, 500] as const;
/** How many unclassified-failure records the snapshot retains. */
const UNKNOWN_FAILURE_RING_CAP = 5;

/** Final rung of the milestone ladder — the only re-warn that still fires
 *  after the per-session escalation budget is exhausted. */
const FINAL_REWARN_MILESTONE: number = REWARN_MILESTONES[REWARN_MILESTONES.length - 1];

/**
 * Flap latch: the FIRST escalation of an open episode always fires
 * (wake-up feature — with dynamic quota the first bark wakes
 * the agent to retry and it may recover). Re-arm requires a SUCCESS STREAK:
 * this many consecutive healthy evaluations (evaluateQuota) or consecutive
 * LLM successes (recordLlmSuccess). A transient close (failures dip below
 * threshold) does NOT re-arm — a close→open flap inside that window is the
 * SAME episode: no new wake bark, milestone ladder retains its high-water.
 */
const QUOTA_REARM_SUCCESS_STREAK = 3;

/**
 * Counter-less conditions (turn-stall) cannot milestone-throttle on a failure
 * count; their repeat re-warn falls back to a LONG cooldown:
 * STALL_REWARN_COOLDOWN_MULT × cooldownMs (sparse but still periodic).
 */
const STALL_REWARN_COOLDOWN_MULT = 4;

/**
 * Escalation fires within one stall episode before the ladder attempts
 * remediation: fire 1 classifies and notifies, fire 2 (confirmed dead)
 * persists the resume marker and aborts once. The ladder is bounded by the
 * terminal hand-backs, never by an unbounded re-warn.
 */
export const STALL_SERVICE_FIRE = 2;

/** Bounds on the resume-marker payload (no unbounded text in a session entry). */
const RESUME_MARKER_TEXT_CAP = 500;
const RESUME_MARKER_ARGS_CAP = 200;

export type WatchdogConditionId =
  | "turn-stall"
  | "quota-loop"
  | "tunnel-down"
  | "wake-delivery"
  | "terminal-stop";

export interface TunnelTransitionEvent {
  status: "up" | "down";
  failures: number;
  lastError?: string;
  message: string;
}

export interface TunnelStatusSnapshot {
  status: "up" | "down" | "unknown";
  failures: number;
}

/** Classification of an open turn-stall episode before any actuation. */
export type StallClassificationKind = "alive" | "silent" | "dead" | "remediated" | "unready";

/** The durable resume payload written before a dead turn is aborted. Carries
 *  what a resumed session needs to continue instead of re-running the dead
 *  step: the pending tool call, the partial output seen on the wire, and the
 *  terminal shape that classified the turn dead. */
export interface StallResumeMarker {
  sessionKey: string;
  detectedAt: number;
  stallAgeMs: number;
  /** Wire silence at detection; undefined when no stream event was ever seen. */
  streamSilentForMs: number | undefined;
  transcriptTerminal: boolean;
  transcriptTerminalKind?: "tool-result" | "error";
  /** Last tool call observed with no observed result (the unexecuted call). */
  pendingToolCall?: { toolName: string; toolCallId?: string; argsPreview?: string };
  /** Bounded tail of the partial assistant output observed on the wire. */
  partialOutput?: string;
  /** Escalation fires this episode at the moment of remediation. */
  fires: number;
}

/** Per-episode stall detail for the status surface (non-clean episodes only). */
export interface StallEpisodeSnapshot {
  key: string;
  open: boolean;
  classification: StallClassificationKind;
  streamSilentForMs: number | undefined;
  transcriptTerminal: boolean;
  fires: number;
  remediated: boolean;
  ended: boolean;
}

export interface WatchdogEngineDeps {
  now: () => number;
  /** Schedule `cb` after `ms`; returns a cancel function (fake-timer seam). */
  schedule: (cb: () => void, ms: number) => () => void;
  /** Waking whisper (triggerTurn) — the escalation action. */
  wakeWhisper: (text: string) => void;
  /** Non-waking whisper (nextTurn/steer) — recovery notifications. */
  quietWhisper: (text: string) => void;
  /** Non-waking whisper for the terminal-stop episode. Falls back to
   *  `quietWhisper` when absent, so fixture tests can capture either. Must
   *  never throw. */
  terminalStopWhisper?: (text: string) => void;
  /** Optional 1-line tg signal; must never throw (absent = skipped). */
  tgSignal?: (text: string) => void;
  /** Optional tunnel transition subscription; the engine wires + disposes it. */
  subscribeTunnel?: (fn: (event: TunnelTransitionEvent) => void) => () => void;
  /** Optional current tunnel status snapshot (robustness against missed events). */
  getTunnelStatus?: () => TunnelStatusSnapshot;
  /** Optional 1-line telemetry emission per detect pass (Hook 2: the
   *  cheap idle-inclusive context-heartbeat line). Absent = skipped, so
   *  fixture tests stay hermetic. Must never throw. */
  telemetryEmit?: (entry: WatchdogTelemetryEntry) => void;
  /** Persist a resume marker to a durable seat (session entry). Returns true
   *  when the seat accepted it; absent or false means no durable checkpoint
   *  exists, so the ladder marks the turn unready instead of aborting. */
  persistResumeMarker?: (key: string, marker: StallResumeMarker) => boolean;
  /** Mechanical abort of the dead turn (the compaction cancel precedent).
   *  Called at most once per episode — the engine latches remediation. */
  abortTurn?: (key: string) => void;
  /** True when a timer/wake is due for this session: a due wake legitimately
   *  keeps a quiet session quiet, so the turn is not classified dead. */
  isWakeDue?: (key: string) => boolean;
  log?: (level: "debug" | "info" | "warn" | "error", message: string, ...rest: unknown[]) => void;
}

/** Scalar-only watchdog observer line (see lib/telemetry/context-heartbeat.ts). */
export interface WatchdogTelemetryEntry {
  ts: number;
  source: "watchdog";
  rssBytes: number;
  heapUsed: number;
  cadence: "base" | "hot";
  openConditions: string;
  quotaConsecutive: number;
  tunnelStatus: "up" | "down" | "unknown";
  tunnelFailures: number;
  stalledCount: number;
  nextCheckInMs: number;
}

export interface WatchdogSnapshot {
  enabled: boolean;
  cadence: "base" | "hot";
  openConditions: WatchdogConditionId[];
  quotaConsecutive: number;
  tunnel: TunnelStatusSnapshot;
  stalledSessions: string[];
  /** Non-clean stall episodes (open or terminal) with their classification. */
  stallEpisodes: StallEpisodeSnapshot[];
  nextCheckAt: number;
  /** Unclassified LLM failures (last 5, newest last): raw bounded text +
   *  provider + HTTP code. During a provider outage the classifier can
   *  bucket dozens of failures as `unknown`, leaving nothing but a counter
   *  — root-causing then requires a forensic pass over logs. Classified
   *  failures (quota/auth/rate/exhaustion) never enter. */
  unknownFailures: UnknownLlmFailure[];
  /** Consecutive terminal-category (auth/balance) failures since the last
   *  success; feeds the terminal-stop episode. */
  terminalConsecutive: number;
}

/** One unclassified LLM failure as retained by the snapshot ring. */
export interface UnknownLlmFailure {
  /** Engine clock (ms) when the failure was recorded. */
  at: number;
  /** Bounded (≤200 chars) raw error text as the keyring reported it. */
  text: string;
  provider?: string;
  model?: string;
  /** First standalone 4xx/5xx token in the text, when present. */
  statusCode?: number;
}

export interface WatchdogEngine {
  start(): void;
  stop(): void;
  /** Session lifecycle + turn-progress bookkeeping (index.ts wires pi hooks). */
  observeSessionStart(key: string): void;
  /** A message ended. `assistant` also clears the terminal-transcript state:
   *  the last event is a completed assistant message, not a stranded call. */
  observeProgress(key: string, kind?: "assistant" | "other"): void;
  /** A tool call was issued; `tool` carries the resume-marker payload. */
  observeToolCall(
    key: string,
    tool?: { toolCallId?: string; toolName?: string; argsPreview?: string },
  ): void;
  /** Provider stream heartbeat (assistant deltas): wire liveness. */
  observeStreamActivity(key: string, partialText?: string): void;
  /** A tool result landed: the transcript's last event awaits continuation. */
  observeToolResult(key: string, toolCallId?: string): void;
  /** The last transcript event is a provider error with no continuation. */
  observeTranscriptError(key: string): void;
  observeTurnStart(key: string): void;
  observeTurnComplete(key: string): void;
  /** Keyring/quota feed: every LLM failure (classified internally) and success.
   *  `meta` carries the keyring's provider/model identity so unclassified
   *  failures can be root-caused from the record alone. */
  recordLlmFailure(detail?: string, meta?: { provider?: string; model?: string }): void;
  recordLlmSuccess(): void;
  /** Run one detect pass synchronously (scheduled loop + test seam). */
  check(): void;
  getSnapshot(): WatchdogSnapshot;
  /** Wake-delivery feed (timer's retry queue → this engine, via the
   *  global-state seam). See WATCHDOG_WAKE_DELIVERY_FEED_KEY. */
  recordWakeOutcomeTimeout(timerId: string, reason: string, timeouts: number): void;
  recordWakeUndelivered(timerId: string, reason: string, attempts: number): void;
  recordWakeDelivered(timerId: string): void;
}

interface StallSession {
  key: string;
  streaming: boolean;
  lastActivityAt: number;
  escalatedAt: number;
  open: boolean;
  /** Last provider stream event (assistant delta); undefined = never seen. */
  lastStreamActivityAt: number | undefined;
  /** The transcript's last event is a tool result or an error, with no
   *  continuation yet (the dead shape). */
  transcriptTerminal: boolean;
  transcriptTerminalKind: "tool-result" | "error" | undefined;
  /** Last tool call observed with no observed result (resume payload). */
  pendingToolCall: { toolName: string; toolCallId?: string; argsPreview?: string } | undefined;
  /** Bounded tail of the partial assistant output seen on the wire. */
  partialOutput: string | undefined;
  /** Escalation fires in the current episode (threshold crossing + re-warns). */
  fires: number;
  /** Abort attempted (terminal, ladder stopped). */
  remediated: boolean;
  /** No durable seat accepted the marker (terminal, ladder stopped). */
  unready: boolean;
  /** Terminal hand-back already surfaced: no further warnings/actuation. */
  episodeEnded: boolean;
}

interface ConditionSink {
  open: boolean;
  lastEscalatedAt: number;
  /** Highest REWARN_MILESTONES value fired for the current open episode
   *  (0 = none). Reset ONLY when the episode latch re-arms (success
   *  streak) — a transient close must not re-arm the ladder mid-episode. */
  lastMilestone: number;
  /** / escalation-injection budget: total barks this condition has
   *  produced this session (never resets). Past the budget, only the final
   *  milestone (500) still escalates. */
  escalations: number;
}

/** Compact duration for whisper text (e.g. "75m"). */
export function formatWatchdogDuration(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m`;
  return `${Math.floor(ms / 3600000)}h`;
}

/**
 * Key-ring rotation-exhaustion idioms. The ring reports ALL LLM failures
 * (rotation needs them), and its own exhaustion messages carry no provider
 * status code — they classify as `unknown` yet are quota-class by definition
 * (all keys dead = the owner must act).
 */
const RING_EXHAUSTION_PATTERN = /key.{0,20}exhaust|keys? exhausted|rotat\w* (exhaust|fail)/i;

/** Bounded detail rendering for log lines (never unbounded error text). */
function truncateDetail(detail: string | undefined): string {
  if (!detail) return "";
  return detail.length > 200 ? `: ${detail.slice(0, 197)}...` : `: ${detail}`;
}

export function createWatchdogEngine(
  config: WatchdogConfig,
  deps: WatchdogEngineDeps,
): WatchdogEngine {
  const {
    now,
    schedule,
    wakeWhisper,
    quietWhisper,
    tgSignal,
    terminalStopWhisper,
    subscribeTunnel,
    getTunnelStatus,
    log = () => {},
  } = deps;

  const cooldownMs = WATCHDOG_COOLDOWN_MULT * config.hotMs;
  // Raw fixture configs may predate the field; resolve once against the default.
  const streamSilenceMs =
    config.streamSilenceMs > 0 ? config.streamSilenceMs : DEFAULT_WATCHDOG_CONFIG.streamSilenceMs;

  let started = false;
  let stopped = false;
  let timerCancel: (() => void) | undefined;
  let disposeTunnel: (() => void) | undefined;
  let nextCheckAt = 0;

  // Condition state.
  // Both conditions' `lastEscalatedAt` start at -Infinity ("never escalated")
  // so the first occurrence of an issue always passes the cooldown check — a 0
  // epoch would look like a just-now escalation under a fake clock at t=0.
  const quota: ConditionSink = {
    open: false,
    lastEscalatedAt: Number.NEGATIVE_INFINITY,
    lastMilestone: 0,
    escalations: 0,
  };
  let quotaConsecutive = 0;
  // Flap latch: first-bark availability + consecutive healthy evals or
  // successes since the last escalation. Factory-closure state (never
  // module-level — state contract).
  let quotaLatchArmed = true;
  let quotaHealthyStreak = 0;
  // Transient/unknown LLM failures: tracked separately, log-only — never
  // escalate from this streak (a slept Mac must not look like a quota loop).
  let transientConsecutive = 0;
  const tunnel: ConditionSink & {
    status: "up" | "down" | "unknown";
    failures: number;
    lastMessageEnvelope?: string;
  } = {
    open: false,
    lastEscalatedAt: Number.NEGATIVE_INFINITY,
    lastMilestone: 0,
    escalations: 0,
    status: "unknown",
    failures: 0,
  };
  const stalls = new Map<string, StallSession>();

  /**
   * Wake-delivery episode (fed by the timer's wake-retry queue via the
   * global-state feed seam — see WATCHDOG_WAKE_DELIVERY_FEED_KEY). Event-
   * driven: the retry queue's own drain ticks are the detection cadence, so
   * this condition needs no detect-pass polling. Dedupe is the episode latch:
   * the FIRST threshold event (repeated outcome timeouts for one fire, or an
   * exhausted drop — whichever comes first) opens the episode and barks once;
   * every later event of the same dead-delivery episode is absorbed. Recovery
   * (a tracked wake settling delivered) closes it with one quiet line.
   */
  const wakeDelivery = { open: false };

  /**
   * Terminal-provider-stop episode: a distinct counter of auth/balance
   * failures (the quota loop counts rate_limit+balance+auth together — a 429
   * burst is not a terminal stop). ONE non-waking emission per episode: the
   * open flag latches the first threshold crossing; later failures of the
   * same episode are absorbed. Closed on a success, so a genuinely recovered
   * route's next stop barks once more. No milestone re-warn ladder and no
   * escalation-budget accounting: one per episode by construction.
   */
  const terminalStop = { open: false };
  let terminalStopConsecutive = 0;
  let terminalStopFirstAt: number | undefined;
  let terminalStopLastCategory: string | undefined;
  let terminalStopLastStatus: number | undefined;

  /** Unclassified-failure ring: bounded to the last N records.
   *  Factory-closure state (never module-level — src/lib/state/AGENTS.md). */
  const unknownFailures: UnknownLlmFailure[] = [];

  function isEnabled(): boolean {
    return config.mode === "on" && started && !stopped;
  }

  function openConditions(): WatchdogConditionId[] {
    const out: WatchdogConditionId[] = [];
    if (quota.open) out.push("quota-loop");
    if (tunnel.open) out.push("tunnel-down");
    if (wakeDelivery.open) out.push("wake-delivery");
    if (terminalStop.open) out.push("terminal-stop");
    for (const s of stalls.values()) if (s.open) out.push("turn-stall");
    return out;
  }

  function anyOpen(): boolean {
    return openConditions().length > 0;
  }

  function fireEscalation(text: string, tg: string): void {
    wakeWhisper(text);
    try {
      tgSignal?.(tg);
    } catch {
      // optional — never fatal
    }
  }

  /**
   * Milestone edge-detector for repeat re-warns: the highest milestone that
   * `n` has reached (n >= milestone, i.e. crossed from below) but that is
   * still above `lastMilestone` (the highest already fired this episode), or
   * undefined when no new milestone was crossed. The fired high-water mark
   * resets only when the episode latch re-arms (success streak), so a
   * flapping condition keeps its ladder while a genuinely recovered provider
   * gets a fresh one for the next outage.
   */
  function crossedRewarnMilestone(n: number, lastMilestone: number): number | undefined {
    let crossed: number | undefined;
    for (const m of REWARN_MILESTONES) {
      if (n >= m && m > lastMilestone) crossed = m;
    }
    return crossed;
  }

  /**
   * / injection budget gate: past the per-session budget for this
   * condition, only the final milestone (500) still escalates.
   */
  function budgetAllows(sink: ConditionSink, milestone: number): boolean {
    return (
      sink.escalations < WATCHDOG_ESCALATION_BUDGET_PER_SESSION ||
      milestone === FINAL_REWARN_MILESTONE
    );
  }

  /**
   * Shared tunnel-down escalation gate — both the scheduled detect pass
   * (evaluateTunnel) and the tunnel push subscription route through here so
   * the milestone throttle cannot be bypassed by either path. Assumes
   * tunnel.status / tunnel.failures already reflect current state.
   */
  function escalateTunnelDownGated(): void {
    if (!tunnel.open) {
      // Threshold crossing: the first escalation for an open condition
      // always fires when the budget allows (first bark = wake-up feature).
      if (!budgetAllows(tunnel, 0)) return;
      tunnel.open = true;
      tunnel.lastMilestone = 0;
      escalateTunnelDown();
      tunnel.escalations++;
      tunnel.lastEscalatedAt = now();
      return;
    }
    // Continuously open: sparse milestone re-warn, with the normal cooldown
    // kept as a second gate (strictly-fewer barks, never more).
    if (now() - tunnel.lastEscalatedAt < cooldownMs) return;
    const m = crossedRewarnMilestone(tunnel.failures, tunnel.lastMilestone);
    if (m === undefined) return;
    if (!budgetAllows(tunnel, m)) return;
    escalateTunnelDown();
    tunnel.escalations++;
    tunnel.lastEscalatedAt = now();
    tunnel.lastMilestone = m;
  }

  // Escalation paths (per condition)

  function escalateTurnStall(s: StallSession): void {
    const dur = formatWatchdogDuration(now() - s.lastActivityAt);
    const label = s.key.length > 48 ? `${s.key.slice(0, 45)}…` : s.key;
    fireEscalation(
      `Watchdog: turn stall detected — the active turn has had no tool-call and no turn-complete for >${dur} ` +
        `(session ${label}). Diagnose the stall, log what you find, and take the safe action ` +
        `(finish/abort the turn or resume the interrupted step) before continuing.`,
      `[watchdog] turn stall >${dur} — agent alive?`,
    );
  }

  // Stall classification + bounded ladder

  function newStallSession(key: string): StallSession {
    return {
      key,
      streaming: false,
      lastActivityAt: now(),
      escalatedAt: Number.NEGATIVE_INFINITY,
      open: false,
      lastStreamActivityAt: undefined,
      transcriptTerminal: false,
      transcriptTerminalKind: undefined,
      pendingToolCall: undefined,
      partialOutput: undefined,
      fires: 0,
      remediated: false,
      unready: false,
      episodeEnded: false,
    };
  }

  function ensureStall(key: string): StallSession {
    let s = stalls.get(key);
    if (!s) {
      s = newStallSession(key);
      stalls.set(key, s);
    }
    return s;
  }

  /** Progress (a tool call, a tool result, a message, a turn boundary) closes
   *  the episode and re-arms the ladder for the next one. */
  function closeStallEpisode(s: StallSession): void {
    s.open = false;
    s.fires = 0;
    s.remediated = false;
    s.unready = false;
    s.episodeEnded = false;
  }

  function streamSilentForMs(s: StallSession): number | undefined {
    return s.lastStreamActivityAt === undefined ? undefined : now() - s.lastStreamActivityAt;
  }

  function isWakeDue(key: string): boolean {
    try {
      return deps.isWakeDue?.(key) === true;
    } catch {
      return false;
    }
  }

  /** The classification gate: live wire activity is not a stall; wire silence
   *  plus a terminal transcript (and no due wake) is dead; anything else is
   *  silent-ambiguous and stays advisory. */
  function classifyStall(s: StallSession): StallClassificationKind {
    if (s.remediated) return "remediated";
    if (s.unready) return "unready";
    const silentFor = streamSilentForMs(s);
    const silent = silentFor === undefined || silentFor > streamSilenceMs;
    if (!silent) return "alive";
    if (s.transcriptTerminal && !isWakeDue(s.key)) return "dead";
    return "silent";
  }

  function boundHead(text: string | undefined, cap: number): string | undefined {
    if (!text) return undefined;
    return text.length > cap ? `${text.slice(0, cap - 1)}…` : text;
  }

  function boundTail(text: string | undefined, cap: number): string | undefined {
    if (!text) return undefined;
    return text.length > cap ? `…${text.slice(-(cap - 1))}` : text;
  }

  function buildResumeMarker(s: StallSession): StallResumeMarker {
    return {
      sessionKey: s.key,
      detectedAt: now(),
      stallAgeMs: now() - s.lastActivityAt,
      streamSilentForMs: streamSilentForMs(s),
      transcriptTerminal: s.transcriptTerminal,
      transcriptTerminalKind: s.transcriptTerminalKind,
      pendingToolCall: s.pendingToolCall ? { ...s.pendingToolCall } : undefined,
      partialOutput: s.partialOutput,
      fires: s.fires,
    };
  }

  /** Out-of-band owner page (the tg-signal seam); must never throw. */
  function pageOwner(text: string): void {
    try {
      tgSignal?.(text);
    } catch {
      // optional — never fatal
    }
  }

  /**
   * Rung 3 of the ladder: persist before cancel (a cancel without a durable
   * checkpoint is kill-and-forget), cancel once, hand back to the owner. A
   * missing half — no seat accepted the marker, or no abort seam is wired —
   * degrades to the unready hand-back instead of aborting.
   */
  function remediateStall(s: StallSession): void {
    const marker = buildResumeMarker(s);
    const silentFor = marker.streamSilentForMs;
    const silenceLabel = silentFor === undefined ? "unknown" : formatWatchdogDuration(silentFor);
    const terminalLabel = s.transcriptTerminalKind ?? "terminal";
    let persisted = false;
    try {
      persisted = deps.persistResumeMarker?.(s.key, marker) === true;
    } catch (err) {
      log("warn", `watchdog: resume marker persist failed: ${(err as Error).message}`);
    }
    const canAbort = typeof deps.abortTurn === "function";
    if (!persisted || !canAbort) {
      s.unready = true;
      s.episodeEnded = true;
      const why = !persisted
        ? "no durable resume seat accepted the marker"
        : "no abort seam is wired";
      log("warn", `watchdog: turn stall UNREADY (${why}) — abort withheld for ${s.key}`);
      pageOwner(
        `[watchdog] dead turn unready — no provider stream activity for ${silenceLabel}, ` +
          `transcript terminal (${terminalLabel}), but ${why}; abort withheld rather than killing and forgetting. ` +
          `A manual quit + resume replays the pending step.`,
      );
      return;
    }
    s.remediated = true;
    s.episodeEnded = true;
    try {
      deps.abortTurn?.(s.key);
    } catch (err) {
      log("warn", `watchdog: abort of the stalled turn failed: ${(err as Error).message}`);
    }
    log(
      "warn",
      `watchdog: turn stall remediated — resume marker persisted, abort dispatched for ${s.key}`,
    );
    pageOwner(
      `[watchdog] dead turn aborted — no provider stream activity for ${silenceLabel}, ` +
        `transcript terminal (${terminalLabel}), no wake due. Resume marker written to the session; ` +
        `the next turn resumes from it instead of re-running the dead step.`,
    );
    quietWhisper(
      `Watchdog: the stalled turn was aborted after ${silenceLabel} of wire silence; a resume marker ` +
        `was written to this session (pending tool call + partial output). Resume from the marker.`,
    );
  }

  function escalateQuotaLoop(): void {
    const n = quotaConsecutive;
    fireEscalation(
      `Watchdog: LLM rate-limit/quota loop — ${n} consecutive rate-limit/quota/auth failures with no success. ` +
        `Suggest switching model, backing off, or pausing; report the provider state so the owner can act.`,
      `[watchdog] LLM rate-limit/quota loop (${n}x) — backoff/pause?`,
    );
  }

  /** ONE non-waking emission for the terminal-stop episode. Content per the
   *  design: count, local first-error time, last category + numeric status if
   *  present, and the fix line. No key material, hashes, key counts or dollar
   *  figures — `llm-error`'s raw text is deliberately not echoed. */
  function escalateTerminalStop(): void {
    const n = terminalStopConsecutive;
    const since = terminalStopFirstAt ? formatLocalTime(new Date(terminalStopFirstAt)) : "unknown";
    const last = terminalStopLastCategory ?? "auth/balance";
    const status = terminalStopLastStatus != null ? ` ${terminalStopLastStatus}` : "";
    const text =
      `Watchdog: terminal provider stop — ${n} auth/balance errors since ${since} ` +
      `(last: ${last}${status}). Timer wakes are paused for this session; no retry will be attempted. ` +
      `Fix the cause, then restart the session or switch the model.`;
    try {
      (terminalStopWhisper ?? quietWhisper)(text);
    } catch (err) {
      log("warn", `watchdog: terminal-stop whisper delivery failed: ${(err as Error).message}`);
    }
  }

  function escalateTunnelDown(): void {
    const n = tunnel.failures;
    fireEscalation(
      tunnel.lastMessageEnvelope ??
        `Watchdog: telegram tunnel DOWN (${n} consecutive getUpdates failures). The remote canary is ` +
          `offline — diagnose the tunnel/poller before relying on remote operations.`,
      `[watchdog] tg tunnel down (${n} fetch failures)`,
    );
  }

  /** Bounded timer-reason rendering for the wake-delivery bark text. */
  function boundReason(reason: string): string {
    return reason.length > 120 ? `${reason.slice(0, 117)}…` : reason;
  }

  // Wake-delivery feed (timer → watchdog)

  /** Repeated outcome timeouts for one fire: the loop is not settling wake
   *  turns. The queue only arms (and forwards) an outcome timeout when NO
   *  agent run is active for the fire — a merely-long run never reaches
   *  here (drainDue's long-run grace), and a wedged ACTIVE run pages via
   *  turn-stall instead. What reaches this function is a dead delivery:
   *  consecutive windows with no settle and no run. One bark per episode;
   *  later timeouts of the same episode are absorbed (a wedged loop must
   *  not page per retry). */
  function recordWakeOutcomeTimeout(timerId: string, reason: string, timeouts: number): void {
    if (!isEnabled() || wakeDelivery.open) return;
    wakeDelivery.open = true;
    fireEscalation(
      `Watchdog: wake delivery stalling — timer ${timerId} ("${boundReason(reason)}") has ` +
        `${timeouts} consecutive wake outcome timeouts with no turn settle and no agent run active. ` +
        `The wake send likely never started a turn (a pre-flight abort never settles wakes). ` +
        `Check for lost timer fires before relying on timer wakes.`,
      `[watchdog] timer wake not settling (${timeouts}× outcome timeout, no active run) — wake send lost?`,
    );
  }

  /** A fire dropped after exhausting its redelivery bound: the scheduled
   *  content is permanently lost. Barks only when it is the episode's first
   *  event — if outcome timeouts already paged, the episode stays one bark. */
  function recordWakeUndelivered(timerId: string, reason: string, attempts: number): void {
    if (!isEnabled() || wakeDelivery.open) return;
    wakeDelivery.open = true;
    fireEscalation(
      `Watchdog: wake delivery died — timer ${timerId} ("${boundReason(reason)}") was permanently ` +
        `undelivered after ${attempts} redeliveries; the scheduled content never reached a turn. ` +
        `Check the agent loop / provider health before relying on timer wakes.`,
      `[watchdog] wake fire permanently undelivered after ${attempts} retries: ${boundReason(reason)}`,
    );
  }

  /** A tracked wake settled delivered — the loop runs again. Closes the
   *  episode with one recovery line. The tunnel recovery precedent only
   *  whispers because tg itself was down; here tg is the channel that WORKED
   *  (the wedge was the loop, not the tunnel), so the owner who got the tg
   *  bark also gets the tg all-clear. */
  function recordWakeDelivered(timerId: string): void {
    if (!isEnabled() || !wakeDelivery.open) return;
    wakeDelivery.open = false;
    quietWhisper(
      `Watchdog: wake delivery recovered — timer wakes are settling again (confirmed by timer ${timerId}).`,
    );
    try {
      tgSignal?.("[watchdog] wake delivery recovered — timer wakes settling again");
    } catch {
      // optional — never fatal
    }
  }

  // Detect pass

  // Standalone closure (no `this`) so both the object's check() method and
  // the scheduled timer call it, and any code path (check, tunnel push) can
  // re-cadence immediately after a condition opens.
  const performCheck = (): void => {
    if (!isEnabled()) return;
    evaluateQuota();
    evaluateTunnel();
    evaluateStalls();
    scheduleNextCheck();
    emitTelemetryLine();
  };

  /**
   * Hook 2: one cheap scalar telemetry line per detect pass so idle
   * processes are covered on the watchdog's wall-clock cadence (the OOM
   * overnight window had idle processes too). No ctx here — the wired
   * emitter (watchdog/index.ts) enriches with sessionId/session size/
   * health mode. Optional dep keeps fixture tests hermetic.
   */
  function emitTelemetryLine(): void {
    if (!deps.telemetryEmit) return;
    try {
      const mem = process.memoryUsage();
      deps.telemetryEmit({
        ts: now(),
        source: "watchdog",
        rssBytes: mem.rss,
        heapUsed: mem.heapUsed,
        cadence: anyOpen() ? "hot" : "base",
        openConditions: openConditions().join(",").slice(0, 120),
        quotaConsecutive,
        tunnelStatus: tunnel.status,
        tunnelFailures: tunnel.failures,
        stalledCount: [...stalls.values()].filter((s) => s.open).length,
        nextCheckInMs: Math.max(0, nextCheckAt - now()),
      });
    } catch {
      // telemetry never fatal
    }
  }

  /** Soft backoff: hot while ≥1 issue is open, base when clean. */
  const scheduleNextCheck = (): void => {
    const cadence = anyOpen() ? "hot" : "base";
    const intervalMs = cadence === "hot" ? config.hotMs : config.baseMs;
    nextCheckAt = now() + intervalMs;
    if (timerCancel) timerCancel();
    timerCancel = schedule(() => performCheck(), intervalMs);
  };

  function evaluateQuota(): void {
    const problem = quotaConsecutive >= config.quotaErrors;
    if (problem) {
      quotaHealthyStreak = 0; // any quota failure breaks the success streak
      if (!quota.open) {
        quota.open = true;
        if (quotaLatchArmed && budgetAllows(quota, 0)) {
          // Threshold crossing + latch armed: the FIRST escalation of the
          // open episode always fires (owner-endorsed wake-up feature), and
          // the episode starts with a fresh milestone ladder.
          quotaLatchArmed = false;
          quota.lastMilestone = 0;
          escalateQuotaLoop();
          quota.escalations++;
          quota.lastEscalatedAt = now();
          return;
        }
        // Same episode re-opened after a transient close (flap): NO new
        // wake bark and the ladder keeps its high-water — fall through to
        // the milestone gate. This is the D6 storm fix. (A budget-exhausted
        // session also lands here: only the 500 rung escalates.)
      }
      // Continuously open: sparse milestone re-warn, with the normal
      // cooldown kept as a second gate (strictly-fewer barks, never more).
      if (now() - quota.lastEscalatedAt < cooldownMs) return;
      const m = crossedRewarnMilestone(quotaConsecutive, quota.lastMilestone);
      if (m === undefined) return;
      if (!budgetAllows(quota, m)) return;
      escalateQuotaLoop();
      quota.escalations++;
      quota.lastEscalatedAt = now();
      quota.lastMilestone = m;
    } else if (quota.open) {
      // Silent recovery (already rotating / success). latch: a transient
      // close does NOT reset the milestone ladder nor re-arm the wake bark —
      // re-arm requires the success streak (noteQuotaHealthy).
      quota.open = false;
    } else {
      noteQuotaHealthy();
    }
  }

  /** Latch re-arm: a consecutive success streak (healthy evaluations or
   *  LLM successes — both funnel here) re-arms the first bark and starts a
   *  fresh milestone ladder for the next genuine outage. */
  function noteQuotaHealthy(): void {
    if (quotaLatchArmed) return;
    quotaHealthyStreak++;
    if (quotaHealthyStreak >= QUOTA_REARM_SUCCESS_STREAK) {
      quotaLatchArmed = true;
      quota.lastMilestone = 0;
      quotaHealthyStreak = 0;
    }
  }

  function evaluateTunnel(): void {
    // Snapshot-driven seatbelt: covers a down event emitted before we
    // subscribed (the hub preserves the latest status; the push handler emits
    // the primary escalation, this keeps a missed transition from wedging).
    const snap = getTunnelStatus?.();
    if (snap) {
      tunnel.status = snap.status;
      tunnel.failures = snap.failures;
    }
    const down = tunnel.status === "down" && tunnel.failures >= config.tunnelFailures;
    if (down) {
      escalateTunnelDownGated();
    } else if (tunnel.open) {
      // Genuine up transition = explicit success: full re-arm.
      tunnel.open = false;
      tunnel.lastMilestone = 0; // re-arm the ladder for the next outage
    }
  }

  function evaluateStalls(): void {
    const threshold = config.stallMult * config.baseMs;
    for (const s of stalls.values()) {
      const age = now() - s.lastActivityAt;
      if (s.streaming && age > threshold) {
        if (s.episodeEnded) continue; // terminal hand-back already surfaced
        const cls = classifyStall(s);
        if (!s.open) {
          // Threshold crossing: fire 1 = rung 1 (notify) + rung 2 (classify).
          s.open = true;
          s.fires = 1;
          s.escalatedAt = now();
          log(
            "warn",
            `watchdog: turn stall first fire (${s.key}) — classification ${cls}` +
              ` (wire silence ${streamSilentForMs(s) ?? "?"}ms, transcript terminal ${s.transcriptTerminal})`,
          );
          escalateTurnStall(s);
          continue;
        }
        if (now() - s.escalatedAt < STALL_REWARN_COOLDOWN_MULT * cooldownMs) continue;
        s.fires++;
        if (cls === "dead" && s.fires >= STALL_SERVICE_FIRE) {
          remediateStall(s);
          continue;
        }
        // Advisory re-warn: the counter-less long cooldown (sparse but
        // periodic), unchanged for episodes that never confirm dead.
        escalateTurnStall(s);
        s.escalatedAt = now();
      } else if (s.open) {
        closeStallEpisode(s);
      }
    }
  }

  // Public surface

  return {
    start() {
      if (started) return;
      if (config.mode !== "on") {
        log("info", "watchdog engine disabled (broker.watchdog.mode != on)");
        return;
      }
      started = true;
      stopped = false;
      // Prime the tunnel state from the shared hub so a down event emitted
      // before subscription is not lost.
      const snap = getTunnelStatus?.();
      if (snap) {
        tunnel.status = snap.status;
        tunnel.failures = snap.failures;
      }
      if (subscribeTunnel) {
        disposeTunnel = subscribeTunnel((event) => {
          // The push handler both seeds state and escalates/reports recovery.
          tunnel.status = event.status;
          tunnel.failures = event.failures;
          if (event.status === "down") {
            if (event.message) tunnel.lastMessageEnvelope = event.message;
            if (event.failures >= config.tunnelFailures) {
              const wasOpen = tunnel.open;
              escalateTunnelDownGated();
              // Fast recheck while the issue is open (design: soft backoff).
              if (!wasOpen) scheduleNextCheck();
            }
          } else {
            // Tunnel recovered: close + one quiet recovery whisper.
            // Genuine up event = explicit success: full ladder re-arm.
            const wasOpen = tunnel.open;
            tunnel.open = false;
            tunnel.lastMilestone = 0; // re-arm the ladder for the next outage
            if (wasOpen) quietWhisper(event.message || "Telegram tunnel recovered.");
          }
        });
      }
      scheduleNextCheck();
      log(
        "info",
        `watchdog engine started (${config.mode}, base ${config.baseMs}ms, hot ${config.hotMs}ms)`,
      );
    },

    stop() {
      stopped = true;
      if (timerCancel) timerCancel();
      timerCancel = undefined;
      if (disposeTunnel) disposeTunnel();
      disposeTunnel = undefined;
      log("info", "watchdog engine stopped");
    },

    observeSessionStart(key: string) {
      stalls.set(key, newStallSession(key));
    },

    observeProgress(key, kind) {
      const s = ensureStall(key);
      s.lastActivityAt = now();
      if (kind === "assistant") {
        s.transcriptTerminal = false;
        s.transcriptTerminalKind = undefined;
      }
      if (s.open) closeStallEpisode(s); // progress resolved the stall
    },

    observeToolCall(key, tool) {
      const s = ensureStall(key);
      // "uses last-tool-call, not wall clock" — a fresh tool call resets the
      // stall clock even if the wall clock is old.
      s.lastActivityAt = now();
      s.transcriptTerminal = false;
      s.transcriptTerminalKind = undefined;
      if (tool?.toolName) {
        s.pendingToolCall = {
          toolName: tool.toolName,
          toolCallId: tool.toolCallId,
          argsPreview: boundHead(tool.argsPreview, RESUME_MARKER_ARGS_CAP),
        };
      }
      if (s.open) closeStallEpisode(s);
    },

    observeStreamActivity(key, partialText) {
      const s = ensureStall(key);
      s.lastStreamActivityAt = now();
      s.transcriptTerminal = false;
      s.transcriptTerminalKind = undefined;
      if (partialText) s.partialOutput = boundTail(partialText, RESUME_MARKER_TEXT_CAP);
    },

    observeToolResult(key, toolCallId) {
      const s = ensureStall(key);
      s.lastActivityAt = now();
      s.transcriptTerminal = true;
      s.transcriptTerminalKind = "tool-result";
      // Clear the pending call when ids match, or when either side carries no
      // id (an unmatchable result is the only candidate).
      const pendingId = s.pendingToolCall?.toolCallId;
      if (!toolCallId || !pendingId || pendingId === toolCallId) s.pendingToolCall = undefined;
      if (s.open) closeStallEpisode(s);
    },

    observeTranscriptError(key) {
      const s = ensureStall(key);
      s.transcriptTerminal = true;
      s.transcriptTerminalKind = "error";
    },

    observeTurnStart(key) {
      const s = ensureStall(key);
      s.streaming = true;
      s.lastStreamActivityAt = now(); // the wire clock starts with the new call
      s.transcriptTerminal = false;
      s.transcriptTerminalKind = undefined;
      s.pendingToolCall = undefined;
      s.partialOutput = undefined;
      closeStallEpisode(s);
    },

    observeTurnComplete(key) {
      const s = ensureStall(key);
      s.streaming = false;
      s.lastActivityAt = now();
      s.transcriptTerminal = false;
      s.transcriptTerminalKind = undefined;
      s.pendingToolCall = undefined;
      s.partialOutput = undefined;
      closeStallEpisode(s);
    },

    recordLlmFailure(detail?: string, meta?: { provider?: string; model?: string }): void {
      // The key ring reports ALL LLM failures (rotation needs them), but only
      // quota-class outcomes feed the quota loop: rate-limit/balance/auth, or
      // ring-exhaustion text (which carries no provider status code).
      // Transient/abort/unknown (sleep timeouts, dropped sockets) must never
      // bark quota — they get a separate log-only streak instead.
      const category = classifyLlmError(detail ?? "").category;
      const ringExhausted = detail !== undefined && RING_EXHAUSTION_PATTERN.test(detail);
      if (
        category === "rate_limit" ||
        category === "balance" ||
        category === "auth" ||
        ringExhausted
      ) {
        quotaConsecutive++;
        quotaHealthyStreak = 0; // failures break the success streak
        // A terminal stop is auth/balance only (NOT rate_limit, NOT ring
        // exhaustion without a status): a throttled ring keeps waking.
        if (category === "auth" || category === "balance") {
          if (terminalStopConsecutive === 0) terminalStopFirstAt = now();
          terminalStopConsecutive++;
          terminalStopLastCategory = category;
          terminalStopLastStatus = detail ? extractHttpCodeFromText(detail) : undefined;
          if (!terminalStop.open && terminalStopConsecutive >= config.quotaErrors && isEnabled()) {
            terminalStop.open = true;
            escalateTerminalStop();
          }
        }
        log(
          "warn",
          `watchdog: LLM rate-limit/quota/auth failure (${quotaConsecutive} consecutive)${truncateDetail(detail)}`,
        );
      } else {
        transientConsecutive++;
        if (category === "unknown") {
          // An unclassified failure is exactly the case the classifier
          // failed on — retain the raw evidence (bounded text, provider
          // identity, extracted HTTP code) in the snapshot ring so
          // root-causing needs no separate forensic pass. Ring-exhaustion
          // text is quota-class by definition and never lands here.
          unknownFailures.push({
            at: now(),
            text: truncateDetail(detail).replace(/^: /, ""),
            provider: meta?.provider,
            model: meta?.model,
            statusCode: detail ? extractHttpCodeFromText(detail) : undefined,
          });
          if (unknownFailures.length > UNKNOWN_FAILURE_RING_CAP) unknownFailures.shift();
          log(
            "warn",
            `watchdog: LLM unknown failure (transient streak ${transientConsecutive}, ` +
              `provider ${meta?.provider ?? "?"}, HTTP ${
                detail ? (extractHttpCodeFromText(detail) ?? "?") : "?"
              })${truncateDetail(detail)}`,
          );
        } else {
          log(
            "debug",
            `watchdog: LLM ${category} failure (transient streak ${transientConsecutive}, not quota)${truncateDetail(detail)}`,
          );
        }
      }
    },

    recordLlmSuccess() {
      if (quotaConsecutive > 0) {
        log("info", `watchdog: LLM quota streak cleared after ${quotaConsecutive} failure(s)`);
        quotaConsecutive = 0;
      }
      if (terminalStopConsecutive > 0) {
        terminalStopConsecutive = 0;
        terminalStopFirstAt = undefined;
        terminalStopLastCategory = undefined;
        terminalStopLastStatus = undefined;
      }
      // End the episode: a recovered route that later stops terminally barks
      // once more. (No success-streak re-arm latch — see escalateTerminalStop.)
      terminalStop.open = false;
      if (transientConsecutive > 0) {
        log(
          "debug",
          `watchdog: LLM transient streak cleared after ${transientConsecutive} failure(s)`,
        );
        transientConsecutive = 0;
      }
      if (quota.open) {
        quota.open = false;
        // Flap latch: do NOT reset the milestone ladder here — a single
        // success after a long outage is not a new episode. Re-arm requires
        // the success streak (below).
      }
      // An explicit success feeds the re-arm streak (≥3 consecutive
      // successes re-arm the first bark + fresh ladder, killing the
      // close→open flap storm while preserving per-episode wake-ups).
      noteQuotaHealthy();
    },

    check() {
      performCheck();
    },

    recordWakeOutcomeTimeout,
    recordWakeUndelivered,
    recordWakeDelivered,

    getSnapshot(): WatchdogSnapshot {
      return {
        enabled: isEnabled(),
        cadence: anyOpen() ? "hot" : "base",
        openConditions: openConditions(),
        quotaConsecutive,
        tunnel: { status: tunnel.status, failures: tunnel.failures },
        stalledSessions: [...stalls.values()].filter((s) => s.open).map((s) => s.key),
        stallEpisodes: [...stalls.values()]
          .filter((s) => s.open || s.episodeEnded)
          .map((s) => ({
            key: s.key,
            open: s.open,
            classification: classifyStall(s),
            streamSilentForMs: streamSilentForMs(s),
            transcriptTerminal: s.transcriptTerminal,
            fires: s.fires,
            remediated: s.remediated,
            ended: s.episodeEnded,
          })),
        nextCheckAt,
        unknownFailures: unknownFailures.map((r) => ({ ...r })),
        terminalConsecutive: terminalStopConsecutive,
      };
    },
  };
}
