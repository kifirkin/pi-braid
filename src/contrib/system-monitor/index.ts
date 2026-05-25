/**
 * System Monitor Tool — resource usage monitoring without bash ps/top/df.
 *
 * Reports CPU load, memory usage, and disk space as structured metrics.
 * Supports one-shot queries and continuous monitoring with trend tracking.
 *
 * Reduces bash usage by eliminating: `top`, `ps aux`, `df -h`, `free -m`, `vm_stat`.
 */

import * as os from "node:os";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { createLogger } from "../../lib/logger.js";

const log = createLogger("system-monitor");

// ── Types ───────────────────────────────────────────────────────────────────

export interface CpuInfo {
  loadAvg: number[];
  cores: number;
  model: string;
  usagePercent: number;
}

export interface MemoryInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  freePercent: number;
  usedPercent: number;
  formatted: { total: string; free: string; used: string };
}

export interface DiskInfo {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
  freePercent: number;
  mountPoint: string;
  filesystem: string;
  formatted: { total: string; free: string; used: string };
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  state: string;
}

export interface SystemReport {
  timestamp: number;
  hostname: string;
  platform: string;
  uptime: string;
  cpu: CpuInfo;
  memory: MemoryInfo;
  disk: DiskInfo;
  processes: ProcessInfo[];
}

// ── Formatters ──────────────────────────────────────────────────────────────

export function formatBytes(bytes: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

export function formatUptime(seconds: number): string {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const parts: string[] = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0) parts.push(`${hours}h`);
  parts.push(`${mins}m`);
  return parts.join(" ");
}

// ── Collectors ──────────────────────────────────────────────────────────────

export function collectCpu(): CpuInfo {
  const cpus = os.cpus();
  const model = cpus.length > 0 ? cpus[0].model.trim() : "unknown";
  const cores = cpus.length;

  // Calculate CPU usage from /proc or using os.cpus() idle/total
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const type in cpu.times) {
      total += (cpu.times as any)[type];
    }
    idle += cpu.times.idle;
  }
  const usagePercent = total > 0 ? Math.round((1 - idle / total) * 100) : 0;

  return {
    loadAvg: os.loadavg(),
    cores,
    model,
    usagePercent,
  };
}

export function collectMemory(): MemoryInfo {
  const totalBytes = os.totalmem();
  const freeBytes = os.freemem();
  const usedBytes = totalBytes - freeBytes;
  const freePercent = totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 100) : 0;

  return {
    totalBytes,
    freeBytes,
    usedBytes,
    freePercent,
    usedPercent: 100 - freePercent,
    formatted: {
      total: formatBytes(totalBytes),
      free: formatBytes(freeBytes),
      used: formatBytes(usedBytes),
    },
  };
}

export function collectDisk(mountPoint: string): DiskInfo {
  try {
    const stats = fs.statfsSync(mountPoint);
    const totalBytes = stats.blocks * stats.bsize;
    const freeBytes = stats.bfree * stats.bsize;
    const usedBytes = totalBytes - freeBytes;
    const freePercent = totalBytes > 0 ? Math.round((freeBytes / totalBytes) * 100) : 0;

    return {
      totalBytes,
      freeBytes,
      usedBytes,
      freePercent,
      mountPoint,
      filesystem: "unknown",
      formatted: {
        total: formatBytes(totalBytes),
        free: formatBytes(freeBytes),
        used: formatBytes(usedBytes),
      },
    };
  } catch {
    return {
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      freePercent: 0,
      mountPoint,
      filesystem: "unknown",
      formatted: { total: "0 B", free: "0 B", used: "0 B" },
    };
  }
}

