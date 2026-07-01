/**
 * Top-level pi extension discovery.
 *
 * Discovers pi extension PACKAGES (directories with a package.json
 * that declares a `pi` field) by reading the configured `packages`
 * field of pi-core's settings files. This is the source of truth
 * for what is actually loaded at runtime -- NOT a directory walk
 * over cwd/siblings (which over-discovered unrelated packages like
 * sibling repos that happen to have `pi` in their package.json).
 *
 * Discovery sources (in pi-core's own precedence order):
 *
 *   1. Project settings  `<cwd>/.pi/settings.json`  (`packages` field)
 *   2. User settings     `~/.pi/agent/settings.json` (`packages` field)
 *
 * Project scope wins over user scope for the same package identity
 * (matches pi-core's `DefaultPackageManager.resolve()` behavior).
 *
 * Each `packages` entry can be either:
 *
 *   - An absolute local path (e.g. a development checkout).
 *     Resolved by reading `<path>/package.json` and inspecting the
 *     `pi` field for declared extension / skill / prompt entries.
 *
 *   - An npm source, prefixed `npm:`, e.g. `npm:pi-smart-fetch`.
 *     Resolved by walking npm-global node_modules (via `npm root -g`)
 *     and checking each scope directory for a matching package.
 *
 *   - A git source, e.g. `git:github.com/user/repo`. Out of scope
 *     for this discoverer -- if the package's runtime path is
 *     discoverable via the same `npm`/`local` logic after install,
 *     it surfaces; otherwise it is silently skipped (consistent
 *     with the "best-effort, no failure surface" policy).
 *
 * Each successfully resolved package is tagged with the scope that
 * loaded it: `project` or `user-global`. Both are real runtime
 * configuration sources; the tag tells the agent which settings file
 * owns the entry so it can edit the right one.
 *
 * Discovery is best-effort: an unreadable or missing package is
 * silently skipped. The agent's prompt should never carry
 * "failed to resolve /foo" noise.
 */

import { execSync } from "node:child_process";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";

export type LoadSource = "project" | "user-global";

export interface TopLevelExtension {
  /** Package name from package.json. */
  name: string;
  /** Package version from package.json. */
  version: string;
  /** Absolute path to the package root directory. */
  root: string;
  /** Which settings scope owns this entry (project or user-global). */
  source: LoadSource;
  /** Extension entry points declared in `pi.extensions` or `pi.extension`. */
  entries: string[];
}

interface PackageJson {
  name?: string;
  version?: string;
  pi?: {
    extensions?: string[];
    extension?: string;
    skills?: string[];
    prompts?: string[];
  };
}

interface SettingsFile {
  packages?: Array<string | { source: string }>;
}

interface ResolvedPackage {
  pkg: TopLevelExtension;
  source: LoadSource;
}

// ── Settings-file readers ──────────────────────────────────────────────────

/**
 * Read and parse a JSON settings file. Returns an empty object on
 * any failure (missing, unreadable, malformed) -- settings reads
 * are best-effort, never throw into the prompt builder.
 */
function readSettings(filePath: string): SettingsFile {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as SettingsFile;
  } catch {
    return {};
  }
}

/**
 * Read a settings file at `path` and return each `packages` entry's
 * source string. Tolerates both string and object entry shapes
 * (`"npm:foo"` and `{ source: "npm:foo", ... }`).
 */
function readPackageEntries(
  filePath: string,
): Array<{ source: string }> {
  const settings = readSettings(filePath);
  const out: Array<{ source: string }> = [];
  for (const entry of settings.packages ?? []) {
    if (typeof entry === "string") {
      out.push({ source: entry });
    } else if (entry && typeof entry.source === "string") {
      out.push({ source: entry.source });
    }
  }
  return out;
}

// ── Single-package resolution ──────────────────────────────────────────────

/**
 * Read package.json from `dir` and return a TopLevelExtension if it
 * declares ANY `pi` field. Returns null for directories that are
 * not pi packages (e.g. a plain node_modules dep with no `pi`
 * field).
 *
 * We accept any pi-resource declaration -- extensions, skills,
 * prompts, or themes -- because all four are equally "what the user
 * configured pi to load". Filtering to only extension providers
 * would hide pure skill packs (e.g. `pi-braid-skills`) from the
 * prompt even though they ship real, loadable runtime content.
 */
