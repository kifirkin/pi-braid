/**
 * Reasoning Metrics — runtime tests
 * Run: node test/runtime/test-reasoning-metrics.mjs
 */
const ROOT = "/Users/kifir/projects/agents/pi-braid";
const { measureStability, extractAnchors, measureOverlap, measureBigramEntropy, countSelfContradictions } = await import(`${ROOT}/dist/lib/reasoning/reasoning-metrics.js`);

let passed = 0, failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log(`  ✅ ${msg}`)) : (failed++, console.log(`  ❌ ${msg}`));

console.log("\n[1] Anchor extraction");
const anchors = extractAnchors("Implement authentication for the login endpoint");
assert(anchors.size > 0, `anchors extracted: ${anchors.size}`);
assert(anchors.has("authentication"), `auth anchor present`);
assert(!anchors.has("the"), `stop words removed`);
assert(!anchors.has("to"), `stop word "to" removed`);
assert(extractAnchors("the and is are").size === 0, `stop words only: 0`);

console.log("\n[2] Overlap");
const a = extractAnchors("null pointer exception in auth module");
assert(measureOverlap("I fixed null pointer by adding null check", a) > 0.2, `high overlap`);
assert(measureOverlap("Code is well formatted and readable", a) < 0.3, `low overlap (drift)`);
assert(measureOverlap("any", new Set()) === 1.0, `empty anchors: 1.0`);

console.log("\n[3] Bigram entropy");
assert(measureBigramEntropy("fix fix fix fix fix fix") < 0.3, `repetitive: low entropy`);
assert(measureBigramEntropy("the quick brown fox jumps over the lazy dog") > 0.7, `diverse: high entropy`);
assert(measureBigramEntropy("hi") === 1.0, `too short: 1.0`);

console.log("\n[4] Self-contradiction");
assert(countSelfContradictions("Bug is null ref. Bug is not null ref.") >= 1, `contradiction detected`);
assert(countSelfContradictions("Bug is null ref. Fixed by adding check.") === 0, `no contradiction`);

console.log("\n[5] Measure stability");
const stable = measureStability("Implement auth for login", "I implemented auth using JWT tokens.");
assert(stable.stable, `well-formed response stable`);

const drifted = measureStability("Fix auth bug", "I refactored the entire codebase for microservices.");
assert(!drifted.stable, `drifted unstable`);
assert(drifted.reason === "topic_drift", `reason: topic_drift`);

const repetitive = measureStability("Write code that implements a recursive binary search algorithm", "sort sort sort sort sort sort sort sort sort sort sort sort sort sort sort sort sort sort sort sort");
assert(!repetitive.stable, `repetitive unstable: ${repetitive.reason}`);
assert(repetitive.reason === "repetitive", `reason: repetitive`);

console.log("\n" + "=".repeat(50));
console.log(`Reasoning Metrics: ${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
