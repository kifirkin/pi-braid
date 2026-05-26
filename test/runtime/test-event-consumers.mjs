/**
 * Test: Event Consumers — reactive handlers for Event Bus events
 *
 * Removed tests for getViolationCount, getEvictCount, getContextFullWarnings,
 * getLastTurn, getTickCount, getConsumerStatus — those getters were removed
 * as unused (nothing consumed their values).
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { registerEventConsumers, resetConsumerState } = await import(
  "../../dist/lib/event-consumers.js"
);

const { eventBus } = await import("../../dist/lib/event-bus.js");

describe("Event Consumers", () => {
  it("registers 7 handlers without error", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    const stats = eventBus.getStats();
    const totalHandlers = Object.values(stats).reduce((s, v) => s + v.persistent, 0);
    assert.equal(totalHandlers, 7, "Should have 7 persistent handlers");
  });

  it("handles enforcement_violation events without error", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    eventBus.emit({
      type: "enforcement_violation",
      rule: "test",
      description: "test violation",
      severity: "high",
    });
    eventBus.emit({
      type: "enforcement_violation",
      rule: "test2",
      description: "another",
      severity: "low",
    });
  });

  it("handles memory_evict events without error", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    eventBus.emit({ type: "memory_evict", reason: "ttl expired", count: 5 });
  });

  it("handles context_full events without error", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    eventBus.emit({
      type: "context_full",
      usagePercent: 85,
      tokensUsed: 5000,
      tokensLimit: 6000,
    });
  });

  it("handles turn_complete events without error", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    eventBus.emit({ type: "turn_complete", turn: 42, duration: 1000 });
  });

  it("handles heartbeat_tick events without error", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    eventBus.emit({
      type: "heartbeat_tick",
      turn: 10,
      tickCount: 3,
      timestamp: Date.now(),
    });
  });
});

console.log("✅ Event consumers tests complete");