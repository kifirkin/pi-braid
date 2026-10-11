/**
 * Regression test: whisper truncation fix — honest render with
 * retrieval handles for three-memory-store whispers.
 *
 * Owner report: "Retrieved text in three-memory-store whispers is sometimes
 * truncated CRITICALLY."Both whisper render sites sliced retrieved content
 * aggressively (episode task 80 / solution 300; semantic 80) with NO ellipsis
 * and NO memory id, so the receiving agent could not even fetch the full
 * entry. The write path was always clean (addEpisode/sanitizeEpisode store
 * full task/solution; CognitiveMemoryEntry.content is stored and recalled
 * full) — the truncation was render-side only.
 *
 * Fix behaviors pinned here (each FAILS on the pre-fix code):
 * (a) Episode whisper with long solution (>600): renders the full first
 * 600 chars at the start of the Solution line, ends that line with an
 * explicit ellipsis, and appends a retrieval handle
 * `(id: <ep id> — memory recall_get for full text)`.
 * (b) Cross-recall semantic whisper (worst site, was 80 chars): renders
 * 300 chars + explicit ellipsis + `(id: <memory id>)`for a long
 * semantic entry; content beyond the cap must not leak.
 * (c) Short episode (both fields under cap): NO ellipsis and NO id line —
 * no noise for already-complete renders.
 * (d) Mark preservation (compat lock): cross-session episodes still render
 * `[CROSS-SESSION]`and memory confidence `(conf N%)`exactly as
 * before; the icon line format is unchanged.
 *
 * Fixture style follows test-recall-project-scope.mjs: import from dist/,
 * injectable pi fake capturing sendTrackedMessage payload (pi.sendMessage).
 *
 * Hygiene notes:
 * - WHISPER_CAPS.low is 1 per turn: each case calls beginTurn() to open a
 * fresh turn window, so the flood cap never suppresses a fixture send.
 * - The cross-recall path drives the real turn_end handler with an
 * injected CognitiveMemory singleton whose in-memory store is seeded
 * directly (no store() call). recall()'s saveMemory writes the fresh
 * store to SEMANTIC_MEMORY_FILE — the real file's bytes are snapshotted
 * before and restored after (finally), so the owner's live semantic
 * memory is untouched.
 * - The contamination emitSignal path is skipped (recentErrors prefilled
 * to 10) — it needs no coverage here and keeps the fake ctx minimal.
 */

import { strict as assert } from "node:assert";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";

const { whisperRecall } =
  await import("../../../dist/extensions/memory/three-memory-stores/handlers/whisper-recall.js");
const {
  createMemoryStoresState,
  getState,
  default: threeMemoryStoresExtension,
} = await import("../../../dist/extensions/memory/three-memory-stores/index.js");
const { beginTurn } = await import("../../../dist/lib/enforcement/turn-dedup.js");
const { clearAllBuckets } = await import("../../../dist/lib/utils/injection-tracker.js");
const { getCognitiveMemoryInstance, setCognitiveMemoryInstance } =
  await import("../../../dist/lib/state/global-state.js");
const { CognitiveMemory } = await import("../../../dist/lib/memory/index.js");
const { SEMANTIC_MEMORY_FILE } = await import("../../../dist/lib/config/braid-paths.js");

