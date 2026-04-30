/**
 * Injection Tracker — tracks all messages sent via pi.sendMessage/sendUserMessage.
 *
 * Purpose: Make the model's context visible. When extensions inject messages
 * (enforcement whispers, memory nudges, retry prompts, etc.), users should be
 * able to see what the model sees.
 *
 * Usage:
 *   import { trackInjection, getInjections, clearInjections } from "./injection-tracker.js";
 *   trackInjection({ type: "enforcement", source: "enforcement/whisper", content: "..." });
 */

export interface Injection {
  id: string;
  type: "enforcement" | "memory" | "retry" | "heartbeat" | "context" | "other";
  source: string; // e.g., "enforcement/whisper", "context-manager/compaction"
  content: string; // first 200 chars
  timestamp: number;
  display: boolean; // true = visible to model
  steer: boolean; // true = delivered as steer
  turn: number; // approximate turn at injection
}

interface InjectionTrackerState {
  injections: Injection[];
  maxInjections: number;
}

const _state: InjectionTrackerState = {
  injections: [],
  maxInjections: 200,
};

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
}): void {
  const { type, source, content, display = true, steer = false, turn = 0 } = params;
  const injection: Injection = {
    id: `inj-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    type,
    source,
    content: content.slice(0, 500), // cap at 500 chars
    timestamp: Date.now(),
    display,
    steer,
    turn,
  };
  _state.injections.push(injection);
  if (_state.injections.length > _state.maxInjections) {
    _state.injections = _state.injections.slice(-_state.maxInjections);
  }
}

/**
 * Get all injections tracked this session.
 */
export function getInjections(): Injection[] {
  return [..._state.injections];
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
export function clearInjections(): void {
  _state.injections = [];
}
