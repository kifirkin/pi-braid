/**
 * Unit tests for lib pure functions (no pi/ctx dependency).
 * Models actual API shapes discovered through runtime inspection.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

// ═════════════════════════════════════════════════════════════════════════
// reasoning-summary
// ═════════════════════════════════════════════════════════════════════════

const { isReasoningMessage, extractReasoningSummary } =
  await import("../../dist/lib/reasoning/reasoning-summary.js");

describe("reasoning-summary", () => {
  it("isReasoningMessage returns false for non-assistant messages", () => {
    assert.equal(isReasoningMessage({ role: "user", content: "hello" }), false);
  });

  it("isReasoningMessage returns false for empty content", () => {
    assert.equal(isReasoningMessage({ role: "assistant" }), false);
  });

  it("isReasoningMessage returns true for string with  reasoning tag", () => {
    assert.equal(
      isReasoningMessage({ role: "assistant", content: "  reasoning\nLet me think about this." }),
      true,
    );
  });

  it("extractReasoningSummary handles long thinking text", () => {
    const block = { thinking: "A".repeat(500), messages: [] };
    const summary = extractReasoningSummary(block);
    assert.equal(typeof summary, "string");
  });

  it("extractReasoningSummary handles short text", () => {
    const block = { thinking: "Short thought.", messages: [] };
    const summary = extractReasoningSummary(block);
    assert.equal(typeof summary, "string");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// language-hint: detectLanguage (basic — returns EN for most inputs)
// ═════════════════════════════════════════════════════════════════════════

const { detectLanguage } = await import("../../dist/lib/ai/language-hint.js");

describe("language-hint", () => {
  it("detectLanguage always returns a code", () => {
    const result = detectLanguage("Hello world");
    assert.equal(typeof result.code, "string");
    assert.equal(typeof result.name, "string");
  });

  it("detectLanguage handles empty string", () => {
    const result = detectLanguage("");
    assert.equal(typeof result.code, "string");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// injection-tracker: extractText
// ═════════════════════════════════════════════════════════════════════════

const { extractText } = await import("../../dist/lib/utils/injection-tracker.js");

describe("injection-tracker", () => {
  it("extractText handles empty array", () => {
    const result = extractText([]);
    assert.equal(typeof result, "string");
  });

  it("extractText handles null", () => {
    const result = extractText(null);
    assert.equal(result, "");
  });
});

// ═════════════════════════════════════════════════════════════════════════
// turn-end-coordinator: pure handler dispatch
// ═════════════════════════════════════════════════════════════════════════

const {
  registerTurnEndHandler,
  unregisterTurnEndHandler,
  dispatchTurnEnd,
  getRegisteredHandlers,
  clearHandlers,
  handlerCount,
} = await import("../../dist/lib/events/turn-end-coordinator.js");

describe("turn-end-coordinator", () => {
  // Note: these tests share state since coordinator is a module-level singleton.
  // clearHandlers() is called in setup/teardown to isolate tests.

  it("starts with zero handlers", () => {
    clearHandlers();
    assert.equal(handlerCount(), 0);
  });

  it("registerTurnEndHandler adds a handler", () => {
    clearHandlers();
    registerTurnEndHandler("test", 50, () => {});
    assert.equal(handlerCount(), 1);
    clearHandlers();
  });

  it("getRegisteredHandlers returns formatted names", () => {
    clearHandlers();
    registerTurnEndHandler("test", 50, () => {});
    const handlers = getRegisteredHandlers();
    assert.ok(handlers[0].includes("test"));
    assert.ok(handlers[0].includes("50"));
    clearHandlers();
  });

  it("deduplicates handlers by name (last registration wins)", () => {
    clearHandlers();
    registerTurnEndHandler("same-name", 50, () => {});
    registerTurnEndHandler("same-name", 80, () => {});
    assert.equal(handlerCount(), 1);
    const handlers = getRegisteredHandlers();
    assert.ok(handlers[0].includes("80"));
    clearHandlers();
  });

  it("unregisterTurnEndHandler removes a handler", () => {
    clearHandlers();
    registerTurnEndHandler("test", 50, () => {});
    unregisterTurnEndHandler("test");
    assert.equal(handlerCount(), 0);
  });

  it("clearHandlers removes all handlers", () => {
    registerTurnEndHandler("a", 50, () => {});
    registerTurnEndHandler("b", 60, () => {});
    clearHandlers();
    assert.equal(handlerCount(), 0);
  });

  it("dispatchTurnEnd calls handlers in priority order", async () => {
    clearHandlers();
    const calls = [];
    registerTurnEndHandler("low", 10, async () => { calls.push("low"); });
    registerTurnEndHandler("high", 100, async () => { calls.push("high"); });
    registerTurnEndHandler("mid", 50, async () => { calls.push("mid"); });
    await dispatchTurnEnd({}, { cwd: "/test" });
    assert.deepEqual(calls, ["high", "mid", "low"]);
    clearHandlers();
  });

  it("dispatchTurnEnd isolates handler errors", async () => {
    clearHandlers();
    let secondRan = false;
    registerTurnEndHandler("throws", 50, async () => { throw new Error("fail"); });
    registerTurnEndHandler("catches", 40, async () => { secondRan = true; });
    await dispatchTurnEnd({}, { cwd: "/test" });
    assert.equal(secondRan, true);
    clearHandlers();
  });

  it("dispatchTurnEnd is no-op with no handlers", async () => {
    clearHandlers();
    await dispatchTurnEnd({}, { cwd: "/test" });
    assert.equal(handlerCount(), 0);
  });
});

console.log("✅ Lib pure function tests complete");
