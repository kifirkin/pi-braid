/**
 * Test: verification judge task-wide evidence + redelivery skip.
 *
 * BACKGROUND: the judge produced 3 false alarms (WARN 62%,
 * FAIL 82%, FAIL 92%) for work that WAS done. Root cause: JudgeContext.toolLog
 * is built from enforcement turnHistory (recorded only at turn_end); a turn
 * broken by a wake-retry redelivery leaves the judge auditing the
 * redelivered TAIL turn whose log holds only finalize + response text.
 *
 * Fix under test:
 * 1. task-evidence.ts rebuilds evidence since the task's last REAL user
 * message from the pi session store (sessionManager.getBranch()) —
 * survives turn breaks. Injected custom messages never reset the
 * boundary. Capped at TASK_EVIDENCE_CAP with an explicit count line.
 * 2. verification-judge.buildVerificationPrompt renders the TASK EVIDENCE
 * section (TOOL EXECUTION LOG kept as-is).
 * 3. wake-retry exposes a read accessor (isWakeRedeliveryInFlight) and the
 * enforcement MESSAGE_END handler skips the judge while a redelivery
 * (attempt >= 1) is in flight. NO redelivery behavior change.
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

console.log("=== judge task-wide evidence + redelivery skip ===\n");

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

// ── Fixtures ────────────────────────────────────────────────────────────────

/** A session-store message entry (shape mirrors pi-core SessionMessageEntry). */
function msgEntry(role, content, timestamp) {
  return {
    type: "message",
    id: `m-${Math.random().toString(36).slice(2)}`,
    parentId: null,
    timestamp,
    message: { role, content },
  };
}
function toolResultEntry(toolName, toolCallId, isError, text, timestamp) {
  return {
    type: "message",
    id: `r-${Math.random().toString(36).slice(2)}`,
    parentId: null,
    timestamp,
    message: {
      role: "toolResult",
      toolCallId,
      toolName,
      isError,
      content: [{ type: "text", text }],
    },
  };
}
function assistantEntry(contentItems, timestamp) {
  return {
    type: "message",
    id: `a-${Math.random().toString(36).slice(2)}`,
    parentId: null,
    timestamp,
    message: { role: "assistant", content: contentItems },
  };
}
function toolCallItem(id, name, args) {
  return { type: "toolCall", id, name, arguments: args };
}
/** Injected braid traffic (whisper/timer fire) — custom_message, never a user message. */
function injectedEntry(timestamp) {
  return {
    type: "custom_message",
    customType: "timer-fire",
    id: "c-1",
    parentId: null,
    timestamp,
    display: true,
    content: [{ type: "text", text: "[timer] resume - Resume the task." }],
    details: { _braidInjected: true, _braidSource: "timer/fire-retry" },
  };
}
/** Fake ExtensionContext carrying only the sessionManager the collector reads. */
function fakeCtx(branch) {
  return { sessionManager: { getBranch: () => branch } };
}

const t = (n) => `2026-09-09T09:0${n}:00.000Z`;

// ── 1. Task evidence: previous-turn evidence survives into the prompt ────────

await test("collectTaskEvidence includes turn-1 evidence for a judge call in turn 2", async () => {
  const { collectTaskEvidence } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  const branch = [
    msgEntry("user", "Fix the judge", t(0)),
    // turn 1: real verification evidence
    assistantEntry([toolCallItem("tc-1", "bash", { command: "npm test" })], t(1)),
    toolResultEntry("bash", "tc-1", false, "81 passed, 0 failed", t(1)),
    assistantEntry([toolCallItem("tc-2", "telegram_send", { text: "done" })], t(2)),
    toolResultEntry("telegram_send", "tc-2", false, '{"ok":true,"message_id":42}', t(2)),
    // injected whisper between turns — must NOT reset the boundary
    injectedEntry(t(3)),
    // turn 2 (the judge call): finalize with no result yet
    assistantEntry(
      [
        { type: "text", text: "wrapping up" },
        toolCallItem("tc-3", "finalize", { completed: true }),
      ],
      t(4),
    ),
  ];
  const evidence = collectTaskEvidence(fakeCtx(branch));
  assert.ok(evidence, "evidence must be collected");
  const joined = evidence.lines.join("\n");
  assert.ok(joined.includes("task start: user"), "boundary marker line present");
  assert.ok(joined.includes("bash [OK]"), "turn-1 bash [OK] line present");
  assert.ok(joined.includes("npm test"), "bash command included for command runners");
  assert.ok(joined.includes("telegram_send [OK]"), "telegram_send receipt line present");
  assert.ok(joined.includes("message_id"), "receipt payload visible");
  assert.ok(
    !joined.includes("Resume the task"),
    "injected custom message text must not leak into evidence",
  );
  assert.ok(joined.includes("finalize"), "finalize call visible");
});

