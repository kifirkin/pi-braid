#!/usr/bin/env node
/**
 * adversarial-instruments.mjs — run each gate against a world built to be refused.
 *
 * Why this exists: a gate is exercised where it passes and where it refuses a
 * well-formed input, and almost never where its own input is absent, empty or a
 * different shape. The interesting failure is the one a reader cannot act on:
 * a checker that reports a broken world clean, or refuses without naming the
 * path, field or version the refusal is about. Neither shows up in a suite that
 * only feeds the gate what it expects.
 *
 * The protocol. Each row of the table below builds a fresh temporary world,
 * invokes one checker through its command line the way a seat does, and compares
 * the result with the row's declaration: the exit code, and the tokens the
 * message must carry. Declarations come from the checker's own contract or from
 * the case's inputs — the subject token is always a path or value the world
 * constructed, and a remedy token is declared only where the checker's own usage
 * or refusal promises one — never from what the run happened to print.
 *
 * Verdicts:
 *   pass        the declared exit code, and every declared token, is present
 *   silent-pass the row was built to be refused and the checker exited 0
 *   unnamed     the checker refused but its message is missing a declared token
 *   wrong-exit  the exit code is neither the declared one nor a silent pass
 *   error       the command could not be started, or a world could not be built
 *
 * Every row prints one line:
 *   PASS <checker> <case> (exit=1, named "<token>")
 *   FAIL <checker> <case> (exit=0)
 *   FAIL <checker> <case> (exit=1, message did not name "<token>")
 *
 * Exit: 0 every row agrees, 1 at least one row diverged (a world that could not
 * be built reports as an error row), 2 the table is unusable. A divergence is
 * the measurement, not a reason to stop: the run prints every row before it
 * exits.
 *
 * Usage:
 *   node packages/core/scripts/adversarial-instruments.mjs [--json] [--only <text>] [--list] [--keep]
 *   node packages/core/scripts/adversarial-instruments.mjs --table <path>   run an external case table
 *
 * The table is data: a row names the checker, the world to build, the argv, cwd
 * and env to run with, and what the run must say. A case that needs a builder
 * it cannot express is visibly exceptional here, which is the point of keeping
 * the builders few and generic.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TREE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CASE_TIMEOUT_MS = 120_000;

/** A stamp a fixture can use as "the day this row was written": built, never
 *  spelled as a date literal, because a fixture clock is not provenance. */
function stamp(day, hour = 12) {
  return new Date(Date.UTC(2026, 8, day, hour, 0, 0)).toISOString().replace(/\.\d{3}Z$/, "Z");
}

/** The value a ghost revision carries: well-formed, resolvable nowhere. */
const GHOST = "f".repeat(40);

// ── worlds ──────────────────────────────────────────────────────────────────
//
// A builder receives a private directory, creates the world's fixed parts
// (repositories, directories), and returns the values its argv and its
// declarations name plus any file whose text needs those values. The runner
// fills placeholders once, then writes those files, so a case table never has
// to hold a path or a computed revision.

function gitWorld(dir) {
  mkdirSync(dir, { recursive: true });
  const git = (...args) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "fixture@example.test");
  git("config", "user.name", "fixture");
  writeFileSync(join(dir, "tracked.txt"), "one\n");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  const head = git("rev-parse", "HEAD").stdout.trim();
  return { git, head };
}

