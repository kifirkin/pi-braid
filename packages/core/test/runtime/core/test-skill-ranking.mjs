/**
 * Test: list_skills relevance ranking — the deterministic answer.
 *
 * The catalog is a list of one-line purposes, so a caller who does not already
 * know a skill's name has to guess. The tool now orders its rows by fit to the
 * current task, and the ordering is answered by rankSkillsDeterministic() in
 * auto-inject.ts — the same scorer, comparator and frequency gate the
 * auto-inject whisper uses, so the catalog read and the whisper cannot disagree
 * about which skill is better. No model is called: the tier that would have
 * broken ties was built, measured against this scorer and did not clear its
 * pre-registered bar, so the read is free and the `braid.skills.ranking` policy
 * is echoed rather than acted on.
 *
 * What must hold, in order:
 *   1. An unambiguous read leads with the matching skill and says so; the
 *      verdict comes from the scorer's own margin, not from the tool.
 *   2. Every ambiguous shape is named: a tie, a thin margin, a task too short
 *      to rank. An unmatched row carries no relevance field, so no row pays
 *      bytes for "nothing matched".
 *   3. `rank: "catalog"` is the plain catalog, with no ranking fields at all.
 *   4. The schema gates `rank` through pi-core's own validator (the default is
 *      applied by the handler, not by the schema).
 *   5. `braid.skills.ranking` is read and echoed in the report; the reserved
 *      values evaluate to the keyword path.
 *   6. The task text is the newest user message on the branch; no task text
 *      means catalog order and a `no-task` verdict.
 *
 * Run: node test/runtime/core/test-skill-ranking.mjs
 */

import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "skills-ranking-"));
process.env.HOME = FAKE_HOME;

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const DIST = join(ROOT, "dist", "extensions", "core", "skills-tool");

const toolModule = await import(join(DIST, "index.js"));
const { setCachedSkills, currentTaskText } = toolModule;
const skillsToolExtension = toolModule.default;
const { RANK_MARGIN_THRESHOLD, RANK_SHORT_TASK_CHARS } = await import(
  join(DIST, "auto-inject.js")
);
const { validateToolArguments } = await import("@earendil-works/pi-ai/utils/validation");

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      passed++;
      console.log(`  [ok] ${name}`);
    })
    .catch((e) => {
      failed++;
      console.log(`  [fail] ${name}: ${e.message}`);
    });
}

// ── fixtures ───────────────────────────────────────────────────────────────

const CATALOG = mkdtempSync(join(tmpdir(), "skills-ranking-catalog-"));

/**
 * Write a SKILL.md and return the cache row list_skills consumes. Triggers are
 * read back from the file by setCachedSkills, so the fixture exercises the real
 * trigger reader rather than handing the scorer a phrase list.
 *
 * Names deliberately do NOT carry the task words: a name token is worth +3, so
 * a name that repeats the prompt would decide the case before the evidence
 * under test could. Each trigger is the only strong evidence its skill has.
 */
function skillFile(name, description, trigger) {
  mkdirSync(join(CATALOG, name), { recursive: true });
  const front = ["---", `name: ${name}`, `description: "${description}"`];
  if (trigger) front.push(`trigger: "${trigger}"`);
  front.push("---", "", `# ${name}`, "");
  const filePath = join(CATALOG, name, "SKILL.md");
  writeFileSync(filePath, `${front.join("\n")}\n`, "utf-8");
  return { name, filePath, description, baseDir: join(CATALOG, name) };
}

const CATALOG_ROWS = [
  skillFile("ship-it", "Publish the packages: bump versions, tag.", "release train"),
  skillFile("prose-polish", "Rewrite long-form copy for tone and clarity.", "docs pass"),
  skillFile("quiet-fix", "Diagnose a stalled worker and its branch.", "stalled worker"),
  skillFile("zzz-filler", "Unrelated catalog filler with no other purpose."),
];

const UNAMBIGUOUS_TASK = "run the release train for the four packages tonight";
const AMBIGUOUS_TASK = "release train and docs pass, both land first";
const THIN_MARGIN_TASK = "release train and docs pass, match the tone";

/** Fake pi: only registerTool is read; the rest of the surface is inert. */
function fakePi() {
  const tools = [];
  return {
    tools,
    on: () => {},
    registerTool: (def) => tools.push(def),
    sendMessage: () => {},
    getExtensionState: () => ({}),
    setExtensionState: () => {},
  };
}

