/**
 * Regression fixture: scratchpad remove_constraint accepts the documented `id`.
 *
 * Coverage:
 * - remove_constraint honors the canonical id-or-text argument (`params.id ?? text`)
 *   that every sibling remove_* handler receives: a constraint present in the pad is
 *   removed when the caller passes only `id` (the schema-documented parameter). The
 *   pre-fix dispatch entry read `params.constraint_id ?? text` instead, so this exact
 *   call answered "Constraint not found: " for a constraint that existed.
 * - the documented text fallback works for constraints: an exact `description` match
 *   removes the entry, because Constraint carries `description`, not `text`.
 * - an unknown id still answers "Constraint not found: <id>" with the read hint.
 * - the legacy `constraint_id` parameter keeps working.
 *
 * Run: node test/runtime/memory/test-scratchpad-remove-constraint.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// ── Hermetic settings isolation (same seam as sibling fixtures) ──
const FAKE_HOME = mkdtempSync(join(tmpdir(), "scratchpad-remove-constraint-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), JSON.stringify({}));

const { ACTION_DISPATCH } = await import(
  join(ROOT, "dist/extensions/memory/scratchpad/handlers.js")
);

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok   ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}\n     ${err.message}`);
  }
}

/** Minimal TaskScratchpad: only the collections the constraint path touches. */
function freshPad() {
  const now = Date.now();
  return {
    goal: "test",
    prior_goal: "",
    plan: [],
    done: [],
    decisions: [],
    hypotheses: [],
    notes: [],
    session: {
      turn: 0,
      phase: "executing",
      mode: "normal",
      last_compact_turn: 0,
      session_start: now,
      updated_at: now,
    },
    constraints: [],
    key_learnings: [],
    updatedAt: now,
    projectSlug: "test-remove-constraint",
  };
}

/** The tool computes this once and hands it to the dispatch entry (index.ts). */
function dispatchRemoveConstraint(pad, params, text = "") {
  const idOrText = params.id ?? text;
  return ACTION_DISPATCH.remove_constraint(pad, params, text, idOrText, "");
}

function seed(pad, id, description) {
  pad.constraints.push({
    id,
    type: "custom",
    description,
    added_at: Date.now(),
    expires_at: 0,
    acknowledged: false,
  });
}

await test("remove_constraint removes by the documented id parameter", async () => {
  const pad = freshPad();
  seed(pad, "con-abc123", "keep the repo private until publication");
  const r = await dispatchRemoveConstraint(pad, { id: "con-abc123" });
  assert.equal(pad.constraints.length, 0, `expected removal, got: ${r.resultText}`);
  assert.match(r.resultText, /^Constraint removed: con-abc123$/);
});

await test("remove_constraint falls back to an exact description match", async () => {
  const pad = freshPad();
  seed(pad, "con-def456", "no package-lock edits");
  const r = await dispatchRemoveConstraint(pad, { id: "no package-lock edits" });
  assert.equal(pad.constraints.length, 0, `expected description match, got: ${r.resultText}`);
});

await test("unknown id reports not-found with the read hint", async () => {
  const pad = freshPad();
  seed(pad, "con-ghi789", "stays");
  const r = await dispatchRemoveConstraint(pad, { id: "con-nope" });
  assert.equal(pad.constraints.length, 1);
  assert.match(r.resultText, /^Constraint not found: con-nope/);
  assert.match(r.resultText, /scratchpad read/);
});

await test("legacy constraint_id parameter still removes", async () => {
  const pad = freshPad();
  seed(pad, "con-jkl012", "legacy path");
  const r = await ACTION_DISPATCH.remove_constraint(pad, { constraint_id: "con-jkl012" }, "", "");
  assert.equal(pad.constraints.length, 0, `expected legacy removal, got: ${r.resultText}`);
});

console.log(`\n# tests ${passed + failed}\n# pass ${passed}\n# fail ${failed}`);
process.exit(failed === 0 ? 0 : 1);
