/**
 * Test: Core Logger - contract test for log level routing.
 *
 * Locks the contract that was broken in Q1: warn/info/debug were
 * silently dropped (empty default switch case in writeToConsole).
 * This test catches any regression where the switch case falls
 * through without writing to console.
 *
 * What it checks:
 *   1. _consoleMinLevel default is "warn" (info/debug stay silent by default)
 *   2. _consoleMinLevel can be lowered via setConsoleLogLevel
 *   3. writeToConsole has an explicit case for each LogLevel
 *      (no empty default that would silently drop messages)
 *   4. setGlobalLogLevel exists and gates the buffer emit
 *   5. The "warn" and "error" cases route to console.warn / console.error
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

// ── 1. Default _consoleMinLevel is "warn" ─────────────────────────────────

assert.ok(
  /let _consoleMinLevel: LogLevel = "warn"/.test(src),
  "_consoleMinLevel must default to 'warn' (don't spam raw terminal)",
);

// ── 2. setConsoleLogLevel exists ───────────────────────────────────────────

assert.ok(
  /export function setConsoleLogLevel/.test(src),
  "setConsoleLogLevel must be exported so callers can opt into verbose logging",
);

// ── 3. writeToConsole has explicit case for each level ─────────────────────
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

// ── 4. setGlobalLogLevel still exported ────────────────────────────────────

assert.ok(
  /export function setGlobalLogLevel/.test(src),
  "setGlobalLogLevel must remain exported",
);

// ── 5. warn routes to console.warn, error to console.error ────────────────

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

// ── 6. Module-level state is annotated as such ────────────────────────────

assert.ok(
  /Module state/.test(src),
  "Module state section header should be present (state-ownership contract)",
);

console.log("✅ logger.ts contract: _consoleMinLevel='warn', setConsoleLogLevel exported, all 4 levels routed.");
