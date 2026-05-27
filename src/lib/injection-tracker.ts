/**
 * Injection Tracker — tracks all messages sent via pi.sendMessage/sendUserMessage.
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

const _buckets = new Map<string, InjectionBucket>();

let _activeSessionId: string | undefined;

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
    existingDetails._braidInjected = true;
    existingDetails._braidSource = injectionMeta.source;
    params.details = existingDetails;
  }

  pi.sendMessage(params, options);
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

  pi.on("session_shutdown", () => {
    setActiveSessionId(undefined);
  });
}
