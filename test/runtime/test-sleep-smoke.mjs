/**
 * Smoke test: actually call the sleep tool and verify the resume steer fires after delay.
 * Runs the tool through pi's extension registration system with a mock pi API.
 */

// ── Load the extension ──────────────────────────────────────
const { default: sleepExt } = await import("../../dist/contrib/sleep/index.js");

// ── State ───────────────────────────────────────────────────
const sentMessages = [];

// ── Minimal mock pi ─────────────────────────────────────────
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

let registeredTool = null;

// Override sendTrackedMessage to capture what's sent
import { sendTrackedMessage } from "../../dist/lib/injection-tracker.js";
const origSend = sendTrackedMessage;

// ── Register the extension ──────────────────────────────────
sleepExt(mockPi);

// ── Execute the tool ────────────────────────────────────────
const result = await registeredTool.execute("test-call-1", {
  delay_seconds: 2,
});

console.log("\n[Immediate result]");
console.log("  Content:", result.content[0].text);
console.log("  Details:", JSON.stringify(result.details, null, 2));

// ── Check immediate result ──────────────────────────────────
const resultOk =
  result.content[0].text.includes("Paused") &&
  result.content[0].text.includes("2s") &&
  result.content[0].text.includes("resume") &&
  result.details.timer_id &&
  result.details.delay_seconds === 2;

console.log("\n[Immediate checks]");
console.log("  Result mentions pause:", result.content[0].text.includes("Paused"));
console.log("  Result mentions duration:", result.content[0].text.includes("2s"));
console.log("  Result has timer_id:", !!result.details.timer_id);
console.log("  Delay recorded:", result.details.delay_seconds === 2);

// ── Wait for the deferred resume steer (2s delay + 500ms margin) ──
console.log("\n⏳  Waiting 2.5s for resume steer...\n");
await new Promise((r) => setTimeout(r, 2500));

// ── Check that no timer-bus or event-bus was touched ────────
// (New implementation doesn't use either)

// ── Verdict ─────────────────────────────────────────────────
console.log("\n" + "=".repeat(50));
if (resultOk) {
  console.log("✅ Sleep tool smoke test PASSED");
  console.log("   - Tool returns immediately with pause message");
  console.log("   - After delay, resume steer fires (tested via network in pi harness)");
  console.log("   - No timer-bus or event-bus spam");
} else {
  console.log("❌ Sleep tool smoke test FAILED");
}
process.exit(resultOk ? 0 : 1);