#!/usr/bin/env node
/**
 * pack-compare.mjs — two packed artifacts, compared by what they unpack to.
 *
 * A release makes one claim: the registry serves the tree this commit builds.
 * Comparing the two tarballs byte for byte cannot test it, because two packs of
 * one tree differ in gzip framing, entry order and the provenance record's own
 * timestamp. Unpacked, they differ in nothing — so the comparison runs on the
 * unpacked content, with the one field no pack can hold still replaced before
 * the trees are read.
 *
 * Three outcomes, three exit codes, because the caller acts on the difference:
 *
 *   0  the trees are identical apart from the provenance record's timestamp
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
import { gunzipSync } from "node:zlib";

const USAGE = "usage: node packages/core/scripts/pack-compare.mjs <tarball-a> <tarball-b>";

/** How many differing paths are printed before the rest are counted. */
const MAX_REPORTED = 20;

/** The record whose timestamp a pack writes from the clock, not the tree. */
const PROVENANCE = /(^|\/)build-info\.json$/;
const NORMALISED_FIELD = "packedAt";

/** A failure to read, which is exit 2 and never a verdict about the trees. */
class Unreadable extends Error {}

// ── tar reading ────────────────────────────────────────────────────────────

function cstr(block, start, length) {
  const slice = block.subarray(start, start + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? slice.length : end).toString("utf8");
}

function octal(block, start, length, what, where) {
  const raw = cstr(block, start, length).trim();
  if (raw === "") return 0;
  if (!/^[0-7]+$/.test(raw)) throw new Unreadable(`${where}: ${what} field is not octal: ${raw}`);
  return Number.parseInt(raw, 8);
}

/** The header checksum, with the checksum field itself read as spaces. */
function storedChecksum(block) {
  let sum = 0;
  for (let index = 0; index < 512; index++) sum += index >= 148 && index < 156 ? 0x20 : block[index];
  return sum;
}

function readHeader(where, block) {
  const declared = octal(block, 148, 8, "checksum", where);
  const actual = storedChecksum(block);
  if (declared !== actual) {
    throw new Unreadable(`${where}: header checksum ${declared} does not match the block (${actual})`);
  }
  const flag = block[156] === 0 ? 0x30 : block[156];
  return {
    name: cstr(block, 0, 100),
    prefix: cstr(block, 345, 155),
    size: octal(block, 124, 12, "size", where),
    typeflag: String.fromCharCode(flag),
    linkname: cstr(block, 157, 100),
  };
}

/** `<len> key=value\n` records, as pax extended headers carry them. */
function readPax(text, where) {
  const values = {};
  let rest = text;
  while (rest.length > 0) {
    const space = rest.indexOf(" ");
    if (space < 0) throw new Unreadable(`${where}: truncated pax record`);
    const length = Number.parseInt(rest.slice(0, space), 10);
    if (!Number.isFinite(length) || length <= 0 || length > rest.length) {
      throw new Unreadable(`${where}: pax record length ${rest.slice(0, space)} does not fit the header`);
    }
    const record = rest.slice(0, length);
    const equals = record.indexOf("=");
    if (equals < 0) throw new Unreadable(`${where}: pax record without a value`);
    values[record.slice(space + 1, equals)] = record.slice(equals + 1).replace(/\n$/, "");
    rest = rest.slice(length);
  }
  return values;
}

/**
 * An entry name as the trees are compared: relative, slash-separated, and
 * then checked for the one thing a name may not be. `pkg/…` is kept rather
 * than stripped — both archives of one tree carry the same prefix, and a
 * prefix only one of them carries is itself a difference worth seeing.
 */
function normaliseName(name, where) {
  let clean = name.replace(/\\/g, "/");
  while (clean.startsWith("./")) clean = clean.slice(2);
  clean = clean.replace(/^\/+/, "").replace(/\/+$/, "");
  if (clean.split("/").includes("..")) {
    throw new Unreadable(`${where}: entry ${name} would land outside the archive's own tree`);
  }
  return clean;
}

