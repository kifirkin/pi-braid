/**
 * Smoke test: actually call the sleep tool and verify the reminder fires after delay.
 * Runs the tool through pi's extension registration system with a mock pi API.
 */

import { eventBus } from "../../dist/lib/event-bus.js";
import { emitTimerReminder } from "../../dist/lib/timer-bus.js";

// ── Capture timer-bus reminders ──────────────────────────────
const capturedReminders = [];
const origEmit = emitTimerReminder;
emitTimerReminder = (reminder) => {
  capturedReminders.push(reminder);
};

// ── Capture event-bus fires ─────────────────────────────────
const capturedEvents = [];
const origBusEmit = eventBus.emit.bind(eventBus);
eventBus.emit = (...args) => {
  capturedEvents.push(args[0]);
  return origBusEmit(...args);
};

// ── Load the extension ──────────────────────────────────────
const { default: sleepExt } = await import("../../dist/contrib/sleep/index.js");

// ── Minimal mock pi ─────────────────────────────────────────
const sentMessages = [];
const mockPi = {
  registerTool: (tool) => {
    console.log(`  📌 Registered tool: ${tool.name}`);
    return tool;
  },
  registerCommand: () => {},
  on: () => {},
  sendMessage: (params, opts) => {
    sentMessages.push({ params, opts });
  },
  getAllTools: () => [],
  getActiveTools: () => [],
  setActiveTools: () => {},
  appendEntry: () => {},
  getExtensionState: () => ({}),
  ui: { notify: () => {} },
};

// ── Register the extension ──────────────────────────────────
sleepExt(mockPi);

// ── Find the registered tool (pi.registerTool was called above) ──
// We need to grab the tool definition that was registered
let registeredTool = null;
const origRegisterTool = mockPi.registerTool;
mockPi.registerTool = (tool) => {
  registeredTool = tool;
  return origRegisterTool(tool);
};

// Re-register by calling the extension again (idempotent in practice)
sleepExt(mockPi);

// ── Execute the tool ────────────────────────────────────────
const result = await registeredTool.execute("test-call-1", {
  delay_seconds: 2,
  reason: "test smoke: reminder should fire in ~2s",
});

console.log("\n[Immediate result]");
console.log("  Content:", result.content[0].text);
console.log("  Details:", JSON.stringify(result.details, null, 2));

// ── Wait for the deferred reminder (2s delay + 500ms margin) ──
console.log("\n⏳  Waiting 2.5s for reminder to fire...\n");
await new Promise((r) => setTimeout(r, 2500));

// ── Check captured reminders ────────────────────────────────
console.log("[Timer-bus reminders captured]", capturedReminders.length);
for (const r of capturedReminders) {
  console.log(`  🕐 id=${r.id} reason="${r.reason}"`);
}

// ── Check captured events ───────────────────────────────────
const timerFires = capturedEvents.filter((e) => e && e.type === "timer_fire");
console.log("\n[Event-bus timer_fire events]", timerFires.length);
for (const e of timerFires) {
  console.log(`  🔔 id=${e.id} payload="${e.payload}"`);
}

// ── Check steer messages ────────────────────────────────────
console.log("\n[Steer messages sent]", sentMessages.length);
for (const m of sentMessages) {
  console.log(`  📤 customType=${m.params.customType} triggerTurn=${m.opts?.triggerTurn}`);
}

// ── Verdict ─────────────────────────────────────────────────
const allGood =
  capturedReminders.length > 0 &&
  timerFires.length > 0 &&
  sentMessages.length > 0 &&
  result.details.timer_id;

console.log("\n" + "=".repeat(50));
if (allGood) {
  console.log("✅ Sleep tool smoke test PASSED");
  console.log("   - Tool returns immediately");
  console.log("   - Reminder fires after delay");
  console.log("   - eventBus, timer-bus, and steer all triggered");
} else {
  console.log("❌ Sleep tool smoke test FAILED");
}
process.exit(allGood ? 0 : 1);
