/**
 * Tool-batch-safe compaction boundaries: a braid-supplied firstKeptEntryId
 * must never split a tool batch.
 *
 * Why (the 400): braid supplies the compaction boundary (slide cut, archive
 * range, deterministic/failsafe cut) that pi-core consumes verbatim. pi-core's
 * own cut-point selector never picks a tool result - `isCutPointMessage`
 * returns false for toolResult (compaction.js:253-266) and `findValidCutPoints`
 * is built on it (compaction.js:288-305) - because a kept slice that opens
 * with a tool result, or keeps an assistant's tool_calls without all their
 * results, is a payload the provider rejects: "Messages with role 'tool' must
 * be a response to a preceding message with 'tool_calls'" (HTTP 400). A kept
 * slice produced by a braid supplier must satisfy the same invariant.
 *
 * The fixture models the real pi-core/session contracts:
 *   - branch entries are { id, parentId, type: "message", message: { role,
 *     content } }; an assistant tool call is a content block
 *     { type: "toolCall", id, name, arguments } and its result is a
 *     { role: "toolResult", toolCallId } message (verified against live
 *     sessions: an assistant entry's id precedes its tool results' ids);
 *   - ctx.compact(options) forwards options.customInstructions to
 *     session_before_compact (the SLIDE_MODE marker arrives as a string);
 *   - a session_before_compact handler may return { compaction } (the
 *     extension-compaction channel): pi-core then skips its LLM
 *     summarization and persists the provided result verbatim;
 *   - ctx.sessionManager.getBranch() returns the live path; extension state
 *     (cmState, batch settle) is keyed by the session file, so every fixture
 *     gets a unique one.
 *
 * Run: node test/runtime/memory/test-tool-batch-boundary.mjs
 */

import { strict as assert } from "node:assert";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..", "..");
const D = join(ROOT, "dist");

const { registerContextCompress } = await import(
  join(D, "extensions/memory/context-manager/handlers/tools/context-compress.js")
);
const { registerBeforeCompactHandler } = await import(
  join(D, "extensions/memory/context-manager/handlers/compaction.js")
);
const { getCmState } = await import(
  join(D, "extensions/memory/context-manager/handlers/shared.js")
);
const { resolveWindow } = await import(join(D, "lib/detection/context-usage.js"));
const { snapBoundaryOutsideToolBatch, findBoundaryViolation } = await import(
  join(D, "extensions/memory/context-manager/handlers/tool-batch-boundary.js")
);

console.log("=== tool-batch-safe compaction boundaries ===\n");

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

// ── The small validator the brief asks for ───────────────────────────────────-
// Given the branch and the index the kept slice starts at, report every
// structural problem in the slice [cutIndex..end]. Empty = a valid slice.
function callIdsOf(entry) {
  const m = entry?.message;
  if (entry?.type !== "message" || m?.role !== "assistant") return [];
  const ids = [];
  for (const b of Array.isArray(m.content) ? m.content : []) {
    if (b?.type === "toolCall" && typeof b.id === "string") ids.push(b.id);
  }
  for (const c of Array.isArray(m.toolCalls) ? m.toolCalls : []) {
    const id = c?.id ?? c?.toolCallId;
    if (typeof id === "string") ids.push(id);
  }
  return ids;
}
function resultIdOf(entry) {
  const m = entry?.message;
  if (entry?.type !== "message" || m?.role !== "toolResult") return undefined;
  return typeof m.toolCallId === "string" ? m.toolCallId : undefined;
}
function keptSliceViolations(branch, cutIndex) {
  const problems = [];
  if (cutIndex < 0 || cutIndex >= branch.length) {
    problems.push(`cut index ${cutIndex} out of range (branch ${branch.length})`);
    return problems;
  }
  if (resultIdOf(branch[cutIndex])) {
    problems.push(`kept slice begins with a tool result (${branch[cutIndex].id})`);
  }
  for (let i = cutIndex; i < branch.length; i++) {
    for (const id of callIdsOf(branch[i])) {
      let answered = false;
      for (let j = i + 1; j < branch.length; j++) {
        if (resultIdOf(branch[j]) === id) {
          answered = true;
          break;
        }
      }
      if (!answered) {
        problems.push(`tool_calls ${id} on ${branch[i].id} unanswered inside the kept slice`);
      }
    }
  }
  return problems;
}
function assertValidSlice(branch, cutIndex, label) {
  const problems = keptSliceViolations(branch, cutIndex);
  assert.deepEqual(problems, [], `${label}: kept slice must be structurally valid`);
}

