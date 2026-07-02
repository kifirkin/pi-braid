/**
 * Test: safeSessionManagerTyped returns a properly typed SessionManager
 * with getSessionFile() (no more `as unknown as SmWithSessionFile` cast
 * at every callsite).
 *
 * HISTORY (2026-06-15):
 *   The watchdog extension (and several others) needed to call
 *   sm.getSessionFile() but the canonical SessionManager wrapper
 *   didn't include that method. Each extension defined its own
 *   SmWithSessionFile local interface and used:
 *     const sm = safeSessionManager(ctx) as unknown as SmWithSessionFile;
 *   ... at every callsite (5+ in watchdog alone).
 *
 * FIX:
 *   - SessionManager wrapper in lib/state/session-manager.ts now
 *     includes getSessionFile(): string | null
 *   - New safeSessionManagerTyped() in lib/state/extension-state.ts
 *     returns the typed wrapper directly (no cast needed)
 *   - Watchdog migrated to safeSessionManagerTyped (5 callsites
 *     down from `as unknown as SmWithSessionFile` to clean calls)
 *
 * This test pins the contract.
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  sessionManager: join(ROOT, "src/lib/state/session-manager.ts"),
  extensionState: join(ROOT, "src/lib/state/extension-state.ts"),
  watchdog: join(ROOT, "src/extensions/self/watchdog/index.ts"),
  sycophancy: join(ROOT, "src/extensions/cognitive/sycophancy-detector/index.ts"),
  analytics: join(ROOT, "src/extensions/heartbeat/analytics/index.ts"),
  threeMemoryStores: join(ROOT, "src/extensions/memory/three-memory-stores/index.ts"),
  sessionRecall: join(ROOT, "src/extensions/memory/session-recall/index.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const sessionMgrSrc = readFileSync(FILES.sessionManager, "utf-8");
const extStateSrc = readFileSync(FILES.extensionState, "utf-8");
const watchdogSrc = readFileSync(FILES.watchdog, "utf-8");

console.log("=== safeSessionManagerTyped + SessionManager.getSessionFile ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(`  [x] ${name}: ${e.message}`);
    failed++;
  }
}

// ── SessionManager interface contract ───────────────────────────────────

test("SessionManager interface includes getSessionFile(): string | null", () => {
  const ifaceMatch = sessionMgrSrc.match(
    /export interface SessionManager\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(ifaceMatch, "SessionManager interface not found");
  const body = ifaceMatch[1];
  assert.match(
    body,
    /getSessionFile\(\):\s*string\s*\|\s*null/,
    "SessionManager must include getSessionFile(): string | null",
  );
});

test("getSessionFile JSDoc explains the return value contract", () => {
  const ifaceMatch = sessionMgrSrc.match(
    /export interface SessionManager\s*\{([\s\S]*?)\n\}/,
  );
  assert.ok(ifaceMatch, "SessionManager interface not found");
  const body = ifaceMatch[1];
  // Look for JSDoc above getSessionFile
  assert.match(
    body,
    /\/\*\*[\s\S]*?getSessionFile\(\)/,
    "getSessionFile should have a JSDoc explaining when it returns null (ephemeral sessions)",
  );
});

// ── safeSessionManagerTyped contract ─────────────────────────────────────

test("safeSessionManagerTyped is exported from extension-state.ts", () => {
  assert.match(
    extStateSrc,
    /export function safeSessionManagerTyped\(/,
    "safeSessionManagerTyped must be exported (callers need to import it)",
  );
});

test("safeSessionManagerTyped JSDoc explains the pattern it replaces", () => {
  // The JSDoc is BEFORE the function declaration, not after.
  const jsdocMatch = extStateSrc.match(
    /\/\*\*[\s\S]*?export function safeSessionManagerTyped/,
  );
  assert.ok(jsdocMatch, "safeSessionManagerTyped JSDoc not found");
  const body = jsdocMatch[0];
  assert.match(
    body,
    /safeSessionManager\(ctx\) as unknown as SmWithSessionFile/,
    "JSDoc must reference the old `as unknown as SmWithSessionFile` pattern it replaces",
  );
});

test("safeSessionManagerTyped returns undefined when sessionManager is unavailable", () => {
  const fnMatch = extStateSrc.match(
    /export function safeSessionManagerTyped[\s\S]*?\n\}/,
  );
  assert.ok(fnMatch, "safeSessionManagerTyped function not found");
  const body = fnMatch[0];
  assert.match(
    body,
    /if \(!sm\) return undefined/,
    "Function must return undefined when safeSessionManager returns falsy",
  );
});

test("safeSessionManagerTyped returns the typed SessionManager when available", () => {
  const fnMatch = extStateSrc.match(
    /export function safeSessionManagerTyped[\s\S]*?\n\}/,
  );
  assert.ok(fnMatch, "safeSessionManagerTyped function not found");
  const body = fnMatch[0];
  // The return type should use the import() type so the import is
  // captured correctly (avoids the deep import cycle that broke earlier
  // attempts at this kind of wrapper).
  assert.match(
    body,
    /return sm as import\(["']\.\/session-manager\.js["']\)\.SessionManager/,
    "Function must cast sm to the SessionManager import type for type safety",
  );
});

// ── Watchdog migration contract ─────────────────────────────────────────

test("Watchdog imports safeSessionManagerTyped (not safeSessionManager + SmWithSessionFile)", () => {
  assert.match(
    watchdogSrc,
    /import \{ safeSessionManagerTyped \}/,
    "Watchdog must import safeSessionManagerTyped",
  );
  assert.ok(
    !/interface SmWithSessionFile/.test(watchdogSrc),
    "Watchdog must NOT re-declare SmWithSessionFile locally (the new typed wrapper replaces it)",
  );
});

test("Watchdog has zero `as unknown as SmWithSessionFile` casts", () => {
  const castCount = (watchdogSrc.match(/as unknown as SmWithSessionFile/g) || []).length;
  assert.strictEqual(
    castCount,
    0,
    `Watchdog must have 0 'as unknown as SmWithSessionFile' casts. Found: ${castCount}`,
  );
});

test("Watchdog has 5 callsites using safeSessionManagerTyped", () => {
  const callCount = (watchdogSrc.match(/safeSessionManagerTyped\(ctx\)/g) || []).length;
  assert.ok(
    callCount >= 4,
    `Watchdog should have 4-5 safeSessionManagerTyped(ctx) callsites. Found: ${callCount}`,
  );
});

test("Watchdog callsites use ?.getSessionFile?.() for safety (typed wrapper, but ctx can still be stale)", () => {
  // The optional chaining on .getSessionFile is still there because
  // even the typed wrapper could be undefined if the sessionManager
  // was unavailable. We're just removing the SmWithSessionFile
  // local interface, not the defensive optional chaining.
  const sm = watchdogSrc.match(/sm\?\.getSessionFile\?\.\(\) \?\? ctx\.cwd/g) || [];
  assert.ok(
    sm.length >= 4,
    `Watchdog should have multiple 'sm?.getSessionFile?.() ?? ctx.cwd' callsites. Found: ${sm.length}`,
  );
});

// ── Other migrated sites (round 2) ────────────────────────────────────────

test("Sycophancy detector uses safeSessionManagerTyped (no SmWithSessionFile-style local interface)", () => {
  const src = readFileSync(FILES.sycophancy, "utf-8");
  assert.match(
    src,
    /import.*safeSessionManagerTyped/,
    "Sycophancy detector must import safeSessionManagerTyped",
  );
  assert.ok(
    !/safeSessionManager\(ctx\) as \{ getBranch/.test(src),
    "Sycophancy detector must not use the old 'safeSessionManager(ctx) as {getBranch?()}' cast pattern",
  );
  assert.match(
    src,
    /safeSessionManagerTyped\(ctx\)/,
    "Sycophancy detector must have a safeSessionManagerTyped(ctx) callsite",
  );
});

test("Heartbeat analytics uses safeSessionManagerTyped (was: 'as {getSessionFile?(): string}')", () => {
  const src = readFileSync(FILES.analytics, "utf-8");
  assert.match(
    src,
    /import.*safeSessionManagerTyped/,
    "Heartbeat analytics must import safeSessionManagerTyped",
  );
  assert.ok(
    !/safeSessionManager\(ctx\) as \{ getSessionFile/.test(src),
    "Heartbeat analytics must not use the old 'safeSessionManager(ctx) as {getSessionFile?()}' cast pattern",
  );
});

test("Three-memory-stores uses safeSessionManagerTyped (was: 'as CtxSessionManager')", () => {
  const src = readFileSync(FILES.threeMemoryStores, "utf-8");
  assert.match(
    src,
    /import.*safeSessionManagerTyped/,
    "Three-memory-stores must import safeSessionManagerTyped",
  );
  assert.ok(
    !/safeSessionManager\(ctx\) as CtxSessionManager/.test(src),
    "Three-memory-stores must not use the old CtxSessionManager local interface cast",
  );
  // The CtxSessionManager local interface should be gone
  assert.ok(
    !/interface CtxSessionManager extends SessionManager/.test(src),
    "Three-memory-stores must not declare a local CtxSessionManager interface (use safeSessionManagerTyped)",
  );
});

test("Session-recall uses safeSessionManagerTyped (was: 'as {getBranch?(): any[]}')", () => {
  const src = readFileSync(FILES.sessionRecall, "utf-8");
  assert.match(
    src,
    /import.*safeSessionManagerTyped/,
    "Session-recall must import safeSessionManagerTyped",
  );
  assert.ok(
    !/safeSessionManager\(ctx\) as \{ getBranch\?\(\): any\[\]/.test(src),
    "Session-recall must not use the old 'safeSessionManager(ctx) as {getBranch?(): any[]}' cast pattern",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== safeSessionManagerTyped + SessionManager.getSessionFile tests passed ===");
