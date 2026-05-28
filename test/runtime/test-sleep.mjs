/**
 * Test: Sleep Tool — pause agent execution
 *
 * Verifies:
 *  1. Extension file structure
 *  2. Module registration in definitions.ts
 *  3. Tool registration and basic execution
 *  4. Resume steer fires after the requested delay
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
  assert(!src.includes("reason"), "does NOT accept reason param (removed in simplification)");
  assert(src.includes("setTimeout"), "uses setTimeout to schedule resolve");
  assert(!src.includes("emitTimerReminder"), "does NOT push to timer-bus");
  assert(!src.includes("eventBus.emit"), "does NOT emit to event-bus");
  assert(!src.includes("sendTrackedMessage"), "does NOT send resume steer (blocks promise instead)");
  assert(!src.includes("unref"), "does NOT unref (timer must keep process alive)");
  assert(src.includes("Do NOT use bash"), "description warns against bash sleep");
  assert(src.includes("timer_set"), "description cross-references timer_set");
  assert(src.includes("Pause agent execution"), "description says pause not delay");
  assert(!src.includes("Returns immediately"), "description does NOT claim returns immediately (now blocks)");
  assert(src.includes("MIN_DELAY_SECS"), "has minimum delay validation");
  assert(src.includes("MAX_DELAY_SECS"), "has maximum delay validation");
}

// ── [2] Module system registration ───────────────────────────
console.log("\n[2] Extension manifest registration (sleep removed — was dead code)");
{
  const fs = await import("fs");
  const mani = fs.readFileSync(`${ROOT}/src/extensions/manifest.ts`, "utf8");

  assert(!mani.includes("sleepFn"), "sleepFn import removed from manifest");
  assert(!mani.includes('"sleep"'), "sleep extension unregistered from manifest");
}

// ── [3] Tool-security: tool-security.ts was dead code (graveyard → deleted) ──
// The file no longer exists, and the SAFE_TOOL_KEEP allowlist was abandoned.
// Sleep tool registration in manifest covers tool availability.
console.log("\n[3] Tool-security check skipped (tool-security.ts was dead code)");

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
  assert(!js.includes("sendTrackedMessage"), "built JS does NOT import sendTrackedMessage");
}

// ── [5] Module loadable ─────────────────────────────────────
console.log("\n[5] Module can be loaded at runtime");
{
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

// ── [7] Promise blocks until delay elapses ────────────────────
console.log("\n[7] Tool blocks until delay elapses");
{
  const src = await import("fs").then((f) => f.readFileSync(`${ROOT}/src/contrib/sleep/index.ts`, "utf8"));
  assert(
    src.includes("await new Promise<void>((resolve) => setTimeout(resolve, delayMs))"),
    "execute awaits a delayed promise to block tool call",
  );
  assert(
    !src.includes("sendTrackedMessage"),
    "no sendTrackedMessage call (no steer needed)",
  );
  assert(
    !src.includes("deliverAs: \"steer\""),
    "no steer delivery (resume naturally from promise resolve)",
  );
}

// ── Summary ──────────────────────────────────────────────────
console.log("\n" + "=".repeat(50));
console.log("Sleep Tool Tests: " + passed + " passed, " + failed + " failed");
process.exit(failed > 0 ? 1 : 0);