// ── Fixture ───────────────────────────────────────────────────────────────────

let worldSeq = 0;

/**
 * A real, growable branch: `branchLength` large text entries, with a parallel
 * tool batch injected at `batchAt` (one assistant carrying `batchSize`
 * tool_calls, followed by one toolResult per call). Content is sized against
 * the RESOLVED window (chars/4 estimate) so the fixture stays above the
 * <30% skip guards regardless of the live settings.
 */
function makeWorld({ branchLength = 60, percent = 80, batchAt = 10, batchSize = 3 } = {}) {
  const branch = [];
  const window = resolveWindow(100000).contextWindow;
  const textLen = Math.max(40, Math.round(((percent / 100) * window * 4) / branchLength));
  for (let i = 0; i < branchLength; i++) {
    branch.push({
      id: `e${i}`,
      parentId: i === 0 ? null : `e${i - 1}`,
      type: "message",
      message: {
        role: i % 2 === 0 ? "user" : "assistant",
        content: [{ type: "text", text: `entry ${i} ${"x".repeat(textLen - 8)}` }],
        timestamp: 1000 + i,
      },
    });
  }
  // The batch: one assistant with N tool_calls, then N results. A mid-batch
  // cut (any result that is not the batch's first) is the live 400 shape.
  const owner = {
    id: `batch-owner`,
    parentId: branch[batchAt - 1]?.id ?? null,
    type: "message",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "calling N tools in parallel" },
        ...Array.from({ length: batchSize }, (_, k) => ({
          type: "toolCall",
          id: `call_${k}`,
          name: "read",
          arguments: { path: `/tmp/f${k}` },
        })),
      ],
      timestamp: 2000 + batchAt,
    },
  };
  branch[batchAt] = owner;
  for (let k = 0; k < batchSize; k++) {
    const idx = batchAt + 1 + k;
    branch[idx] = {
      id: `batch-result-${k}`,
      parentId: idx === 0 ? owner.id : branch[idx - 1].id,
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: `call_${k}`,
        toolName: "read",
        content: [{ type: "text", text: `result ${k}` }],
        timestamp: 2100 + idx,
      },
    };
  }
  // Re-link the entries after the batch so parent ids stay consistent.
  for (let i = batchAt + batchSize + 1; i < branch.length; i++) {
    branch[i].parentId = i === 0 ? null : branch[i - 1].id;
  }

  const sessionFile = join(
    tmpdir(),
    `tool-batch-boundary-${++worldSeq}-${Math.random().toString(36).slice(2)}.jsonl`,
  );
  const labels = new Map();
  const sm = {
    branch,
    labels,
    getSessionFile: () => sessionFile,
    getSessionId: () => `fixture-session-${worldSeq}`,
    getLeafId: () => branch[branch.length - 1]?.id,
    getBranch: () => branch,
    getTree: () => [{ entry: branch[0], children: [], label: labels.get(branch[0].id) }],
    getLabel: (id) => labels.get(id),
    getChildren: () => [],
    appendCustomEntry: (customType, data) => {
      const prev = branch[branch.length - 1];
      const entry = {
        id: `c${branch.length}`,
        parentId: prev?.id ?? null,
        type: "custom",
        customType,
        data,
        timestamp: new Date().toISOString(),
      };
      branch.push(entry);
      return entry.id;
    },
    appendCompaction: (summary, firstKeptEntryId, tokensBefore, details, fromHook, usage) => {
      const prev = branch[branch.length - 1];
      const entry = {
        id: `k${branch.length}`,
        parentId: prev?.id ?? null,
        type: "compaction",
        summary,
        firstKeptEntryId,
        tokensBefore,
        details,
        fromHook,
        usage,
        timestamp: new Date().toISOString(),
      };
      branch.push(entry);
      return entry.id;
    },
  };
  return { sm, branch, batchAt, batchSize };
}

