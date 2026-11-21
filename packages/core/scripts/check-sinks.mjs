#!/usr/bin/env node
// check-sinks.mjs - did the learning this wave produced reach a sink?
//
// A wave can close with its report written and its learning nowhere: no journal
// entry the next seat will read, no memory the next recall can find, no doc line
// naming what changed. The report then reads as complete while the only copy of
// the finding is the report itself.
//
//   node packages/core/scripts/check-sinks.mjs --wave <id> [--report <path>]
//        [--subject <text>]... [--file <path>]... [--since <iso>]
//        [--cwd <dir>] [--repo <dir>] [--workers <file>] [--base <ref>] [--json]
//
// Four searches, each printing what it scanned and what it found:
//
//   journal  a journal entry naming the wave's subject or one of its files,
//            written since the wave started
//   memory   an episode or semantic entry written since the wave started and
//            naming the subject (the write log is counted, not matched: it
//            records hashes, not text)
//   doc      an AGENTS.md or doc line added by the branch that names the
//            subject; documentation is a sink. A doc that only points at a
//            store, or quotes a rule id the store holds, is classified as a
//            projection rather than a second truth, and the wave's own report
//            is never counted: a report naming itself proves nothing
//   store    a preference rule the store holds whose `since` day is the wave's
//            day or later: the rule reached a store, and the doc can only
//            point at it
//
// Verdicts:
//   exit 0  at least one sink carries the wave's trace
//   exit 1  REFUSED: the report's work left no trace in any sink
//   exit 2  usage, a wave start that cannot be placed, or a store that cannot
//           be read - a search that could not run cannot honestly say "no trace"
//
// Read-only: nothing here writes, appends or repairs.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(resolve(__dirname, ".."), "dist");

const EXIT_REACHED = 0;
const EXIT_REFUSED = 1;
const EXIT_CANNOT_RUN = 2;

const USAGE = `Usage: node packages/core/scripts/check-sinks.mjs --wave <id> [options]

  --wave <id>        the wave to look for (also a search term)
  --report <path>    the report the wave wrote; its name is a search term
  --subject <text>   a phrase the wave's trace should carry (repeatable)
  --file <path>      a file the wave changed; its basename is a search term
  --since <iso>      when the wave started (default: the registry row's spawnedAt)
  --cwd <dir>        project whose journal, memory and fleet are read
  --repo <dir>       git repo whose branch carries the doc lines (default: --cwd)
  --workers <file>   worker registry to place the wave start from
  --base <ref>       branch base for the doc search (default: main)
  --json             print the searches as JSON`;

function usageError(message) {
  console.error(`Sink check: cannot run - ${message}`);
  console.error(USAGE);
  process.exit(EXIT_CANNOT_RUN);
}

const argv = process.argv.slice(2);
let wave = null;
let report = null;
let sinceArg = null;
let cwd = process.cwd();
let repo = null;
let workersArg = null;
let base = "main";
let json = false;
const subjects = [];
const files = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--wave") wave = argv[++i] ?? null;
  else if (a === "--report") report = argv[++i] ?? null;
  else if (a === "--subject") subjects.push(argv[++i] ?? "");
  else if (a === "--file") files.push(argv[++i] ?? "");
  else if (a === "--since") sinceArg = argv[++i] ?? null;
  else if (a === "--cwd") {
    const v = argv[++i];
    if (!v) usageError("--cwd needs a directory");
    cwd = isAbsolute(v) ? v : resolve(process.cwd(), v);
  } else if (a === "--repo") {
    const v = argv[++i];
    if (!v) usageError("--repo needs a directory");
    repo = isAbsolute(v) ? v : resolve(process.cwd(), v);
  } else if (a === "--workers") workersArg = argv[++i] ?? null;
  else if (a === "--base") base = argv[++i] ?? "main";
  else if (a === "--json") json = true;
  else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(EXIT_REACHED);
  } else usageError(`unknown argument ${a}`);
}

