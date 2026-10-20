/**
 * Fixture: blank selectors read as absent for `context_inspect` and
 * `explore_paths`.
 *
 * A client that emits every schema key sends "" for the keys it does not use.
 * Framework validation converts "" to 0 for `Type.Optional(Type.Number())` and
 * leaves blank strings intact. Before the fix:
 *   - `context_inspect` detail=prune read the converted 0 as the minimum age,
 *     and `age >= 0` admits every candidate: the documented 5-turn floor
 *     disabled itself, so the dry run listed recent entries as prunable;
 *   - `explore_paths` accepted a blank required hypothesis, searched for
 *     nothing, and answered a report whose only content was "No useful
 *     keywords found" - read as "no evidence", not as an unusable call.
 *
 * After the fix a blank `minAge` applies the documented 5 and a blank required
 * hypothesis is refused by name. The optional third hypothesis is absent when
 * blank. Controls keep the fix from becoming a blanket default or refusal: a
 * real `minAge` still filters, real hypotheses still search, a real third
 * hypothesis still runs.
 *
 * Run: node test/runtime/memory/test-blank-inspect-and-explore.mjs
 *      (after npm run build - this test reads dist, not src)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.HOME = mkdtempSync(join(tmpdir(), "blank-inspect-memory-"));
process.env.BRAID_HOME = mkdtempSync(join(tmpdir(), "blank-inspect-memory-braid-"));

const { registerContextInspect } = await import(
  "../../../dist/extensions/memory/context-manager/handlers/tools/context-inspect.js"
);
const { createExplorePathsTool } = await import(
  "../../../dist/extensions/memory/memory-agent-bridge/explore-paths.js"
);
const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");

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

/** Drive raw arguments through the framework's own conversion, as pi-core does before a handler runs. */
function validated(tool, raw) {
  return validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    { name: tool.name, arguments: raw },
  );
}

// ── context_inspect: a blank minAge applies the documented floor ───────────

console.log("=== context_inspect: a blank minAge applies the documented 5 ===\n");

/**
 * A linear branch of EIGHT entries. analyzeSession()'s candidate age is
 * `branch.length - 1 - i`, so the first five entries (ages 7..3) are prune
 * candidates and the last three (ages 2..0) are too recent to be scored.
 * The ages straddle the documented 5-turn floor: 3 candidates at >= 5,
 * 5 candidates at >= 3.
 */
function makeBranch(length = 8) {
  return Array.from({ length }, (_, i) => ({
    id: `entry-${i}`,
    type: "message",
    message: {
      role: "assistant",
      // Under 50 chars of text: "assistant message with no substantive text",
      // which is what makes the entry a candidate.
      content: [{ type: "text", text: "ok" }],
      timestamp: 1_700_000_000_000 + i,
    },
  }));
}

function inspectCtx() {
  const file = "blank-inspect.jsonl";
  return {
    cwd: process.env.BRAID_HOME,
    mode: "test",
    hasUI: false,
    model: undefined,
    sessionManager: {
      getSessionFile: () => file,
      getSessionId: () => file,
      getLabel: () => undefined,
      getBranch: () => makeBranch(),
      getTree: () => [],
    },
  };
}

function inspectTool() {
  const pi = {
    tools: [],
    registerTool(tool) {
      this.tools.push(tool);
    },
    on() {},
  };
  registerContextInspect(pi);
  const tool = pi.tools.find((t) => t.name === "context_inspect");
  assert.ok(tool, "context_inspect registered");
  return tool;
}

