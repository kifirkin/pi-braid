#!/usr/bin/env node
/**
 * check-release-content.mjs — a published version's content is frozen.
 *
 * The publish loop asks the registry whether a version exists and, when it
 * does, skips it. That is correct for the version string and wrong for the
 * content: a workspace can carry a changed file under a version string that is
 * already on the registry, the loop skips it, and the change is never
 * published. Nothing in the tree recorded what a version *was*, so no check
 * could notice. This tool is that record and the gate over it.
 *
 * The record is `release-ledger.json` at the repository root: one entry per
 * published `name@version`, holding the sha256 of every file the tarball
 * carries. `--record` writes it at release time; the default mode refuses when
 * the pack of a recorded version no longer matches its entry; and
 * `--verify-published` holds the registry's own artifact to the same entries,
 * which is the comparison that covers a version the release tag never names.
 *
 * Why per-file digests and not the tarball digest. A tarball digest cannot be
 * the durable record, and this was measured, not assumed: two packs of one
 * tree differ, because every workspace's `prepack` writes the provenance
 * record with the wall clock, the branch and the machine's short sha. A
 * `pi-braid-contrib` pack taken during a release and the same version's
 * registry artifact differ in exactly those fields of `build-info.json` and in
 * nothing else; a `pi-braid` pack agrees with its registry artifact on all
 * 1068 files apart from the same fields. So a raw digest would refuse on the
 * recorder's branch name, and an equality with `dist.integrity` would compare
 * the machine that packed rather than the tree that shipped. Comparing what
 * each packed file holds, in process, removes the whole class.
 *
 * The provenance record is excluded, by name, because it is the file whose
 * content is the packer's environment. Everything else is compared literally,
 * including `package.json` and, for a package that builds, its `dist/`. What
 * that leaves is the claim the ledger makes: these files, with these contents,
 * ship under this version.
 *
 * Modes:
 *   (default, or --check)  refuse when a recorded version's content changed
 *                          --require-recorded: a missing entry is a refusal
 *   --record               add an entry for every version not yet recorded
 *                          --seed-from-registry: record published content
 *   --verify-published     compare each recorded version's registry artifact
 *
 * Where the content of a recorded version comes from. A release records the
 * tree it is about to publish, because that is what the artifact will contain.
 * A version that is already on the registry can only be recorded from the
 * registry, since the tree pack of that version string is content nobody can
 * install; `--seed-from-registry` is that path, and every entry says which
 * source answered (`source: "tree"` or `"registry"`), so a seeded entry cannot
 * pass for a release-time one. The last two modes are the release workflow's:
 * it seeds once over the versions that shipped before the ledger existed, then
 * records each new version from the tree at release time.
 *
 * Where it runs, and why not on every commit. The comparison is scoped to the
 * release boundary - the publish workflow runs `--check` for each package it is
 * about to publish, and `--verify-published` after publishing - because a
 * recorded version's content legitimately moves between releases: measured over
 * the sixty commits before this file was written, twenty-one commits that
 * changed a package's shipped content carried no version bump. A gate in the
 * per-commit chain would therefore be red on ordinary work, and a gate that is
 * red on ordinary work is switched off within the week. What still runs on
 * every commit is this tool's own test, so the comparison is exercised on every
 * commit while the verdict it reaches is reserved for a release.
 *
 * The name says `release:` and not `check:` for the same reason: `check:*` is
 * the chain's namespace, and `check-ci-chain.mjs` holds every entry in it to a
 * command that runs on every commit, with no escape hatch for a gate that can
 * fail (its advisory exemption requires `--no-exit-code`).
 *
 * Exit codes, and the line between the last two is the point of the tool:
 *   0  every recorded version still packs to its recorded content, or is not
 *      recorded yet
 *   1  a recorded version's content changed, or the registry serves an artifact
 *      that differs from the ledger, or serves a version the ledger never
 *      recorded
 *   2  the question could not be answered: a pack failed, a tarball could not
 *      be read, the ledger is unreadable. Never reported as either verdict.
 *
 * `--record` refuses rather than rewrites. An entry that no longer matches the
 * tree means the version is not what was released, and rewriting the entry
 * would launder exactly the failure this tool exists to catch: the remedy is a
 * version bump, which creates a new key and leaves the old one as history.
 *
 * A prerelease version (`1.2.3-next.4`) is never published by the release
 * workflow, so it has no content on the registry to protect and is skipped.
 * Recording one would demand a new entry on every iteration commit.
 *
 * Usage: node packages/core/scripts/check-release-content.mjs [mode] [options]
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BUILD_INFO_FILE, SHA_SHORT_LENGTH } from "./build-info.mjs";
import { readArchive, Unreadable } from "./lib/tar-entries.mjs";

const LEDGER_FILE = "release-ledger.json";

/** The ledger format this tool writes and the only one it reads. */
const LEDGER_FORMAT = 1;