function readPiPackage(
  dir: string,
  source: LoadSource,
): TopLevelExtension | null {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return null;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
    if (!pkg.pi) return null;
    // Require at least one pi-resource declaration. A package.json
    // with `pi: {}` is structurally present but provides nothing.
    const hasExtension =
      (Array.isArray(pkg.pi.extensions) && pkg.pi.extensions.length > 0) ||
      typeof pkg.pi.extension === "string";
    const hasSkill =
      Array.isArray(pkg.pi.skills) && pkg.pi.skills.length > 0;
    const hasPrompt =
      Array.isArray(pkg.pi.prompts) && pkg.pi.prompts.length > 0;
    if (!hasExtension && !hasSkill && !hasPrompt) return null;

    const entries: string[] = [];
    if (Array.isArray(pkg.pi.extensions)) entries.push(...pkg.pi.extensions);
    if (typeof pkg.pi.extension === "string") entries.push(pkg.pi.extension);

    return {
      name: pkg.name ?? basename(dir),
      version: pkg.version ?? "unknown",
      root: resolve(dir),
      source,
      entries,
    };
  } catch {
    return null;
  }
}

/** Last path segment, ignoring trailing slashes. */
function basename(p: string): string {
  const parts = p.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? p;
}

/**
 * Resolve a single `packages` entry source string to a directory
 * containing a valid pi-extension package. Returns null if the
 * source is unsupported or cannot be located on disk.
 *
 * Supported shapes:
 *   - `npm:<spec>` (e.g. `npm:pi-smart-fetch`) -- looks in the global
 *     npm root (`npm root -g`), under each scoped directory.
 *   - absolute local path (starts with `/`) -- used as-is.
 *   - relative local path -- resolved relative to `cwd`.
 */
function resolveEntryToPackage(
  source: string,
  scope: LoadSource,
  cwd: string,
): TopLevelExtension | null {
  const trimmed = source.trim();
  if (!trimmed) return null;

  // npm:<spec> -- find in global node_modules.
  if (trimmed.startsWith("npm:")) {
    const spec = trimmed.slice("npm:".length).trim();
    const at = spec.lastIndexOf("@");
    // Specs of the form `@scope/name` have the version boundary at
    // the SECOND `@`; the first `@` is part of the scope. We only
    // strip a trailing `@version` if it parses as semver-ish.
    let name = spec;
    let version: string | undefined;
    if (at > 0 && at < spec.length - 1 && /[\d.]/.test(spec[at + 1])) {
      name = spec.slice(0, at);
      version = spec.slice(at + 1);
    }
    if (!name) return null;
    const installedDir = findNpmPackageDir(name, version);
    if (!installedDir) return null;
    return readPiPackage(installedDir, scope);
  }

  // Local path: absolute or relative-to-cwd.
  const localPath =
    trimmed.startsWith("/") || trimmed.startsWith("~")
      ? expandHome(trimmed)
      : resolve(cwd, trimmed);
  if (!existsSync(localPath)) return null;
  let isDir = false;
  try {
    isDir = statSync(localPath).isDirectory();
  } catch {
    return null;
  }
  if (!isDir) return null;
  return readPiPackage(localPath, scope);
}

/** Minimal `~` expansion (no env-var interpolation beyond $HOME). */
function expandHome(p: string): string {
  if (p === "~") return process.env.HOME ?? p;
  if (p.startsWith("~/")) {
    return join(process.env.HOME ?? "", p.slice(2));
  }
  return p;
}

/**
 * Locate a globally-installed npm package by name. Walks the
 * scope directories under the global npm root (`npm root -g`).
 * Optional `version` filters to a directory whose `package.json`
 * version matches; if absent, the first matching directory wins.
 *
 * Returns the absolute directory path, or null if not found.
 */
