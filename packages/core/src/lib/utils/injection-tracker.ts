/**
 * Injection Tracker - tracks all messages sent via pi.sendMessage/sendUserMessage.
 *
 * Purpose: Make the model's context visible. When extensions inject messages
 * (enforcement whispers, memory nudges, retry prompts, etc.), users should be
 * able to see what the model sees.
 *
 * State is keyed by optional sessionId to prevent cross-session leakage.
 * Defaults to a "default" bucket when no sessionId is provided.
 *
 * The in-memory bucket is a fast path, not the source of truth: every tracked
 * injection also appends a durable session entry (`INJECTION_ENTRY_TYPE`) and
 * `session_start` / `session_tree` rebuild the active bucket from
 * `ctx.sessionManager.getBranch()`. Branch-sensitive state must follow the
 * branch (checkout, resume), and abandoned branches are alternative histories
 * that are never replayed.
 *
 * Usage:
 *   import { trackInjection, getInjections, clearInjections } from "./injection-tracker.js";
 *   trackInjection({ type: "enforcement", source: "enforcement/whisper", content: "..." });
 */

import { createLogger } from "../core/logger.js";
import { SESSION_SHUTDOWN, MESSAGE_START, MESSAGE_END } from "../core/event-names.js";
import { tryWhisper, type WhisperPriority } from "../enforcement/turn-dedup.js";
import { BRAID_ID, BRAID_INJECTED, BRAID_SOURCE } from "../constants/injection-details.js";
import { areCognitiveNudgesDisabled } from "../config/braid-settings.js";
import { registerSessionStartHandler, SessionPhase } from "../state/session-start-queue.js";
import { nextId } from "./id.js";
import { applyWhisperEnvelope } from "./whisper-format.js";
import { gateTriggerTurnOptions, isAgentBusy } from "./wake-gate.js";

const log = createLogger("injection-tracker");

export interface Injection {
  id: string;
  type: "enforcement" | "memory" | "retry" | "heartbeat" | "context" | "sop-suggestion" | "other";
  source: string;
  content: string;
  timestamp: number;
  display: boolean;
  steer: boolean;
  turn: number;
}

interface InjectionBucket {
  injections: Injection[];
  maxInjections: number;
}

/**
 * Custom entry type for durable injection records. Stable: reconstruction
 * scans branch entries by this key, so renaming it orphans older sessions.
 */
export const INJECTION_ENTRY_TYPE = "braid_injection";

/** Per-bucket cap; also applied when rebuilding a bucket from branch entries. */
export const MAX_INJECTIONS = 200;

/**
 * Display cap for a tracked body. The log is a bounded render, not a store of
 * record: callers whose entry IS the record (the context-manager owner-input
 * seat) pass `fullContent` to keep the body verbatim.
 */
const MAX_INJECTION_CONTENT = 500;

/**
 * Structural appendEntry seam: the documented durable write path
 * (pi.appendEntry -> sessionManager.appendCustomEntry). Same shape as
 * compaction-trace's EntryAppender, so tests can double it without a full
 * extension API.
 */
export interface InjectionEntryAppender {
  appendEntry<T = unknown>(customType: string, data?: T): void;
}

// The appender is captured from the extension API at registration time
// because trackInjection runs on deep send paths with no `pi` in scope.
// Best-effort: an unset or throwing seam degrades to the in-memory bucket,
// which is exactly the pre-durable behavior. Module-level let, documented
// exception (seam slot) in lib/state/AGENTS.md.
let _entryAppender: InjectionEntryAppender | undefined;

// _buckets: keyed by sessionId, so it IS effectively session-scoped despite
//   living at module level. Cleared on SESSION_SHUTDOWN (see registerInjectionTracker).
// _activeSessionId: pointer to the most recent sessionId; fallback for callers
//   that lose ctx (e.g. after compaction).
// _sendDepth: process-global re-entry counter for sendTrackedMessage.
const _buckets = new Map<string, InjectionBucket>();

let _activeSessionId: string | undefined;

// Same-body cross-call de-bloat. turn-dedup.ts only caps whispers WITHIN a
// single turn (per-turn window closes on each `input`), so a body that
// legitimately re-fires after its per-turn window — turn after turn, each a
// fresh token load — was never deduped. The benchmark measured 41% of
// 7,690 whisper deliveries (3,129) as exact-repeat bodies re-injected within
// the same session. This layer suppresses a normalised-exact-repeat body
// re-delivered inside REPRIME_COOLDOWN_MS, scoped per-session like _buckets
// and cleared on SESSION_SHUTDOWN.
//
// REPRIME_COOLDOWN_MS: a signal that still matters 20+ minutes later
// re-fires after the window elapses; the rapid turn-after-turn re-prime spam
// (the measured waste) is cut.
export const REPRIME_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes

interface ReprimeBucket {
  /** normalized body key -> lastEmittedAt (ms epoch), per session. */
  lastEmitted: Map<string, number>;
}

// _reprime: keyed by sessionId (same convention as _buckets). Cleared via
// the SESSION_SHUTDOWN handler in registerInjectionTracker so a body can fire
// fresh in the next session (no cross-session cooldown bleed).
// The per-session lastEmitted map grows one entry per DISTINCT whisper body
// for the whole session; only entries inside the cooldown window can ever
// matter, so expired entries are pruned on every emit and a hard cap bounds
// pathological body diversity. See REPRIME_MAX_ENTRIES below.
const _reprime = new Map<string, ReprimeBucket>();