function makeFakeCtx(sm) {
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    model: { contextWindow: 100000 },
    sessionManager: sm,
    compactCalls: [],
    compact(options) {
      this.compactCalls.push(options);
    },
  };
}

function makeFakePi(sm) {
  const handlers = new Map();
  const tools = new Map();
  return {
    handlers,
    tools,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    registerTool(def) {
      tools.set(def.name, def);
    },
    appendEntry(customType, data) {
      sm?.appendCustomEntry?.(customType, data);
    },
    async _emit(event, ...args) {
      const name = typeof event === "string" ? event : event.type;
      let result;
      for (const h of handlers.get(name) ?? []) {
        const r = await h(event, ...args);
        if (name === "session_before_compact" && r) result = r;
      }
      return result;
    },
  };
}

/** Batch owner index, its last result index, and the entry after it. */
function batchGeometry(world) {
  const { branch, batchAt, batchSize } = world;
  return {
    ownerIndex: batchAt,
    lastResultIndex: batchAt + batchSize,
    afterBatchIndex: batchAt + batchSize + 1,
    lastResultId: branch[batchAt + batchSize].id,
    afterBatchId: branch[batchAt + batchSize + 1].id,
  };
}

// ── Behavioral checks (RED before the fix, GREEN after) ───────────────────────

await test("slide cut landing mid-batch is snapped out of the batch", async () => {
  const world = makeWorld({ branchLength: 60, batchAt: 10, batchSize: 3 });
  const ctx = makeFakeCtx(world.sm);
  const pi = makeFakePi(world.sm);
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");
  assert.ok(tool, "context_compress registered");

  // keep=48 on a 60-entry branch -> the slide cut candidate is index 12, the
  // second of three results. Old behavior: cutEntryId = the tool result.
  const rawCutIndex = 60 - 48;
  assert.ok(
    world.branch[rawCutIndex]?.message?.role === "toolResult",
    `fixture: raw cut index ${rawCutIndex} is a tool result`,
  );
  const result = await tool.execute("s-1", { action: "slide", keep: 48 }, undefined, undefined, ctx);
  assert.ok(!result.details?.error, `slide accepted: ${result.content?.[0]?.text ?? ""}`);

  const slide = getCmState(ctx).slideMode;
  assert.ok(slide?.active && slide.cutEntryId, "slideMode persisted for session_before_compact");
  const cutIndex = world.branch.findIndex((e) => e.id === slide.cutEntryId);
  assert.ok(cutIndex >= 0, "slide cut points at a live entry");
  assertValidSlice(world.branch, cutIndex, "slide");
  assert.equal(
    slide.cutEntryId,
    batchGeometry(world).afterBatchId,
    "the cut snaps forward to the first entry after the batch's last tool result",
  );
});