await test("prompt renders TASK EVIDENCE section above the current-window TOOL EXECUTION LOG", async () => {
  const { buildVerificationPrompt } = await import(
    join(ROOT, "dist/extensions/enforcement/verification-judge.js")
  );
  const prompt = buildVerificationPrompt({
    userRequest: "Fix the judge",
    toolsUsed: ["bash", "finalize"],
    toolLog: ["Turn 9: [finalize]"], // the redelivered tail turn: finalize + text only
    hasCodeChanges: false,
    lastResponse: "done",
    thinking: "",
    taskEvidence: [
      `09:00:00 ── task start: user ── Fix the judge`,
      `09:01:00 bash [OK]: $ npm test: 81 passed, 0 failed`,
    ],
  });
  assert.ok(
    prompt.includes("## TASK EVIDENCE (since last user message, disk/session-surviving)"),
    "TASK EVIDENCE section present",
  );
  assert.ok(
    prompt.includes("bash [OK]: $ npm test: 81 passed"),
    "previous-turn evidence in prompt",
  );
  const evIdx = prompt.indexOf("## TASK EVIDENCE");
  const logIdx = prompt.indexOf("## TOOL EXECUTION LOG");
  assert.ok(
    evIdx !== -1 && logIdx !== -1 && evIdx < logIdx,
    "TASK EVIDENCE rendered before TOOL EXECUTION LOG",
  );
  assert.ok(prompt.includes("Turn 9: [finalize]"), "current-window TOOL EXECUTION LOG kept as-is");
});

// ── 2. Task boundary semantics ───────────────────────────────────────────────

await test("a new real user message resets the evidence window", async () => {
  const { collectTaskEvidence } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  const branch = [
    msgEntry("user", "First task", t(0)),
    toolResultEntry("bash", "tc-old", false, "old evidence", t(1)),
    msgEntry("user", "Second task", t(2)),
    toolResultEntry("bash", "tc-new", false, "new evidence", t(3)),
  ];
  const evidence = collectTaskEvidence(fakeCtx(branch));
  const joined = evidence.lines.join("\n");
  assert.ok(joined.includes("Second task"), "current boundary marker present");
  assert.ok(joined.includes("new evidence"), "current-task evidence present");
  assert.ok(!joined.includes("old evidence"), "previous-task evidence dropped");
});

await test("injected custom messages do not reset the evidence window", async () => {
  const { collectTaskEvidence } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  const branch = [
    msgEntry("user", "One task", t(0)),
    toolResultEntry("bash", "tc-1", false, "before whisper", t(1)),
    injectedEntry(t(2)),
    toolResultEntry("bash", "tc-2", false, "after whisper", t(3)),
  ];
  const evidence = collectTaskEvidence(fakeCtx(branch));
  const joined = evidence.lines.join("\n");
  assert.ok(
    joined.includes("before whisper") && joined.includes("after whisper"),
    "evidence on both sides of an injected whisper survives",
  );
});

await test("failed tool results keep the [FAIL] prefix", async () => {
  const { collectTaskEvidence } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  const branch = [
    msgEntry("user", "task", t(0)),
    toolResultEntry("bash", "tc-1", true, "Error: 1 failed", t(1)),
  ];
  const evidence = collectTaskEvidence(fakeCtx(branch));
  assert.ok(
    /^\d{2}:\d{2}:\d{2}/.test(evidence.lines[1]),
    `line timestamped (got: ${evidence.lines[1].slice(0, 10)})`,
  );
  assert.ok(evidence.lines[1].includes("bash [FAIL]"), "FAIL status present");
  assert.ok(evidence.lines[1].includes("Error: 1 failed"), "failure snippet present");
});

