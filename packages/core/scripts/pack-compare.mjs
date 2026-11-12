#!/usr/bin/env node
/**
 * pack-compare.mjs — two packed artifacts, compared by what they unpack to.
 *
 * A release makes one claim: the registry serves the tree this commit builds.
 * Comparing the two tarballs byte for byte cannot test it, because two packs of
 * one tree differ in gzip framing, entry order and the three fields of the
 * provenance record that describe the machine a pack ran on rather than the
 * tree it packed. Unpacked, they differ in nothing — so the comparison runs on
 * the unpacked content, with those fields replaced before the trees are read.
 *
 * The record's `name`, `version`, `sha` and `dirty` are not among them: they
 * describe the artifact and the commit it was packed from, and a difference in
 * any of those is the difference this tool exists to report.
 *
 * Three outcomes, three exit codes, because the caller acts on the difference:
 *
 *   0  the trees are identical apart from the provenance fields a pack writes
 *      from its environment
 *   1  something else differs; the differing paths are printed, bounded
 *   2  the comparison could not be made: an argument is not a path, a file is
 *      not a gzipped tar, an archive carries an entry type this reader does
 *      not know, an entry would land outside the extraction directory
 *
 * The two must not collapse into each other. A read failure reported as a
 * difference reads as "the released tree is not the committed one" and sends a
 * release looking for a source change that does not exist; an unread archive
 * reported as equal would clear a release the tool never saw. That is why this
 * file reads archives in process — node:zlib plus a ustar reader — instead of
 * shelling out to `tar`: a missing or misbehaving binary would have to be
 * classified as one of the two verdicts, and neither is true.
 *
 * Modes, owners and timestamps are not compared. A packer writes them from the
 * machine it runs on; the question is what the bytes are, not who wrote them.
 * No network, no npm, no child process. Output is deterministic — the same
 * arguments print the same lines — so a workflow log can be diffed.
 *
 * Usage: node packages/core/scripts/pack-compare.mjs <tarball-a> <tarball-b>
 */
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { readArchive, Unreadable } from "./lib/tar-entries.mjs";

const USAGE = "usage: node packages/core/scripts/pack-compare.mjs <tarball-a> <tarball-b>";

/** How many differing paths are printed before the rest are counted. */
const MAX_REPORTED = 20;

/** The record whose fields describe the machine that packed, not the tree. */
const PROVENANCE = /(^|\/)build-info\.json$/;

/**
 * The record's environment-derived fields: replaced before the trees are read,
 * each with the reason two packs of one commit disagree on it. Every other
 * field is compared as content.
 */
const ENVIRONMENT_FIELDS = [
  { field: "packedAt", why: "the clock of the machine that packs" },
  { field: "branch", why: "a release tag is checked out detached in CI" },
  { field: "shaShort", why: "git shortens to the length its own object database needs" },
];

// The reader is shared with check-release-content.mjs, which asks the same
// question of a packed workspace and of a registry artifact.

// ── unpacking and comparison ───────────────────────────────────────────────

function extractTree(entries, dir) {
  for (const [name, entry] of entries) {
    const target = join(dir, name);
    mkdirSync(dirname(target), { recursive: true });
    if (entry.kind === "file") writeFileSync(target, entry.data);
    else symlinkSync(entry.data.toString("utf8"), target);
  }
}

/** Walk an unpacked tree into the same map shape the archive reader produces. */
function walkTree(dir) {
  const entries = new Map();
  const visit = (absolute, prefix) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) visit(child, name);
      else if (entry.isSymbolicLink()) entries.set(name, { kind: "symlink", data: Buffer.from(readlinkSync(child)) });
      else if (entry.isFile()) entries.set(name, { kind: "file", data: readFileSync(child) });
      else throw new Unreadable(`${absolute}: entry ${name} is neither a file nor a link`);
    }
  };
  visit(dir, "");
  return entries;
}

/**
 * Replace the fields a packer writes from its environment. Everything else in
 * the record — the package, the version, the commit, the dirty flag — is
 * compared, because it is the artifact's own provenance and a change to it is
 * a real difference.
 *
 * A record is compared as data, not as text: key order and whitespace are a
 * writer's choice, and the fields are the record. A field's presence is not
 * normalised either — a record that lost the field is a different record, and
 * reporting it as content is the honest answer. That is also what keeps the
 * normalisation from being a hole to pack through: deleting a field to make a
 * pair compare equal is itself the difference.
 *
 * Returns the paths whose environment fields actually differed, with those
 * fields, so an identical pair says so instead of reporting a normalisation
 * that changed nothing.
 */
