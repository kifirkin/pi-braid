#!/usr/bin/env node
// check-boot.mjs - the seven facts a cold seat would otherwise rediscover by
// hand, printed in one read-only command.
//
// The failure this closes was measured on a real session start: finding the
// journal, the memory stores, the scratchpad, the handoff, the fleet, the
// skills catalog and the corpus index took minutes, and an empty store printed
// the same silence as a store that had never been written. The seat's first
// action depends on telling those apart, so every row prints existence AND a
// size, and `empty` is a printed fact rather than a failure.
//
//   node packages/core/scripts/check-boot.mjs [--cwd <dir>] [--json]
//        [--brief <path>] [--skills-root <dir>]...
//        [--skip <step>]... --reason <text> [--require <step>]...
//
// Three headings, each row one store or one environment fact:
//
//   environment  braid home, git (root/branch/HEAD/dirty/commits), skills
//                catalog reachability, corpus index shards
//   project      journal, memory (episodes, semantic, write log), scratchpad,
//                handoff, fleet, dox walk (AGENTS.md from cwd to the git root)
//   task         the live fleet rows' output files, the brief when named, and
//                every declared skip with its reason
//
// Verdicts:
//   exit 0  every step produced a fact. An empty or missing store is a fact.
//   exit 1  a store could not be read, or a step named with --require produced
//           nothing while no skip was declared for it.
//   exit 2  usage, or a tree with no build: the paths and the store contracts
//           come from dist/, never re-derived, because a second slug rule is
//           how a writer and a reader stop naming the same file.
//
// Read-only: this script writes nothing, creates nothing and repairs nothing.

import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CORE_PKG = resolve(__dirname, "..");
const DIST = join(CORE_PKG, "dist");

const EXIT_OK = 0;
const EXIT_FAILED = 1;
const EXIT_CANNOT_RUN = 2;

const USAGE = `Usage: node packages/core/scripts/check-boot.mjs [options]

  --cwd <dir>          project the rows describe (default: process cwd)
  --brief <path>       the work's brief, printed under "task"
  --skills-root <dir>  extra skills root to count (repeatable)
  --skip <step>        do not run this step; needs --reason
  --reason <text>      why the skipped steps were skipped
  --require <step>     this step must produce something (empty/missing fails)
  --json               print the rows as JSON

Steps: home, git, skills, corpus, journal, memory, scratchpad, handoff, fleet,
dox, owed, brief. A section name (environment, project, task) matches its rows.`;

// ── arguments ───────────────────────────────────────────────────────────────

function usageError(message) {
  console.error(`Boot check: cannot run - ${message}`);
  console.error(USAGE);
  process.exit(EXIT_CANNOT_RUN);
}

const argv = process.argv.slice(2);
let cwd = process.cwd();
let brief = null;
let reason = null;
let json = false;
const skipSteps = [];
const requireSteps = [];
const extraSkillsRoots = [];

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--cwd") {
    const v = argv[++i];
    if (!v) usageError("--cwd needs a directory");
    cwd = isAbsolute(v) ? v : resolve(process.cwd(), v);
  } else if (a === "--brief") {
    brief = argv[++i] ?? null;
    if (!brief) usageError("--brief needs a path");
  } else if (a === "--skills-root") {
    const v = argv[++i];
    if (!v) usageError("--skills-root needs a directory");
    extraSkillsRoots.push(resolve(v));
  } else if (a === "--skip") {
    const v = argv[++i];
    if (!v) usageError("--skip needs a step name");
    skipSteps.push(v);
  } else if (a === "--reason") {
    reason = argv[++i] ?? null;
    if (!reason) usageError("--reason needs text");
  } else if (a === "--require") {
    const v = argv[++i];
    if (!v) usageError("--require needs a step name");
    requireSteps.push(v);
  } else if (a === "--json") {
    json = true;
  } else if (a === "--help" || a === "-h") {
    console.log(USAGE);
    process.exit(EXIT_OK);
  } else {
    usageError(`unknown argument ${a}`);
  }
}

