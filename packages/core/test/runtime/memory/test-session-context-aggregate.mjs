/**
 * Option B — cross-session context-adoption aggregate.
 *
 * Tests the pure aggregation surface in session-recall/context-aggregate.ts
 * against fixture session files in a temp dir:
 * - compaction events + lossy (empty/boilerplate) summary detection
 * - coverage: context_compression / context_compress_slide custom
 * entries + on-disk originals archives (epoch-in-filename windowing)
 * - navigation adoption: label (tag), branch_summary (checkout),
 * context_navigate(action=log) tool calls
 * - window (since/until), project filter, maxFiles cap, size cap
 * - adoption_rate math and the ≤40-line formatted block
 */

import { strict as assert } from "node:assert";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  aggregateContextAdoption,
  aggregateSessionFile,
  isBoilerplateSummary,
  formatContextAggregate,
} = await import("../../../dist/extensions/memory/session-recall/context-aggregate.js");

console.log("=== Option B cross-session context-adoption aggregate ===\n");

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

// ── Fixture builders ─────────────────────────────────────────────────────────

// All fixture timestamps are Date.now()-relative: hard-coded dates went stale
// once run-date drifted >7 days past them. Sessions A/B/C sit inside the
// default 7-day window (now-1h/24h/48h); D sits outside (now-30d).
const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
// Session-file naming convention: <ISO stamp with ':'/'.' as '-'>_<uuid>.jsonl
// (dateFromPath() in session-recall/search.ts parses the leading YYYY-MM-DD).
const fileStamp = (ts) => new Date(ts).toISOString().replace(/[:.]/g, "-");
const utcDate = (ts) => new Date(ts).toISOString().slice(0, 10);
const tsA = NOW - 1 * HOUR;
const tsB = NOW - 24 * HOUR;
const tsC = NOW - 48 * HOUR;
const tsD = NOW - 30 * DAY;
const ENTRY_TS = new Date(tsA).toISOString();

const SUBSTANTIVE_SUMMARY =
  "## Goal\nImplement the payment gateway migration.\n## Done\n- Migrated checkout flow\n- Added retry handlers\n## Next Steps\n- Roll out to prod\n";

const BOILERPLATE_SUMMARY =
  "## Goal\n[No conversation content exists. There is no user goal to summarize.]\n" +
  "## Progress\n### Done\n- (nothing — the conversation is empty)\n" +
  "## Key Decisions\n- **No decisions recorded**: No conversation content was provided.\n";

function sessionLine(entry) {
  return JSON.stringify(entry);
}

function compactionEntry(summary, id) {
  return {
    type: "compaction",
    id,
    parentId: "root",
    timestamp: ENTRY_TS,
    summary,
    firstKeptEntryId: "abc",
  };
}

function customEntry(customType, data, id) {
  return { type: "custom", customType, data, id, parentId: "root", timestamp: ENTRY_TS };
}

function labelEntry(label, id) {
  return { type: "label", label, targetId: "abc", id, parentId: "root", timestamp: ENTRY_TS };
}

function branchSummaryEntry(summary, id) {
  return {
    type: "branch_summary",
    summary,
    fromId: "root",
    id,
    parentId: "root",
    timestamp: ENTRY_TS,
  };
}

function navigateLogCall() {
  return {
    type: "message",
    id: "msg1",
    parentId: "root",
    timestamp: ENTRY_TS,
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "where am i" },
        { type: "toolCall", id: "tc1", name: "context_navigate", arguments: { action: "log" } },
      ],
    },
  };
}

function plainMessage() {
  return {
    type: "message",
    id: "msg0",
    parentId: "root",
    timestamp: ENTRY_TS,
    message: { role: "user", content: [{ type: "text", text: "hello" }] },
  };
}