/**
 * Unresolved-advisory registry: one entry per advisory message that has been
 * handed to pi but whose append event has not been observed yet.
 *
 * WHY: an advisory emitted while an earlier one of the same kind is still
 * in flight stacks behind it (pi's follow-up lane drains one message per
 * run stop), so the newer notice arrives after the work it asks for. The
 * emitter checks `hasUnresolvedAdvisory()` before emitting and skips the
 * emission while one is in flight; the entry retires when the delivered
 * message is appended, which pi reports as `message_start` + `message_end`
 * carrying the message's `details` (the same object this module tagged with
 * `BRAID_ID`).
 *
 * Process-global, not per-session: ids are unique per process and the
 * shutdown handler clears the map at the session boundary, so a new session
 * never inherits an in-flight flag from the previous one. The TTL is the
 * safety valve for a lost event (a suppressed send, a crash between
 * emission and append): a stale entry must not wedge the emitter forever.
 */
interface UnresolvedAdvisory {
  id: string;
  advisory: string;
  emittedAt: number;
}

/**
 * TTL for an unresolved advisory. Sized above any observed emission->append
 * window (park flushes at the same turn_end; the follow-up tail ran to
 * hours) so a live delivery is never cut off, and short enough that a lost
 * event cannot wedge the emitter for the session.
 */
export const UNRESOLVED_ADVISORY_TTL_MS = 30 * 60 * 1000; // 30 minutes

const _unresolvedAdvisories = new Map<string, UnresolvedAdvisory>();

// Test-only clock override so fixtures can prove the TTL opens the gate
// without waiting REAL minutes. null restores Date.now(). Same pattern as
// the reprime clock above.
let _advisoryNowOverride: number | null = null;

function advisoryNow(): number {
  return _advisoryNowOverride ?? Date.now();
}

/** Drop entries whose TTL expired; a lost event must not wedge the emitter. */
function pruneUnresolvedAdvisories(now: number = advisoryNow()): void {
  for (const [id, entry] of _unresolvedAdvisories) {
    if (now - entry.emittedAt >= UNRESOLVED_ADVISORY_TTL_MS) _unresolvedAdvisories.delete(id);
  }
}

/**
 * Record an advisory as in flight. Called by the send funnel only after every
 * suppression path has passed, so a suppressed message never registers.
 */
export function registerUnresolvedAdvisory(entry: UnresolvedAdvisory): void {
  pruneUnresolvedAdvisories();
  _unresolvedAdvisories.set(entry.id, entry);
}

/**
 * Retire an in-flight advisory by id. Called from the `message_start` /
 * `message_end` handlers with the id the delivered message carries in its
 * details; unknown ids (regular messages, other producers) are a no-op.
 */
export function resolveUnresolvedAdvisory(id: string): void {
  _unresolvedAdvisories.delete(id);
}

/**
 * True while an advisory of this kind is in flight (and its TTL has not
 * expired). Emitters use this to refuse stacking a second notice behind one
 * that has not landed yet.
 */
export function hasUnresolvedAdvisory(advisory: string): boolean {
  pruneUnresolvedAdvisories();
  for (const entry of _unresolvedAdvisories.values()) {
    if (entry.advisory === advisory) return true;
  }
  return false;
}

/**
 * Drop every in-flight advisory. Session boundary + test reset: the next
 * session must not inherit the previous one's unresolved flags.
 */
export function clearUnresolvedAdvisories(): void {
  _unresolvedAdvisories.clear();
}

/**
 * Test hook: pin the clock used by advisory TTL pruning so fixtures can
 * prove the window opens without waiting real minutes. Pass null to restore
 * Date.now().
 */
export function _setAdvisoryClockForTests(nowMs: number | null): void {
  _advisoryNowOverride = nowMs;
}

/** Hard cap on distinct tracked bodies per session (oldest evicted). */
const REPRIME_MAX_ENTRIES = 300;

// Test-only clock override so fixtures can prove the cooldown window closes
// without waiting REAL minutes. null restores Date.now().
let _nowOverride: number | null = null;

function reprimeNow(): number {
  return _nowOverride ?? Date.now();
}

function getReprimeBucket(): ReprimeBucket {
  const key = _activeSessionId ?? "default";
  let bucket = _reprime.get(key);
  if (!bucket) {
    bucket = { lastEmitted: new Map() };
    _reprime.set(key, bucket);
  }
  return bucket;
}