// ── 3. Cap behavior ──────────────────────────────────────────────────────────

await test("cap honored with explicit count line (never silent truncation)", async () => {
  const { collectTaskEvidence, renderTaskEvidence, TASK_EVIDENCE_CAP } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  assert.strictEqual(TASK_EVIDENCE_CAP, 200, "cap constant is 200");
  const branch = [msgEntry("user", "task", t(0))];
  const extra = TASK_EVIDENCE_CAP + 50; // results beyond the cap (plus the boundary line = CAP+51 entries)
  for (let i = 0; i < extra; i++) {
    branch.push(toolResultEntry("bash", `tc-${i}`, false, `result ${i}`, t(1)));
  }
  // Entries: boundary line + `extra`results (each toolResult is 1 line).
  const total = 1 + extra;
  const evidence = collectTaskEvidence(fakeCtx(branch));
  assert.strictEqual(
    evidence.truncatedCount,
    total - TASK_EVIDENCE_CAP,
    "truncatedCount counts dropped front entries",
  );
  assert.strictEqual(evidence.lines.length, TASK_EVIDENCE_CAP, "cap honored");
  const rendered = renderTaskEvidence(evidence);
  assert.strictEqual(rendered.length, TASK_EVIDENCE_CAP + 1, "count line prepended");
  assert.ok(
    rendered[0].includes(`${total - TASK_EVIDENCE_CAP} older evidence entries truncated`),
    "count line names dropped entries",
  );
  assert.ok(rendered[rendered.length - 1].includes(`result ${extra - 1}`), "newest line kept");
  // Prompt-only path: no truncation -> no count line.
  const noTrunc = renderTaskEvidence({ lines: ["a"], truncatedCount: 0 });
  assert.deepStrictEqual(noTrunc, ["a"]);
});

// ── 4. In-flight calls ───────────────────────────────────────────────────────

await test("result-less finalize call of the audited message emitted as in-flight", async () => {
  const { collectTaskEvidence } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  const branch = [
    msgEntry("user", "task", t(0)),
    assistantEntry([toolCallItem("tc-1", "bash", { command: "npm test" })], t(1)),
    toolResultEntry("bash", "tc-1", false, "ok", t(1)),
    assistantEntry([toolCallItem("tc-2", "finalize", { completed: true })], t(2)),
  ];
  const evidence = collectTaskEvidence(fakeCtx(branch));
  const inFlight = evidence.lines.filter((l) => l.includes("finalize"));
  assert.strictEqual(inFlight.length, 1, "exactly one finalize line");
  assert.ok(inFlight[0].includes("in flight"), "marked as in flight (no toolResult yet)");
});

await test("stale result-less calls from older turns are NOT emitted", async () => {
  const { collectTaskEvidence } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  const branch = [
    msgEntry("user", "task", t(0)),
    assistantEntry([toolCallItem("tc-abort", "bash", { command: "aborted turn call" })], t(1)),
    // aborted turn: no toolResult; a LATER turn completes with a result
    assistantEntry([toolCallItem("tc-2", "bash", { command: "npm test" })], t(2)),
    toolResultEntry("bash", "tc-2", false, "ok", t(3)),
  ];
  const evidence = collectTaskEvidence(fakeCtx(branch));
  const joined = evidence.lines.join("\n");
  assert.ok(
    !joined.includes("in flight"),
    "no stale in-flight lines when branch ends with a result",
  );
  assert.ok(!joined.includes("aborted turn call"), "stale aborted call not surfaced");
});

await test("session store unavailable -> collectTaskEvidence returns null", async () => {
  const { collectTaskEvidence } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  assert.strictEqual(
    collectTaskEvidence({}),
    null,
    "null on missing sessionManager (fallback path)",
  );
  assert.strictEqual(collectTaskEvidence(fakeCtx([])), null, "null on empty branch");
});

// ── 5. Redelivery skip gate ──────────────────────────────────────────────────

