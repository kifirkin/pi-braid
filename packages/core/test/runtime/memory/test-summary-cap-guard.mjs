/**
 * Fixture test: the high-context compact guard must never hand the summarizer a
 * span that pi-ai's request clamp will strangle.
 *
 * pi-ai clamps max_tokens against `window - estimate(prompt) - 4096`, floored at 1
 * (simple-options.js:6-12), so a span whose estimate reaches `window - 4096` gets an
 * empty length-stopped summary: the compaction aborts, persists nothing, and re-fires.
 * The guard's contract after the fix:
 * (a) a span above the resolved window produces the deterministic no-summary cut
 *     (an extension compaction result, the path where pi-core skips its LLM call),
 *     and no span is handed onward;
 * (b) at a 1M window a guard span still summarizes normally, with the boundary-aware
 *     start pi-core prepared (never the raw branch head);
 * (c) the boundary-aware span is preserved untouched when the guard's cut needs no
 *     shrink (the prepared span already ends at or before the cut).
 *
 * Failing-first: on the pre-fix tree the guard overwrote prep.messagesToSummarize with
 * the raw branch head [0..cutIndex-1] and fell through to the summarizer, so (a) finds
 * no extension compaction result while (b) and (c) observe msg 0 (the raw head) in the
 * span, and (c) sees the cut anchor replace pi-core's own anchor.
 *
 * Run: node test/runtime/memory/test-summary-cap-guard.mjs
 */

import { strict as assert } from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

// Hermetic settings isolation: redirect HOME before the dist imports so the window
// used by the guard is the one each case pins on ctx.model.contextWindow (no
// contextLimitTokens override in settings). Mirrors test-high-context-guard-substantive.
const FAKE_HOME = mkdtempSync(join(tmpdir(), "sumcap-guard-"));
process.env.HOME = FAKE_HOME;
mkdirSync(join(FAKE_HOME, ".pi", "agent"), { recursive: true });
writeFileSync(join(FAKE_HOME, ".pi", "agent", "settings.json"), JSON.stringify({}));

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

const { registerBeforeCompactHandler } = await import(
  join(ROOT, "dist/extensions/memory/context-manager/handlers/compaction.js")
);

function makeFakePi() {
  const handlers = new Map();
  return {
    handlers,
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    async _emit(event, ctx) {
      const name = typeof event === "string" ? event : event.type;
      let last;
      for (const h of handlers.get(name) ?? []) {
        const r = await h(event, ctx);
        if (r !== undefined) last = r;
      }
      return last;
    },
  };
}

let sessionSeq = 0;
function makeCtx({ branch, contextWindow }) {
  const sessionId = `sumcap-${++sessionSeq}`;
  return {
    cwd: "/tmp/test",
    mode: "test",
    hasUI: false,
    model: { contextWindow },
    getContextUsage: () => ({ percent: 0, tokens: 0, contextWindow }),
    sessionManager: {
      getSessionFile: () => `/tmp/${sessionId}.jsonl`,
      getSessionId: () => sessionId,
      getLeafId: () => "leaf-1",
      getBranch: () => branch,
      getTree: () => branch.map((e) => ({ entry: { id: e.id, type: e.type } })),
      getChildren: () => [],
      getLabel: () => undefined,
      appendCustomEntry: () => {},
    },
  };
}

/**
 * Synthetic branch of `len` message entries with a fixed text payload. The last
 * entry carries a provider-style usage total when `usageAtLast` is given, which is
 * the session-tree measure's usage-backed refinement (a real request total, the same
 * number the live guard reads).
 */
function makeBranch(len, pad, { usageAtLast } = {}) {
  const branch = [];
  for (let i = 0; i < len; i++) {
    const message = {
      role: i % 2 ? "assistant" : "user",
      content: [{ type: "text", text: `msg ${i} ${"x".repeat(pad)}` }],
      timestamp: 1000 + i,
    };
    if (i === len - 1 && usageAtLast !== undefined) {
      message.role = "assistant";
      message.usage = {
        input: usageAtLast - 10,
        output: 10,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: usageAtLast,
      };
    }
    branch.push({ id: `e${i}`, type: "message", message });
  }
  return branch;
}

/** pi-core-shaped preparation: a boundary-aware span plus its kept-region anchor. */
function makePrep(branch, spanStart, spanEndInclusive, firstKeptEntryId) {
  return {
    messagesToSummarize: branch.slice(spanStart, spanEndInclusive + 1).map((e) => e.message),
    turnPrefixMessages: [],
    isSplitTurn: false,
    firstKeptEntryId,
    tokensBefore: 0,
  };
}

