/**
 * EW-7.11: braid.enforcement settings block plumbing.
 *
 * HISTORY (2026-06-27):
 *   NudgeManager.DEFAULT_NUDGE_CONFIGS hardcoded all per-type cooldowns.
 *   The constructor accepted `customConfig` but no caller passed it -
 *   the hook was dead. Power users couldn't tune cooldowns without
 *   forking.
 *
 * FIX: Settings plumbing.
 *   - braid-settings.ts exports getRawNudgeConfigOverrides() that reads
 *     braid.enforcement.nudgeConfigs from settings.json (unttyped).
 *   - nudge-manager.ts exports validateNudgeConfig(type, cfg) that
 *     returns {valid, errors, parsed}. Drops invalid fields but keeps
 *     valid ones (defense in depth: one bad field doesn't lose the
 *     whole entry).
 *   - nudge-manager.ts exports parseNudgeConfigOverrides(raw) that
 *     applies BOTH layers (unknown-type filter + per-entry validation)
 *     and returns the shape NudgeManager expects.
 *   - getNudgeManager(ctx) calls parseNudgeConfigOverrides on every
 *     access, then passes the result to the NudgeManager constructor.
 *
 * This test pins the contract at both the source level (is it wired?)
 * and the runtime level (does the validation behave?).
 *
 * Companion tests:
 *   - test-suppress-nudges-applied.mjs (P1-4) - the wrapper layer
 *   - test-nudgetype-wiring.mjs (P1-5) - the union of NudgeTypes
 */

import { strict as assert } from "node:assert";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const FILES = {
  braidSettings: join(ROOT, "src/lib/config/braid-settings.ts"),
  nudgeManager: join(ROOT, "src/extensions/enforcement/nudge-manager.ts"),
};

for (const [name, path] of Object.entries(FILES)) {
  assert.ok(existsSync(path), `${name} source file should exist at ${path}`);
}

const bsSrc = readFileSync(FILES.braidSettings, "utf-8");
const nmSrc = readFileSync(FILES.nudgeManager, "utf-8");

// ── Source-level wire-up checks ──────────────────────────────────────────────

// Subtest 1: braid-settings exports the raw reader
assert.match(
  bsSrc,
  /export function getRawNudgeConfigOverrides/,
  "braid-settings must export getRawNudgeConfigOverrides",
);

// Subtest 2: BraidConfig has the enforcement block
assert.match(
  bsSrc,
  /enforcement\?:\s*\{/,
  "BraidConfig interface must include enforcement block",
);

// Subtest 3: the enforcement block has nudgeConfigs
assert.match(
  bsSrc,
  /nudgeConfigs\?:\s*Record<string,\s*unknown>/,
  "enforcement block must declare nudgeConfigs as Record<string, unknown>",
);

// Subtest 4: nudge-manager imports the raw reader
assert.match(
  nmSrc,
  /import\s*\{[^}]*getRawNudgeConfigOverrides[^}]*\}\s*from\s*["'][^"']*braid-settings[^"']*["']/,
  "nudge-manager must import getRawNudgeConfigOverrides from braid-settings",
);

// Subtest 5: nudge-manager exports validateNudgeConfig
assert.match(
  nmSrc,
  /export function validateNudgeConfig/,
  "nudge-manager must export validateNudgeConfig",
);

// Subtest 6: nudge-manager exports parseNudgeConfigOverrides
assert.match(
  nmSrc,
  /export function parseNudgeConfigOverrides/,
  "nudge-manager must export parseNudgeConfigOverrides",
);

// Subtest 7: getNudgeManager passes overrides to NudgeManager constructor
assert.match(
  nmSrc,
  /new NudgeManager\(\s*overrides\s*\)/,
  "getNudgeManager must pass overrides to the NudgeManager constructor",
);

// ── Runtime behavior checks ─────────────────────────────────────────────────
//
// Tests run after `npm run build` (scripts/run-tests.mjs), so importing
// from dist/ is safe and reflects the actual built code.

const distPath = join(ROOT, "dist", "extensions", "enforcement", "nudge-manager.js");
assert.ok(existsSync(distPath), `dist nudge-manager.js must exist at ${distPath}`);

const { validateNudgeConfig, parseNudgeConfigOverrides, DEFAULT_NUDGE_CONFIGS } =
  await import(distPath);

// Subtest 8: validateNudgeConfig -- valid input returns parsed + no errors
{
  const r = validateNudgeConfig("validation", {
    baseCooldownMs: 30000,
    escalateAfter: 5,
    deduplicate: false,
  });
  assert.equal(r.valid, true, "fully-valid config should be valid");
  assert.equal(r.errors.length, 0);
  assert.equal(r.parsed.baseCooldownMs, 30000);
  assert.equal(r.parsed.escalateAfter, 5);
  assert.equal(r.parsed.deduplicate, false);
}