// Prevents unbounded recursion when pi.sendMessage(steer) triggers synchronous
// event chains (e.g., before_agent_start -> sendCompactNudge -> sendTrackedMessage
// -> pi.sendMessage -> before_agent_start ...).
// Incremented before pi.sendMessage, decremented after. If depth >= MAX_REENTRY_DEPTH,
// the message is dispatched via setTimeout(0) to break the synchronous chain.
//
// IMPORTANT: setTimeout(0) is used instead of queueMicrotask because microtasks
// run in the same event loop turn — the call stack does NOT unwind between
// microtasks. If each deferred microtask triggers another synchronous chain
// (before_agent_start → 25+ hooks → sendTrackedMessage → pi.sendMessage →
// _runAgentPrompt → ...), the stack still overflows. setTimeout(0) creates a
// real macrotask boundary: the stack fully unwinds before the deferred send.
let _sendDepth = 0;
// MAX_REENTRY_DEPTH = 1: The first sendTrackedMessage call goes through
// synchronously (depth 0 → 1). Any re-entrant send (depth >= 1) is deferred
// via setTimeout(0), breaking the synchronous chain at the macrotask boundary.
//
// Failure mode bounded here: the post-compaction stack overflow. After
// compaction the agent wakes up and calls tools (e.g., scratchpad); the
// tool_call/
// tool_execution_end events fire synchronously, and a handler that sends
// a triggerTurn:true whisper creates a recursive _runAgentPrompt call.
// With MAX_REENTRY_DEPTH=1, the first whisper goes through, but any
// re-entrant whisper triggered by the synchronous before_agent_start hooks
// is deferred to a new macrotask — the stack unwinds first.
const MAX_REENTRY_DEPTH = 1;

/**
 * Set the active session ID. Call on session_start to scope injections.
 */
export function setActiveSessionId(id: string | undefined): void {
  _activeSessionId = id;
}

function getBucket(): InjectionBucket {
  const key = _activeSessionId ?? "default";
  if (!_buckets.has(key)) {
    _buckets.set(key, { injections: [], maxInjections: MAX_INJECTIONS });
  }
  return _buckets.get(key)!;
}

/**
 * Stable body key for reprime suppression.
 *
 * Mirrors the MARS advice-normalization lesson: collapse
 * whitespace AND standalone digit runs so a persisting pattern whose counters
 * keep ticking ("bash used 25/30 tool-turns, 83%" → "bash used #/#
 * tool-turns, #%") still compares equal and stays suppressed. A different
 * tool name, source, or wording produces a different key and re-fires.
 *
 * Boundary-aware (not unconditional) digit collapse: only STANDALONE numeric
 * tokens are noise. Digits embedded in an identifier or unit are SIGNAL and
 * must stay distinct so two genuinely-different whispers don't collide —
 * advisory timer bodies "[timer] 30s elapsed" vs "[timer] 60s elapsed" both
 * normalize to "[timer] #s elapsed" under unconditional collapse and the 2nd
 * would be wrongly held for 20 min. (Fixes a correctness gap found later —
 * see the digit-collapse tests.)
 *
 * Exported because it is the single definition of "the same body" for the
 * enforcement layer: the reprime cooldown below and the adherence meter's
 * rule-signal identity (`lib/enforcement/adherence-meter.ts`) must agree on
 * it, or the meter's "repeats" would drift from the suppression events it
 * counts.
 */
export function reprimeBodyKey(body: string): string {
  return (
    body
      .trim()
      .replace(/\s+/g, " ")
      // Collapse STANDALONE numeric tokens (counts, ratios, percentages):
      // a digit run not adjacent to a word char is a drifting counter, so
      // collapse it; one attached to a word/unit/identifier (30s, v1, ref-2)
      // is meaningful and preserved.
      .replace(/(?<![\w-])\d+(?:\.\d+)?(?!\w)/g, "#")
  );
}

/**
 * True when the same normalized body was last emitted within the reprime
 * cooldown window in this session. First occurrence (no entry) always passes.
 */
function withinReprimeCooldown(key: string): boolean {
  const last = getReprimeBucket().lastEmitted.get(key);
  return last !== undefined && reprimeNow() - last < REPRIME_COOLDOWN_MS;
}

/** Record a delivery so a re-fire inside the cooldown window is suppressed. */
function markReprimeEmitted(key: string): void {
  const bucket = getReprimeBucket();
  // Opportunistic prune — only entries inside the cooldown window
  // can suppress anything, so expired entries are dead weight. Iterate and
  // drop expired ones while inserting the new key.
  const now = reprimeNow();
  for (const [key, ts] of bucket.lastEmitted) {
    if (now - ts >= REPRIME_COOLDOWN_MS) bucket.lastEmitted.delete(key);
  }
  bucket.lastEmitted.set(key, now);
  // Hard cap for pathological body diversity: evict oldest (insertion order).
  while (bucket.lastEmitted.size > REPRIME_MAX_ENTRIES) {
    const oldest = bucket.lastEmitted.keys().next();
    if (oldest.done) break;
    bucket.lastEmitted.delete(oldest.value);
  }
}

/**
 * Track a message injection. Call this from any extension that sends
 * pi.sendMessage or pi.sendUserMessage.
 */
export function trackInjection(params: {
  type: Injection["type"];
  source: string;
  content: string;
  display?: boolean;
  steer?: boolean;
  turn?: number;
  sessionId?: string;
  /**
   * Keep the body verbatim instead of the display cap. For records where the
   * entry IS the durable copy of the text (owner input that a compaction
   * boundary may otherwise lose), a truncated record would be a partial loss.
   */
  fullContent?: boolean;
}): void {
  const { type, source, content, display = true, steer = false, turn = 0 } = params;
  const injection = createInjection(
    type,
    source,
    content,
    display,
    steer,
    turn,
    params.fullContent === true ? undefined : MAX_INJECTION_CONTENT,
  );

  // If explicit sessionId provided, switch bucket temporarily
  if (params.sessionId && params.sessionId !== _activeSessionId) {
    const prev = _activeSessionId;
    _activeSessionId = params.sessionId;
    try {
      const altBucket = getBucket();
      altBucket.injections.push(injection);
      trimBucket(altBucket);
    } finally {
      _activeSessionId = prev;
    }
  } else {
    const bucket = getBucket();
    bucket.injections.push(injection);
    trimBucket(bucket);
  }

  appendInjectionEntry(injection);
}

