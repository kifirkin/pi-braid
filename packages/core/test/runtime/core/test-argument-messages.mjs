/**
 * Tool-argument messages — a rejection names what it would have accepted.
 *
 * Incident shape: a tool call is refused for a value the model guessed, and
 * the refusal says only that validation failed ("must be equal to one of the
 * allowed values", "must have required properties decision"). The model has
 * to guess again. The accepted values already exist in the tool's own schema;
 * the refusal should read them there.
 *
 * Every case below runs the REAL pi path — `prepareArguments` first, then the
 * schema validator pi itself runs (from `@earendil-works/pi-ai`) — so a pass
 * proves the message reaches a model, not merely that a helper returns a
 * string.
 *
 * The `declares` control is the one that keeps this honest: each message's
 * value list must equal the list the schema carries. A hard-coded second copy
 * of the values drifts from the schema, and this fixture turns that drift into
 * a red run instead of a wrong whisper.
 *
 * Run: node test/runtime/core/test-argument-messages.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";

// Pin the persistent tree BEFORE the dist imports: braid-settings bakes its
// settings path from homedir() at module-eval time.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "braid-argmsg-home-"));
const BRAID_HOME = mkdtempSync(join(tmpdir(), "braid-argmsg-braid-"));
process.env.HOME = FAKE_HOME;
process.env.BRAID_HOME = BRAID_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST = join(ROOT, "dist");

const { validateToolArguments } = await import("@earendil-works/pi-ai");
const { createThinkTool } = await import(
  join(DIST, "extensions", "cognitive", "metacognition", "handlers", "think.js")
);
const { THINK_TYPES } = await import(
  join(DIST, "extensions", "cognitive", "metacognition", "handlers", "think-budget.js")
);
const { default: skillsToolExtension } = await import(
  join(DIST, "extensions", "core", "skills-tool", "index.js")
);

console.log("=== tool-argument messages ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(` [v] ${name}`);
  } catch (e) {
    failed++;
    console.log(` [x] ${name}: ${e.message}`);
  }
}

/** Minimal ExtensionAPI double: captures every registered tool. */
function toolsOf(factory) {
  const tools = [];
  const pi = {
    registerTool: (tool) => tools.push(tool),
    on: () => () => {},
    getAllTools: () => tools,
    getActiveTools: () => tools.map((t) => t.name),
    registerCommand: () => {},
    getSettings: () => ({}),
    sendMessage: () => {},
    appendEntry: () => {},
  };
  factory(pi);
  return tools;
}

const think = createThinkTool();
const skillsTools = toolsOf(skillsToolExtension);
const listSkills = skillsTools.find((t) => t.name === "list_skills");
assert.ok(listSkills, "list_skills is registered by the skills-tool extension");

/**
 * The path a model's arguments take inside pi: `prepareArguments` (the tool's
 * own normalisation seat, which runs inside the same guarded block as
 * validation), then the schema check pi performs.
 */
function call(tool, args) {
  const prepared = tool.prepareArguments ? tool.prepareArguments(args) : args;
  return validateToolArguments(tool, { name: tool.name, arguments: prepared });
}

/** The refusal text a model would read, or null when the call is accepted. */
function refusal(tool, args) {
  try {
    call(tool, args);
    return null;
  } catch (e) {
    return e.message;
  }
}

/** Every value a schema node accepts, read from the node. */
function declaredValues(node) {
  if (!node) return [];
  if (typeof node.const === "string") return [node.const];
  if (Array.isArray(node.enum)) return node.enum;
  const branches = node.anyOf ?? node.oneOf ?? [];
  return branches.flatMap(declaredValues);
}

// ── list_skills: a pager-only call is a listing call ────────────────────────

await test("list_skills: paging parameters without an action behave as list", async () => {
  const accepted = call(listSkills, { page: 2, pageSize: 5, sectionsMax: 2 });
  assert.equal(accepted.action, "list", `action defaulted (got ${JSON.stringify(accepted.action)})`);
  assert.equal(accepted.page, 2, "paging parameters survive the default");
});

await test("list_skills: an explicit action still validates", async () => {
  assert.equal(call(listSkills, { action: "list" }).action, "list");
  const msg = refusal(listSkills, { action: "query" });
  assert.ok(msg, "an unknown action is still refused");
  assert.match(msg, /list_skills/, `refusal names the tool: ${msg}`);
  for (const value of declaredValues(listSkills.parameters.properties.action)) {
    assert.ok(msg.includes(value), `refusal names the accepted action "${value}": ${msg}`);
  }
});

await test("list_skills: a guessed rank lists both ranks", async () => {
  const msg = refusal(listSkills, { action: "list", rank: "tree" });
  assert.ok(msg, "an unknown rank is refused");
  const values = declaredValues(listSkills.parameters.properties.rank);
  assert.equal(values.length, 2, `rank declares two values (got ${values.join(", ")})`);
  for (const value of values) {
    assert.ok(msg.includes(value), `refusal names the accepted rank "${value}": ${msg}`);
  }
});

// ── think: the enum and the required field ─────────────────────────────────

await test("think: a guessed type lists every declared type", async () => {
  const msg = refusal(think, { decision: "do the thing", type: "observaton" });
  assert.ok(msg, "an unknown type is refused");
  for (const value of THINK_TYPES) {
    assert.ok(msg.includes(value), `refusal names the declared type "${value}": ${msg}`);
  }
  const declared = declaredValues(think.parameters.properties.type);
  assert.deepEqual(
    [...declared].sort(),
    [...THINK_TYPES].sort(),
    "the schema's own type list is the one the message must carry",
  );
});

await test("think: a missing decision says it is required and what it is for", async () => {
  const msg = refusal(think, { type: "insight" });
  assert.ok(msg, "a call without decision is refused");
  assert.match(msg, /decision/, `refusal names the field: ${msg}`);
  assert.match(msg, /required/i, `refusal says required: ${msg}`);
  const purpose = think.parameters.properties.decision.description;
  assert.ok(purpose, "the schema describes the field");
  assert.ok(msg.includes(purpose), `refusal carries the schema's own purpose text: ${msg}`);
});

await test("think: accepted calls and pi's own range errors are untouched", async () => {
  const ok = call(think, { decision: "ship it", type: "conclusion", depth: "deep", confidence: 0.6 });
  assert.equal(ok.type, "conclusion");
  const msg = refusal(think, { decision: "ship it", confidence: 1.5 });
  assert.match(msg, /confidence/, `a non-list constraint is still pi's to report: ${msg}`);
  assert.match(msg, /must be <= 1/, `pi's own range text survives: ${msg}`);
});

// ── no second copy of the accepted values ──────────────────────────────────

await test("messages derive their values from the schema, not a copy", async () => {
  const cases = [
    [listSkills, { action: "list", rank: "nope" }, "rank"],
    [listSkills, { action: "nope" }, "action"],
    [think, { decision: "x", type: "nope" }, "type"],
    [think, { decision: "x", depth: "nope" }, "depth"],
  ];
  for (const [tool, args, key] of cases) {
    const msg = refusal(tool, args);
    assert.ok(msg, `${tool.name}.${key} refusal missing`);
    const values = declaredValues(tool.parameters.properties[key]);
    assert.ok(values.length >= 1, `${tool.name}.${key} declares a list`);
    for (const value of values) {
      assert.ok(msg.includes(value), `${tool.name}.${key} message carries "${value}": ${msg}`);
    }
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