/** Fake extension context: the branch is the task text, and nothing else is read. */
function fakeCtx(task, { hasBranch = true } = {}) {
  return {
    model: undefined,
    sessionManager: {
      getSessionId: () => "ranking-fixture",
      getSessionFile: () => join(FAKE_HOME, "ranking-fixture.jsonl"),
      getBranch: () =>
        hasBranch && task ? [{ type: "message", message: { role: "user", content: task } }] : [],
    },
  };
}

/** The registered list_skills tool, called the way pi calls it. */
async function callList(ctx, args) {
  const pi = fakePi();
  skillsToolExtension(pi);
  const tool = pi.tools.find((t) => t.name === "list_skills");
  const validated = validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    { name: tool.name, arguments: { action: "list", ...args } },
  );
  const result = await tool.execute("call-1", validated, undefined, undefined, ctx);
  return JSON.parse(result.content[0].text);
}

function writeSettings(ranking) {
  const dir = join(FAKE_HOME, ".pi", "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ braid: { skills: ranking === undefined ? {} : { ranking } } }, null, 2),
    "utf-8",
  );
}

setCachedSkills(CATALOG_ROWS);
writeSettings(undefined); // default policy: keyword

console.log(`\n— catalogue: ${CATALOG_ROWS.map((s) => s.name).join(", ")} —`);
console.log(
  `  verdicts measured through the tool path ` +
    `(margin threshold ${RANK_MARGIN_THRESHOLD}, short task under ${RANK_SHORT_TASK_CHARS} chars):`,
);
for (const [label, task] of [
  ["unambiguous", UNAMBIGUOUS_TASK],
  ["tie", AMBIGUOUS_TASK],
  ["thin-margin", THIN_MARGIN_TASK],
]) {
  const payload = await callList(fakeCtx(task), { pageSize: 4 });
  console.log(
    `  ${label.padEnd(12)} basis=${payload.ranking.basis} order=${payload.skills
      .map((s) => s.name)
      .join(",")}`,
  );
}

// ── 1. the unambiguous answer ─────────────────────────────────────────────

await test("an unambiguous read leads with the matching skill and says why", async () => {
  const payload = await callList(fakeCtx(UNAMBIGUOUS_TASK), { pageSize: 4 });
  assert.equal(payload.ranking.tier, "keyword");
  assert.equal(payload.ranking.basis, "unambiguous");
  assert.equal(payload.ranking.policy, "keyword");
  assert.equal(payload.skills[0].name, "ship-it", "the matching skill leads");
  assert.deepEqual(payload.skills[0].relevance, { score: 3, reason: "trigger" });
  assert.equal(
    "relevance" in payload.skills.at(-1),
    false,
    "an unmatched row carries no evidence",
  );
  assert.equal(payload.total, 4, "every row still renders");
});

await test("nothing scoring is unambiguous, not a failure", async () => {
  const payload = await callList(fakeCtx("quarterly salary benchmark for the region"), {
    pageSize: 4,
  });
  assert.equal(payload.ranking.basis, "no-score");
  assert.deepEqual(
    payload.skills.map((s) => s.name),
    CATALOG_ROWS.map((s) => s.name),
    "catalog order stands",
  );
  assert.equal(
    payload.skills.some((s) => "relevance" in s),
    false,
    "no row claims evidence",
  );
});

// ── 2. every ambiguous shape is named ─────────────────────────────────────

await test("a tie is reported as a tie, not smoothed over", async () => {
  const payload = await callList(fakeCtx(AMBIGUOUS_TASK), { pageSize: 4 });
  assert.equal(payload.ranking.basis, "tie");
  assert.deepEqual(
    payload.skills.slice(0, 2).map((s) => s.name),
    ["prose-polish", "ship-it"],
    "the tie breaks on the comparator's name leg",
  );
});

await test("a margin narrower than the threshold is reported as thin", async () => {
  const payload = await callList(fakeCtx(THIN_MARGIN_TASK), { pageSize: 4 });
  assert.equal(payload.ranking.basis, "thin-margin");
  assert.equal(payload.skills[0].name, "prose-polish", "the extra weak hit leads");
});

