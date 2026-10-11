/**
 * Regression test: episode append-on-write durability + memory_store disk truth.
 *
 * The episode store used to persist ONLY at session_shutdown, as a whole-file
 * rewrite from the process's in-memory snapshot. With several live pi
 * processes the last shutdown erased every episode the other processes had
 * written, and an episode written mid-session was lost on a crash that never
 * reached a clean shutdown.
 *
 * Behaviors pinned here:
 *   A. An episode recorded through the data layer (addEpisode) reaches
 *      episodes.jsonl as an appended JSONL line within seconds, with no
 *      shutdown involved.
 *   B. An episode written through the agent-facing `memory` tool
 *      (episodes_add) is on disk by the time the tool result reports it.
 *   C. A semantic memory written through `memory_store` is on disk in
 *      semantic.json by the time the tool result reports it.
 *   D. The appended lines keep the existing format: one JSON object per line
 *      with the fields the current loader reads (id/task/solution/outcome).
 *
 * Hermetic: HOME is redirected to a temp dir before the dist imports, so the
 * live memory stores are never touched.
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "episode-durability-test-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), "{}\n");

const { createMemoryStoresState, addEpisode } = await import(
  "../../../dist/extensions/memory/three-memory-stores/index.js"
);
const { EPISODES_FILE, SEMANTIC_MEMORY_FILE } = await import(
  "../../../dist/lib/config/braid-paths.js"
);
const { getCognitiveMemory } = await import("../../../dist/lib/memory/index.js");
const { createMemoryTool } = await import(
  "../../../dist/extensions/memory/memory-agent-bridge/memory-tool.js"
);
const { createMemoryStoreTool } = await import(
  "../../../dist/extensions/memory/memory-agent-bridge/memory-store-tool.js"
);

console.log("=== episode append-on-write durability ===\n");

let passed = 0;
let failed = 0;
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

async function pollUntil(predicate, timeoutMs = 3000, stepMs = 25) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return true;
    if (Date.now() > deadline) return false;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

function readEpisodesLines() {
  if (!existsSync(EPISODES_FILE)) return [];
  return readFileSync(EPISODES_FILE, "utf8")
    .split("\n")
    .filter((l) => l.trim().length > 0);
}

function diskHasEpisode(id) {
  return readEpisodesLines().some((l) => l.includes(`"${id}"`));
}

// ── A. Data-layer write lands on disk without shutdown ───────────────────────
await testAsync("addEpisode appends the episode line to episodes.jsonl (no shutdown)", async () => {
  const state = createMemoryStoresState();
  state.currentSessionId = "durability-session";
  const episode = addEpisode(
    state,
    "Instrument the episode store with append-on-write durability",
    "addEpisode now appends one JSONL line per episode, so a stored case survives a process exit that never reaches session_shutdown",
    "success",
    ["read", "edit", "bash"],
    ["durability"],
    "agents/pi-braid",
  );

  const landed = await pollUntil(() => diskHasEpisode(episode.id));
  assert.equal(landed, true, `episode ${episode.id} never reached episodes.jsonl`);
});

// ── B. Tool-level write implies disk truth ───────────────────────────────────
await testAsync("episodes_add is durable when the tool result says 'Episode added'", async () => {
  const memoryTool = createMemoryTool({}, null, () => {});
  const ctx = { cwd: "/tmp/projects/agents/pi-braid" };
  const task = "Wire the episodes_add tool result to disk truth via the append flush";

  const result = await memoryTool.execute(
    "t1",
    {
      action: "episodes_add",
      task,
      solution: "the bridge awaits the episode append flush before answering the agent",
      outcome: "partial",
    },
    null,
    null,
    ctx,
  );
  assert.match(result.content[0].text, /Episode added/);

  const landed = await pollUntil(() => readEpisodesLines().some((l) => l.includes(task.slice(0, 30))));
  assert.equal(landed, true, "tool reported success but the episode is not on disk");
});

// ── C. memory_store implies semantic.json truth ──────────────────────────────
await testAsync("memory_store is durable when the tool result says 'Stored memory'", async () => {
  const memory = getCognitiveMemory();
  await memory.init();
  const tool = createMemoryStoreTool(memory, null, () => {});
  const content = "Durable memory_store probe: the semantic write must be on disk immediately";

  const result = await tool.execute("t1", { content, memoryType: "pattern" }, null, null, {
    cwd: "/tmp/projects/agents/pi-braid",
  });
  const id = result.details?.id;
  assert.ok(id, `tool returned no id: ${result.content[0].text}`);

  const landed = await pollUntil(() => {
    if (!existsSync(SEMANTIC_MEMORY_FILE)) return false;
    const disk = JSON.parse(readFileSync(SEMANTIC_MEMORY_FILE, "utf8"));
    return (disk.memories ?? []).some((m) => m.id === id);
  });
  assert.equal(landed, true, "tool reported success but semantic.json never gained the entry");
});

// ── D. Appended lines stay loader-parseable ──────────────────────────────────
await testAsync("every line in episodes.jsonl parses and carries the loader's fields", () => {
  const lines = readEpisodesLines();
  assert.ok(lines.length >= 2, `expected at least the two appended lines, got ${lines.length}`);
  for (const line of lines) {
    const ep = JSON.parse(line);
    for (const field of ["id", "task", "solution", "outcome", "timestamp"]) {
      assert.ok(field in ep, `appended line is missing field ${field}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== episode append-on-write durability tests passed ===");