if (!wave) usageError("--wave is required: a sink search without a wave has no subject and no window");
if (!existsSync(cwd)) usageError(`--cwd does not exist: ${cwd}`);

// ── the built modules ───────────────────────────────────────────────────────

async function loadDist(relative) {
  const file = join(DIST, relative);
  if (!existsSync(file)) {
    console.error(`Sink check: cannot run - the built module ${relative} is missing (no build in ${DIST}).`);
    console.error("  Run `npm run build` first: the paths and the store contract are the runtime's own, not a copy.");
    process.exit(EXIT_CANNOT_RUN);
  }
  return import(pathToFileURL(file).href);
}

const paths = await loadDist(join("lib", "config", "braid-paths.js"));
const preferences = await loadDist(join("lib", "preferences", "store.js"));
const scratchpadModule = await loadDist(
  join("extensions", "memory", "scratchpad", "persistence.js"),
);

const {
  episodesFilePath,
  getWorkersFilePath,
  journalFilePath,
  journalRotatedFiles,
  memoryDir,
  semanticMemoryFilePath,
} = paths;
const { projectSlugFromCwd } = scratchpadModule;

// ── terms ───────────────────────────────────────────────────────────────────

/** A report stem with its date suffix removed: the name a journal subject uses. */
const stripDate = (name) => name.replace(/-\d{4}-\d{2}-\d{2}$/, "");

const terms = [];
const addTerm = (value) => {
  const term = String(value ?? "").toLowerCase().trim();
  if (term && !terms.includes(term)) terms.push(term);
};

addTerm(wave);
for (const subject of subjects) addTerm(subject);
if (report !== null) {
  const stem = basename(report, extname(report));
  addTerm(stem);
  addTerm(stripDate(stem));
}
for (const file of files) {
  addTerm(basename(file));
  addTerm(stripDate(basename(file)));
}
if (terms.length === 0) usageError("no search terms: pass --wave, --subject or --file");

const namesTerm = (text) => {
  const haystack = String(text ?? "").toLowerCase();
  return terms.some((term) => haystack.includes(term));
};

// ── the wave start ──────────────────────────────────────────────────────────

const workersFile = workersArg !== null ? resolve(cwd, workersArg) : getWorkersFilePath(cwd);

function waveRow() {
  if (!existsSync(workersFile)) return null;
  try {
    const parsed = JSON.parse(readFileSync(workersFile, "utf-8"));
    return parsed?.workers?.[wave] ?? null;
  } catch {
    return null;
  }
}

const row = waveRow();
let sinceMs;
if (sinceArg !== null) {
  sinceMs = Date.parse(sinceArg);
  if (Number.isNaN(sinceMs)) usageError(`--since ${sinceArg} is not a timestamp`);
} else if (row?.spawnedAt) {
  sinceMs = Date.parse(row.spawnedAt);
  if (Number.isNaN(sinceMs)) usageError(`the registry row for ${wave} carries an unusable spawnedAt: ${row.spawnedAt}`);
} else {
  usageError(
    `cannot place when ${wave} started: no registry row in ${workersFile}. Pass --since <iso>, or --workers <file> that names it.`,
  );
}
const sinceDay = new Date(sinceMs).toISOString().slice(0, 10);

// The row's output file is a search term: a journal entry naming the report is
// a sink hit even when it never says the wave id. The row's source files are
// not: basenames such as `index.ts` or `store.ts` name half the tree, and a
// term that matches everything cannot distinguish "this wave landed" from
// "some other wave did". A caller who wants one file matched passes --file.
if (row?.outputFile) addTerm(basename(row.outputFile, extname(row.outputFile)));

// ── readers ─────────────────────────────────────────────────────────────────

const bytesOf = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