/** A session file the result gate can read, or one built to break a read. */
function buildSession(dir, spec) {
  const repo = join(dir, "repo");
  const { head } = gitWorld(repo);
  const plainDir = join(dir, "plain-dir");
  mkdirSync(plainDir, { recursive: true });
  const noCommits = join(dir, "no-commits");
  mkdirSync(noCommits, { recursive: true });
  spawnSync("git", ["-C", noCommits, "init", "-q", "-b", "main"], { encoding: "utf8" });

  const name = spec.session === "space" ? "a session with a space.jsonl" : "session.jsonl";
  const session = join(dir, name);
  const report = join(dir, "report.md");
  writeFileSync(report, "# fixture\n\n## Placement\n\nfixture only\n");
  const failureScript = join(dir, "always-fails.sh");

  const block = {
    worker: "fixture-worker",
    spec: "impl",
    status: "completed",
    output_file: report,
    artifacts: [],
    gate_evidence: [{ cmd: "true", exit: 0 }],
    claims: [
      {
        claim: "the fixture claim holds",
        verified_by: "the fixture harness",
        predicts: "the gate exits 0 for a well-formed block",
      },
    ],
    ...spec.block,
    source_revision: spec.block?.source_revision === "absent" ? GHOST : head,
  };
  if (spec.failureScript === true) {
    block.gate_evidence = [{ cmd: failureScript, exit: 0 }];
    block.claims = [
      {
        claim: "the fixture script passes when run",
        verified_by: failureScript,
        predicts: "the script exits 0 when run",
      },
    ];
  }

  const files = [];
  if (spec.session === "empty") files.push({ path: session, text: "" });
  if (spec.session === "directory") mkdirSync(session, { recursive: true });
  if (spec.session === "present") {
    files.push({ path: session, text: assistantMessage(`\`\`\`json\n${JSON.stringify(block, null, 2)}\n\`\`\``) });
  }
  if (spec.session === "string-block") {
    files.push({ path: session, text: assistantMessage(`\`\`\`json\n${JSON.stringify("a string is not a block")}\n\`\`\``) });
  }
  if (spec.failureScript === true) {
    files.push({ path: failureScript, text: "#!/bin/sh\nexit 1\n", mode: 0o755 });
  }
  return {
    bind: { session, repo, sha: head, plainDir, noCommits, failureScript, dir },
    env: { BRAID_GATE_REPOS: repo },
    files,
  };
}

/**
 * Write one file a world declared. The path is the caller's, always built from
 * the private temporary directory: nothing this runner writes can resolve into
 * the session's project.
 */
function writeWorldFile(target, text, mode) {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
  if (mode !== undefined) chmodSync(target, mode);
}

function assistantMessage(text) {
  return `${JSON.stringify({ type: "message", message: { role: "assistant", content: [{ type: "text", text }] } })}\n`;
}

/** A journal under a private BRAID_HOME, or the absence of one. */
function buildJournal(dir, spec) {
  const home = join(dir, "braid-home");
  const project = join(dir, "project");
  mkdirSync(project, { recursive: true });
  const journal = join(home, "journal", spec.slug, "journal.jsonl");
  const files = [];
  if (spec.journal === "empty") files.push({ path: journal, text: "" });
  if (spec.rows !== undefined) {
    const rows = spec.rows.map((kind) =>
      kind === "legacy"
        ? { seq: 1, at: stamp(1), kind: "intent", text: "A row written before the schema carried status and evidence." }
        : kind,
    );
    files.push({ path: journal, text: `${rows.map((row) => JSON.stringify(row)).join("\n")}\n` });
  }
  return { bind: { home, project, journal, slug: spec.slug }, env: { BRAID_HOME: home }, files };
}

/** A bench the suite runner can read: one fixture, no build, no lock. */
function buildSuite(dir, spec) {
  const root = join(dir, "bench");
  mkdirSync(join(root, "test", "runtime"), { recursive: true });
  const files = [{ path: join(root, "test", "runtime", "one.mjs"), text: "process.exit(0);\n" }];
  let revision = null;
  if (spec.git === true) revision = gitWorld(root).head;
  const baseline = spec.baseline === "no-parent" ? join(dir, "no-such-dir", "baseline.json") : join(dir, "baseline.json");
  if (spec.baseline !== undefined && spec.baseline !== "no-parent") {
    const snapshot = {
      instrument: "check-regressions",
      root,
      ...(spec.revision === "omit" ? {} : { revision: spec.revision === "absent" ? GHOST : revision }),
      counts: { fixtures: spec.fixtures ?? 1, passed: spec.fixtures ?? 1, failed: 0, timedOut: 0 },
      fixtures: spec.fixtures === 0 ? [] : [{ path: "one.mjs", outcome: "passed" }],
    };
    files.push({ path: baseline, text: `${JSON.stringify(snapshot, null, 2)}\n` });
  }
  return { bind: { root, baseline, sha: revision ?? "no revision", ghost: GHOST }, env: {}, files };
}

