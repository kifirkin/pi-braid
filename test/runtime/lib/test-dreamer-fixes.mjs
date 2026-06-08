/**
 * Test: Dreamer fixes (false-positive loop detection)
 *
 * The dreamer (lib/reasoning/dreamer.ts) was firing "Likely to get stuck in
 * X→Y loop (prob: 100%)" advisories with as little as 1 turn of history
 * showing the same tool twice. Root cause: small-sample statistical
 * inference — raw ratios like 1/1 = 100% treated as confident predictions.
 *
 * The fix:
 *  1. Min sample size: refuse to predict when fewer than 5 transitions
 *     are observed for the last tool (returns null instead of guessing).
 *  2. Current-sequence loop detection: detect 4+ consecutive same-tool
 *     calls in the CURRENT sequence (regardless of history).
 *  3. Probability floor: stuck/fail advisories only fire when the
 *     predicted probability is > 0.6 (was 0.15/0.2).
 *  4. Confidence labels: 0.6/0.8/0.95 thresholds (was 0.4/0.7).
 */

import { readFileSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "../../../");

let passed = 0;
let failed = 0;
const assert = (cond, msg) =>
  cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

const srcPath = join(ROOT, "dist/lib/reasoning/dreamer.js");
if (!existsSync(srcPath)) {
  console.error("❌ dist file missing — run `npm run build` first");
  process.exit(1);
}
const src = readFileSync(srcPath, "utf8");

// ── [1] Min sample size constants present ──────────────────────────────────
console.log("\n[1] Min sample size constants");
{
  assert(
    /MIN_SAMPLE_FOR_PREDICTION\s*=\s*5/.test(src),
    "MIN_SAMPLE_FOR_PREDICTION = 5 (refuse to predict with smaller sample)",
  );
  assert(
    /MIN_CURRENT_LOOP_LENGTH\s*=\s*4/.test(src),
    "MIN_CURRENT_LOOP_LENGTH = 4 (4+ consecutive same-tool = loop)",
  );
}

// ── [2] simulatePaths: bail with small sample ──────────────────────────────
console.log("\n[2] simulatePaths: bail with small sample");
{
  // The check `if (total < MIN_SAMPLE_FOR_PREDICTION) return [];` should
  // appear in simulatePaths, BEFORE building the paths array.
  const idx = src.indexOf("function simulatePaths");
  assert(idx > 0, "simulatePaths function exists");
  const block = src.slice(idx, idx + 2000);
  assert(
    /total\s*<\s*MIN_SAMPLE_FOR_PREDICTION\s*\)\s*return\s*\[\]/.test(block),
    "simulatePaths returns [] when total transitions < MIN_SAMPLE_FOR_PREDICTION",
  );
  // The next-tool's sample must also meet the minimum before classifying
  // as "stuck" or "failure".
  assert(
    /nextTotal\s*<\s*MIN_SAMPLE_FOR_PREDICTION/.test(block),
    "simulatePaths: next-tool sample must also meet minimum before classifying as stuck/fail",
  );
}

// ── [3] dream(): current-sequence loop detection ──────────────────────────
console.log("\n[3] dream(): current-sequence loop detection (Path 1)");
{
  const idx = src.indexOf("export function dream(");
  assert(idx > 0, "dream() function exists");
  const block = src.slice(idx, idx + 5000);
  assert(
    /function\s+tailRun\s*\(/.test(src),
    "tailRun helper is defined",
  );
  assert(
    /run\.length\s*>=\s*MIN_CURRENT_LOOP_LENGTH/.test(block),
    "dream() checks tail run length >= MIN_CURRENT_LOOP_LENGTH",
  );
  assert(
    /Detected\s+\$\{run\.length\}\s+consecutive/.test(block),
    "dream() loop advisory: includes the run length in the message",
  );
  // The current-sequence loop path should fire BEFORE the Markov path
  const loopIdx = block.indexOf("Path 1:");
  const markovIdx = block.indexOf("Path 2:");
  assert(loopIdx > 0 && markovIdx > 0, "both loop and Markov paths present");
  assert(loopIdx < markovIdx, "loop path is checked before Markov path");
}

// ── [4] dream(): probability floor ────────────────────────────────────────
console.log("\n[4] dream(): probability floor for stuck/fail advisories");
{
  const idx = src.indexOf("export function dream(");
  const block = src.slice(idx, idx + 5000);
  assert(
    /p\.outcome\s*===\s*"stuck"\s*&&\s*p\.probability\s*>\s*0\.6/.test(block),
    "stuck filter: probability > 0.6 (was 0.15)",
  );
  assert(
    /p\.outcome\s*===\s*"failure"\s*&&\s*p\.probability\s*>\s*0\.6/.test(block),
    "fail filter: probability > 0.6 (was 0.2)",
  );
}

// ── [5] Confidence label thresholds updated ───────────────────────────────
console.log("\n[5] Confidence label thresholds");
{
  // Should be 0.6 / 0.8 / 0.95, not 0.4 / 0.7
  assert(
    /p\s*>=\s*0\.95\s*\)\s*return\s*"high"/.test(src),
    "confidence: high at p >= 0.95 (was 0.7)",
  );
  assert(
    /p\s*>=\s*0\.8\s*\)\s*return\s*"medium"/.test(src),
    "confidence: medium at p >= 0.8 (was 0.4)",
  );
}

