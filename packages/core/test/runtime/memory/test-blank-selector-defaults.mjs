/**
 * Fixture: a blank optional selector means "absent" for the `memory` read
 * actions and a blank required content is refused by name for `memory_store`.
 *
 * A client that emits every schema key sends "" for the keys it does not use.
 * Framework validation (`validateToolArguments`) converts "" to 0 for
 * `Type.Optional(Type.Number())` and the converted value passes, so a handler
 * cannot tell a blank from a typed 0. Before the fix:
 *   - the `memory` read actions passed the converted 0 through as a real
 *     limit, and `slice(0, 0)` answered a blank-limit recall with zero rows -
 *     read by the agent as "no memory";
 *   - `memory_store` accepted blank content: the store gate rejects it as
 *     "Duplicate or low-utility content" for most types and exempts
 *     error/goal, so a blank landed as a real memory.
 *
 * After the fix a blank limit is read as absent (the documented default
 * applies) and a blank content is refused by name before the store call.
 * Controls keep the fix from becoming a blanket default or a blanket refusal:
 * a real limit still caps the rows, and real content still stores.
 *
 * Run: node test/runtime/memory/test-blank-selector-defaults.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Hermetic: HOME is redirected before the dist imports so the write-gate
// settings and the store paths resolve into a throwaway tree.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "blank-selector-defaults-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), "{}\n");

const { createMemoryTool } = await import(
  "../../../dist/extensions/memory/memory-agent-bridge/memory-tool.js"
);
const { createMemoryStoreTool } = await import(
  "../../../dist/extensions/memory/memory-agent-bridge/memory-store-tool.js"
);
const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");

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

const ctx = {
  cwd: "/tmp/projects/agents/pi-braid",
  sessionManager: { getSessionId: () => "blank-selector-defaults-fixture" },
};

/**
 * Drive raw arguments through the framework's own validation/conversion,
 * exactly as pi-core does before a handler runs.
 */
function validated(tool, raw) {
  return validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    { name: tool.name, arguments: raw },
  );
}

// ── the memory read actions ────────────────────────────────────────────────

function memoryRows(n) {
  return Array.from({ length: n }, (_, i) => ({
    memory: {
      id: `mem_${i + 1}`,
      type: "insight",
      tags: [],
      utility: 0.5,
      timestamp: Date.now(),
      accessCount: 1,
      content: `row ${i + 1}`,
    },
    relevance: 0.5,
  }));
}

function memoryEntries(n) {
  return Array.from({ length: n }, (_, i) => ({
    id: `mem_${i + 1}`,
    content: `entry ${i + 1}`,
    type: "insight",
    tags: [],
    timestamp: Date.now(),
    utility: 0.5,
    accessCount: 1,
  }));
}

let recallOptions;
let getAllArg;
const memory = {
  recall: async (_query, options) => {
    recallOptions = options;
    return memoryRows(7);
  },
  getAll: (limit = 20) => {
    getAllArg = limit;
    return memoryEntries(30).slice(0, limit);
  },
};
const memoryTool = createMemoryTool(memory, null, () => {});

console.log("=== memory reads: blank selectors read as absent ===\n");

await test("recall_search with a blank limit renders the documented 5 rows", async () => {
  recallOptions = undefined;
  const args = await validated(memoryTool, {
    action: "recall_search",
    query: "blank selector",
    limit: "",
  });
  assert.equal(args.limit, 0, "the framework converts the blank limit to 0 (tested path)");
  const result = await memoryTool.execute("m1", args, null, null, ctx);
  assert.equal(recallOptions.limit, undefined, "the library sees the limit as absent");
  const text = result.content[0].text;
  assert.match(text, /Found 7 semantic memories:/);
  const listed = text.split("\n").filter((l) => l.startsWith("  [insight] "));
  assert.equal(listed.length, 5, `expected the documented 5 rows, got ${listed.length}`);
});

await test("recall_search control: a real limit still caps the rows", async () => {
  recallOptions = undefined;
  const args = await validated(memoryTool, {
    action: "recall_search",
    query: "blank selector",
    limit: 2,
  });
  assert.equal(args.limit, 2);
  const result = await memoryTool.execute("m2", args, null, null, ctx);
  assert.equal(recallOptions.limit, 2, "a real limit reaches the library");
  const listed = result.content[0].text.split("\n").filter((l) => l.startsWith("  [insight] "));
  assert.equal(listed.length, 2);
});

await test("recall_list with a blank limit asks the library for the documented 20", async () => {
  getAllArg = undefined;
  const args = await validated(memoryTool, { action: "recall_list", limit: "" });
  assert.equal(args.limit, 0, "the framework converts the blank limit to 0 (tested path)");
  const result = await memoryTool.execute("m3", args, null, null, ctx);
  assert.equal(getAllArg, 20, "the library default stands, not a zero-row read");
  assert.equal(result.details.memories.length, 20);
});

await test("recall_list control: a real limit still caps the list", async () => {
  getAllArg = undefined;
  const args = await validated(memoryTool, { action: "recall_list", limit: 3 });
  const result = await memoryTool.execute("m4", args, null, null, ctx);
  assert.equal(getAllArg, 3);
  assert.equal(result.details.memories.length, 3);
});

// ── memory_store's required content ────────────────────────────────────────

const storeCalls = [];
const storeMemory = {
  store: async (content, type, options) => {
    storeCalls.push({ content, type, options });
    return { id: "mem_store_1" };
  },
  findCrossProjectConflicts: () => [],
};
const storeTool = createMemoryStoreTool(storeMemory, null, () => {});

console.log("\n=== memory_store: a blank content is refused by name ===\n");

await test("blank content for an exempt type (error) is refused, not stored", async () => {
  storeCalls.length = 0;
  const args = await validated(storeTool, { content: "", memoryType: "error" });
  assert.equal(args.content, "", "a blank string reaches the handler unchanged");
  const result = await storeTool.execute("s1", args, null, null, ctx);
  assert.equal(storeCalls.length, 0, "nothing was written");
  assert.equal(result.details.stored, false);
  assert.match(result.content[0].text, /memory_store requires non-empty 'content'/);
});

await test("blank content for a gated type (insight) is refused by name, not as a duplicate", async () => {
  storeCalls.length = 0;
  const args = await validated(storeTool, { content: "", memoryType: "insight" });
  const result = await storeTool.execute("s2", args, null, null, ctx);
  assert.equal(storeCalls.length, 0, "nothing was written");
  assert.match(result.content[0].text, /memory_store requires non-empty 'content'/);
  assert.doesNotMatch(
    result.content[0].text,
    /Duplicate or low-utility/,
    "the refusal names the field, not a gate verdict",
  );
});

await test("memory_store control: real content still stores", async () => {
  storeCalls.length = 0;
  const args = await validated(storeTool, {
    content: "A blank selector arrives as 0; read it as absent",
    memoryType: "insight",
  });
  const result = await storeTool.execute("s3", args, null, null, ctx);
  assert.equal(storeCalls.length, 1, "real content reaches the store");
  assert.equal(result.details.stored, true);
  assert.match(result.content[0].text, /Stored memory mem_store_1/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== blank-selector default fixture passed ===");
