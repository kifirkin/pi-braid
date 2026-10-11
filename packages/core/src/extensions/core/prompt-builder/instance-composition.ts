/**
 * Instance Composition: renders the full Instance block (Agent + pi-core
 * version, runtime paths, OS/PID, session, extension packages, other pi
 * instances) on demand via renderInstance (system_info tool); the prompt
 * carries only a compact one-line orientation (version | cwd | session).
 * Invariants: "Root" = pi-core's npm package folder; packages come from
 * the settings `packages` field (project / user-global, pi-core
 * precedence), never a sibling walk; pi-core version resolves from the
 * running pi binary; skills+memory live in memory-section.ts / the list_skills
 * tool; output
 * never contains internal module paths or "->".
 */

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { PromptSection } from "./section.js";
import { discoverTopLevelExtensions, type TopLevelExtension } from "./top-level-extensions.js";
import { gatherL1Environment, type L1EnvironmentData } from "../agent-environment/index.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

/** One loaded skill (name/path/baseDir) as surfaced by pi's skill discovery.
 * Defined here; instance-composition is the only consumer. */
export interface SkillEntry {
  name: string;
  filePath: string;
  baseDir: string;
  /** Frontmatter description (unused by the render; kept for call-site shape). */
  description?: string;
}

interface PiVersionInfo {
  version: string;
  root: string;
  /** Path to the resolved `pi` binary. */
  binary: string;
}

