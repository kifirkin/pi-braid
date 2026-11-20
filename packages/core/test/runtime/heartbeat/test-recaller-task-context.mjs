/**
 * The recaller reads the task, not the session's age.
 *
 * Two defects are measured here:
 *
 * 1. the module context carried no tool names: the field was declared on
 *    `ModuleContext` and constructed as `[]`, so no consumer could see what
 *    the turn actually did;
 * 2. the heuristic matcher compared conditions against a string built from
 *    turn and tool counters, so any condition mentioning "session" or "work"
 *    was selected on every long session, whatever the agent was doing.
 *
 * The fixture drives the real extension for the window (a tool call, then a
 * tick) and the real recaller for the selection, then holds the line: a
 * condition is selected only when the words the agent was given, or the tools
 * it called, carry a strict majority of its content terms.
 *
 * Run: node test/runtime/heartbeat/test-recaller-task-context.mjs
 * (built first: npm run build)
 */

import { test } from "node:test";
import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// Pin the persistent tree BEFORE the dist imports: braid-settings bakes its
// settings path from homedir() at module-eval time.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "braid-recaller-home-"));
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-recaller-data-"));
process.env.HOME = FAKE_HOME;
process.env.BRAID_HOME = BRAID_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST = join(ROOT, "dist");

const { default: heartbeatExtension } = await import(
  "file://" + join(DIST, "extensions", "heartbeat", "heartbeat-scheduler", "index.js")
);
const { getState, getMemoryState } = await import(
  "file://" + join(DIST, "extensions", "heartbeat", "heartbeat-scheduler", "state.js")
);
const { recallerModule } = await import(
  "file://" + join(DIST, "extensions", "heartbeat", "heartbeat-scheduler", "modules", "recaller.js")
);

console.log("=== recaller task context ===\n");

/** Minimal ExtensionAPI double: handlers, deliveries and durable entries. */
function fakePi() {
  const handlers = new Map();
  const sent = [];
  return {
    handlers,
    sent,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool() {},
    appendEntry() {},
    getAllTools: () => [],
    getActiveTools: () => [],
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    sendUserMessage() {},
  };
}

function fakeCtx(sessionId) {
  return {
    cwd: "/tmp/proj",
    model: { contextWindow: 1_000_000 },
    sessionManager: {
      getSessionId: () => sessionId,
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getBranch: () => [],
      getEntries: () => [],
    },
    getContextUsage: () => ({ percent: 5, tokens: 50_000, contextWindow: 1_000_000 }),
  };
}

/** Run every handler the extension registered for this event. */
async function emit(pi, event, ctx) {
  for (const handler of pi.handlers.get(event.type) ?? []) {
    await handler(event, ctx);
  }
}

