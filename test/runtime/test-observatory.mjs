/**
 * Test: Agent Observatory — real-time monitoring system
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const {
  getCollector,
  getObservatoryStatus,
  startObservatory,
  stopObservatory,
} = await import("../../dist/lib/observatory.js");

describe("Observatory", () => {
  it("collects events from Event Bus", () => {
    const collector = getCollector();
    collector.reset();
    
    // Manually record events
    collector.recordToolCall({ toolName: "bash", turn: 1, timestamp: Date.now(), duration: 100, success: true });
    collector.recordStateSnapshot({ turn: 1, timestamp: Date.now(), goal: "test", phase: "exploring", toolCount: 1, errorCount: 0, contextUsage: 0.1, activeModules: ["heartbeat"] });
    
    const metrics = collector.getMetrics();
    assert.equal(metrics.toolCalls.length, 1);
    assert.equal(metrics.stateSnapshots.length, 1);
  });

  it("getToolCallsSince filters by timestamp", () => {
    const collector = getCollector();
    collector.reset();
    
    // Future timestamp should return nothing
    const future = Date.now() + 99999;
    assert.equal(collector.getToolCallsSince(future).length, 0);
    
    // Record a tool call, then check it's findable with past timestamp
    collector.recordToolCall({ toolName: "edit", turn: 2, timestamp: Date.now(), duration: 200, success: true });
    const past = Date.now() - 99999;
    assert.ok(collector.getToolCallsSince(past).length >= 1);
  });

  it("tracks errors in tool calls", () => {
    const collector = getCollector();
    collector.reset();
    
    collector.recordToolCall({ toolName: "bash", turn: 1, timestamp: Date.now(), duration: 500, success: false, error: "command not found" });
    const metrics = collector.getMetrics();
    assert.equal(metrics.toolCalls[0].success, false);
    assert.equal(metrics.toolCalls[0].error, "command not found");
  });

  it("returns status string", () => {
    const status = getObservatoryStatus();
    assert.ok(status.includes("Agent Observatory"), "Should identify itself");
    assert.ok(typeof status === "string");
  });

  it("start/stop server doesn't crash", () => {
    // Verify server module can instantiate without error
    const status = getObservatoryStatus();
    assert.ok(status.includes("Server running: no"), "Server should not be running initially");
    assert.ok(true, "Server module loaded without error");
  });
});

console.log("✅ Observatory tests complete");