if (skipSteps.length > 0 && (reason === null || reason.trim() === "")) {
  usageError(
    `--skip ${skipSteps.join(", ")} carries no reason; a skip that does not say why is a silent hole, which is the failure this instrument exists to close`,
  );
}
if (!existsSync(cwd)) usageError(`--cwd does not exist: ${cwd}`);

// ── the built modules (single source for every path and entry contract) ─────

async function loadDist(relative) {
  const file = join(DIST, relative);
  if (!existsSync(file)) {
    console.error(
      `Boot check: cannot run - the built module ${relative} is missing (no build in ${DIST}).`,
    );
    console.error(
      "  Run `npm run build` first: the paths this check prints come from the same module braid writes them with, so a copy here could name a different file.",
    );
    process.exit(EXIT_CANNOT_RUN);
  }
  return import(`${new URL(`file://${file}`).href}`);
}

const paths = await loadDist(join("lib", "config", "braid-paths.js"));
const scratchpadModule = await loadDist(
  join("extensions", "memory", "scratchpad", "persistence.js"),
);

const {
  braidDir,
  corpusIndexDir,
  episodesFilePath,
  getWorkersFilePath,
  journalFilePath,
  journalRotatedFiles,
  memoryDir,
  scratchpadDir,
  semanticMemoryFilePath,
} = paths;
const { projectSlugFromCwd } = scratchpadModule;

// ── small readers ───────────────────────────────────────────────────────────

const bytesOf = (file) => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

const human = (bytes) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

/** Milliseconds since epoch for a number, an ISO string or a Date; null if unusable. */
function toMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

const isoOf = (ms) => (ms === null ? "unknown" : new Date(ms).toISOString().replace(".000Z", "Z"));

/** One JSONL file, split into parsed rows and the count this reader could not parse. */
function readJsonl(file) {
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
  return { rows, unparseable, bytes: Buffer.byteLength(text) };
}

/** A JSON document; a document that does not parse is a store that cannot be read. */
function readJson(file) {
  const text = readFileSync(file, "utf-8");
  return { value: JSON.parse(text), bytes: Buffer.byteLength(text) };
}

// maxBuffer raised: a large dirty tree makes `git status --porcelain` long, and
// a truncated read would understate the dirty count.
const git = (...args) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
const gitOut = (...args) => {
  const r = git(...args);
  return r.status === 0 ? r.stdout.trim() : null;
};

// ── rows ────────────────────────────────────────────────────────────────────

const rows = [];

/** The skip that covers a step id: its own, or its section's. */
const skipFor = (id, section) =>
  skipSteps.find((s) => s === id || s === section) ?? null;

/**
 * Run one step as a row. Throwing inside `fn` marks the row unreadable, which
 * is the one state that fails a default run: an empty store and a missing
 * store are printed facts, a store that will not open is not.
 */
function step(id, section, label, fn) {
  const skipped = skipFor(id, section);
  if (skipped) {
    rows.push({
      id,
      section,
      label,
      state: "skipped",
      detail: `skipped - ${reason.trim()}`,
      data: { skipped: true, reason: reason.trim() },
    });
    return;
  }
  try {
    const result = fn();
    rows.push({ id, section, label, ...result });
  } catch (error) {
    rows.push({
      id,
      section,
      label,
      state: "unreadable",
      detail: error.message,
      data: { error: error.message },
    });
  }
}

// ── environment ─────────────────────────────────────────────────────────────

step("home", "environment", "braid home", () => {
  const dir = braidDir();
  if (!existsSync(dir)) {
    return { state: "missing", detail: `${dir} (nothing written yet)`, data: { path: dir } };
  }
  const entries = readdirSync(dir).length;
  return {
    state: "ok",
    detail: `${dir} (${entries} top-level entries)`,
    data: { path: dir, topLevelEntries: entries },
  };
});

step("git", "environment", "git", () => {
  const root = gitOut("rev-parse", "--show-toplevel");
  if (root === null) {
    return { state: "missing", detail: "not a git work tree", data: { repo: false } };
  }
  const branch = gitOut("rev-parse", "--abbrev-ref", "HEAD") ?? "unknown";
  const head = gitOut("rev-parse", "--short", "HEAD");
  const commits = gitOut("rev-list", "--count", "HEAD");
  const dirty = (gitOut("status", "--porcelain") ?? "")
    .split("\n")
    .filter(Boolean).length;
  if (head === null) {
    return {
      state: "empty",
      detail: `${root} @ ${branch}, no commits (no history to read), ${dirty} uncommitted`,
      data: { root, branch, head: null, commits: 0, dirty },
    };
  }
  return {
    state: "ok",
    detail: `${root} @ ${branch} ${head}, ${commits} commits, ${dirty} uncommitted`,
    data: { root, branch, head, commits: Number(commits), dirty },
  };
});

/** Every SKILL.md under a root, at most four levels deep: skills are shallow by construction. */
function skillFiles(root) {
  const found = [];
  const walk = (dir, depth) => {
    if (depth > 4) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.name === "SKILL.md") found.push(full);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * The catalog roots this check counts. A checkout is counted from its own
 * packages (never doubled by the installed copies beside them); an installed
 * tree is counted from the core package, its sibling packages and the
 * machine-local directory. `pi` owns the runtime catalog count in the prompt;
 * this row is the derived file-level answer to "are those files reachable".
 */
function skillsRoots() {
  const roots = [{ path: join(CORE_PKG, "skills"), source: "core set" }];
  const monorepoPack = join(CORE_PKG, "..", "..", "packages", "skills", "skills");
  if (existsSync(monorepoPack)) {
    roots.push({ path: monorepoPack, source: "on-demand pack" });
  } else {
    const parent = resolve(CORE_PKG, "..");
    for (const name of readdirSync(parent)) {
      if (name === "pi-braid") continue;
      const candidate = join(parent, name, "skills");
      if (existsSync(candidate)) roots.push({ path: candidate, source: `package ${name}` });
    }
  }
  const home = process.env.HOME ?? "";
  if (home) roots.push({ path: join(home, ".pi", "agent", "skills"), source: "machine-local" });
  for (const extra of extraSkillsRoots) roots.push({ path: extra, source: "declared" });
  return roots;
}

step("skills", "environment", "skills", () => {
  const roots = skillsRoots();
  const seen = new Map();
  const perRoot = [];
  const unreachable = [];
  let files = 0;
  let bytes = 0;
  for (const root of roots) {
    if (!existsSync(root.path)) {
      unreachable.push(root.path);
      perRoot.push(`${root.source}: absent`);
      continue;
    }
    let found;
    try {
      found = skillFiles(root.path);
    } catch (error) {
      unreachable.push(`${root.path} (${error.code ?? error.message})`);
      perRoot.push(`${root.source}: unreadable`);
      continue;
    }
    let rootBytes = 0;
    for (const file of found) {
      const real = realpathSync(file);
      if (seen.has(real)) continue;
      seen.set(real, true);
      files++;
      const size = bytesOf(file);
      bytes += size;
      rootBytes += size;
    }
    perRoot.push(`${root.source} ${found.length}/${human(rootBytes)}`);
  }
  const detail =
    `${files} SKILL.md reachable, ${human(bytes)} (${perRoot.join("; ")})` +
    (unreachable.length > 0 ? ` - unreachable: ${unreachable.join(", ")}` : "");
  return {
    state: files > 0 ? "ok" : "empty",
    detail: `${detail} [derived from files; pi owns the runtime count]`,
    data: { files, bytes, roots: perRoot, unreachable },
  };
});

step("corpus", "environment", "corpus index", () => {
  const dir = corpusIndexDir();
  if (!existsSync(dir)) {
    return { state: "missing", detail: `${dir} (not built)`, data: { path: dir } };
  }
  const shards = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  if (shards.length === 0) {
    return { state: "empty", detail: `${dir} (0 shards)`, data: { path: dir, shards: 0 } };
  }
  let bytes = 0;
  let newest = 0;
  for (const name of shards) {
    const file = join(dir, name);
    bytes += bytesOf(file);
    try {
      newest = Math.max(newest, statSync(file).mtimeMs);
    } catch {
      /* a shard that vanished mid-read is counted by size 0 */
    }
  }
  const ageDays = Math.floor((Date.now() - newest) / 86_400_000);
  return {
    state: "ok",
    detail: `${shards.length} shards, ${human(bytes)}, newest ${isoOf(newest)} (${ageDays}d old)`,
    data: { path: dir, shards: shards.length, bytes, newest: isoOf(newest), ageDays },
  };
});

// ── project ─────────────────────────────────────────────────────────────────

const slug = projectSlugFromCwd(cwd);

step("journal", "project", "journal", () => {
  const file = journalFilePath(slug);
  const rotated = journalRotatedFiles(file);
  const files = [file, ...rotated];
  const present = files.filter((f) => existsSync(f));
  if (present.length === 0) {
    return {
      state: "missing",
      detail: `${file} (no journal for ${slug})`,
      data: { slug, file, entries: 0 },
    };
  }
  let entries = 0;
  let unparseable = 0;
  let bytes = 0;
  let newest = null;
  for (const f of present) {
    const read = readJsonl(f);
    entries += read.rows.length;
    unparseable += read.unparseable;
    bytes += read.bytes;
    for (const row of read.rows) {
      const ms = toMs(row.at);
      if (ms !== null && (newest === null || ms > newest)) newest = ms;
    }
  }
  // The schema verdict belongs to check-journal: it duplicates the writer's
  // schema on purpose, and a third copy here would be one more thing to drift.
  // So the gate is run and its own summary line is quoted, exit code included.
  // A finding does NOT fail this row: the boot check reports, the gate refuses.
  const gateFile = join(__dirname, "check-journal.mjs");
  let gate = null;
  if (existsSync(gateFile)) {
    const run = spawnSync(process.execPath, [gateFile, "--digest", "--cwd", cwd], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    });
    const line = (run.stdout ?? "").split("\n").find((l) => l.startsWith("findings: "));
    gate = { exit: run.status, findings: line ?? null };
  }

  const state = entries === 0 ? "empty" : "ok";
  return {
    state,
    detail:
      `${entries} entries, ${human(bytes)}, newest ${isoOf(newest)}` +
      (rotated.length > 0 ? ` (+${rotated.length} rotated)` : "") +
      (unparseable > 0 ? `, ${unparseable} unparseable line(s)` : "") +
      (gate === null
        ? ""
        : gate.findings === null
          ? `, schema gate exit ${gate.exit}`
          : `\n      schema gate (exit ${gate.exit}): ${gate.findings.replace(/^findings: /, "")}`),
    data: { slug, file, files: present, entries, unparseable, bytes, newest: isoOf(newest), gate },
  };
});

step("memory", "project", "memory", () => {
  const episodesFile = episodesFilePath();
  const semanticFile = semanticMemoryFilePath();
  const writeLogFile = join(memoryDir(), "write-log.jsonl");
  const pieces = [];
  const data = {};

  if (existsSync(episodesFile)) {
    const read = readJsonl(episodesFile);
    let newest = null;
    for (const row of read.rows) {
      const ms = toMs(row.timestamp);
      if (ms !== null && (newest === null || ms > newest)) newest = ms;
    }
    pieces.push(
      `episodes ${read.rows.length}/${human(read.bytes)}, newest ${isoOf(newest)}` +
        (read.unparseable > 0 ? `, ${read.unparseable} unparseable` : ""),
    );
    data.episodes = { file: episodesFile, entries: read.rows.length, bytes: read.bytes, newest: isoOf(newest) };
  } else {
    pieces.push("episodes absent");
    data.episodes = { file: episodesFile, missing: true };
  }

  if (existsSync(semanticFile)) {
    const read = readJson(semanticFile);
    const memories = Array.isArray(read.value?.memories) ? read.value.memories : [];
    pieces.push(`semantic ${memories.length}/${human(read.bytes)}`);
    data.semantic = { file: semanticFile, entries: memories.length, bytes: read.bytes };
  } else {
    pieces.push("semantic absent");
    data.semantic = { file: semanticFile, missing: true };
  }

  if (existsSync(writeLogFile)) {
    const read = readJsonl(writeLogFile);
    let newest = null;
    for (const row of read.rows) {
      const ms = toMs(row.ts);
      if (ms !== null && (newest === null || ms > newest)) newest = ms;
    }
    pieces.push(`write log ${read.rows.length}/${human(read.bytes)}, newest ${isoOf(newest)}`);
    data.writeLog = { file: writeLogFile, entries: read.rows.length, bytes: read.bytes, newest: isoOf(newest) };
  } else {
    pieces.push("write log absent");
    data.writeLog = { file: writeLogFile, missing: true };
  }

  const anyEntries =
    (data.episodes.entries ?? 0) + (data.semantic.entries ?? 0) + (data.writeLog.entries ?? 0);
  return { state: anyEntries > 0 ? "ok" : "empty", detail: pieces.join("; "), data };
});

step("scratchpad", "project", "scratchpad", () => {
  const dir = join(scratchpadDir(), slug);
  const events = join(dir, "events.jsonl");
  if (!existsSync(events)) {
    return { state: "missing", detail: `${dir} (no scratchpad for ${slug})`, data: { slug, dir } };
  }
  const read = readJsonl(events);
  const last = read.rows;
  const state = last.length > 0 ? last[last.length - 1]?.state ?? null : null;
  if (state === null) {
    return { state: "empty", detail: `${events} (${human(read.bytes)}, no state line)`, data: { slug, dir, bytes: read.bytes } };
  }
  const plan = Array.isArray(state.plan) ? state.plan : [];
  const open = plan.filter((item) => item.done !== true && !item.doneTurn);
  const doneRows = Array.isArray(state.done) ? state.done.length : 0;
  const goal = typeof state.goal === "string" ? state.goal.replace(/\s+/g, " ").trim() : "(no goal)";
  return {
    state: "ok",
    detail:
      `${open.length} open of ${plan.length} plan items, ${doneRows} done, ${human(read.bytes)}\n` +
      `      goal: ${goal.length > 160 ? `${goal.slice(0, 157)}...` : goal}`,
    data: { slug, dir, bytes: read.bytes, goal, openPlans: open.length, plan: plan.length, done: doneRows },
  };
});

step("handoff", "project", "handoff", () => {
  const file = join(braidDir(), "sessions", slug, "resume.json");
  if (!existsSync(file)) {
    return { state: "missing", detail: `${file} (no resume file written yet)`, data: { file } };
  }
  const read = readJson(file);
  const openPlans = Array.isArray(read.value?.openPlans) ? read.value.openPlans.length : 0;
  const writtenAt = read.value?.writtenAt ?? null;
  const goal = typeof read.value?.goal === "string" ? read.value.goal.replace(/\s+/g, " ").trim() : "(no goal)";
  const age = toMs(writtenAt);
  const ageDays = age === null ? null : Math.floor((Date.now() - age) / 86_400_000);
  return {
    state: "ok",
    detail:
      `${human(read.bytes)}, written ${writtenAt ?? "unknown"}` +
      (ageDays === null ? "" : ` (${ageDays}d old)`) +
      `, ${openPlans} open plans\n      goal: ${goal.length > 160 ? `${goal.slice(0, 157)}...` : goal}`,
    data: { file, bytes: read.bytes, writtenAt, openPlans, goal },
  };
});

/**
 * The registry's stored lifecycle vocabulary. A row is live when a seat is on
 * it now; `error`, `stalled` and `false-done` are terminal but resumable, which
 * is a different fact from live and from finished, so the row counts them apart.
 */
const LIVE_STATUSES = new Set(["admitted", "working"]);
const RESUMABLE_STATUSES = new Set(["error", "stalled", "false-done"]);

step("fleet", "project", "fleet", () => {
  const file = getWorkersFilePath(cwd);
  if (!existsSync(file)) {
    return { state: "missing", detail: `${file} (no worker registry yet)`, data: { file } };
  }
  const read = readJson(file);
  const workers = read.value?.workers ?? {};
  const all = Object.values(workers);
  const live = all.filter((row) => LIVE_STATUSES.has(row?.status));
  const resumable = all.filter((row) => RESUMABLE_STATUSES.has(row?.status));
  const byStatus = {};
  for (const row of live) byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  const tally = Object.entries(byStatus)
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  const shown = live.slice(0, 8).map((row) => {
    const branch = row.branch ? ` ${row.branch}` : "";
    const output = row.outputFile ? ` -> ${row.outputFile}` : "";
    return `\n      ${row.workerId} [${row.status}]${branch}${output}`;
  });
  return {
    state: live.length > 0 ? "ok" : "empty",
    detail:
      `${live.length} live of ${all.length} rows, ${human(read.bytes)}` +
      (tally ? ` (${tally})` : "") +
      (resumable.length > 0 ? `, ${resumable.length} resumable (error/stalled/false-done)` : "") +
      shown.join("") +
      (live.length > 8 ? `\n      ... and ${live.length - 8} more` : ""),
    data: {
      file,
      bytes: read.bytes,
      total: all.length,
      live: live.length,
      byStatus,
      resumable: resumable.length,
      rows: live.map((r) => ({
        workerId: r.workerId,
        status: r.status,
        branch: r.branch ?? null,
        outputFile: r.outputFile ?? null,
      })),
    },
  };
});

step("dox", "project", "dox walk", () => {
  // git reports the resolved root, and on macOS /var is a symlink to
  // /private/var, so a lexical compare never reaches it and the walk runs to
  // the filesystem root. Both sides are real paths for the same reason.
  const real = (dir) => {
    try {
      return realpathSync(dir);
    } catch {
      return resolve(dir);
    }
  };
  const root = gitOut("rev-parse", "--show-toplevel");
  const stopAt = root === null ? null : real(root.trim());
  const stops = [];
  let current = real(cwd);
  for (let depth = 0; depth <= 8; depth++) {
    const agents = join(current, "AGENTS.md");
    stops.push({
      dir: current,
      agents: existsSync(agents) ? bytesOf(agents) : null,
    });
    if (stopAt !== null && current === stopAt) break;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const present = stops.filter((stop) => stop.agents !== null).length;
  const detail = stops
    .map((stop) => `${stop.dir === real(cwd) ? "." : stop.dir}: ${stop.agents === null ? "absent" : `AGENTS.md ${human(stop.agents)}`}`)
    .join("\n      ");
  return {
    state: present > 0 ? "ok" : "empty",
    detail: `${present}/${stops.length} levels carry AGENTS.md\n      ${detail}`,
    data: { stops: stops.map((s) => ({ dir: s.dir, agentsBytes: s.agents })), present, root: stopAt },
  };
});

// ── task ────────────────────────────────────────────────────────────────────

step("owed", "task", "owed", () => {
  const file = getWorkersFilePath(cwd);
  if (!existsSync(file)) {
    return { state: "missing", detail: "no worker registry: nothing is owed by a fleet row", data: {} };
  }
  const read = readJson(file);
  const live = Object.values(read.value?.workers ?? {}).filter((row) =>
    LIVE_STATUSES.has(row?.status),
  );
  if (live.length === 0) {
    return { state: "empty", detail: "0 live rows: nothing is owed by a fleet row", data: { owed: 0 } };
  }
  const owed = live.map((row) => {
    const output = row.outputFile ?? null;
    const exists = output !== null && existsSync(output);
    return {
      workerId: row.workerId,
      status: row.status,
      outputFile: output,
      written: exists ? bytesOf(output) : null,
    };
  });
  const detail = owed
    .map((row) =>
      row.outputFile === null
        ? `${row.workerId}: no output file declared`
        : `${row.workerId}: ${row.written === null ? "not written" : human(row.written)} ${row.outputFile}`,
    )
    .join("\n      ");
  return { state: "ok", detail, data: { owed } };
});

step("brief", "task", "brief", () => {
  if (brief === null) {
    return {
      state: "missing",
      detail: "not named (pass --brief <path>; nothing is assumed about which brief this seat runs)",
      data: { named: false },
    };
  }
  const file = isAbsolute(brief) ? brief : resolve(cwd, brief);
  if (!existsSync(file)) {
    return { state: "missing", detail: `${file} (named but absent)`, data: { file } };
  }
  return { state: "ok", detail: `${human(bytesOf(file))} ${file}`, data: { file, bytes: bytesOf(file) } };
});

// A declared skip that names no step is a typo, and a typo here would print a
// green run with the step it was meant to hide still unsuppressed.
const ids = new Set(rows.map((row) => row.id));
const sections = new Set(rows.map((row) => row.section));
for (const named of [...skipSteps, ...requireSteps]) {
  if (!ids.has(named) && !sections.has(named)) {
    usageError(`"${named}" names no step or section in this check (steps: ${[...ids].join(", ")})`);
  }
}

// ── verdict ─────────────────────────────────────────────────────────────────

const unreadable = rows.filter((row) => row.state === "unreadable");
const requiredButEmpty = [];
for (const named of requireSteps) {
  const matching = rows.filter((row) => row.id === named || row.section === named);
  for (const row of matching) {
    // A declared skip satisfies a requirement: the rule is "produced nothing
    // AND no skip declared", and the skip is exactly the declaration.
    if (row.state === "empty" || row.state === "missing") requiredButEmpty.push(row);
  }
}

// ── print ───────────────────────────────────────────────────────────────────

if (json) {
  console.log(
    JSON.stringify(
      {
        cwd,
        slug,
        braidHome: braidDir(),
        rows,
        skipped: skipSteps.length > 0 ? { steps: skipSteps, reason } : null,
        unreadable: unreadable.map((row) => ({ id: row.id, detail: row.detail })),
        requiredButEmpty: requiredButEmpty.map((row) => ({ id: row.id, state: row.state })),
      },
      null,
      2,
    ),
  );
} else {
  const width = Math.max(...rows.map((row) => row.label.length));
  console.log(`Boot check - ${cwd}`);
  console.log(`project slug: ${slug}`);
  let section = null;
  for (const row of rows) {
    if (row.section !== section) {
      section = row.section;
      console.log(`\n${section}`);
    }
    console.log(`  ${row.label.padEnd(width)}  ${row.detail}`);
  }
  if (skipSteps.length > 0) {
    console.log(`\ndeclared skips: ${skipSteps.join(", ")} - ${reason}`);
  }
}

if (unreadable.length > 0) {
  console.error(
    `\nFAIL: ${unreadable.length} store(s) could not be read: ${unreadable.map((row) => row.id).join(", ")}`,
  );
  process.exit(EXIT_FAILED);
}
if (requiredButEmpty.length > 0) {
  console.error(
    `\nFAIL: required step(s) produced nothing and declared no skip: ${requiredButEmpty
      .map((row) => `${row.id} (${row.state})`)
      .join(", ")}`,
  );
  process.exit(EXIT_FAILED);
}
process.exit(EXIT_OK);
