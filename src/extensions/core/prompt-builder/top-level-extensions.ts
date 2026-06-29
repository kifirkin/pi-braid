/**
 * Top-level pi extension discovery.
 *
 * Discovers pi extension PACKAGES (i.e. directories with a
 * package.json that has a "pi" field declaring extension entry
 * points). This is pi-core TUI style: a concise summary of "what
 * pi extensions are loaded and where they came from" — not the
 * internal module tree of one specific package.
 *
 * Discovery sources, in priority order:
 *
 *   1. Cwd package — the package the agent was launched from
 *      (the "primary" extension, usually pi-braid itself).
 *   2. Sibling packages — directories adjacent to cwd that have
 *      a "pi" field in package.json (e.g. ./pi-braid-contrib).
 *   3. User-global — `~/.pi/agent/extensions/*` (per-user
 *      installed extensions, loaded from anywhere).
 *   4. npm — `node_modules/<scope>/<pkg>` whose package.json
 *      declares "pi" (third-party via package manager).
 *
 * Each discovered package is classified with a load-source tag so
 * the Instance block can render e.g. "sibling-repo" vs "npm" vs
 * "user-global". This is the "where it came from" affordance the
 * user asked for: agents can grep `~/.pi/agent/extensions/` for
 * user-global, walk up `../<sibling>` for sibling-repo, etc.
 *
 * Discovery is best-effort: a missing or unreadable directory is
 * silently skipped (the agent should not see "failed to scan
 * /foo" in its system prompt).
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";

export type LoadSource =
  | "cwd" // package.json in cwd itself
  | "sibling" // sibling directory of cwd
  | "user-global" // ~/.pi/agent/extensions/<pkg>/
  | "npm"; // node_modules/<scope>/<pkg>

export interface TopLevelExtension {
  /** Package name from package.json. */
  name: string;
  /** Package version from package.json. */
  version: string;
  /** Absolute path to the package root directory. */
  root: string;
  /** How this package was loaded (where it was found). */
  source: LoadSource;
  /** Extension entry points declared in "pi.extensions" or "pi.extension". */
  entries: string[];
}

interface PackageJson {
  name?: string;
  version?: string;
  pi?: {
    extensions?: string[];
    extension?: string;
  };
}

/**
 * Read package.json from a directory and return null if it is not
 * a valid pi-extension package.
 */
function readPiPackage(dir: string): TopLevelExtension | null {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
    const pi = pkg.pi;
    if (!pi) return null;
    const entries: string[] = [];
    if (Array.isArray(pi.extensions)) entries.push(...pi.extensions);
    if (typeof pi.extension === "string") entries.push(pi.extension);
    if (entries.length === 0) return null;
    return {
      name: pkg.name ?? basename(dir),
      version: pkg.version ?? "unknown",
      root: resolve(dir),
      source: "cwd", // overwritten by caller
      entries,
    };
  } catch {
    return null;
  }
}

/** Last path segment (handles trailing slashes). */
function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/** Scan a directory one level deep for subdirs that have "pi" in package.json. */
function scanDirForPiPackages(dir: string): TopLevelExtension[] {
  if (!existsSync(dir)) return [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return [];
  }
  const found: TopLevelExtension[] = [];
  for (const name of entries) {
    const sub = join(dir, name);
    let isDir = false;
    try {
      isDir = statSync(sub).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    const pkg = readPiPackage(sub);
    if (pkg) found.push(pkg);
  }
  return found;
}

/**
 * Discover top-level pi extension packages.
 *
 * Returns the primary (cwd) package first, then siblings sorted
 * alphabetically, then user-global sorted alphabetically, then
 * npm packages sorted alphabetically. Deduplicates by absolute
 * root path so a symlinked sibling + cwd does not appear twice.
 */
export function discoverTopLevelExtensions(
  cwd: string = process.cwd(),
): TopLevelExtension[] {
  const seen = new Set<string>();
  const out: TopLevelExtension[] = [];

  const add = (pkg: TopLevelExtension | null, source: LoadSource) => {
    if (!pkg) return;
    if (seen.has(pkg.root)) return;
    seen.add(pkg.root);
    out.push({ ...pkg, source });
  };

  // 1. Cwd package (the primary extension).
  const cwdPkg = readPiPackage(cwd);
  add(cwdPkg, "cwd");

  // 2. Sibling packages — directories adjacent to cwd.
  const parent = dirname(cwd);
  if (parent && parent !== cwd) {
    const siblings = scanDirForPiPackages(parent);
    for (const sib of siblings) add(sib, "sibling");
  }

  // 3. User-global extensions.
  const globalDir = join(homedir(), ".pi", "agent", "extensions");
  const globals = scanDirForPiPackages(globalDir);
  for (const g of globals) add(g, "user-global");

  // 4. npm — walk node_modules/<scope>/ for pi-* packages.
  const nm = join(cwd, "node_modules");
  if (existsSync(nm)) {
    let scopes: string[];
    try {
      scopes = readdirSync(nm).filter((s) => s.startsWith("@"));
    } catch {
      scopes = [];
    }
    for (const scope of scopes) {
      const scopeDir = join(nm, scope);
      let isDir = false;
      try {
        isDir = statSync(scopeDir).isDirectory();
      } catch {
        continue;
      }
      if (!isDir) continue;
      const pkgs = scanDirForPiPackages(scopeDir);
      for (const p of pkgs) add(p, "npm");
    }
  }

  return out;
}