await test("archive boundary landing mid-batch is snapped out of the batch", async () => {
  const world = makeWorld({ branchLength: 60, batchAt: 10, batchSize: 3 });
  const ctx = makeFakeCtx(world.sm);
  const pi = makeFakePi(world.sm);
  registerContextCompress(pi);
  const tool = pi.tools.get("context_compress");

  // endIndex=11 -> declared boundary = branch[12], the second of three
  // results. Old behavior: firstKeptEntryId = the tool result.
  const result = await tool.execute(
    "a-1",
    {
      action: "archive",
      startIndex: 0,
      endIndex: 11,
      topic: "fixture",
      summary: "Owner: fixture. Braid: fixture.",
    },
    undefined,
    undefined,
    ctx,
  );
  assert.ok(!result.details?.error, `archive accepted: ${result.content?.[0]?.text ?? ""}`);

  const rangeMode = getCmState(ctx).rangeMode;
  assert.ok(rangeMode?.active, "rangeMode persisted for session_before_compact");
  const boundaryIndex = world.branch.findIndex((e) => e.id === rangeMode.firstKeptEntryId);
  assert.ok(boundaryIndex >= 0, "archive boundary points at a live entry");
  assertValidSlice(world.branch, boundaryIndex, "archive");
  assert.equal(
    rangeMode.firstKeptEntryId,
    batchGeometry(world).afterBatchId,
    "the declared boundary snaps forward out of the batch",
  );
});

await test("session_before_compact re-snaps a raw mid-batch slide cut (foreign armer)", async () => {
  const world = makeWorld({ branchLength: 60, batchAt: 10, batchSize: 3 });
  const ctx = makeFakeCtx(world.sm);
  const pi = makeFakePi(world.sm);
  registerBeforeCompactHandler(pi);

  // A cut armed raw on a mid-batch result - the state any boundary supplier
  // that bypassed the helper would leave behind.
  const rawCutIndex = 12;
  assert.ok(world.branch[rawCutIndex]?.message?.role === "toolResult");
  getCmState(ctx).slideMode = {
    active: true,
    cutEntryId: world.branch[rawCutIndex].id,
    keepCount: 48,
    droppedCount: rawCutIndex,
    timestamp: Date.now(),
  };

  const prep = {
    firstKeptEntryId: world.branch[40].id,
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 1234,
  };
  const outcome = await pi._emit(
    {
      type: "session_before_compact",
      preparation: prep,
      customInstructions: "SLIDE_MODE:true",
      reason: "manual",
    },
    ctx,
  );
  assert.ok(outcome?.compaction, "handler returns the extension compaction object");
  const boundaryIndex = world.branch.findIndex(
    (e) => e.id === outcome.compaction.firstKeptEntryId,
  );
  assert.ok(boundaryIndex >= 0, "compaction anchor points at a live entry");
  assertValidSlice(world.branch, boundaryIndex, "session_before_compact");
  assert.equal(
    outcome.compaction.firstKeptEntryId,
    batchGeometry(world).afterBatchId,
    "the consumed slide boundary is re-snapped against the current branch",
  );
});

// ── The helper, on hand-built branches ────────────────────────────────────────

/** prefix text entries, one assistant with `batchSize` calls, N results, suffix. */
function makeBatchBranch({ prefix = 4, batchSize = 3, suffix = 2, callsShape = "content" } = {}) {
  const entries = [];
  for (let i = 0; i < prefix; i++) {
    entries.push({ id: `p${i}`, type: "message", message: { role: "user", content: [] } });
  }
  const callIds = Array.from({ length: batchSize }, (_, k) => `call_${k}`);
  entries.push({
    id: "owner",
    type: "message",
    message:
      callsShape === "content"
        ? {
            role: "assistant",
            content: callIds.map((id) => ({ type: "toolCall", id, name: "read", arguments: {} })),
          }
        : { role: "assistant", content: [], toolCalls: callIds.map((id) => ({ id })) },
  });
  for (let k = 0; k < batchSize; k++) {
    entries.push({
      id: `r${k}`,
      type: "message",
      message: { role: "toolResult", toolCallId: callIds[k], content: [] },
    });
  }
  for (let i = 0; i < suffix; i++) {
    entries.push({ id: `s${i}`, type: "message", message: { role: "assistant", content: [] } });
  }
  return entries;
}

