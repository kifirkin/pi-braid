/**
 * Agent Event Bus — unified async event routing
 *
 * Replaces hardcoded module integration in heartbeat tick with
 * event-driven handlers. Every async mechanism (timer, memory,
 * heuristic, enforcement) emits through this bus.
 *
 * Heartbeat tick → emit('turn_complete') → handlers react
 * Timer fires → emit('timer_fire') → inject into context
 * etc.
 *
 * Paper: 2604.14178 — Cognitive Scheduling with Event-Driven Architecture
 */

import { createLogger } from "../core/logger.js";

const log = createLogger("event-bus");

// ── Event Types ──────────────────────────────────────────────────────────────

export interface TimerEvent {
  type: "timer_fire";
  id: string;
  reason: string;
  tag?: string;
  payload: string;
}

export interface MemoryEvictEvent {
  type: "memory_evict";
  entity?: string;
  reason: string;
  count: number;
}

export interface TurnCompleteEvent {
  type: "turn_complete";
  turn: number;
  duration: number;
}

export interface ContextFullEvent {
  type: "context_full";
  usagePercent: number;
  tokensUsed: number;
  tokensLimit: number;
}

export interface EnforcementEvent {
  type: "enforcement_violation";
  rule: string;
  description: string;
  severity: "low" | "medium" | "high";
}

export interface HeartbeatTickEvent {
  type: "heartbeat_tick";
  turn: number;
  tickCount: number;
  timestamp: number;
}

export interface ToolErrorEvent {
  type: "tool_error";
  toolName: string;
  error: string;
  turn: number;
  timestamp: number;
}

export interface AnalyticsAlertEvent {
  type: "analytics_alert";
  alertType: "addiction" | "degradation" | "recovery" | "anomaly";
  severity: "info" | "warn" | "critical";
  message: string;
  data?: Record<string, unknown>;
  turn: number;
  timestamp: number;
}

export interface SopSuggestionEvent {
  type: "sop_suggestion";
  episodeId: string;
  similarity: number;
  message: string;
  timestamp: number;
}

export type AgentEvent =
  | TimerEvent
  | MemoryEvictEvent
  | TurnCompleteEvent
  | ContextFullEvent
  | EnforcementEvent
  | HeartbeatTickEvent
  | ToolErrorEvent
  | AnalyticsAlertEvent
  | SopSuggestionEvent;

type Handler<T extends AgentEvent = AgentEvent> = (event: T) => void;

// ── Event Bus ────────────────────────────────────────────────────────────────

class EventBus {
  private handlers = new Map<string, Set<Handler>>();
  private onceHandlers = new Map<string, Set<Handler>>();

  /**
   * Register a handler for an event type.
   */
  on<T extends AgentEvent["type"]>(
    eventType: T,
    handler: Handler<Extract<AgentEvent, { type: T }>>,
  ): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler as Handler);
  }

  /**
   * Register a one-shot handler for an event type.
   */
  once<T extends AgentEvent["type"]>(
    eventType: T,
    handler: Handler<Extract<AgentEvent, { type: T }>>,
  ): void {
    if (!this.onceHandlers.has(eventType)) {
      this.onceHandlers.set(eventType, new Set());
    }
    this.onceHandlers.get(eventType)!.add(handler as Handler);
  }

  /**
   * Emit an event to all registered handlers.
   */
  emit(event: AgentEvent): void {
    const handlers = this.handlers.get(event.type);
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(event as AgentEvent);
        } catch (err) {
          log.error(`Handler error for ${event.type}:`, err);
        }
      }
    }

    // Fire once handlers, then remove them
    const onceHandlers = this.onceHandlers.get(event.type);
    if (onceHandlers) {
      for (const handler of onceHandlers) {
        try {
          handler(event as AgentEvent);
        } catch (err) {
          log.error(`Once-handler error for ${event.type}:`, err);
        }
      }
      this.onceHandlers.delete(event.type);
    }
  }

  /**
   * Remove a handler for an event type.
   */
  off<T extends AgentEvent["type"]>(
    eventType: T,
    handler: Handler<Extract<AgentEvent, { type: T }>>,
  ): void {
    this.handlers.get(eventType)?.delete(handler as Handler);
    this.onceHandlers.get(eventType)?.delete(handler as Handler);
  }

  /**
   * Remove all handlers for an event type.
   */
  clear(eventType?: AgentEvent["type"]): void {
    if (eventType) {
      this.handlers.delete(eventType);
      this.onceHandlers.delete(eventType);
    } else {
      this.handlers.clear();
      this.onceHandlers.clear();
    }
  }

  /**
   * Get handler counts for diagnostics.
   */
  getStats(): Record<string, { persistent: number; once: number }> {
    const stats: Record<string, { persistent: number; once: number }> = {};
    const allTypes = new Set([...this.handlers.keys(), ...this.onceHandlers.keys()]);
    for (const type of allTypes) {
      stats[type] = {
        persistent: this.handlers.get(type)?.size ?? 0,
        once: this.onceHandlers.get(type)?.size ?? 0,
      };
    }
    return stats;
  }
}

/**
 * Global singleton event bus instance.
 */
export const eventBus = new EventBus();
