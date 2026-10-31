#!/usr/bin/env node
/**
 * build-decisions-index — backfill owner rulings into the semantic memory store.
 *
 * The read half is split along the line the placement gate draws:
 * `lib/memory/decision-grammar.ts` carries the generic grammar and the tag
 * derivation, and `lib/orchestrator/owner-speech.ts` decides whether a turn is
 * the owner speaking and files the result in braid's shape. This script is the
 * write half. It reads the corpus shards the `session ask` index already owns,
 * classifies every user turn, applies the caps, skips what the store already
 * carries, and writes through `saveMemory` — the store's own locked, atomic,
 * merge-on-write path. A second run adds nothing.
 *
 *   node packages/core/scripts/build-decisions-index.mjs                 # census, no write
 *   node packages/core/scripts/build-decisions-index.mjs --write         # backfill
 *   node packages/core/scripts/build-decisions-index.mjs --project projects/agents/pi-braid
 *   node packages/core/scripts/build-decisions-index.mjs --since 2026-08-01T00:00:00Z
 *   node packages/core/scripts/build-decisions-index.mjs --max-per-project 10 --max-total 40
 *   node packages/core/scripts/build-decisions-index.mjs --json
 *
 * Two bounds the store imposes, and the reason the defaults are small:
 *
 *  - **The store is a 200-entry working set** (`MAX_ENTRIES`), pruned by
 *    utility. A backfill is a population competing for those slots, so the
 *    default budget is a slice of the cap rather than the whole corpus; the
 *    budget is a flag, so a later run can raise it deliberately.
 *  - **Recency is the only ordering.** The caps keep the newest rulings
 *    first; nothing here infers that a later ruling replaced an earlier one,
 *    because that inference needs a judgement the transcript does not carry.
 *
 * Needs the built package (`npm run build`): the classifier, the store I/O and
 * the path accessors are imported from `dist/`, never re-implemented here, so
 * the reader and the writer cannot disagree about what a ruling is or where
 * the store lives.
 *
 * Exit codes: 0 a census (and, with `--write`, a store) was produced; 2 bad
 * usage; 1 an operational error or a missing build.
 */
import { copyFile, readFile, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(resolve(__dirname, ".."), "dist");

function die(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Import a compiled module, naming the one command that fixes a missing build. */
async function loadDist(relative) {
  const file = join(DIST, relative);
  if (!existsSync(file)) {
    die(
      1,
      `build-decisions-index: ${file} is absent; the package is not built. Run \`npm run build\` first.`,
    );
  }
  return import(pathToFileURL(file).href);
}

const USAGE = `usage: node packages/core/scripts/build-decisions-index.mjs [options]

  --index <dir>            corpus shard directory (default: <braid root>/corpus-index)
  --project <label>        only turns from one project label (exact match)
  --since <iso>            only turns at or after this ISO-8601 timestamp
  --max-per-project <n>    rulings kept per project, newest first (default: 40)
  --max-total <n>          rulings kept across all projects, newest first (default: 60)
  --dry-run                print the census and write nothing (the default)
  --write                  write the survivors into the semantic store
  --json                   print the census as one JSON object
  --verbose                print one line per kept ruling
  -h, --help               this message`;

const DEFAULT_MAX_PER_PROJECT = 40;
const DEFAULT_MAX_TOTAL = 60;

const args = process.argv.slice(2);
let indexArg;
let projectFilter;
let sinceArg;
let maxPerProject = DEFAULT_MAX_PER_PROJECT;
let maxTotal = DEFAULT_MAX_TOTAL;
let write = false;
let asJson = false;
let verbose = false;

function readPositiveInt(name, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    die(2, `build-decisions-index: ${name} takes a positive integer (got "${raw}")\n\n${USAGE}`);
  }
  return value;
}

for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg === "--index" && args[i + 1]) {
    indexArg = args[++i];
  } else if (arg === "--project" && args[i + 1]) {
    projectFilter = args[++i];
  } else if (arg === "--since" && args[i + 1]) {
    sinceArg = args[++i];
  } else if (arg === "--max-per-project" && args[i + 1]) {
    maxPerProject = readPositiveInt("--max-per-project", args[++i]);
  } else if (arg === "--max-total" && args[i + 1]) {
    maxTotal = readPositiveInt("--max-total", args[++i]);
  } else if (arg === "--dry-run") {
    write = false;
  } else if (arg === "--write") {
    write = true;
  } else if (arg === "--json") {
    asJson = true;
  } else if (arg === "--verbose") {
    verbose = true;
  } else {
    die(2, `build-decisions-index: unknown argument ${arg}\n\n${USAGE}`);
  }
}

