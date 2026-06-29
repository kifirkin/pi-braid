/**
 * Instance Composition section for the prompt-builder.
 *
 * Renders a concise, consolidated "## Instance" block at the very
 * top of the system prompt. Surfaces:
 *   - Agent identity + the actually-running pi-core version
 *   - Runtime environment (root, cwd, os, hostname, now, pid)
 *   - Session state (session elapsed, since-last-event, turn count,
 *     tool-call average) — merged from the prior Session block
 *   - Top-level pi extension PACKAGES (not internal modules) with
 *     load-source classification (cwd / sibling / user-global / npm)
 *   - Aggregate counts (total skills, memory entries)
 *   - A discovery hint pointing at the read tool
 *
 * This is the agent's at-a-glance view of "what is loaded and
 * where it came from." The three-block system prompt architecture
 * (v3.6) collapsed into two in v3.7:
 *   - Instance (this block): all stable + volatile env / session
 *     state, plus top-level pi extensions.
 *   - Context: conditional context info (memory count, session
 *     health, context %, checkpoint awareness) — only shown when
 *     there is something to surface.
 *
 * The split was driven by two concerns:
 *   1. Braid internal modules (core / cognitive / memory / ...) are
 *      project-specific info that leaks implementation details into
 *      every system prompt. They were replaced by top-level pi
 *      extension package discovery (pi-braid, pi-braid-contrib,
 *      pi-braid-skills, ...) — the "what's loaded" question at the
 *      right level of abstraction.
 *   2. The prior "## Session" block (PID, session time, turns,
 *      tool avg) was conceptually part of the same top-of-prompt
 *      env summary; keeping it in a separate section diluted both
 *      blocks. Merged into Instance so all env info lives together.
 *
 * Pi-core version discovery was rewritten in v3.7 to use the
 * actually-running pi binary (resolved via `which pi`) rather than
 * walking up from braid's `import.meta.url`. The old walk could
 * find braid's local node_modules (often an outdated version)
 * before the global installation that actually runs.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import type { PromptSection } from "./section.js";
import {
  discoverTopLevelExtensions,
  type TopLevelExtension,
} from "./top-level-extensions.js";
import { gatherL1Environment, type L1EnvironmentData } from "../agent-environment/index.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

// ── Pi-core version discovery (use the actually-running binary) ─────────────

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
  //    when running tests from inside the pi-braid repo, npm puts
  //    `<repo>/node_modules/.bin` first in PATH and `which pi` then
  //    resolves to braid's old pinned 0.77.0 binary instead of the
  //    user's actually-installed 0.80.2). Instead, walk PATH manually
  //    and skip any entry containing `/node_modules/.bin/` — those
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
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    // fall through
  }
  return { version: "unknown", root: process.cwd() };
}

// ── Main builder ────────────────────────────────────────────────────────────

export interface InstanceContext {
  /** Skills available (from prompt-builder). */
  skillCount: number;
  /** Memory entries (from three-memory-stores). */
  memoryCount: number;
}

interface InstanceData {
  braidVersion: string;
  braidRoot: string;
  pi: PiVersionInfo;
  /** System info: platform, hostname, os type. */
  os: { platform: string; type: string; hostname: string };
  /** Current working directory — separate from braidRoot because
   *  the agent may have `cd`'d into a subproject. */
  cwd: string;
  /** Current ISO datetime, captured at section render. */
  now: string;
  /** Session state from `agent-environment/gatherL1Environment()`. */
  session: L1EnvironmentData;
  /** Top-level pi extension packages, ordered by discovery priority. */
  topLevelExtensions: TopLevelExtension[];
  skillCount: number;
  memoryCount: number;
}

export async function instanceSection(
  _pi: ExtensionAPI,
  ctx: ExtensionContext,
  instanceCtx: InstanceContext,
): Promise<PromptSection> {
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
  const data: InstanceData = {
    braidVersion: braid.version,
    braidRoot: braid.root,
    pi,
    os: osInfo,
    cwd: process.cwd(),
    now: new Date().toISOString(),
    session,
    topLevelExtensions,
    skillCount: instanceCtx.skillCount,
    memoryCount: instanceCtx.memoryCount,
  };
  return {
    name: "instance",
    render: () => renderInstance(data),
  };
}

// ── Renderer ────────────────────────────────────────────────────────────────

function renderInstance(d: InstanceData): string {
  const lines: string[] = [];
  lines.push("## Instance");
  lines.push(
    `Agent: Braid v${d.braidVersion} (over pi-core v${d.pi.version})`,
  );

  // Env: root, cwd, os, hostname, now, pid. All at the top.
  lines.push(`Root: ${d.braidRoot}`);
  if (d.cwd !== d.braidRoot) {
    lines.push(`Cwd: ${d.cwd}`);
  }
  lines.push(`OS: ${d.os.platform} (${d.os.type}) hostname=${d.os.hostname}`);
  lines.push(`Now: ${d.now}`);
  lines.push(`PID: ${d.session.pid}`);

  // Session: elapsed, last event, turns, tool avg.
  lines.push(
    `Session: ${formatMs(d.session.sessionElapsedMs)} elapsed, last event ${formatMs(d.session.sinceLastEventMs)} ago, ${d.session.turnCount} turn${d.session.turnCount === 1 ? "" : "s"}`,
  );
  if (d.session.avgToolTimeMs > 0) {
    lines.push(`Tool avg: ${d.session.avgToolTimeMs}ms`);
  }

  // Top-level pi extensions (the user's preferred style: concise
  // summary of pi extension packages with load-source tags, NOT
  // braid's internal module tree).
  if (d.topLevelExtensions.length > 0) {
    lines.push("");
    lines.push(
      `Pi extensions (${d.topLevelExtensions.length} loaded):`,
    );
    for (const ext of d.topLevelExtensions) {
      const tag = sourceTag(ext.source);
      const rel = relativeToCwd(ext.root, d.cwd);
      lines.push(`  ${ext.name} v${ext.version}  ${rel}  (${tag})`);
    }
  }

  // Aggregate counts
  const counts: string[] = [];
  if (d.skillCount > 0) counts.push(`${d.skillCount} skill${d.skillCount === 1 ? "" : "s"}`);
  if (d.memoryCount > 0) counts.push(`${d.memoryCount} memor${d.memoryCount === 1 ? "y" : "ies"}`);
  if (counts.length > 0) {
    lines.push("");
    lines.push(`Resources: ${counts.join(", ")}`);
  }

  // Discovery hint: read source on demand. One line at the end is
  // enough — the system prompt is not a directory listing.
  lines.push("");
  lines.push(
    "→ Discover: `read` any path above (e.g. `read <extension-root>/index.ts`) to inspect an extension's source.",
  );

  return lines.join("\n");
}

function sourceTag(s: TopLevelExtension["source"]): string {
  switch (s) {
    case "cwd":
      return "cwd";
    case "sibling":
      return "sibling-repo";
    case "user-global":
      return "user-global";
    case "npm":
      return "npm";
  }
}

/**
 * Render a path relative to cwd when possible, else absolute.
 * Keeps the Instance block readable when extensions live next to
 * the cwd project (the common case).
 */
function relativeToCwd(p: string, cwd: string): string {
  if (p === cwd) return ".";
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