function readJsonlRows(file) {
  const text = readFileSync(file, "utf-8");
  const rows = [];
  let unparseable = 0;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      rows.push(JSON.parse(trimmed));
    } catch {
      unparseable++;
    }
  }
  return { rows, unparseable };
}

const toMs = (value) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
};

// The stores belong to a project; the branch belongs to a repo. A wave can run
// in one and write its report in the other, so the two roots are named apart.
const docRoot = repo ?? cwd;
if (!existsSync(docRoot)) usageError(`--repo does not exist: ${docRoot}`);
// A diff over a long branch exceeds spawnSync's 1 MB default and dies with a
// null status, which would read as "no lines added". The buffer is raised and
// the failure is returned, so a git read that did not happen is never counted
// as zero hits.
const GIT_BUFFER = 256 * 1024 * 1024;
const git = (...args) => spawnSync("git", ["-C", docRoot, ...args], { encoding: "utf8", maxBuffer: GIT_BUFFER });
const gitRun = (...args) => {
  const r = git(...args);
  return {
    ok: r.status === 0,
    out: r.stdout ?? "",
    reason: r.status === 0 ? null : (r.stderr || "").trim() || r.error?.message || `git exited ${r.status}`,
  };
};
const gitOut = (...args) => {
  const r = gitRun(...args);
  return r.ok ? r.out : null;
};

// ── searches ────────────────────────────────────────────────────────────────

const slug = projectSlugFromCwd(cwd);
const searches = [];

function searchJournal() {
  const file = journalFilePath(slug);
  const candidates = [file, ...journalRotatedFiles(file)].filter((f) => existsSync(f));
  if (candidates.length === 0) {
    return { name: "journal", state: "missing", scanned: `${file} (absent)`, hits: [], count: 0 };
  }
  let scanned = 0;
  const hits = [];
  for (const candidate of candidates) {
    const { rows, unparseable } = readJsonlRows(candidate);
    scanned += rows.length;
    for (const entry of rows) {
      const at = toMs(entry.at);
      if (at === null || at < sinceMs) continue;
      const text = [entry.kind, entry.subject, entry.text, entry.reason, ...(entry.evidence ?? [])].join(" ");
      if (!namesTerm(text)) continue;
      hits.push({
        seq: entry.seq ?? null,
        at: new Date(at).toISOString(),
        subject: entry.subject ?? "(no subject)",
        kind: entry.kind ?? null,
        file: candidate,
      });
    }
    if (unparseable > 0) {
      // A line this reader cannot parse is not evidence either way; the count
      // is printed so a REFUSED verdict never hides behind a broken file.
      hits.push({ unparseable });
    }
  }
  return {
    name: "journal",
    state: "ok",
    scanned: `${scanned} entries in ${candidates.length} file(s)`,
    hits: hits.filter((hit) => !("unparseable" in hit)),
    count: hits.filter((hit) => !("unparseable" in hit)).length,
    unparseable: hits.filter((hit) => "unparseable" in hit).reduce((n, hit) => n + hit.unparseable, 0),
  };
}

