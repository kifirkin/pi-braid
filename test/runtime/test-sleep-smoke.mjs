/**
 * Smoke test: actually call the sleep tool and verify it blocks until the delay elapses.
 * Runs the tool through pi's extension registration system with a mock pi API.
 */

// ── Load the extension ──────────────────────────────────────
const { default: sleepExt } = await import("../../dist/contrib/sleep/index.js");

// ── Minimal mock pi ─────────────────────────────────────────
let registeredTool = null;
const mockPi = {
  registerTool: (tool) => {
    registeredTool = tool;
    return tool;
  },
  registerCommand: () => {},
  on: () => {},
  sendMessage: () => {},
  getAllTools: () => [],
  getActiveTools: () => [],
  setActiveTools: () => {},
  appendEntry: () => {},
  getExtensionState: () => ({}),
  ui: { notify: () => {} },
};

// ── Register the extension ──────────────────────────────────
sleepExt(mockPi);

// ── Execute the tool — this now blocks for 2 seconds ────────
const t0 = Date.now();
const result = await registeredTool.execute("test-call-1", {
  delay_seconds: 2,
});
const elapsed = Date.now() - t0;

console.log("\n[Result after delay]");
console.log("  Content:", result.content[0].text);
console.log("  Details:", JSON.stringify(result.details, null, 2));
console.log("  Elapsed (ms):", elapsed);

// ── Checks ──────────────────────────────────────────────────
const resultOk =
  result.content[0].text.includes("Resumed after") &&
  result.content[0].text.includes("2s") &&
  result.details.timer_id &&
  result.details.delay_seconds === 2;

const timingOk =
  elapsed >= 1900 && elapsed <= 3500;

console.log("\n[Checks]");
console.log("  Result mentions resume:", result.content[0].text.includes("Resumed after"));
console.log("  Result mentions duration:", result.content[0].text.includes("2s"));
console.log("  Result has timer_id:", !!result.details.timer_id);
console.log("  Delay recorded:", result.details.delay_seconds === 2);
console.log("  Actual elapsed ~2s:", timingOk ? `yes (${elapsed}ms)` : `no (${elapsed}ms)`);

// ── Verdict ─────────────────────────────────────────────────
console.log("\n" + "=".repeat(50));
if (resultOk && timingOk) {
  console.log("✅ Sleep tool smoke test PASSED");
  console.log("   - Execute blocked for ~2s (agent pauses)");
  console.log("   - Result returned after delay with resume message");
  console.log("   - No steer or sendTrackedMessage needed");
} else {
  console.log("❌ Sleep tool smoke test FAILED");
}
process.exit(resultOk && timingOk ? 0 : 1);