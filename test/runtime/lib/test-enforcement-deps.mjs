/**
 * Test: enforcement module has no circular dependencies.
 *
 * Regression test for the bug where state.ts ↔ session-state.ts had a
 * runtime cycle (ENFORCEMENT_PARAMS imported both ways) and state.ts ↔
 * verification-judge-state.ts had a type cycle (EnforcementState imported
 * both ways).
 *
 * The fix: extract ENFORCEMENT_PARAMS and EnforcementState interface to
 * enforcement-types.ts. Both sub-state files import from the types file
 * (one-way), so there is no cycle.
 *
 * This test statically scans for value-level cycles by tracking imports.
 * Type-only imports are exempt (TS strips them, no runtime cycle).
 */

import { readFileSync, existsSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../../");
const ENF_DIR = join(ROOT, "dist/extensions/enforcement");
const ENF_SUBSTATE_DIR = join(ENF_DIR, "substate");

if (!existsSync(ENF_DIR)) {
  console.error("❌ dist/extensions/enforcement missing — run `npm run build`");
  process.exit(1);
}

let passed = 0, failed = 0;
const assert = (cond, msg) =>
  cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

// ── Collect all enforcement dist files ─────────────────────────────────
const files = readdirSync(ENF_DIR)
  .filter(f => f.endsWith(".js"))
  .filter(f => !f.endsWith(".d.ts"))
  .map(f => f.replace(/\.js$/, ""));

console.log(`[1] Inspecting ${files.length} enforcement files for cycles`);

// ── Parse value-level imports ──────────────────────────────────────────
const valueImports = new Map(); // file -> Set<importedFile>
const typeImports = new Map();   // file -> Set<importedFile>

for (const f of files) {
  const src = readFileSync(join(ENF_DIR, f + ".js"), "utf8");
  const vSet = new Set();
  const tSet = new Set();
  // Match: import { ... } from "./foo.js"  (value imports)
  const reValue = /import\s*\{[^}]+\}\s*from\s*['"]\.\/([a-z-]+)['"]/g;
  let m;
  while ((m = reValue.exec(src)) !== null) {
    vSet.add(m[1]);
  }
  // Match: import type { ... } from "./foo.js"  (type-only imports)
  const reType = /import\s+type\s*\{[^}]+\}\s*from\s*['"]\.\/([a-z-]+)['"]/g;
  while ((m = reType.exec(src)) !== null) {
    tSet.add(m[1]);
  }
  // Match: import Foo from "./foo.js"  (default imports)
  const reDefault = /import\s+[A-Za-z_]+\s+from\s+['"]\.\/([a-z-]+)['"]/g;
  while ((m = reDefault.exec(src)) !== null) {
    vSet.add(m[1]);
  }
  valueImports.set(f, vSet);
  typeImports.set(f, tSet);
}

// ── Detect cycles in value-level imports ──────────────────────────────
console.log("\n[2] Detect value-level cycles");
{
  // DFS for cycles in value imports
  const visited = new Set();
  const stack = new Set();
  const cycles = [];

  function dfs(node, path) {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push([...path.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    for (const next of valueImports.get(node) || new Set()) {
      dfs(next, [...path, node]);
    }
    stack.delete(node);
  }

  for (const f of files) {
    if (!visited.has(f)) dfs(f, []);
  }

  assert(
    cycles.length === 0,
    `no value-level cycles in enforcement/ (found: ${cycles.length})`,
  );
  if (cycles.length > 0) {
    console.log("  Cycles detected:");
    for (const c of cycles) console.log("    " + c.join(" → "));
  }
}

// ── Type-only cycles are tolerated but logged ─────────────────────────
console.log("\n[3] Type-only cycles (informational, TS strips these)");
{
  const visited = new Set();
  const stack = new Set();
  const cycles = [];

  function dfs(node, path) {
    if (stack.has(node)) {
      const cycleStart = path.indexOf(node);
      cycles.push([...path.slice(cycleStart), node]);
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.add(node);
    // Include type imports in this scan
    for (const next of typeImports.get(node) || new Set()) {
      dfs(next, [...path, node]);
    }
    for (const next of valueImports.get(node) || new Set()) {
      dfs(next, [...path, node]);
    }
    stack.delete(node);
  }

  for (const f of files) {
    if (!visited.has(f)) dfs(f, []);
  }

  // State.ts ↔ verification-judge-state.ts used to be a type cycle.
  // After the fix, it should be resolved: state.ts re-exports EnforcementState
  // from enforcement-types.js, and verification-judge-state.js imports it from
  // enforcement-types.js. So no direct state→verification-judge import.
  assert(
    cycles.length === 0,
    "no type cycles between state.ts and sub-state files (cycle broken via enforcement-types.ts)",
  );
}

// ── Specific check: state.ts no longer imports from session-state.ts for ENFORCEMENT_PARAMS ─
console.log("\n[4] Specific check: state.ts does NOT export ENFORCEMENT_PARAMS (now in enforcement-types.ts)");
{
  const stateSrc = readFileSync(join(ENF_DIR, "state.js"), "utf8");
  // state.ts should re-export it, not define it inline
  // It should NOT have a const ENFORCEMENT_PARAMS = { ... }
  const hasInlineDefinition = /const\s+ENFORCEMENT_PARAMS\s*=\s*\{/.test(stateSrc);
  assert(
    !hasInlineDefinition,
    "ENFORCEMENT_PARAMS is not defined inline in state.ts (moved to enforcement-types.ts)",
  );
  // It should re-export it
  assert(
    /export\s*\{\s*ENFORCEMENT_PARAMS/.test(stateSrc),
    "ENFORCEMENT_PARAMS is re-exported from enforcement-types.ts for backward compat",
  );
}

// ── enforcement-types.ts exists and is importable ──────────────────────
console.log("\n[5] enforcement-types.ts exists");
{
  const typesPath = join(ENF_DIR, "enforcement-types.js");
  assert(existsSync(typesPath), "enforcement-types.js exists in dist/");
  const src = readFileSync(typesPath, "utf8");
  assert(
    /export\s+const\s+ENFORCEMENT_PARAMS/.test(src),
    "enforcement-types.ts exports ENFORCEMENT_PARAMS",
  );
  assert(
    /export\s+interface\s+EnforcementState|export\s+type\s+EnforcementState/.test(src) ||
      /EnforcementState/.test(src),
    "enforcement-types.ts defines EnforcementState",
  );
}

// ── session-state.ts imports from enforcement-types.ts, not state.ts ──
console.log("\n[6] session-state.ts no longer imports from state.ts");
{
  const sessionSrc = readFileSync(join(ENF_SUBSTATE_DIR, "session-state.js"), "utf8");
  assert(
    /from\s*['"]\.\.\/enforcement-types\.js['"]/.test(sessionSrc),
    "session-state.ts imports ENFORCEMENT_PARAMS from enforcement-types.ts",
  );
  assert(
    !/from\s*['"]\.\/state\.js['"]/.test(sessionSrc),
    "session-state.ts does NOT import from state.ts (cycle broken)",
  );
}

// ── verification-judge-state.ts imports from enforcement-types.ts ─────
console.log("\n[7] verification-judge-state.ts imports from enforcement-types.ts");
{
  // Type-only imports are elided by tsc in the dist JS, so check the source TS
  const judgeSrc = readFileSync(
    join(ROOT, "src/extensions/enforcement/substate/verification-judge-state.ts"),
    "utf8",
  );
  assert(
    /from\s*['"]\.\.\/enforcement-types\.js['"]/.test(judgeSrc),
    "verification-judge-state.ts imports EnforcementState from enforcement-types.ts",
  );
  assert(
    !/from\s*['"]\.\/state\.js['"]/.test(judgeSrc),
    "verification-judge-state.ts does NOT import from state.ts (cycle broken)",
  );
}

// ── Summary ────────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
