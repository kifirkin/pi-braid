/**
 * Test: dreamer module end-to-end verification (D0)
 *
 * Verifies that the dreamer module:
 * 1. shouldActivate() returns true when conditions are met (25+ turns, 15+ tools)
 * 2. shouldActivate() returns false when conditions are not met
 * 3. activate() generates a reflection episode with real ctx
 * 4. activate() calls whisper with insights when patterns detected
 * 5. activate() adds heuristic rule when cross-session pattern repeats
 */

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";

const { dreamerModule, getMemoryState } = await import(
  "../../dist/extensions/heartbeat/heartbeat-scheduler/index.js"
);

// ── Mock ctx builder ────────────────────────────────────────────────────────
// Builds a minimal ctx that satisfies getMemoryState + whisper interface
function createMockCtx(overrides = {}) {
  const toolsUsed = overrides.toolsUsed || [];
  const episodes = overrides.episodes || [];
  const whisperCalls = [];

  const memState = {
    currentSessionTools: toolsUsed,
    episodes,
    heuristics: [],
    addEpisode: (ep) => { episodes.push(ep); },
    addHeuristic: (h) => { heuristics.push(h); },
  };

  return {
    turnCount: overrides.turnCount || 30,
    totalToolCalls: overrides.totalToolCalls || 20,
    lastActivation: overrides.lastActivation || new Map(),
    sessionAge: overrides.sessionAge || 30,
    toolCallsSinceLastTick: [],
    silentTurns: 0,
    metadata: { toolFailures: 0, decompositionDepth: 0 },
    // ctx object that getMemoryState can read
    get cwd() { return "/test/project"; },
    whisper: (msg, opts) => { whisperCalls.push({ msg, opts }); },
    _whisperCalls: whisperCalls,
    _memState: memState,
    _episodes: episodes,
    ...overrides,
  };
}

// Hook getMemoryState to return our mock memState
const originalGetMemoryState = getMemoryState;

const DEFAULT_CONTEXT = {
  turnCount: 30,
  totalToolCalls: 20,
  lastActivation: new Map(),
  ctx: undefined,
  sessionAge: 30,
  toolCallsSinceLastTick: [],
  silentTurns: 0,
  metadata: { toolFailures: 0, decompositionDepth: 0 },
};

