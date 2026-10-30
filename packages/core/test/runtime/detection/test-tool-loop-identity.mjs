/**
 * Tool-loop identity: a loop is the same call repeating, not the same tool
 * name repeating.
 *
 * The detector used to count tool names. Sixteen `bash` calls running sixteen
 * different commands (git status, a build, a commit, a grep) reached the same
 * threshold as sixteen runs of one command, and the whisper told the agent it
 * was looping while it was working. Identity is the tool plus its arguments
 * (toolCallIdentity): keys sorted, whitespace collapsed, long values digested.
 *
 * Cases here, each one the shape it guards:
 *   1. chain of work, 20 distinct `bash` commands  -> NOT a loop
 *   2. the same `bash` call 20 times               -> loop, count 20, pattern repeat
 *   3. two calls strict-alternating 20 times       -> loop, pattern alternation
 *   4. mixed read/write chain, all distinct        -> NOT a loop
 *   5. threshold boundary: 15 repeats silent, 16 fires
 *   6. cross-turn: the same call in 16 consecutive turns -> loop, pattern cross-turn
 *   7. state change: after firing, the cooldown holds; a new episode after the
 *      cooldown re-fires
 *   8. intentional tool inside an identity repeat suppresses the verdict
 *   9. names-only sequences cannot accuse (the stateless seam)
 *  10. identity normalization: key order and whitespace are not identity
 *  11. the whisper states what it observed and never claims "no progress"
 *
 * Drives the COMPILED dist module (npm test builds first).
 * Run: node test/runtime/detection/test-tool-loop-identity.mjs
 */

import { strict as assert } from "node:assert";
import { test } from "node:test";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const D = join(ROOT, "dist");

const {
  createToolLoopState,
  recordToolCall,
  recordTurnEnd,
  detectToolLoop,
  detectToolLoopFromSequence,
  markLoopFired,
  toolCallIdentity,
  TOOL_LOOP_THRESHOLD,
  TOOL_LOOP_COOLDOWN_TURNS,
} = await import("file://" + join(D, "lib/detection/tool-loop-detector.js"));

console.log("=== tool-loop identity ===\n");

/** A chain of work: twenty different commands, all through `bash`. */
const CHAIN = [
  "cd /repo && git status --short",
  "cd /repo && git log --oneline -5",
  "cd /repo && rg -n 'timeout' src/lib",
  "cd /repo && sed -n '1,60p' package.json",
  "cd /repo && npm run typecheck",
  "cd /repo && npm run build",
  "cd /repo && node --test test/a.mjs",
  "cd /repo && node --test test/b.mjs",
  "cd /repo && git diff --stat",
  "cd /repo && git add src/lib/a.ts",
  "cd /repo && git commit -q -m 'fix: a'",
  "cd /repo && git add src/lib/b.ts",
  "cd /repo && git commit -q -m 'fix: b'",
  "cd /repo && rg -n 'report' src",
  "cd /repo && wc -l src/index.ts",
  "cd /repo && ls -la dist",
  "cd /repo && shasum dist/index.js",
  "cd /repo && git show --stat HEAD",
  "cd /repo && npm run lint",
  "cd /repo && git show HEAD --stat",
];

/** Drive a state with one call per entry, then close the turn. */
function drive(calls) {
  const state = createToolLoopState();
  for (const [tool, input] of calls) recordToolCall(state, tool, input);
  recordTurnEnd(state);
  return state;
}

const bash = (command) => ["bash", { command }];

// ── 1. the false accusation: twenty distinct commands ──────────────────────
test("chain of work: 20 distinct bash commands are NOT a loop", () => {
  const state = drive(CHAIN.map(bash));
  assert.equal(state.history.length, 20, "all 20 calls recorded in the window");
  assert.equal(
    new Set(state.history.map((c) => c.identity)).size,
    20,
    "20 distinct identities: no call repeated",
  );
  assert.equal(detectToolLoop(state).isLoop, false, "a chain of work is not a loop");
});

// ── 2. the case that must still fire: one command, twenty times ────────────
test("identical repeat: the same bash call 20 times IS a loop", () => {
  const state = drive(Array.from({ length: 20 }, () => bash("npm run build")));
  const verdict = detectToolLoop(state);
  assert.equal(verdict.isLoop, true, "one call repeated trips the detector");
  assert.equal(verdict.tool, "bash", "the identity's tool is named");
  assert.equal(verdict.count, 20, "the count is the run length");
  assert.equal(verdict.pattern, "repeat", "pattern names the repeat shape");
  assert.match(verdict.message, /^Tool loop detected: /, "message keeps the census phrase");
  assert.match(verdict.message, /repeated 20 times in a row/, "message states the observation");
  assert.doesNotMatch(
    verdict.message,
    /no progress/i,
    "the detector cannot see progress, so the message does not claim it",
  );
});