const sinceMs = sinceArg === undefined ? undefined : Date.parse(sinceArg);
if (sinceArg !== undefined && Number.isNaN(sinceMs)) {
  die(2, `build-decisions-index: --since takes an ISO-8601 timestamp (got "${sinceArg}")`);
}

const { classifyOwnerRuling, rulingBaseTags, rulingDuplicateKey, rulingPointer, rulingPointerPattern } =
  await loadDist(join("lib", "orchestrator", "owner-speech.js"));
const { deriveTopicTags } = await loadDist(join("lib", "memory", "decision-grammar.js"));
const { readStoreFile, saveMemory } = await loadDist(join("lib", "memory", "storage.js"));
const { calculateUtility } = await loadDist(join("lib", "memory", "lifecycle.js"));
const { generateId } = await loadDist(join("lib", "memory", "utils.js"));
const { MAX_ENTRIES } = await loadDist(join("lib", "memory", "constants.js"));
const { corpusIndexDir, semanticMemoryFilePath } = await loadDist(
  join("lib", "config", "braid-paths.js"),
);
// The shard writer's own naming rule, imported rather than re-derived: the
// duplicate scan and the shard's `session_id` column must agree on what a
// session id is, or a re-run would write the same ruling twice.
const { sessionIdFromPath } = await loadDist(
  join("extensions", "memory", "session-recall", "corpus-index.js"),
);

const indexDir = indexArg ? resolve(indexArg) : corpusIndexDir();
if (!existsSync(indexDir)) {
  die(1, `build-decisions-index: no corpus index at ${indexDir}`);
}

/** Read one shard: manifest first, then one row per user turn. */
async function readShard(file) {
  const text = await readFile(file, "utf8");
  const lines = text.split("\n");
  let manifest;
  try {
    manifest = JSON.parse(lines[0]);
  } catch {
    return { error: "manifest does not parse" };
  }
  if (manifest?.kind !== "manifest") return { error: "no manifest" };
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      return { error: `row ${i} does not parse` };
    }
    if (
      typeof row?.session !== "string" ||
      typeof row?.session_id !== "string" ||
      typeof row?.project !== "string" ||
      typeof row?.ts !== "string" ||
      typeof row?.line !== "number" ||
      typeof row?.text !== "string"
    ) {
      return { error: `row ${i} is not a turn record` };
    }
    rows.push(row);
  }
  return { manifest, rows };
}

const shardFiles = (await readdir(indexDir)).filter((name) => name.endsWith(".jsonl")).sort();
if (shardFiles.length === 0) {
  die(1, `build-decisions-index: no shards under ${indexDir}`);
}

const skippedShards = [];
const perProject = new Map();
const classTotals = {};
let turnsScanned = 0;
let candidatesExtracted = 0;

for (const name of shardFiles) {
  const file = join(indexDir, name);
  const shard = await readShard(file);
  if (shard.error) {
    skippedShards.push(`${name}: ${shard.error}`);
    continue;
  }
  if (projectFilter !== undefined && shard.manifest.project !== projectFilter) continue;
  let stats = perProject.get(shard.manifest.project);
  if (!stats) {
    stats = {
      project: shard.manifest.project,
      turns: 0,
      candidates: 0,
      classes: {},
      candidatesList: [],
    };
    perProject.set(shard.manifest.project, stats);
  }
  for (const row of shard.rows) {
    if (projectFilter !== undefined && row.project !== projectFilter) continue;
    if (sinceMs !== undefined) {
      const ts = Date.parse(row.ts);
      if (Number.isNaN(ts) || ts < sinceMs) continue;
    }
    stats.turns++;
    turnsScanned++;
    const candidate = classifyOwnerRuling(row);
    if (!candidate) continue;
    stats.candidates++;
    candidatesExtracted++;
    stats.classes[candidate.class] = (stats.classes[candidate.class] ?? 0) + 1;
    classTotals[candidate.class] = (classTotals[candidate.class] ?? 0) + 1;
    stats.candidatesList.push(candidate);
  }
}