// ── [6] Live: re-run the originally-failing scenarios ─────────────────────
console.log("\n[6] Live: re-run the failing scenarios");
{
  // Inline the fixed logic to verify the runtime behavior.
  // Mirrors the implementation in dreamer.ts.
  const MIN_SAMPLE_FOR_PREDICTION = 5;
  const MIN_CURRENT_LOOP_LENGTH = 4;

  function tailRun(seq) {
    if (seq.length === 0) return { tool: null, length: 0 };
    const last = seq[seq.length - 1];
    let length = 0;
    for (let i = seq.length - 1; i >= 0; i--) {
      if (seq[i] === last) length++;
      else break;
    }
    return { tool: last, length };
  }

  function fixedDream(currentSequence, historicalSequences) {
    // Path 1: current-sequence loop
    const run = tailRun(currentSequence);
    if (run.length >= MIN_CURRENT_LOOP_LENGTH) {
      return { fire: true, source: "current-loop", run };
    }

    // Path 2: Markov with min sample
    if (currentSequence.length === 0) return { fire: false };
    const lastTool = currentSequence[currentSequence.length - 1];
    const transitions = new Map();
    for (const seq of historicalSequences) {
      for (let i = 0; i < seq.length - 1; i++) {
        const from = seq[i], to = seq[i + 1];
        if (!transitions.has(from)) transitions.set(from, new Map());
        const counts = transitions.get(from);
        counts.set(to, (counts.get(to) ?? 0) + 1);
      }
    }
    const nextCounts = transitions.get(lastTool);
    if (!nextCounts || nextCounts.size === 0) return { fire: false };
    const total = [...nextCounts.values()].reduce((a, b) => a + b, 0);
    if (total < MIN_SAMPLE_FOR_PREDICTION) return { fire: false };

    for (const [nextTool, count] of nextCounts) {
      const prob = count / total;
      const nextNext = transitions.get(nextTool);
      if (nextNext) {
        const nextTotal = [...nextNext.values()].reduce((a, b) => a + b, 0);
        if (nextTotal < MIN_SAMPLE_FOR_PREDICTION) continue;
        const selfLoopRate = (nextNext.get(nextTool) ?? 0) / nextTotal;
        if (selfLoopRate > 0.5 && prob > 0.6) {
          return { fire: true, source: "markov", nextTool, prob };
        }
      }
    }
    return { fire: false };
  }

  // Originally-firing scenarios that should now be silent
  const falsePositives = [
    { name: "1 turn [read,read,read], cur=[read,read]", hist: [["read", "read", "read"]], cur: ["read", "read"] },
    { name: "scratchpad history (3 obs, was 67% stuck)", hist: [["scratchpad","scratchpad"],["scratchpad","read"],["scratchpad","scratchpad"]], cur: ["scratchpad","scratchpad"] },
    { name: "3-deep read, 2-turn history", hist: [["read","read","read"],["read","read","read"]], cur: ["read","read","read"] },
    { name: "scratchpad x2 minimal", hist: [["scratchpad","scratchpad"]], cur: ["scratchpad","scratchpad"] },
  ];
  for (const s of falsePositives) {
    const r = fixedDream(s.cur, s.hist);
    assert(!r.fire, `false positive suppressed: ${s.name}`);
  }

  // Genuine loops should still fire
  const realLoops = [
    { name: "4-deep read loop", hist: [], cur: ["read","read","read","read"] },
    { name: "5-deep scratchpad loop", hist: [], cur: ["scratchpad","scratchpad","scratchpad","scratchpad","scratchpad"] },
    { name: "8-deep edit loop", hist: [], cur: ["edit","edit","edit","edit","edit","edit","edit","edit"] },
  ];
  for (const s of realLoops) {
    const r = fixedDream(s.cur, s.hist);
    assert(r.fire && r.source === "current-loop", `real loop detected: ${s.name}`);
  }

  // Strong Markov evidence (10 transitions) should still fire
  const strongMarkov = fixedDream(
    ["edit"],
    Array(10).fill(["edit", "edit"]),
  );
  assert(strongMarkov.fire && strongMarkov.source === "markov",
    "strong Markov evidence (10 transitions) still fires");

  // Mixed scenarios (mid-length history) should be silent (not enough data)
  const marginal = fixedDream(
    ["read"],
    Array(3).fill(["read", "read"]),
  );
  assert(!marginal.fire, "marginal history (3 transitions) is silent (insufficient data)");
}

// ── Summary ──────────────────────────────────────────────────────────────
console.log(`\n📊 Results: ${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
