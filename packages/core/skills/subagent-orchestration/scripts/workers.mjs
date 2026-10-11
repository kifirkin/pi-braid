#!/usr/bin/env node
/**
 * Worker status at a glance.
 *
 * Replaces the hand-rolled per-worker loops: one call answers "what is every
 * worker doing, and is anything wrong with it" from evidence rather than from
 * the registry's own claim about itself.
 *
 *   node workers.mjs                  live workers in the cwd's registry
 *   node workers.mjs <id> <id>        only these
 *   node workers.mjs --all            include closed
 *   node workers.mjs --repo <path>    another repo's registry
 *   node workers.mjs --json           machine-readable
 *   node workers.mjs --stale <min>    age after which 'working' is flagged (default 15)
 *
 * What it reads, and why each one is separate evidence:
 *   registry   the claim (status, session path, deliverable, branch)
 *   session    mtime + event count — the only proof a worker is still moving
 *   git        commits ahead of the base and dirty count, from the real tree
 *   output     whether the deliverable exists on disk, and its size
 *
 * A worker is never reported healthy on the registry's word alone. The
 * registry says 'working' long after a pane died, and says 'admitted' for a
 * worker that has been running for an hour.
 */

import { readFileSync, existsSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, basename, resolve } from "node:path";
import { homedir } from "node:os";

const REGISTRY_ROOT = join(homedir(), ".pi", "agent", "braid", "projects");

function sanitize(p) {
  return resolve(p).replace(/[/.]/g, "-").replace(/^-/, "");
}

function git(args, cwd) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** Branch -> worktree path, from git's own porcelain listing. */
function worktrees(repo) {
  const out = git(["worktree", "list", "--porcelain"], repo);
  const map = new Map();
  if (!out) return map;
  let path = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9).trim();
    else if (line.startsWith("branch ") && path) {
      map.set(
        line
          .slice(7)
          .trim()
          .replace(/^refs\/heads\//, ""),
        path,
      );
    } else if (line.startsWith("detached") && path) {
      map.set(`(detached@${path})`, path);
    }
  }
  return map;
}