function searchMemory() {
  const episodesFile = episodesFilePath();
  const semanticFile = semanticMemoryFilePath();
  const writeLogFile = join(memoryDir(), "write-log.jsonl");
  const hits = [];
  let scanned = 0;
  let writes = 0;
  let unparseable = 0;
  let present = 0;

  if (existsSync(episodesFile)) {
    present++;
    const { rows, unparseable: bad } = readJsonlRows(episodesFile);
    unparseable += bad;
    scanned += rows.length;
    for (const entry of rows) {
      const at = toMs(entry.timestamp);
      if (at === null || at < sinceMs) continue;
      const text = [entry.task, entry.solution, ...(entry.tags ?? []), entry.strategicSOP]
        .filter(Boolean)
        .join(" ");
      if (!namesTerm(text)) continue;
      hits.push({
        source: "episode",
        at: new Date(at).toISOString(),
        id: entry.id ?? null,
        text: String(entry.task ?? entry.solution ?? "").slice(0, 120),
      });
    }
  }

  // A semantic entry carries no timestamp in the store's current shape, so a
  // match cannot be placed in the wave's window. It is printed as undated and
  // never counted as a hit: "this exists now" is not "this wave put it there".
  let semanticUndated = 0;
  if (existsSync(semanticFile)) {
    present++;
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(semanticFile, "utf-8"));
    } catch (error) {
      return {
        name: "memory",
        state: "unreadable",
        scanned: `${semanticFile} (${error.message})`,
        hits: [],
        count: 0,
      };
    }
    const memories = Array.isArray(parsed?.memories) ? parsed.memories : [];
    scanned += memories.length;
    for (const entry of memories) {
      const at = toMs(entry.createdAt ?? entry.timestamp);
      if (!namesTerm([entry.content, ...(entry.tags ?? [])].filter(Boolean).join(" "))) continue;
      if (at === null) {
        semanticUndated++;
        continue;
      }
      if (at < sinceMs) continue;
      hits.push({
        source: "semantic",
        at: new Date(at).toISOString(),
        id: entry.id ?? null,
        text: String(entry.content ?? "").slice(0, 120),
      });
    }
  }

  // The write log records hashes, not text, so it can be counted in the window
  // but never matched. Printed as a count so "no text to match" is visible.
  if (existsSync(writeLogFile)) {
    present++;
    const { rows, unparseable: bad } = readJsonlRows(writeLogFile);
    unparseable += bad;
    scanned += rows.length;
    for (const entry of rows) {
      const at = toMs(entry.ts);
      if (at !== null && at >= sinceMs) writes++;
    }
  }

  if (present === 0) {
    return { name: "memory", state: "missing", scanned: `${memoryDir()} (no memory files)`, hits: [], count: 0 };
  }
  return {
    name: "memory",
    state: "ok",
    scanned: `${scanned} entries`,
    hits,
    count: hits.length,
    writes,
    semanticUndated,
    unparseable,
  };
}

