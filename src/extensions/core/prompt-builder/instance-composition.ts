/**
 * Instance Composition section for the prompt-builder.
 *
 * Renders a concise, tree-style "## Instance" block at the top of the
 * system prompt. Surfaces:
 *   - Agent identity + version (Braid over pi-core)
 *   - Runtime environment (root, cwd, os, datetime)
 *   - Extension tree (grouped by module, with per-extension tool counts)
 *   - Aggregate counts (total tools, skills, memory entries)
 *   - Skipped extensions (if any)
 *
 * This block is the agent's at-a-glance view of "what's loaded and where
 * it came from." Replaces the scattered env info previously split
 * between agent-environment/index.ts and l1-environment.ts.
 *
 * Stable per session-start: does NOT include volatile session stats
 * (turns, elapsed, tool avg) — those live in the Session block.
 * Conditional context info (%, memory count, health) lives in Context.
 *
 * Tool provenance comes from src/lib/state/tool-provenance.ts, which
 * the loader populates at extension-load time.
 *
 * Discovery: agent reads this on every turn; for full extension
 * details (e.g., "what does enforcement do?"), it consults the
 * source code directly via the read tool. No braid-reference skill
 * is needed — the Instance tree IS the documentation.
 */

import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import * as os from "node:os";
import type { PromptSection } from "./section.js";
import { getToolProvenance } from "../../../lib/state/tool-provenance.js";
import {
  MANIFEST,
  getModuleGroup,
  getModuleNames,
} from "../../../extensions/manifest.js";

interface PiVersionInfo {
  version: string;
  root: string;
}

interface InstanceData {
  braidVersion: string;
  braidRoot: string;
  piVersionInfo: PiVersionInfo;
  /** System info: platform, hostname, os type. */
  machine: { platform: string; type: string; hostname: string };
  /** Current ISO datetime, captured at section render. */
  now: string;
  /** Extensions grouped by module, with tool counts. */
  modules: Array<{
    name: string;
    extensions: Array<{
      id: string;
      desc: string;
      alwaysOn: boolean;
      disabledByDefault: boolean;
      enabled: boolean;
      tools: string[];
    }>;
  }>;
  /** Tools that pi-core registered (not attributed to any extension). */
  coreTools: string[];
  /** Total skill count, if available. */
  skillCount: number;
  /** Total memory entry count, if available. */
  memoryCount: number;
}

// ── Pi-core version discovery (mirrors pi-reference skill) ──────────────────

const PI_PACKAGE_NAMES = ["@earendil-works/pi-coding-agent"];

function discoverPiRootPath(): string {
  try {
    const piPath = execSync("which pi 2>/dev/null || echo ''", {
      encoding: "utf8",
      timeout: 5000,
    }).trim();
    if (piPath && existsSync(piPath)) {
      let dir = dirname(piPath);
      for (let i = 0; i < 5; i++) {
        const pkgPath = join(dir, "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          if (PI_PACKAGE_NAMES.includes(pkg.name)) return dir;
        }
        dir = dirname(dir);
      }
    }
  } catch {
    // fall through to next strategy
  }
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 10; i++) {
      for (const pkgName of PI_PACKAGE_NAMES) {
        const [scope, name] = pkgName.split("/");
        const candidate = join(dir, "node_modules", scope, name, "package.json");
        if (existsSync(candidate)) {
          const pkg = JSON.parse(readFileSync(candidate, "utf8"));
          if (pkg.name === pkgName) return dirname(candidate);
        }
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return "";
}

function readPiVersion(): PiVersionInfo {
  const root = discoverPiRootPath();
  if (!root) return { version: "unknown", root: "" };
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    return { version: pkg.version ?? "unknown", root };
  } catch {
    return { version: "unknown", root };
  }
}

// ── Braid version discovery (this package) ──────────────────────────────────

function readBraidVersion(): { version: string; root: string } {
  try {
    let dir = dirname(fileURLToPath(import.meta.url));
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        if (pkg.name === "pi-braid") return { version: pkg.version ?? "unknown", root: dir };
      }
      const parent = resolve(dir, "..");
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return { version: "unknown", root: process.cwd() };
}

// ── Module grouping with tool counts ────────────────────────────────────────