await test("blank minAge applies the documented 5-turn floor", async () => {
  const tool = inspectTool();
  const args = await validated(tool, { detail: "prune", minAge: "" });
  assert.equal(args.minAge, 0, "the framework converts the blank minAge to 0 (tested path)");
  const result = await tool.execute("ci1", args, null, null, inspectCtx());
  assert.equal(
    result.details.candidatesFound,
    3,
    "the documented floor filters the two candidates younger than 5 turns",
  );
  assert.match(result.content[0].text, /## Context Prune - 3 of 3 candidates/);
});

await test("control: a real minAge still filters", async () => {
  const tool = inspectTool();
  const atSix = await tool.execute(
    "ci2",
    await validated(tool, { detail: "prune", minAge: 6 }),
    null,
    null,
    inspectCtx(),
  );
  assert.equal(atSix.details.candidatesFound, 2, "ages 7 and 6 only");

  const atThree = await tool.execute(
    "ci3",
    await validated(tool, { detail: "prune", minAge: 3 }),
    null,
    null,
    inspectCtx(),
  );
  assert.equal(atThree.details.candidatesFound, 5, "every scored candidate");
});

await test("control: an omitted minAge agrees with the blank one", async () => {
  const tool = inspectTool();
  const result = await tool.execute(
    "ci4",
    await validated(tool, { detail: "prune" }),
    null,
    null,
    inspectCtx(),
  );
  assert.equal(result.details.candidatesFound, 3);
});

// ── explore_paths: a blank required hypothesis is refused by name ──────────

console.log("\n=== explore_paths: a blank required hypothesis is refused ===\n");

const SEARCH_ROOT = mkdtempSync(join(tmpdir(), "blank-explore-root-"));
writeFileSync(
  join(SEARCH_ROOT, "parser.ts"),
  "export function clampOffset(offset: number, max: number): number {\n  return Math.min(offset, max);\n}\n",
);

const REAL_ONE =
  "The bug might be in parser.ts because the offset is never clamped to the buffer length";
const REAL_TWO = "The bug might be in parser.ts because the guard runs after the slice";

const explore = createExplorePathsTool();
const exploreCtx = { cwd: SEARCH_ROOT, sessionManager: { getSessionId: () => "blank-explore" } };

await test("blank hypothesis_1 is refused by name", async () => {
  const args = await validated(explore, {
    hypothesis_1: "",
    hypothesis_2: REAL_TWO,
    searchRoot: SEARCH_ROOT,
  });
  assert.equal(args.hypothesis_1, "", "a blank string reaches the handler unchanged (tested path)");
  const result = await explore.execute("ex1", args, null, null, exploreCtx);
  assert.equal(result.details.error, "missing_hypothesis", "the refusal names the missing input");
  assert.deepEqual(result.details.blank, ["hypothesis_1"]);
  assert.match(result.content[0].text, /requires a non-empty 'hypothesis_1'/);
  assert.doesNotMatch(
    result.content[0].text,
    /No useful keywords found/,
    "a call that named nothing must not read as a search that found nothing",
  );
});

await test("both blank hypotheses are named together", async () => {
  const result = await explore.execute(
    "ex2",
    { hypothesis_1: "   ", hypothesis_2: "\n\t", searchRoot: SEARCH_ROOT },
    null,
    null,
    exploreCtx,
  );
  assert.deepEqual(result.details.blank, ["hypothesis_1", "hypothesis_2"]);
  assert.match(result.content[0].text, /'hypothesis_1' and 'hypothesis_2'/);
});

await test("control: real hypotheses still search", async () => {
  const args = await validated(explore, {
    hypothesis_1: REAL_ONE,
    hypothesis_2: REAL_TWO,
    searchRoot: SEARCH_ROOT,
  });
  const result = await explore.execute("ex3", args, null, null, exploreCtx);
  assert.equal(result.details.error, undefined, "no refusal");
  assert.equal(result.details.hypotheses, 2);
  assert.match(result.content[0].text, /\[ok\] "parser\.ts"/, "the named file was found");
});

await test("a blank third hypothesis is absent, not an empty section", async () => {
  const result = await explore.execute(
    "ex4",
    { hypothesis_1: REAL_ONE, hypothesis_2: REAL_TWO, hypothesis_3: "", searchRoot: SEARCH_ROOT },
    null,
    null,
    exploreCtx,
  );
  assert.equal(result.details.hypotheses, 2, "two hypotheses ran, not three");
  assert.doesNotMatch(
    result.content[0].text,
    /### Hypothesis 3/,
    "a blank third hypothesis must not become an empty report section",
  );

  const whitespace = await explore.execute(
    "ex4b",
    {
      hypothesis_1: REAL_ONE,
      hypothesis_2: REAL_TWO,
      hypothesis_3: "   ",
      searchRoot: SEARCH_ROOT,
    },
    null,
    null,
    exploreCtx,
  );
  assert.equal(whitespace.details.hypotheses, 2, "whitespace is not a third hypothesis");
  assert.doesNotMatch(
    whitespace.content[0].text,
    /### Hypothesis 3/,
    "whitespace must not become a report section either",
  );
});

await test("control: a real third hypothesis still runs", async () => {
  const result = await explore.execute(
    "ex5",
    {
      hypothesis_1: REAL_ONE,
      hypothesis_2: REAL_TWO,
      hypothesis_3: "The bug might be in parser.ts because the return is rounded",
      searchRoot: SEARCH_ROOT,
    },
    null,
    null,
    exploreCtx,
  );
  assert.equal(result.details.hypotheses, 3);
  assert.match(result.content[0].text, /### Hypothesis 3/);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== memory blank-input fixture passed ===");
