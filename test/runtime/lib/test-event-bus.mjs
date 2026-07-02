/**
 * Test: Event Bus - unified async event routing
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

const { eventBus, EventBus } = await import("../../../dist/lib/events/event-bus.js");

describe("Event Bus", () => {
  it("should be a singleton", () => {
    assert.ok(eventBus);
    assert.ok(typeof eventBus.on === "function");
    assert.ok(typeof eventBus.emit === "function");
    assert.ok(typeof eventBus.off === "function");
  });

  it("should deliver events to registered handlers", () => {
    const received = [];
    const handler = (event) => received.push(event.payload);

    eventBus.on("timer_fire", handler);
    eventBus.emit({ type: "timer_fire", id: "t1", reason: "test", payload: "hello", tag: undefined });

    assert.equal(received.length, 1);
    assert.equal(received[0], "hello");

    eventBus.off("timer_fire", handler);
  });

  it("should support multiple handlers per event type", () => {
    const results = [];
    const h1 = () => results.push(1);
    const h2 = () => results.push(2);

    eventBus.on("turn_complete", h1);
    eventBus.on("turn_complete", h2);
    eventBus.emit({ type: "turn_complete", turn: 1, duration: 100 });

    assert.equal(results.length, 2);
    assert.ok(results.includes(1));
    assert.ok(results.includes(2));

    eventBus.off("turn_complete", h1);
    eventBus.off("turn_complete", h2);
  });

  it("should support one-shot handlers via once()", () => {
    let count = 0;
    const handler = () => count++;

    eventBus.once("timer_fire", handler);
    eventBus.emit({ type: "timer_fire", id: "t1", reason: "a", payload: "first", tag: undefined });
    eventBus.emit({ type: "timer_fire", id: "t1", reason: "b", payload: "second", tag: undefined });

    assert.equal(count, 1, "once handler should fire only once");
  });

  it("should not crash on handler errors", () => {
    eventBus.on("timer_fire", () => { throw new Error("handler crash"); });
    eventBus.emit({ type: "timer_fire", id: "t1", reason: "test", payload: "crash", tag: undefined });
    // Should not throw - handler error is caught
    assert.ok(true);
  });

  it("should clear all handlers with clear()", () => {
    let count = 0;
    eventBus.on("turn_complete", () => count++);
    eventBus.clear();
    eventBus.emit({ type: "turn_complete", turn: 2, duration: 100 });
    assert.equal(count, 0, "handler should not fire after clear()");
  });

  it("should return stats about registered handlers", () => {
    const handler = () => {};
    eventBus.on("turn_complete", handler);
    eventBus.on("timer_fire", handler);

    const stats = eventBus.getStats();
    assert.ok(stats["turn_complete"]);
    assert.ok(stats["timer_fire"]);
    assert.equal(stats["turn_complete"].persistent, 1);

    eventBus.clear();
  });

  it("should clear specific event type", () => {
    let count = 0;
    const h1 = () => count++;
    eventBus.on("turn_complete", h1);
    eventBus.on("timer_fire", () => {});

    eventBus.clear("turn_complete");
    eventBus.emit({ type: "turn_complete", turn: 3, duration: 100 });
    assert.equal(count, 0);

    eventBus.clear();
  });
});

console.log("[ok] Event bus tests complete");
