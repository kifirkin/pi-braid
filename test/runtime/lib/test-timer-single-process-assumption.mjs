/**
 * Test: DR-C-4 - timer extension single-process-per-session assumption
 * is documented at the top of the source.
 *
 * BACKGROUND:
 *   ROADMAP DR-C-4 found that the `poller` in
 *   `extensions/scheduling/timer/index.ts` is a closure-captured `let`
 *   inside the extension factory. Each `timerExtension(pi)` call gets
 *   its own closure, which is correct for the standard pi lifecycle
 *   (one process per session, one extension registration per session).
 *
 *   The assumption breaks if a single Node process ever runs MORE THAN
 *   ONE pi session concurrently. The fix (when needed) is to migrate
 *   `poller` and `sessionState` to `getExtensionState(ctx, "timer", ...)`
 *   keyed by the ctx's session id.
 *
 *   This test enforces the documentation discipline: the file must
 *   have an explicit, recognizable "DR-C-4" section explaining the
 *   assumption, the failure mode, and the migration path. A future
 *   contributor who removes or refactors the poller without reading
 *   this section will get caught by the test (the section will be
 *   gone or non-conforming).
 *
 * This test verifies:
 *   1. The top-of-file docstring has a "DR-C-4" labeled section.
 *   2. The section explicitly states "SINGLE-PROCESS-PER-SESSION".
 *   3. The section mentions the closure-captured `poller`.
 *   4. The section describes the migration path
 *      (getExtensionState / WeakMap).
 *   5. The file still has a single `let poller` declaration (not
 *      duplicated or moved out of the factory).
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const TIMER_PATH = join(ROOT, "src/extensions/scheduling/timer/index.ts");

assert.ok(existsSync(TIMER_PATH), "timer source must exist");
const src = readFileSync(TIMER_PATH, "utf-8");

console.log("=== DR-C-4 timer single-process-per-session assumption tests ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(`  ✓ ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(`  ✗ ${name}: ${e.message}`);
      failed++;
    });
}

// ── Top-of-file documentation ──────────────────────────────────────────────

await test("top-of-file docstring has a DR-C-4 section", () => {
  // The first JSDoc block at the top of the file must mention DR-C-4
  // explicitly. A bare prose mention is not enough - we need a labeled
  // section so future contributors can find it.
  const firstDocblock = src.match(/^\s*\/\*\*([\s\S]*?)\*\//);
  assert.ok(firstDocblock, "file must have a top-of-file JSDoc block");
  assert.match(
    firstDocblock[1],
    /DR-C-4/,
    "top-of-file docstring must mention DR-C-4 explicitly",
  );
});

await test("DR-C-4 section explicitly states SINGLE-PROCESS-PER-SESSION", () => {
  assert.match(
    src,
    /SINGLE-PROCESS-PER-SESSION ASSUMPTION/,
    'top-of-file must have a "SINGLE-PROCESS-PER-SESSION ASSUMPTION" section',
  );
});

await test("DR-C-4 section describes the closure-captured poller", () => {
  // The section must call out the poller explicitly so a future
  // refactor that moves the poller elsewhere gets caught.
  assert.match(
    src,
    /SINGLE-PROCESS-PER-SESSION[\s\S]{0,500}?poller/,
    "DR-C-4 section must mention the closure-captured poller within 500 chars",
  );
});

await test("DR-C-4 section describes the migration path", () => {
  // The migration path is the actionable guidance - if a future
  // contributor needs to actually fix this, the doc must tell them how.
  assert.match(
    src,
    /getExtensionState|WeakMap/,
    "DR-C-4 section must describe the migration path (getExtensionState or WeakMap)",
  );
});

// ── Source-level: poller is still in the extension factory ─────────────────

await test("extension factory still has a single `let poller` declaration", () => {
  // The DR-C-4 fix is documentation + (optional) runtime check. The
  // actual `poller` variable is not migrated in this step. We verify
  // it's still in the expected place: exactly one `let poller`
  // declaration, inside the extension factory.
  const pollerDeclarations = src.match(/^\s*let\s+poller\b/gm) || [];
  assert.strictEqual(
    pollerDeclarations.length,
    1,
    `expected exactly 1 "let poller" declaration, found ${pollerDeclarations.length}`,
  );
});

await test("extension factory's poller is a TimerPoller", () => {
  assert.match(
    src,
    /let\s+poller:\s*TimerPoller\s*\|\s*null\s*=\s*null/,
    "poller must be typed TimerPoller | null (current pattern)",
  );
});

await test("ensurePoller is the lazy initializer", () => {
  // The factory pattern: poller is null until first ctx is available.
  // The actual code uses an arrow function, not a function declaration.
  assert.match(
    src,
    /ensurePoller\s*=[\s\S]*?if\s*\(\s*!poller\s*\)/,
    "ensurePoller must check `if (!poller)` to lazily initialize",
  );
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  process.exit(1);
}
console.log("=== DR-C-4 timer assumption tests passed ===");