/** A document plus the registry entry that governs one number on it. */
function buildClaims(dir, spec) {
  const root = join(dir, "tree");
  mkdirSync(root, { recursive: true });
  const document = join(root, "doc.md");
  const registry = join(dir, "registry.json");
  const files = [{ path: document, text: `# doc\n\n${spec.docLine}\n` }];
  if (spec.registry !== "missing") {
    const entry = {
      id: "leaves",
      claim: "the fixture leaf count",
      stated: { file: "doc.md", line: 3, pattern: spec.statedPattern },
      derived: { cmd: spec.derivedCmd, pattern: "^([0-9]+)$" },
    };
    files.push({ path: registry, text: `${JSON.stringify({ claims: [entry] }, null, 2)}\n` });
  }
  return { bind: { root, document, registry }, env: {}, files };
}

/** A copy of the recorded pi surface, with one symbol or member moved. */
function buildSurface(dir, spec) {
  const manifest = join(dir, "pi-surface.json");
  const files = [];
  if (spec.manifest !== "missing") {
    const record = JSON.parse(readFileSync(join(TREE, "packages", "core", "pi-surface.json"), "utf8"));
    if (spec.edit === "remove-symbol") delete record.surfaces["extension-api"].symbols["ExtensionAPI"];
    if (spec.edit === "move-member") {
      const members = record.surfaces["extension-api"].symbols["ExtensionAPI"].members.on;
      members[0] = members[0].replace("): () => void", "): () => never");
    }
    files.push({ path: manifest, text: `${JSON.stringify(record, null, 2)}\n` });
  }
  return { bind: { manifest }, env: {}, files };
}

/** A module that imports the package build the tree has not produced. */
function buildUnbuilt(dir) {
  const entry = join(dir, "main.mjs");
  return { bind: { entry }, env: {}, files: [{ path: entry, text: 'import "./dist/absent.js";\n' }] };
}

const BUILDERS = {
  session: buildSession,
  journal: buildJournal,
  suite: buildSuite,
  claims: buildClaims,
  surface: buildSurface,
  unbuilt: buildUnbuilt,
  none: () => ({ bind: {}, env: {}, files: [] }),
};

// ── the table ───────────────────────────────────────────────────────────────
//
// One row per broken world. `names` holds tokens the message must carry; a
// token in braces is a value the world constructed, so the declaration cannot
// drift from the case.