await test("isWakeRedeliveryInFlight tracks outstanding redeliveries (attempt >= 1) only", async () => {
  const { wakeRetryQueue, isWakeRedeliveryInFlight, WAKE_OUTCOME_TIMEOUT_MS } = await import(
    join(ROOT, "dist/extensions/scheduling/timer/wake-retry.js")
  );
  wakeRetryQueue.resetForTests();
  try {
    assert.strictEqual(isWakeRedeliveryInFlight(), false, "no outstanding wakes -> false");
    // Original fire (attempt 0): judge must NOT skip.
    wakeRetryQueue.trackWake({ id: "timer-orig", firesAt: 0, reason: "r", wake: true }, 0);
    assert.strictEqual(
      isWakeRedeliveryInFlight(),
      false,
      "original fire (attempt 0) is not a redelivery",
    );
    // Redelivery (attempt 1): judge must skip.
    wakeRetryQueue.trackWake({ id: "timer-retry", firesAt: 0, reason: "r", wake: true }, 1);
    assert.strictEqual(
      isWakeRedeliveryInFlight(),
      true,
      "outstanding redelivery (attempt 1) detected",
    );
    // Outcome timeout arms a PENDING retry (not yet delivered): still not "in flight".
    wakeRetryQueue.resetForTests();
    wakeRetryQueue._setClockForTests(() => 1_000_000); // pin sentAt
    wakeRetryQueue.trackWake({ id: "timer-long", firesAt: 0, reason: "r", wake: true }, 0);
    wakeRetryQueue._setClockForTests(() => 1_000_000 + WAKE_OUTCOME_TIMEOUT_MS + 1_000); // jump past the outcome window (240s)
    const due = wakeRetryQueue.drainDue();
    assert.strictEqual(due.length, 0, "armed retry still inside its 5s backoff — not due yet");
    assert.strictEqual(wakeRetryQueue.pendingRetryCount(), 1, "outcome timeout arms the retry");
    assert.strictEqual(
      isWakeRedeliveryInFlight(),
      false,
      "armed-but-not-delivered retry is not in flight (original turn judged)",
    );
    // Settle resolves the outstanding entry -> gate closes.
    wakeRetryQueue.resetForTests();
    wakeRetryQueue.trackWake({ id: "timer-retry2", firesAt: 0, reason: "r", wake: true }, 2);
    wakeRetryQueue.onAgentEnd(false);
    wakeRetryQueue.onAgentSettled();
    assert.strictEqual(
      isWakeRedeliveryInFlight(),
      false,
      "settled outstanding wake clears the gate",
    );
  } finally {
    wakeRetryQueue.resetForTests();
    wakeRetryQueue._setClockForTests(null);
  }
});

await test("redelivery marker: outcome timeout keeps the timed-out entry flagged, not re-attempted", async () => {
  const { wakeRetryQueue } = await import(
    join(ROOT, "dist/extensions/scheduling/timer/wake-retry.js")
  );
  wakeRetryQueue.resetForTests();
  wakeRetryQueue._setClockForTests(() => 1_000_000);
  try {
    wakeRetryQueue.trackWake({ id: "timer-x", firesAt: 0, reason: "r", wake: true }, 0);
    wakeRetryQueue.drainDue(); // arms retry 1, marks entry timedOut
    const due = wakeRetryQueue.drainDue();
    assert.strictEqual(due.length, 0, "timedOut entry not re-armed twice (re-arm guard intact)");
  } finally {
    wakeRetryQueue.resetForTests();
    wakeRetryQueue._setClockForTests(null);
  }
});

// ── 6. Handler wiring smoke ──────────────────────────────────────────────────

await test("MESSAGE_END handler wires the gate and the evidence collector", async () => {
  const { registerMessageEndHandler } = await import(
    join(ROOT, "dist/extensions/enforcement/handlers/register-message-end.js")
  );
  assert.strictEqual(typeof registerMessageEndHandler, "function", "handler export intact");
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    join(ROOT, "dist/extensions/enforcement/handlers/register-message-end.js"),
    "utf-8",
  );
  assert.ok(src.includes("isWakeRedeliveryInFlight"), "redelivery skip gate wired");
  assert.ok(src.includes("collectTaskEvidence"), "task evidence collector wired");
  assert.ok(src.includes("renderTaskEvidence"), "evidence renderer wired");
});

// ── 7. Chunked evidence summaries (over-cap logs) ──────────────────────────