/**
 * Append the durable record for one tracked injection. Best-effort: the
 * in-memory bucket already holds it, and a missing/failing seam must never
 * break the send path it observes.
 */
function appendInjectionEntry(injection: Injection): void {
  try {
    _entryAppender?.appendEntry(INJECTION_ENTRY_TYPE, injection);
  } catch (e) {
    log.debug(`[injection-tracker] durable injection entry append failed: ${e}`);
  }
}

/**
 * Rebuild the injection list from the session branch entries.
 *
 * Branch-sensitive: only entries on the ACTIVE branch count, so a checkout or
 * a resume sees exactly the injections that branch contains. Abandoned
 * branches (entries off the current leaf path) are alternative histories and
 * are never replayed. Malformed payloads are skipped rather than trusted; the
 * per-bucket cap is applied after the scan, dropping the oldest.
 */
export function readInjectionsFromBranch(entries: readonly unknown[]): Injection[] {
  const injections: Injection[] = [];
  for (const raw of entries) {
    const entry = raw as { type?: string; customType?: string; data?: unknown } | null;
    if (entry?.type !== "custom" || entry.customType !== INJECTION_ENTRY_TYPE) continue;
    const data = entry.data as Partial<Injection> | null | undefined;
    if (!data || typeof data !== "object") continue;
    if (typeof data.source !== "string" || typeof data.content !== "string") continue;
    injections.push({
      id: typeof data.id === "string" ? data.id : nextId("inj"),
      type: (typeof data.type === "string" ? data.type : "other") as Injection["type"],
      source: data.source,
      content: data.content,
      timestamp: typeof data.timestamp === "number" ? data.timestamp : 0,
      display: data.display !== false,
      steer: data.steer === true,
      turn: typeof data.turn === "number" ? data.turn : 0,
    });
  }
  return injections.length > MAX_INJECTIONS ? injections.slice(-MAX_INJECTIONS) : injections;
}

/**
 * Read the active session key from a ctx (session file preferred, id as
 * fallback). Returns undefined when the manager is absent or stale.
 */
function readSessionKey(ctx: unknown): string | undefined {
  try {
    const sm = (
      ctx as
        | {
            sessionManager?: { getSessionFile?: () => string | null; getSessionId?: () => string };
          }
        | null
        | undefined
    )?.sessionManager;
    if (sm) return sm.getSessionFile?.() ?? sm.getSessionId?.();
  } catch {
    // sessionManager getter may throw on stale ctx
  }
  return undefined;
}

/**
 * Replace the active session's bucket with the branch reconstruction.
 * Replacement, not merge: the branch is the source of truth, and an in-memory
 * entry that is not on the branch is an abandoned history. A stale ctx keeps
 * the in-memory bucket instead of emptying it.
 */
export function reconstructInjectionBucket(ctx: unknown): void {
  let branch: readonly unknown[];
  try {
    const sm = (ctx as { sessionManager?: { getBranch?: () => unknown[] } } | null | undefined)
      ?.sessionManager;
    branch = typeof sm?.getBranch === "function" ? (sm.getBranch() ?? []) : [];
  } catch {
    return;
  }
  if (!Array.isArray(branch)) return;
  const key = _activeSessionId ?? "default";
  _buckets.set(key, {
    injections: readInjectionsFromBranch(branch),
    maxInjections: MAX_INJECTIONS,
  });
}

function createInjection(
  type: Injection["type"],
  source: string,
  content: string,
  display: boolean,
  steer: boolean,
  turn: number,
  contentLimit: number | undefined,
): Injection {
  return {
    id: nextId("inj"),
    type,
    source,
    content: contentLimit === undefined ? content : content.slice(0, contentLimit),
    timestamp: Date.now(),
    display,
    steer,
    turn,
  };
}

function trimBucket(bucket: InjectionBucket): void {
  if (bucket.injections.length > bucket.maxInjections) {
    bucket.injections = bucket.injections.slice(-bucket.maxInjections);
  }
}

/**
 * Get all injections tracked for the active session.
 */
export function getInjections(sessionId?: string): Injection[] {
  if (sessionId) {
    const bucket = _buckets.get(sessionId);
    return bucket ? [...bucket.injections] : [];
  }
  return [...getBucket().injections];
}

/**
 * Extract plain text from message content array for tracking.
 */
export function extractText(content: unknown[]): string {
  if (!Array.isArray(content)) return String(content ?? "").slice(0, 200);
  return content
    .filter((c): c is { type: string; text?: string } => typeof c === "object" && c !== null)
    .map((c) => c.text ?? "")
    .join(" ")
    .slice(0, 200);
}

/**
 * Wrapper around pi.sendMessage that also tracks the injection.
 * Use this instead of pi.sendMessage for all extension-injected messages.
 */
