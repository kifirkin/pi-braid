/**
 * Test: Cognitive Memory — unified memory system (941L across 5 files).
 *
 * Tests structure, exports, types, and key logic via source analysis.
 */

const ROOT = "/Users/kifir/projects/agents/pi-braid";

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

// ── [1] File structure ──────────────────────────────────────────────
console.log("\n[1] Cognitive memory file structure");
{
  const fs = await import("fs");
  const exists = (f) => {
    try { fs.accessSync(f); return true; } catch { return false; }
  };
  assert(exists(`${ROOT}/src/lib/cognitive-memory/index.ts`), "index.ts exists");
  assert(exists(`${ROOT}/src/lib/cognitive-memory/types.ts`), "types.ts exists");
  assert(exists(`${ROOT}/src/lib/cognitive-memory/constants.ts`), "constants.ts exists");
  assert(exists(`${ROOT}/src/lib/cognitive-memory/storage.ts`), "storage.ts exists");
  assert(exists(`${ROOT}/src/lib/cognitive-memory/utils.ts`), "utils.ts exists");
}

// ── [2] Types ──────────────────────────────────────────────────────
console.log("\n[2] Types (types.ts)");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/cognitive-memory/types.ts`, "utf8");

  assert(src.includes("export type CognitiveMemoryType"), "exports CognitiveMemoryType");
  for (const t of ["insight","pattern","preference","goal","error","episodic","semantic","procedural"])
    assert(src.includes(`"${t}"`), `type includes '${t}'`);

  assert(src.includes("export interface CognitiveMemoryEntry"), "exports CognitiveMemoryEntry");
  assert(src.includes("content: string"), "Entry has content");
  assert(src.includes("type: CognitiveMemoryType"), "Entry has type");
  assert(src.includes("tags: string[]"), "Entry has tags");
  assert(src.includes("timestamp: number"), "Entry has timestamp");
  assert(src.includes("importance: number"), "Entry has importance (0-1)");
  assert(src.includes("utility: number"), "Entry has utility");
  assert(src.includes("expiresAt?: number"), "Entry has optional expiresAt");
  assert(src.includes("accessCount: number"), "Entry has accessCount");
  assert(src.includes("lastAccessed: number"), "Entry has lastAccessed");

  assert(src.includes("export interface MemoryContext"), "exports MemoryContext");
  assert(src.includes("files?: string[]"), "MemoryContext has files");
  assert(src.includes("solution?: string"), "MemoryContext has solution");

  assert(src.includes("export interface MemoryLink"), "exports MemoryLink");
  assert(src.includes('"fixes"'), "MemoryLink has fix type");
  assert(src.includes('"related"'), "MemoryLink has related type");
  assert(src.includes('"supersedes"'), "MemoryLink has supersedes type");

  assert(src.includes("export interface CognitiveMemoryStore"), "exports CognitiveMemoryStore");
  assert(src.includes("version: number"), "Store has version");
  assert(src.includes("lastConsolidation: number"), "Store has lastConsolidation");
}

// ── [3] Constants ──────────────────────────────────────────────────
console.log("\n[3] Constants (constants.ts)");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/cognitive-memory/constants.ts`, "utf8");

  assert(src.includes("export const MAX_ENTRIES"), "exports MAX_ENTRIES");
  assert(src.includes("export const MIN_UTILITY_THRESHOLD"), "exports MIN_UTILITY_THRESHOLD");
  assert(src.includes("export const CONSOLIDATION_INTERVAL"), "exports CONSOLIDATION_INTERVAL");
  assert(src.includes("export const CATEGORY_BASE_UTILITY"), "exports CATEGORY_BASE_UTILITY");
  assert(src.includes("export const MEMORY_DIR"), "exports MEMORY_DIR");
  assert(src.includes("export const MEMORY_FILE"), "exports MEMORY_FILE");
  assert(src.includes('"memory.json"'), "memory file = memory.json");
}