function searchDoc(storeIds) {
  const reportPath = report === null ? null : isAbsolute(report) ? report : resolve(cwd, report);
  const root = gitOut("rev-parse", "--show-toplevel")?.trim() ?? null;
  if (root === null) {
    return { name: "doc", state: "missing", scanned: "not a git work tree", hits: [], count: 0 };
  }
  const baseResolves = gitRun("rev-parse", "--verify", "--quiet", `${base}^{commit}`).ok;
  if (!baseResolves) {
    return {
      name: "doc",
      state: "unreadable",
      scanned: `${root} (no ${base} ref to diff against)`,
      hits: [],
      count: 0,
    };
  }
  const changed = gitRun("diff", "--name-only", `${base}...HEAD`);
  if (!changed.ok) {
    return {
      name: "doc",
      state: "unreadable",
      scanned: `${root} (git diff could not read the branch: ${changed.reason})`,
      hits: [],
      count: 0,
    };
  }
  const changedFiles = changed.out.split("\n").filter(Boolean);
  const docFiles = changedFiles.filter((name) => /\.(md|mdx|markdown)$/i.test(name));
  // Markdown only: a doc line is the only kind this search classifies, and the
  // unfiltered diff of a docs repo carries fetched HTML and PDFs that would
  // exhaust the buffer without ever contributing a hit.
  const diffRun = gitRun(
    "diff",
    "--unified=0",
    `${base}...HEAD`,
    "--",
    "*.md",
    "*.mdx",
    "*.markdown",
  );
  if (!diffRun.ok) {
    return {
      name: "doc",
      state: "unreadable",
      scanned: `${root} (git diff could not read the added lines: ${diffRun.reason})`,
      hits: [],
      count: 0,
    };
  }
  const diff = diffRun.out;
  // One doc file can carry hundreds of matching lines in a long range, so the
  // unit of evidence is the file: its matching lines, and whether every one of
  // them points at a store (a projection) or carries the text itself.
  // git reports the resolved root while a caller may pass a path through a
  // symlinked temp dir (/var -> /private/var on macOS), so both sides are real.
  const realish = (value) => {
    try {
      return realpathSync(value);
    } catch {
      return resolve(value);
    }
  };
  const reportReal = reportPath === null ? null : realish(reportPath);
  const reportRel = reportReal === null ? null : reportReal.startsWith(`${root}/`)
    ? reportReal.slice(root.length + 1)
    : null;
  const byFile = new Map();
  let file = null;
  let excludedReport = 0;
  const namesStore = /\.pi\/agent\/braid|preferences\.(json|md)/i;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      file = line.slice(4).replace(/^b\//, "");
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const added = line.slice(1);
    if (file === null || !namesTerm(added)) continue;
    if (reportRel !== null && file === reportRel) {
      excludedReport++;
      continue;
    }
    // A projection is a line that either points at the store or quotes a rule
    // the store holds: the store is the truth and the doc line derives from it.
    const derived = namesStore.test(added) || storeIds.some((id) => added.includes(id));
    const entry = byFile.get(file) ?? { file, lines: 0, derived: 0, samples: [] };
    entry.lines++;
    if (derived) entry.derived++;
    if (entry.samples.length < 3) entry.samples.push({ derived, line: added.trim().slice(0, 160) });
    byFile.set(file, entry);
  }
  const hits = [...byFile.values()].map((entry) => {
    const kind = entry.derived === entry.lines ? "projection" : entry.derived === 0 ? "doc-line" : "mixed";
    return {
      file: entry.file,
      lines: entry.lines,
      kind,
      samples: entry.samples.map((sample) => ({ kind: sample.derived ? "projection" : "doc-line", line: sample.line })),
    };
  });
  hits.sort((a, b) => b.lines - a.lines);
  return {
    name: "doc",
    state: "ok",
    scanned:
      `${root} (${base}...HEAD: ${changedFiles.length} files changed, ${docFiles.length} docs)` +
      (excludedReport > 0 ? `, ${excludedReport} line(s) of the report itself excluded` : ""),
    hits,
    count: hits.length,
    docFiles,
  };
}

function searchStore() {
  const file = preferences.preferencesFilePath();
  if (!existsSync(file)) {
    return { name: "store", state: "missing", scanned: `${file} (absent)`, hits: [], count: 0 };
  }
  const read = preferences.readPreferences(file);
  if (!read.ok) {
    return {
      name: "store",
      state: "unreadable",
      scanned: `${file} (${preferences.describeStoreRefusal(read)})`,
      hits: [],
      count: 0,
    };
  }
  const hits = [];
  let undated = 0;
  for (const entry of read.entries) {
    if (!namesTerm([entry.id, entry.rule].filter(Boolean).join(" "))) continue;
    const day = typeof entry.since === "string" ? entry.since.slice(0, 10) : null;
    if (day === null) {
      undated++;
      continue;
    }
    if (day < sinceDay) continue;
    hits.push({
      id: entry.id,
      surface: entry.surface ?? null,
      since: day,
      rule: String(entry.rule ?? "").slice(0, 140),
    });
  }
  return {
    name: "store",
    state: "ok",
    scanned: `${read.entries.length} rules in ${file}`,
    hits,
    count: hits.length,
    undated,
    ids: read.entries.map((entry) => String(entry.id ?? "")).filter(Boolean),
  };
}

const storeSearch = searchStore();
const docSearch = searchDoc(storeSearch.ids ?? []);
searches.push(searchJournal(), searchMemory(), docSearch, storeSearch);

// ── verdict ─────────────────────────────────────────────────────────────────