/** How many differing paths a refusal lists before counting the rest. */
const MAX_LISTED = 20;

/** npm's own directory inside every tarball it packs. */
const PACK_ROOT = "package/";

const DEFAULT_REGISTRY = "https://registry.npmjs.org";

const MODES = ["check", "record", "verify-published"];

const USAGE = `usage: node packages/core/scripts/check-release-content.mjs [mode] [options]

  --check             (default) refuse when a recorded version's content changed
  --require-recorded  with --check: a version with no entry is a refusal
  --record            record every version the ledger does not hold yet
  --seed-from-registry
                      with --record: take each version's content from the
                      registry, for versions published before this ledger
  --verify-published  compare the registry's artifacts against the ledger
  --workspace <dir>   only the workspace under packages/<dir> (repeatable)
  --root <dir>        the repository to read (default: this git work tree)
  --ledger <file>     the ledger to read and write (default: <root>/${LEDGER_FILE})
  --registry <url>    the registry to read (default: ${DEFAULT_REGISTRY})`;

/** A question this tool could not answer. Exit 2, never a verdict. */
class Unanswerable extends Error {}

const out = (message) => console.log(message);
const problem = (message) => console.error(message);

/** The last lines of a captured stream, for an error a reader can act on. */
function tail(text, lines = 12) {
  const kept = String(text ?? "")
    .trimEnd()
    .split("\n")
    .slice(-lines);
  return kept.length === 0 ? "(no output)" : kept.join("\n");
}

function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * One digest over a whole content map: the paths in sorted order, each with its
 * own digest. Printed as the single number a reader compares by eye, and
 * derived rather than stored, so a ledger entry cannot hold a total that
 * disagrees with the files it lists.
 */
function digestOf(files) {
  const hash = createHash("sha256");
  for (const path of [...files.keys()].sort()) hash.update(`${path}\u0000${files.get(path)}\n`);
  return `sha256:${hash.digest("hex")}`;
}

// ── the tree ──────────────────────────────────────────────────────────────

/** The git work tree the process runs in, or null outside one. */
function gitRoot() {
  const result = spawnSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
}

/** The commit the tree is at, or null when git cannot answer. */
function gitHead(root) {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  return result.status === 0 && result.stdout.trim() !== "" ? result.stdout.trim() : null;
}

/**
 * Every workspace the release workflow can publish: `packages/<dir>` with a
 * manifest that is not private. Discovered, never listed, so a new package is
 * covered by the existing rules.
 */
function workspaces(root) {
  const packagesDir = join(root, "packages");
  let entries;
  try {
    entries = readdirSync(packagesDir, { withFileTypes: true });
  } catch (error) {
    throw new Unanswerable(`${packagesDir}: cannot be read (${error.code ?? error.message})`);
  }
  const found = [];
  for (const entry of entries.filter((candidate) => candidate.isDirectory()).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const dir = join(packagesDir, entry.name);
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) continue;
    let manifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    } catch (error) {
      throw new Unanswerable(`${manifestPath}: not JSON (${error.message})`);
    }
    if (manifest?.private === true) continue;
    if (typeof manifest?.name !== "string" || typeof manifest?.version !== "string") {
      throw new Unanswerable(`${manifestPath}: no name and version to compare`);
    }
    found.push({ dir, manifestPath, name: manifest.name, version: manifest.version, shortName: entry.name });
  }
  if (found.length === 0) throw new Unanswerable(`${packagesDir}: holds no publishable workspace`);
  return found;
}

