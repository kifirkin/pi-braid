/**
 * Regression test: memory write-decision log, the append-only measurement
 * hook for the review-before-write gate (lib/memory/write-log.ts).
 *
 * The gate's decisions were previously visible only in session logs, which
 * cannot be counted across sessions. write-log.jsonl carries one JSON line per
 * gated decision so per-site write counts, decision mix and silence can be
 * measured week over week.
 *
 * Behaviors pinned here:
 *   A. Path: the log resolves under the hermetic HOME
 *      (~/.pi/agent/braid/memory/write-log.jsonl).
 *   B. One line per gated decision, exact schema and stable key order, for all
 *      four decision values.
 *   C. Privacy: hashes only, no raw task/solution text ever reaches the file.
 *   D. Hash stability: identical input -> identical hash, across sites.
 *   E. Warp path: an unwritable log target degrades to a debug log and the
 *      gate decision still applies (the memory write is unaffected).
 *   F. Warn mode: decisions are logged while the write proceeds unchanged.
 *   G. Inactive gate (disabled globally or per-site) computes no decision and
 *      appends nothing.
 *   H. skip-dup lines carry the existing episode id.
 *   I. Real writer paths log through the wrapper (episodes_add, memory_store
 *      episodic twin).
 *
 * Hermetic: HOME is redirected to a temp dir before the dist imports, so the
 * live settings.json cannot change the gate defaults this suite pins.
 */

import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const FAKE_HOME = mkdtempSync(join(tmpdir(), "write-log-test-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), "{}\n");

const {
  WRITE_LOG_FILE,
  WRITE_LOG_HASH_LENGTH,
  buildWriteLogLine,
  logWriteDecision,
  applyWriteGateLogged,
} = await import("../../../dist/lib/memory/write-log.js");
const { MEMORY_WRITE_GATE_DEFAULTS } = await import("../../../dist/lib/memory/write-quality.js");
const { createMemoryTool } =
  await import("../../../dist/extensions/memory/memory-agent-bridge/memory-tool.js");
const { createMemoryStoreTool } =
  await import("../../../dist/extensions/memory/memory-agent-bridge/memory-store-tool.js");

console.log("=== memory write-decision log ===\n");

let passed = 0;
let failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(` [v] ${name}`);
    passed++;
  } catch (e) {
    console.log(` [x] ${name}: ${e.message}`);
    failed++;
  }
}

const DEFAULT_CFG = {
  enabled: true,
  cooldownMs: MEMORY_WRITE_GATE_DEFAULTS.cooldownMs,
  mode: MEMORY_WRITE_GATE_DEFAULTS.mode,
  sites: {},
};

const SIGNAL_TASK = "Wire the write-decision log into the gated episode writers";
const SIGNAL_SOLUTION = "call applyWriteGateLogged at all five sites and append one JSON line";
const DEAD_SOLUTION = "Outcome: success";
const JUNK_TASK = "session_outcome";

/** Parsed log lines (empty when nothing was appended). */
function lines() {
  if (!existsSync(WRITE_LOG_FILE) || !statSync(WRITE_LOG_FILE).isFile()) return [];
  return readFileSync(WRITE_LOG_FILE, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l));
}

function resetLog() {
  rmSync(WRITE_LOG_FILE, { force: true, recursive: true });
}

// ── A. Path ──────────────────────────────────────────────────────────────────
test("log path resolves under the braid memory dir", () => {
  assert.equal(
    WRITE_LOG_FILE,
    join(FAKE_HOME, ".pi", "agent", "braid", "memory", "write-log.jsonl"),
  );
});

// ── B. One line per decision, exact schema ─────────────────────────────────────
test("four decisions -> four lines, exact schema and key order", () => {
  resetLog();
  // accept / repair / reject / skip-dup through the gated wrapper.
  applyWriteGateLogged(DEFAULT_CFG, {
    site: "finalize",
    task: SIGNAL_TASK,
    solution: SIGNAL_SOLUTION,
  });
  applyWriteGateLogged(DEFAULT_CFG, {
    site: "finalize",
    task: SIGNAL_TASK,
    solution: DEAD_SOLUTION,
    toolSequence: ["read", "edit", "bash"],
  });
  applyWriteGateLogged(DEFAULT_CFG, {
    site: "episodesAdd",
    task: JUNK_TASK,
    solution: SIGNAL_SOLUTION,
  });
  applyWriteGateLogged(DEFAULT_CFG, {
    site: "episodesAdd",
    task: SIGNAL_TASK,
    solution: SIGNAL_SOLUTION,
    recent: [{ id: "ep_dup", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION }],
  });

  const logged = lines();
  assert.equal(logged.length, 4, "one line per gated decision");
  assert.deepEqual(
    logged.map((l) => l.decision),
    ["accept", "repair", "reject", "skip-dup"],
  );
  assert.deepEqual(
    logged.map((l) => l.site),
    ["finalize", "finalize", "episodesAdd", "episodesAdd"],
  );

  assert.deepEqual(
    Object.keys(logged[0]),
    ["ts", "site", "decision", "reason", "taskHash", "solutionHash", "mode"],
    "schema key order (no id when the caller has none)",
  );
  assert.deepEqual(
    Object.keys(logged[3]),
    ["ts", "site", "id", "decision", "reason", "taskHash", "solutionHash", "mode"],
    "skip-dup lines carry the existing episode id in place",
  );

  for (const line of logged) {
    assert.match(line.ts, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, "ISO-8601 ts");
    assert.equal(line.mode, "enforce", "mode recorded at decision time");
    assert.equal(line.taskHash.length, WRITE_LOG_HASH_LENGTH);
    assert.equal(line.solutionHash.length, WRITE_LOG_HASH_LENGTH);
    assert.ok(line.reason.length > 0, "every line carries a reason");
  }
  assert.equal(logged[0].reason, "accepted");
  assert.equal(logged[1].reason, "dead solution field repaired from tool sequence");
  assert.match(logged[2].reason, /^task carries no signal/);
  assert.equal(logged[3].reason, "duplicate (exact, similarity 1.00)");
});