console.log("=== Three-mem whisper render: honest truncation with retrieval handles ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

// ── Fixtures ─────────────────────────────────────────────────────────────────

/** Injectable pi fake: captures every sendTrackedMessage delivery. */
function makeCapturePi() {
  const sent = [];
  const handlers = new Map();
  return {
    sent,
    handlers,
    on(event, handler) {
      handlers.set(event, handler);
    },
    sendMessage(params, options) {
      sent.push({ params, options });
    },
  };
}

/** Joined text of the single captured whisper (envelope included). */
function deliveredText(pi) {
  assert.equal(pi.sent.length, 1, `expected exactly 1 delivered whisper, got ${pi.sent.length}`);
  return pi.sent[0].params.content.map((c) => c.text ?? "").join("\n");
}

/** Unique non-periodic filler: chunk-k tokens are lexicographically unique. */
function chunkFiller(count, pad = 6) {
  return Array.from({ length: count }, (_, i) => `chunk-${String(i).padStart(pad, "0")}`).join(" ");
}

function makeEpisode(overrides = {}) {
  return {
    id: "ep-test-1",
    task: "short task",
    solution: "short solution",
    outcome: "success",
    similarity: 0.9,
    timestamp: Date.now(),
    toolSequence: [],
    tags: [],
    project: "agents/pi-braid",
    sessionId: "session-whisper-render-test",
    ...overrides,
  };
}

// ── (a) Long solution: 600-char render + ellipsis + id handle ────────────────
test("(a) long solution (>600): first 600 chars render, ellipsis, id handle, no leak", () => {
  beginTurn();
  clearAllBuckets();
  const solution = chunkFiller(50); // 50 * 12 + 49 spaces = 649 chars
  assert.ok(solution.length > 600, "fixture solution must exceed the 600-char cap");
  const ep = makeEpisode({ id: "ep-test-long-solution", solution });
  const state = createMemoryStoresState();
  const pi = makeCapturePi();

  whisperRecall(state, {}, pi, "Past solution might apply:", [ep], "agents/pi-braid");

  const text = deliveredText(pi);
  assert.ok(
    text.includes(`    Solution: ${solution.slice(0, 600)}…`),
    "solution line must start with the full first 600 chars and end with an ellipsis",
  );
  assert.ok(
    text.includes("(id: ep-test-long-solution — memory recall_get for full text)"),
    "truncated episode must carry the retrieval handle with its id",
  );
  assert.ok(!text.includes("chunk-000046"), "content beyond the 600-char cap must not leak");
  assert.ok(text.includes("chunk-000045"), "the last fully-visible chunk (pre-cap) must render");
});

// ── (b) Cross-recall: 300-char semantic render + ellipsis + id (worst site) ──
await testAsync(
  "(b) cross-recall semantic whisper: 300 chars + ellipsis + id, no leak",
  async () => {
    const hadSemanticFile = existsSync(SEMANTIC_MEMORY_FILE);
    const semanticBackup = hadSemanticFile ? readFileSync(SEMANTIC_MEMORY_FILE) : null;
    const originalCm = getCognitiveMemoryInstance();
    try {
      // Inject a fresh singleton with a seeded in-memory store (no store()
      // call, so no pre-restore disk writes). recall() will still persist the
      // store once — restored from the snapshot below.
      const cm = new CognitiveMemory(); // intentionally NOT init()-ed from disk
      const content = `file_read task pattern insight: ${chunkFiller(50)}`; // > 300 chars
      cm.getMemoryStore().memories.push({
        id: "sem-test-long-semantic",
        content,
        type: "semantic",
        tags: [],
        timestamp: Date.now(),
        accessCount: 0,
        lastAccessed: Date.now(),
        importance: 0.9,
        utility: 0.9,
      });
      setCognitiveMemoryInstance(cm);

      const ctx = {
        cwd: "/tmp/projects/agents/pi-braid",
        sessionManager: {
          getSessionFile: () => "session-whisper-render-test.jsonl",
          getSessionId: () => "session-whisper-render-test",
        },
      };
      // Pre-create state so the turn_end gate conditions pass:
      // >= 3 tools, cooldowns elapsed, no prior semantic dedup hashes.
      const state = getState(ctx);
      state.currentSessionTools = ["read", "read", "read"];
      state.lastRecallTime = 0;
      state.lastSemanticRecallTime = 0;
      state.lastSemanticRecallHashes = [];

      const pi = makeCapturePi();
      threeMemoryStoresExtension(pi);
      const turnEnd = pi.handlers.get("turn_end");
      assert.ok(turnEnd, "extension must register a turn_end handler");

      beginTurn();
      await turnEnd({}, ctx);

      const text = deliveredText(pi);
      assert.ok(text.includes("Related memory:"), "cross-recall title line must render");
      // Query is "file_read task pattern" (3 read tools, no recent errors);
      // the seeded content contains all three words so relevance clears the
      // > 1.5 filter gate.
      assert.ok(
        text.includes(`  [semantic] ${content.slice(0, 300)}`),
        "semantic entry must render its type tag and first 300 chars",
      );
      assert.ok(
        text.includes(`${content.slice(0, 300)}… (id: sem-test-long-semantic)`),
        "truncated semantic entry must end with ellipsis and carry the id handle",
      );
      assert.ok(!text.includes("chunk-000025"), "content beyond the 300-char cap must not leak");
      assert.ok(
        text.includes("chunk-000019"),
        "the last fully-visible chunk (pre-cap) must render",
      );
    } finally {
      setCognitiveMemoryInstance(originalCm);
      if (semanticBackup) {
        writeFileSync(SEMANTIC_MEMORY_FILE, semanticBackup);
      } else {
        try {
          unlinkSync(SEMANTIC_MEMORY_FILE);
        } catch {
          /* nothing to clean up */
        }
      }
    }
  },
);

// ── (c) Short episode: no ellipsis, no id line (no noise) ────────────────────
test("(c) short episode: no ellipsis and no id handle", () => {
  beginTurn();
  clearAllBuckets();
  const ep = makeEpisode({
    id: "ep-test-short",
    task: "fix flaky checkout test",
    solution: "rerun with isolated fixtures",
  });
  const state = createMemoryStoresState();
  const pi = makeCapturePi();

  whisperRecall(state, {}, pi, "Past solution might apply:", [ep], "agents/pi-braid");

  const text = deliveredText(pi);
  assert.ok(!text.includes("…"), "no ellipsis when nothing was truncated");
  assert.ok(!text.includes("(id:"), "no retrieval handle when nothing was truncated");
  assert.ok(
    text.includes("    Solution: rerun with isolated fixtures"),
    "full short solution must render unmodified",
  );
});

// ── (d) Marks preserved: [CROSS-SESSION] + conf% render as before ────────────
test("(d) cross-session marks and confidence preserved (compat lock)", () => {
  beginTurn();
  clearAllBuckets();
  const ep = makeEpisode({
    id: "ep-test-cross-session",
    task: "fix the zorblaxflux import cycle",
    solution: "invert the dependency and extract a shared module",
    _crossSession: true,
    memoryConfidence: 0.87,
    similarity: 0.9,
    sessionId: "session-other",
  });
  const state = createMemoryStoresState();
  // Prefill to skip the contamination emitSignal path (out of scope here);
  // the [CROSS-SESSION] render mark is independent of that signal.
  state.recentErrors = new Array(10).fill("bash:command_execution");
  const pi = makeCapturePi();

  whisperRecall(state, {}, pi, "Past solution might apply:", [ep], "agents/pi-braid");

  const text = deliveredText(pi);
  assert.ok(
    text.includes("[ok] [CROSS-SESSION] (conf 87%) fix the zorblaxflux import cycle"),
    "icon + [CROSS-SESSION] + conf% + task line must render unchanged",
  );
  assert.ok(!text.includes("(id:"), "short fields still render without the id line");
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("=== Three-mem whisper render tests passed ===");
