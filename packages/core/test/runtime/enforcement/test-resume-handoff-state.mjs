/**
 * Resume handoff: the file a fresh seat reads after a mastership transfer
 * must carry the program, not just the metadata around it.
 *
 * Failing-first coverage: a populated scratchpad exists in the store's own
 * format (an `events.jsonl` checkpoint) while the resume writer must fill
 * goal, open plan steps and recent decisions from it.
 *
 * 1. SESSION_SHUTDOWN writer: goal, open plans (with status), recent
 *    decisions (with reason) and recent learnings are filled from the
 *    checkpoint log; a completed plan step is NOT reported as open.
 * 2. Turn-end pre-save writer: same projection through the other call site.
 * 3. No scratchpad on disk: every section is empty and the write still lands
 *    (the degradation contract -- never throw on the pre-compaction path).
 * 4. Isolation: every durable write lands under the pinned BRAID_HOME; the
 *    live tree is untouched.
 *
 * Run: node test/runtime/enforcement/test-resume-handoff-state.mjs
 * (build first: npm run build)
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Pin braid's whole durable tree into a private tmpdir BEFORE any dist module
// loads (the dynamic imports below honor it): the writers' resume file lands
// under BRAID_HOME, never the live tree.
const BRAID_HOME = mkdtempSync(join(tmpdir(), "w648-resume-braid-home-"));
process.env.BRAID_HOME = BRAID_HOME;
const LIVE_SESSIONS_ROOT = join(
  typeof process.env.HOME === "string" ? process.env.HOME : "",
  ".pi/agent/braid/sessions",
);

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const DIST = join(ROOT, "dist");
const cwd = mkdtempSync(join(tmpdir(), "w648-resume-cwd-"));

console.log("=== resume handoff carries the scratchpad program ===\n");

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

const { saveScratchpadToDisk, createScratchpad, projectSlugFromCwd } = await import(
  join(DIST, "extensions/memory/scratchpad/persistence.js")
);
const { SESSION_SHUTDOWN } = await import(join(DIST, "lib/core/event-names.js"));

const SLUG = projectSlugFromCwd(cwd);

function resumePathFor(projectCwd, slug) {
  return join(BRAID_HOME, "sessions", projectSlugFromCwd(projectCwd), "resume.json");
}

function readResume(projectCwd, slug) {
  const file = resumePathFor(projectCwd, slug);
  assert.ok(existsSync(file), `resume.json written at ${file}`);
  return JSON.parse(readFileSync(file, "utf-8"));
}

/**
 * Seed a populated scratchpad in the store's real format: the checkpoint log
 * the scratchpad tool appends to. Deliberately NOT a latest.json snapshot -
 * that fixture shape is what let the defect pass CI.
 */
async function seedPopulatedScratchpad(slug) {
  const pad = createScratchpad("transfer the seat: finish the handoff repair", slug);
  pad.plan = [
    {
      id: "pl-done",
      text: "read the store that actually exists",
      spentCalls: 1,
      startTurn: 1,
      doneTurn: 3,
      startTotalCalls: 0,
    },
    {
      id: "pl-live",
      text: "project the resume fields from the checkpoint",
      spentCalls: 1,
      startTurn: 4,
      doneTurn: 0,
      startTotalCalls: 0,
    },
    {
      id: "pl-next",
      text: "run the fixture with a planted revert",
      spentCalls: 0,
      startTurn: 0,
      doneTurn: 0,
      startTotalCalls: 0,
    },
    {
      id: "pl-last",
      text: "write the report",
      spentCalls: 0,
      startTurn: 0,
      doneTurn: 0,
      startTotalCalls: 0,
    },
  ];
  pad.decisions = [1, 2, 3, 4, 5, 6].map((n) => ({
    id: `dc-${n}`,
    text: `decision ${n}`,
    turn: n,
    ...(n === 6 ? { reason: "the last word on it" } : {}),
  }));
  pad.key_learnings = [
    {
      id: "lrn-1",
      content: "state lives in the checkpoint log",
      category: "codebase_fact",
      scope: ["persistence.ts"],
      added_at: Date.now(),
      persisted: false,
    },
    {
      id: "lrn-2",
      content: "a fixture can encode the defect it guards",
      category: "pattern",
      scope: ["test/runtime"],
      added_at: Date.now(),
      persisted: false,
    },
  ];
  await saveScratchpadToDisk(pad);
  const storeFile = join(BRAID_HOME, "scratchpads", slug, "events.jsonl");
  assert.ok(existsSync(storeFile), "seed landed in the checkpoint log");
  return pad;
}

function assertCarriesProgram(saved, { withLearnings }) {
  assert.strictEqual(
    saved.goal,
    "transfer the seat: finish the handoff repair",
    "goal carried from the checkpoint log",
  );
  assert.deepStrictEqual(
    saved.openPlans.map((p) => p.id),
    ["pl-live", "pl-next", "pl-last"],
    "open plan steps carried, the completed step excluded",
  );
  assert.deepStrictEqual(
    saved.openPlans.map((p) => p.status),
    ["in_progress", "pending", "pending"],
    "each open step carries its status",
  );
  assert.deepStrictEqual(
    saved.recentDecisions.map((d) => d.id),
    ["dc-2", "dc-3", "dc-4", "dc-5", "dc-6"],
    "the last five decisions carried",
  );
  assert.strictEqual(
    saved.recentDecisions[4].reason,
    "the last word on it",
    "a decision keeps its reason",
  );
  if (withLearnings) {
    assert.deepStrictEqual(
      saved.recentLearnings.map((l) => l.content),
      ["state lives in the checkpoint log", "a fixture can encode the defect it guards"],
      "recent learnings carried",
    );
  }
}

