/**
 * Enforcement Substate Import Direction Test
 *
 * Asserts the import-direction contract documented in
 * `src/extensions/enforcement/AGENTS.md`:
 *
 *   "Import contract:
 *    - `state.ts` imports sub-state factories/resets from sub-state files.
 *    - Sub-state files do **NOT** import from `state.ts`.
 *    - `enforcement-types.ts` is the only file imported by both `state.ts`
 *      and the sub-state files that need `EnforcementState` or `ENFORCEMENT_PARAMS`."
 *
 * Background: a circular dependency between `state.ts` and
 * `session-state.ts` (or `verification-judge-state.ts`) was the original
 * reason `enforcement-types.ts` was extracted. Adding an import from
 * `state.ts` back into a sub-state file would re-introduce that cycle,
 * silently breaking the extension.
 *
 * The AGENTS.md claims a structural test exists at this path. Until
 * 2026-06-13, it didn't. This file implements what the docs promised.
 */

import { strict as assert } from "assert";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const ENFORCEMENT_DIR = join(ROOT, "src", "extensions", "enforcement");
const SUBSTATE_DIR = join(ENFORCEMENT_DIR, "substate");
const STATE_FILE = join(ENFORCEMENT_DIR, "state.ts");
const TYPES_FILE = join(ENFORCEMENT_DIR, "enforcement-types.ts");

// ── Helpers ────────────────────────────────────────────────────────────────

function readImports(filePath) {
  const src = readFileSync(filePath, "utf-8");
  // Match import statements that target a relative path.
  // Skips: type-only imports (we still want to catch them but treat
  // them as type-only — not runtime circular dep risk).
  const importRe = /import\s+(?:type\s+)?{?[^}]*}?\s+from\s+["']([^"']+)["']/g;
  const imports = [];
  let m;
  while ((m = importRe.exec(src)) !== null) {
    const isTypeOnly = /^import\s+type\b/.test(m[0]);
    imports.push({ path: m[1], isTypeOnly });
  }
  return imports;
}

function listSubstateFiles() {
  return readdirSync(SUBSTATE_DIR)
    .filter((f) => f.endsWith("-state.ts"))
    .map((f) => join(SUBSTATE_DIR, f));
}

// ── Tests ──────────────────────────────────────────────────────────────────

console.log("Test 1: No sub-state file imports from `state.ts`");
{
  const substateFiles = listSubstateFiles();
  let violations = 0;
  for (const file of substateFiles) {
    const imports = readImports(file);
    const stateImports = imports.filter((i) =>
      i.path === "../state.js" || i.path === "../state",
    );
    if (stateImports.length > 0) {
      console.log(
        `  ✗ ${file.replace(ROOT + "/", "")} imports from "${stateImports[0].path}"`,
      );
      violations++;
    }
  }
  assert.strictEqual(
    violations,
    0,
    `${violations} sub-state file(s) import from state.ts. This re-introduces the circular ` +
      `dependency that enforcement-types.ts was extracted to break. Move shared types/params ` +
      `to enforcement-types.ts and import from there instead.`,
  );
  console.log(
    `✅ PASS: ${substateFiles.length} sub-state file(s) checked, none import from state.ts`,
  );
}

console.log("\nTest 2: `state.ts` imports sub-state factories (downward references allowed)");
{
  const imports = readImports(STATE_FILE);
  const substateImports = imports.filter(
    (i) => i.path.includes("./substate/") && i.path.endsWith(".js"),
  );
  assert.ok(
    substateImports.length >= 7,
    `state.ts should import from at least 7 sub-state files. Found ${substateImports.length}.`,
  );
  console.log(
    `✅ PASS: state.ts imports ${substateImports.length} sub-state module(s) (expected ≥7)`,
  );
}

console.log("\nTest 3: `state.ts` imports shared types from `enforcement-types.ts`");
{
  const imports = readImports(STATE_FILE);
  const typesImports = imports.filter(
    (i) => i.path === "./enforcement-types.js" || i.path === "./enforcement-types",
  );
  assert.ok(
    typesImports.length > 0,
    `state.ts must import from enforcement-types.ts to share EnforcementState/ENFORCEMENT_PARAMS. ` +
      `Found 0 imports.`,
  );
  console.log(
    `✅ PASS: state.ts imports enforcement-types.ts (${typesImports.length} import statement(s))`,
  );
}

console.log("\nTest 4: Sub-state files that need EnforcementState/ENFORCEMENT_PARAMS import them from enforcement-types.ts");
{
  const substateFiles = listSubstateFiles();
  let checkedCount = 0;
  for (const file of substateFiles) {
    let src = readFileSync(file, "utf-8");
    // Strip comments to avoid matching identifier names mentioned only in docs.
    // Replace `// ...` line comments and `/* ... */` block comments with spaces.
    src = src.replace(/\/\*[\s\S]*?\*\//g, " ");
    src = src.replace(/\/\/[^\n]*/g, " ");
    const needsTypes =
      /\bEnforcementState\b/.test(src) || /\bENFORCEMENT_PARAMS\b/.test(src);
    if (!needsTypes) continue;
    checkedCount++;
    const imports = readImports(file);
    const typesImports = imports.filter(
      (i) => i.path === "../enforcement-types.js" || i.path === "../enforcement-types",
    );
    assert.ok(
      typesImports.length > 0,
      `${file.replace(ROOT + "/", "")} references EnforcementState/ENFORCEMENT_PARAMS in code ` +
        `but does not import from enforcement-types.ts. It should — that's the file's only purpose.`,
    );
  }
  assert.ok(
    checkedCount > 0,
    `Expected at least one sub-state file to reference EnforcementState/ENFORCEMENT_PARAMS in code. ` +
      `Found 0. Test may be vacuous.`,
  );
  console.log(
    `✅ PASS: ${checkedCount} sub-state file(s) that need shared types import from enforcement-types.ts`,
  );
}

console.log("\n🎯 All enforcement import-direction tests passed!");