// ── 3. ping-pong: two calls alternating ────────────────────────────────────
test("alternation: two calls alternating 20 times IS a loop", () => {
  const state = createToolLoopState();
  for (let i = 0; i < 20; i++) {
    recordToolCall(state, "bash", { command: "npm run build" });
    recordToolCall(state, "read", { path: "/repo/dist/errors.log" });
    recordTurnEnd(state);
  }
  const verdict = detectToolLoop(state);
  assert.equal(verdict.isLoop, true, "a strict two-call oscillation is a loop");
  assert.equal(verdict.pattern, "alternation", "pattern names the oscillation");
  assert.equal(verdict.count, 20, "count is the number of calls in the oscillation");
  assert.match(verdict.message, /alternated 20 times in a row/, "message states the observation");
  assert.match(verdict.message, /`(bash|read)`, `(read|bash)`/, "message names both calls' tools");
  assert.doesNotMatch(verdict.message, /no progress/i, "no progress claim");
});

// ── 4. mixed chain: distinct reads and writes ──────────────────────────────
test("mixed chain: distinct read/write calls are NOT a loop", () => {
  const calls = [];
  for (let i = 0; i < 10; i++) calls.push(["read", { path: `/repo/src/mod${i}.ts` }]);
  for (let i = 0; i < 10; i++) calls.push(["write", { path: `/repo/src/out${i}.ts`, content: `x${i}` }]);
  const state = drive(calls);
  assert.equal(new Set(state.history.map((c) => c.identity)).size, 20, "20 distinct calls");
  assert.equal(detectToolLoop(state).isLoop, false, "editing a series of files is work");
});

// ── 5. threshold boundary ──────────────────────────────────────────────────
test("threshold: 15 repeats are silent, the 16th fires", () => {
  const under = drive(Array.from({ length: TOOL_LOOP_THRESHOLD - 1 }, () => bash("npm run build")));
  assert.equal(detectToolLoop(under).isLoop, false, "threshold - 1 does not fire");

  const at = drive(Array.from({ length: TOOL_LOOP_THRESHOLD }, () => bash("npm run build")));
  const verdict = detectToolLoop(at);
  assert.equal(verdict.isLoop, true, "threshold fires");
  assert.equal(verdict.count, TOOL_LOOP_THRESHOLD, "count is the threshold");
});

// ── 6. cross-turn: the same call, one per turn ─────────────────────────────
test("cross-turn: the same call in 16 consecutive turns IS a loop", () => {
  const state = createToolLoopState();
  for (let turn = 0; turn < TOOL_LOOP_THRESHOLD; turn++) {
    recordToolCall(state, "bash", { command: "npm run build" });
    // a different second call each turn: the same build call returns, nothing
    // else repeats, so only the cross-turn shape can name this a loop
    recordToolCall(state, "read", { path: `/repo/logs/turn-${turn}.log` });
    recordTurnEnd(state);
  }
  const verdict = detectToolLoop(state);
  assert.equal(verdict.isLoop, true, "one call returning every turn is a loop");
  assert.equal(verdict.pattern, "cross-turn", "pattern names the cross-turn shape");
  assert.match(verdict.message, /ran in 16 consecutive turns/, "message states the observation");
});

test("cross-turn: a different command each turn is NOT a loop", () => {
  const state = createToolLoopState();
  for (let turn = 0; turn < TOOL_LOOP_THRESHOLD; turn++) {
    recordToolCall(state, "bash", { command: `rg -n 'token${turn}' src` });
    recordTurnEnd(state);
  }
  assert.equal(detectToolLoop(state).isLoop, false, "changing the command each turn is a chain");
});