/** Drive turn boundaries until the scheduler ticks once. */
async function runUntilTick(pi, ctx, state, maxTurns = 80) {
  const before = state.stats.totalTicks;
  for (let turn = 0; turn < maxTurns && state.stats.totalTicks === before; turn++) {
    await emit(pi, { type: "turn_end", turnIndex: state.turnCount }, ctx);
  }
  assert.ok(state.stats.totalTicks > before, "the scheduler must tick within the turn window");
  // Module activations are fired from the tick's pass; let them settle.
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/**
 * Boot the extension with a capture module at the front of the activation
 * queue, then return the pi/ctx/state triple plus the slot the module fills.
 */
async function bootWithCapture(sessionId) {
  const pi = fakePi();
  heartbeatExtension(pi);
  const ctx = fakeCtx(sessionId);
  await emit(pi, { type: "session_start", session: {} }, ctx);

  const state = getState(ctx);
  const captured = { context: null };
  state.modules.set("context-capture", {
    module: {
      name: "context-capture",
      description: "captures the module context for the fixture",
      priority: 100,
      shouldActivate: () => true,
      async activate(context) {
        captured.context = context;
      },
    },
    enabled: true,
    activations: 0,
    lastActivated: 0,
    effectiveness: 0.5,
  });
  return { pi, ctx, state, captured };
}

// ── the window the tick hands to modules ───────────────────────────────────

test("a tool call before a tick is on the module context", async () => {
  const { pi, ctx, state, captured } = await bootWithCapture("recall-1");

  await emit(
    pi,
    { type: "before_agent_start", prompt: "inspect the heartbeat scheduler wiring" },
    ctx,
  );
  await emit(pi, { type: "tool_call", toolName: "read", input: { path: "/tmp/a.ts" } }, ctx);
  await emit(pi, { type: "tool_call", toolName: "grep", input: { pattern: "moduleContext" } }, ctx);

  await runUntilTick(pi, ctx, state);

  assert.ok(captured.context, "the capture module received a heartbeat tick");
  assert.deepEqual(
    captured.context.toolCallsSinceLastTick,
    ["read", "grep"],
    `the tick carries the calls made since the previous tick (got ${JSON.stringify(captured.context.toolCallsSinceLastTick)})`,
  );
  assert.equal(
    captured.context.recentUserText,
    "inspect the heartbeat scheduler wiring",
    "the tick carries the prompt the agent was given",
  );
});

test("a second tick carries only the calls made after the first", async () => {
  const { pi, ctx, state, captured } = await bootWithCapture("recall-2");

  await emit(pi, { type: "tool_call", toolName: "read", input: {} }, ctx);
  await runUntilTick(pi, ctx, state);
  assert.deepEqual(
    captured.context.toolCallsSinceLastTick,
    ["read"],
    "first tick sees the first call",
  );

  await emit(pi, { type: "tool_call", toolName: "bash", input: {} }, ctx);
  await runUntilTick(pi, ctx, state);
  assert.deepEqual(
    captured.context.toolCallsSinceLastTick,
    ["bash"],
    `the window resets at each tick (got ${JSON.stringify(captured.context.toolCallsSinceLastTick)})`,
  );
});

// ── the matcher the recaller runs ──────────────────────────────────────────

let matcherSessions = 0;

/**
 * Run the real recaller against one heuristic and return the whispers it
 * asked for. The memory state is the same session-scoped bucket the memory
 * extension populates.
 */
async function selectHeuristic({ taskText, toolNames = [], condition }) {
  const ctx = fakeCtx(`matcher-${++matcherSessions}`);
  const memState = getMemoryState(ctx);
  assert.ok(memState, "the memory state is available");
  memState.heuristics = [
    {
      id: "h-1",
      condition,
      action: "apply the condition",
      priority: 1,
      successRate: 0.5,
      uses: 0,
      successes: 0,
      lastUsed: 0,
      created: 0,
    },
  ];

  const whispers = [];
  await recallerModule.activate({
    ctx,
    turnCount: 10,
    lastActivation: new Map(),
    sessionAge: 10,
    toolCallsSinceLastTick: toolNames,
    recentUserText: taskText,
    totalToolCalls: 12,
    silentTurns: 0,
    metadata: {},
    whisper(message) {
      whispers.push(message);
    },
  });
  return whispers;
}

const HYGIENE = "session hygiene: prune the scratchpad before compaction";

test("a heuristic about pruning is silent on a rename task", async () => {
  const whispers = await selectHeuristic({
    taskText: "rename a variable in the timer",
    condition: HYGIENE,
  });
  assert.equal(whispers.length, 0, `no heuristic for an unrelated task (got ${whispers.length})`);
});

test("the same heuristic is selected on the task that names it", async () => {
  const whispers = await selectHeuristic({
    taskText: "prune the scratchpad before compaction",
    condition: HYGIENE,
  });
  assert.equal(whispers.length, 1, `one recall whisper (got ${whispers.length})`);
  assert.match(whispers[0], /scratchpad/, `the condition is named: ${whispers[0]}`);
  assert.match(whispers[0], /<memory-context>/, "the whisper keeps its fence");
});

test("one shared verb is not a task match", async () => {
  const whispers = await selectHeuristic({
    taskText: "prune the dead code",
    condition: HYGIENE,
  });
  assert.equal(whispers.length, 0, `a shared verb is not a shared task (got ${whispers.length})`);
});

test("tool names are task evidence", async () => {
  const whispers = await selectHeuristic({
    taskText: "collect the section headings",
    toolNames: ["browser_navigate"],
    condition: "browser navigate the sitemap",
  });
  assert.equal(
    whispers.length,
    1,
    `two condition terms in the tool names select (got ${whispers.length})`,
  );
});

test("a condition whose terms are all function words is never selected", async () => {
  const whispers = await selectHeuristic({
    taskText: "the work of the session",
    condition: "the and of with",
  });
  assert.equal(whispers.length, 0, `a contentless condition selects nothing (got ${whispers.length})`);
});