await test("a task too short to rank says so instead of guessing", async () => {
  const payload = await callList(fakeCtx("ok go"), { pageSize: 4 });
  assert.equal(payload.ranking.basis, "short-task");
  assert.deepEqual(
    payload.skills.map((s) => s.name),
    CATALOG_ROWS.map((s) => s.name),
  );
});

// ── 3. the plain catalog ──────────────────────────────────────────────────

await test("rank: catalog returns the unranked catalog, with no ranking fields", async () => {
  const payload = await callList(fakeCtx(AMBIGUOUS_TASK), { pageSize: 4, rank: "catalog" });
  assert.equal("ranking" in payload, false);
  assert.deepEqual(
    payload.skills.map((s) => s.name),
    CATALOG_ROWS.map((s) => s.name),
    "catalog order is the cache order",
  );
  for (const row of payload.skills) {
    assert.equal("relevance" in row, false, `${row.name} carries no ranking field`);
  }
});

// ── 4. the schema ─────────────────────────────────────────────────────────

await test("the schema gates rank, and the handler applies the default", async () => {
  const pi = fakePi();
  skillsToolExtension(pi);
  const tool = pi.tools.find((t) => t.name === "list_skills");
  for (const value of ["relevance", "catalog"]) {
    const args = validateToolArguments(
      { name: tool.name, parameters: tool.parameters },
      { name: tool.name, arguments: { action: "list", rank: value } },
    );
    assert.equal(args.rank, value);
  }
  const omitted = validateToolArguments(
    { name: tool.name, parameters: tool.parameters },
    { name: tool.name, arguments: { action: "list" } },
  );
  assert.equal(omitted.rank, undefined, "the schema leaves it absent");
  const payload = await callList(fakeCtx(AMBIGUOUS_TASK), { pageSize: 4 });
  assert.ok(payload.ranking, "…and the handler's default is relevance");
  assert.throws(
    () =>
      validateToolArguments(
        { name: tool.name, parameters: tool.parameters },
        { name: tool.name, arguments: { action: "list", rank: "alphabetical" } },
      ),
    /rank|literal|union/i,
  );
});

// ── 5. the policy setting ─────────────────────────────────────────────────

await test("the policy is read and echoed; reserved values answer with the keyword path", async () => {
  for (const [value, expected] of [
    ["keyword", "keyword"],
    ["auto", "auto"],
    ["model", "model"],
    ["sometimes", "keyword"],
    [undefined, "keyword"],
  ]) {
    writeSettings(value);
    try {
      const payload = await callList(fakeCtx(UNAMBIGUOUS_TASK), { pageSize: 4 });
      assert.equal(payload.ranking.policy, expected, `policy for ${JSON.stringify(value)}`);
      assert.equal(payload.ranking.tier, "keyword", "the deterministic tier is the only tier");
      assert.equal(payload.skills[0].name, "ship-it");
    } finally {
      writeSettings(undefined);
    }
  }
});

// ── 6. task-text edges ────────────────────────────────────────────────────

await test("no task text at all: catalog order and a no-task verdict", async () => {
  const payload = await callList(fakeCtx("", { hasBranch: false }), { pageSize: 4 });
  assert.equal(payload.ranking.basis, "no-task");
  assert.deepEqual(
    payload.skills.map((s) => s.name),
    CATALOG_ROWS.map((s) => s.name),
  );
});

await test("the task text is the newest user message on the branch", () => {
  const ctx = {
    sessionManager: {
      getBranch: () => [
        { type: "message", message: { role: "user", content: "first task" } },
        { type: "message", message: { role: "assistant", content: [{ type: "text", text: "hi" }] } },
        { type: "message", message: { role: "user", content: [{ type: "text", text: "newest" }] } },
      ],
    },
  };
  assert.equal(currentTaskText(ctx), "newest");
  assert.equal(currentTaskText({}), "");
});

await test("ranking is stable: the same read twice gives the same order", async () => {
  const first = await callList(fakeCtx(AMBIGUOUS_TASK), { pageSize: 4 });
  const second = await callList(fakeCtx(AMBIGUOUS_TASK), { pageSize: 4 });
  assert.deepEqual(
    first.skills.map((s) => s.name),
    second.skills.map((s) => s.name),
  );
  assert.equal(first.ranking.basis, second.ranking.basis);
});

// ── result ────────────────────────────────────────────────────────────────

console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
