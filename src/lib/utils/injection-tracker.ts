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
 * Usage:
 *   import { trackInjection, getInjections, clearInjections } from "./injection-tracker.js";
 *   trackInjection({ type: "enforcement", source: "enforcement/whisper", content: "..." });
 */

import { createLogger } from "../core/logger.js";
import { SESSION_SHUTDOWN } from "../core/event-names.js";
import { tryWhisper, type WhisperPriority } from "../enforcement/turn-dedup.js";
import { BRAID_INJECTED, BRAID_SOURCE } from "../constants/injection-details.js";

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

// ── Module-level state (PROCESS-GLOBAL — see extension-state.ts header) ────────
// _buckets: keyed by sessionId, so it IS effectively session-scoped despite
//   living at module level. Cleared via `registerSessionCleanup` on SESSION_END.
// _activeSessionId: pointer to the most recent sessionId; fallback for callers
//   that lose ctx (e.g. after compaction).
// _sendDepth: process-global re-entry counter for sendTrackedMessage.
const _buckets = new Map<string, InjectionBucket>();

let _activeSessionId: string | undefined;

// ── Re-entry depth tracking for sendTrackedMessage ───────────────────────────
// Prevents unbounded recursion when pi.sendMessage(steer) triggers synchronous
// event chains (e.g., before_agent_start → sendCompactNudge → sendTrackedMessage
// → pi.sendMessage → before_agent_start ...).
// Incremented before pi.sendMessage, decremented after. If depth > MAX_REENTRY_DEPTH,
// the message is dispatched via queueMicrotask to break the synchronous chain.
let _sendDepth = 0;
// MAX_REENTRY_DEPTH = 1: only allow 1 synchronous pi.sendMessage call before
// deferring to microtask. With ~25 extensions each registering before_agent_start
// hooks, the runtime re-entry depth can far exceed 2 if every nested call is
// allowed through. 1 is the safe floor - anything deeper is unsafe.
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
    _buckets.set(key, { injections: [], maxInjections: 200 });
  }
  return _buckets.get(key)!;
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
}): void {
  const { type, source, content, display = true, steer = false, turn = 0 } = params;
  const bucket = getBucket();

  // If explicit sessionId provided, switch bucket temporarily
  if (params.sessionId && params.sessionId !== _activeSessionId) {
    const prev = _activeSessionId;
    _activeSessionId = params.sessionId;
    try {
      const altBucket = getBucket();
      altBucket.injections.push(createInjection(type, source, content, display, steer, turn));
      trimBucket(altBucket);
      return;
    } finally {
      _activeSessionId = prev;
    }
  }

  bucket.injections.push(createInjection(type, source, content, display, steer, turn));
  trimBucket(bucket);
}

function createInjection(
  type: Injection["type"],
  source: string,
  content: string,
  display: boolean,
  steer: boolean,
  turn: number,
): Injection {
  return {
    id: `inj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    source,
    content: content.slice(0, 500),
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

export function sendTrackedMessage(
  pi: any,
  params: {
    customType?: string;
    content: { type: string; text?: string }[];
    display?: boolean;
    details?: unknown;
  },
  options?: { triggerTurn?: boolean; deliverAs?: string },
  injectionMeta: {
    type: Injection["type"];
    source: string;
    steer?: boolean;
  } = { type: "other", source: "unknown" },
): void {
  // Per-turn whisper cap (flood protection). Critical paths always pass;
  // other priorities are capped per WHISPER_CAPS in turn-dedup.ts.
  // We track the suppressed whisper in the injection log so users can see
  // it was filtered (not silently lost).
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
    log.debug(
      `[flood-cap] ${priority} whisper from ${injectionMeta.source} suppressed`,
    );
    return;
  }

  const text = extractText(params.content);
  trackInjection({
    type: injectionMeta.type,
    source: injectionMeta.source,
    content: text,
    display: params.display ?? true,
    steer: injectionMeta.steer ?? false,
    turn: 0,
  });

  // Tag message metadata so compaction can identify injected messages
  // and exclude them from LLM summarization (prevents nudge conflate)
  if (injectionMeta.type !== "other") {
    const existingDetails =
      typeof params.details === "object" && params.details !== null
        ? (params.details as Record<string, unknown>)
        : {};
    existingDetails[BRAID_INJECTED] = true;
    existingDetails[BRAID_SOURCE] = injectionMeta.source;
    params.details = existingDetails;
  }

  if (_sendDepth >= MAX_REENTRY_DEPTH) {
    // Break synchronous re-entry by deferring to microtask.
    // This prevents stack overflow when pi.sendMessage(steer) triggers
    // a synchronous before_agent_start that calls sendTrackedMessage again.
    // The runtime's own re-entry depth (across extension hooks) is not visible
    // to this counter, so we keep MAX_REENTRY_DEPTH conservative (1) to stop
    // the chain before it can grow during a tool execution.
    log.warn(
      `sendTrackedMessage re-entry depth ${_sendDepth}/${MAX_REENTRY_DEPTH} - deferring to microtask`,
    );
    queueMicrotask(() => {
      pi.sendMessage(params, options);
    });
    return;
  }

  _sendDepth++;
  try {
    pi.sendMessage(params, options);
  } finally {
    _sendDepth--;
  }
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
 * Clear ALL injection buckets. Nuclear option for testing.
 */
export function clearAllBuckets(): void {
  _buckets.clear();
}

/**
 * Register session lifecycle handlers for injection tracking.
 * Call from an extension that has access to pi events.
 * Automatically scopes injections to the current session.
 */
export function registerInjectionTracker(pi: {
  on: (event: string, handler: (...args: any[]) => any) => void;
}): void {
  pi.on(
    "session_start",
    (
      _event: unknown,
      ctx: { sessionManager?: { getSessionFile?: () => string; getSessionId?: () => string } },
    ) => {
      let sessionId: string | undefined;
      try {
        const sm = ctx?.sessionManager;
        if (sm) {
          sessionId = sm.getSessionFile?.() ?? sm.getSessionId?.();
        }
      } catch {
        // sessionManager getter may throw on stale ctx
      }
      setActiveSessionId(sessionId);
    },
  );

  pi.on(SESSION_SHUTDOWN, () => {
    setActiveSessionId(undefined);
  });
}
