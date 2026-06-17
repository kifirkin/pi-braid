/**
 * Test: No raw console.* calls in src/ (only via the logger).
 *
 * Locks the WHISPER-AND-LOGGING-AUDIT finding that raw console.* calls
 * corrupt the TUI rendering. The logger (lib/core/logger.ts) is the only
 * sanctioned output channel. Tests and scripts are exempt.
 *
 * This test scans src/ for `console.log|warn|error|info|debug` calls and
 * asserts none appear outside the logger module and test files.
 *
 * See: docs/WHISPER-AND-LOGGING-AUDIT.md, src/lib/core/logger.ts.
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

// Only the logger module is allowed to call console.* directly.
// All other modules must use log.info/warn/error/debug from createLogger.
const ALLOWED_FILES = new Set([
  "src/lib/core/logger.ts",
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
    // Skip comments
    if (line.trim().startsWith("//") || line.trim().startsWith("*")) continue;
    // Match console.{log,info,warn,error,debug,trace}(
    if (!/\bconsole\.(log|info|warn|error|debug|trace)\s*\(/.test(line)) continue;

    violations.push({ file: rel, line: i + 1, text: line.trim() });
  }
}

if (violations.length > 0) {
  console.log("\n✗ Raw `console.*` calls found outside logger module:\n");
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}: ${v.text}`);
  }
  console.log(`\n  ${violations.length} violation(s) in ${scanned} files scanned.`);
  console.log("  Fix: import log from lib/core/logger.ts and use log.info/warn/error/debug.");
  console.log("  The logger routes through ctx.ui.notify (TUI-safe) when a session is bound.\n");
  process.exit(1);
}

console.log(`✓ No raw console.* calls outside logger. (${scanned} files scanned)`);