// Subtest 9: validateNudgeConfig -- empty object is valid (no overrides)
{
  const r = validateNudgeConfig("validation", {});
  assert.equal(r.valid, true);
  assert.deepEqual(r.parsed, {});
}

// Subtest 10: validateNudgeConfig -- negative cooldown rejected, valid field preserved
{
  const r = validateNudgeConfig("validation", {
    baseCooldownMs: -100,
    deduplicate: true,
  });
  assert.equal(r.valid, false, "negative cooldown should fail");
  assert.equal(r.parsed.baseCooldownMs, undefined, "negative value should be dropped");
  assert.equal(r.parsed.deduplicate, true, "valid sibling field should be preserved");
  assert.ok(r.errors.some((e) => e.includes("baseCooldownMs")), "should error on baseCooldownMs");
}

// Subtest 11: validateNudgeConfig -- wrong type rejected
{
  const r = validateNudgeConfig("validation", { deduplicate: "yes" });
  assert.equal(r.valid, false);
  assert.equal(r.parsed.deduplicate, undefined);
  assert.ok(r.errors.some((e) => e.includes("must be a boolean")));
}

// Subtest 12: validateNudgeConfig -- non-integer rejected
{
  const r = validateNudgeConfig("validation", { baseCooldownMs: 1.5 });
  assert.equal(r.valid, false);
  assert.equal(r.parsed.baseCooldownMs, undefined);
}

// Subtest 13: validateNudgeConfig -- unknown field rejected, valid preserved
{
  const r = validateNudgeConfig("validation", {
    fooBar: 42,
    escalateAfter: 3,
  });
  assert.equal(r.valid, false);
  assert.equal(r.parsed.escalateAfter, 3, "known field should still be parsed");
  assert.ok(r.errors.some((e) => e.includes("not a valid field")));
}

// Subtest 14: validateNudgeConfig -- null/array cfg rejected
{
  const r1 = validateNudgeConfig("validation", null);
  assert.equal(r1.valid, false);
  const r2 = validateNudgeConfig("validation", [1, 2]);
  assert.equal(r2.valid, false);
}

// Subtest 15: parseNudgeConfigOverrides -- filters unknown types
{
  const r = parseNudgeConfigOverrides({
    validation: { baseCooldownMs: 30000 },
    bogusType: { baseCooldownMs: 5000 },
  });
  assert.equal(r.validation?.baseCooldownMs, 30000);
  assert.equal(r.bogusType, undefined, "unknown type should be dropped");
}

// Subtest 16: parseNudgeConfigOverrides -- drops fully-invalid entries
{
  const r = parseNudgeConfigOverrides({
    malformed: "not an object",
  });
  assert.equal(r.malformed, undefined);
}

// Subtest 17: parseNudgeConfigOverrides -- empty input returns empty object
{
  assert.deepEqual(parseNudgeConfigOverrides({}), {});
}

// Subtest 18: defaults still cover all 7 wired NudgeTypes
{
  // P1-5 / EW-7.2 settled on 7 types; if this drops, the test fails
  // and pin the regression at the contract level.
  const types = Object.keys(DEFAULT_NUDGE_CONFIGS).sort();
  assert.deepEqual(types, [
    "context",
    "malformed",
    "memory",
    "recordFailure",
    "scratchpad",
    "sessionSignals",
    "validation",
  ]);
}

console.log("=== EW-7.11: enforcement settings plumbing ===");
console.log("  [v] braid-settings exports getRawNudgeConfigOverrides");
console.log("  [v] BraidConfig has enforcement block");
console.log("  [v] enforcement block has nudgeConfigs field");
console.log("  [v] nudge-manager imports getRawNudgeConfigOverrides");
console.log("  [v] nudge-manager exports validateNudgeConfig");
console.log("  [v] nudge-manager exports parseNudgeConfigOverrides");
console.log("  [v] getNudgeManager passes overrides to constructor");
console.log("  [v] validateNudgeConfig: valid input -> parsed");
console.log("  [v] validateNudgeConfig: empty object -> valid");
console.log("  [v] validateNudgeConfig: invalid field dropped, sibling preserved");
console.log("  [v] validateNudgeConfig: wrong type rejected");
console.log("  [v] validateNudgeConfig: non-integer rejected");
console.log("  [v] validateNudgeConfig: unknown field rejected");
console.log("  [v] validateNudgeConfig: null/array cfg rejected");
console.log("  [v] parseNudgeConfigOverrides: filters unknown types");
console.log("  [v] parseNudgeConfigOverrides: drops fully-invalid entries");
console.log("  [v] parseNudgeConfigOverrides: empty input -> empty object");
console.log("  [v] DEFAULT_NUDGE_CONFIGS covers all 7 NudgeTypes");
console.log("18 passed, 0 failed");
console.log("=== EW-7.11 enforcement settings tests passed ===");