const CASES = [
  {
    checker: "check-result",
    script: "packages/core/scripts/check-result.mjs",
    case: "missing-session-file",
    why: "the session a close names does not exist",
    world: { kind: "session", session: "missing" },
    argv: ["node", "packages/core/scripts/check-result.mjs", "{session}"],
    expect: { code: 1, names: ["{session}"] },
  },
  {
    checker: "check-result",
    script: "packages/core/scripts/check-result.mjs",
    case: "empty-session-file",
    why: "a session truncated to nothing must refuse, and say which file",
    world: { kind: "session", session: "empty" },
    argv: ["node", "packages/core/scripts/check-result.mjs", "{session}"],
    expect: { code: 1, names: ["{session}"] },
  },
  {
    checker: "check-result",
    script: "packages/core/scripts/check-result.mjs",
    case: "session-path-is-a-directory",
    why: "the path exists but is a directory, the shape a mistyped glob produces",
    world: { kind: "session", session: "directory" },
    argv: ["node", "packages/core/scripts/check-result.mjs", "{session}"],
    expect: { code: 1, names: ["{session}"] },
  },
  {
    checker: "check-result",
    script: "packages/core/scripts/check-result.mjs",
    case: "absent-path-with-a-space",
    why: "a path with a space must survive a refusal intact",
    world: { kind: "session", session: "space" },
    argv: ["node", "packages/core/scripts/check-result.mjs", "{session}"],
    expect: { code: 1, names: ["{session}"] },
  },
  {
    checker: "check-result",
    script: "packages/core/scripts/check-result.mjs",
    case: "block-is-a-json-string",
    why: "a fenced value that is not an object is not a result block",
    world: { kind: "session", session: "string-block" },
    argv: ["node", "packages/core/scripts/check-result.mjs", "{session}"],
    expect: { code: 2, names: ["{session}"] },
  },
  {
    checker: "check-result",
    script: "packages/core/scripts/check-result.mjs",
    case: "repo-is-not-a-repository",
    why: "a --repo path that is not a git tree must be named as such",
    world: { kind: "session", session: "present", block: { source_revision: "absent" } },
    argv: ["node", "packages/core/scripts/check-result.mjs", "{session}", "--repo", "{plainDir}"],
    expect: { code: 1, names: ["{plainDir}", "pass --repo <path>"] },
  },
  {
    checker: "check-result",
    script: "packages/core/scripts/check-result.mjs",
    case: "repo-with-no-commits",
    why: "a repository holding no revision cannot hold the one the block names",
    world: { kind: "session", session: "present", block: { source_revision: "absent" } },
    argv: ["node", "packages/core/scripts/check-result.mjs", "{session}", "--repo", "{noCommits}"],
    expect: { code: 1, names: ["{noCommits}", "pass --repo <path>"] },
  },
  {
    checker: "check-result",
    script: "packages/core/scripts/check-result.mjs",
    case: "row-claims-a-zero-the-command-does-not-return",
    why: "a gate row records exit 0 for a command that exits 1",
    world: { kind: "session", session: "present", failureScript: true },
    argv: ["node", "packages/core/scripts/check-result.mjs", "{session}"],
    expect: { code: 1, names: ["always-fails.sh"] },
  },
  {
    checker: "check-journal",
    script: "packages/core/scripts/check-journal.mjs",
    case: "no-journal-directory",
    why: "a project that never wrote a journal is a population of zero",
    world: { kind: "journal", slug: "fixture", journal: "absent" },
    argv: ["node", "packages/core/scripts/check-journal.mjs", "--project", "fixture"],
    expect: { code: 0, names: ["{journal}", "0 entries"] },
  },
  {
    checker: "check-journal",
    script: "packages/core/scripts/check-journal.mjs",
    case: "empty-journal",
    why: "an empty file is the same population as no file",
    world: { kind: "journal", slug: "fixture", journal: "empty" },
    argv: ["node", "packages/core/scripts/check-journal.mjs", "--project", "fixture"],
    expect: { code: 0, names: ["{journal}", "0 entries"] },
  },
  {
    checker: "check-journal",
    script: "packages/core/scripts/check-journal.mjs",
    case: "one-legacy-row",
    why: "a row from the old writer is missing the fields the schema now requires",
    world: { kind: "journal", slug: "fixture", rows: ["legacy"] },
    argv: ["node", "packages/core/scripts/check-journal.mjs", "--project", "fixture"],
    expect: { code: 2, names: ["FIELDS line 1", "intent without status"] },
  },
  {
    checker: "check-journal",
    script: "packages/core/scripts/check-journal.mjs",
    case: "digest-over-one-legacy-row",
    why: "the digest printer must not read a structural finding as an open program",
    world: { kind: "journal", slug: "fixture", rows: ["legacy"] },
    argv: ["node", "packages/core/scripts/check-journal.mjs", "--project", "fixture", "--digest"],
    expect: { code: 2, names: ["FIELDS line 1", "intent without status"] },
  },
  {
    checker: "check-regressions",
    script: "packages/core/scripts/check-regressions.mjs",
    case: "no-baseline",
    why: "the baseline a comparison names is absent",
    world: { kind: "suite" },
    argv: ["node", "packages/core/scripts/check-regressions.mjs", "--check", "{baseline}", "--root", "{root}"],
    expect: { code: 2, names: ["{baseline}", "Take one with --baseline"] },
  },
  {
    checker: "check-regressions",
    script: "packages/core/scripts/check-regressions.mjs",
    case: "baseline-revision-absent-from-history",
    why: "a revision this tree does not descend from must be refused",
    world: { kind: "suite", git: true, baseline: "recorded", revision: "absent" },
    argv: ["node", "packages/core/scripts/check-regressions.mjs", "--check", "{baseline}", "--root", "{root}"],
    expect: { code: 2, names: ["{ghost}", "Take a new baseline"] },
  },
  {
    checker: "check-regressions",
    script: "packages/core/scripts/check-regressions.mjs",
    case: "baseline-omits-the-revision-field",
    why: "a baseline that records no revision still has to be placed against this tree",
    world: { kind: "suite", git: true, baseline: "recorded", revision: "omit" },
    argv: ["node", "packages/core/scripts/check-regressions.mjs", "--check", "{baseline}", "--root", "{root}"],
    expect: { code: 2, names: ["{root}", "Take a new baseline"] },
  },
  {
    checker: "check-regressions",
    script: "packages/core/scripts/check-regressions.mjs",
    case: "unwritable-baseline-path",
    why: "the path a baseline cannot be written to",
    world: { kind: "suite", baseline: "no-parent" },
    argv: ["node", "packages/core/scripts/check-regressions.mjs", "--baseline", "{baseline}", "--root", "{root}"],
    expect: { code: 2, names: ["{baseline}"] },
  },
  {
    checker: "check-regressions",
    script: "packages/core/scripts/check-regressions.mjs",
    case: "baseline-with-no-fixtures",
    why: "a baseline holding no row grounds no comparison",
    world: { kind: "suite", git: true, baseline: "recorded", fixtures: 0 },
    argv: ["node", "packages/core/scripts/check-regressions.mjs", "--check", "{baseline}", "--root", "{root}"],
    expect: { code: 2, names: ["0 fixture(s) compared"] },
  },
  {
    checker: "check-source-claims",
    script: "packages/core/scripts/check-source-claims.mjs",
    case: "the-sentence-is-deleted",
    why: "the line the registry points at no longer carries the claimed sentence",
    world: {
      kind: "claims",
      docLine: "Nothing here states a count.",
      statedPattern: "^The fixture has ([0-9]+) leaves\\.$",
      derivedCmd: "printf '3\\n'",
    },
    argv: ["node", "packages/core/scripts/check-source-claims.mjs", "--root", "{root}", "--registry", "{registry}"],
    expect: { code: 1, names: ["doc.md"] },
  },
  {
    checker: "check-source-claims",
    script: "packages/core/scripts/check-source-claims.mjs",
    case: "the-number-is-wrong",
    why: "the document states one number and the command derives another",
    world: {
      kind: "claims",
      docLine: "The fixture has 4 leaves.",
      statedPattern: "^The fixture has ([0-9]+) leaves\\.$",
      derivedCmd: "printf '3\\n'",
    },
    argv: ["node", "packages/core/scripts/check-source-claims.mjs", "--root", "{root}", "--registry", "{registry}"],
    expect: { code: 1, names: ["doc.md:3", "printf"] },
  },
  {
    checker: "check-source-claims",
    script: "packages/core/scripts/check-source-claims.mjs",
    case: "registry-is-missing",
    why: "the registry a run names was never written",
    world: {
      kind: "claims",
      registry: "missing",
      docLine: "The fixture has 3 leaves.",
      statedPattern: "^The fixture has ([0-9]+) leaves\\.$",
      derivedCmd: "printf '3\\n'",
    },
    argv: ["node", "packages/core/scripts/check-source-claims.mjs", "--root", "{root}", "--registry", "{registry}"],
    expect: { code: 1, names: ["{registry}"] },
  },
  {
    checker: "check-source-claims",
    script: "packages/core/scripts/check-source-claims.mjs",
    case: "two-numbers-one-enrolled",
    why: "the line states a pair and the entry governs only the first number",
    world: {
      kind: "claims",
      docLine: "The fixture has 3 of 41 leaves.",
      statedPattern: "^The fixture has ([0-9]+) of [0-9]+ leaves\\.$",
      derivedCmd: "printf '3\\n'",
    },
    argv: ["node", "packages/core/scripts/check-source-claims.mjs", "--root", "{root}", "--registry", "{registry}"],
    expect: { code: 1, names: ["41"] },
  },
  {
    checker: "check-pi-surface",
    script: "packages/core/scripts/check-pi-surface.mjs",
    case: "manifest-is-missing",
    why: "the record the gate compares against was never written",
    world: { kind: "surface", manifest: "missing" },
    argv: ["node", "packages/core/scripts/check-pi-surface.mjs", "--check", "--manifest", "{manifest}"],
    expect: { code: 1, names: ["{manifest}", "--record"] },
  },
  {
    checker: "check-pi-surface",
    script: "packages/core/scripts/check-pi-surface.mjs",
    case: "recorded-symbol-deleted",
    why: "the record omits a symbol the surface declares",
    world: { kind: "surface", edit: "remove-symbol" },
    argv: ["node", "packages/core/scripts/check-pi-surface.mjs", "--check", "--manifest", "{manifest}"],
    expect: { code: 1, names: ["extension-api/ExtensionAPI", "re-record"] },
  },
  {
    checker: "check-pi-surface",
    script: "packages/core/scripts/check-pi-surface.mjs",
    case: "recorded-member-signature-moved",
    why: "pi changed one member signature the record still carries",
    world: { kind: "surface", edit: "move-member" },
    argv: ["node", "packages/core/scripts/check-pi-surface.mjs", "--check", "--manifest", "{manifest}"],
    expect: { code: 1, names: ["member \"on\" changed", "re-record"] },
  },
  {
    checker: "a runtime fixture",
    case: "import-of-an-unbuilt-tree",
    why: "a module that imports the package build the tree has not produced",
    world: { kind: "unbuilt" },
    argv: ["node", "{entry}"],
    expect: { code: 1, names: ["npm run build"] },
  },
];