/** Hand-built TaskEvidence with `n`ordered evidence lines (no session store needed). */
function evidenceOf(n) {
  return {
    lines: Array.from({ length: n }, (_, i) => `09:00:00 bash [OK]: $ cmd ${i}: result ${i}`),
    truncatedCount: 0,
  };
}

await test("summarize: at or under the cap -> no sub-calls, output identical to the legacy render", async () => {
  const { collectTaskEvidence, renderTaskEvidence, summarizeTaskEvidence, TASK_EVIDENCE_CAP } =
    await import(join(ROOT, "dist/extensions/enforcement/task-evidence.js"));
  const branch = [msgEntry("user", "task", t(0))];
  for (let i = 0; i < TASK_EVIDENCE_CAP - 1; i++) {
    branch.push(toolResultEntry("bash", `tc-${i}`, false, `result ${i}`, t(1)));
  }
  const evidence = collectTaskEvidence(fakeCtx(branch), { cap: false });
  assert.ok(evidence, "evidence collected");
  assert.strictEqual(
    evidence.lines.length,
    TASK_EVIDENCE_CAP,
    "uncapped collect returns every line",
  );
  let calls = 0;
  const out = await summarizeTaskEvidence(fakeCtx(branch), evidence, {
    summarizeLlm: async () => {
      calls++;
      return { text: "sub-call must not fire" };
    },
  });
  assert.strictEqual(calls, 0, "no LLM sub-calls at or under the cap");
  assert.deepStrictEqual(out, renderTaskEvidence(evidence), "identical to the legacy render");
  // Default collect behavior unchanged: still caps with an explicit count.
  const capped = collectTaskEvidence(fakeCtx(branch));
  assert.strictEqual(capped.lines.length, TASK_EVIDENCE_CAP, "default collect still caps");
  assert.strictEqual(capped.truncatedCount, 0, "no drops at exactly the cap");
});

await test("summarize: over the cap -> sub-calls fire, summaries render in order, newest chunk stays raw", async () => {
  const { summarizeTaskEvidence } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  const evidence = evidenceOf(250); // ceil(250/150)-1 = 1 summary chunk -> chunks of 125 + 125
  const calls = [];
  const out = await summarizeTaskEvidence(fakeCtx([]), evidence, {
    summarizeLlm: async (systemPrompt, userPrompt) => {
      calls.push({ systemPrompt, userPrompt });
      return { text: `S${calls.length}` };
    },
  });
  assert.strictEqual(calls.length, 1, "one sub-call for the single older chunk");
  assert.ok(
    /\[OK\]/.test(calls[0].systemPrompt),
    "sub-call system prompt asks to preserve OK/FAIL counts",
  );
  assert.ok(calls[0].userPrompt.includes("cmd 0"), "sub-call covers the oldest lines");
  assert.ok(!calls[0].userPrompt.includes("cmd 249"), "sub-call excludes the newest chunk");
  assert.strictEqual(out[0], "(chunk 1/2 summary) S1", "numbered summary line renders first");
  assert.deepStrictEqual(
    out.slice(1),
    evidence.lines.slice(125),
    "raw newest chunk verbatim after the summary",
  );
  assert.ok(
    !out.join("\n").includes("older evidence entries truncated"),
    "no count line (nothing dropped)",
  );
});

await test("summarize: adaptive chunk bound — 1200-line log and a huge log stay within 6 sub-calls", async () => {
  const { summarizeTaskEvidence, MAX_CHUNK_SUMMARIES } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  assert.strictEqual(MAX_CHUNK_SUMMARIES, 6, "bound constant is 6");
  let calls = 0;
  const summarize = async () => {
    calls++;
    return { text: `S${calls}` };
  };
  const out = await summarizeTaskEvidence(fakeCtx([]), evidenceOf(1200), {
    summarizeLlm: summarize,
  });
  assert.strictEqual(
    calls,
    MAX_CHUNK_SUMMARIES,
    "1200-line log uses the full bound (<= 6 sub-calls)",
  );
  const summaryLines = out.filter((l) => l.startsWith("(chunk "));
  assert.strictEqual(summaryLines.length, calls, "one summary line per sub-call");
  assert.strictEqual(summaryLines[0], "(chunk 1/7 summary) S1", "summaries numbered oldest-first");
  assert.strictEqual(
    summaryLines[calls - 1],
    `(chunk ${calls}/7 summary) S${calls}`,
    "summary order matches chunk order",
  );
  assert.strictEqual(
    out[out.length - 1].endsWith("result 1199"),
    true,
    "newest line rendered last, raw",
  );
  // The bound holds regardless of log length: chunk size grows instead.
  const before = calls;
  await summarizeTaskEvidence(fakeCtx([]), evidenceOf(10000), { summarizeLlm: summarize });
  assert.strictEqual(calls - before, MAX_CHUNK_SUMMARIES, "10000-line log also stays at the bound");
});