function buildModulesData(
  enabledIds: Set<string>,
): {
  modules: InstanceData["modules"];
  coreTools: string[];
} {
  const provenance = getToolProvenance();
  const toolCounts = new Map<string, number>();
  for (const [toolName, extId] of provenance) {
    toolCounts.set(extId, (toolCounts.get(extId) ?? 0) + 1);
  }
  // Tools not attributed to any extension (pi-core built-ins)
  const allExtensions = new Set(MANIFEST.map((e) => e.id));
  const coreTools: string[] = [];
  for (const [toolName, extId] of provenance) {
    if (!allExtensions.has(extId)) coreTools.push(toolName);
  }

  const moduleNames = getModuleNames();
  const modules: InstanceData["modules"] = [];

  for (const modName of moduleNames) {
    const entries = getModuleGroup(modName);
    if (entries.length === 0) continue;
    const extensions = entries.map((e) => {
      const tools = Array.from(provenance.entries())
        .filter(([, src]) => src === e.id)
        .map(([name]) => name)
        .sort();
      return {
        id: e.id,
        desc: e.desc,
        alwaysOn: e.alwaysOn ?? false,
        disabledByDefault: e.disabledByDefault ?? false,
        enabled: enabledIds.has(e.id),
        tools,
      };
    });
    modules.push({ name: modName, extensions });
  }

  // Sort modules: alwaysOn first, then alphabetical
  modules.sort((a, b) => {
    const aAlways = a.extensions.every((e) => e.alwaysOn) ? 0 : 1;
    const bAlways = b.extensions.every((e) => e.alwaysOn) ? 0 : 1;
    if (aAlways !== bAlways) return aAlways - bAlways;
    return a.name.localeCompare(b.name);
  });

  return { modules, coreTools };
}

// ── Main builder ────────────────────────────────────────────────────────────

export interface InstanceContext {
  /** Set of currently-enabled extension IDs (from loader state). */
  enabledIds: string[];
  /** Skills available (from prompt-builder). */
  skillCount: number;
  /** Memory entries (from three-memory-stores). */
  memoryCount: number;
}

export async function instanceSection(ctx: InstanceContext): Promise<PromptSection> {
  const piVersion = readPiVersion();
  const braid = readBraidVersion();
  const machine = {
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

  const enabledIds = new Set(ctx.enabledIds);
  const { modules, coreTools } = buildModulesData(enabledIds);

  const data: InstanceData = {
    braidVersion: braid.version,
    braidRoot: braid.root,
    piVersionInfo: piVersion,
    machine,
    now: new Date().toISOString(),
    modules,
    coreTools,
    skillCount: ctx.skillCount,
    memoryCount: ctx.memoryCount,
  };

  return {
    name: "instance",
    render: () => renderInstance(data),
  };
}

function renderInstance(d: InstanceData): string {
  const lines: string[] = [];
  lines.push("## Instance");
  lines.push(
    `Agent: Braid v${d.braidVersion} (over pi-core v${d.piVersionInfo.version})`,
  );
  lines.push(`Root: ${d.braidRoot}`);
  lines.push(`Cwd: ${process.cwd()}`);
  lines.push(`OS: ${d.machine.platform} (${d.machine.type})`);
  lines.push(`Now: ${d.now}`);

  // Extension tree
  const totalEnabled = d.modules.reduce(
    (sum, m) => sum + m.extensions.filter((e) => e.enabled).length,
    0,
  );
  const totalExtensions = d.modules.reduce((sum, m) => sum + m.extensions.length, 0);
  const totalTools = d.modules.reduce(
    (sum, m) => sum + m.extensions.reduce((s, e) => s + e.tools.length, 0),
    0,
  ) + d.coreTools.length;

  lines.push("");
  lines.push(
    `Extensions (${totalEnabled}/${totalExtensions} enabled, ${totalTools} tools):`,
  );

  for (const mod of d.modules) {
    const enabledExts = mod.extensions.filter((e) => e.enabled);
    if (enabledExts.length === 0) continue;
    const modLabel = mod.name;
    const isAlwaysOn = enabledExts.every((e) => e.alwaysOn);
    const tag = isAlwaysOn ? "always-on" : "";
    lines.push(`  ${modLabel}${tag ? ` (${tag})` : ""}:`);
    for (const ext of enabledExts) {
      const count = ext.tools.length;
      const tools = count > 0 ? ` [${count} tool${count === 1 ? "" : "s"}]` : "";
      lines.push(`    - ${ext.id}${tools}`);
    }
  }

  if (d.coreTools.length > 0) {
    lines.push(`  pi-core: ${d.coreTools.length} built-in tool${d.coreTools.length === 1 ? "" : "s"}`);
  }

  // Aggregate counts
  const counts: string[] = [];
  if (d.skillCount > 0) counts.push(`${d.skillCount} skill${d.skillCount === 1 ? "" : "s"}`);
  if (d.memoryCount > 0) counts.push(`${d.memoryCount} memor${d.memoryCount === 1 ? "y" : "ies"}`);
  if (counts.length > 0) {
    lines.push("");
    lines.push(`Resources: ${counts.join(", ")}`);
  }

  return lines.join("\n");
}