// ── running ─────────────────────────────────────────────────────────────────

const BIND_NAMES = new Set([
  "dir",
  "tree",
  "session",
  "repo",
  "sha",
  "plainDir",
  "noCommits",
  "failureScript",
  "home",
  "project",
  "journal",
  "slug",
  "root",
  "baseline",
  "ghost",
  "document",
  "registry",
  "manifest",
  "entry",
]);

function fill(text, bind) {
  const out = String(text).replace(/\{([a-zA-Z]+)\}/g, (whole, name) => {
    if (!BIND_NAMES.has(name)) return whole;
    if (bind[name] === undefined) throw new Error(`the table names {${name}} but the world does not bind it`);
    return bind[name];
  });
  const left = /\{([a-zA-Z]+)\}/.exec(out);
  if (left !== null) throw new Error(`the table names ${left[0]} but no value fills it`);
  return out;
}

function judge(row, seen, bind) {
  const names = row.expect.names.map((name) => fill(name, bind));
  const missing = names.filter((name) => !seen.text.includes(name));
  const base = { checker: row.checker, case: row.case, names, missing, exit: seen.exit };
  if (seen.error) return { ...base, verdict: "error", detail: seen.error };
  if (seen.exit !== row.expect.code) {
    return {
      ...base,
      verdict: row.expect.code !== 0 && seen.exit === 0 ? "silent-pass" : "wrong-exit",
      detail: `exit=${seen.exit}, expected ${row.expect.code}`,
    };
  }
  if (missing.length > 0) {
    return { ...base, verdict: "unnamed", detail: `exit=${seen.exit}, message did not name ${quote(missing)}` };
  }
  return { ...base, verdict: "pass", detail: `exit=${seen.exit}, named ${quote(names)}` };
}

