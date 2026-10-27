/**
 * Regression test: a request that cannot fit the window is refused, not sent.
 *
 * The wiring under test is the one an LLM call performs line for line:
 * measure the payload, add the requested output budget, compare against the
 * resolved window, run compaction once, measure again, and only then send.
 * The fixture counts provider calls, because the contract is about what never
 * reaches the provider - an assertion on the returned verdict alone would pass
 * even if the caller sent the doomed request anyway.
 *
 * Run: node test/runtime/lib/test-presend-budget.mjs
 */

import { strict as assert } from "node:assert";
import { join, dirname } from "node:path";

const __dirname = dirname(new URL(import.meta.url).pathname);
const ROOT = join(__dirname, "..", "..", "..");

const { checkSendBudget, formatSendBudgetRefusal, guardAgainstDoomedSend } = await import(
  join(ROOT, "dist", "lib", "ai", "presend-budget.js")
);

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push(`${name}: ${err.message}`);
    console.log(`  FAIL ${name}`);
  }
}

const WINDOW = 1_048_576;

/** The production call site, reduced to what it decides. */
async function attemptSend(params) {
  const calls = { provider: 0, compact: 0 };
  const guard = await guardAgainstDoomedSend({
    measure: params.measure,
    outputTokens: params.outputTokens,
    contextWindow: params.contextWindow,
    compact: params.compact
      ? async () => {
          calls.compact++;
          return params.compact();
        }
      : undefined,
  });
  if (guard.allowed) {
    calls.provider++;
    return { guard, calls, text: "ok" };
  }
  return { guard, calls };
}

console.log("=== pre-send budget ===\n");

await test("a payload inside the window is sent once, without compaction", async () => {
  const r = await attemptSend({
    measure: () => 900_000,
    outputTokens: 100_000,
    contextWindow: WINDOW,
    compact: () => {
      throw new Error("compaction must not run when the request fits");
    },
  });
  assert.equal(r.guard.allowed, true);
  assert.equal(r.calls.compact, 0);
  assert.equal(r.calls.provider, 1);
  assert.equal(r.guard.verdict.projectedTokens, 1_000_000);
});

await test("the output budget is spent from the same window", async () => {
  const r = await attemptSend({
    measure: () => 1_000_000,
    outputTokens: 50_000,
    contextWindow: WINDOW,
    compact: () => false,
  });
  assert.equal(r.guard.allowed, false, "1,000,000 + 50,000 does not fit a 1,048,576 window");
  assert.equal(r.calls.provider, 0);
  assert.equal(r.guard.verdict.overBy, 1_424);
});

await test("a compaction that frees nothing does not re-open the door", async () => {
  const r = await attemptSend({
    measure: () => 1_147_001,
    outputTokens: 1000,
    contextWindow: WINDOW,
    compact: () => false,
  });
  assert.equal(r.guard.allowed, false);
  assert.equal(r.calls.compact, 1, "compaction runs exactly once");
  assert.equal(r.calls.provider, 0, "no provider call in the refusal case");
  assert.equal(r.guard.compacted, false);
});

await test("refusal names the numbers, the window and the remedy in one line", async () => {
  const r = await attemptSend({
    measure: () => 1_147_001,
    outputTokens: 1000,
    contextWindow: WINDOW,
    compact: () => false,
  });
  const line = r.guard.line;
  assert.ok(line, "a refusal carries its line");
  assert.equal(line.includes("\n"), false, "one line, not a paragraph");
  assert.match(line, /1148K/, "the projected need is named");
  assert.match(line, /1049K/, "the window is named");
  assert.match(line, /over by 99K/, "the gap is named");
  assert.match(line, /Nothing was sent/);
  assert.match(line, /context_compress action="archive"/, "the remedy is actionable");
});

await test("compaction that frees enough space sends exactly once, after the compaction", async () => {
  let freed = false;
  const r = await attemptSend({
    // The payload shrinks only after compaction: the second measurement is the
    // one that decides, which is why the guard re-measures instead of trusting
    // the compaction's own report.
    measure: () => (freed ? 800_000 : 1_200_000),
    outputTokens: 100_000,
    contextWindow: WINDOW,
    compact: () => {
      freed = true;
      return true;
    },
  });
  assert.equal(r.guard.allowed, true);
  assert.equal(r.guard.compacted, true);
  assert.equal(r.calls.compact, 1);
  assert.equal(r.calls.provider, 1);
});

await test("a compaction that throws is treated as having freed nothing", async () => {
  const r = await attemptSend({
    measure: () => 1_200_000,
    outputTokens: 100_000,
    contextWindow: WINDOW,
    compact: () => {
      throw new Error("summarizer unavailable");
    },
  });
  assert.equal(r.guard.allowed, false);
  assert.equal(r.calls.provider, 0);
});

await test("an unknown window never pretends a request fits", async () => {
  const verdict = checkSendBudget({ payloadTokens: 10_000, outputTokens: 1000, contextWindow: 0 });
  assert.equal(verdict.fits, false);
  assert.match(formatSendBudgetRefusal(verdict), /unknown window/);
});

await test("the verdict is arithmetic, not a threshold: exactly full fits, one over does not", async () => {
  const exact = checkSendBudget({
    payloadTokens: 1_000_000,
    outputTokens: 48_576,
    contextWindow: WINDOW,
  });
  assert.equal(exact.fits, true);
  assert.equal(exact.overBy, 0);
  const oneOver = checkSendBudget({
    payloadTokens: 1_000_000,
    outputTokens: 48_577,
    contextWindow: WINDOW,
  });
  assert.equal(oneOver.fits, false);
  assert.equal(oneOver.overBy, 1);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const f of failures) console.error(`FAILED: ${f}`);
  process.exit(1);
}
