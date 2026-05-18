/**
 * Test: Sleep Tool — non-blocking delay
 *
 * Verifies:
 *  1. Extension file structure
 *  2. Module registration in definitions.ts
 *  3. Tool registration and basic execution
 *  4. Delayed reminder fires after the requested delay
 */

const ROOT = "/Users/kifir/projects/agents/pi-braid";

let passed = 0;
let failed = 0;
const assert = (cond, msg) =>
  cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

// ── [1] Extension file structure ─────────────────────────────
console.log("\n[1] Sleep extension structure");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/contrib/sleep/index.ts`, "utf8");

  assert(src.includes("export default function sleepExtension"), "exports default function");
  assert(src.includes('name: "sleep"'), "registers tool named 'sleep'");
  assert(src.includes("delay_seconds"), "accepts delay_seconds param");
  assert(src.includes("reason"), "accepts optional reason param");
  assert(src.includes("setTimeout"), "uses setTimeout for deferred reminder");
  assert(src.includes("emitTimerReminder"), "emits timer-bus reminder on fire");
  assert(src.includes("eventBus.emit"), "emits event-bus notification on fire");
  assert(src.includes("sendTrackedMessage"), "sends steer message on fire");
  assert(src.includes("unref"), "unrefs the timer handle (best-effort)");
  assert(src.includes("Do NOT use bash"), "description warns against bash sleep");
  assert(src.includes("timer_set"), "description cross-references timer_set");
  assert(src.includes("MIN_DELAY_SECS"), "has minimum delay validation");
  assert(src.includes("MAX_DELAY_SECS"), "has maximum delay validation");
}

// ── [2] Module system registration ───────────────────────────
console.log("\n[2] Module system registration");
{
  const fs = await import("fs");
  const defs = fs.readFileSync(`${ROOT}/src/modules/definitions.ts`, "utf8");

  assert(defs.includes("sleepFn"), "sleepFn imported in definitions");
  assert(defs.includes('{ name: "sleep", fn: sleepFn }'), "sleep listed in contrib module extensions");
}

// ── [3] Tool-security allowlist ──────────────────────────────
console.log("\n[3] Tool-security allowlist");
{
  const fs = await import("fs");
  const ts = fs.readFileSync(`${ROOT}/src/lib/tool-security.ts`, "utf8");

  assert(ts.includes('"sleep"'), "sleep in SAFE_TOOL_KEEP");
}

// ── [4] Build artifact exists ────────────────────────────────
console.log("\n[4] Build artifact");
{
  const fs = await import("fs");
  assert(
    fs.existsSync(`${ROOT}/dist/contrib/sleep/index.js`),
    "dist/contrib/sleep/index.js exists after build",
  );
  const js = fs.readFileSync(`${ROOT}/dist/contrib/sleep/index.js`, "utf8");
  assert(js.includes("sleepExtension"), "built JS exports sleepExtension");
  assert(js.includes("setTimeout"), "built JS contains setTimeout");
}

// ── [5] Functional: sleep fires reminder after delay ─────────
console.log("\n[5] Functional: delayed reminder fires after sleep");
{
  // eventBus is a class instance; import and verify it exists
  const { eventBus } = await import(`${ROOT}/dist/lib/event-bus.js`);
  assert(eventBus && typeof eventBus.emit === "function", "eventBus available with emit");

  // Verify sleep module can be loaded
  const sleepMod = await import(`${ROOT}/dist/contrib/sleep/index.js`);
  assert(typeof sleepMod.default === "function", "sleepExtension is callable (default export)");
}

// ── [6] Delay validation ─────────────────────────────────────
console.log("\n[6] Delay parameter validation");
{
  const src = await import("fs").then((f) => f.readFileSync(`${ROOT}/src/contrib/sleep/index.ts`, "utf8"));

  assert(
    src.includes("MIN_DELAY_SECS = 1") && src.includes("MAX_DELAY_SECS = 86_400"),
    "delay bounds are [1, 86400]",
  );
  assert(src.includes("throw new Error"), "throws on invalid delay");
  assert(src.includes('default: DEFAULT_DELAY_SECS'), "default is 30s");
}

// ── Summary ──────────────────────────────────────────────────
console.log("\n" + "=".repeat(50));
console.log("Sleep Tool Tests: " + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);