function discoverRunningPi(): PiVersionInfo {
  // 1. Find the actually-running `pi` binary. We DON'T just call
  //    `which pi` because that follows PATH order and can return a
  //    stale binary from a sibling repo's `node_modules/.bin` (e.g.
  //    when running tests from inside a repo, npm puts
  //    `<repo>/node_modules/.bin` first in PATH and `which pi` then
  //    resolves to that repo's old pinned binary instead of the
  //    user's actually-installed one). Instead, walk PATH manually
  //    and skip any entry containing `/node_modules/.bin/` -- those
  //    are project-local installs and almost always stale relative
  //    to the user's mise/npm-global install.
  const PATH_DIRS = (process.env.PATH ?? "").split(":");
  let binary = "";
  for (const dir of PATH_DIRS) {
    const candidate = join(dir, "pi");
    if (!existsSync(candidate)) continue;
    if (candidate.includes("/node_modules/.bin/")) continue;
    binary = candidate;
    break;
  }
  // Fallback to `which pi` if PATH walking didn't find anything
  // (e.g. PATH is unset or unusual shell).
  if (!binary) {
    try {
      binary = execSync("which pi 2>/dev/null || true", {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
    } catch {
      binary = "";
    }
  }
  if (!binary || !existsSync(binary)) {
    // Fall back: walk up from process.argv[1] looking for the
    // pi-coding-agent package. This works when invoked through
    // node directly (e.g. `node /path/to/pi-coding-agent/dist/cli.js`).
    let dir = "";
    try {
      const argv1 = process.argv[1];
      if (argv1) dir = dirname(argv1);
    } catch {
      dir = "";
    }
    if (!dir) return { version: "unknown", root: "", binary: "" };
    for (let i = 0; i < 8; i++) {
      const candidate = join(dir, "package.json");
      if (existsSync(candidate)) {
        try {
          const pkg = JSON.parse(readFileSync(candidate, "utf8"));
          if (pkg.name === "@earendil-works/pi-coding-agent") {
            return { version: pkg.version ?? "unknown", root: dir, binary: dir };
          }
        } catch {
          // continue
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    return { version: "unknown", root: "", binary: "" };
  }
  // 2. Resolve any symlinks (mise installs `bin/pi` as a symlink to
  //    `lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`).
  try {
    binary = realpathSync(binary);
  } catch {
    // not a symlink, fall through
  }
  // 3. Walk up from the binary looking for the pi-coding-agent
  //    package. Two strategies per level:
  //      a) `<dir>/node_modules/@earendil-works/pi-coding-agent/package.json`
  //         (mise / npm global layout: the binary's sibling-parent
  //         holds the package in its node_modules).
  //      b) `<dir>/package.json` whose `name` field matches
  //         (source / monorepo layout: the binary lives inside
  //         the package itself).
  let dir = dirname(binary);
  for (let i = 0; i < 10; i++) {
    // Strategy (a): node_modules lookup.
    const nmCandidate = join(
      dir,
      "node_modules",
      "@earendil-works",
      "pi-coding-agent",
      "package.json",
    );
    if (existsSync(nmCandidate)) {
      try {
        const pkg = JSON.parse(readFileSync(nmCandidate, "utf8"));
        if (pkg.name === "@earendil-works/pi-coding-agent") {
          return {
            version: pkg.version ?? "unknown",
            root: dirname(dirname(dirname(nmCandidate))),
            binary,
          };
        }
      } catch {
        // continue
      }
    }
    // Strategy (b): direct package.json lookup.
    const directCandidate = join(dir, "package.json");
    if (existsSync(directCandidate)) {
      try {
        const pkg = JSON.parse(readFileSync(directCandidate, "utf8"));
        if (pkg.name === "@earendil-works/pi-coding-agent") {
          return { version: pkg.version ?? "unknown", root: dir, binary };
        }
      } catch {
        // continue
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return { version: "unknown", root: "", binary };
}

function readBraidVersion(): { version: string; root: string } {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "pi-braid") return { version: pkg.version ?? "unknown", root: dir };
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return { version: "unknown", root: process.cwd() };
}

// Discovers all `pi` processes running on the system (including the current
// one) and their working directories. Uses `ps` + `lsof` on macOS/Linux.
// Results are cached with a short TTL to avoid repeated `lsof` calls.

interface OtherPiInstance {
  pid: number;
  cwd: string;
  /** Elapsed time formatted as a human-readable string (e.g. "5h 25m"). */
  elapsed: string;
  /** Terminal the process is attached to (e.g. "ttys002"). */
  tty: string;
  /** Whether this is the current process. */
  isCurrent: boolean;
}

const CACHE_TTL_MS = 5_000;
let _otherPiCache: { data: OtherPiInstance[]; timestamp: number } | null = null;

function discoverOtherPiInstances(): OtherPiInstance[] {
  const now = Date.now();
  if (_otherPiCache && now - _otherPiCache.timestamp < CACHE_TTL_MS) {
    return _otherPiCache.data;
  }

  const instances: OtherPiInstance[] = [];
  const currentPid = process.pid;

  try {
    // Match the exact command name "pi" (not grep, not "pi-braid", not "pi-coding-agent").
    const psOut = spawnSync("ps", ["-eo", "pid=,etime=,tty=,comm=", "-o", "command="], {
      encoding: "utf8",
      timeout: 5000,
    });
    if (psOut.status !== 0) return [];

    const lines = psOut.stdout.trim().split("\n");
    const piPids: number[] = [];
    const piLines: Map<number, { elapsed: string; tty: string }> = new Map();

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split(/\s+/);
      if (parts.length < 4) continue;

      const pid = parseInt(parts[0], 10);
      if (isNaN(pid)) continue;

      const elapsed = parts[1];
      const tty = parts[2];
      const comm = parts[3];
      const command = parts.slice(4).join(" ");

      const isPiProcess =
        comm === "pi" || command.includes("pi-coding-agent") || command.includes("/pi");

      if (isPiProcess) {
        piPids.push(pid);
        piLines.set(pid, { elapsed, tty });
      }
    }

    // Batch all PIDs into a single `lsof` call for efficiency.
    if (piPids.length > 0) {
      const pidList = piPids.join(",");
      const lsofOut = spawnSync("lsof", ["-a", "-p", pidList, "-d", "cwd", "-F", "n"], {
        encoding: "utf8",
        timeout: 5000,
      });

      if (lsofOut.status === 0) {
        // Parse lsof output: each entry has a 'p<PID>' line followed by
        // 'fcwd' and 'n<path>' lines. We want the 'n<path>' after 'fcwd'.
        const lsofLines = lsofOut.stdout.split("\n");
        let currentPidEntry = 0;
        let afterCwd = false;

        for (const line of lsofLines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          if (trimmed.startsWith("p")) {
            currentPidEntry = parseInt(trimmed.slice(1), 10) || 0;
            afterCwd = false;
          } else if (trimmed === "fcwd") {
            afterCwd = true;
          } else if (afterCwd && trimmed.startsWith("n")) {
            const cwd = trimmed.slice(1);
            const info = piLines.get(currentPidEntry);
            if (info) {
              instances.push({
                pid: currentPidEntry,
                cwd,
                elapsed: info.elapsed,
                tty: info.tty,
                isCurrent: currentPidEntry === currentPid,
              });
            }
            afterCwd = false;
            currentPidEntry = 0;
          }
        }
      }

      // Fallback: for PIDs where lsof didn't return a cwd (e.g. permission
      // denied), still add them with unknown cwd.
      for (const pid of piPids) {
        if (!instances.find((i) => i.pid === pid)) {
          const info = piLines.get(pid);
          if (info) {
            instances.push({
              pid,
              cwd: "(unknown)",
              elapsed: info.elapsed,
              tty: info.tty,
              isCurrent: pid === currentPid,
            });
          }
        }
      }
    }
  } catch {
    // Non-fatal - instance discovery is a best-effort bonus
  }

  instances.sort((a, b) => {
    if (a.isCurrent) return -1;
    if (b.isCurrent) return 1;
    return a.pid - b.pid;
  });

  _otherPiCache = { data: instances, timestamp: now };
  return instances;
}

export interface InstanceContext {
  /** Skills available (from prompt-builder). */
  skillCount: number;
  /** Unique base directories for loaded skills (from skill file paths).
   *  Defaults to [] when not provided. */
  skillDirs?: string[];
  /** Skill entries for line-count rendering (surfaced via system_info). */
  skills?: SkillEntry[];
  /** Memory entries (from three-memory-stores). */
  memoryCount: number;
}

/** Exported for system-info-tool — the full Instance data shape. */
export interface InstanceData {
  braidVersion: string;
  /** Resolved pi-core info (version + npm package folder). */
  pi: PiVersionInfo;
  /** Userland pi settings directory (~/.pi/agent or
   *  PI_CODING_AGENT_DIR override). The agent uses this to find
   *  its own settings, skills, memory, and session files. */
  settingsDir: string;
  /** System info: platform, hostname, os type. */
  os: { platform: string; type: string; hostname: string };
  /** Current working directory -- where the user invoked `pi` from. */
  cwd: string;
  /** Current ISO datetime, captured at section render. */
  now: string;
  /** ISO datetime when the pi instance/session started (wall clock). */
  startedAt: string;
  /** Session id (pi-core session manager). The agent uses this
   *  to read the raw session file or invoke the session-recall
   *  tool. Format: short hex id or UUID. */
  sessionId: string;
  /** Session state from `agent-environment/gatherL1Environment()`. */
  session: L1EnvironmentData;
  /** Top-level pi extension packages, ordered by discovery priority. */
  topLevelExtensions: TopLevelExtension[];
  /** Other Pi instances running on the system (discovered via ps + lsof). */
  otherPiInstances: OtherPiInstance[];
  skillCount: number;
  /** Unique base directories for loaded skills. */
  skillDirs: string[];
  /** Skill entries for line-count rendering. */
  skills: SkillEntry[];
  memoryCount: number;
}

/**
 * Gather all Instance data without building a PromptSection.
 * Exported for system-info-tool — same data as instanceSection() but
 * no PromptSection wrapping.
 */
export async function gatherInstanceData(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  instanceCtx: InstanceContext,
): Promise<InstanceData> {
  const pi = discoverRunningPi();
  const braid = readBraidVersion();
  const session = gatherL1Environment(_pi, ctx);
  const topLevelExtensions = discoverTopLevelExtensions();
  const osInfo = {
    platform:
      os.platform() === "win32"
        ? "Windows"
        : os.platform() === "darwin"
          ? "macOS"
          : os.platform() === "linux"
            ? "Linux"
            : os.platform(),
    type: os.type(),
    hostname: os.hostname(),
  };
  const otherPiInstances = discoverOtherPiInstances();
  return {
    braidVersion: braid.version,
    pi,
    settingsDir: getAgentDir(),
    os: osInfo,
    cwd: process.cwd(),
    now: new Date().toISOString(),
    startedAt: session.sessionStartedAt,
    sessionId: ctx.sessionManager?.getSessionId() ?? "",
    session,
    topLevelExtensions,
    otherPiInstances,
    skillCount: instanceCtx.skillCount,
    skillDirs: instanceCtx.skillDirs ?? [],
    skills: instanceCtx.skills ?? [],
    memoryCount: instanceCtx.memoryCount,
  };
}

export async function instanceSection(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  instanceCtx: InstanceContext,
): Promise<PromptSection> {
  const data = await gatherInstanceData(_pi, ctx, instanceCtx);
  return {
    name: "instance",
    render: async () => renderInstance(data),
  };
}

/** Exported for system-info-tool — renders InstanceData to plain text. */
export async function renderInstance(d: InstanceData): Promise<string> {
  const lines: string[] = [];
  lines.push(`Agent: Braid v${d.braidVersion} (over pi-core v${d.pi.version})`);

  // Runtime locations. Each is a distinct concept:
  //   - Root:   the pi-core npm package folder (where the agent is hosted).
  //   - Cwd:    where the user invoked `pi` from (their project).
  //   - Settings: the userland pi settings dir (settings.json, skills, memory,
  //             sessions). Override via PI_CODING_AGENT_DIR.
  lines.push(`Core: ${d.pi.root || "(unknown)"}`);
  lines.push(`Cwd: ${d.cwd}`);
  lines.push(`Settings: ${d.settingsDir}`);

  // Environment snapshot: OS + pid.
  lines.push(`OS: ${d.os.platform}`);
  lines.push(`PID: ${d.session.pid}`);
  if (d.startedAt) {
    lines.push(`Started: ${d.startedAt}`);
  } else {
    lines.push(`Started: (unknown)`);
  }

  // Session: id is the discovery hook (read the raw session file or
  // invoke the session-recall tool); elapsed/last-event/turns are
  // volatile session stats.
  const sessionParts: string[] = [];
  if (d.sessionId) sessionParts.push(d.sessionId);
  sessionParts.push(
    `${formatMs(d.session.sessionElapsedMs)} elapsed`,
    `last event ${formatMs(d.session.sinceLastEventMs)} ago`,
    `${d.session.turnCount} turn${d.session.turnCount === 1 ? "" : "s"}`,
  );
  lines.push(`Session: ${sessionParts.join(", ")}`);
  if (d.session.avgToolTimeMs > 0) {
    lines.push(`Tool avg: ${d.session.avgToolTimeMs}ms`);
  }

  // Top-level pi extension PACKAGES (read from pi-core's `packages`
  // settings field -- the real runtime configuration). Each is tagged
  // with the settings scope that owns the entry so the agent can
  // edit the right file when adding/removing a package.
  if (d.topLevelExtensions.length > 0) {
    lines.push("");
    lines.push(`Pi extensions (${d.topLevelExtensions.length} loaded):`);
    for (const ext of d.topLevelExtensions) {
      const tag = ext.source;
      const rel = relativeToCwd(ext.root, d.cwd);
      lines.push(`  ${ext.name} v${ext.version}  ${rel}  (${tag})`);
    }
  }

  // Other Pi instances in the same working directory
  // Filters to only PIDs whose cwd matches the current session's cwd.
  // This surfaces concurrent Pi sessions on the same project without
  // the noise of unrelated Pi instances elsewhere on the system.
  const sameDirInstances = d.otherPiInstances.filter((i) => i.cwd === d.cwd);
  if (sameDirInstances.length > 1) {
    lines.push("");
    const otherCount = sameDirInstances.filter((i) => !i.isCurrent).length;
    lines.push(`Pi instances (${otherCount} other${otherCount === 1 ? "" : "s"}) in cwd:`);
    for (const inst of sameDirInstances) {
      const marker = inst.isCurrent ? "  \u2190 current" : "";
      lines.push(`  PID ${inst.pid}  ${inst.elapsed}  ${inst.tty}${marker}`);
    }
  }

  return lines.join("\n");
}

/**
 * Render a path relative to cwd when possible, else absolute.
 * Keeps the Instance block readable when extensions live next to
 * the cwd project (the common case). When the extension IS the
 * cwd (e.g. pi-braid loaded from the project being worked on),
 * return the absolute path -- not "." -- so the agent can `read`
 * or `grep` the location with the same string it sees elsewhere
 * in the prompt.
 */
function relativeToCwd(p: string, cwd: string): string {
  if (p === cwd) return p + " (cwd)";
  if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
  return p;
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}
