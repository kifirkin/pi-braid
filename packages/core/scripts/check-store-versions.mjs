#!/usr/bin/env node
/**
 * check-store-versions — the census over the state files braid keeps, and the
 * gate that notices a store nobody declared.
 *
 * Every store-shaped file under the braid home is one of two things: a store,
 * which declares the versions this build reads and is read through the
 * versioned reader, or a declared non-store, which carries a reason it is not
 * one. A file that is neither fails the run. That is the failure this program
 * exists for: a new store appearing is normal, and a new store appearing
 * *undeclared* is how a reader starts guessing again.
 *
 * The list below is the declaration, not a discovery: the checker owns it
 * because the question it answers is about this machine (which files exist),
 * not about a format. The readers it calls live in `lib/store/versioned.js` and
 * are imported from the build, while the schema of each store (its supported
 * versions, its required row fields, its declared tolerance) is spelled here.
 * That split is deliberate: an instrument that imported a producer's validator
 * could only find the mistakes the validator already knows about.
 *
 * A declared tolerance is printed and counted, never absorbed. `console/jobs.json`
 * has no version field and is read as legacy version 0 through a declared
 * migration to version 1; the line says so, and the instrument line counts it.
 * A tolerance that is not counted is the silent path this program removes.
 *
 * Findings are three classes, matching the three failures:
 *   VERSION       a store declares a version this build does not read, or a
 *                 tolerance this build cannot honour
 *   UNPARSEABLE   a store is not readable as its declared shape
 *   UNDECLARED    a store-shaped file the list does not name
 *
 * Usage:
 *   node packages/core/scripts/check-store-versions.mjs [--home <dir>]
 *
 * Exit: 0 clean (declared tolerances and absent stores are printed, not failed),
 *       2 at least one finding, 1 an operational error (no build, bad argument).
 */

import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const DIST = join(ROOT, "dist");

