/**
 * Test: No direct calls to pi.sendMessage() outside the injection tracker.
 *
 * Locks the WHISPER-AND-LOGGING-AUDIT finding that sendTrackedMessage
 * is the only correct path for messages the agent will read on its next turn.
 * The flood-cap, dedup, and tiered-tracking logic lives in
 * lib/utils/injection-tracker.ts. Bypassing it loses all of that.
 *
 * This test scans src/ for `pi.sendMessage(` calls and asserts the only
 * occurrences are in the injection-tracker module itself.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(ROOT, "src");

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist") continue;
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

// Only the injection tracker should call pi.sendMessage directly.
// All other sites must use sendTrackedMessage(pi, params, options, meta, bypass?).
const ALLOWED_FILES = new Set([
  "src/lib/utils/injection-tracker.ts",
]);

const violations = [];
let scanned = 0;

for (const file of walk(SRC)) {
  scanned++;
  const rel = file.replace(ROOT + "/", "");
  if (ALLOWED_FILES.has(rel)) continue;

  const src = readFileSync(file, "utf-8");
  const lines = src.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match pi.sendMessage( but not sendTrackedMessage.
    // Allow comments.
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    if (!/\bpi\.sendMessage\s*\(/.test(line)) continue;
    if (/\bsendTrackedMessage\s*\(/.test(line)) continue; // false positive

    violations.push({ file: rel, line: i + 1, text: line.trim() });
  }
}

if (violations.length > 0) {
  console.log("\n[x] Direct `pi.sendMessage(` calls found outside injection-tracker:\n");
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}: ${v.text}`);
  }
  console.log(`\n  ${violations.length} violation(s) in ${scanned} files scanned.`);
  console.log("  Fix: use sendTrackedMessage(pi, params, options, meta, bypassFloodCap?).");
  console.log("  This ensures flood capping, dedup, and tiered tracking apply.\n");
  process.exit(1);
}

console.log(`[v] No direct pi.sendMessage() calls outside injection-tracker. (${scanned} files scanned)`);
