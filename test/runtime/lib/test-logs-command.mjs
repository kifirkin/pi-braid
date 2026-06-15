/**
 * Test: /logs slash command (TUI-safe logging retrieval).
 *
 * HISTORY (2026-06-15):
 *   User flagged that console.* writes break TUI rendering. The fix:
 *   default _consoleMinLevel to "none" so warn/info/debug don't write
 *   to stdout/stderr. The in-memory buffer is always populated; the
 *   /logs command retrieves it.
 *
 *   This test pins the contract:
 *     1. _consoleMinLevel defaults to "none" (TUI-safe)
 *     2. setConsoleLogLevel accepts "none" | LogLevel
 *     3. getLogBuffer is exported
 *     4. formatLogBuffer is exported
 *     5. clearLogBuffer is exported
 *     6. The /logs command exists in health-maintenance
 *     7. The /logs command supports subcommands: show N / clear / level
 *     8. The command uses ctx.ui.notify (not console.log) for output
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  logger: join(ROOT, "src/lib/core/logger.ts"),
  healthMaintenance: join(ROOT, "src/extensions/self/health-maintenance/index.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const loggerSrc = readFileSync(FILES.logger, "utf-8");
const healthSrc = readFileSync(FILES.healthMaintenance, "utf-8");

console.log("=== /logs command + TUI-safe logger ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

// ── Logger contract ─────────────────────────────────────────────────────

test("_consoleMinLevel defaults to 'none' (TUI-safe)", () => {
  assert.match(
    loggerSrc,
    /let _consoleMinLevel: ConsoleLogLevel = "none"/,
    "Must default to 'none' so extensions never write to stdout/stderr",
  );
});

test("ConsoleLogLevel type includes 'none' sentinel", () => {
  assert.match(
    loggerSrc,
    /export type ConsoleLogLevel = LogLevel \| "none"/,
    "ConsoleLogLevel must be LogLevel | 'none'",
  );
});

test("writeToConsole early-returns on 'none'", () => {
  assert.match(
    loggerSrc,
    /function writeToConsole[\s\S]*?if \(_consoleMinLevel === "none"\) return/,
    "writeToConsole must early-return on 'none' to protect TUI",
  );
});

test("setConsoleLogLevel accepts ConsoleLogLevel", () => {
  assert.match(
    loggerSrc,
    /export function setConsoleLogLevel\(level: ConsoleLogLevel\)/,
    "setConsoleLogLevel must accept ConsoleLogLevel",
  );
});

test("getLogBuffer / formatLogBuffer / clearLogBuffer are exported", () => {
  for (const fn of ["getLogBuffer", "formatLogBuffer", "clearLogBuffer"]) {
    assert.ok(
      new RegExp(`export function ${fn}`).test(loggerSrc),
      `${fn} must be exported (the /logs command needs it)`,
    );
  }
});

test("addToBuffer is called BEFORE writeToConsole (buffer populated even at 'none')", () => {
  // The critical contract: even when console writes are suppressed,
  // the in-memory buffer still gets the entry.
  assert.match(
    loggerSrc,
    /addToBuffer\(entry\);[\s\S]*?writeToConsole\(entry\)/,
    "addToBuffer must be called before writeToConsole so buffer is always populated",
  );
});

// ── /logs command contract ─────────────────────────────────────────────

test("/logs command is registered in health-maintenance", () => {
  assert.match(
    healthSrc,
    /pi\.registerCommand\("logs"/,
    "health-maintenance must register a 'logs' slash command",
  );
});

test("/logs handler supports subcommand 'clear'", () => {
  assert.match(
    healthSrc,
    /if \(sub === "clear"\) \{[\s\S]*?clearLogBuffer\(\)/,
    "/logs clear must call clearLogBuffer()",
  );
});

test("/logs handler supports subcommand 'level'", () => {
  assert.match(
    healthSrc,
    /if \(sub === "level"\) \{[\s\S]*?setConsoleLogLevel\(level\)/,
    "/logs level <X> must call setConsoleLogLevel(level)",
  );
});

test("/logs handler validates level arg is one of none|error|warn|info|debug", () => {
  assert.match(
    healthSrc,
    /\["none", "error", "warn", "info", "debug"\]\.includes\(level\)/,
    "/logs level must validate the level arg against the allowed set",
  );
});

test("/logs default behavior shows last 50 entries", () => {
  assert.match(
    healthSrc,
    /const requested = sub \? parseInt\(sub, 10\) : 50/,
    "/logs with no args must default to 50 entries",
  );
});

test("/logs cap is 500 entries to prevent TUI notification overflow", () => {
  assert.match(
    healthSrc,
    /Math\.min\(requested, 500\)/,
    "/logs N must cap at 500 to avoid ctx.ui.notify overflow",
  );
});

test("/logs uses ctx.ui.notify (not console.log) for output", () => {
  // The whole point: don't write to console. Use ctx.ui.notify so the
  // user sees the buffer in their TUI as a notification.
  const handlerBody = healthSrc.match(
    /pi\.registerCommand\("logs"[\s\S]*?handler: async[\s\S]*?\},[\s\S]*?\}\);/,
  );
  assert.ok(handlerBody, "logs command handler not found");
  // Multiple ctx.ui.notify calls expected (header + entries)
  const notifyCount = (handlerBody[0].match(/ctx\.ui\.notify\(/g) || []).length;
  assert.ok(
    notifyCount >= 3,
    `logs handler should use ctx.ui.notify multiple times (header, entries, errors). Found: ${notifyCount}`,
  );
});

test("/logs empty buffer case uses ctx.ui.notify (not console.log)", () => {
  assert.match(
    healthSrc,
    /entries\.length === 0\)[\s\S]*?ctx\.ui\.notify\("Log buffer is empty"/,
    "Empty buffer case must use ctx.ui.notify",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== /logs + TUI-safe logger regression tests passed ===");