function die(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

async function loadDist(relative) {
  const file = join(DIST, relative);
  if (!existsSync(file)) {
    die(
      1,
      `check-store-versions: ${file} is absent; the package is not built. Run \`npm run build\` first.`,
    );
  }
  return import(pathToFileURL(file).href);
}

const {
  readVersionedJson,
  readVersionedJsonl,
  describeJsonSummary,
  describeJsonlSummary,
  StoreRefusal,
} = await loadDist(join("lib", "store", "versioned.js"));
const { braidDir } = await loadDist(join("lib", "config", "braid-paths.js"));

// ── The declaration ───────────────────────────────────────────────────────

/** Fields every episode row carries; a row missing one is counted, not dropped. */
const EPISODE_REQUIRED = [
  "id",
  "task",
  "solution",
  "outcome",
  "similarity",
  "timestamp",
  "toolSequence",
  "tags",
  "project",
  "sessionId",
  "quality",
];

/** Fields an episode row may omit. A row missing one is `partial`, not an error:
 *  the rows written before the fields existed are the reason the distinction is
 *  declared here rather than inferred. */
const EPISODE_OPTIONAL = ["strategicSOP", "functionalSOP", "atomicSOP"];

/**
 * Every store, by path relative to the braid home. A `*` in a path matches one
 * directory segment, so a per-directory store is declared once.
 *
 * `supported` is every version this build can handle, oldest first: a file at a
 * lower version is migrated up, a file above the highest is refused.
 */
const STORES = [
  {
    path: "memory/semantic.json",
    kind: "json",
    supported: [1],
  },
  {
    path: "memory/episodes.jsonl",
    kind: "jsonl",
    supported: [1],
    rowVersion: 1,
    required: EPISODE_REQUIRED,
    optional: EPISODE_OPTIONAL,
  },
  {
    path: "console/jobs.json",
    kind: "json",
    supported: [0, 1],
    legacy: {
      accept: true,
      version: 0,
      reason: "written before the schedule carried a version field",
    },
    migrate: {
      0: (data) => ({ ...data, version: 1 }),
    },
  },
  {
    path: "console/services.json",
    kind: "json",
    supported: [2],
  },
  {
    path: "projects/*/workers.json",
    kind: "json",
    supported: [1],
  },
  {
    path: "projects/*/locks.json",
    kind: "json",
    supported: [1],
  },
];

/**
 * Store-shaped files that are not stores, each with the reason. `kind` is
 * `log` for an append-only stream of events and `unversioned` for state this
 * build reads without a version rule; both are counted in the instrument line,
 * so the census stays complete rather than shrinking by exclusion.
 */
const NON_STORES = [
  {
    path: "memory/write-log.jsonl",
    kind: "log",
    reason: "an audit of write decisions: rows are events, read for a history rather than a state",
  },
  {
    path: "console/chat.jsonl",
    kind: "log",
    reason: "the console's chat transcript: rows are messages, appended and never migrated",
  },
  {
    path: "console/state.json",
    kind: "unversioned",
    reason: "the console's per-job runtime record: read with a default and rewritten every cycle",
  },
  {
    path: "projects/*/deliverables.jsonl",
    kind: "log",
    reason: "the delivery log: rows are events, read to answer what was delivered and when",
  },
  {
    path: "projects/*/pending-timers.jsonl",
    kind: "unversioned",
    reason: "the pending-timer queue: read for live timers, and a timer that is gone needs no version",
  },
  {
    path: "projects/*/module-overrides.json",
    kind: "unversioned",
    reason: "operator module switches: read whole, and a switch that is absent is simply off",
  },
];

/** Directories whose store-shaped files must all be declared: a directory, or
 *  `projects`, whose one-level children are the per-project directories. */
const SCAN_ROOTS = ["memory", "console", "projects"];

// ── Arguments ─────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let home = "";
for (let index = 0; index < args.length; index++) {
  const arg = args[index];
  if (arg === "--home") {
    home = resolve(args[++index] ?? "");
    if (!args[index]) die(1, "check-store-versions: --home needs a directory");
  } else if (arg === "--help" || arg === "-h") {
    process.stdout.write(
      "usage: check-store-versions [--home <dir>]\n" +
        "exit 0 clean, 2 findings (VERSION|UNPARSEABLE|UNDECLARED), 1 operational error\n",
    );
    process.exit(0);
  } else {
    die(1, `check-store-versions: unknown argument ${JSON.stringify(arg)}`);
  }
}
if (home === "") {
  try {
    home = braidDir();
  } catch (error) {
    die(1, `check-store-versions: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// ── Findings ──────────────────────────────────────────────────────────────

const findings = { VERSION: [], UNPARSEABLE: [], UNDECLARED: [] };
function finding(shape, detail) {
  findings[shape].push(`${shape} ${detail}`);
}
const storeLines = [];

/** A refusal as one line, with the home prefix dropped so the path reads relative. */
function refused(error) {
  if (!(error instanceof StoreRefusal)) throw error;
  const detail = error.message.startsWith(`${home}/`)
    ? error.message.slice(home.length + 1)
    : error.message;
  finding(error.kind === "version" ? "VERSION" : "UNPARSEABLE", detail);
}

// ── The population ────────────────────────────────────────────────────────

/** Files in one directory, top level only, matching the store extensions. */
function storeShaped(directory) {
  let entries;
  try {
    entries = readdirSync(directory, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && /\.(?:json|jsonl)$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/**
 * Every store-shaped file under the scan roots, as paths relative to the home.
 *
 * Store-shaped means the name ends in the store extension. A backup beside a
 * store (`jobs.json.bak-...`) is the file an edit replaced, and its name says
 * so: it does not end in the extension, so it is not in the population and no
 * reader will mistake it for a store.
 */
function census(home) {
  const found = [];
  for (const root of SCAN_ROOTS) {
    const directory = join(home, root);
    if (!existsSync(directory)) continue;
    if (root === "projects") {
      let children;
      try {
        children = readdirSync(directory, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of children) {
        if (!child.isDirectory()) continue;
        for (const name of storeShaped(join(directory, child.name))) {
          found.push(`projects/${child.name}/${name}`);
        }
      }
      continue;
    }
    for (const name of storeShaped(directory)) found.push(`${root}/${name}`);
  }
  return found.sort();
}

/** A declared path against a file path: `*` matches one directory segment. */
function matches(declared, actual) {
  const left = declared.split("/");
  const right = actual.split("/");
  if (left.length !== right.length) return false;
  return left.every((segment, index) => segment === "*" || segment === right[index]);
}

const storeFor = (relative) => STORES.find((store) => matches(store.path, relative));
const nonStoreFor = (relative) => NON_STORES.find((entry) => matches(entry.path, relative));

// ── Read the stores ───────────────────────────────────────────────────────

const counts = { stores: 0, files: 0, rows: 0, partial: 0, legacy: 0, migrated: 0 };
const declared = { log: 0, unversioned: 0 };
/** Files each store entry accounted for and the lines that describe them, so a
 *  glob prints one line and a refused file is not mistaken for an absent store. */
const perStore = new Map();

const files = census(home);
for (const relative of files) {
  const store = storeFor(relative);
  if (store === undefined) {
    const entry = nonStoreFor(relative);
    if (entry !== undefined) {
      declared[entry.kind]++;
      continue;
    }
    finding("UNDECLARED", `${relative}: not declared by the store list`);
    continue;
  }

  counts.files++;
  const record = perStore.get(store) ?? { files: 0, lines: [] };
  perStore.set(store, record);
  record.files++;
  const path = join(home, relative);

  if (store.kind === "jsonl") {
    try {
      const read = readVersionedJsonl(path, {
        supported: store.supported,
        rowVersion: store.rowVersion,
        required: store.required,
        optional: store.optional,
        migrate: store.migrate,
      });
      counts.rows += read.summary.rows;
      counts.partial += read.summary.partial;
      if (read.summary.migratedRows > 0) counts.migrated++;
      record.lines.push(
        `${relative}: row version ${read.summary.rowVersion}; ${describeJsonlSummary(read.summary)}`,
      );
    } catch (error) {
      refused(error);
    }
    continue;
  }

  try {
    const read = readVersionedJson(path, {
      supported: store.supported,
      legacy: store.legacy,
      migrate: store.migrate,
    });
    if (read.summary.legacy !== null) counts.legacy++;
    if (read.summary.migrated.length > 0) counts.migrated++;
    record.lines.push(`${relative}: ${describeJsonSummary(read.summary)}`);
  } catch (error) {
    refused(error);
  }
}

for (const store of STORES) {
  const record = perStore.get(store) ?? { files: 0, lines: [] };
  if (record.files === 0) {
    storeLines.push(`${store.path}: absent`);
    continue;
  }
  counts.stores++;
  if (record.lines.length === 0) {
    storeLines.push(`${store.path}: refused, ${record.files} file${record.files === 1 ? "" : "s"}`);
    continue;
  }
  if (record.files === 1 && record.lines.length === 1) {
    storeLines.push(record.lines[0]);
    continue;
  }
  const versions = [...new Set(record.lines.map((line) => line.slice(line.indexOf(": ") + 2)))];
  const missing = record.files - record.lines.length;
  const refused = missing > 0 ? `, ${missing} refused` : "";
  storeLines.push(`${store.path} (${record.files} files): ${versions.join("; ")}${refused}`);
}

// ── Report ────────────────────────────────────────────────────────────────

const nonStorePatterns = NON_STORES.map((entry) => `${entry.path} (${entry.kind})`);
const nonStoreLine =
  `declared non-stores: ${NON_STORES.length} patterns, ` +
  `${declared.log} logs, ${declared.unversioned} unversioned: ${nonStorePatterns.join(", ")}; ` +
  "a .bak copy beside a store is the file an edit replaced, and its name keeps it out of the census";



process.stdout.write(`braid stores under ${home}\n`);
for (const line of storeLines) process.stdout.write(`${line}\n`);
process.stdout.write(`${nonStoreLine}\n`);

const all = [...findings.VERSION, ...findings.UNPARSEABLE, ...findings.UNDECLARED];
for (const line of all) process.stdout.write(`${line}\n`);

process.stdout.write(
  `findings: VERSION ${findings.VERSION.length}, UNPARSEABLE ${findings.UNPARSEABLE.length}, ` +
    `UNDECLARED ${findings.UNDECLARED.length}; stores ${counts.stores}, files ${counts.files}, ` +
    `rows ${counts.rows}, partial ${counts.partial}, legacy ${counts.legacy}, ` +
    `migrated ${counts.migrated}, logs ${declared.log}, unversioned ${declared.unversioned}\n`,
);

process.exit(all.length === 0 ? 0 : 2);
