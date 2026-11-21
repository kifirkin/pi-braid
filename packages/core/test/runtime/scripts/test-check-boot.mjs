/**
 * Test: scripts/check-boot.mjs - the seven facts a cold seat needs, printed in
 * one read-only command.
 *
 * Every case runs the real script against a pinned BRAID_HOME and a temp
 * project directory, never the live tree. The store paths are resolved by the
 * built modules (the same ones the script reads), so a fixture cannot quietly
 * agree with a path the runtime never writes.
 *
 * 1. a populated tree prints every fact with a size and exits 0;
 * 2. an empty tree prints empty/absent facts and still exits 0 - the whole
 *    point is that "nothing here yet" is not a failure;
 * 3. a store that does not parse exits 1 and names the row;
 * 4. --require fails a step that produced nothing, and names it;
 * 5. --skip with a reason suppresses the same failure and prints the reason;
 * 6. --skip without a reason exits 2: a silent skip is the hole this closes;
 * 7. an unknown step or argument exits 2;
 * 8. the dox walk names each level from a nested cwd to the git root;
 * 9. a repo with no commits is printed as "no commits" and does not fail;
 * 10. an absent --skills-root is named as unreachable without failing;
 * 11. --json carries the same rows with stable ids and states.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const GATE = join(ROOT, "scripts", "check-boot.mjs");
const DIST = join(ROOT, "dist");

const SINCE = "2026-01-02T03:04:05.000Z";

/**
 * The production paths for a pinned home and a project cwd, resolved by the
 * built modules rather than re-derived here. One spawn per fixture keeps the
 * caller's environment untouched.
 */
function pathsFor(home, cwd) {
  const script = `
    const paths = await import(${JSON.stringify(pathToFileURL(join(DIST, "lib", "config", "braid-paths.js")).href)});
    const scratch = await import(${JSON.stringify(pathToFileURL(join(DIST, "extensions", "memory", "scratchpad", "persistence.js")).href)});
    const slug = scratch.projectSlugFromCwd(process.env.FIX_CWD);
    console.log(JSON.stringify({
      slug,
      journal: paths.journalFilePath(slug),
      episodes: paths.episodesFilePath(),
      semantic: paths.semanticMemoryFilePath(),
      writeLog: paths.memoryDir() + "/write-log.jsonl",
      scratchpadDir: paths.scratchpadDir() + "/" + slug,
      workers: paths.getWorkersFilePath(process.env.FIX_CWD),
      corpus: paths.corpusIndexDir(),
      sessions: paths.braidDir() + "/sessions/" + slug,
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, BRAID_HOME: home, FIX_CWD: cwd },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, `path resolver failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

/** A temp braid home plus a temp project directory; both removed after the case. */
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "boot-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "braid");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  spawnSync("git", ["init", "-q", "-b", "main", project]);
  spawnSync("git", ["-C", project, "config", "user.email", "fixture@example.com"]);
  spawnSync("git", ["-C", project, "config", "user.name", "fixture"]);
  writeFileSync(join(project, "AGENTS.md"), "# Project\n");
  spawnSync("git", ["-C", project, "add", "AGENTS.md"]);
  spawnSync("git", ["-C", project, "commit", "-q", "-m", "init"]);

  const paths = pathsFor(home, project);
  return {
    root,
    home,
    project,
    paths,
    run(...args) {
      const result = spawnSync(process.execPath, [GATE, "--cwd", project, ...args], {
        env: { ...process.env, BRAID_HOME: home },
        encoding: "utf-8",
      });
      return {
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
        stdout: result.stdout ?? "",
      };
    },
  };
}

const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

/** Every store the check knows about, written through the paths it resolves. */
function populate(fx) {
  const { paths } = fx;
  mkdirSync(dirname(paths.journal), { recursive: true });
  writeFileSync(
    paths.journal,
    jsonl([
      { seq: 1, at: SINCE, kind: "outcome", subject: "one", text: "first", reason: null, evidence: [] },
      { seq: 2, at: SINCE, kind: "outcome", subject: "two", text: "second", reason: null, evidence: [] },
    ]) + "not json at all\n",
  );
  mkdirSync(dirname(paths.episodes), { recursive: true });
  writeFileSync(
    paths.episodes,
    jsonl([{ id: "ep-1", task: "a task", solution: "a solution", timestamp: Date.parse(SINCE) }]),
  );
  writeFileSync(paths.semantic, JSON.stringify({ version: 1, memories: [{ id: "mem-1", content: "a memory" }] }));
  writeFileSync(paths.writeLog, jsonl([{ ts: SINCE, site: "finalize", decision: "accept" }]));
  mkdirSync(paths.scratchpadDir, { recursive: true });
  writeFileSync(
    join(paths.scratchpadDir, "events.jsonl"),
    jsonl([
      {
        ts: Date.parse(SINCE),
        state: {
          goal: "a goal",
          plan: [{ id: "pl-1", text: "open" }, { id: "pl-2", text: "closed", done: true }],
          done: [{ id: "pl-0" }],
        },
      },
    ]),
  );
  mkdirSync(paths.sessions, { recursive: true });
  writeFileSync(
    join(paths.sessions, "resume.json"),
    JSON.stringify({ writtenAt: SINCE, goal: "resume goal", openPlans: ["one", "two"] }),
  );
  mkdirSync(dirname(paths.workers), { recursive: true });
  writeFileSync(
    paths.workers,
    JSON.stringify({
      version: 1,
      workers: {
        w1: { workerId: "w1", status: "admitted", branch: "worker/w1/x", outputFile: join(fx.root, "owed.md") },
        w2: { workerId: "w2", status: "completed" },
      },
    }),
  );
  writeFileSync(join(fx.root, "owed.md"), "owed\n");
  mkdirSync(paths.corpus, { recursive: true });
  writeFileSync(join(paths.corpus, "shard-one.jsonl"), jsonl([{ turn: 1 }]));
}