const failed = searches.filter((search) => search.state === "unreadable");
if (failed.length > 0) {
  if (json) {
    console.log(JSON.stringify({ wave, since: new Date(sinceMs).toISOString(), terms, searches, verdict: "cannot-answer" }, null, 2));
  } else {
    console.error(`Sink check: cannot answer for ${wave} - ${failed.map((s) => s.name).join(", ")} could not be read; an unread search cannot say "no trace"`);
    for (const search of failed) console.error(`  ${search.name}: ${search.scanned}`);
  }
  process.exit(EXIT_CANNOT_RUN);
}

const hitSearches = searches.filter((search) => search.count > 0);
const docHits = searches.find((search) => search.name === "doc")?.hits ?? [];
const storeHits = searches.find((search) => search.name === "store")?.hits ?? [];
const storeReached = storeHits.length > 0;
const docIsProjectionOnly =
  docHits.length > 0 && docHits.every((hit) => hit.kind === "projection");

const reportRow = report === null ? null : {
  path: isAbsolute(report) ? report : resolve(cwd, report),
  written: existsSync(isAbsolute(report) ? report : resolve(cwd, report))
    ? bytesOf(isAbsolute(report) ? report : resolve(cwd, report))
    : null,
};

if (json) {
  console.log(
    JSON.stringify(
      {
        wave,
        since: new Date(sinceMs).toISOString(),
        terms,
        report: reportRow,
        searches,
        verdict: hitSearches.length > 0 ? "reached" : "refused",
        sinks: hitSearches.map((search) => search.name),
        docIsProjectionOnly,
      },
      null,
      2,
    ),
  );
} else {
  console.log(`Sink check - ${wave} since ${new Date(sinceMs).toISOString()}`);
  console.log(`terms: ${terms.join(", ")}`);
  if (reportRow !== null) {
    console.log(
      `report: ${reportRow.written === null ? `not written ${reportRow.path}` : `${reportRow.written} bytes ${reportRow.path}`}`,
    );
  }
  console.log("");
  for (const search of searches) {
    console.log(`${search.name.padEnd(8)} ${search.count} hit(s) — scanned ${search.scanned}`);
    for (const hit of search.hits.slice(0, 5)) {
      if (search.name === "journal") console.log(`         seq ${hit.seq} ${hit.at} ${hit.subject}`);
      else if (search.name === "memory") console.log(`         ${hit.source} ${hit.at} ${hit.id ?? ""}: ${hit.text}`);
      else if (search.name === "doc")
        console.log(
          `         ${hit.kind} ${hit.file} (${hit.lines} line${hit.lines === 1 ? "" : "s"}): ${hit.samples[0]?.line ?? ""}`,
        );
      else console.log(`         rule "${hit.id}" since ${hit.since} (${hit.surface ?? "unbound"})`);
    }
    if (search.hits.length > 5) console.log(`         ... and ${search.hits.length - 5} more file(s)`);
    if (search.unparseable > 0) console.log(`         ${search.unparseable} unparseable line(s) skipped`);
    if (search.writes !== undefined) console.log(`         ${search.writes} write-log rows in the window (hashes only, no text to match)`);
    if (search.semanticUndated > 0) console.log(`         ${search.semanticUndated} semantic match(es) carry no timestamp: undated, not counted`);
    if (search.undated > 0) console.log(`         ${search.undated} matching rule(s) carry no since date: undated, not counted`);
  }
  if (storeReached && docIsProjectionOnly) {
    console.log("\nthe rule reached the store; the doc line is a projection that points at it, not a second copy");
  }
}

if (hitSearches.length === 0) {
  console.error(`\nREFUSED: no trace of ${wave} in any sink since ${new Date(sinceMs).toISOString()}`);
  console.error("  the work left no journal entry, no memory entry, no doc line and no store rule");
  process.exit(EXIT_REFUSED);
}
console.log(`\nSINK REACHED: ${hitSearches.map((search) => `${search.name} ${search.count}`).join(", ")}`);
process.exit(EXIT_REACHED);
