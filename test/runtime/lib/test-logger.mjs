/**
 * Test: Core Logger - contract test for log level routing.
 *
 * Locks the contract that was broken in Q1: warn/info/debug were
 * silently dropped (empty default switch case in writeToConsole).
 *
 * This test was UPDATED (2026-06-15) when the default was changed from
 * "warn" to "none" - the rationale is that pi is a TUI process and
 * writing to stdout/stderr from an extension handler corrupts the TUI
 * cursor positioning. The in-memory buffer is always populated; the
 * /logs slash command exposes it to the user.
 *
 * What it checks:
 *   1. _consoleMinLevel default is "none" (TUI-safe)
 *   2. setConsoleLogLevel accepts "none" | LogLevel
 *   3. writeToConsole early-returns when _consoleMinLevel === "none"
 *   4. writeToConsole has an explicit case for each LogLevel
 *      (no empty default that would silently drop messages)
 *   5. setGlobalLogLevel exists and gates the buffer emit
 *   6. The "warn" and "error" cases route to console.warn / console.error
 *   7. The in-memory buffer is populated regardless of console level
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  logger: join(ROOT, "src/lib/core/logger.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const src = readFileSync(FILES.logger, "utf-8");

// ── 1. Default _consoleMinLevel is "none" (TUI-safe) ───────────────────────

assert.ok(
  /let _consoleMinLevel: ConsoleLogLevel = "none"/.test(src),
  "_consoleMinLevel must default to 'none' (TUI-safe: never write to stdout/stderr from extensions)",
);

// ── 2. ConsoleLogLevel is a union that includes "none" ─────────────────────

assert.ok(
  /export type ConsoleLogLevel = LogLevel \| "none"/.test(src),
  "ConsoleLogLevel type must include 'none' sentinel for TUI-safe mode",
);

// ── 3. writeToConsole early-returns on "none" ─────────────────────────────

assert.ok(
  /function writeToConsole[\s\S]*?if \(_consoleMinLevel === "none"\) return/.test(src),
  "writeToConsole must early-return when _consoleMinLevel is 'none'",
);

// ── 4. setConsoleLogLevel exists and accepts ConsoleLogLevel ──────────────

assert.ok(
  /export function setConsoleLogLevel\(level: ConsoleLogLevel\)/.test(src),
  "setConsoleLogLevel must accept ConsoleLogLevel (LogLevel | 'none')",
);

// ── 5. writeToConsole has explicit case for each level ─────────────────────
//   The old bug was: default case did nothing, so warn/info/debug were
//   silently dropped. This regex catches that regression.

const switchBlock = src.match(/switch\s*\(entry\.level\)\s*{([\s\S]*?)\n}/);
assert.ok(switchBlock, "writeToConsole must have a switch on entry.level");

const cases = switchBlock[1].match(/case "(debug|info|warn|error)":/g) || [];
const caseLevels = cases.map((c) => c.match(/"(debug|info|warn|error)"/)[1]);
assert.deepEqual(
  caseLevels.sort(),
  ["debug", "error", "info", "warn"],
  `writeToConsole must have a case for every level. Found: ${caseLevels.join(", ")}. Empty default = silent drop bug.`,
);

// ── 6. setGlobalLogLevel still exported (gates buffer) ────────────────────

assert.ok(
  /export function setGlobalLogLevel/.test(src),
  "setGlobalLogLevel must remain exported (gates in-memory buffer emit)",
);

// ── 7. warn routes to console.warn, error to console.error ────────────────

const switchBody = switchBlock[1];
assert.ok(
  /case "warn":[\s\S]*?console\.warn/.test(switchBody),
  "'warn' case must call console.warn",
);
assert.ok(
  /case "error":[\s\S]*?console\.error/.test(switchBody),
  "'error' case must call console.error",
);
assert.ok(
  /case "info":[\s\S]*?console\.info/.test(switchBody),
  "'info' case must call console.info (so lowering _consoleMinLevel actually surfaces it)",
);
assert.ok(
  /case "debug":[\s\S]*?console\.debug/.test(switchBody),
  "'debug' case must call console.debug (same reasoning)",
);

// ── 8. In-memory buffer is populated even at "none" console level ─────────

assert.ok(
  /addToBuffer\(entry\);[\s\S]*?writeToConsole\(entry\)/.test(src),
  "addToBuffer must be called BEFORE writeToConsole so the in-memory buffer is populated even when console writes are suppressed",
);

assert.ok(
  /export function getLogBuffer/.test(src),
  "getLogBuffer must be exported (for /logs slash command or debugging)",
);

assert.ok(
  /export function formatLogBuffer/.test(src),
  "formatLogBuffer must be exported (for the /logs slash command)",
);

console.log("✅ logger.ts contract: _consoleMinLevel='none' (TUI-safe), ConsoleLogLevel includes 'none', all 4 levels routed, buffer always populated.");

// ── 9. setLoggerContext API + ctx.ui.notify routing ───────────────────────

assert.ok(
  /export function setLoggerContext\(ctx: LoggerContext \| null\)/.test(src),
  "setLoggerContext must be exported (so src/index.ts can bind on session_start)",
);

assert.ok(
  /export function getLoggerContext\(\)/.test(src),
  "getLoggerContext must be exported (for tests + debugging)",
);

assert.ok(
  /export interface LoggerContext/.test(src),
  "LoggerContext interface must be exported (callers can type their bind)",
);

// writeToConsole must check _boundContext FIRST and route to ctx.ui.notify
const writeBlock = src.match(/function writeToConsole\([\s\S]*?\n\}/);
assert.ok(writeBlock, "writeToConsole must exist");
const writeBody = writeBlock[0];
assert.ok(
  /_boundContext\?\.ui\?\.notify/.test(writeBody),
  "writeToConsole must route through _boundContext.ui.notify when bound (TUI-safe)",
);

// Severity mapping for ctx.ui.notify
assert.ok(
  /notifySeverityForLevel/.test(writeBody) || /"error"|"warning"/.test(writeBody),
  "writeToConsole must map log level to ctx.ui.notify severity (error/warning/info)",
);

// Bound ctx routing must happen BEFORE any console.* call
const notifyIdx = writeBody.indexOf("_boundContext?.ui?.notify");
const consoleIdx = writeBody.search(/console\.(error|warn|info|debug)/);
if (notifyIdx !== -1 && consoleIdx !== -1) {
  assert.ok(
    notifyIdx < consoleIdx,
    "Bound ctx routing (ctx.ui.notify) must be checked BEFORE any console.* call",
  );
}

// ── 10. Session-start binding in src/index.ts ─────────────────────────────

const indexSrc = readFileSync(join(ROOT, "src/index.ts"), "utf-8");
assert.ok(
  /setLoggerContext\(ctx\)/.test(indexSrc),
  "src/index.ts must call setLoggerContext(ctx) on session_start",
);
assert.ok(
  /setLoggerContext\(null\)/.test(indexSrc),
  "src/index.ts must call setLoggerContext(null) on session_shutdown",
);
assert.ok(
  /pi\.on\(SESSION_START/.test(indexSrc),
  "src/index.ts must use the SESSION_START constant (not raw 'session_start' string)",
);
assert.ok(
  /pi\.on\(SESSION_SHUTDOWN/.test(indexSrc),
  "src/index.ts must use the SESSION_SHUTDOWN constant (not raw 'session_shutdown' string)",
);

console.log("✅ setLoggerContext API + session_start binding verified.");