function textOf(msg) {
  return msg?.content?.[0]?.text ?? "";
}

async function fireBeforeCompact(pi, ctx, prep) {
  const evt = { type: "session_before_compact", preparation: prep };
  return pi._emit(evt, ctx);
}

/** Deterministic cut formula from the guard (mirrors compaction.ts keep/cut math). */
function guardCut(branchLength) {
  const keepCount = Math.min(50, Math.max(10, Math.floor(branchLength * 0.3)));
  return { keepCount, cutIndex: Math.max(0, branchLength - keepCount) };
}

const BRANCH_LEN = 120; // keepCount 36, cutIndex 84

console.log("=== summary-cap guard: no strangled span reaches the summarizer ===\n");

await test("(a) span above the resolved window: deterministic cut, no span handed onward", async () => {
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  const branch = makeBranch(BRANCH_LEN, 1200); // ~36K tokens on a 20K window
  const ctx = makeCtx({ branch, contextWindow: 20_000 });
  const prep = makePrep(branch, 0, 109, branch[110].id);
  const spanRef = prep.messagesToSummarize;

  const result = await fireBeforeCompact(pi, ctx, prep);

  // pi-core consumes result.compaction with fromExtension=true and skips
  // _runDefaultCompaction (agent-session.js:1771-1785 auto, :1497-1512 manual);
  // an extension compaction result IS the no-LLM-call path.
  assert.ok(result?.compaction, "handler must return an extension compaction result");
  const { cutIndex } = guardCut(BRANCH_LEN);
  assert.equal(result.compaction.firstKeptEntryId, branch[cutIndex].id);
  assert.match(String(result.compaction.summary), /deterministic/i);
  assert.equal(prep.messagesToSummarize, spanRef, "the stub path must not hand a span onward");
  assert.equal(prep.firstKeptEntryId, branch[110].id, "prep must stay untouched on the stub path");
});

await test("(b) 1M window: guard span still summarizes, boundary-aware start kept", async () => {
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  const branch = makeBranch(BRANCH_LEN, 200, { usageAtLast: 800_000 }); // 80% of the window
  const ctx = makeCtx({ branch, contextWindow: 1_000_000 });
  const prep = makePrep(branch, 10, 109, branch[110].id);

  const result = await fireBeforeCompact(pi, ctx, prep);

  assert.equal(result, undefined, "no extension compaction when the span fits the window");
  const { cutIndex } = guardCut(BRANCH_LEN);
  const texts = prep.messagesToSummarize.map(textOf);
  assert.ok(texts.length > 0, "guard must leave a non-empty summarize set");
  assert.ok(
    texts.some((t) => t.startsWith("msg 10 ")),
    "the boundary-aware span start is kept",
  );
  assert.ok(
    !texts.some((t) => t.startsWith("msg 0 ")),
    "the raw branch head must not be reintroduced",
  );
  assert.ok(
    !texts.some((t) => t.startsWith(`msg ${cutIndex} `)),
    "entries the cut keeps live must not be summarized",
  );
  assert.equal(prep.firstKeptEntryId, branch[cutIndex].id, "the deterministic cut anchor applies");
  assert.equal(prep.turnPrefixMessages.length, 0);
  assert.equal(prep.isSplitTurn, false);
});

await test("(c) prepared span preserved when the cut needs no shrink", async () => {
  const pi = makeFakePi();
  registerBeforeCompactHandler(pi);
  const branch = makeBranch(BRANCH_LEN, 200, { usageAtLast: 800_000 });
  const ctx = makeCtx({ branch, contextWindow: 1_000_000 });
  const prep = makePrep(branch, 10, 40, branch[41].id); // ends well before cutIndex 84

  const result = await fireBeforeCompact(pi, ctx, prep);

  assert.equal(result, undefined);
  const texts = prep.messagesToSummarize.map(textOf);
  assert.ok(
    texts.some((t) => t.startsWith("msg 10 ")),
    "prepared span start survives",
  );
  assert.ok(
    texts.some((t) => t.startsWith("msg 40 ")),
    "prepared span end survives",
  );
  assert.ok(
    !texts.some((t) => t.startsWith("msg 0 ")),
    "the raw branch head must not replace the prepared span",
  );
  assert.ok(
    !texts.some((t) => t.startsWith("msg 84 ")),
    "the prepared span must not be widened to the cut",
  );
  assert.equal(prep.firstKeptEntryId, branch[41].id, "pi-core's own anchor must survive untouched");
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