/**
 * Map a source to a priority tier for the per-turn whisper cap.
 * Default: "low" (most whispers are advisory).
 *
 * Critical: auto-recovery, agent loops,
 *           timer/fire (user-scheduled and compaction-resume wake-ups).
 *           Bypasses WHISPER_CAPS.high - only subject to PER_SOURCE_CAP.
 *           A user-set timer is time-critical by definition: if 3 other
 *           high-priority whispers have already fired in the turn, the
 *           timer whisper must still reach the agent, otherwise the user
 *           perceives "timer didn't fire." See test-timer-fire-suppression.
 * High:     enforcement-critical, compaction-retry exhausted, threshold-exhausted
 * Medium:   context-80%+, analytics, navigation
 * Low:      hints, suggestions, drift, dreamer, etc.
 */
function priorityFromSource(source: string, options?: { triggerTurn?: boolean }): WhisperPriority {
  if (/auto-recovery|turn-outcome\/loop|timer\/fire/.test(source)) {
    return "critical";
  }
  if (
    /enforcement\/whisper|exhausted|compaction-retry|context-manager\/rotation/.test(source) ||
    options?.triggerTurn === true
  ) {
    return "high";
  }
  if (/analytics|navigation|context-full|register-session-start/.test(source)) {
    return "medium";
  }
  return "low";
}

/**
 * Translate the funnel's delivery class into pi-core's `sendCustomMessage`
 * option shape (see the DELIVERY CONTRACT above `sendTrackedMessage`).
 *
 * - `deliverAs: "nextTurn"` is returned unchanged (branch 1).
 * - `triggerTurn: true` is returned unchanged (branch 2 while streaming,
 *   branch 3 when idle).
 * - `delivery: "live"` resolves to `{ deliverAs }` with triggerTurn OMITTED:
 *   branch 2 requires `triggerTurn !== false` while streaming, and omission
 *   never starts a run when idle.
 * - `delivery: "park"` resolves to `{ deliverAs, triggerTurn: false }`:
 *   branch 4 while streaming, branch 5 when idle.
 * - no class: returned unchanged.
 */
function resolveDeliveryOptions(options?: {
  triggerTurn?: boolean;
  deliverAs?: string;
  delivery?: "live" | "park";
}): { triggerTurn?: boolean; deliverAs?: string } | undefined {
  if (!options) return options;
  if (options.deliverAs === "nextTurn") return options;
  if (options.triggerTurn === true) return options;
  if (options.delivery === "live") return { deliverAs: options.deliverAs ?? "steer" };
  if (options.delivery === "park") {
    return { deliverAs: options.deliverAs ?? "steer", triggerTurn: false };
  }
  return options;
}

/**
 * Deliver one agent-bound message and report whether it was ACCEPTED for
 * delivery, so a counter that claims a message was sent can be held to
 * what actually left this function.
 *
 * DELIVERY CONTRACT (pi-core 1.0.2 `AgentSession.sendCustomMessage`, branch
 * order at dist/core/agent-session.js:1756-1782):
 *   1. deliverAs === "nextTurn"              -> queued for the next user prompt
 *   2. isStreaming && triggerTurn !== false  -> agent.steer() (agent.followUp()
 *                                               for deliverAs "followUp") - the
 *                                               only branch that reaches a live run
 *   3. triggerTurn (truthy)                  -> starts a run (_runAgentPrompt)
 *   4. isStreaming                           -> parked to the end-of-turn flush
 *                                               (_pendingCustomMessages)
 *   5. otherwise                             -> appended to the session now
 * `delivery` names the intent for the streaming case; this funnel is the one
 * place that translates it into pi-core's option shape:
 *   - "live": steer into the running loop (branch 2). The resolved shape OMITS
 *     triggerTurn - pi 0.84.2 made `triggerTurn: false` park (branch 4,
 *     PR #8022), so `{ deliverAs: "steer", triggerTurn: false }` no longer
 *     steers. When idle a live send is appended (branch 5): it never starts a
 *     run by itself.
 *   - "park": record for the end-of-turn flush while a run is active (branch 4),
 *     resolved as `{ deliverAs, triggerTurn: false }`. When idle: appended.
 *   - triggerTurn: true keeps its wake meaning whatever `delivery` says
 *     (branch 3 when idle, branch 2 while streaming).
 *   - deliverAs: "nextTurn" is passed through unchanged (branch 1).
 * A send with no class passes through unchanged (the pre-class call shape).
 *
 * RETURN CONTRACT: `true` when the message was handed to `pi.sendMessage`
 * (now, or scheduled on the deferred macrotask when `triggerTurn` defers),
 * `false` when a suppression path dropped it outright: cognitive nudges
 * disabled, the per-turn/per-source flood cap, or the cross-call reprime
 * cooldown. Callers that count what they sent MUST branch on this value;
 * callers that treat whispers as best-effort may ignore it.
 *
 * `true` is not a guarantee that the model reads it: for a `triggerTurn`
 * wake with a `wakeDefer` hook the send can still be withdrawn or parked by
 * the CALLER's own liveness answer inside the deferred macrotask (that
 * caller already owns redelivery, so it does not need this signal). Every
 * non-deferred message reaches pi-core's session stream: a live send steers
 * the running loop, a park send is appended immediately when idle and parked
 * for the end-of-turn flush when a run is active - a suppression upstream of
 * `pi.sendMessage` is the only way a whisper reaches no stream at all.
 */