/** Newest first: a ruling stated later outranks one it may have replaced. */
const newestFirst = (a, b) => {
  const delta = Date.parse(b.ts) - Date.parse(a.ts);
  if (delta !== 0) return delta;
  if (a.session !== b.session) return a.session < b.session ? -1 : 1;
  return b.line - a.line;
};

const survivors = [];
for (const stats of perProject.values()) {
  stats.candidatesList.sort(newestFirst);
  const kept = stats.candidatesList.slice(0, maxPerProject);
  stats.survivors = kept.length;
  survivors.push(...kept);
}
survivors.sort(newestFirst);
const budgeted = survivors.slice(0, maxTotal);

// Duplicate scan: one turn is one ruling, keyed `<session_id>:<line>`.
const existing = await readStoreFile();
const storeBefore = existing?.memories ?? [];
const knownKeys = new Set();
// The label is the writer's, read back from the module that stamps it: a second
// spelling here would make the duplicate scan blind to its own entries.
const POINTER = rulingPointerPattern();
for (const entry of storeBefore) {
  const match = typeof entry.source === "string" ? POINTER.exec(entry.source) : null;
  if (!match) continue;
  const sessionId = sessionIdFromPath(match[1]);
  knownKeys.add(`${sessionId}:${match[2]}`);
}

const toWrite = [];
const duplicates = [];
for (const candidate of budgeted) {
  if (knownKeys.has(rulingDuplicateKey(candidate))) {
    duplicates.push(candidate);
    continue;
  }
  toWrite.push(candidate);
}

// The population a quote's tags are derived from: every entry the store holds
// now, plus the entry each survivor is about to become. Measured this way the
// same run on the same corpus derives the same tags, and a second run (which
// writes nothing) is never consulted for a ranking it cannot change.
const frequency = new Map();
const countDocument = (text) => {
  for (const token of new Set(String(text ?? "").toLowerCase().match(/[a-z][a-z0-9-]{3,}/g) ?? [])) {
    frequency.set(token, (frequency.get(token) ?? 0) + 1);
  }
};
for (const entry of storeBefore) countDocument(entry.content);
for (const candidate of toWrite) countDocument(candidate.quote);
const tagPopulation = {
  total: storeBefore.length + toWrite.length,
  count: (token) => frequency.get(token) ?? 0,
};

const storePath = semanticMemoryFilePath();
const result = {
  index_dir: indexDir,
  mode: write ? "write" : "dry-run",
  projects: [...perProject.values()]
    .map((stats) => ({
      project: stats.project,
      turns: stats.turns,
      candidates: stats.candidates,
      classes: stats.classes,
      survivors: stats.survivors,
      kept: toWrite.filter((candidate) => candidate.project === stats.project).length,
      duplicates: duplicates.filter((candidate) => candidate.project === stats.project).length,
    }))
    .sort((a, b) => b.candidates - a.candidates || (a.project < b.project ? -1 : 1)),
  totals: {
    turns: turnsScanned,
    // Three populations, named apart on purpose: what the classifier found,
    // what survived the caps, and what the store did not already carry.
    candidates: candidatesExtracted,
    survivors: budgeted.length,
    kept: toWrite.length,
    duplicates: duplicates.length,
    classes: classTotals,
  },
  skipped_shards: skippedShards,
  store: {
    path: storePath,
    before: storeBefore.length,
    after: storeBefore.length,
    written: 0,
    backup: null,
    max_entries: MAX_ENTRIES,
  },
};

