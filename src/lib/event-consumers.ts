/**
 * Event Consumers — reactive handlers for all Event Bus events.
 *
 * Registered once on session_start. Each handler reacts to an event type.
 * This is where the Event Bus comes alive — without these, events do nothing.
 */

import { createLogger } from "./logger.js";
import { eventBus } from "./event-bus.js";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";

const log = createLogger("event-consumers");

// ── Handler: timer_fire → inject agent reminder ─────────────────────────────

export function onTimerFire(event: { id: string; reason: string; payload: string }): void {
  log.info(`[event] Timer fired: "${event.reason}" (${event.id})`);
  // The timer extension already injects the reminder via sendTrackedMessage.
  // This handler adds parallel logging and metrics tracking.
}

// ── Handler: enforcement_violation → track metrics ──────────────────────────

let _violationCount = 0;

export function onEnforcementViolation(event: {
  rule: string;
  description: string;
  severity: string;
}): void {
  _violationCount++;
  log.info(
    `[event] Enforcement violation #${_violationCount}: [${event.severity}] ` +
      `${event.rule}: ${event.description.slice(0, 60)}`,
  );
}

export function getViolationCount(): number {
  return _violationCount;
}

// ── Handler: memory_evict → trigger consolidation queue ──────────────────────

let _evictCount = 0;

export function onMemoryEvict(event: { reason: string; count: number }): void {
  _evictCount++;
  log.info(
    `[event] Memory evict #${_evictCount}: ${event.reason} (${event.count} messages)`,
  );
}

export function getEvictCount(): number {
  return _evictCount;
}

// ── Handler: context_full → trigger compaction ───────────────────────────────

let _contextFullWarnings = 0;
/** When context_full fires, this tracks the highest usage % seen for aggressive compression. */
let _peakUsagePercent = 0;

export function onContextFull(event: { usagePercent: number }): void {
  _contextFullWarnings++;
  if (event.usagePercent > _peakUsagePercent) {
    _peakUsagePercent = event.usagePercent;
  }
  log.warn(
    `[event] Context full warning #${_contextFullWarnings}: ` +
      `${event.usagePercent.toFixed(1)}% used` +
      ` (peak: ${_peakUsagePercent.toFixed(1)}%)`,
  );
}

export function getContextFullWarnings(): number {
  return _contextFullWarnings;
}

/**
 * Get the peak usage % seen. Used by compaction to determine
 * compression aggressiveness — higher peak → more aggressive.
 */
export function getPeakUsagePercent(): number {
  return _peakUsagePercent;
}

// ── Handler: turn_complete → track module health ────────────────────────────

let _turnCount = 0;

export function onTurnComplete(event: { turn: number; duration: number }): void {
  _turnCount = event.turn;
}

export function getLastTurn(): number {
  return _turnCount;
}

// ── Handler: heartbeat_tick → track tick stats ──────────────────────────────

let _tickCount = 0;

export function onHeartbeatTick(event: { turn: number; tickCount: number }): void {
  _tickCount = event.tickCount;
}

export function getTickCount(): number {
  return _tickCount;
}

// ── Handler: analytics_alert → structured alert channel ─────────────────────

let _alertCount = 0;
const _recentAlerts: Array<{ type: string; severity: string; message: string; timestamp: number }> = [];
const MAX_ALERTS = 50;

export function onAnalyticsAlert(event: {
  alertType: string;
  severity: string;
  message: string;
  data?: Record<string, unknown>;
  turn: number;
  timestamp: number;
}): void {
  _alertCount++;
  _recentAlerts.push({
    type: event.alertType,
    severity: event.severity,
    message: event.message.slice(0, 120),
    timestamp: event.timestamp,
  });
  if (_recentAlerts.length > MAX_ALERTS) _recentAlerts.shift();

  log.info(
    `[event] Analytics alert #${_alertCount}: [${event.severity}] ` +
    `${event.alertType}: ${event.message.slice(0, 80)}`,
  );
}

export function getAlertCount(): number {
  return _alertCount;
}

export function getRecentAlerts() {
  return [..._recentAlerts];
}

// ── Register all consumers (idempotent) ─────────────────────────────────────

let _registered = false;

export function registerEventConsumers(): void {
  if (_registered) return;
  _registered = true;

  eventBus.on("timer_fire", onTimerFire);
  eventBus.on("enforcement_violation", onEnforcementViolation);
  eventBus.on("memory_evict", onMemoryEvict);
  eventBus.on("context_full", onContextFull);
  eventBus.on("turn_complete", onTurnComplete);
  eventBus.on("heartbeat_tick", onHeartbeatTick);
  eventBus.on("analytics_alert", onAnalyticsAlert);

  log.info("[event] All consumers registered (7 handlers)");
}

// ── Reset (for testing) ─────────────────────────────────────────────────────

export function resetConsumerState(): void {
  _violationCount = 0;
  _evictCount = 0;
  _contextFullWarnings = 0;
  _turnCount = 0;
  _tickCount = 0;
  _alertCount = 0;
  _recentAlerts.length = 0;
  _registered = false; // Allow re-registration
}

// ── Diagnostics ─────────────────────────────────────────────────────────────

export function getConsumerStatus(): string {
  const lines: string[] = [];
  lines.push("=== Event Bus Consumers ===");
  lines.push(`Violations tracked: ${_violationCount}`);
  lines.push(`Memory evictions: ${_evictCount}`);
  lines.push(`Context full warnings: ${_contextFullWarnings}`);
  lines.push(`Turns tracked: ${_turnCount}`);
  lines.push(`Ticks tracked: ${_tickCount}`);
  lines.push(`Analytics alerts: ${_alertCount}`);
  return lines.join("\n");
}