export function sendTrackedMessage(
  pi: any,
  params: {
    customType?: string;
    content: { type: string; text?: string }[];
    display?: boolean;
    details?: unknown;
  },
  options?: { triggerTurn?: boolean; deliverAs?: string; delivery?: "live" | "park" },
  injectionMeta: {
    type: Injection["type"];
    source: string;
    steer?: boolean;
    /**
     * Mark this send as an advisory of the given kind. The funnel then
     * registers it in the unresolved-advisory registry, tags the delivered
     * message's details with its correlation id (`BRAID_ID`), and the append
     * events (`message_start`/`message_end`) retire it. Only accepted sends
     * register: every suppression path above returns before the
     * registration. Advisory kinds are owned by their emitters; this module
     * never learns what any kind means.
     */
    advisory?: string;
  } = { type: "other", source: "unknown" },
  /**
   * `bypassFloodCap: true` skips the per-source / per-priority flood
   * protection in `turn-dedup.tryWhisper`. Use this ONLY for
   * user/agent-contracted events where dropping the message is a
   * correctness bug: timer fires (user scheduled, post-compaction
   * resume), session-shutdown warnings, hard errors. The cap still
   * applies to other system whispers (enforcement, dreamer, heartbeats).
   */
  bypass: { bypassFloodCap?: boolean } = {},
  /**
   * Busy-deferral for triggerTurn wakes. When set and the deferred
   * macrotask finds the session busy at send time (isAgentBusy():
   * ctx.signal undefined while ctx.isIdle() is false — a compaction or
   * pre-flight window where pi-core's sendCustomMessage would route the raw
   * triggerTurn into _runAgentPrompt and start a competing agent run),
   * onBusy() runs INSTEAD of the send and the caller owns redelivery (the
   * timer's wake-retry queue). Wakes without this hook send unchanged — the
   * run-region gate below stays their catch-all rewrite.
   *
   * isWithdrawn() is the caller's own liveness answer for that same moment:
   * this send is no longer wanted (the timer's cancel retired the wake), so
   * it must neither go out nor be re-parked. Asked BEFORE the busy check —
   * withdrawal is terminal and monotone, busyness is a transient hold, and
   * re-parking a withdrawn send would resurrect the delivery state its
   * retirer already dropped. Omitted, the busy check is the only gate,
   * exactly as before.
   */
  wakeDefer?: { onBusy: () => void; isWithdrawn?: () => boolean },
): boolean {
  // ROADMAP P1-4 / EW-7.3: braid.suppressNudges is the universal
  // off-switch. Apply it here so every sendTrackedMessage call site
  // (20+ callers across enforcement, dreamer, memory, timer, drift,
  // hints, etc.) automatically respects the setting without each
  // site needing its own check. This was previously checked in only
  // 4 sites (sendEnforcementWhisper + 3 analytics/index.ts sites),
  // so setting braid.suppressNudges=true still delivered ~70% of
  // agent-facing whispers. Now the check is centralized at the
  // single entry point.
  if (areCognitiveNudgesDisabled()) {
    log.debug(
      `[injection-tracker] Tracked message suppressed via braid.suppressNudges=true ` +
        `(source: ${injectionMeta.source})`,
    );
    return false;
  }

  // ROADMAP EW-7.12+: apply the universal whisper envelope so the agent
  // can distinguish system-injected messages from human user input. Done
  // before the flood cap so the tracked (and potentially suppressed)
  // content reflects what would have been delivered. See
  // `lib/utils/whisper-format.ts` for the rationale and migration story.
  applyWhisperEnvelope(params.content, injectionMeta.source);

  // Per-turn whisper cap (flood protection). Critical paths always pass;
  // other priorities are capped per WHISPER_CAPS in turn-dedup.ts.
  // We track the suppressed whisper in the injection log so users can see
  // it was filtered (not silently lost).
  // bypassFloodCap:true skips the cap entirely - reserved for
  // user/agent-contracted events (see JSDoc).
  if (!bypass.bypassFloodCap) {
    const priority = priorityFromSource(injectionMeta.source, options);
    if (!tryWhisper(priority, injectionMeta.source)) {
      trackInjection({
        type: injectionMeta.type,
        source: injectionMeta.source,
        content: extractText(params.content),
        display: false,
        steer: false,
        turn: 0,
      });
      log.debug(`[flood-cap] ${priority} whisper from ${injectionMeta.source} suppressed`);
      return false;
    }
  }

  const text = extractText(params.content);

  // Cross-call exact-repeat de-bloat. The per-turn flood cap above only caps
  // whispers WITHIN a turn, so a body that re-fires after its per-turn window
  // closed was re-injected turn after turn — 41% of whisper deliveries (3,129
  // of 7,690) measured as exact-repeat bodies in the same session. Same
  // digit-normalized body inside REPRIME_COOLDOWN_MS is suppressed (tracked
  // display:false so it is visible as filtered, matching the flood-cap path).
  // triggerTurn:true wakes always pass — a dropped wake is a correctness bug.
  // First occurrence and genuinely different bodies always pass. See
  // docs/ tool-whisper-benchmark.md .1 and the MARS dedup lesson
  // for the digit-collapse key.
  const reprimeKey = reprimeBodyKey(text);
  const suppressReprime = options?.triggerTurn !== true && withinReprimeCooldown(reprimeKey);
  if (suppressReprime) {
    trackInjection({
      type: injectionMeta.type,
      source: injectionMeta.source,
      content: text,
      display: false,
      steer: false,
      turn: 0,
    });
    log.debug(
      `[reprime] exact-repeat body suppressed (source ${injectionMeta.source}, within ${REPRIME_COOLDOWN_MS}ms window)`,
    );
    return false;
  }
  markReprimeEmitted(reprimeKey);

  trackInjection({
    type: injectionMeta.type,
    source: injectionMeta.source,
    content: text,
    display: params.display ?? true,
    steer: injectionMeta.steer ?? false,
    turn: 0,
  });

  // Tag message metadata so compaction can identify injected messages
  // and exclude them from LLM summarization (prevents nudge conflate).
  // An advisory also carries its registry correlation id here: the append
  // events repeat the same `details` object, which is how the registry
  // entry retires (see the registry block above).
  const advisory = injectionMeta.advisory;
  const advisoryId = advisory === undefined ? undefined : nextId("adv");
  if (injectionMeta.type !== "other" || advisoryId !== undefined) {
    const existingDetails =
      typeof params.details === "object" && params.details !== null
        ? (params.details as Record<string, unknown>)
        : {};
    if (injectionMeta.type !== "other") {
      existingDetails[BRAID_INJECTED] = true;
      existingDetails[BRAID_SOURCE] = injectionMeta.source;
    }
    if (advisoryId !== undefined) existingDetails[BRAID_ID] = advisoryId;
    params.details = existingDetails;
  }
  if (advisoryId !== undefined && advisory !== undefined) {
    registerUnresolvedAdvisory({ id: advisoryId, advisory, emittedAt: advisoryNow() });
  }

  // Translate the declared delivery class into pi-core's option shape once.
  // The run-region gate below only ever rewrites triggerTurn wakes, at send
  // time; the class translation itself is static.
  const resolvedOptions = resolveDeliveryOptions(options);

  // This is the nuclear fix for the recurring post-compaction stack overflow.
  // When triggerTurn:true is set, pi.sendMessage calls sendCustomMessage →
  // _runAgentPrompt → agent loop synchronously (the async function preamble
  // before the first await sets up the chain). If the agent loop fires events
  // whose handlers call sendTrackedMessage with triggerTurn:true, the chain
  // becomes recursive and overflows the V8 stack — even with the
  // MAX_REENTRY_DEPTH guard below, because the guard only catches the SECOND
  // re-entrant call, not the first synchronous chain from the agent loop.
  //
  // setTimeout(0) creates a real macrotask boundary: the call stack fully
  // unwinds before _runAgentPrompt starts. This prevents ALL synchronous
  // re-entry, regardless of the call depth or event chain complexity.
  //
  // For non-triggerTurn messages (steer, followUp, silent push), the
  // synchronous path is preserved — they don't enter the agent loop and
  // can't cause stack overflow.
  const shouldDefer = options?.triggerTurn === true;
  if (shouldDefer || _sendDepth >= MAX_REENTRY_DEPTH) {
    if (!shouldDefer) {
      log.warn(
        `sendTrackedMessage re-entry depth ${_sendDepth}/${MAX_REENTRY_DEPTH} - deferring to setTimeout(0)`,
      );
    }
    // Mark depth as busy before deferring so the agent loop that starts from
    // the deferred pi.sendMessage inherits the depth guard. Without this,
    // non-triggerTurn sendTrackedMessage calls from tool_result handlers
    // during that agent turn would re-enter synchronously.
    _sendDepth++;
    setTimeout(() => {
      try {
        // Withdrawal check at SEND time, before the busy check: the caller
        // may have retired this wake in the window between the deferral and
        // this macrotask (timer cancel -> retireTimer). A withdrawn send
        // must not go out, and must not be re-parked either — onBusy()
        // exists to hold a LIVE wake for later, and handing it a withdrawn
        // one re-arms delivery state (a retry ladder, a parked fire) for an
        // id the canceller already dropped, which only a downstream guard
        // would then have to suppress a second time.
        if (options?.triggerTurn === true && wakeDefer?.isWithdrawn?.() === true) {
          log.debug(
            `[injection-tracker] deferred send withdrawn by its caller (source: ${injectionMeta.source})`,
          );
          return;
        }
        // State-based busy check at SEND time: the deferred macrotask may
        // land in a window the region flag does not cover — a compaction
        // that outlived the gate's fail-safe (region auto-cleared), or any
        // busy slice between events. A positively-determined busy state
        // with a re-queue hook holds the wake instead of sending it into a
        // session whose next raw triggerTurn send would start a competing
        // agent run and hit pi-core's activeRun guard. The run-region gate
        // below remains the catch-all rewrite for wakes without a hook.
        if (options?.triggerTurn === true && wakeDefer && isAgentBusy()) {
          wakeDefer.onBusy();
          return;
        }
        // Gate triggerTurn on the run-region state at send time: the
        // deferred macrotask may land in a session prompt() pre-flight,
        // where pi-core's isStreaming flag is false but a run is imminent.
        // When gated, the wake becomes a live steer (steer into the streaming
        // run / append to the session in the pre-flight) instead of a raw
        // agent.prompt re-entry that would hit pi-core's activeRun guard.
        pi.sendMessage(params, gateTriggerTurnOptions(resolvedOptions));
      } finally {
        _sendDepth--;
      }
    }, 0);
    return true;
  }

  _sendDepth++;
  try {
    // Defense in depth: apply the gate on the synchronous path too (it only
    // rewrites when a run region is active; otherwise it is a no-op).
    pi.sendMessage(params, gateTriggerTurnOptions(resolvedOptions));
  } finally {
    _sendDepth--;
  }
  return true;
}