function quote(names) {
  return names.map((name) => JSON.stringify(name)).join(", ");
}

function runRow(row, workRoot) {
  const dir = mkdtempSync(join(workRoot, `${row.case.replace(/[^a-z0-9]+/gi, "-")}-`));
  const builder = BUILDERS[row.world?.kind ?? "none"];
  if (builder === undefined) throw new Error(`the ${row.case} row names an unknown world: ${row.world.kind}`);
  const world = builder(dir, row.world ?? {});
  const bind = { dir, tree: TREE, ...world.bind };
  for (const file of world.files ?? []) {
    writeWorldFile(fill(file.path, bind), fill(file.text, bind), file.mode);
  }
  const argv = row.argv.map((arg) => fill(arg, bind));
  const cwd = fill(row.cwd ?? "{tree}", bind);
  const env = { ...process.env, ...world.env };
  for (const [name, value] of Object.entries(row.env ?? {})) env[name] = fill(value, bind);
  if (row.script !== undefined && !existsSync(join(TREE, row.script))) {
    return { ...judge(row, { exit: null, text: "", error: `missing script ${row.script}` }, bind), bind, output: "" };
  }
  const result = spawnSync(argv[0] === "node" ? process.execPath : argv[0], argv.slice(1), {
    cwd,
    env,
    encoding: "utf8",
    timeout: CASE_TIMEOUT_MS,
  });
  const text = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const seen = {
    exit: result.status,
    text,
    error:
      result.error !== undefined
        ? `could not run ${argv[0]}: ${result.error.message}`
        : result.status === null
          ? `died on ${result.signal ?? "a signal"}`
          : undefined,
  };
  const judged = judge(row, seen, bind);
  const roots = [dir, realpathSync(dir)].sort((a, b) => b.length - a.length);
  const shorten = (text) => roots.reduce((out, root) => out.split(root).join("<world>"), text);
  return {
    ...judged,
    names: judged.names.map(shorten),
    missing: judged.missing.map(shorten),
    detail: shorten(judged.detail),
    output: shorten(text.trim()),
  };
}

