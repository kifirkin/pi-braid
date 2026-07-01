/**
 * Test: No direct ctx.whisper usage in heartbeat-scheduler modules.
 *
 * Locks the v1.7/v1.8 migration of CognitiveModule implementations to use
 * the ModuleContext.whisper() method (not context.ctx.whisper?.()).
 *
 * Background (ROADMAP P0-1 / DR-C-1):
 *   The heartbeat tick handler aggregates all module whispers via
 *   ModuleContext.whisper() into a per-tick buffer and flushes via
 *   sendTrackedMessage -- honoring the per-source flood cap and
 *   injection tracking. Calling ctx.whisper directly bypasses the
 *   cap and tracking.
 *
 *   The v1.8 commit (e134bff9) migrated 6 modules from
 *   context.ctx.whisper?.() to context.whisper(). This test would
 *   have caught the v1.8 regression in test-dreamer.mjs (test mock
 *   hadn't been updated to provide a top-level whisper on the
 *   ModuleContext wrapper).
 *
 * Scope: only the cognitive modules in
 *   src/extensions/heartbeat/heartbeat-scheduler/modules/*.ts.
 *   Other sites that need to whisper (e.g. the parent
 *   heartbeat-scheduler policy engine, topic-drift, turn-end-handler)
 *   use sendTrackedMessage, which is its own pattern and not
 *   covered here.
 *
 * Allowed: comment lines (// or *) only.
 * Flagged: any non-comment line matching ctx.whisper( or
 *   ?.ctx.whisper( in the modules directory.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MODULES_DIR = join(
  ROOT,
  "src/extensions/heartbeat/heartbeat-scheduler/modules",
);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

const violations = [];
let scanned = 0;

for (const file of walk(MODULES_DIR)) {
  scanned++;
  const rel = file.replace(ROOT + "/", "");
  const src = readFileSync(file, "utf-8");
  const lines = src.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Allow comments and docblock lines.
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    // Allow empty lines (caught by trimmed === "" but no .whisper on them).
    if (trimmed === "") continue;

    // The forbidden pattern: ctx.whisper( -- direct call to the
    // ExtensionContext whisper method. The right pattern is
    // context.whisper( (the ModuleContext method) which we don't flag.
    if (!/\bctx\.whisper\s*\(/.test(line)) continue;

    violations.push({ file: rel, line: i + 1, text: trimmed });
  }
}

if (violations.length > 0) {
  console.log("\n✗ Direct `ctx.whisper(` calls found in heartbeat-scheduler modules:\n");
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}: ${v.text}`);
  }
  console.log(`\n  ${violations.length} violation(s) in ${scanned} module files scanned.`);
  console.log("  Fix: use `context.whisper(msg, opts)` (the ModuleContext method) instead.");
  console.log("  The module whisper path aggregates into a per-tick buffer and flushes");
  console.log("  via sendTrackedMessage, which honors the per-source flood cap.\n");
  process.exit(1);
}

console.log(
  `✓ No direct ctx.whisper() calls in heartbeat-scheduler modules. (${scanned} files scanned)`,
);