/**
 * Clear injection history (e.g., on session_start fresh).
 */
export function clearInjections(sessionId?: string): void {
  if (sessionId) {
    _buckets.delete(sessionId);
  } else {
    const key = _activeSessionId ?? "default";
    _buckets.delete(key);
  }
}

/**
 * Clear ALL injection buckets, per-session reprime state, and in-flight
 * advisory registrations. Nuclear option for testing.
 */
export function clearAllBuckets(): void {
  _buckets.clear();
  _reprime.clear();
  clearUnresolvedAdvisories();
}

/**
 * Test hook: pin the clock used by reprime cooldown checks so fixtures can
 * prove the cooldown window closes without waiting real minutes.
 * Pass null to restore Date.now().
 */
export function _setReprimeClockForTests(nowMs: number | null): void {
  _nowOverride = nowMs;
}

/**
 * Register session lifecycle handlers for injection tracking.
 * Call from an extension that has access to pi events.
 * Automatically scopes injections to the current session.
 *
 * Durable path: the extension API's `appendEntry` is captured as the write
 * seam for branch entries, and `session_start` / `session_tree` rebuild the
 * active bucket from `getBranch()`. The rebuild is registered in the
 * Background phase on purpose: context-lifecycle clears the tracker in its
 * MemoryState session_start handler, so a rebuild registered there would be
 * wiped before it was ever read. Background runs last by construction.
 */