await test("summarize: any sub-call failure degrades to the exact legacy drop-oldest output", async () => {
  const { renderTaskEvidence, summarizeTaskEvidence, TASK_EVIDENCE_CAP } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  const lines = evidenceOf(250).lines;
  const legacy = renderTaskEvidence({
    lines: lines.slice(lines.length - TASK_EVIDENCE_CAP),
    truncatedCount: lines.length - TASK_EVIDENCE_CAP,
  });
  const call = (impl) =>
    summarizeTaskEvidence(fakeCtx([]), { lines, truncatedCount: 0 }, { summarizeLlm: impl });
  // The call-site fallback expression: null -> renderTaskEvidence(uncapped evidence).
  const fallbackOf = async (impl) => {
    const summarized = await call(impl);
    return summarized ?? renderTaskEvidence({ lines, truncatedCount: 0 });
  };
  assert.deepStrictEqual(
    await fallbackOf(async () => ({ error: "model unavailable" })),
    legacy,
    "error result -> legacy output",
  );
  assert.deepStrictEqual(
    await fallbackOf(async () => {
      throw new Error("seam threw");
    }),
    legacy,
    "thrown error -> legacy output",
  );
  assert.deepStrictEqual(
    await fallbackOf(async () => ({ text: "   " })),
    legacy,
    "blank summary -> legacy output",
  );
  assert.deepStrictEqual(
    await call(async () => ({ error: "model unavailable" })),
    null,
    "failure surfaces as null for the caller",
  );
  assert.ok(
    legacy[0].includes("50 older evidence entries truncated"),
    "legacy fallback carries the count line",
  );
});

await test("summarize: the judge's abort signal reaches sub-calls; abort degrades to the legacy render", async () => {
  const { renderTaskEvidence, summarizeTaskEvidence, TASK_EVIDENCE_CAP } = await import(
    join(ROOT, "dist/extensions/enforcement/task-evidence.js")
  );
  const lines = evidenceOf(250).lines;
  const controller = new AbortController();
  const seen = [];
  const out = await summarizeTaskEvidence(
    fakeCtx([]),
    { lines, truncatedCount: 0 },
    {
      signal: controller.signal,
      summarizeLlm: async (_systemPrompt, _userPrompt, subOptions) => {
        seen.push(subOptions.signal);
        controller.abort();
        return { error: "Request was aborted" };
      },
    },
  );
  assert.deepStrictEqual(seen, [controller.signal], "sub-call received the judge's own signal");
  assert.strictEqual(out, null, "abort-shaped failure falls back (null) for the caller");
  // Call-site expression on the fallback path: the judge still gets a full section.
  const finalLines = out ?? renderTaskEvidence({ lines, truncatedCount: 0 });
  assert.strictEqual(
    finalLines.length,
    TASK_EVIDENCE_CAP + 1,
    "judge still receives a full evidence section",
  );
  assert.ok(
    finalLines[0].includes("50 older evidence entries truncated"),
    "fallback render carries the explicit count line",
  );
});

await test("MESSAGE_END handler wires the chunk summarizer with the legacy fallback", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(
    join(ROOT, "dist/extensions/enforcement/handlers/register-message-end.js"),
    "utf-8",
  );
  assert.ok(src.includes("summarizeTaskEvidence"), "chunk summarizer wired at the call site");
  assert.ok(src.includes("renderTaskEvidence"), "legacy render fallback wired");
  assert.ok(src.includes("cap: false"), "call site collects uncapped evidence for the summarizer");
});

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
console.log("=== judge task-wide evidence + redelivery skip passed ===");