describe("check-boot", () => {
  it("prints every fact with a size for a populated tree", (t) => {
    const fx = fixture(t);
    populate(fx);
    const r = fx.run();
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /Boot check/);
    assert.match(r.stdout, /journal\s+2 entries/);
    assert.match(r.stdout, /unparseable line/);
    assert.match(r.stdout, /episodes 1\//);
    assert.match(r.stdout, /semantic 1\//);
    assert.match(r.stdout, /write log 1\//);
    assert.match(r.stdout, /1 open of 2 plan items, 1 done/);
    assert.match(r.stdout, /2 open plans/);
    assert.match(r.stdout, /1 live of 2 rows/);
    assert.match(r.stdout, /1 shards/);
    assert.match(r.stdout, /1\/1 levels carry AGENTS\.md/);
    assert.match(r.stdout, /w1: .*owed\.md/);
  });

  it("prints an empty tree as facts and still exits 0", (t) => {
    const fx = fixture(t);
    const r = fx.run();
    assert.equal(r.status, 0, r.output);
    assert.doesNotMatch(r.stdout, /FAIL/);
    assert.match(r.stdout, /journal\s+.*no journal/);
    assert.match(r.stdout, /episodes absent/);
    assert.match(r.stdout, /no scratchpad/);
    assert.match(r.stdout, /no resume file/);
    assert.match(r.stdout, /not built/);
  });

  it("fails a store that does not parse, and names the row", (t) => {
    const fx = fixture(t);
    populate(fx);
    writeFileSync(fx.paths.semantic, "{ this is not json");
    const r = fx.run();
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /FAIL: 1 store\(s\) could not be read: memory/);
  });

  it("fails a required step that produced nothing", (t) => {
    const fx = fixture(t);
    const r = fx.run("--require", "journal");
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /required step\(s\) produced nothing.*journal \(missing\)/);
  });

  it("suppresses that failure when the skip states its reason", (t) => {
    const fx = fixture(t);
    const r = fx.run("--require", "journal", "--skip", "journal", "--reason", "fresh tree, no seat yet");
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /skipped - fresh tree, no seat yet/);
    assert.match(r.stdout, /declared skips: journal - fresh tree, no seat yet/);
  });

  it("refuses a skip with no reason", (t) => {
    const fx = fixture(t);
    const r = fx.run("--skip", "journal");
    assert.equal(r.status, 2, r.output);
    assert.match(r.output, /carries no reason/);
  });

  it("refuses an unknown step or argument", (t) => {
    const fx = fixture(t);
    let r = fx.run("--skip", "journel", "--reason", "typo");
    assert.equal(r.status, 2, r.output);
    assert.match(r.output, /names no step/);
    r = fx.run("--wat");
    assert.equal(r.status, 2, r.output);
    assert.match(r.output, /unknown argument --wat/);
  });

  it("walks the AGENTS.md chain from a nested cwd to the git root", (t) => {
    const fx = fixture(t);
    const nested = join(fx.project, "packages", "core");
    mkdirSync(nested, { recursive: true });
    const paths = pathsFor(fx.home, nested);
    assert.ok(existsSync(join(fx.project, "AGENTS.md")));
    const result = spawnSync(process.execPath, [GATE, "--cwd", nested], {
      env: { ...process.env, BRAID_HOME: fx.home },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /1\/3 levels carry AGENTS\.md/);
    assert.match(result.stdout, /project\/packages: absent/);
    assert.match(result.stdout, /project: AGENTS\.md 10 B/);
    assert.ok(paths.slug.length > 0);
  });

  it("prints a repo with no commits as no commits, without failing", (t) => {
    const fx = fixture(t);
    const bare = join(fx.root, "empty-repo");
    mkdirSync(bare, { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main", bare]);
    const result = spawnSync(process.execPath, [GATE, "--cwd", bare], {
      env: { ...process.env, BRAID_HOME: fx.home },
      encoding: "utf-8",
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /no commits \(no history to read\)/);
  });

  it("counts a declared skills root and names an absent one", (t) => {
    const fx = fixture(t);
    const skills = join(fx.root, "extra-skills");
    mkdirSync(join(skills, "alpha"), { recursive: true });
    mkdirSync(join(skills, "beta"), { recursive: true });
    writeFileSync(join(skills, "alpha", "SKILL.md"), "# alpha\n");
    writeFileSync(join(skills, "beta", "SKILL.md"), "# beta\n");
    const r = fx.run("--skills-root", skills, "--skills-root", join(fx.root, "nowhere"));
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /declared 2\//);
    assert.match(r.stdout, /unreachable: .*nowhere/);
  });

  it("carries the same rows in --json", (t) => {
    const fx = fixture(t);
    populate(fx);
    const r = fx.run("--json");
    assert.equal(r.status, 0, r.output);
    const parsed = JSON.parse(r.stdout);
    assert.ok(Array.isArray(parsed.rows));
    const ids = parsed.rows.map((row) => row.id);
    for (const id of ["home", "git", "skills", "corpus", "journal", "memory", "scratchpad", "handoff", "fleet", "dox", "owed", "brief"]) {
      assert.ok(ids.includes(id), `missing row ${id}`);
    }
    const journal = parsed.rows.find((row) => row.id === "journal");
    assert.equal(journal.state, "ok");
    assert.equal(journal.data.entries, 2);
    const memory = parsed.rows.find((row) => row.id === "memory");
    assert.equal(memory.data.episodes.entries, 1);
    assert.equal(memory.data.semantic.entries, 1);
  });
});