function fmtAge(ms) {
  if (ms == null) return "   -";
  const m = Math.floor(ms / 60000);
  if (m < 1) return "  <1m";
  if (m < 60) return `${String(m).padStart(3)}m`;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(3)}h`;
}

function fmtSize(bytes) {
  if (bytes == null) return "    -";
  if (bytes < 1024) return `${bytes}B`.padStart(5);
  return `${(bytes / 1024).toFixed(1)}K`.padStart(5);
}

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Set();
const ids = [];
let repo = process.cwd();
let staleMin = 15;

for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === "--repo") repo = resolve(argv[++i]);
  else if (a === "--stale") staleMin = Number(argv[++i]);
  else if (a.startsWith("--")) flags.add(a.slice(2));
  else ids.push(a);
}
const showAll = flags.has("all");
const asJson = flags.has("json");

// ── registry ────────────────────────────────────────────────────────────────
const regPath = join(REGISTRY_ROOT, sanitize(repo), "workers.json");
if (!existsSync(regPath)) {
  console.error(`no registry for ${repo}`);
  console.error(`  looked in ${regPath}`);
  console.error(`  pass --repo <repo root>, or run from one of:`);
  console.error(`    ${readdirSafe()}`);
  process.exit(2);
}
function readdirSafe() {
  try {
    return execFileSync("ls", [REGISTRY_ROOT], { encoding: "utf8" })
      .trim()
      .split("\n")
      .join(", ");
  } catch {
    return "(unreadable)";
  }
}

const reg = JSON.parse(readFileSync(regPath, "utf8"));
const all = Object.values(reg.workers ?? {});
const CLOSED = new Set([
  "completed",
  "error",
  "stalled",
  "false-done",
  "closed",
  "merged",
]);

let rows = all;
if (ids.length) rows = all.filter((w) => ids.includes(w.workerId));
else if (!showAll) rows = all.filter((w) => !CLOSED.has(w.status));

rows.sort((a, b) => {
  const n = (s) => Number(String(s).replace(/\D/g, "")) || 0;
  return (
    n(a.workerId) - n(b.workerId) ||
    String(a.workerId).localeCompare(b.workerId)
  );
});

if (!rows.length) {
  const live = all.filter((w) => !CLOSED.has(w.status)).length;
  console.log(
    `no workers match (registry has ${all.length} entries, ${live} live)`,
  );
  process.exit(0);
}

// ── evidence per worker ─────────────────────────────────────────────────────
const wt = worktrees(repo);
const base = git(["rev-parse", "--abbrev-ref", "HEAD"], repo) ?? "main";
const now = Date.now();

const out = rows.map((w) => {
  const r = {
    id: w.workerId,
    spec: w.spec,
    status: w.status,
    ageMs: null,
    events: null,
    commits: null,
    dirty: null,
    reportBytes: null,
    deliverable: w.outputFile ? basename(w.outputFile) : null,
    branch: w.branch ?? null,
    pane: w.pane ?? null,
    flags: [],
  };

  // session: the only proof of motion
  if (w.workerSession && existsSync(w.workerSession)) {
    const st = statSync(w.workerSession);
    r.ageMs = now - st.mtimeMs;
    try {
      r.events = readFileSync(w.workerSession, "utf8")
        .split("\n")
        .filter(Boolean).length;
    } catch {
      // An existing file that cannot be read is a different failure mode from
      // a missing one: the worker may be moving, but its evidence is not.
      r.flags.push("SESSION-UNREADABLE");
    }
  } else if (!CLOSED.has(w.status)) {
    r.flags.push("NO-SESSION");
  }

  // git: real tree state
  const tree = (w.branch && wt.get(w.branch)) || null;
  if (tree && existsSync(tree)) {
    const ahead = git(["rev-list", "--count", `${base}..HEAD`], tree);
    r.commits = ahead == null ? null : Number(ahead);
    const dirty = git(["status", "--porcelain"], tree);
    r.dirty = dirty == null ? null : dirty.split("\n").filter(Boolean).length;
  }

  // deliverable
  if (w.outputFile && existsSync(w.outputFile)) {
    r.reportBytes = statSync(w.outputFile).size;
  }

  // flags — the failure modes that cost real time tonight
  if (r.events != null && r.events < 3 && !CLOSED.has(w.status))
    r.flags.push("NOT-FIRED");
  if (r.ageMs != null && r.ageMs > staleMin * 60000 && !CLOSED.has(w.status)) {
    r.flags.push(`STALE>${staleMin}m`);
  }
  if (!CLOSED.has(w.status) && r.reportBytes != null)
    r.flags.push("REPORT-READY");
  if (CLOSED.has(w.status) && w.outputFile && !existsSync(w.outputFile)) {
    r.flags.push("FALSE-DONE");
  }
  return r;
});

// ── output ──────────────────────────────────────────────────────────────────
if (asJson) {
  console.log(JSON.stringify({ repo, base, workers: out }, null, 2));
  process.exit(0);
}

const live = out.filter((r) => !CLOSED.has(r.status)).length;
console.log(
  `${repo}  (base ${base})  —  ${live} live / ${out.length} shown / ${all.length} registered\n`,
);

const H = [
  "ID",
  "SPEC",
  "STATUS",
  "AGE",
  "EV",
  "COMMITS",
  "DIRTY",
  "REPORT",
  "DELIVERABLE",
];
const cells = out.map((r) => [
  r.id,
  r.spec ?? "-",
  r.status,
  fmtAge(r.ageMs),
  r.events == null ? "   -" : String(r.events).padStart(4),
  r.commits == null ? "  -" : String(r.commits).padStart(3),
  r.dirty == null ? "  -" : String(r.dirty).padStart(3),
  fmtSize(r.reportBytes),
  r.deliverable ?? "-",
]);
const w = H.map((h, i) => Math.max(h.length, ...cells.map((c) => c[i].length)));
const line = (c) =>
  c
    .map((v, i) => v.padEnd(w[i]))
    .join("  ")
    .trimEnd();
console.log(line(H));
console.log(w.map((n) => "-".repeat(n)).join("  "));
for (const c of cells) console.log(line(c));

const flagged = out.filter((r) => r.flags.length);
if (flagged.length) {
  console.log("\nflags:");
  for (const r of flagged)
    console.log(`  ${r.id.padEnd(6)} ${r.flags.join(" ")}`);
}

console.log(
  "\nlegend: REPORT-READY = deliverable on disk, read it and run check-result",
);
console.log(
  "        STALE>Nm     = no session write in N min while status is live — poll the pane",
);
console.log(
  "        NOT-FIRED    = session has <3 events; the prompt may be staged, send enter",
);
console.log(
  "        FALSE-DONE   = closed with a deliverable that does not exist",
);