// ── C. Privacy: hashes only ──────────────────────────────────────────────────
test("the log never carries raw task or solution text", () => {
  resetLog();
  applyWriteGateLogged(DEFAULT_CFG, {
    site: "finalize",
    task: SIGNAL_TASK,
    solution: SIGNAL_SOLUTION,
  });
  applyWriteGateLogged(DEFAULT_CFG, {
    site: "finalize",
    task: JUNK_TASK,
    solution: DEAD_SOLUTION,
  });

  const raw = readFileSync(WRITE_LOG_FILE, "utf8");
  for (const secret of [SIGNAL_TASK, SIGNAL_SOLUTION, DEAD_SOLUTION, JUNK_TASK]) {
    assert.equal(raw.includes(secret), false, `raw content leaked: ${secret}`);
  }
  assert.equal(lines().length, 2);
});

// ── D. Hash stability ────────────────────────────────────────────────────────
test("identical input hashes identically, across sites and configs", () => {
  resetLog();
  const input = { task: SIGNAL_TASK, solution: SIGNAL_SOLUTION };
  applyWriteGateLogged(DEFAULT_CFG, { site: "finalize", ...input });
  applyWriteGateLogged(DEFAULT_CFG, { site: "mars", ...input });
  applyWriteGateLogged({ ...DEFAULT_CFG, mode: "warn" }, { site: "episodesAdd", ...input });

  const logged = lines();
  assert.equal(logged.length, 3);
  const [finalizeLine, marsLine, warnLine] = logged;
  assert.equal(finalizeLine.taskHash, marsLine.taskHash);
  assert.equal(finalizeLine.solutionHash, marsLine.solutionHash);
  assert.equal(finalizeLine.taskHash, warnLine.taskHash);
  // A different candidate hashes differently.
  applyWriteGateLogged(DEFAULT_CFG, { site: "mars", task: SIGNAL_TASK, solution: DEAD_SOLUTION });
  const otherLine = lines()[3];
  assert.notEqual(otherLine.solutionHash, finalizeLine.solutionHash);
});

// ── E. Unwritable log target ─────────────────────────────────────────────────
test("an unwritable log path never breaks the memory write", () => {
  resetLog();
  // Occupy the log path with a directory: every append now fails (EISDIR).
  mkdirSync(WRITE_LOG_FILE, { recursive: true });
  try {
    const outcome = applyWriteGateLogged(DEFAULT_CFG, {
      site: "finalize",
      task: SIGNAL_TASK,
      solution: DEAD_SOLUTION,
      toolSequence: ["read", "edit", "bash"],
    });
    assert.equal(outcome.write, true, "the gate decision still applies");
    assert.equal(
      outcome.solution,
      "Ran: read -> edit -> bash",
      "the repair still reaches the writer",
    );

    const rejected = applyWriteGateLogged(DEFAULT_CFG, {
      site: "episodesAdd",
      task: JUNK_TASK,
      solution: SIGNAL_SOLUTION,
    });
    assert.equal(rejected.write, false, "a reject still suppresses the write");
    assert.equal(statSync(WRITE_LOG_FILE).isDirectory(), true, "no file was appended");
  } finally {
    rmSync(WRITE_LOG_FILE, { force: true, recursive: true });
  }
  assert.equal(lines().length, 0);
});

test("a direct logWriteDecision call is equally safe when the append fails", () => {
  resetLog();
  mkdirSync(WRITE_LOG_FILE, { recursive: true });
  try {
    assert.doesNotThrow(() =>
      logWriteDecision({
        site: "mars",
        decision: { action: "accept" },
        task: SIGNAL_TASK,
        solution: SIGNAL_SOLUTION,
        mode: "enforce",
      }),
    );
  } finally {
    rmSync(WRITE_LOG_FILE, { force: true, recursive: true });
  }
});