function main() {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const keep = args.includes("--keep");
  const list = args.includes("--list");
  const onlyIndex = args.indexOf("--only");
  const only = onlyIndex >= 0 ? args[onlyIndex + 1] : "";
  if (onlyIndex >= 0 && (only === undefined || only.startsWith("--"))) {
    process.stderr.write("adversarial-instruments: --only needs text to match a case or checker\n");
    process.exit(2);
  }
  const tableIndex = args.indexOf("--table");
  const tablePath = tableIndex >= 0 ? args[tableIndex + 1] : undefined;
  if (tableIndex >= 0 && (tablePath === undefined || tablePath.startsWith("--"))) {
    process.stderr.write("adversarial-instruments: --table needs the path of a JSON case table\n");
    process.exit(2);
  }
  let cases = CASES;
  if (tablePath !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(readFileSync(tablePath, "utf8"));
    } catch (error) {
      process.stderr.write(`adversarial-instruments: ${tablePath}: ${error.message}\n`);
      process.exit(2);
    }
    if (!Array.isArray(parsed) || parsed.length === 0) {
      process.stderr.write(`adversarial-instruments: ${tablePath}: expected a non-empty array of rows\n`);
      process.exit(2);
    }
    for (const row of parsed) {
      const bad =
        typeof row?.checker !== "string" ||
        typeof row?.case !== "string" ||
        !Array.isArray(row?.argv) ||
        row.argv.length === 0 ||
        typeof row?.expect?.code !== "number" ||
        !Array.isArray(row?.expect?.names);
      if (bad) {
        process.stderr.write(
          `adversarial-instruments: ${tablePath}: a row needs checker, case, argv and expect {code, names}: ` +
            `${JSON.stringify(row)}\n`,
        );
        process.exit(2);
      }
    }
    cases = parsed;
  }
  const rows = only === "" ? cases : cases.filter((row) => `${row.checker} ${row.case}`.includes(only));
  if (rows.length === 0) {
    process.stderr.write(`adversarial-instruments: no case matches ${JSON.stringify(only)}\n`);
    process.exit(2);
  }
  if (list) {
    for (const row of rows) console.log(`${row.checker}\t${row.case}`);
    return;
  }

  const workRoot = mkdtempSync(join(tmpdir(), "adversarial-instruments-"));
  const results = [];
  try {
    for (const row of rows) {
      let result;
      try {
        result = runRow(row, workRoot);
      } catch (error) {
        result = {
          checker: row.checker,
          case: row.case,
          verdict: "error",
          detail: `the world could not be built: ${error.message}`,
          names: [],
          missing: [],
          exit: null,
          output: "",
        };
      }
      results.push(result);
      const line = `${result.verdict === "pass" ? "PASS" : "FAIL"} ${row.checker} ${row.case} (${result.detail})`;
      if (!json) console.log(line);
    }
  } finally {
    if (keep) process.stderr.write(`worlds kept under ${workRoot}\n`);
    else rmSync(workRoot, { recursive: true, force: true });
  }

  const tally = { pass: 0, "silent-pass": 0, unnamed: 0, "wrong-exit": 0, error: 0 };
  for (const result of results) tally[result.verdict] += 1;
  const diverged = results.length - tally.pass;
  const summary =
    `adversarial-instruments: ${results.length} case(s), ${tally.pass} pass, ${diverged} fail ` +
    `(${tally["silent-pass"]} silent-pass, ${tally.unnamed} unnamed, ${tally["wrong-exit"]} wrong-exit, ${tally.error} error)`;
  if (json) {
    console.log(
      JSON.stringify(
        {
          tree: TREE,
          cases: results.map(({ checker, case: id, verdict, exit, names, missing, detail, output }) => ({
            checker,
            case: id,
            verdict,
            exit,
            names,
            missing,
            detail,
            output,
          })),
          summary: tally,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(summary);
  }
  process.exitCode = diverged === 0 ? 0 : 1;
}

main();
