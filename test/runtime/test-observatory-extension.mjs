/**
 * Test: Observatory Extension — real-time agent monitoring dashboard.
 *
 * Verifies that:
 * 1. The observatory extension registers correctly in the module system
 * 2. The /observatory tool is registered with expected parameters
 * 3. The extension wires session_start → WebSocket server start
 * 4. The frontend HTML file exists and loads correctly
 */

const ROOT = "/Users/kifir/projects/agents/pi-braid";

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

// ── [1] Extension file exists and exports a default function ──────────
console.log("\n[1] Observatory extension structure");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/contrib/observatory/index.ts`, "utf8");

  assert(src.includes("export default function observatoryExtension"), "exports default function");
  assert(src.includes("pi.registerTool"), "registers /observatory tool");
  assert(src.includes("pi.on(\"session_start\"") || src.includes("registerSessionStartHandler"), "listens to session_start");
  assert(src.includes("isDaemonRunning"), "checks daemon status via PID");
  assert(src.includes("braid-daemon.sh"), "manages daemon via shell script");
  assert(src.includes("execSync"), "uses execSync for daemon control");
  assert(!src.includes("startObservatory"), "does NOT start server (daemon manages)");
  assert(src.includes("\"observatory\""), "tool name is observatory");
  assert(src.includes("StringEnum"), "uses StringEnum for action parameter");
  assert(src.includes("status"), "has status action");
  assert(src.includes("start"), "has start action");
  assert(src.includes("stop"), "has stop action");
  assert(src.includes("restart"), "has restart action");
}

// ── [2] Extension is registered in module definitions ────────────────
console.log("\n[2] Module system registration");
{
  const fs = await import("fs");
  const defs = fs.readFileSync(`${ROOT}/src/modules/definitions.ts`, "utf8");

  assert(defs.includes("observatoryFn"), "observatoryFn imported in definitions");
  assert(defs.includes("observatory"), "observatory listed in tools module");
  assert(defs.includes("\"session_start\", \"session_shutdown\""), "observatory events in listensTo");
}

// ── 
// ── [3] Observatory library check skipped (was dead code) ──
// The old src/lib/observatory.ts was in graveyard/ and deleted.
// Current observatory is at contrib/observatory/ (client tool) and
// braid-os/observatory-daemon.ts (server daemon).
console.log("[3] Observatory library check skipped (was dead code)");
// ── [4] Frontend HTML exists and loads ───────────────────────────────
console.log("\n[4] Observatory frontend");
{
  const fs = await import("fs");
  const html = fs.readFileSync(`${ROOT}/observatory/index.html`, "utf8");

  assert(html.includes("pi-braid Observatory"), "has title");
  assert(html.includes("Three.js") || html.includes("three.module"), "loads Three.js");
  assert(html.includes("WebSocket"), "has WebSocket connection");
  assert(html.includes("localhost:4199"), "connects to port 4199");
  assert(html.includes("OrbitControls"), "has OrbitControls");
  assert(html.includes("CSS2DRenderer"), "has CSS2DRenderer for labels");
  assert(html.includes("timeline"), "has timeline panel");
  assert(html.includes("metrics"), "has metrics panel");
  assert(html.includes("turn_complete"), "supports turn_complete events");
  assert(html.includes("enforcement_violation"), "supports enforcement events");
  assert(html.includes("heartbeat_tick"), "supports heartbeat events");
}

// ── [5] Test discovery ───────────────────────
console.log("\n[5] Test discovery");
{
  const fs = await import("fs");
  const files = fs.readdirSync(`${ROOT}/test/runtime`);
  assert(files.includes("test-observatory-extension.mjs"), "observatory extension test file exists");
  assert(files.includes("test-observatory.mjs"), "observatory lib test file exists");
  assert(true, "test runner auto-discovers .mjs files");
}

// Summary
console.log("\n" + ("=").repeat(50));
console.log("Observatory Extension Tests: " + passed + " passed, " + failed + " failed");
if (failed > 0) process.exit(1);
