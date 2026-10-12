// state-paths.ts — the directories this package's state files live in.
//
// Providers state lives in two pi-owned trees and nowhere else:
//
//   - pi's agent directory (the directory pi keeps settings.json in):
//     `.key-ring-state-<name>.json`, `.provider-route-state.json`,
//     `.provider-outage-notify.json`
//   - pi's agent directory plus braid's own root, for the braid tree braid
//     core owns: `<braid root>/offload/presend/<stamp>-<n>-<model>.txt`
//
// Both used to be re-derived per file, and the agent-directory form ended in
// `process.env.HOME || process.env.USERPROFILE || "."`: with neither variable
// set, that last leg made a state file relative to the cwd, so a provider
// could write into a stranger's project. There is no relative leg any more. A
// base that cannot be derived absolutely is reported as null, and the caller
// refuses to write and warns instead of writing somewhere unowned.
//
// The resolutions are mirrored, not imported: packages/providers is a
// standalone package with no pi-braid (or pi-core) dependency, so core's
// braidDir() is reproduced here field for field. Keep the two in step.

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

/**
 * `<home>/.pi/agent` — the directory pi keeps its own state in, derived from
 * os.homedir() (`$HOME`, else the passwd entry). `null` when no absolute home
 * can be resolved: callers must then refuse to write, never fall back to a
 * relative path.
 */
export function homedirAgentDir(): string | null {
  let home: string;
  try {
    home = homedir();
  } catch {
    return null;
  }
  if (!home || !isAbsolute(home)) return null;
  return join(home, ".pi", "agent");
}

/**
 * pi's agent directory as pi itself resolves it: `PI_CODING_AGENT_DIR` when it
 * is set to an absolute path (a relative override names no pi directory, so it
 * is refused rather than resolved against the cwd), otherwise
 * `homedirAgentDir()`.
 */
export function piAgentDir(): string | null {
  const override = process.env.PI_CODING_AGENT_DIR;
  if (override && override.trim()) {
    const trimmed = override.trim();
    return isAbsolute(trimmed) ? trimmed : null;
  }
  return homedirAgentDir();
}

/**
 * Braid's data root, mirroring core's braidDir() in
 * packages/core/src/lib/config/braid-paths.ts: `BRAID_HOME` when it is pinned
 * to a non-blank value (path.resolve()d, exactly as core resolves it), else
 * the default tree under the pi agent dir. With BRAID_HOME unset this is the
 * directory core resolves, so a file this package reports and the file core
 * wrote cannot come from two different roots. One bound worth stating: core's
 * fallback leg is a module-load constant and this one resolves per call, so if
 * a process reassigns HOME after both modules are loaded, core keeps the
 * original home and this follows the new one (this resolution is the more
 * faithful one to pi, whose own getAgentDir() reads the environment per call).
 */
export function braidDataRoot(): string {
  const override = process.env.BRAID_HOME;
  if (override && override.trim()) return resolve(override);
  return join(homedir(), ".pi", "agent", "braid");
}