// ── 1. SESSION_SHUTDOWN writer ──────────────────────────────────────────────

await test("(1) shutdown writer fills goal, open plans, decisions, learnings", async () => {
  const { registerSessionShutdownResumption } = await import(
    join(DIST, "extensions/enforcement/handlers/register-session-shutdown-resumption.js")
  );
  const pad = await seedPopulatedScratchpad(SLUG);

  const handlers = new Map();
  registerSessionShutdownResumption({
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: () => {},
  });
  const list = handlers.get(SESSION_SHUTDOWN) ?? [];
  assert.ok(list.length > 0, "session_shutdown handler registered");
  for (const handler of list) await handler({}, { cwd });

  const saved = readResume(cwd, SLUG);
  assertCarriesProgram(saved, { withLearnings: true });
  assert.strictEqual(pad.goal, saved.goal, "the seeded pad is the state that was read");
});

// ── 2. Turn-end pre-save writer ─────────────────────────────────────────────

function makeBranch(n, perEntryTokens) {
  const text = "x".repeat(perEntryTokens * 4);
  const branch = [];
  for (let i = 0; i < n; i++) {
    branch.push({
      id: `e${i}`,
      parentId: null,
      type: "message",
      timestamp: new Date().toISOString(),
      message: { role: i % 2 === 0 ? "user" : "assistant", content: [{ type: "text", text }] },
    });
  }
  return branch;
}

await test("(2) turn-end pre-save fills the same program", async () => {
  const { registerTurnEndHygiene } = await import(
    join(DIST, "extensions/enforcement/handlers/register-turn-end-hygiene.js")
  );
  const { dispatchTurnEnd } = await import(join(DIST, "lib/events/turn-end-coordinator.js"));
  const { getState } = await import(join(DIST, "extensions/enforcement/state.js"));
  const { getResolvedContextWindow } = await import(join(DIST, "lib/config/braid-settings.js"));

  // Native compaction stands down so the act takes its own path; the resume
  // write happens before the act arms, in either mode.
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  writeFileSync(
    join(cwd, ".pi", "settings.json"),
    JSON.stringify({ compaction: { enabled: false } }),
    "utf-8",
  );

  await seedPopulatedScratchpad(SLUG);

  const resolved = getResolvedContextWindow(200_000);
  assert.ok(resolved > 0, "resolved context window known");
  const branch = makeBranch(Math.round((resolved * 0.65) / 500), 500);
  const ctx = {
    cwd,
    model: { contextWindow: 200_000 },
    sessionManager: {
      getBranch: () => branch,
      getTree: () => branch.map((entry) => ({ entry, children: [], label: undefined })),
      getSessionId: () => "synthetic",
      getSessionFile: () => join(cwd, "synthetic-session.jsonl"),
      getSessionName: () => "synthetic",
      getCwd: () => cwd,
      getEntries: () => branch,
      appendCustomEntry: () => {},
    },
    compact: () => {},
    getContextUsage: () => ({
      tokens: Math.round(resolved * 0.65),
      contextWindow: 200_000,
      percent: 65,
    }),
  };
  const state = getState(ctx);
  state.enforcementActive = true;
  state.lastCompactionTurn = -100;

  registerTurnEndHygiene({ on: () => {}, registerTool: () => {}, sendMessage: () => {} });
  await dispatchTurnEnd({ turnIndex: 7, ctx }, ctx);

  const saved = readResume(cwd, SLUG);
  assertCarriesProgram(saved, { withLearnings: false });
  assert.strictEqual(saved.reason, "turn-end auto-compact pre-save", "pre-save identifies itself");
});

// ── 3. No scratchpad: empty sections, the write still lands ────────────────

await test("(3) absent scratchpad degrades to empty sections, never a throw", async () => {
  const { registerSessionShutdownResumption } = await import(
    join(DIST, "extensions/enforcement/handlers/register-session-shutdown-resumption.js")
  );
  const bareCwd = mkdtempSync(join(tmpdir(), "w648-resume-bare-"));
  const handlers = new Map();
  registerSessionShutdownResumption({
    on(event, handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
    },
    registerTool: () => {},
  });
  for (const handler of handlers.get(SESSION_SHUTDOWN) ?? []) await handler({}, { cwd: bareCwd });

  const saved = readResume(bareCwd, projectSlugFromCwd(bareCwd));
  assert.strictEqual(saved.goal, null, "no goal invented");
  assert.deepStrictEqual(saved.openPlans, [], "no open plans invented");
  assert.deepStrictEqual(saved.recentDecisions, [], "no decisions invented");
  assert.ok(Array.isArray(saved.uncommittedFiles), "the rest of the record still written");
  rmSync(bareCwd, { recursive: true, force: true });
});

// ── 4. Isolation ────────────────────────────────────────────────────────────

await test("(4) every durable write stayed under BRAID_HOME", async () => {
  assert.ok(
    !existsSync(join(LIVE_SESSIONS_ROOT, SLUG)),
    "fixture wrote nothing into the live sessions tree",
  );
  assert.ok(existsSync(join(BRAID_HOME, "sessions", SLUG, "resume.json")), "write landed pinned");
});

rmSync(cwd, { recursive: true, force: true });
rmSync(BRAID_HOME, { recursive: true, force: true });

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.log("RESULT: FAIL");
  process.exit(1);
}
console.log("RESULT: PASS");