function normaliseProvenance(left, right) {
  const normalised = [];
  for (const name of [...left.keys()].sort()) {
    if (!PROVENANCE.test(name)) continue;
    const a = left.get(name);
    const b = right.get(name);
    if (a === undefined || b === undefined || a.kind !== "file" || b.kind !== "file") continue;

    const first = parseRecord(a.data);
    const second = parseRecord(b.data);
    if (first === null || second === null) continue; // not records: compare them as content

    const replaced = [];
    for (const { field } of ENVIRONMENT_FIELDS) {
      if (!(field in first) || !(field in second)) continue;
      if (first[field] !== second[field]) replaced.push(field);
      delete first[field];
      delete second[field];
    }
    if (replaced.length > 0) normalised.push({ path: name, fields: replaced });
    a.data = canonicalRecord(first);
    b.data = canonicalRecord(second);
  }
  return normalised;
}

/** A JSON object, or null when the bytes are not one. */
function parseRecord(data) {
  try {
    const parsed = JSON.parse(data.toString("utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function canonicalRecord(record) {
  const ordered = {};
  for (const key of Object.keys(record).sort()) ordered[key] = record[key];
  return Buffer.from(JSON.stringify(ordered));
}

function diffTrees(left, right) {
  const differences = [];
  const names = [...new Set([...left.keys(), ...right.keys()])].sort();
  for (const name of names) {
    const a = left.get(name);
    const b = right.get(name);
    if (a === undefined) differences.push({ name, reason: "only in b" });
    else if (b === undefined) differences.push({ name, reason: "only in a" });
    else if (a.kind !== b.kind) differences.push({ name, reason: `kind differs (${a.kind} vs ${b.kind})` });
    else if (!a.data.equals(b.data)) differences.push({ name, reason: "content differs" });
  }
  return differences;
}

// ── the command ────────────────────────────────────────────────────────────

function compare(first, second) {
  const work = mkdtempSync(join(tmpdir(), "pack-compare-"));
  try {
    extractTree(readArchive(first), join(work, "a"));
    extractTree(readArchive(second), join(work, "b"));
    const left = walkTree(join(work, "a"));
    const right = walkTree(join(work, "b"));
    const normalised = normaliseProvenance(left, right);

    console.log(`a: ${first}`);
    console.log(`b: ${second}`);

    const differences = diffTrees(left, right);
    if (differences.length === 0) {
      if (normalised.length === 0) {
        console.log("trees identical");
        return 0;
      }
      // Name what was ignored and why: an equality this tool reached by
      // replacing something is a weaker statement than one it reached by
      // comparing everything, and a reader has to be able to tell them apart.
      const paths = [...new Set(normalised.map((entry) => entry.path))];
      const fields = new Set(normalised.flatMap((entry) => entry.fields));
      console.log(`trees identical apart from ${paths.join(", ")}: ${[...fields].join(", ")}`);
      for (const { field, why } of ENVIRONMENT_FIELDS) {
        if (fields.has(field)) console.log(`  ${field.padEnd(9)} environment-derived: ${why}`);
      }
      return 0;
    }

    console.log(`trees differ: ${differences.length} path${differences.length === 1 ? "" : "s"}`);
    for (const difference of differences.slice(0, MAX_REPORTED)) {
      console.log(`  ${difference.reason.padEnd(16)} ${difference.name}`);
    }
    const omitted = differences.length - MAX_REPORTED;
    if (omitted > 0) console.log(`  ... and ${omitted} more path${omitted === 1 ? "" : "s"}`);
    return 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

const [first, second, ...extra] = process.argv.slice(2);
if (first === undefined || second === undefined || extra.length > 0) {
  console.error(USAGE);
  process.exit(2);
}

try {
  process.exitCode = compare(first, second);
} catch (error) {
  if (!(error instanceof Unreadable)) throw error;
  console.error(`pack-compare: ${error.message}`);
  process.exitCode = 2;
}