// ── 7. state change: cooldown, then a new episode ──────────────────────────
test("cooldown: the same episode stays at one verdict until the cooldown elapses", () => {
  const state = createToolLoopState();
  for (let turn = 0; turn < 8; turn++) {
    recordToolCall(state, "bash", { command: "npm run build" });
    recordToolCall(state, "bash", { command: "npm run build" });
    recordTurnEnd(state);
  }
  assert.equal(detectToolLoop(state).isLoop, true, "episode 1 fires");
  markLoopFired(state);

  for (let turn = 0; turn < TOOL_LOOP_COOLDOWN_TURNS - 1; turn++) {
    recordToolCall(state, "bash", { command: "npm run build" });
    recordToolCall(state, "bash", { command: "npm run build" });
    recordTurnEnd(state);
  }
  assert.equal(detectToolLoop(state).isLoop, false, "inside the cooldown: no second whisper");

  recordToolCall(state, "bash", { command: "npm run build" });
  recordToolCall(state, "bash", { command: "npm run build" });
  recordTurnEnd(state);
  assert.equal(detectToolLoop(state).isLoop, true, "cooldown elapsed: the episode re-fires");
});

// ── 8. intentional-use filter survives the identity rule ───────────────────
test("intentional use: a think inside an identity repeat suppresses the verdict", () => {
  const state = createToolLoopState();
  recordToolCall(state, "think", { type: "reflect", decision: "re-evaluate" });
  for (let i = 0; i < 19; i++) recordToolCall(state, "bash", { command: "npm run build" });
  recordTurnEnd(state);
  assert.equal(
    state.history.filter((c) => c.identity === toolCallIdentity("bash", { command: "npm run build" }))
      .length,
    19,
    "19 identical calls are in the window",
  );
  assert.equal(detectToolLoop(state).isLoop, false, "an engaged agent is not stuck");
});

// ── 9. the stateless seam: names cannot accuse ─────────────────────────────
test("stateless: a names-only sequence cannot establish a loop", () => {
  const names = Array.from({ length: 20 }, () => "bash");
  const verdict = detectToolLoopFromSequence(names);
  assert.equal(verdict.isLoop, false, "twenty identical names are not twenty identical calls");
});

test("stateless: a recorded identity repeat fires on the same path", () => {
  const calls = Array.from({ length: 20 }, () => ({
    tool: "bash",
    identity: toolCallIdentity("bash", { command: "npm run build" }),
  }));
  const verdict = detectToolLoopFromSequence(calls);
  assert.equal(verdict.isLoop, true, "the stateless path fires when it holds identities");
  assert.equal(verdict.count, 20, "same count as the stateful path");
  assert.match(verdict.message, /repeated 20 times in a row/, "same message as the stateful path");
});

test("stateless: a recorded chain of distinct calls is NOT a loop", () => {
  const calls = CHAIN.map((command) => ({
    tool: "bash",
    identity: toolCallIdentity("bash", { command }),
  }));
  assert.equal(detectToolLoopFromSequence(calls).isLoop, false, "chain of work stays silent");
});

// ── 10. identity normalization ─────────────────────────────────────────────
test("identity: key order and whitespace are not identity", () => {
  assert.equal(
    toolCallIdentity("read", { path: "/repo/a.ts", limit: 50 }),
    toolCallIdentity("read", { limit: 50, path: "/repo/a.ts" }),
    "argument key order does not change the call",
  );
  assert.equal(
    toolCallIdentity("bash", { command: "git   status\n  --short" }),
    toolCallIdentity("bash", { command: "git status --short" }),
    "whitespace does not change the call",
  );
  assert.notEqual(
    toolCallIdentity("bash", { command: "git status" }),
    toolCallIdentity("bash", { command: "git log" }),
    "a different command is a different call",
  );
  assert.notEqual(
    toolCallIdentity("read", { path: "/repo/a.ts" }),
    toolCallIdentity("read", { path: "/repo/b.ts" }),
    "a different path is a different call",
  );
});

test("identity: long values are digested, equality survives the digest", () => {
  const command = `node -e '${"x".repeat(2000)}'`;
  const identity = toolCallIdentity("bash", { command });
  assert.ok(identity.length < 200, `identity stays bounded (${identity.length} chars)`);
  assert.equal(
    identity,
    toolCallIdentity("bash", { command }),
    "the same long command yields the same identity",
  );
  assert.notEqual(
    identity,
    toolCallIdentity("bash", { command: `${command}y` }),
    "a different long command yields a different identity",
  );
});

// ── 11. no identity evidence, no verdict ───────────────────────────────────
test("a call recorded without arguments is identified by its name", () => {
  assert.equal(toolCallIdentity("bash"), "bash", "no arguments: the name is the identity");
  assert.equal(toolCallIdentity("bash", {}), "bash", "empty arguments: the name is the identity");
});