// ── the ledger ────────────────────────────────────────────────────────────

/**
 * Read the ledger. A missing file is an empty ledger, which is the state of a
 * repository that has not recorded a release yet: every version is then new,
 * and the default mode says so rather than refusing.
 *
 * A ledger that is present and unreadable is exit 2. Treating a damaged entry
 * as an absent one would clear a version whose content was never compared,
 * which is the failure this file exists to prevent.
 */
function readLedger(file) {
  const entries = new Map();
  if (!existsSync(file)) return { entries };
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    throw new Unanswerable(`${file}: cannot be read (${error.code ?? error.message})`);
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Unanswerable(`${file}: not JSON (${error.message})`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Unanswerable(`${file}: the ledger is not an object`);
  }
  if (parsed.version !== LEDGER_FORMAT) {
    throw new Unanswerable(`${file}: format ${JSON.stringify(parsed.version)} is not the ${LEDGER_FORMAT} this tool writes`);
  }
  if (parsed.entries === null || typeof parsed.entries !== "object" || Array.isArray(parsed.entries)) {
    throw new Unanswerable(`${file}: no entries object`);
  }
  for (const [key, entry] of Object.entries(parsed.entries)) {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Unanswerable(`${file}: entry ${key} is not an object`);
    }
    const map = new Map();
    const files = entry.files;
    if (files === null || typeof files !== "object" || Array.isArray(files)) {
      throw new Unanswerable(`${file}: entry ${key} carries no files map`);
    }
    for (const [path, digest] of Object.entries(files)) {
      if (typeof digest !== "string" || !/^[0-9a-f]{64}$/.test(digest)) {
        throw new Unanswerable(`${file}: entry ${key} path ${path} does not carry a sha256 digest`);
      }
      map.set(path, digest);
    }
    entries.set(key, {
      released_from: typeof entry.released_from === "string" ? entry.released_from : null,
      source: entry.source === "registry" ? "registry" : "tree",
      files: map,
    });
  }
  return { entries };
}

/** The ledger as text: every map in sorted order, so a diff shows the change. */
function serialiseLedger(ledger) {
  const entries = {};
  for (const key of [...ledger.entries.keys()].sort()) {
    const entry = ledger.entries.get(key);
    const files = {};
    for (const path of [...entry.files.keys()].sort()) files[path] = entry.files.get(path);
    entries[key] = { released_from: entry.released_from, source: entry.source, files };
  }
  return `${JSON.stringify({ version: LEDGER_FORMAT, entries }, null, 2)}\n`;
}

// ── packing and reading content ───────────────────────────────────────────

/** The one object `npm pack --json` prints, or null when the output is not it. */
function packReport(stdout) {
  const start = String(stdout ?? "").indexOf("[");
  const end = String(stdout ?? "").lastIndexOf("]");
  if (start < 0 || end < start) return null;
  try {
    const parsed = JSON.parse(String(stdout).slice(start, end + 1));
    return Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object" ? parsed[0] : null;
  } catch {
    return null;
  }
}

/**
 * Pack one workspace the way a release packs it: its own lifecycle, no
 * `--ignore-scripts`. The scripts are the point, since `prepack` is what puts
 * the built output, the staged changelog and the provenance record into the
 * artifact; a pack without them would describe a tree nobody publishes.
 */
