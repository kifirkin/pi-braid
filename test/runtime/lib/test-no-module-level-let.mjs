/**
 * Test: No new module-level `let` declarations outside the documented exceptions.
 *
 * Locks Q5 (module-level let migration). The pattern:
 *   - Use getExtensionState(ctx, "key", factory) for per-session state.
 *   - Use global-state.ts getters for process-global state.
 *   - Module-level `let` is banned except for the 29 documented exceptions
 *     (organized in 7 categories A-F: re-entry guards, lazy-load guards,
 *     test injectors, encapsulated global-state, logger config,
 *     session-state mirrors, mutable config). See src/lib/state/AGENTS.md
 *     encapsulated global-state, logger config, session-state mirrors,
 *     tunable config). See src/lib/state/AGENTS.md "Documented exceptions"
 *     table for the full list with justifications.
 *
 * This test scans src/ for `^let ` or `^export let` at module scope and asserts
 * the only matches are the documented exceptions. Test injectors (id.ts) and
 * encapsulated globals-state lets are explicitly allowed.
 *
 * To add a new exception: edit the EXEMPT_LINES set below AND add a row to
 * the "Documented exceptions" table in src/lib/state/AGENTS.md.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const SRC = join(ROOT, "src");

// ── Collect all .ts files in src/ ──────────────────────────────────────────

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (entry === "node_modules" || entry === "dist") continue;
    const st = statSync(full);
    if (st.isDirectory()) yield* walk(full);
    else if (entry.endsWith(".ts")) yield full;
  }
}

// Each entry: { file: "relative/path", line: 1-based, pattern: substring that
// must be on the offending line }. Keep this list in sync with
// src/lib/state/AGENTS.md "Documented exceptions" table.
//
// Categories:
//   A. Re-entry guards (sync-flow protection) - cannot be ctx-keyed
//   B. Test-injectable function slots - intentionally mutable for tests
//   C. Encapsulated lets in global-state.ts (getter pattern)
//   D. Logger / framework config - process-global by design
//   E. Session-state mirrors - process-global fallback for code without ctx
//   F. Mutable config values (tunable parameters) - exported
const EXEMPT_LINES = [
  // ── A. Re-entry guards (sync-flow protection) ──────────────────────────
  { file: "src/extensions/memory/context-lifecycle/state.ts", line: 100, pattern: "let _currentSessionState" },
  { file: "src/extensions/memory/context-lifecycle/state.ts", line: 101, pattern: "let _currentSessionId" },
  { file: "src/lib/utils/injection-tracker.ts", line: 50, pattern: "let _activeSessionId" },
  { file: "src/lib/utils/injection-tracker.ts", line: 58, pattern: "let _sendDepth" },
  { file: "src/lib/enforcement/turn-dedup.ts", line: 107, pattern: "let _state" },

  // ── A2. Lazy-load guards ───────────────────────────────────────────
  { file: "src/lib/store/evidence-pool.ts", line: 38, pattern: "let loadedFromDisk" },

  // ── B. Test-injectable function slots ─────────────────────────────────
  { file: "src/lib/ai/llm-call.ts", line: 68, pattern: "let _completeSimple" },
  { file: "src/lib/utils/id.ts", line: 29, pattern: "let _randomSuffix" },
  { file: "src/lib/utils/id.ts", line: 33, pattern: "let _counter" },
  { file: "src/lib/utils/id.ts", line: 35, pattern: "let _idGenerator" },

  // ── C. Encapsulated lets in global-state.ts (getter pattern) ──────────
  { file: "src/lib/state/global-state.ts", line: 82, pattern: "let _rotationState" },
  { file: "src/lib/state/global-state.ts", line: 118, pattern: "let _nudgeAnalyticsFallback" },
  { file: "src/lib/state/global-state.ts", line: 144, pattern: "let _cognitiveMemoryInstance" },
  { file: "src/lib/state/global-state.ts", line: 180, pattern: "let _postLoopTimeoutMs" },
  { file: "src/lib/state/global-state.ts", line: 226, pattern: "let _llmErrorListener" },
  { file: "src/lib/state/global-state.ts", line: 227, pattern: "let _llmSuccessListener" },
  { file: "src/lib/state/global-state.ts", line: 279, pattern: "let _timerExtensionFactoryState" },

  // ── D. Logger / framework config (process-global) ─────────────────────
  { file: "src/lib/core/logger.ts", line: 73, pattern: "let _boundContext" },
  { file: "src/lib/core/logger.ts", line: 79, pattern: "let _globalMinLevel" },
  { file: "src/lib/core/logger.ts", line: 80, pattern: "let _globallySuppressed" },
  { file: "src/lib/core/logger.ts", line: 96, pattern: "let _consoleMinLevel" },
  { file: "src/lib/state/extension-state.ts", line: 42, pattern: "let _lastSessionKey" },
  { file: "src/lib/state/session-start-queue.ts", line: 44, pattern: "let initialized" },
  { file: "src/lib/state/async-storage.ts", line: 24, pattern: "let flushScheduled" },

  // ── E. Session-state mirrors (process-global fallback for code without ctx) ──
  { file: "src/extensions/core/input-polisher/index.ts", line: 10, pattern: "let _isCompactionActiveImpl" },
  { file: "src/extensions/heartbeat/analytics/shared.ts", line: 109, pattern: "let _lastState" },
  { file: "src/extensions/memory/context-manager/handlers/shared.ts", line: 125, pattern: "let _fallbackActive" },
  { file: "src/lib/detection/degradation-detector.ts", line: 63, pattern: "let _global" },
  { file: "src/lib/detection/topic-drift-detector.ts", line: 66, pattern: "let _ctx" },
  { file: "src/lib/events/timer-bus.ts", line: 22, pattern: "let pendingReminders" },
  { file: "src/lib/ai/llm-call.ts", line: 93, pattern: "let rateLimitCooldownUntil" },

  // ── F. Mutable config values (tunable parameters) ─────────────────────
  { file: "src/lib/reasoning/advice-tracker.ts", line: 47, pattern: "export let dreamerCooldownMs" },
  { file: "src/lib/reasoning/advice-tracker.ts", line: 50, pattern: "export let marsOveruseMultiplier" },
  { file: "src/lib/reasoning/advice-tracker.ts", line: 60, pattern: "let _idCounter" },
];

// Build a set of "file:line" pairs for quick lookup.
const exemptKey = (file, line) => `${file}:${line}`;
const exemptSet = new Set(EXEMPT_LINES.map((e) => exemptKey(e.file, e.line)));

const violations = [];
let scanned = 0;

for (const file of walk(SRC)) {
  scanned++;
  const rel = file.replace(ROOT + "/", "");
  const lines = readFileSync(file, "utf-8").split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match ONLY module-scope `let`: column 0 (no indentation) or `export let`.
    // Function-scope `let` (indented) is fine.
    if (!/^(export\s+)?let\s+\w+/.test(line)) continue;
    const lineNo = i + 1;
    if (exemptSet.has(exemptKey(rel, lineNo))) continue;

    // Find an exemption that matches this line by pattern (in case the line moved)
    const matched = EXEMPT_LINES.find((e) => e.file === rel && line.includes(e.pattern.replace(/^let\s+/, "")));
    if (matched) {
      // Line moved - assert it's still the same file and update expected line
      console.warn(`  ! Exempt line moved: ${rel}:${lineNo} (expected ${matched.line}). Pattern: ${matched.pattern}`);
      continue;
    }

    violations.push({ file: rel, line: lineNo, text: line.trim() });
  }
}

if (violations.length > 0) {
  console.log("\n✗ Module-level `let` violations found:\n");
  for (const v of violations) {
    console.log(`  ${v.file}:${v.line}: ${v.text}`);
  }
  console.log(`\n  ${violations.length} violation(s) in ${scanned} files scanned.`);
  console.log("  Fix: use getExtensionState(ctx, key, factory) for per-session state,");
  console.log("       or add a getter to lib/state/global-state.ts for process-global state.");
  console.log("       If neither works, add to EXEMPT_LINES in test-no-module-level-let.mjs");
  console.log("       AND to the Documented exceptions table in src/lib/state/AGENTS.md.\n");
  process.exit(1);
}

console.log(`✓ No module-level let violations outside documented exceptions. (${scanned} files scanned)`);