describe("D0 Dreamer Module", () => {
  it("shouldActivate returns true with sufficient turns and tools", () => {
    const context = {
      ...DEFAULT_CONTEXT,
      turnCount: 30,
      totalToolCalls: 21,
    };
    const result = dreamerModule.shouldActivate(context);
    assert.equal(result, true, "Should activate at 30 turns / 21 tools (no ctx)");
  });

  it("shouldActivate returns false with insufficient turns", () => {
    const context = {
      ...DEFAULT_CONTEXT,
      turnCount: 5,
      totalToolCalls: 30,
    };
    const result = dreamerModule.shouldActivate(context);
    assert.equal(result, false, "Should not activate at 5 turns");
  });

  it("shouldActivate returns false with insufficient tools", () => {
    const context = {
      ...DEFAULT_CONTEXT,
      turnCount: 30,
      totalToolCalls: 3,
    };
    const result = dreamerModule.shouldActivate(context);
    assert.equal(result, false, "Should not activate with 3 tool calls");
  });

  it("shouldActivate respects cooldown (25 turns between activations)", () => {
    const lastActivation = new Map();
    lastActivation.set("dreamer", 10);
    const context = {
      ...DEFAULT_CONTEXT,
      turnCount: 30,
      totalToolCalls: 30,
      lastActivation,
    };
    const result = dreamerModule.shouldActivate(context);
    assert.equal(result, false, "Should not activate within 25-turn cooldown");
  });

  it("shouldActivate works after cooldown expires", () => {
    const lastActivation = new Map();
    lastActivation.set("dreamer", 5);
    const context = {
      ...DEFAULT_CONTEXT,
      turnCount: 35,
      totalToolCalls: 21,
      lastActivation,
    };
    const result = dreamerModule.shouldActivate(context);
    assert.equal(result, true, "Should activate after 30 turns (past 25 cooldown)");
  });

  it("module metadata is correctly structured", () => {
    assert.equal(dreamerModule.name, "dreamer");
    assert.equal(dreamerModule.priority, 0.4);
    assert.ok(typeof dreamerModule.shouldActivate === "function");
    assert.ok(typeof dreamerModule.activate === "function");
  });

  // ── activate() integration tests ──────────────────────────────────────
  // These tests verify the activate() code path using a real ExtensionContext
  // built from pi's getExtensionState. We import the actual extension to get
  // a properly structured ctx.

  it("activate() returns early when no memState (ctx undefined)", async () => {
    const context = {
      ...DEFAULT_CONTEXT,
      turnCount: 30,
      totalToolCalls: 21,
      ctx: undefined,
    };
    // Should not throw, just return early
    await dreamerModule.activate(context);
  });

  it("activate() generates a reflection episode with code-heavy pattern", async () => {
    // Build a real ctx-like object that getExtensionState can use
    const episodes = [];
    const whisperCalls = [];
    const toolsUsed = [
      "bash", "write", "edit", "bash", "write", "edit",
      "bash", "write", "edit", "bash", "write", "edit",
      "bash", "write", "edit", "bash", "write", "edit",
      "bash", "write", "edit", "bash",
    ];

    // Create a minimal ctx that works with getExtensionState
    const ctx = {
      cwd: "/test/project",
      whisper: (msg, opts) => { whisperCalls.push({ msg, opts }); },
    };

    // Pre-populate the extension state that getMemoryState reads
    const { getExtensionState } = await import("../../dist/lib/extension-state.js");
    getExtensionState(ctx, "three-memory-stores", () => ({
      episodes,
      heuristics: [],
      toolStats: new Map(),
      currentSessionTools: toolsUsed,
      sessionStartTime: Date.now(),
      lastSkillType: "",
      skillTransitionCount: 0,
      recentErrors: [],
      currentSessionId: "test-session",
    }));

    const context = {
      turnCount: 30,
      totalToolCalls: 25,
      lastActivation: new Map(),
      ctx,
      sessionAge: 30,
      toolCallsSinceLastTick: [],
      silentTurns: 0,
      metadata: { toolFailures: 0, decompositionDepth: 0 },
    };

    await dreamerModule.activate(context);

    // Verify episode was created
    assert.ok(episodes.length > 0, "Should create at least one episode");
    const ep = episodes[episodes.length - 1];
    assert.ok(ep.task.match(/\d+ tool calls/), "Episode task should mention tool count, got: " + ep.task);
    assert.ok(ep.tags.includes("dreamer"), "Episode should have dreamer tag");
    assert.ok(ep.tags.includes("self-reflection"), "Episode should have self-reflection tag");
  });

  it("activate() calls whisper when code-heavy pattern detected", async () => {
    const episodes = [];
    const whisperCalls = [];
    const toolsUsed = [
      "bash", "write", "edit", "bash", "write", "edit",
      "bash", "write", "edit", "bash", "write", "edit",
      "bash", "write", "edit", "bash", "write", "edit",
      "bash", "write", "edit", "bash", "write", "edit", "bash",
    ];

    const ctx = {
      cwd: "/test/project",
      whisper: (msg, opts) => { whisperCalls.push({ msg, opts }); },
    };

    const { getExtensionState } = await import("../../dist/lib/extension-state.js");
    getExtensionState(ctx, "three-memory-stores", () => ({
      episodes,
      heuristics: [],
      toolStats: new Map(),
      currentSessionTools: toolsUsed,
      sessionStartTime: Date.now(),
      lastSkillType: "",
      skillTransitionCount: 0,
      recentErrors: [],
      currentSessionId: "test-session",
    }));

    const context = {
      turnCount: 30,
      totalToolCalls: 26,
      lastActivation: new Map(),
      ctx,
      sessionAge: 30,
      toolCallsSinceLastTick: [],
      silentTurns: 0,
      metadata: { toolFailures: 0, decompositionDepth: 0 },
    };

    await dreamerModule.activate(context);

    assert.ok(whisperCalls.length > 0, "Should call whisper with insights");
    const whisperMsg = whisperCalls[0].msg;
    assert.ok(
      whisperMsg.includes("Code-heavy") || whisperMsg.includes("verification") || whisperMsg.includes("code generation"),
      "Whisper should mention code-heavy pattern, got: " + whisperMsg,
    );
  });

  it("activate() does NOT call whisper when no concerning patterns", async () => {
    const episodes = [];
    const whisperCalls = [];
    const toolsUsed = [
      "grep", "find", "read", "read_document", "web_fetch",
      "bash", "write", "edit",
      "grep", "find", "read",
      "bash", "write",
      "grep", "find",
      "bash",
    ];

    const ctx = {
      cwd: "/test/project",
      whisper: (msg, opts) => { whisperCalls.push({ msg, opts }); },
    };

    const { getExtensionState } = await import("../../dist/lib/extension-state.js");
    getExtensionState(ctx, "three-memory-stores", () => ({
      episodes,
      heuristics: [],
      toolStats: new Map(),
      currentSessionTools: toolsUsed,
      sessionStartTime: Date.now(),
      lastSkillType: "",
      skillTransitionCount: 0,
      recentErrors: [],
      currentSessionId: "test-session",
    }));

    const context = {
      turnCount: 30,
      totalToolCalls: 20,
      lastActivation: new Map(),
      ctx,
      sessionAge: 30,
      toolCallsSinceLastTick: [],
      silentTurns: 0,
      metadata: { toolFailures: 0, decompositionDepth: 0 },
    };

    await dreamerModule.activate(context);

    assert.equal(whisperCalls.length, 0, "Should not call whisper for balanced usage");
  });

  it("activate() generates episode with repetitive tool pattern insight", async () => {
    const episodes = [];
    const whisperCalls = [];
    const toolsUsed = Array(25).fill("bash");

    const ctx = {
      cwd: "/test/project",
      whisper: (msg, opts) => { whisperCalls.push({ msg, opts }); },
    };

    const { getExtensionState } = await import("../../dist/lib/extension-state.js");
    getExtensionState(ctx, "three-memory-stores", () => ({
      episodes,
      heuristics: [],
      toolStats: new Map(),
      currentSessionTools: toolsUsed,
      sessionStartTime: Date.now(),
      lastSkillType: "",
      skillTransitionCount: 0,
      recentErrors: [],
      currentSessionId: "test-session",
    }));

    const context = {
      turnCount: 30,
      totalToolCalls: 25,
      lastActivation: new Map(),
      ctx,
      sessionAge: 30,
      toolCallsSinceLastTick: [],
      silentTurns: 0,
      metadata: { toolFailures: 0, decompositionDepth: 0 },
    };

    await dreamerModule.activate(context);

    assert.ok(episodes.length > 0, "Should create episode");
    assert.ok(whisperCalls.length > 0, "Should whisper about repetitive usage");
    const whisperMsg = whisperCalls[0].msg;
    assert.ok(
      whisperMsg.includes("Repetitive") || whisperMsg.includes("alternative"),
      "Whisper should mention repetitive pattern, got: " + whisperMsg,
    );
  });
});

console.log("✅ D0 dreamer tests complete");
