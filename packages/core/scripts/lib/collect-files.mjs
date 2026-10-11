/**
 * Recursive file walker shared by the repo check scripts.
 *
 * Five check scripts used to carry their own copy with drifted skip sets and
 * signatures; the drift meant two gates could disagree about which files they
 * were looking at. Callers pass their own predicate (and, for the marker gate,
 * an extra directory to exclude) so every checker walks the same tree.
 */

import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** Directories never walked: dependencies, build output, VCS metadata. */
export const DEFAULT_SKIP_DIRS = new Set(["node_modules", "dist", ".git"]);

/**
 * Collect files under `dir` for which `predicate(fullPath)` is true.
 *
 * - Directories named in `skipDirs` (default DEFAULT_SKIP_DIRS) are not walked.
 * - Entries whose name starts with "." are skipped unless `skipDot: false`.
 * - Unreadable directories and dangling entries are skipped, not fatal: a
 *   gate that dies on one unreadable path reports less than it checked.
 */
export function collectFiles(dir, predicate = () => true, options = {}) {
  const skipDirs = options.skipDirs ?? DEFAULT_SKIP_DIRS;
  const skipDot = options.skipDot ?? true;
  const out = [];
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (skipDot && name.startsWith(".")) continue;
    if (skipDirs.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) out.push(...collectFiles(full, predicate, options));
    else if (predicate(full)) out.push(full);
  }
  return out;
}
