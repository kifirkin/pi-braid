/**
 * Test: File Diff Tool
 *
 * Verifies that the diff extension registers correctly, parses unified diffs,
 * and handles file comparison, git diff, and summary modes.
 */

const ROOT = "/Users/kifir/projects/agents/pi-braid";

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

// ── [1] Extension file exists and registers tool ─────────────────
console.log("\n[1] Diff extension structure");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/contrib/diff/index.ts`, "utf8");

  assert(src.includes("export default function diffExtension"), "exports default function");
  assert(src.includes("registerTool"), "registers a tool");
  assert(src.includes("file_diff"), "tool name is file_diff");
  assert(src.includes("fileA"), "accepts fileA parameter");
  assert(src.includes("fileB"), "accepts fileB parameter");
  assert(src.includes("gitRefA"), "accepts gitRefA for git diff");
  assert(src.includes("parseUnifiedDiff"), "has unified diff parser");
  assert(src.includes("formatResult"), "has result formatter");
  assert(src.includes("diffFiles"), "has file diff engine");
  assert(src.includes("diffGit"), "has git diff engine");
  assert(src.includes("DiffHunk"), "exports DiffHunk type");
  assert(src.includes("DiffChange"), "exports DiffChange type");
  assert(src.includes("DiffResult"), "exports DiffResult type");
}

// ── [2] Registered in extension manifest ────────────────────────────
console.log("\n[2] Extension manifest registration");
{
  const fs = await import("fs");
  const mani = fs.readFileSync(`${ROOT}/src/extensions/manifest.ts`, "utf8");

  assert(mani.includes("diffFn"), "diffFn imported in manifest");
  assert(mani.includes('"diff"'), "diff listed in manifest");
}

// ── [3] Parse unified diff ────────────────────────────────────────
console.log("\n[3] Diff parser");
{
  // Import the parser function from dist
  const { parseUnifiedDiff } = await import("../../../dist/contrib/diff/index.js");

  const sampleDiff = `--- a/file.txt
+++ b/file.txt
@@ -1,4 +1,5 @@
 line1
-line2
+line2-modified
 line3
+line4-new
 line5`;

  const hunks = parseUnifiedDiff(sampleDiff);
  assert(hunks.length === 1, "Parsed 1 hunk");
  assert(hunks[0].oldStart === 1, "Hunk oldStart = 1");
  assert(hunks[0].newStart === 1, "Hunk newStart = 1");
  assert(hunks[0].changes.length > 0, "Hunk has changes");

  const adds = hunks[0].changes.filter((c) => c.type === "add");
  const dels = hunks[0].changes.filter((c) => c.type === "del");
  const ctxs = hunks[0].changes.filter((c) => c.type === "ctx");

  assert(adds.length === 2, "2 additions found");
  assert(dels.length === 1, "1 deletion found");
  assert(ctxs.length >= 2, "Context lines found");
  assert(adds[0].content === "line2-modified", "Addition content correct");
  assert(dels[0].content === "line2", "Deletion content correct");
}

// ── [4] Parse empty/matching files ────────────────────────────────
console.log("\n[4] Empty diff handling");
{
  const { parseUnifiedDiff } = await import("../../../dist/contrib/diff/index.js");

  const emptyHunks = parseUnifiedDiff("");
  assert(emptyHunks.length === 0, "No hunks from empty input");

  const noChangeDiff = `--- a/file.txt
+++ b/file.txt`;
  const noChangeHunks = parseUnifiedDiff(noChangeDiff);
  assert(noChangeHunks.length === 0, "No hunks from header-only diff");
}

// ── [5] Multiple hunks ────────────────────────────────────────────
console.log("\n[5] Multi-hunk diff parsing");
{
  const { parseUnifiedDiff } = await import("../../../dist/contrib/diff/index.js");

  const multiHunkDiff = `--- a/file.txt
+++ b/file.txt
@@ -1,3 +1,4 @@
 a
-b
+b-modified
 c
@@ -10,3 +11,4 @@
 x
 y
+z-added
 w`;

  const hunks = parseUnifiedDiff(multiHunkDiff);
  assert(hunks.length === 2, "Parsed 2 hunks");
  assert(hunks[0].oldStart === 1, "First hunk oldStart = 1");
  assert(hunks[1].oldStart === 10, "Second hunk oldStart = 10");
  assert(hunks[1].changes.filter((c) => c.type === "add").length === 1, "Second hunk has 1 addition");
}

// ── [6] Event bus integration — ToolErrorEvent ────────────────────
console.log("\n[6] ToolErrorEvent in event bus");
{
  const fs = await import("fs");
  const lib = fs.readFileSync(`${ROOT}/src/lib/events/event-bus.ts`, "utf8");

  assert(lib.includes("ToolErrorEvent"), "ToolErrorEvent interface defined");
  assert(lib.includes("tool_error"), "tool_error type emitted");
  assert(lib.includes("toolName"), "ToolErrorEvent has toolName");
  assert(lib.includes("ToolErrorEvent") && lib.includes("AgentEvent ="), "ToolErrorEvent included in AgentEvent union");
}

// ── [7] Error-capture emits tool_error ────────────────────────────
console.log("\n[7] Error-capture emits tool_error");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/extensions/error-tracking/index.ts`, "utf8");

  assert(src.includes("eventBus.emit"), "eventBus.emit called on tool failure");
  assert(src.includes('type: "tool_error"'), "emits tool_error event type");
  assert(src.includes("toolName"), "includes toolName in emission");
}

// Summary
console.log("\n" + ("=").repeat(50));
console.log("Diff Tool Tests: " + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