async function makeFixture() {
  const dir = await mkdtemp(join(tmpdir(), "braid-s8-"));
  const proj = join(dir, "--tmp-project--");
  await mkdir(proj, { recursive: true });
  const archives = join(proj, "archives");
  await mkdir(archives, { recursive: true });

  // Session A: 2 compactions (1 substantive, 1 boilerplate=loss), 1 archive,
  // 1 slide, 1 deep-clean, 2 tags, 1 checkout, 1 log.
  const sessionA = [
    plainMessage(),
    compactionEntry(SUBSTANTIVE_SUMMARY, "c1"),
    compactionEntry(BOILERPLATE_SUMMARY, "c2"),
    customEntry("context_compression", { topic: "t1", summary: "s1" }, "cu1"),
    customEntry("context_compress_slide", { keep: 50, dropped: 20 }, "cu2"),
    customEntry("context_compression", { topic: "t2", fromDeepClean: true }, "cu3"),
    labelEntry("before-cleanup", "l1"),
    labelEntry("milestone", "l2"),
    branchSummaryEntry("checkout summary", "bs1"),
    navigateLogCall(),
  ]
    .map(sessionLine)
    .join("\n");

  // Session B: 1 substantive compaction only (no navigation).
  const sessionB = [plainMessage(), compactionEntry(SUBSTANTIVE_SUMMARY, "c3")]
    .map(sessionLine)
    .join("\n");

  // Session C: navigation only, no compaction (pure adopter).
  const sessionC = [plainMessage(), labelEntry("tag-c", "l3"), navigateLogCall()]
    .map(sessionLine)
    .join("\n");

  // Session D: outside the default 7-day window (now-30d).
  const sessionD = [plainMessage(), compactionEntry(BOILERPLATE_SUMMARY, "c4")]
    .map(sessionLine)
    .join("\n");

  const fileA = `${fileStamp(tsA)}_aaaaaaaa-0000-0000-0000-000000000001.jsonl`;
  const fileB = `${fileStamp(tsB)}_aaaaaaaa-0000-0000-0000-000000000002.jsonl`;
  const fileC = `${fileStamp(tsC)}_aaaaaaaa-0000-0000-0000-000000000003.jsonl`;
  const fileD = `${fileStamp(tsD)}_aaaaaaaa-0000-0000-0000-000000000004.jsonl`;
  await writeFile(join(proj, fileA), sessionA + "\n");
  await writeFile(join(proj, fileB), sessionB + "\n");
  await writeFile(join(proj, fileC), sessionC + "\n");
  await writeFile(join(proj, fileD), sessionD + "\n");

  // On-disk originals archives: one inside the window, one outside.
  const inWindowEpoch = tsA;
  const outWindowEpoch = tsD;
  await writeFile(join(archives, `sessA-leafA-${inWindowEpoch}.jsonl`), "{}" + "\n");
  await writeFile(join(archives, `sessD-leafD-${outWindowEpoch}.jsonl`), "{}" + "\n");

  return {
    dir,
    proj,
    archives,
    inWindowEpoch,
    outWindowEpoch,
    files: { A: fileA, B: fileB, C: fileC, D: fileD },
    // Explicit-window preset covering exactly A/B/C (D is 30 days back).
    window: { since: utcDate(tsC), until: utcDate(tsA) },
  };
}

// ── Boilerplate detection ────────────────────────────────────────────────────

test("isBoilerplateSummary: empty summary is lossy", () => {
  assert.equal(isBoilerplateSummary(""), true);
  assert.equal(isBoilerplateSummary("   "), true);
  assert.equal(isBoilerplateSummary(undefined), true);
  assert.equal(isBoilerplateSummary(null), true);
});

test("isBoilerplateSummary: boilerplate family is lossy", () => {
  assert.equal(isBoilerplateSummary(BOILERPLATE_SUMMARY), true);
  assert.equal(
    isBoilerplateSummary("No conversation content exists. There is no user goal to summarize."),
    true,
  );
  assert.equal(isBoilerplateSummary("Await actual conversation content to summarize."), true);
});

test("isBoilerplateSummary: substantive summary is not lossy", () => {
  assert.equal(isBoilerplateSummary(SUBSTANTIVE_SUMMARY), false);
  assert.equal(
    isBoilerplateSummary("Implemented the payment gateway migration with retry handlers."),
    false,
  );
});

// ── Per-file aggregation ─────────────────────────────────────────────────────

