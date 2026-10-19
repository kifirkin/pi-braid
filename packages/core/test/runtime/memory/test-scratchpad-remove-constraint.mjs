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
 * - the blank-selector boundary of the same id-or-text read, driven through
 *   the registered tool: `mark_done` with a blank `id` finds the plan step by
 *   its text (pre-fix it fell into the legacy add-a-done path and left the
 *   step open), an unmatched text refuses by name, and `read` with a blank
 *   `filter.untilTurn` (converted to 0 by argument validation) applies no turn
 *   filter instead of dropping every item that has a turn.
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

// ── Blank-selector boundary: mark_done's id, read's untilTurn ───────────────
// These reads live in index.ts (the tool boundary), not in the dispatch entries
// above: the tool computes `idOrText` once and hands it down, and the framework
// converts a blank untilTurn to 0 before the handler runs. Driving the
// registered tool is the only way to pin both reads.

const { default: scratchpadExtension } = await import(
  join(ROOT, "dist/extensions/memory/scratchpad/index.js")
);
const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");

function fakePi() {
  const tools = new Map();
  return {
    tools,
    on() {},
    registerTool(def) {
      tools.set(def.name, def);
    },
  };
}

const padPi = fakePi();
scratchpadExtension(padPi);
const padTool = padPi.tools.get("scratchpad");
assert.ok(padTool, "scratchpad tool must be registered");

let padSeq = 0;
/** A per-case cwd gives each case its own pad (the persistence slug is the cwd). */
function makePadCtx() {
  padSeq++;
  const id = `blank-pad-${padSeq}`;
  return {
    cwd: `/tmp/blank-selector-fixture-${padSeq}`,
    mode: "test",
    hasUI: false,
    sessionManager: { getSessionFile: () => `/tmp/${id}.jsonl`, getSessionId: () => id },
  };
}

/** Drive raw arguments through the framework validation, as pi-core does. */
function validatedPadArgs(raw) {
  return validateToolArguments(
    { name: padTool.name, parameters: padTool.parameters },
    { name: padTool.name, arguments: raw },
  );
}

async function runPad(ctx, raw) {
  return padTool.execute("pad-1", validatedPadArgs(raw), undefined, undefined, ctx);
}

/**
 * Advance the pad's turn. `turn`/`phase`/`mode` are read from the raw record by
 * update_session, but they are not declared schema parameters, so this setup
 * call uses the direct execute path like the pre-existing dispatch calls above.
 */
async function setPadTurn(ctx, turn) {
  return padTool.execute("pad-turn", { action: "update_session", turn }, undefined, undefined, ctx);
}

function planLines(result) {
  return result.content[0].text.split("\n").filter((l) => l.includes("(pl-"));
}

await test("mark_done with a blank id completes the plan step by its text", async () => {
  const ctx = makePadCtx();
  await setPadTurn(ctx, 5);
  const text = "the step a blank id must still close";
  const added = await runPad(ctx, { action: "add_plan", text });
  assert.match(added.content[0].text, /Step added/);
  const marked = await runPad(ctx, { action: "mark_done", id: "", text });
  assert.match(marked.content[0].text, new RegExp(`^Completed: ${text}`));
  const lines = planLines(await runPad(ctx, { action: "read" }));
  assert.equal(lines.length, 1, `expected one plan line, got: ${lines.join(" | ")}`);
  assert.match(lines[0], /\[ok\]/, `plan step must be closed, got: ${lines[0]}`);
});

await test("mark_done control: a real id still completes its plan step", async () => {
  const ctx = makePadCtx();
  await setPadTurn(ctx, 3);
  const added = await runPad(ctx, { action: "add_plan", text: "the step a real id closes" });
  const id = added.content[0].text.match(/\(id: (pl-[^)]+)\)/)?.[1];
  assert.ok(id, `no plan id in: ${added.content[0].text}`);
  await runPad(ctx, { action: "mark_done", id });
  const lines = planLines(await runPad(ctx, { action: "read" }));
  assert.equal(lines.length, 1);
  assert.match(lines[0], /\[ok\]/);
});

await test("mark_done with a blank id and an unmatched text refuses by name", async () => {
  const ctx = makePadCtx();
  await runPad(ctx, { action: "add_plan", text: "a step that is never matched" });
  const result = await runPad(ctx, { action: "mark_done", id: "", text: "no such step" });
  assert.match(result.content[0].text, /Plan step not found: no such step/);
});

await test("mark_done with both selectors blank keeps the refusal by name", async () => {
  const ctx = makePadCtx();
  const result = await runPad(ctx, { action: "mark_done", id: "", text: "" });
  assert.match(result.content[0].text, /mark_done requires an 'id'.*or 'text'/);
});

await test("read with a blank untilTurn (converted 0) applies no turn filter", async () => {
  const ctx = makePadCtx();
  await setPadTurn(ctx, 4);
  await runPad(ctx, { action: "add_plan", text: "turn-four step" });
  await runPad(ctx, { action: "add_note", text: "turn-four note" });
  const args = validatedPadArgs({
    action: "read",
    filter: { sinceTurn: "", untilTurn: "", limit: "" },
  });
  assert.equal(args.filter.untilTurn, 0, "the framework converts the blank untilTurn to 0");
  const result = await padTool.execute("pad-2", args, undefined, undefined, ctx);
  const text = result.content[0].text;
  assert.match(text, /turn-four step/, `the pad must still show the step, got:\n${text}`);
  assert.match(text, /turn-four note/);
});

await test("read control: a real untilTurn still filters later items", async () => {
  const ctx = makePadCtx();
  await setPadTurn(ctx, 4);
  await runPad(ctx, { action: "add_note", text: "turn-four note" });
  const result = await runPad(ctx, { action: "read", filter: { untilTurn: 2 } });
  assert.doesNotMatch(result.content[0].text, /turn-four note/);
});

console.log(`\n# tests ${passed + failed}\n# pass ${passed}\n# fail ${failed}`);
process.exit(failed === 0 ? 0 : 1);
