/**
 * turn_start carries no user text: pi declares TurnStartEvent as
 * { type, turnIndex, timestamp } and its event mapping emits exactly those
 * fields, so a handler reading `event.userMessage ?? event.text` sees "" and
 * the SOP-suggestion path never runs. The path needs a source pi actually
 * provides: the run prompt from before_agent_start, with the live branch's
 * newest user entry as fallback.
 *
 * The observable is the typed `sop_suggestion` event the injection path emits
 * on the shared eventBus once a seeded episode scores above threshold. The
 * harness drives the extension's real registered handlers in pi's event order
 * with a stub pi/ctx.
 *
 * Run: node test/runtime/heartbeat/test-turn-start-sop-source.mjs
 *      (after npm run build - this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// HOME redirect BEFORE dist imports: settings resolution walks homedir().
process.env.HOME = mkdtempSync(join(tmpdir(), "turn-start-sop-source-"));

const { default: heartbeatExtension } = await import(
  "../../../dist/extensions/heartbeat/heartbeat-scheduler/index.js"
);
const { getExtensionState } = await import("../../../dist/lib/state/extension-state.js");
const { eventBus } = await import("../../../dist/lib/events/event-bus.js");

console.log("=== turn_start SOP suggestion sources the current prompt ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

const PROMPT = "refactor heartbeat scheduler dedup window";

function deriveProject(cwd) {
  const parts = cwd.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.length >= 2 ? parts.slice(-2).join("/") : cwd || "unknown";
}

let seq = 0;

function makeCtx(branch = []) {
  const id = `turn-start-sop-${seq++}`;
  return {
    cwd: `/tmp/heartbeat-projects/${id}`,
    sessionManager: {
      getSessionFile: () => `${id}.jsonl`,
      getSessionId: () => id,
      getBranch: () => branch,
      getEntries: () => [],
    },
    getContextUsage: () => ({ percent: 10, tokens: 1_000, contextWindow: 200_000 }),
  };
}

function seedEpisode(ctx, id, task, project) {
  const memState = getExtensionState(ctx, "three-memory-stores", () => ({ episodes: [] }));
  const episode = {
    id,
    task,
    solution: "capture the prompt before the first turn, then consult it per turn",
    outcome: "success",
    similarity: 0,
    timestamp: Date.now(),
    toolSequence: ["read", "edit"],
    tags: ["heartbeat"],
    project,
    sessionId: "turn-start-sop-test",
    strategicSOP: "source the turn text from the event that carries it",
    functionalSOP: ["read the event type", "capture before turn zero"],
    atomicSOP: ["read", "edit"],
  };
  memState.episodes.push(episode);
  return episode;
}

function makePi() {
  const handlers = new Map();
  const sent = [];
  return {
    sent,
    on(event, fn) {
      handlers.set(event, [...(handlers.get(event) ?? []), fn]);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
    async emit(event, payload, ctx) {
      for (const fn of handlers.get(event) ?? []) {
        await fn(payload, ctx);
      }
    },
  };
}

function collectSuggestions() {
  const seen = [];
  const handler = (event) => seen.push(event);
  eventBus.on("sop_suggestion", handler);
  return { seen, stop: () => eventBus.off("sop_suggestion", handler) };
}

const pi = makePi();
heartbeatExtension(pi);

await test("before_agent_start + turn_start: the captured prompt scores an episode", async () => {
  const ctx = makeCtx();
  const episode = seedEpisode(ctx, "ep-captured", PROMPT, deriveProject(ctx.cwd));
  const collected = collectSuggestions();
  try {
    await pi.emit("before_agent_start", { type: "before_agent_start", prompt: PROMPT }, ctx);
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
  } finally {
    collected.stop();
  }
  assert.equal(
    collected.seen.length,
    1,
    `exactly one sop_suggestion event (got ${collected.seen.length})`,
  );
  assert.equal(collected.seen[0].episodeId, episode.id);
  assert.ok(
    collected.seen[0].similarity >= 0.3,
    `similarity above the retrieval floor (got ${collected.seen[0].similarity})`,
  );
});

await test("no capture: the newest user entry in the branch is the fallback source", async () => {
  const branch = [
    {
      id: "u1",
      type: "message",
      message: { role: "user", content: [{ type: "text", text: PROMPT }] },
    },
  ];
  const ctx = makeCtx(branch);
  const episode = seedEpisode(ctx, "ep-branch", PROMPT, deriveProject(ctx.cwd));
  const collected = collectSuggestions();
  try {
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
  } finally {
    collected.stop();
  }
  assert.equal(collected.seen.length, 1, "the branch fallback fed the retrieval");
  assert.equal(collected.seen[0].episodeId, episode.id);
});

await test("fallback accepts a plain-string user content too", async () => {
  const branch = [{ id: "u2", type: "message", message: { role: "user", content: PROMPT } }];
  const ctx = makeCtx(branch);
  const episode = seedEpisode(ctx, "ep-branch-string", PROMPT, deriveProject(ctx.cwd));
  const collected = collectSuggestions();
  try {
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
  } finally {
    collected.stop();
  }
  assert.equal(collected.seen.length, 1, "a string-content user entry is a valid source");
  assert.equal(collected.seen[0].episodeId, episode.id);
});

await test("neither capture nor branch user text: no suggestion is invented", async () => {
  const ctx = makeCtx();
  seedEpisode(ctx, "ep-unreferenced", PROMPT, deriveProject(ctx.cwd));
  const collected = collectSuggestions();
  try {
    await pi.emit("turn_start", { type: "turn_start", turnIndex: 0, timestamp: Date.now() }, ctx);
  } finally {
    collected.stop();
  }
  assert.equal(collected.seen.length, 0, "an empty turn text stays below the length guard");
});

console.log(`\nResults: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== turn_start SOP source tests passed ===");