function collectProcesses(limit: number): ProcessInfo[] {
  // Use ps via execSync as fallback — os module doesn't provide per-process info
  try {
    const stdout = execSync(`ps -eo pid,comm,%cpu,%mem,state --sort=-%cpu | head -${limit + 1}`, {
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
    const lines = stdout.trim().split("\n").slice(1); // skip header
    return lines.map((line) => {
      const parts = line.trim().split(/\s+/);
      return {
        pid: parseInt(parts[0]) || 0,
        name: parts[1] || "unknown",
        cpu: parseFloat(parts[2]) || 0,
        memory: parseFloat(parts[3]) || 0,
        state: parts[4] || "?",
      };
    });
  } catch {
    return [];
  }
}

export function collectReport(mountPoint: string, processLimit: number): SystemReport {
  return {
    timestamp: Date.now(),
    hostname: os.hostname(),
    platform: `${os.type()} ${os.release()} (${os.arch()})`,
    uptime: formatUptime(os.uptime()),
    cpu: collectCpu(),
    memory: collectMemory(),
    disk: collectDisk(mountPoint),
    processes: collectProcesses(processLimit),
  };
}

// ── Snapshot tracking (session-scoped, keyed on a stable session handle) ────

const _snapshots = new Map<string, SystemReport>();

function getSnapshotKey(session: string | undefined): string {
  return session ?? "default";
}

function collectDelta(current: SystemReport, sessionKey?: string): Record<string, string> {
  const key = getSnapshotKey(sessionKey);
  const previous = _snapshots.get(key);
  if (!previous) {
    _snapshots.set(key, current);
    return { info: "First snapshot — no delta available" };
  }

  const memDelta = current.memory.freePercent - previous.memory.freePercent;
  const diskDelta = current.disk.freePercent - previous.disk.freePercent;
  const cpuDelta = current.cpu.usagePercent - previous.cpu.usagePercent;
  _snapshots.set(key, current);

  return {
    "memory Δ": `${memDelta > 0 ? "+" : ""}${memDelta.toFixed(1)}% free`,
    "disk Δ": `${diskDelta > 0 ? "+" : ""}${diskDelta.toFixed(1)}% free`,
    "cpu Δ": `${cpuDelta > 0 ? "+" : ""}${cpuDelta.toFixed(1)}% usage`,
  };
}

// ── Extension ───────────────────────────────────────────────────────────────

export default function systemMonitorExtension(pi: ExtensionAPI) {
  pi.registerTool({
    name: "system_monitor",
    label: "System Monitor",
    promptSnippet: "Report CPU, memory, disk, and top processes",
    description:
      "Report CPU, memory, disk, and top processes as structured metrics — use to troubleshoot performance issues. " +
      "Use mount_point to check a specific disk (default: /). " +
      "Set with_delta=true to see changes from last call. " +
      "Set process_limit to control how many top processes are returned (default: 0 = none).",
    parameters: Type.Object({
      mount_point: Type.Optional(
        Type.String({ default: "/", description: "Disk mount point to check" }),
      ),
      with_delta: Type.Optional(
        Type.Boolean({ default: false, description: "Show delta from last check" }),
      ),
      process_limit: Type.Optional(
        Type.Number({ default: 0, description: "Top N processes by CPU (0=none)" }),
      ),
    }),
    execute: async (_toolCallId: string, params: any): Promise<any> => {
      const mountPoint = params.mount_point || "/";
      const processLimit = params.process_limit ?? 0;
      const withDelta = params.with_delta ?? false;

      const report = collectReport(mountPoint, processLimit);

      // Build structured text output
      const lines: string[] = [
        `🖥  ${report.hostname} — ${report.platform}`,
        `⏱  Uptime: ${report.uptime}`,
        ``,
        `📊 **CPU**: ${report.cpu.usagePercent}% used (${report.cpu.cores} cores @ ${report.cpu.model})`,
        `   Load avg: ${report.cpu.loadAvg.map((v) => v.toFixed(2)).join(", ")}`,
        ``,
        `💾 **Memory**: ${report.memory.formatted.used} / ${report.memory.formatted.total} (${report.memory.usedPercent}%)`,
        `   Free: ${report.memory.formatted.free} (${report.memory.freePercent}%)`,
        ``,
        `💽 **Disk (${report.disk.mountPoint})**: ${report.disk.formatted.used} / ${report.disk.formatted.total} (${100 - report.disk.freePercent}%)`,
        `   Free: ${report.disk.formatted.free} (${report.disk.freePercent}%)`,
      ];

      if (withDelta) {
        const delta = collectDelta(report, process.cwd());
        lines.push(``, `📈 **Delta from last check**:`);
        for (const [key, val] of Object.entries(delta)) {
          lines.push(`   ${key}: ${val}`);
        }
      }

      if (processLimit > 0 && report.processes.length > 0) {
        lines.push(
          ``,
          `🔝 **Top ${Math.min(processLimit, report.processes.length)} processes by CPU**:`,
        );
        lines.push(`   PID  NAME                CPU%  MEM%  STATE`);
        for (const p of report.processes.slice(0, processLimit)) {
          lines.push(
            `   ${String(p.pid).padEnd(5)} ${p.name.padEnd(18)} ${String(p.cpu.toFixed(1)).padStart(5)} ${String(p.memory.toFixed(1)).padStart(5)}  ${p.state}`,
          );
        }
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n") }],
        details: {
          hostname: report.hostname,
          platform: report.platform,
          uptime: report.uptime,
          cpu: {
            usagePercent: report.cpu.usagePercent,
            cores: report.cpu.cores,
            loadAvg: report.cpu.loadAvg,
          },
          memory: report.memory,
          disk: report.disk,
          processes: report.processes.slice(0, processLimit),
        },
      };
    },
  });

  log.info("System monitor extension registered.");
}
