/**
 * Test: Event Consumers — reactive handlers for Event Bus events
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  registerEventConsumers,
  resetConsumerState,
  getViolationCount,
  getEvictCount,
  getContextFullWarnings,
  getLastTurn,
  getTickCount,
  getConsumerStatus,
} = await import("../../dist/lib/event-consumers.js");

const { eventBus } = await import("../../dist/lib/event-bus.js");

describe("Event Consumers", () => {
  it("registers 6 handlers without error", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    const stats = eventBus.getStats();
    const totalHandlers = Object.values(stats).reduce((s, v) => s + v.persistent, 0);
    assert.equal(totalHandlers, 6, "Should have 6 persistent handlers");
  });

  it("tracks enforcement violations", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    eventBus.emit({ type: "enforcement_violation", rule: "test", description: "test violation", severity: "high" });
    eventBus.emit({ type: "enforcement_violation", rule: "test2", description: "another", severity: "low" });
    assert.equal(getViolationCount(), 2);
  });

  it("tracks memory evictions", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    eventBus.emit({ type: "memory_evict", reason: "ttl expired", count: 5 });
    assert.equal(getEvictCount(), 1);
  });

  it("tracks context full warnings", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    eventBus.emit({ type: "context_full", usagePercent: 85, tokensUsed: 5000, tokensLimit: 6000 });
    assert.equal(getContextFullWarnings(), 1);
  });

  it("tracks turn_complete events", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    eventBus.emit({ type: "turn_complete", turn: 42, duration: 1000 });
    assert.equal(getLastTurn(), 42);
  });

  it("tracks heartbeat ticks", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    eventBus.emit({ type: "heartbeat_tick", turn: 10, tickCount: 3, timestamp: Date.now() });
    assert.equal(getTickCount(), 3);
  });

  it("returns diagnostic status", () => {
    resetConsumerState();
    eventBus.clear();
    registerEventConsumers();
    const status = getConsumerStatus();
    assert.ok(status.includes("Event Bus Consumers"), "Should identify itself");
  });
});

console.log("✅ Event consumers tests complete");
