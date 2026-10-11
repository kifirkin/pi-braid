/**
 * braid.context.contextAutoCompact settings resolver.
 *
 * The usage-driven auto-arm reads this block: enabled (default true — the
 * auto-relief is the fix, not an opt-in experiment), armPercent (default 60,
 * the sustained-usage line), confirmTicks (default 2 — "crosses and STAYS
 * there"). Invalid fields fall back to their defaults with a once-per-process
 * warning; the resolver is pure and unit-pinned here.
 *
 * Run: node test/runtime/memory/test-auto-compact-settings.mjs
 * (built first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "auto-compact-settings-home-"));
process.env.HOME = FAKE_HOME;
process.env.PI_CODING_AGENT_DIR = join(FAKE_HOME, ".pi", "agent");
mkdirSync(process.env.PI_CODING_AGENT_DIR, { recursive: true });

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const { resolveAutoCompactConfig, AUTO_COMPACT_DEFAULTS } = await import(
  join(ROOT, "dist/lib/config/braid-settings.js")
);

console.log("=== braid.context.contextAutoCompact resolver ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

await test("absent block resolves to defaults (enabled, 60%, 2 ticks)", async () => {
  const resolved = resolveAutoCompactConfig(undefined);
  assert.deepEqual(resolved, { enabled: true, armPercent: 60, confirmTicks: 2 });
  assert.deepEqual(AUTO_COMPACT_DEFAULTS, { enabled: true, armPercent: 60, confirmTicks: 2 });
});

await test("valid fields pass through", async () => {
  const resolved = resolveAutoCompactConfig({ enabled: false, armPercent: 75, confirmTicks: 4 });
  assert.deepEqual(resolved, { enabled: false, armPercent: 75, confirmTicks: 4 });
});

await test("invalid fields fall back per-field", async () => {
  assert.deepEqual(
    resolveAutoCompactConfig({ armPercent: 150 }).armPercent,
    60,
    "armPercent above 100 is invalid",
  );
  assert.deepEqual(
    resolveAutoCompactConfig({ armPercent: 0 }).armPercent,
    60,
    "armPercent 0 is invalid",
  );
  assert.deepEqual(
    resolveAutoCompactConfig({ confirmTicks: 0 }).confirmTicks,
    2,
    "confirmTicks below 1 is invalid",
  );
  assert.deepEqual(
    resolveAutoCompactConfig({ confirmTicks: 1.5 }).confirmTicks,
    2,
    "confirmTicks must be an integer",
  );
  assert.deepEqual(
    resolveAutoCompactConfig({ enabled: "yes" }).enabled,
    true,
    "non-boolean enabled falls back",
  );
});

await test("non-object shapes fall back to defaults", async () => {
  assert.deepEqual(resolveAutoCompactConfig("on"), {
    enabled: true,
    armPercent: 60,
    confirmTicks: 2,
  });
  assert.deepEqual(resolveAutoCompactConfig(42), {
    enabled: true,
    armPercent: 60,
    confirmTicks: 2,
  });
  assert.deepEqual(resolveAutoCompactConfig(null), {
    enabled: true,
    armPercent: 60,
    confirmTicks: 2,
  });
});

try {
  rmSync(FAKE_HOME, { recursive: true, force: true });
} catch {
  /* best-effort */
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
