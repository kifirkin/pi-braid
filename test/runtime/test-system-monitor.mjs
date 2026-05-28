/**
 * Test: System Monitor Tool
 *
 * Verifies extension registration, metric collection logic,
 * formatting helpers, and module system integration.
 */

const ROOT = "/Users/kifir/projects/agents/pi-braid";

let passed = 0;
let failed = 0;
const assert = (cond, msg) => cond ? (passed++, console.log("  ✅ " + msg)) : (failed++, console.log("  ❌ " + msg));

// ── [1] Extension file exists ─────────────────────────────────
console.log("\n[1] System monitor extension structure");
{
  const fs = await import("fs");
  const src = fs.readFileSync(`${ROOT}/src/contrib/system-monitor/index.ts`, "utf8");

  assert(src.includes("export default function systemMonitorExtension"), "exports default function");
  assert(src.includes("registerTool"), "registers a tool");
  assert(src.includes("system_monitor"), "tool name is system_monitor");
  assert(src.includes("mount_point"), "accepts mount_point param");
  assert(src.includes("with_delta"), "accepts with_delta param");
  assert(src.includes("process_limit"), "accepts process_limit param");
  assert(src.includes("collectCpu"), "has CPU collector");
  assert(src.includes("collectMemory"), "has memory collector");
  assert(src.includes("collectDisk"), "has disk collector");
  assert(src.includes("collectProcesses"), "has process collector");
  assert(src.includes("formatBytes"), "has byte formatter");
  assert(src.includes("formatUptime"), "has uptime formatter");
  assert(src.includes("collectDelta"), "has delta tracker");
  assert(src.includes("CpuInfo"), "exports CpuInfo type");
  assert(src.includes("MemoryInfo"), "exports MemoryInfo type");
  assert(src.includes("DiskInfo"), "exports DiskInfo type");
  assert(src.includes("SystemReport"), "exports SystemReport type");
}

// ── [2] Module system registration ────────────────────────────
console.log("\n[2] Extension manifest registration");
{
  const fs = await import("fs");
  const mani = fs.readFileSync(`${ROOT}/src/extensions/manifest.ts`, "utf8");

  assert(mani.includes("systemMonitorFn"), "systemMonitorFn imported in manifest");
  assert(mani.includes("system-monitor"), "system-monitor listed in manifest");
}

// ── [3] Format helpers ────────────────────────────────────────
console.log("\n[3] Format helpers");
{
  const { formatBytes, formatUptime } = await import("../../dist/contrib/system-monitor/index.js");

  assert(formatBytes(0) === "0.0 B", "0 bytes formats correctly");
  assert(formatBytes(1024) === "1.0 KB", "1024 bytes = 1 KB");
  assert(formatBytes(1048576) === "1.0 MB", "1048576 bytes = 1 MB");
  assert(formatBytes(1073741824) === "1.0 GB", "1 GB formats correctly");
  assert(formatUptime(0) === "0m", "0 uptime");
  assert(formatUptime(3600) === "1h 0m", "1 hour uptime");
  assert(formatUptime(86400) === "1d 0m", "1 day uptime");
  assert(formatUptime(90000) === "1d 1h 0m", "1 day 1 hour");
}

// ── [4] CPU collector logic ───────────────────────────────────
console.log("\n[4] CPU collector");
{
  const { collectCpu } = await import("../../dist/contrib/system-monitor/index.js");
  const cpu = collectCpu();

  assert(typeof cpu.cores === "number" && cpu.cores > 0, `Has cores: ${cpu.cores}`);
  assert(typeof cpu.usagePercent === "number", "Usage percent is number");
  assert(Array.isArray(cpu.loadAvg), "Has load average array");
  assert(cpu.loadAvg.length === 3, "Load average has 3 values");
  assert(typeof cpu.model === "string" && cpu.model.length > 0, "Has CPU model name");
}

// ── [5] Memory collector logic ────────────────────────────────
console.log("\n[5] Memory collector");
{
  const { collectMemory } = await import("../../dist/contrib/system-monitor/index.js");
  const mem = collectMemory();

  assert(mem.totalBytes > 0, "Total memory > 0");
  assert(mem.freeBytes >= 0, "Free memory >= 0");
  assert(mem.usedBytes >= 0, "Used memory >= 0");
  assert(mem.freePercent + mem.usedPercent === 100, "Free% + used% = 100");
  assert(typeof mem.formatted.total === "string", "Formatted total is string");
  assert(typeof mem.formatted.free === "string", "Formatted free is string");
}

// ── [6] Disk collector logic ──────────────────────────────────
console.log("\n[6] Disk collector");
{
  const { collectDisk } = await import("../../dist/contrib/system-monitor/index.js");
  const disk = collectDisk("/");

  assert(disk.totalBytes > 0, "Total disk > 0");
  assert(disk.freePercent >= 0, "Free percent >= 0");
  assert(disk.mountPoint === "/", "Default mount point is /");
  assert(typeof disk.formatted.total === "string", "Formatted disk total is string");
}

// ── [7] Report collection ─────────────────────────────────────
console.log("\n[7] Full report");
{
  const { collectReport } = await import("../../dist/contrib/system-monitor/index.js");
  const report = collectReport("/", 3);

  assert(report.hostname.length > 0, "Has hostname");
  assert(report.platform.length > 0, "Has platform info");
  assert(report.uptime.length > 0, "Has uptime string");
  assert(report.cpu.cores > 0, "Report has CPU info");
  assert(report.memory.totalBytes > 0, "Report has memory info");
  assert(report.disk.totalBytes > 0, "Report has disk info");
  assert(Array.isArray(report.processes), "Has processes array");
}

// Summary
console.log("\n" + ("=").repeat(50));
console.log("System Monitor Tests: " + passed + " passed, " + failed + " failed");
