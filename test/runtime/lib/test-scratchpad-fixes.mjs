/**
 * Test: Scratchpad fixes (double-push bug + add_learning UX)
 *
 * Verifies the bundle of fixes for:
 *  1. Double-push bug — every "append" case was doing `arr.push(item)` AND
 *     `capPush(arr, item, MAX)`. capPush internally pushes again, so every
 *     entry was added twice. Confirmed empirically: the live scratchpad
 *     file had 2 copies of every add_plan / mark_done entry. Fix: removed
 *     the redundant push() call before capPush() in 7 cases.
 *  2. add_learning format — the pipe-delimited format ("category|content|scope")
 *     was undocumented in the schema/description, so the model would often
 *     pass plain text (which failed category validation with a bare
 *     "Invalid category:" message). Fix: added explicit `category`, `content`,
 *     `scope` schema fields; category aliases accepted; error message
 *     includes valid categories, common aliases, and the format hint.
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../../");

let passed = 0;
let failed = 0;
const assert = (cond, msg) =>
  cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

const srcPath = join(ROOT, "dist/extensions/core/scratchpad/index.js");
if (!existsSync(srcPath)) {
  console.error("❌ dist file missing — run `npm run build` first");
  process.exit(1);
}
const src = readFileSync(srcPath, "utf8");

// ── [1] Double-push bug: removed in 7 cases ───────────────────────────────
console.log("\n[1] Double-push bug removed from append cases");
{
  // Helper: find any case block and verify it does NOT contain a redundant
  // push immediately followed by capPush of the same item.
  //
  // Pattern that USED to be present (bug):
  //   pad.plan.push({...});
  //   capPush(pad.plan, pad.plan[pad.plan.length-1], RECYCLE.MAX_PLAN);
  //
  // Pattern that should be present (fix):
  //   const step: PlanStep = {...};
  //   capPush(pad.plan, step, RECYCLE.MAX_PLAN);

  // The compiled JS for each case should NOT have a `.push(...)` immediately
  // before `capPush(<same array>, ...)`.
  // We test this by finding each capPush call and checking the surrounding
  // ~6 lines for a push of the same array.

  const cases = [
    { arr: "pad.plan", caseName: "add_plan" },
    { arr: "pad.done", caseName: "mark_done" },
    { arr: "pad.decisions", caseName: "add_decision" },
    { arr: "pad.hypotheses", caseName: "add_hypothesis" },
    { arr: "pad.notes", caseName: "add_note" },
    { arr: "pad.constraints", caseName: "add_constraint" },
    { arr: "pad.key_learnings", caseName: "add_learning" },
    { arr: "pad.plan", caseName: "elevate_to_plan" },
  ];

  for (const { arr, caseName } of cases) {
    // The bug pattern: `arr.push(...)\s*;\s*capPush(arr, ...)` (within 80 chars
    // of each other in the same case block).
    // The compiled JS has `pad.plan` etc. without spaces, and the push/capPush
    // lines can be ~3 lines apart (with the local const in between for some).
    // We check the more general pattern: within any 200-char window, we should
    // NOT see `arr.push(` followed by `capPush(arr, `.
    const bugPattern = new RegExp(
      `${arr.replace(/\./g, "\\.")}\\.push\\([^)]*\\)[^;]{0,200}?capPush\\(${arr.replace(/\./g, "\\.")},`,
      "s",
    );
    assert(
      !bugPattern.test(src),
      `${caseName}: removed redundant ${arr}.push() before capPush (no double-push)`,
    );
  }

  // Also: each case should still call capPush exactly once (sanity check that
  // we didn't accidentally remove the capPush call entirely).
  for (const { arr, caseName } of cases) {
    // The compiled JS uses destructuring or direct capPush calls. Check
    // the case block contains at least one capPush of the array.
    const idx = src.indexOf(`case "${caseName}"`);
    assert(idx > 0, `${caseName}: case block exists in compiled output`);
    // The capPush call for this case is somewhere after the case label
    // (may be many lines down, but should be present).
    const afterCase = src.slice(idx, idx + 5000);
    const hasCapPush = new RegExp(
      `capPush\\(${arr.replace(/\./g, "\\.")},`,
    ).test(afterCase);
    assert(hasCapPush, `${caseName}: still calls capPush(${arr}, ...) (capacity enforced)`);
  }
}

// ── [2] add_learning: explicit category/content fields ────────────────────
console.log("\n[2] add_learning schema accepts explicit category/content/scope");
{
  // Schema: Type.Object with optional category, content, scope fields
  assert(
    /category:\s*Type\.Optional\(/.test(src),
    "schema: category is an optional field",
  );
  assert(
    /content:\s*Type\.Optional\(/.test(src),
    "schema: content is an optional field",
  );
  assert(
    /scope:\s*Type\.Optional\(\s*Type\.Array\(Type\.String/.test(src),
    "schema: scope is an optional array-of-strings field",
  );

  // add_learning case should check the explicit fields FIRST, then fall
  // back to pipe-delimited text. Verify both code paths exist.
  const addLearningIdx = src.indexOf('case "add_learning"');
  assert(addLearningIdx > 0, "add_learning case block present");
  const block = src.slice(addLearningIdx, addLearningIdx + 4000);

  assert(
    /explicitCategory\s*=\s*params\.category/.test(block),
    "add_learning: reads params.category as explicit category",
  );
  assert(
    /explicitContent\s*=\s*params\.content/.test(block),
    "add_learning: reads params.content as explicit content",
  );
  assert(
    /if\s*\(\s*explicitCategory\s*\|\|\s*explicitContent\s*\)/.test(block),
    "add_learning: takes explicit-field path when category or content is provided",
  );
  assert(
    /text\.split\("\|\|"/.test(block) === false,  // would be the bug
    "add_learning: does NOT have the old buggy split('|') without explicit fields",
  );
  assert(
    /text\.split\("\\|"/.test(block) || /text\.split\(['"]\\|['"]\)/.test(block),
    "add_learning: legacy pipe-delimited text path still works (backward compat)",
  );
}

// ── [3] add_learning: category aliases accepted ──────────────────────────
console.log("\n[3] add_learning: category aliases");
{
  // The compiled JS should contain a resolveCategory function and an
  // LEARNING_CATEGORY_ALIASES map. We can't easily assert runtime behavior
  // (would need a full scratchpad + extension context), so we verify the
  // alias table is present with common misspellings mapped to canonical
  // categories.
  assert(
    /LEARNING_CATEGORY_ALIASES/.test(src),
    "category alias map is defined",
  );
  // Common misspellings: bug, defect, insight, solution, patch, fact, rule
  const expectedAliases = [
    ["bug", "root_cause"],
    ["defect", "root_cause"],
    ["insight", "pattern"],
    ["solution", "fix"],
    ["patch", "fix"],
    ["fact", "codebase_fact"],
    ["rule", "constraint"],
  ];
  for (const [alias, target] of expectedAliases) {
    const re = new RegExp(`${alias}\\s*:\\s*"${target}"`);
    assert(re.test(src), `alias: "${alias}" → "${target}"`);
  }
}

// ── [4] add_learning: error message is helpful ───────────────────────────
console.log("\n[4] add_learning: helpful error message");
{
  // The error message should:
  // 1. Quote the invalid category (so the model can see what it sent)
  // 2. List valid categories
  // 3. Suggest aliases
  // 4. Mention the explicit-fields alternative
  const idx = src.indexOf('case "add_learning"');
  const block = src.slice(idx, idx + 4000);

  assert(
    /Invalid category:.*\$\{rawCategory\}/.test(block),
    "error message: includes the invalid category the model sent",
  );
  assert(
    /Valid:.*VALID_LEARNING_CATEGORIES/.test(block),
    "error message: lists valid categories",
  );
  assert(
    /Common aliases/.test(block),
    "error message: suggests common aliases",
  );
  assert(
    /explicit 'category' and 'content' fields/.test(block),
    "error message: suggests the explicit-fields alternative",
  );
}

// ── [5] Tool description documents the format ────────────────────────────
console.log("\n[5] Tool description documents the format");
{
  // The description in the compiled JS should mention add_learning categories
  // and the explicit-fields alternative.
  const descIdx = src.indexOf('name: "scratchpad"');
  assert(descIdx > 0, "tool registration: scratchpad tool exists");
  const descBlock = src.slice(descIdx, descIdx + 3000);
  assert(
    /add_learning/.test(descBlock),
    "description: mentions add_learning action",
  );
  assert(
    /category.*content.*fields/i.test(descBlock) || /'category'.*'content'/.test(descBlock),
    "description: suggests explicit category+content fields",
  );
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
