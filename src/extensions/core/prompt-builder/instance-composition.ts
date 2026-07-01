/**
 * Instance Composition section for the prompt-builder.
 *
 * Renders a concise, consolidated "## Instance" block at the very
 * top of the system prompt. Surfaces:
 *   - Agent identity + the actually-running pi-core version
 *   - Runtime environment: pi-core root (npm package folder), cwd,
 *     userland settings dir (~/.pi/agent), os/hostname/now/pid
 *   - Session: id + elapsed + last-event + turn count + tool avg
 *   - Top-level pi extension PACKAGES read from pi-core's settings
 *     `packages` field (the real runtime configuration), tagged
 *     `project` or `user-global` by scope
 *   - Aggregate counts (total skills, memory entries)
 *   - A generic discovery hint pointing at the read tool
 *
 * This is the agent's at-a-glance view of "what is loaded and
 * where it came from." Three corrections since v3.7:
 *
 *   1. Root points at the pi-core npm package folder (where the
 *      agent is hosted), not at braid's source. The v3.7 wording
 *      used braidRoot, which leaked the development cwd into the
 *      prompt and made "Root" mean the wrong thing for anyone
 *      using pi without braid.
 *
 *   2. Cwd is now always rendered as its own line. Previously it
 *      was suppressed when equal to braidRoot, which hid the
 *      agent's actual working directory from any agent running
 *      from a project subdir.
 *
 *   3. Top-level extension discovery now reads the `packages`
 *      field from pi-core's settings files (the actual runtime
 *      configuration), instead of scanning cwd/sibling directories.
 *      The old sibling-walk over-discovered unrelated packages
 *      (e.g. `@saibolla/ada` showed up just because it was a
 *      sibling repo with a `pi` field) and under-discovered npm
 *      packages + skill packs that the user had actually configured.
 *      Source tags now distinguish `project` (cwd/.pi/settings.json)
 *      from `user-global` (~/.pi/agent/settings.json), matching
 *      pi-core's own precedence model.
 *
 * Pi-core version discovery was rewritten in v3.7 to use the
 * actually-running pi binary (resolved via PATH walk + `which pi`
 * fallback) rather than walking up from braid's `import.meta.url`.
 * The old walk could find braid's local node_modules (often an
 * outdated version) before the global installation that actually
 * runs.
 */

import { execSync } from "node:child_process";
import { readFileSync, existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as os from "node:os";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
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
  /** Session id (pi-core session manager). The agent uses this
   *  to read the raw session file or invoke the session-recall
   *  tool. Format: short hex id or UUID. */
  sessionId: string;
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
    pi,
    settingsDir: getAgentDir(),
    os: osInfo,
    cwd: process.cwd(),
    now: new Date().toISOString(),
    sessionId: ctx.sessionManager?.getSessionId() ?? "",
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

  // Runtime locations. Each is a distinct concept:
  //   - Root:   the pi-core npm package folder (where the agent is hosted).
  //   - Cwd:    where the user invoked `pi` from (their project).
  //   - Settings: the userland pi settings dir (settings.json, skills, memory,
  //             sessions). Override via PI_CODING_AGENT_DIR.
  lines.push(`Root: ${d.pi.root || "(unknown)"}`);
  lines.push(`Cwd: ${d.cwd}`);
  lines.push(`Settings: ${d.settingsDir}`);

  // OS + now + pid -- environment snapshot.
  lines.push(`OS: ${d.os.platform} (${d.os.type}) hostname=${d.os.hostname}`);
  lines.push(`Now: ${d.now}`);
  lines.push(`PID: ${d.session.pid}`);

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
    lines.push(
      `Pi extensions (${d.topLevelExtensions.length} loaded):`,
    );
    for (const ext of d.topLevelExtensions) {
      const tag = ext.source;
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

  // Discovery hint: the prompt is not a directory listing. Every path
  // above is `read`-able on demand; tools reach the wider runtime
  // (~/.pi/agent, <pi-core>/docs, sibling repos via the file system).
  lines.push("");
  lines.push(
    "Discover on demand: `read` any path above to inspect its source; the file tools (`bash`, `grep`, `find`, `ls`) reach the wider runtime including ~/.pi/agent and the pi-core package.",
  );

  return lines.join("\n");
}

function sourceTag(s: TopLevelExtension["source"]): string {
  // Retained as a single point of source-tag normalization in case
  // future discovery emits more granular tags (e.g. `npm` vs
  // `local-path` within `user-global`). Currently a no-op pass-through.
  return s;
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