function packWorkspace(workspace, into) {
  const result = spawnSync("npm", ["pack", "--json", "--pack-destination", into], {
    cwd: workspace.dir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_loglevel: "error", npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (result.error) {
    throw new Unanswerable(`cannot run npm pack in ${workspace.dir}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Unanswerable(`npm pack failed in ${workspace.dir} (exit ${result.status}):\n${tail(result.stderr || result.stdout)}`);
  }
  const report = packReport(result.stdout);
  if (report === null || typeof report.filename !== "string") {
    throw new Unanswerable(`${workspace.dir}: npm pack printed no tarball name:\n${tail(result.stdout)}`);
  }
  const tarball = join(into, report.filename);
  if (!existsSync(tarball)) {
    throw new Unanswerable(`${workspace.dir}: npm pack named ${report.filename} and wrote no such file`);
  }
  return tarball;
}

/**
 * The registry's artifact for this exact version, or null when the registry
 * does not serve it.
 *
 * Absent and unreadable are kept apart by the rule the publish loop already
 * uses: an absent version is exit 1 together with `E404` in the output, and
 * any other failure is a read that says nothing about the version.
 */
/**
 * What npm's answer means, and the one distinction the verify path depends on.
 *
 * `npm pack name@version` answers a version the registry does not serve with
 * E404 (`npm view`) or ETARGET (`No matching version found for name@version`);
 * which of the two appears depends on the verb and the registry's packument, and
 * a check that knows only E404 reads ETARGET as an unanswerable failure. That is
 * what failed the first release this gate ran on: the version had just been
 * published, npm had not served it yet, and the verify step exited 2 while the
 * publish itself had succeeded.
 */
export function registryReadVerdict(status, said) {
  if (status === 0) return "ok";
  if (status === 1 && (said.includes("E404") || said.includes("ETARGET"))) return "absent";
  return "fail";
}

function fetchPublished(workspace, into, registry) {
  const spec = `${workspace.name}@${workspace.version}`;
  const result = spawnSync("npm", ["pack", spec, "--json", "--pack-destination", into, `--registry=${registry}`], {
    cwd: into,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, npm_config_loglevel: "error", npm_config_audit: "false", npm_config_fund: "false" },
  });
  if (result.error) throw new Unanswerable(`cannot run npm pack for ${spec}: ${result.error.message}`);
  const said = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const verdict = registryReadVerdict(result.status, said);
  if (verdict === "absent") return null;
  if (verdict === "fail") {
    throw new Unanswerable(`the registry read for ${spec} failed (exit ${result.status}):\n${tail(said)}`);
  }
  const report = packReport(result.stdout);
  if (report === null || typeof report.filename !== "string") {
    throw new Unanswerable(`${spec}: npm pack printed no tarball name:\n${tail(result.stdout)}`);
  }
  const tarball = join(into, report.filename);
  if (!existsSync(tarball)) throw new Unanswerable(`${spec}: npm pack named ${report.filename} and wrote no such file`);
  return tarball;
}

/**
 * The content of a tarball: path inside the package to sha256 of its bytes.
 *
 * The provenance record is the one exclusion, and it is excluded because its
 * fields are the packer's environment rather than the tree (see the header).
 * A link or a directory in a packed workspace is not content this ledger can
 * speak about, so it is refused instead of silently dropped.
 */
function contentOf(tarball) {
  const files = new Map();
  for (const [name, entry] of readArchive(tarball)) {
    if (!name.startsWith(PACK_ROOT)) {
      throw new Unanswerable(`${tarball}: entry ${name} is outside the archive's ${PACK_ROOT} root`);
    }
    const path = name.slice(PACK_ROOT.length);
    if (path === BUILD_INFO_FILE) continue;
    if (entry.kind !== "file") {
      throw new Unanswerable(`${tarball}: ${path} is a ${entry.kind}, which this ledger cannot record`);
    }
    files.set(path, sha256(entry.data));
  }
  if (files.size === 0) throw new Unanswerable(`${tarball}: carries no content to record`);
  return files;
}

/** Where the two content maps disagree, in sorted path order. */
function differences(recorded, packed) {
  const rows = [];
  const paths = [...new Set([...recorded.keys(), ...packed.keys()])].sort();
  for (const path of paths) {
    const before = recorded.get(path);
    const after = packed.get(path);
    if (before === undefined) rows.push({ reason: "added", path });
    else if (after === undefined) rows.push({ reason: "removed", path });
    else if (before !== after) rows.push({ reason: "changed", path });
  }
  return rows;
}

// ── reporting ─────────────────────────────────────────────────────────────

/**
 * Name the workspace, the version, both digests and the paths that moved, then
 * the one action that resolves it. A refusal a reader cannot act on is a wall.
 */
function reportContentRefusal(root, { workspace, key, entry, packed, rows }) {
  const from = entry.released_from === null ? "a tree git could not name" : entry.released_from.slice(0, SHA_SHORT_LENGTH);
  problem(`check-release-content: refusing: ${key} packs to content the ledger does not hold`);
  problem(`  recorded  ${digestOf(entry.files)}  from ${from}`);
  problem(`  packed    ${digestOf(packed)}`);
  for (const row of rows.slice(0, MAX_LISTED)) problem(`  ${row.reason.padEnd(8)} ${row.path}`);
  if (rows.length > MAX_LISTED) problem(`  ... and ${rows.length - MAX_LISTED} more path(s)`);
  problem("  this version is on the registry or may be, so its content cannot change:");
  problem(`  bump the version in ${relative(root, workspace.manifestPath)}, then record the new version:`);
  problem("  npm run release:content:record");
}

// ── modes ─────────────────────────────────────────────────────────────────

/** The ledger's key for a workspace, and whether it is a version we may hold. */
function identity(workspace) {
  return {
    key: `${workspace.name}@${workspace.version}`,
    prerelease: workspace.version.includes("-"),
  };
}

function runCheck(root, ledger, list, work, requireRecorded) {
  const refusals = [];
  const unrecorded = [];
  let compared = 0;
  let recorded = 0;
  let prerelease = 0;

  for (const workspace of list) {
    const { key, prerelease: isPrerelease } = identity(workspace);
    if (isPrerelease) {
      prerelease += 1;
      out(`${key}  prerelease, never published: not compared`);
      continue;
    }
    const entry = ledger.entries.get(key);
    if (entry === undefined) {
      // A release may not publish a version whose content was never recorded:
      // the record has to exist before the artifact does, or nothing can say
      // afterwards what that version contained. Reporting it is the default
      // because a fresh ledger would otherwise refuse every version at once.
      if (requireRecorded) {
        unrecorded.push(key);
        continue;
      }
      recorded += 1;
      out(`${key}  no ledger entry: a new version to publish`);
      continue;
    }
    const packed = contentOf(packWorkspace(workspace, work));
    const rows = differences(entry.files, packed);
    compared += 1;
    if (rows.length === 0) {
      out(`${key}  unchanged  ${digestOf(entry.files)}`);
      continue;
    }
    refusals.push({ workspace, key, entry, packed, rows });
  }

  for (const refusal of refusals) reportContentRefusal(root, refusal);
  if (unrecorded.length > 0) {
    for (const key of unrecorded) {
      problem(`check-release-content: refusing: ${key} has no ledger entry, so its content was never recorded`);
      problem("  a version has to be recorded before it is published, not after:");
      problem("  npm run release:content:record");
    }
    return 1;
  }
  if (refusals.length > 0) return 1;
  out(
    `check-release-content: ${list.length} workspace(s): ${compared} compared, ${recorded} not recorded yet, ${prerelease} prerelease`,
  );
  return 0;
}

/**
 * Record a version's content, from the tree or from the registry.
 *
 * The tree is the right source for a version that has not been published: it
 * is what the release is about to upload. The registry is the only right source
 * for a version that already has been, because that artifact is what users
 * already hold - a tree pack of the same version string would record content
 * nobody can install. `source` on the entry says which answer a reader is
 * looking at, so a seeded entry cannot pass for a release-time one.
 */
function runRecord(root, ledger, list, work, ledgerPath, options) {
  const head = gitHead(root);
  const seeded = options.seedFromRegistry;
  const added = [];
  const refusals = [];
  let unchanged = 0;
  let prerelease = 0;

  for (const workspace of list) {
    const { key, prerelease: isPrerelease } = identity(workspace);
    if (isPrerelease) {
      prerelease += 1;
      out(`${key}  prerelease, never published: not recorded`);
      continue;
    }
    const packed = seeded
      ? contentOf(publishedTarball(workspace, work, options.registry))
      : contentOf(packWorkspace(workspace, work));
    const entry = ledger.entries.get(key);
    if (entry === undefined) {
      ledger.entries.set(key, { released_from: head, source: seeded ? "registry" : "tree", files: packed });
      added.push({ key, digest: digestOf(packed) });
      continue;
    }
    const rows = differences(entry.files, packed);
    if (rows.length === 0) {
      unchanged += 1;
      out(`${key}  already recorded  ${digestOf(entry.files)}`);
      continue;
    }
    refusals.push({ workspace, key, entry, packed, rows });
  }

  // Nothing is written when anything was refused: a partial write would record
  // the versions that happened to pack first and leave the ledger claiming a
  // release that did not happen.
  if (refusals.length > 0) {
    for (const refusal of refusals) reportContentRefusal(root, refusal);
    problem("check-release-content: nothing was recorded");
    return 1;
  }
  if (added.length === 0) {
    out(`check-release-content: the ledger records every current version${prerelease > 0 ? ` (${prerelease} prerelease left alone)` : ""}`);
    return 0;
  }

  writeFileSync(ledgerPath, serialiseLedger(ledger));
  for (const { key, digest } of added) out(`${key}  recorded  ${digest}`);
  out(
    `check-release-content: ${added.length} entr${added.length === 1 ? "y" : "ies"} added to ${relative(root, ledgerPath)}` +
      `${seeded ? ` from ${options.registry}` : " from the tree"}, ${unchanged} already recorded`,
  );
  return 0;
}

/** The registry's artifact for this version, or a refusal naming why there is none. */
function publishedTarball(workspace, work, registry) {
  const tarball = fetchPublished(workspace, work, registry);
  if (tarball === null) unrecordable(workspace);
  return tarball;
}

/** Seeding can only record versions the registry serves; anything else stops the run. */
function unrecordable(workspace) {
  throw new Unanswerable(`${workspace.name}@${workspace.version} is not on the registry, so there is no published content to seed from`);
}

function runVerifyPublished(root, ledger, list, work, registry) {
  const refusals = [];
  let compared = 0;
  let absent = 0;
  let prerelease = 0;

  for (const workspace of list) {
    const { key, prerelease: isPrerelease } = identity(workspace);
    if (isPrerelease) {
      prerelease += 1;
      out(`${key}  prerelease, never published: not compared`);
      continue;
    }
    const entry = ledger.entries.get(key);
    const tarball = fetchPublished(workspace, work, registry);

    // A version the registry serves that the ledger does not hold is the hole
    // the ledger exists to close: the content behind it was never recorded, so
    // nothing can say whether it is what this tree ships.
    if (entry === undefined) {
      if (tarball === null) {
        absent += 1;
        out(`${key}  not on the registry and not recorded: nothing to compare`);
        continue;
      }
      refusals.push({ kind: "unrecorded", key });
      continue;
    }
    if (tarball === null) {
      absent += 1;
      out(`${key}  recorded, not on the registry yet: nothing to compare`);
      continue;
    }

    const files = contentOf(tarball);
    const rows = differences(entry.files, files);
    compared += 1;
    if (rows.length === 0) {
      out(`${key}  registry matches the ledger  ${digestOf(files)}`);
      continue;
    }
    refusals.push({ kind: "differs", workspace, key, entry, packed: files, rows });
  }

  for (const refusal of refusals) {
    if (refusal.kind === "unrecorded") {
      problem(`check-release-content: refusing: ${refusal.key} is on the registry with no ledger entry`);
      problem("  the content behind a published version has to be recorded to be checkable:");
      problem("  npm run release:content:record");
      continue;
    }
    problem(`check-release-content: refusing: the registry serves ${refusal.key} with content the ledger does not hold`);
    problem(`  recorded  ${digestOf(refusal.entry.files)}`);
    problem(`  registry  ${digestOf(refusal.packed)}`);
    for (const row of refusal.rows.slice(0, MAX_LISTED)) problem(`  ${row.reason.padEnd(8)} ${row.path}`);
    if (refusal.rows.length > MAX_LISTED) problem(`  ... and ${refusal.rows.length - MAX_LISTED} more path(s)`);
    problem("  the registry's artifact is not the content this ledger recorded for that version:");
    problem("  a version cannot be replaced, so the difference is published and unchangeable. Open a release that bumps it.");
  }
  if (refusals.length > 0) return 1;
  out(
    `check-release-content: ${list.length} workspace(s): ${compared} compared against ${registry}, ${absent} not published, ${prerelease} prerelease`,
  );
  return 0;
}

// ── the command ────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const options = { mode: null, root: null, ledger: null, registry: DEFAULT_REGISTRY, workspaces: [], requireRecorded: false, seedFromRegistry: false };
  const modes = [];
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--check" || arg === "--record" || arg === "--verify-published") {
      modes.push(arg.slice(2));
      continue;
    }
    if (arg === "--require-recorded") {
      options.requireRecorded = true;
      continue;
    }
    if (arg === "--seed-from-registry") {
      options.seedFromRegistry = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      out(USAGE);
      process.exit(0);
    }
    const value = argv[index + 1];
    if (arg === "--root" || arg === "--ledger" || arg === "--registry" || arg === "--workspace") {
      if (value === undefined || value.startsWith("--")) throw new Unanswerable(`${arg} needs a value\n${USAGE}`);
      if (arg === "--workspace") options.workspaces.push(value);
      else options[arg.slice(2)] = value;
      index += 1;
      continue;
    }
    throw new Unanswerable(`unknown argument "${arg}"\n${USAGE}`);
  }
  if (modes.length > 1) throw new Unanswerable(`one mode per run, got ${modes.join(" and ")}\n${USAGE}`);
  options.mode = modes[0] ?? "check";
  if (!MODES.includes(options.mode)) throw new Unanswerable(`unknown mode "${options.mode}"\n${USAGE}`);
  // Each of the two only means something in one mode, and silently ignoring it
  // in the others would let a run report a policy it never applied.
  if (options.requireRecorded && options.mode !== "check") {
    throw new Unanswerable(`--require-recorded applies to --check only, not --${options.mode}\n${USAGE}`);
  }
  if (options.seedFromRegistry && options.mode !== "record") {
    throw new Unanswerable(`--seed-from-registry applies to --record only, not --${options.mode}\n${USAGE}`);
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));

  const root = options.root === null ? gitRoot() : resolve(options.root);
  if (root === null) throw new Unanswerable(`not inside a git work tree; pass --root <dir>\n${USAGE}`);

  const ledgerPath = options.ledger === null ? join(root, LEDGER_FILE) : resolve(options.ledger);
  const ledger = readLedger(ledgerPath);
  const all = workspaces(root);

  // A release step names the package it is about to publish; a name it cannot
  // resolve is refused rather than skipped, since a filter that silently matched
  // nothing would report a clean run over no workspace at all.
  let list = all;
  if (options.workspaces.length > 0) {
    list = [];
    for (const wanted of options.workspaces) {
      const match = all.find((workspace) => workspace.shortName === wanted);
      if (match === undefined) {
        throw new Unanswerable(`no publishable workspace packages/${wanted} (have: ${all.map((w) => w.shortName).join(", ")})`);
      }
      list.push(match);
    }
  }

  const work = mkdtempSync(join(tmpdir(), "release-content-"));
  try {
    if (options.mode === "record") return runRecord(root, ledger, list, work, ledgerPath, options);
    if (options.mode === "verify-published") return runVerifyPublished(root, ledger, list, work, options.registry);
    return runCheck(root, ledger, list, work, options.requireRecorded);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Run only when this file is the program.
 *
 * The check's pieces are worth testing in-process (`registryReadVerdict` is a
 * pure function over npm's answer), and an import that runs the CLI cannot be
 * tested that way: importing it packed every workspace, `npm pack` ran this
 * package's `prepack`, the prepack rebuilt `dist`, and for the fourteen seconds
 * of that rebuild every fixture in the pooled run that imports `dist` failed
 * with a module-not-found. A module that runs on import breaks the process that
 * imports it.
 */
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    if (error instanceof Unanswerable || error instanceof Unreadable) {
      problem(`check-release-content: ${error.message}`);
      process.exitCode = 2;
    } else {
      throw error;
    }
  }
}
