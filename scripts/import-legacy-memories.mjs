/**
 * Import legacy memories.json into cognitive-memory memory.json
 *
 * Transforms old format `{ id, content, timestamp, tags }` → CognitiveMemoryEntry
 * `{ id, content, type, tags, timestamp, accessCount, lastAccessed, source, importance, utility }`
 *
 * Usage: node scripts/import-legacy-memories.mjs [--dry-run]
 *
 * The current memory.json is empty (0 entries) so this is a pure insert.
 * Backups are created automatically.
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MEMORY_DIR = join(homedir(), ".pi", "memory");
const SOURCE = join(MEMORY_DIR, "memories.json");
const TARGET = join(MEMORY_DIR, "memory.json");

// ── Type inference from tags ──────────────────────────────────────────────────

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
  return "insight"; // safe default — most legacy entries were insights
}

// ── Content fingerprint (short hash for dedup) ────────────────────────────────

function shortHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h) + str.charCodeAt(i);
    h |= 0;
  }
  return Math.abs(h).toString(36).substring(0, 6);
}

// ── Main ──────────────────────────────────────────────────────────────────────

const isDryRun = process.argv.includes("--dry-run");

// Read source
if (!existsSync(SOURCE)) {
  console.error("Source not found:", SOURCE);
  process.exit(1);
}
const source = JSON.parse(readFileSync(SOURCE, "utf-8"));
const rawMemories = source.memories || [];
console.log(`Source: ${rawMemories.length} memories in ${SOURCE}`);

// Read target (will be empty — just verifying)
const targetRaw = existsSync(TARGET) ? readFileSync(TARGET, "utf-8") : "{}";
let target;
try {
  target = JSON.parse(targetRaw);
} catch {
  target = { version: 1, memories: [], lastConsolidation: 0, turnCount: 0 };
}
console.log(`Target: ${target.memories?.length ?? 0} memories in ${TARGET}`);

// Check for existing IDs (dedup)
const existingIds = new Set((target.memories || []).map((m) => m.id));
const existingFingerprints = new Set(
  (target.memories || []).map((m) => shortHash(m.content)),
);

// Transform
const imported = [];
const skipped = [];
const now = Date.now();

for (const m of rawMemories) {
  const id = m.id || `legacy-${shortHash(m.content)}-${Date.now()}`;

  if (existingIds.has(id)) {
    skipped.push({ id, reason: "duplicate id" });
    continue;
  }

  const fingerprint = shortHash(m.content);
  if (existingFingerprints.has(fingerprint)) {
    skipped.push({ id, reason: "duplicate content (same fingerprint)" });
    continue;
  }

  const type = inferType(m.tags || []);
  const ts = m.timestamp || now;

  imported.push({
    id,
    content: m.content,
    type,
    tags: m.tags || [],
    timestamp: ts,
    accessCount: 0,
    lastAccessed: ts,
    source: "legacy-import",
    importance: type === "error" ? 0.7 : type === "pattern" ? 0.6 : type === "goal" ? 0.5 : 0.5,
    utility: 0.5,
  });
}

// Summary
const typeCounts = {};
for (const m of imported) {
  typeCounts[m.type] = (typeCounts[m.type] || 0) + 1;
}

console.log(`\n=== Import Summary ===`);
console.log(`Importing: ${imported.length} memories`);
console.log(`Skipped:   ${skipped.length} (duplicates)`);
for (const [t, c] of Object.entries(typeCounts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${t}: ${c}`);
}

if (isDryRun) {
  console.log(`\n[Dry run] No files written. Add --dry-run to confirm.`);
  process.exit(0);
}

// Write backup
const backupPath = `${TARGET}.backup.${Date.now()}`;
copyFileSync(TARGET, backupPath);
console.log(`\nBackup: ${backupPath}`);

// Merge and write
const merged = {
  version: 1,
  memories: [...(target.memories || []), ...imported],
  lastConsolidation: target.lastConsolidation || 0,
  turnCount: target.turnCount || 0,
};

writeFileSync(TARGET, JSON.stringify(merged, null, 2));
console.log(`Written: ${merged.memories.length} memories to ${TARGET}`);
console.log(`  ${target.memories?.length ?? 0} existing + ${imported.length} imported`);
console.log("\n✅ Import complete. Run `npm run test` to verify.");