// ── F. Warn mode ─────────────────────────────────────────────────────────────
test("warn mode logs the computed decision while the write proceeds unchanged", () => {
  resetLog();
  const warn = { ...DEFAULT_CFG, mode: "warn" };
  const outcome = applyWriteGateLogged(warn, {
    site: "finalize",
    task: SIGNAL_TASK,
    solution: DEAD_SOLUTION,
    toolSequence: ["read", "edit", "bash"],
  });
  assert.equal(outcome.write, true, "warn writes anyway");
  assert.equal(outcome.solution, DEAD_SOLUTION, "warn does not apply the repair");

  const logged = lines();
  assert.equal(logged.length, 1, "the observation line is still recorded");
  assert.equal(logged[0].decision, "repair", "the computed decision is logged, not the write");
  assert.equal(logged[0].mode, "warn");
});

// ── G. Inactive gate ─────────────────────────────────────────────────────────
test("a disabled or opted-out gate appends nothing", () => {
  resetLog();
  const off = { ...DEFAULT_CFG, enabled: false };
  applyWriteGateLogged(off, { site: "finalize", task: JUNK_TASK, solution: DEAD_SOLUTION });
  applyWriteGateLogged(off, { site: "mars", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION });
  assert.equal(lines().length, 0, "no decision is computed when the gate is off");

  const optOut = { ...DEFAULT_CFG, sites: { finalize: false } };
  applyWriteGateLogged(optOut, { site: "finalize", task: JUNK_TASK, solution: DEAD_SOLUTION });
  assert.equal(lines().length, 0, "the opted-out site logs nothing");

  // ...while the other sites stay gated and logged.
  applyWriteGateLogged(optOut, { site: "mars", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION });
  const logged = lines();
  assert.equal(logged.length, 1);
  assert.equal(logged[0].site, "mars");
});

// ── H. Builder contract ──────────────────────────────────────────────────────
test("buildWriteLogLine is pure: caller-owned clock, skip-dup id fallback", () => {
  const now = new Date("2026-09-14T12:00:00.000Z");
  const acceptLine = buildWriteLogLine(
    {
      site: "mars",
      decision: { action: "accept" },
      task: SIGNAL_TASK,
      solution: SIGNAL_SOLUTION,
      mode: "enforce",
    },
    now,
  );
  assert.equal(acceptLine.ts, "2026-09-14T12:00:00.000Z");
  assert.equal(acceptLine.id, undefined, "no id is invented for an accept");

  const dupLine = buildWriteLogLine(
    {
      site: "episodesAdd",
      decision: { action: "skip-dup", existingId: "ep_7", match: "near", similarity: 0.9 },
      task: SIGNAL_TASK,
      solution: SIGNAL_SOLUTION,
      mode: "enforce",
    },
    now,
  );
  assert.equal(dupLine.id, "ep_7");
  assert.equal(dupLine.reason, "duplicate (near, similarity 0.90)");
  assert.equal(JSON.stringify(dupLine).includes(SIGNAL_TASK), false, "hashes only");
});

// ── I. Real writer paths ─────────────────────────────────────────────────────
await testAsync("episodes_add logs its decision through the wrapper", async () => {
  resetLog();
  const memoryTool = createMemoryTool({}, null, () => {});
  const ctx = { cwd: "/tmp/projects/agents/pi-braid" };

  await memoryTool.execute(
    "t1",
    { action: "episodes_add", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION, outcome: "partial" },
    null,
    null,
    ctx,
  );
  await memoryTool.execute(
    "t2",
    { action: "episodes_add", task: SIGNAL_TASK, solution: SIGNAL_SOLUTION, outcome: "partial" },
    null,
    null,
    ctx,
  );
  await memoryTool.execute(
    "t3",
    { action: "episodes_add", task: JUNK_TASK, solution: SIGNAL_SOLUTION, outcome: "partial" },
    null,
    null,
    ctx,
  );

  const logged = lines();
  assert.deepEqual(
    logged.map((l) => l.decision),
    ["accept", "skip-dup", "reject"],
    "explicit episode writes log every decision",
  );
  assert.ok(
    logged.every((l) => l.site === "episodesAdd"),
    "site is attributed to the writer",
  );
});

await testAsync("memory_store episodic twin logs its decision", async () => {
  resetLog();
  const memory = { store: async () => ({ id: "mem_001" }) };
  const tool = createMemoryStoreTool(memory, null, () => {});
  const ctx = { cwd: "/tmp/projects/agents/pi-braid" };

  await tool.execute(
    "t1",
    { content: SIGNAL_TASK, memoryType: "episodic", tags: ["gate"] },
    null,
    null,
    ctx,
  );
  await tool.execute("t2", { content: SIGNAL_TASK, memoryType: "episodic" }, null, null, ctx);

  const logged = lines();
  assert.deepEqual(
    logged.map((l) => [l.site, l.decision]),
    [
      ["memoryStoreTwin", "accept"],
      ["memoryStoreTwin", "skip-dup"],
    ],
  );
  assert.equal(logged[1].id.substring(0, 3), "ep-", "the skipped duplicate id is recorded");
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== write-decision log tests passed ===");
