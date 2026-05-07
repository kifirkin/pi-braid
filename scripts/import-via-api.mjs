/**
 * Import legacy memories.json using CognitiveMemory.store() API.
 *
 * Uses the official cognitive-memory API instead of raw file writes.
 * Each memory goes through the full store pipeline: dedup (shouldStore),
 * type validation, auto-tag generation, consolidation on completion.
 * This guarantees compatibility with consolidation/prune operations.
 *
 * Usage: node scripts/import-via-api.mjs
 */

const { existsSync, readFileSync } = require("node:fs");
const { homedir } = require("node:os");
const { join } = require("node:path");

const MEMORY_DIR = join(homedir(), ".pi", "memory");
const SOURCE = join(MEMORY_DIR, "memories.json");

// ── Type inference from tags (same logic as import-legacy-memories.mjs) ───────

function inferType(tags) {
  const lower = new Set(tags.map((t) => t.toLowerCase()));
  if (lower.has("pattern")) return "pattern";
  if (lower.has("error") || lower.has("bug") || lower.has("bug-fix") || lower.has("bugfix")) return "error";
  if (lower.has("insight") || lower.has("lesson")) return "insight";
  if (lower.has("goal") || lower.has("feature")) return "goal";
  if (lower.has("preference")) return "preference";
  if (lower.has("episodic") || lower.has("session") || lower.has("session-analysis")) return "episodic";
  if (lower.has("semantic")) return "semantic";
  if (lower.has("procedural") || lower.has("workflow") || lower.has("onboarding")) return "procedural";
  return "insight";
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  // Read source
  if (!existsSync(SOURCE)) {
    console.error("Source not found:", SOURCE);
    process.exit(1);
  }
  const source = JSON.parse(readFileSync(SOURCE, "utf-8"));
  const rawMemories = source.memories || [];
  console.log(`Source: ${rawMemories.length} memories`);

  // Import cognitive-memory (reads current memory.json on init)
  const { getCognitiveMemory } = await import(
    join(process.cwd(), "dist/lib/cognitive-memory/index.js")
  );
  const cm = getCognitiveMemory();
  await cm.init();

  // Before: check current count
  const { loadMemory } = await import(
    join(process.cwd(), "dist/lib/cognitive-memory/storage.js")
  );
  let before = await loadMemory();
  console.log(`Before import: ${before.memories.length} memories in store`);
  console.log(`Consolidation: turn ${before.turnCount}`);

  // Import each memory through the store() API
  let imported = 0;
  let skipped = 0;

  for (const m of rawMemories) {
    const type = inferType(m.tags || []);

    try {
      await cm.store(
        m.content,
        type,
        {
          tags: m.tags || [],
          source: "legacy-import",
          importance: type === "error" ? 0.7 :
                      type === "pattern" ? 0.6 :
                      type === "goal" ? 0.5 : 0.5,
        },
      );
      imported++;
    } catch (e) {
      // shouldStore() rejects duplicates
      skipped++;
      if (e.message && !e.message.includes("Duplicate")) {
        console.error(`  Error on entry: ${e.message}`);
      }
    }

    if (imported % 50 === 0) {
      console.log(`  Progress: ${imported} imported, ${skipped} skipped`);
    }
  }

  // After: check result
  let after = await loadMemory();
  console.log(`\n=== Import Complete ===`);
  console.log(`Imported: ${imported}`);
  console.log(`Skipped:  ${skipped} (duplicates or low utility)`);
  console.log(`Store now has: ${after.memories.length} memories`);
}

main().catch((e) => {
  console.error("Import failed:", e);
  process.exit(1);
});