test("aggregateSessionFile: counts durable markers", async () => {
  const { dir, proj, files } = await makeFixture();
  try {
    const counts = await aggregateSessionFile(join(proj, files.A));
    assert.ok(counts, "file must parse");
    assert.equal(counts.compactions, 2);
    assert.equal(counts.lossy, 1, "boilerplate compaction must count as loss");
    assert.equal(counts.archives, 2, "context_compression entries");
    assert.equal(counts.slides, 1, "context_compress_slide entries");
    assert.equal(counts.deepCleans, 1, "fromDeepClean flag");
    assert.equal(counts.tags, 2);
    assert.equal(counts.checkouts, 1);
    assert.equal(counts.logs, 1, "context_navigate(action=log) tool call");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Full aggregate ───────────────────────────────────────────────────────────

test("aggregateContextAdoption: window + signals + adoption rate", async () => {
  const { dir, window: win } = await makeFixture();
  try {
    const r = await aggregateContextAdoption(dir, win);
    assert.equal(r.scanned.files, 3, "sessions A/B/C in window, D excluded");
    assert.equal(r.compaction.events, 3, "A=2, B=1");
    assert.equal(r.compaction.lossy, 1, "only A's boilerplate compaction");
    assert.equal(r.coverage.archives, 2, "A: archive + deep-clean");
    assert.equal(r.coverage.slides, 1);
    assert.equal(r.coverage.deepCleans, 1);
    assert.equal(r.coverage.originalsArchives, 1, "only the in-window epoch archive");
    assert.equal(r.adoption.tags, 3, "A=2, C=1");
    assert.equal(r.adoption.checkouts, 1);
    assert.equal(r.adoption.logs, 2, "A=1, C=1");
    assert.equal(r.adoptingSessions, 2, "A and C adopted navigation");
    assert.equal(r.compactingSessions, 2, "A and B compacted");

    // adoption_rate = navigation / (navigation + compactions)
    // navigation = tags3 + checkouts1 + logs2 + archives2 + slides1 + deepCleans1 = 10
    // compactions = 3 -> 10/13
    assert.ok(r.adoptionRate !== null);
    assert.ok(Math.abs(r.adoptionRate - 10 / 13) < 1e-9, `expected 10/13, got ${r.adoptionRate}`);
    assert.equal(r.navigationActions, 10);
    assert.equal(r.compactions, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aggregateContextAdoption: default window is recent 7 days", async () => {
  const { dir } = await makeFixture();
  try {
    const r = await aggregateContextAdoption(dir);
    // Session D (now-30d) is outside the default window; A/B/C are in.
    assert.equal(r.scanned.files, 3);
    assert.equal(r.compaction.events, 3);
    assert.equal(r.compaction.lossy, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aggregateContextAdoption: project filter narrows the scan", async () => {
  const { dir } = await makeFixture();
  try {
    const r = await aggregateContextAdoption(dir, { project: "tmp-project" });
    assert.equal(r.scanned.files, 3, "all fixtures are under the tmp-project dir");
    const none = await aggregateContextAdoption(dir, { project: "does-not-exist" });
    assert.equal(none.scanned.files, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aggregateContextAdoption: maxFiles cap and size cap", async () => {
  const { dir } = await makeFixture();
  try {
    const capped = await aggregateContextAdoption(dir, { maxFiles: 1 });
    assert.equal(capped.scanned.files, 1, "cap at 1 file");

    // Oversize skip: set a tiny size cap so every file is skipped.
    const tiny = await aggregateContextAdoption(dir, { maxFileSizeBytes: 1 });
    assert.equal(tiny.scanned.files, 0);
    assert.equal(tiny.scanned.skippedOversize, 3, "all 3 in-window files skipped as oversized");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("aggregateContextAdoption: empty dir yields idle result", async () => {
  const dir = await mkdtemp(join(tmpdir(), "braid-s8-empty-"));
  try {
    const r = await aggregateContextAdoption(dir);
    assert.equal(r.scanned.files, 0);
    assert.equal(r.adoptionRate, null);
    assert.equal(r.trend, "no §8 activity in window");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ── Formatting ───────────────────────────────────────────────────────────────

test("formatContextAggregate: concise block ≤ 40 lines with trend", async () => {
  const { dir, window: win } = await makeFixture();
  try {
    const r = await aggregateContextAdoption(dir, win);
    const block = formatContextAggregate(r);
    const lineCount = block.split("\n").length;
    assert.ok(lineCount <= 40, `block must be ≤ 40 lines, got ${lineCount}`);
    assert.ok(block.includes("Adoption rate"), "block must show the adoption rate");
    assert.ok(block.includes("Trend"), "block must include a trend read");
    assert.ok(block.includes("10/13") || block.includes("77%"), "rate must reflect 10/13");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== Option B context-adoption aggregate tests passed ===");