if (write && toWrite.length > 0) {
  // The backup is the rollback: taken before the first entry lands, and named
  // in the output so the restore command is copy-paste, not archaeology.
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = `${storePath}.bak-${stamp}`;
  if (existsSync(storePath)) await copyFile(storePath, backup);
  result.store.backup = backup;

  // saveMemory re-reads the disk store under its lock and unions these entries
  // with whatever another process wrote since the duplicate scan above.
  let lastIssued = 0;
  const nextTimestamp = () => {
    lastIssued = Math.max(Date.now(), lastIssued + 1);
    return lastIssued;
  };
  const entries = toWrite.map((candidate) => {
    const timestamp = nextTimestamp();
    const emphasis = 0.6;
    return {
      id: generateId(),
      content: candidate.quote,
      type: "preference",
      tags: [...rulingBaseTags(candidate), ...deriveTopicTags(candidate.quote, tagPopulation)],
      timestamp,
      accessCount: 0,
      lastAccessed: timestamp,
      source: rulingPointer(candidate),
      importance: emphasis,
      utility: calculateUtility("preference", candidate.quote, emphasis),
      // No projectId: a ruling is cross-project knowledge, and a scoped entry
      // is filtered out of another project's recall (projectScope defaults to
      // "current"). The project it came from rides in `source` and in the tags.
    };
  });
  const merged = await saveMemory({
    version: 1,
    memories: entries,
    lastConsolidation: 0,
    turnCount: 0,
  });
  result.store.written = entries.length;
  result.store.after = merged.memories.length;
}

const report = result.totals;
if (asJson) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} else {
  const lines = [
    `decisions census (${result.mode}): ${report.turns} turn(s) scanned, ` +
      `${report.candidates} candidate ruling(s), ${report.kept} to write ` +
      `(${report.survivors} after caps, ${report.duplicates} already in the store)`,
    `  store: ${result.store.before} entries before` +
      (result.mode === "write"
        ? `, ${result.store.after} after (${result.store.written} written)`
        : ""),
    `  budget: ${maxPerProject} per project, ${maxTotal} total; store cap ${MAX_ENTRIES}`,
  ];
  if (Object.keys(classTotals).length > 0) {
    const classes = Object.entries(classTotals)
      .sort((a, b) => b[1] - a[1])
      .map(([kind, count]) => `${kind} ${count}`)
      .join(", ");
    lines.push(`  classes: ${classes}`);
  }
  lines.push(`  index: ${indexDir}`);
  lines.push("");
  const interesting = result.projects.filter((p) => p.candidates > 0 || p.turns > 0);
  lines.push(`  ${interesting.length} project(s) with turns:`);
  for (const project of interesting.slice(0, verbose ? interesting.length : 15)) {
    lines.push(
      `    ${project.project}: ${project.turns} turn(s), ${project.candidates} candidate(s), ` +
        `${project.survivors} survivor(s), ${project.duplicates} duplicate(s)`,
    );
  }
  if (!verbose && interesting.length > 15) {
    lines.push(`    ... ${interesting.length - 15} more (--verbose lists all, --json for the full census)`);
  }
  for (const skip of skippedShards) lines.push(`  skipped shard: ${skip}`);
  if (verbose) {
    lines.push("");
    lines.push("  kept rulings:");
    for (const candidate of toWrite) {
      lines.push(`    [${candidate.class}] ${candidate.project} ${candidate.ts} ${candidate.session}:${candidate.line}`);
      lines.push(`      ${candidate.quote.replace(/\n/g, " ").slice(0, 200)}`);
    }
  }
  if (write && result.store.backup) {
    lines.push("");
    lines.push(`  backup: ${result.store.backup}`);
    lines.push(`  restore: cp '${result.store.backup}' '${result.store.path}'`);
  }
  if (result.store.after > MAX_ENTRIES && !write) {
    lines.push("");
    lines.push(
      `  note: the write would leave ${result.store.before + toWrite.length} entries against a ` +
        `${MAX_ENTRIES}-entry cap; the store's next prune evicts the lowest-utility entries.`,
    );
  }
  lines.push("");
  process.stdout.write(`${lines.join("\n")}\n`);
}
