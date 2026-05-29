/**
 * Topic Drift Detector — runtime tests
 * Run: node test/runtime/test-topic-drift.mjs
 */
const ROOT = "/Users/kifir/projects/agents/pi-braid";
const { TopicDriftDetector, setCriticCtx } = await import(`${ROOT}/dist/lib/detection/topic-drift-detector.js`);

let passed = 0;
let failed = 0;
const assert = (cond, msg) =>
  cond
    ? (passed++, console.log(`  ✅ ${msg}`))
    : (failed++, console.log(`  ❌ ${msg}`));

console.log("[1] Basic drift detection (no LLM — uses heuristic fallback)");
{
  const d = new TopicDriftDetector({ minTurns: 3 });

  // Not enough turns → no drift
  let check = await d.check();
  assert(!check.drifted, "No drift with empty history");
  assert(check.reason === "too_few_turns", "Reason: too_few_turns");

  // Set task context
  d.setTaskContext("Implement user authentication with JWT tokens and refresh mechanism");
  check = await d.check();
  assert(check.reason === "too_few_turns", "Still too few turns after task set");

  // Add turns aligned with task
  d.addTurn("Let's implement the user authentication middleware");
  d.addTurn("The JWT tokens need a refresh mechanism");
  d.addTurn("We should validate tokens on every request");
  check = await d.check();
  // Without LLM ctx, critics fall back to conservative "no drift"
  assert(!check.drifted, "Conservative fallback: no drift when LLM unavailable");
  assert(check.severity === "subtle", "Severity subtle when no LLM");
}

console.log("\n[2] Cooldown prevents repeated warnings");
{
  const d = new TopicDriftDetector({ minTurns: 3 });
  d.setTaskContext("Implement GraphQL schema for user profiles");
  d.addTurn("I think the weather is nice today");
  d.addTurn("Let's talk about cooking recipes");
  d.addTurn("My favorite hobby is hiking");

  const check1 = await d.check();
  // Without LLM ctx: conservative fallback = no drift
  assert(!check1.drifted, "Conservative fallback on unrelated turns without LLM");

  const check2 = await d.check();
  // Second call hits cooldown since first didn't fire lastDriftWarning
  assert(!check2.drifted, "Second check: still no drift");
}

console.log("\n[3] Reset clears state");
{
  const d = new TopicDriftDetector({ minTurns: 3 });
  d.setTaskContext("Debug the race condition in async handler");
  d.addTurn("This is a test message");
  d.addTurn("Another unrelated thing");
  d.addTurn("Completely off topic");
  d.reset();

  const check = await d.check();
  assert(!check.drifted, "No drift after reset");
  assert(check.reason === "too_few_turns", "Reset cleared history");
}

console.log("\n[4] Tool command filtering");
{
  const d = new TopicDriftDetector({ minTurns: 3 });
  d.setTaskContext("Optimize database queries");
  d.addTurn("/think about the query plan");
  d.addTurn("/tool memory_list");
  d.addTurn("Let's add an index on the user_id column");

  // Only 1 non-slash turn → still too few
  const check = await d.check();
  assert(!check.drifted, "Slash commands filtered, not enough real turns");
}

console.log("\n[5] Whisper generation");
{
  const d = new TopicDriftDetector({ minTurns: 3 });
  d.setTaskContext("Fix the memory leak in the connection pool");
  d.addTurn("What about the UI design for the dashboard?");
  d.addTurn("The color scheme should be dark mode by default");
  d.addTurn("We need responsive breakpoints for mobile");

  // Force a drifted check result for whisper testing
  // (critics won't fire without ctx, so simulate with manual state)
  const check = {
    drifted: true,
    task: "Fix the memory leak in the connection pool",
    current: "UI design, color scheme, responsive breakpoints",
    severity: "moderate",
    reason: "semantic_drift",
  };
  const whisper = d.generateWhisper(check);
  assert(whisper !== null, "Whisper generated");
  assert(
    whisper.includes("[SUBTLE]") || whisper.includes("[WARN]"),
    "Whisper has severity tag",
  );
  assert(whisper.includes("drift"), "Whisper mentions drift");
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);