function findNpmPackageDir(
  name: string,
  version: string | undefined,
): string | null {
  const globalRoot = getGlobalNpmRoot();
  if (!globalRoot) return null;
  if (!existsSync(globalRoot)) return null;

  // Scoped package: @scope/name -> look under globalRoot/@scope/name.
  if (name.startsWith("@")) {
    const dir = join(globalRoot, name);
    return packageDirMatches(dir, version) ? dir : null;
  }

  // Unscoped: scan globalRoot itself for a directory whose
  // package.json `name` matches. npm installs both flat (legacy)
  // and nested layouts.
  let entries: string[];
  try {
    entries = readdirSync(globalRoot);
  } catch {
    return null;
  }
  for (const entry of entries) {
    const dir = join(globalRoot, entry);
    let isDir = false;
    try {
      isDir = statSync(dir).isDirectory();
    } catch {
      continue;
    }
    if (!isDir) continue;
    if (packageDirMatches(dir, version, name)) return dir;
  }
  return null;
}

/**
 * Does the directory at `dir` look like the package we want?
 * - If `expectedName` is given, the package.json's `name` field
 *   must match (used for unscoped lookup where the directory name
 *   may differ from the package name).
 * - If `expectedVersion` is given, the package.json's `version`
 *   field must match exactly.
 * - Otherwise, just require a package.json to exist.
 */
function packageDirMatches(
  dir: string,
  expectedVersion?: string,
  expectedName?: string,
): boolean {
  const pkgPath = join(dir, "package.json");
  if (!existsSync(pkgPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as PackageJson;
    if (expectedName && pkg.name !== expectedName) return false;
    if (expectedVersion && pkg.version !== expectedVersion) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve the global npm root via `npm root -g`. Returns null if
 * the command fails or produces no output. Cached after first
 * successful call so the (slow) `npm root -g` invocation runs at
 * most once per process -- the value never changes inside one
 * pi session.
 *
 * Implemented as an IIFE-wrapped closure so the cache `let`
 * stays function-scoped (the project's no-module-level-let
 * policy keeps top-level `let` out of every file except the
 * documented exceptions in `src/lib/state/`).
 */
const getGlobalNpmRoot = ((): (() => string | null) => {
  let cached: string | null | undefined;
  return () => {
    if (cached !== undefined) return cached;
    try {
      const out = execSync("npm root -g 2>/dev/null || true", {
        encoding: "utf8",
        timeout: 5000,
      }).trim();
      cached = out || null;
    } catch {
      cached = null;
    }
    return cached;
  };
})();

// ── Main discovery ─────────────────────────────────────────────────────────

/**
 * Discover top-level pi extension packages from pi-core's settings.
 *
 * Walks both settings scopes (project, then user-global) in pi's
 * own precedence order, dedupes by absolute root path (project
 * wins over user-global on collision), and returns the resolved
 * packages. Unresolved entries are silently skipped -- a missing
 * package should never surface as "unknown" in the prompt.
 *
 * Settings-file paths:
 *   - project: `<cwd>/.pi/settings.json`
 *   - user-global: read from `PI_CODING_AGENT_DIR` env override,
 *     falling back to `~/.pi/agent/settings.json`.
 */
export function discoverTopLevelExtensions(
  cwd: string = process.cwd(),
  options?: {
    projectSettingsPath?: string;
    userSettingsPath?: string;
  },
): TopLevelExtension[] {
  const projectPath =
    options?.projectSettingsPath ?? join(cwd, ".pi", "settings.json");
  const userPath =
    options?.userSettingsPath ??
    process.env.PI_CODING_AGENT_DIR ??
    join(process.env.HOME ?? "~", ".pi", "agent", "settings.json");

  const seen = new Set<string>();
  const out: ResolvedPackage[] = [];
  const add = (pkg: TopLevelExtension | null, source: LoadSource) => {
    if (!pkg) return;
    if (seen.has(pkg.root)) return;
    seen.add(pkg.root);
    out.push({ pkg, source });
  };

  // Project scope first (matches pi-core's precedence).
  for (const entry of readPackageEntries(projectPath)) {
    add(resolveEntryToPackage(entry.source, "project", cwd), "project");
  }
  // User-global scope.
  for (const entry of readPackageEntries(userPath)) {
    add(resolveEntryToPackage(entry.source, "user-global", cwd), "user-global");
  }

  // Sort within each scope by name for stable output.
  out.sort((a, b) => a.pkg.name.localeCompare(b.pkg.name));

  return out.map((r) => r.pkg);
}