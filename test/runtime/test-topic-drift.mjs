/**
 * Topic Drift Detector — runtime tests
 * Run: node test/runtime/test-topic-drift.mjs
 */
const ROOT = "/Users/kifir/projects/agents/pi-braid";
const { TopicDriftDetector } = await import(`${ROOT}/dist/lib/topic-drift-detector.js`);

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log(`  ✅ ${msg}`)) : (failed++, console.log(`  ❌ ${msg}`));

console.log("[1] Basic drift detection");
{
	const d = new TopicDriftDetector({ topicThreshold: 0.15, minTurns: 3, enableStructural: true });
	
	// Not enough turns → no drift
	let check = d.check();
	assert(!check.drifted, "No drift with empty history");
	assert(check.reason === "too_few_turns", "Reason: too_few_turns");

	// Set task context
	d.setTaskContext("Implement user authentication with JWT tokens and refresh mechanism");
	check = d.check();
	assert(check.reason === "too_few_turns", "Still too few turns after task set");

	// Add turns aligned with task (use overlapping vocabulary)
	d.addTurn("Let's implement the user authentication middleware");
	d.addTurn("The JWT tokens need a refresh mechanism");
	d.addTurn("We should validate tokens on every request");
	check = d.check();
	assert(!check.drifted, "No drift — turns align with task");
	assert(check.severity === "subtle", "Severity subtle when aligned");
}

console.log("\n[2] Semantic drift detection");
{
	const d = new TopicDriftDetector({ topicThreshold: 0.15, minTurns: 3, enableStructural: true });
	d.setTaskContext("Implement user authentication with JWT tokens");

	// Add turns that drift away
	d.addTurn("The weather today is quite nice");
	d.addTurn("I was thinking about quantum physics yesterday");
	d.addTurn("My favorite color is blue");

	const check = d.check();
	assert(check.drifted, "Drift detected on unrelated turns");
	assert(check.reason === "semantic_drift", "Reason: semantic_drift");
	assert(check.severity !== "subtle", "Drift has non-subtle severity");
}

console.log("\n[3] Structural drift with partial semantic overlap");
{
	const d = new TopicDriftDetector({ topicThreshold: 0.05, structuralThreshold: 0.02, minTurns: 3, enableStructural: true });
	d.setTaskContext("Build a REST API for e-commerce product catalog");

	// Semantic overlap but structural mismatch
	d.addTurn("Let's discuss the database schema for users");
	d.addTurn("I prefer MongoDB over PostgreSQL for flexibility");
	d.addTurn("Have you seen the latest football match?");

	const check = d.check();
	assert(check.drifted || check.reason === "too_few_turns" || check.reason === "too_short", "Either drift or legitimate skip");
}

console.log("\n[4] Whisper generation");
{
	const d = new TopicDriftDetector({ topicThreshold: 0.15, minTurns: 3 });
	d.setTaskContext("Fix the memory leak in the connection pool");
	d.addTurn("What about the UI design for the dashboard?");
	d.addTurn("The color scheme should be dark mode by default");
	d.addTurn("We need responsive breakpoints for mobile");

	const check = d.check();
	const whisper = d.generateWhisper(check);
	assert(whisper !== null, "Whisper generated");
	assert(whisper.includes("[SUBTLE]") || whisper.includes("[WARN]"), "Whisper has severity tag");
	assert(whisper.includes("drift detected"), "Whisper mentions drift");
}

console.log("\n[5] Cooldown prevents repeated warnings");
{
	const d = new TopicDriftDetector({ topicThreshold: 0.15, minTurns: 3 });
	d.setTaskContext("Implement GraphQL schema for user profiles");
	d.addTurn("I think the weather is nice today");
	d.addTurn("Let's talk about cooking recipes");
	d.addTurn("My favorite hobby is hiking");

	const check1 = d.check();
	assert(check1.drifted, "First check: drift detected");

	const check2 = d.check();
	assert(!check2.drifted, "Second check: cooldown prevents re-alert");
	assert(check2.reason === "cooldown", "Reason: cooldown");
}

console.log("\n[6] Reset clears state");
{
	const d = new TopicDriftDetector({ topicThreshold: 0.15, minTurns: 3 });
	d.setTaskContext("Debug the race condition in async handler");
	d.addTurn("This is a test message");
	d.addTurn("Another unrelated thing");
	d.addTurn("Completely off topic");
	d.reset();

	const check = d.check();
	assert(!check.drifted, "No drift after reset");
	assert(check.reason === "too_few_turns", "Reset cleared history");
}

console.log("\n[7] Tool command filtering");
{
	const d = new TopicDriftDetector({ topicThreshold: 0.15, minTurns: 3 });
	d.setTaskContext("Optimize database queries");
	d.addTurn("/think about the query plan");
	d.addTurn("/tool memory_list");
	d.addTurn("Let's add an index on the user_id column");

	// Only 1 non-slash turn → still too few
	const check = d.check();
	assert(!check.drifted, "Slash commands filtered, not enough real turns");
}

console.log(`\n=== Results: ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