export function registerInjectionTracker(pi: {
  on: (event: string, handler: (...args: any[]) => any) => void;
  appendEntry?: <T = unknown>(customType: string, data?: T) => void;
}): void {
  // Capture the durable write path. The arrow defers dispatch to call time so
  // the runtime's own appendEntry (initialized only after the session starts)
  // is resolved on each write; an API without the seam degrades to in-memory.
  _entryAppender =
    typeof pi.appendEntry === "function"
      ? { appendEntry: (customType, data) => pi.appendEntry!(customType, data) }
      : undefined;

  // The local type widens ExtensionAPI's overloaded on() so we can
  // pass any event name + handler without TypeScript asking which
  // overload applies. The caller must provide a real ExtensionAPI.
  const onAny = pi.on as (event: string, handler: (...args: any[]) => any) => void;

  onAny("session_start", (_event: unknown, ctx: unknown) => {
    setActiveSessionId(readSessionKey(ctx));
  });

  // pi-native tree navigation (`/tree`, ctx.navigateTree) emits session_tree;
  // realign the bucket with the new branch immediately instead of waiting for
  // the next session_start. (A branch change committed directly through
  // sessionManager.branchWithSummary emits nothing; that path realigns at the
  // next session_start, which the durable entries make correct.)
  onAny("session_tree", (_event: unknown, ctx: unknown) => {
    const sessionId = readSessionKey(ctx);
    if (sessionId) setActiveSessionId(sessionId);
    reconstructInjectionBucket(ctx);
  });

  // Advisory retirement: pi emits `message_start` + `message_end` when a
  // custom message is appended (both for the immediate append and for a
  // parked flush; a steered message emits them when the running loop consumes
  // it). The event's message carries the `details` object this module tagged
  // with `BRAID_ID`, so the id in the event is the whole correlation. Both
  // events are handled: one fires on append, and pairing them means a future
  // pi change to either emission point still retires the entry.
  const retireAdvisoryFromEvent = (event: unknown) => {
    const message = (event as { message?: { details?: unknown } } | null | undefined)?.message;
    const details = message?.details as Record<string, unknown> | undefined;
    const id = details?.[BRAID_ID];
    if (typeof id === "string") resolveUnresolvedAdvisory(id);
  };
  onAny(MESSAGE_START, retireAdvisoryFromEvent);
  onAny(MESSAGE_END, retireAdvisoryFromEvent);

  // Branch reconstruction at the session boundary. Background phase: after
  // every MemoryState handler (including context-lifecycle's clearInjections)
  // has run. Synchronous body on purpose: the rebuild must be in place before
  // the first agent turn tracks an injection.
  registerSessionStartHandler(
    pi,
    SessionPhase.Background,
    async (_event: unknown, ctx: unknown) => {
      const sessionId = readSessionKey(ctx);
      if (sessionId) setActiveSessionId(sessionId);
      reconstructInjectionBucket(ctx);
    },
    "injection-tracker-branch-rebuild",
  );

  pi.on(SESSION_SHUTDOWN, (_event, ctx) => {
    // Clear per-session reprime state so a body can fire fresh in the next
    // session (no cross-session cooldown bleed).
    const sessionId = readSessionKey(ctx);
    if (sessionId) _reprime.delete(sessionId);
    if (_activeSessionId) _reprime.delete(_activeSessionId);
    // Delete the ended session's injection bucket so per-session state does
    // not accumulate for the process lifetime. The durable entries stay in
    // the session file, so the next session_start reconstructs them.
    if (sessionId) _buckets.delete(sessionId);
    if (_activeSessionId) _buckets.delete(_activeSessionId);
    // In-flight advisories belong to the session that emitted them; the next
    // session must not inherit an unresolved flag (its own notices would be
    // silently suppressed until the TTL).
    clearUnresolvedAdvisories();
    setActiveSessionId(undefined);
  });
}
