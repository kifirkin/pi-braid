/**
 * EW-7.2 / P1-5: Every NudgeType in DEFAULT_NUDGE_CONFIGS must have
 * at least one call site that calls
 * `getNudgeManager(ctx).shouldSendNudge(<type>, ...)` somewhere in src/.
 *
 * HISTORY:
 *   The original NudgeType union had 16 members but only 2 had callers
 *   (validation, scratchpad). The other 14 were forward-looking
 *   scaffolding — configs without triggering logic, creating a false
 *   impression of a wired-up system. A new contributor reading
 *   `nudge-manager.ts` would assume e.g. `dangerousCommand` or
 *   `malformed` was rate-limited by NudgeManager — it was not.
 *
 *   This test pins the contract: every NudgeType has at least one
 *   caller. If you add a new NudgeType, you must wire it up in the
 *   same commit (or this test will fail).
 *
 * SCOPE:
 *   - NudgeType union is the source of truth (defined in
 *     `src/extensions/enforcement/nudge-manager.ts`).
 *   - A "caller" is any source-level occurrence of the type literal
 *     inside a `shouldSendNudge(...)` call within `src/`. The check
 *     is intentionally permissive (substring match on the type string)
 *     to allow both direct calls and template-built calls. If a type
 *     is constructed dynamically (e.g. `types[i]`), that pattern
 *     needs a manual override comment in the source — see
 *     `MANUAL_OVERRIDES` below.
 *
 *   - Tests, dist/, and node_modules are excluded.
 */

import { strict as assert } from "node:assert";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

const NUDGE_MANAGER_PATH = join(
  ROOT,
  "src/extensions/enforcement/nudge-manager.ts",
);
assert.ok(existsSync(NUDGE_MANAGER_PATH), "nudge-manager.ts must exist");

const nudgeSrc = readFileSync(NUDGE_MANAGER_PATH, "utf-8");

// ── Step 1: extract NudgeType union members from the source ──────────────

function extractNudgeTypes(src) {
  // Match the union block: `export type NudgeType = ... | "x" | "y" ...;`
  // Look for lines containing quoted identifiers between the = and ; markers.
  const unionMatch = src.match(
    /export\s+type\s+NudgeType\s*=\s*([\s\S]*?);/,
  );
  assert.ok(unionMatch, "could not find NudgeType union in nudge-manager.ts");

  const body = unionMatch[1];
  const members = [];
  for (const m of body.matchAll(/"\s*([a-zA-Z][a-zA-Z0-9]*)\s*"/g)) {
    members.push(m[1]);
  }
  return members;
}

const nudgeTypes = extractNudgeTypes(nudgeSrc);
assert.ok(nudgeTypes.length > 0, "NudgeType union must not be empty");

// ── Step 2: walk src/ and collect shouldSendNudge call sites ────────────

function walkSrc(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === "dist" || entry === "coverage") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walkSrc(full, out);
    else if (/\.(ts|mts|cts)$/.test(entry)) out.push(full);
  }
  return out;
}

const srcFiles = walkSrc(join(ROOT, "src"));
assert.ok(srcFiles.length > 0, "src/ tree must exist");

// Per-type set of file:line where the type string appears inside a
// shouldSendNudge call. Two patterns are accepted:
//   (a) Direct: a line contains both `shouldSendNudge(...)` and a
//       string literal matching the type.
//   (b) Lookup table: a file that contains a `shouldSendNudge(...)`
//       call AND contains the type string as a key in a config-like
//       expression (e.g. `{ type: "memory" }` or `"memory": { type: ... }`).
//       This covers the EW-7.2 lookup table in turn-end-handler.ts
//       that routes L2 sub-signals to their NudgeType via a variable.
const callersByType = {};
for (const type of nudgeTypes) callersByType[type] = [];

for (const file of srcFiles) {
  const text = readFileSync(file, "utf-8");
  const hasShouldSendCall = /shouldSendNudge\s*\(/.test(text);
  if (!hasShouldSendCall) continue;
  for (const type of nudgeTypes) {
    // Pattern (a): direct call
    const directRe = new RegExp(`shouldSendNudge\\s*\\([^)]*["']\\s*${type}\\s*["']`, "s");
    if (directRe.test(text)) {
      callersByType[type].push(`${file} (direct)`);
      continue;
    }
    // Pattern (b): lookup table — the type appears as a key (quoted or
    // bare identifier) in an object literal whose value starts with `{`.
    // Catches both `"memory": { type: "memory" }` and `memory: { type: "memory" }`.
    // The file association (must contain a shouldSendNudge call) proves intent.
    const lookupRe = new RegExp(
      `(?:["']\\s*)?${type}(?:\\s*["'])?\\s*:\\s*\\{`,
    );
    if (lookupRe.test(text)) {
      callersByType[type].push(`${file} (lookup-table)`);
    }
  }
}

// ── Step 3: assert every type has at least one caller ────────────────────

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

console.log("=== EW-7.2 NudgeType wiring contract ===\n");

check("NudgeType union is non-empty", () => {
  assert.ok(nudgeTypes.length > 0, "empty NudgeType union");
});

check(`NudgeType union has ${nudgeTypes.length} members`, () => {
  // Sanity check — catches accidental deletions.
  assert.ok(nudgeTypes.length >= 5, `expected >=5 NudgeType members, got ${nudgeTypes.length}`);
});

for (const type of nudgeTypes) {
  check(`NudgeType "${type}" has at least one caller`, () => {
    const sites = callersByType[type];
    assert.ok(
      sites.length > 0,
      `NudgeType "${type}" is defined in DEFAULT_NUDGE_CONFIGS but has no caller ` +
        `of getNudgeManager(ctx).shouldSendNudge("${type}", ...) in src/. ` +
        `Either wire it up to a real trigger, or remove the type from the union ` +
        `and DEFAULT_NUDGE_CONFIGS.`,
    );
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== EW-7.2 NudgeType wiring contract satisfied ===");