await test("validator: the old mid-batch boundary is structurally invalid", () => {
  const branch = makeBatchBranch({ prefix: 4, batchSize: 3, suffix: 2 });
  const rawCutIndex = 4 + 1; // first result: the old cut shape
  const problems = keptSliceViolations(branch, rawCutIndex);
  assert.ok(
    problems.some((p) => p.includes("begins with a tool result")),
    `raw mid-batch cut must be flagged, got ${JSON.stringify(problems)}`,
  );
});

await test("helper: mid-batch candidate snaps forward past the batch's last result", () => {
  const branch = makeBatchBranch({ prefix: 4, batchSize: 3, suffix: 2 });
  const snapped = snapBoundaryOutsideToolBatch(branch, 4 + 1);
  assert.equal(snapped, 4 + 3 + 1, "first entry after the batch's last tool result");
  assertValidSlice(branch, snapped, "helper forward snap");
});

await test("helper: mid-batch candidate with no room forward snaps backward to the assistant", () => {
  const branch = makeBatchBranch({ prefix: 4, batchSize: 3, suffix: 0 });
  const snapped = snapBoundaryOutsideToolBatch(branch, 4 + 1);
  assert.equal(snapped, 4, "the batch's assistant message is kept live");
  assertValidSlice(branch, snapped, "helper backward snap");
});

await test("helper: a valid candidate is returned unchanged", () => {
  const branch = makeBatchBranch({ prefix: 4, batchSize: 3, suffix: 2 });
  assert.equal(snapBoundaryOutsideToolBatch(branch, 4), 4, "assistant start is valid");
  assert.equal(snapBoundaryOutsideToolBatch(branch, 4 + 3 + 1), 4 + 3 + 1, "post-batch entry");
  assert.equal(findBoundaryViolation(branch, 4 + 3 + 1), null);
});

await test("helper: orphaned leading results (call gone from the branch) are dropped", () => {
  const branch = makeBatchBranch({ prefix: 4, batchSize: 2, suffix: 1 });
  const orphaned = [
    { id: "orphan-0", type: "message", message: { role: "toolResult", toolCallId: "gone-0" } },
    { id: "orphan-1", type: "message", message: { role: "toolResult", toolCallId: "gone-1" } },
    ...branch,
  ];
  const snapped = snapBoundaryOutsideToolBatch(orphaned, 0);
  assert.equal(snapped, 2, "snap forward past the orphaned run");
  assertValidSlice(orphaned, snapped, "helper orphan snap");
});

await test("helper: an assistant with unanswered tool_calls inside the slice drops the batch", () => {
  // One assistant, two calls, one result, then suffix entries: the batch is
  // truncated, so no boundary can keep the assistant.
  const branch = [
    { id: "p0", type: "message", message: { role: "user", content: [] } },
    {
      id: "owner",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "toolCall", id: "call_0" },
          { type: "toolCall", id: "call_1" },
        ],
      },
    },
    { id: "r0", type: "message", message: { role: "toolResult", toolCallId: "call_0" } },
    { id: "s0", type: "message", message: { role: "assistant", content: [] } },
    { id: "s1", type: "message", message: { role: "assistant", content: [] } },
  ];
  const violation = findBoundaryViolation(branch, 1);
  assert.equal(violation?.kind, "unanswered-tool-calls", "unanswered calls are flagged");
  const snapped = snapBoundaryOutsideToolBatch(branch, 1);
  assert.equal(snapped, 3, "the truncated batch is dropped");
  assertValidSlice(branch, snapped, "helper unanswered snap");
});

await test("helper: converted toolCalls shape is read too", () => {
  const branch = makeBatchBranch({ prefix: 2, batchSize: 2, suffix: 1, callsShape: "toolCalls" });
  assert.equal(findBoundaryViolation(branch, 2 + 1)?.kind, "leading-tool-result");
  const snapped = snapBoundaryOutsideToolBatch(branch, 2 + 1);
  assert.equal(snapped, 2 + 2 + 1);
  assertValidSlice(branch, snapped, "helper toolCalls shape");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
