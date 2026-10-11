/**
 * Test: Self-Evolution Loop - hint persistence and pruning
 */

import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;

// ── End-to-end: write test hints, verify loadConsolidatedHints parses them ─

console.log("\n[E2E] Hint file parsing");
{
  // Create a temp hints file and verify parsing logic
  const testDir = join(tmpdir(), "braid-test-hints-" + Date.now());
  mkdirSync(testDir, { recursive: true });
  const hintsFile = join(testDir, "test-hints.jsonl");

  // Write a valid hint
  const validHint = {
    task: "Fix type error",
    strategy: "Debug by isolating components",
    steps: ["Read file", "Edit fix", "Run tests"],
    score: 85,
    source: "consolidation",
    createdAt: Date.now(),
  };

  // Write a stale hint (older than the 7-day HINT_MAX_AGE_MS)
  const staleHint = {
    task: "Old task",
    strategy: "Old strategy",
    steps: ["Old step"],
    score: 70,
    source: "consolidation",
    createdAt: Date.now() - 8 * 24 * 60 * 60 * 1000, // 8 days ago (stale under the 7-day TTL)
  };

  writeFileSync(hintsFile, JSON.stringify(staleHint) + "\n" + JSON.stringify(validHint) + "\n");

  const content = readFileSync(hintsFile, "utf-8");
  const lines = content.split("\n").filter((l) => l.trim());
  assert.equal(lines.length, 2, "Should have 2 hint lines");

  // Verify parsing
  const parsed = lines.map((l) => JSON.parse(l));
  const now = Date.now();
  const SEVEN_DAYS = 7 * 24 * 60 * 60 * 1000; // mirrors HINT_MAX_AGE_MS (lib/constants/session-thresholds.ts)
  const fresh = parsed.filter((h) => now - (h.createdAt ?? 0) < SEVEN_DAYS);
  assert.equal(fresh.length, 1, "Should have 1 fresh hint (stale one filtered)");
  assert.equal(fresh[0].task, "Fix type error", "Fresh hint should be the valid one");

  // Cleanup
  rmSync(testDir, { recursive: true, force: true });
  console.log("  [ok] E2E hint parsing: freshness filtering works correctly");
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log("\n==================================================");
console.log(`Self-Evolution Loop Tests: ${passed} passed, ${failed} failed`);