// ── [4] Index — class structure and methods ────────────────────────
console.log("\n[4] Index — CognitiveMemory class");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/cognitive-memory/index.ts`, "utf8");

  assert(src.includes("export class CognitiveMemory"), "exports CognitiveMemory class");

  // Core CRUD
  assert(src.includes("async store("), "has store() method");
  assert(src.includes("async recall("), "has recall() method");
  assert(src.includes("searchByTags("), "has searchByTags() method");
  assert(src.includes("async consolidate("), "has consolidate() method");
  assert(src.includes("remove("), "has remove() method");
  assert(src.includes("getStats("), "has getStats() method");

  // Internal logic
  assert(src.includes("shouldStore("), "has shouldStore() guard");

  // Re-exports
  assert(src.includes('CognitiveMemoryType'), "re-exports CognitiveMemoryType");
  assert(src.includes('CognitiveMemoryEntry'), "re-exports CognitiveMemoryEntry");
  assert(src.includes('CognitiveMemoryStore'), "re-exports CognitiveMemoryStore");
  assert(src.includes('formatMemoryTimestamp'), "re-exports formatMemoryTimestamp");
  assert(src.includes('formatMemoryEntry'), "re-exports formatMemoryEntry");
  assert(src.includes('generateAutoTags'), "re-exports generateAutoTags");
}

// ── [5] shouldStore logic ──────────────────────────────────────────
console.log("\n[5] shouldStore logic");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/cognitive-memory/index.ts`, "utf8");

  assert(src.includes('type === "error" || type === "goal"'), "errors and goals always stored");
  assert(src.includes("content.trim().length < 20"), "short content (<20 chars) filtered");
  assert(src.includes("SIMILARITY_THRESHOLD = 0.6"), "duplicate threshold = 0.6");
  assert(src.includes("jaccardSimilarity"), "uses jaccardSimilarity for dedup");
}

// ── [6] TTL, eviction, sort ────────────────────────────────────────
console.log("\n[6] TTL and eviction logic");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/cognitive-memory/index.ts`, "utf8");

  assert(src.includes("expiresAt"), "checks expiresAt for TTL expiration");
  assert(src.includes("MAX_ENTRIES"), "enforces MAX_ENTRIES limit");
  assert(src.includes("b.utility - a.utility"), "sorts by utility descending (highest kept)");
  assert(src.includes("saveMemory("), "persists after mutations");
}

// ── [7] Utils ──────────────────────────────────────────────────────
console.log("\n[7] Utils (utils.ts)");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/cognitive-memory/utils.ts`, "utf8");

  const fns = ["jaccardSimilarity","generateAutoTags","generateId",
    "formatMemoryTimestamp","formatMemoryEntry","parseStructuredContent"];
  for (const fn of fns)
    assert(src.includes(`export function ${fn}`), `exports ${fn}()`);

  // Jaccard formula
  assert(src.includes("intersection / union"), "jaccard = intersection / union");

  // Auto-tags
  assert(src.includes("context.files"), "generateAutoTags uses file context");
  assert(src.includes("context.error"), "generateAutoTags uses error context");
}

// ── [8] Storage ────────────────────────────────────────────────────
console.log("\n[8] Storage (storage.ts)");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/cognitive-memory/storage.ts`, "utf8");

  assert(src.includes("export async function loadMemory"), "exports loadMemory()");
  assert(src.includes("export async function saveMemory"), "exports saveMemory()");
  assert(src.includes("catch (e)"), "has error handling in catch block");
  assert(src.includes("fs.readFile("), "uses async fs I/O");
  assert(src.includes("fileMutationQueue.write("), "uses async file mutation queue for writes");
  assert(src.includes("MEMORY_FILE"), "references MEMORY_FILE constant");
}

// ── [9] Main shim re-export ────────────────────────────────────────
console.log("\n[9] Main shim re-export (cognitive-memory.ts)");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/lib/cognitive-memory.ts`, "utf8");

  assert(src.includes("export { CognitiveMemory"), "re-exports CognitiveMemory class");
}

// ── Report ────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