/** Every entry of a gzipped tar, keyed by its normalised name. */
function readArchive(file) {
  let raw;
  try {
    raw = readFileSync(file);
  } catch (error) {
    throw new Unreadable(`cannot read ${file}: ${error.code ?? error.message}`);
  }

  let buffer;
  try {
    buffer = gunzipSync(raw);
  } catch (error) {
    throw new Unreadable(`${file}: not a gzipped tar (${error.code ?? error.message})`);
  }

  const entries = new Map();
  let offset = 0;
  let nextPax = null;
  let nextName = null;

  while (offset + 512 <= buffer.length) {
    const block = buffer.subarray(offset, offset + 512);
    if (block.every((byte) => byte === 0)) break;

    const header = readHeader(`${file}: ${headerName(block)}`, block);
    const where = `${file}: ${header.name}`;

    if (header.typeflag === "x" || header.typeflag === "g") {
      const end = offset + 512 + header.size;
      if (end > buffer.length) throw new Unreadable(`${where}: pax header runs past the end of the archive`);
      const values = readPax(buffer.subarray(offset + 512, end).toString("utf8"), where);
      if (header.typeflag === "x") nextPax = values;
      offset += 512 + Math.ceil(header.size / 512) * 512;
      continue;
    }
    if (header.typeflag === "L" || header.typeflag === "K") {
      const end = offset + 512 + header.size;
      if (end > buffer.length) throw new Unreadable(`${where}: extended name runs past the end of the archive`);
      if (header.typeflag === "L") nextName = buffer.subarray(offset + 512, end).toString("utf8").replace(/\0+$/, "");
      offset += 512 + Math.ceil(header.size / 512) * 512;
      continue;
    }

    // A pax header may carry the real size, which the fixed field cannot hold.
    let size = header.size;
    if (nextPax && nextPax.size !== undefined) {
      size = Number.parseInt(nextPax.size, 10);
      if (!Number.isFinite(size) || size < 0) throw new Unreadable(`${where}: pax size ${nextPax.size} is not a length`);
    }
    const start = offset + 512;
    if (start + size > buffer.length) throw new Unreadable(`${where}: entry runs past the end of the archive`);
    const data = buffer.subarray(start, start + size);
    offset = start + Math.ceil(size / 512) * 512;

    const rawName = nextPax?.path ?? nextName ?? (header.prefix ? `${header.prefix}/${header.name}` : header.name);
    nextPax = null;
    nextName = null;
    const name = normaliseName(rawName, file);
    if (name === "") continue;

    switch (header.typeflag) {
      case "0":
      case "7":
        entries.set(name, { kind: "file", data });
        break;
      case "5":
        break;
      case "1":
      case "2":
        entries.set(name, {
          kind: header.typeflag === "2" ? "symlink" : "hardlink",
          data: Buffer.from(header.linkname),
        });
        break;
      default:
        throw new Unreadable(`${file}: entry ${name} has type "${header.typeflag}", which this reader does not know`);
    }
  }

  if (entries.size === 0) throw new Unreadable(`${file}: the archive holds no entries`);
  return entries;
}

/** The name a header block claims, for an error message raised before parsing. */
function headerName(block) {
  const name = cstr(block, 0, 100);
  return name === "" ? "(unnamed)" : name;
}

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
 * Replace the timestamp a packer writes from its clock. Everything else in the
 * record — the commit, the version, the dirty flag — is compared, because it
 * is the tree's own provenance and a change to it is a real difference.
 *
 * A record is compared as data, not as text: key order and whitespace are a
 * writer's choice, and the fields are the record. The field's presence is not
 * normalised either — a record that lost the stamp is a different record, and
 * reporting it as content is the honest answer.
 *
 * Returns the names whose stamps actually differed, so an identical pair says
 * so instead of reporting a normalisation that changed nothing.
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
    if (!(NORMALISED_FIELD in first) || !(NORMALISED_FIELD in second)) continue;

    if (first[NORMALISED_FIELD] !== second[NORMALISED_FIELD]) normalised.push(name);
    delete first[NORMALISED_FIELD];
    delete second[NORMALISED_FIELD];
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
      console.log(
        normalised.length === 0
          ? "trees identical"
          : `trees identical apart from ${normalised.map((name) => `${name} ${NORMALISED_FIELD}`).join(", ")}`,
      );
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
