/**
 * Single-Ownership Enforcer
 *
 * Detects hardcoded raw strings that should use shared constants.
 * Run as part of the test suite to prevent knowledge drift.
 *
 * Principles:
 *   - Every event name string used with pi.on() or onEvent() should
 *     import from lib/core/event-names.ts
 *
 * This is a structural invariant test - it fails if the pattern is violated.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

const USES_EVENT_NAMES = "lib/core/event-names.ts";

const ALLOWED_FILES = new Set([
  USES_EVENT_NAMES,
  "lib/events/event-types.ts",
  "lib/events/turn-end-coordinator.ts",
  "lib/state/extension-state.ts",
]);

const EVENT_NAMES = [
  "session_start",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_shutdown",
  "agent_end",
  "input",
  "turn_end",
  "turn_complete",
  "tool_call",
  "message_end",
  "tool_execution_start",
  "tool_execution_end",
  "session_tree",
  "extension_ui_request",
  "resources_discover",
  "nudge",
  "signal",
  "turn_analytics",
  "memory_store",
  "memory_recall",
];

function scanForRawEventStrings(filePath, relativePath) {
  const src = readFileSync(filePath, "utf-8");
  const lines = src.split("\n");
  const violations = [];

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed === "") continue;

    for (const evt of EVENT_NAMES) {
      const piOnPattern = new RegExp(`pi\\.on\\(.*["']${evt}["']`);
      const onEventPattern = new RegExp(`onEvent\\(.*["']${evt}["']`);
      const registerPattern = new RegExp(`registerTurnEndHandler\\(.*["']${evt}["']`);
      const handlerRegistryPattern = new RegExp(`event:\\s*["']${evt}["']`);

      if (
        piOnPattern.test(trimmed) ||
        onEventPattern.test(trimmed) ||
        registerPattern.test(trimmed) ||
        handlerRegistryPattern.test(trimmed)
      ) {
        violations.push({ file: relativePath, line: i + 1, raw: `"${evt}"` });
      }
    }
  }

  return violations;
}

function walk(dir, base) {
  const files = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const rel = join(base, entry);
    if (statSync(full).isDirectory()) {
      if (entry === "node_modules" || entry.startsWith(".")) continue;
      files.push(...walk(full, rel));
    } else if (entry.endsWith(".ts")) {
      files.push(rel);
    }
  }
  return files;
}

const allFiles = walk(ROOT, "");
const violations = [];

for (const file of allFiles) {
  if (ALLOWED_FILES.has(file)) continue;
  const filePath = join(ROOT, file);
  violations.push(...scanForRawEventStrings(filePath, file));
}

if (violations.length > 0) {
  console.log(
    `\n\u26a0\ufe0f  ${violations.length} raw event string(s) found in non-constant files:\n`,
  );
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}  ${v.raw}`);
  }
  console.log(`\nUse constants from ${USES_EVENT_NAMES} instead of raw strings.\n`);
  process.exit(1);
}

console.log("\u2705 No raw event string violations found.");
