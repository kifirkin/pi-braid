/**
 * Test: scripts/check-sinks.mjs - did the learning a wave produced reach a sink?
 *
 * Each case pins one verdict boundary. The stores live under a pinned
 * BRAID_HOME and the branch lives in a temp git repo, so both the window and
 * the diff are attributable: nothing here reads the live tree.
 *
 * 1. a journal entry, an episode and a doc line all name the wave: reached;
 * 2. nothing names it: refused, with every search reporting its zero;
 * 3. a preference rule reached the store while the doc only points at it: the
 *    verdict is a store sink and the doc line is classified as a projection;
 * 4. a trace older than --since is not this wave's: still refused;
 * 5. a wave the registry does not hold and no --since: exit 2, not a guess;
 * 6. the wave's own report is not a sink: a branch that only adds the report
 *    line proves nothing;
 * 7. a base ref the repo does not carry exits 2: an unread search cannot say
 *    "no trace";
 * 8. a semantic match with no timestamp is printed as undated, never counted.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const GATE = join(ROOT, "scripts", "check-sinks.mjs");
const DIST = join(ROOT, "dist");

const SINCE = "2026-01-02T03:04:05.000Z";
const BEFORE = "2026-01-01T00:00:00.000Z";
const WAVE = "w9001";

/** Store paths for a pinned home and project cwd, resolved by the built modules. */
function pathsFor(home, cwd) {
  const script = `
    const paths = await import(${JSON.stringify(pathToFileURL(join(DIST, "lib", "config", "braid-paths.js")).href)});
    const scratch = await import(${JSON.stringify(pathToFileURL(join(DIST, "extensions", "memory", "scratchpad", "persistence.js")).href)});
    const slug = scratch.projectSlugFromCwd(process.env.FIX_CWD);
    console.log(JSON.stringify({
      journal: paths.journalFilePath(slug),
      episodes: paths.episodesFilePath(),
      semantic: paths.semanticMemoryFilePath(),
      preferences: paths.braidDir() + "/preferences.json",
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, BRAID_HOME: home, FIX_CWD: cwd },
    encoding: "utf-8",
  });
  assert.equal(result.status, 0, `path resolver failed: ${result.stderr}`);
  return JSON.parse(result.stdout);
}

const git = (repo, ...args) => spawnSync("git", ["-C", repo, ...args], { encoding: "utf-8" });
const jsonl = (rows) => `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "sink-check-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, "braid");
  const repo = join(root, "repo");
  mkdirSync(home, { recursive: true });
  mkdirSync(repo, { recursive: true });

  spawnSync("git", ["init", "-q", "-b", "main", repo]);
  git(repo, "config", "user.email", "fixture@example.com");
  git(repo, "config", "user.name", "fixture");
  writeFileSync(join(repo, "AGENTS.md"), "# base\n");
  git(repo, "add", "AGENTS.md");
  git(repo, "commit", "-q", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD").stdout.trim();

  const paths = pathsFor(home, repo);
  const workers = join(root, "workers.json");
  writeFileSync(
    workers,
    JSON.stringify({ version: 1, workers: { [WAVE]: { workerId: WAVE, status: "admitted", spawnedAt: SINCE } } }),
  );

  return {
    root,
    home,
    repo,
    base,
    paths,
    workers,
    /** Commit one file on a side branch and leave the repo checked out on it. */
    branchWith(name, content) {
      git(repo, "checkout", "-q", "-b", `wave-${name}`);
      mkdirSync(dirname(join(repo, name)), { recursive: true });
      writeFileSync(join(repo, name), content);
      git(repo, "add", name);
      git(repo, "commit", "-q", "-m", `wave: ${name}`);
    },
    writeJournal(rows) {
      mkdirSync(dirname(paths.journal), { recursive: true });
      writeFileSync(paths.journal, jsonl(rows));
    },
    writeEpisodes(rows) {
      mkdirSync(dirname(paths.episodes), { recursive: true });
      writeFileSync(paths.episodes, jsonl(rows));
    },
    writeSemantic(memories) {
      mkdirSync(dirname(paths.semantic), { recursive: true });
      writeFileSync(paths.semantic, JSON.stringify({ version: 1, memories }));
    },
    writePreferences(entries) {
      writeFileSync(paths.preferences, JSON.stringify({ version: 1, entries }, null, 2));
    },
    run(...args) {
      const result = spawnSync(
        process.execPath,
        [GATE, "--wave", WAVE, "--cwd", repo, "--workers", workers, ...args],
        { env: { ...process.env, BRAID_HOME: home }, encoding: "utf-8" },
      );
      return {
        status: result.status,
        output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
        stdout: result.stdout ?? "",
      };
    },
  };
}

describe("check-sinks", () => {
  it("reaches every sink a wave wrote to", (t) => {
    const fx = fixture(t);
    fx.writeJournal([
      { seq: 7, at: SINCE, kind: "outcome", subject: "sink-wave", text: "the wave landed", evidence: ["check-sinks.mjs"] },
    ]);
    fx.writeEpisodes([{ id: "ep-1", task: "sink-wave finding", solution: "a durable lesson", timestamp: Date.parse(SINCE) }]);
    fx.branchWith("docs/NOTES.md", "# Notes\n\nsink-wave added this line.\n");

    const r = fx.run("--subject", "sink-wave", "--since", SINCE);
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /journal\s+1 hit/);
    assert.match(r.stdout, /memory\s+1 hit/);
    assert.match(r.stdout, /doc\s+1 hit/);
    assert.match(r.stdout, /SINK REACHED: journal 1, memory 1, doc 1/);
  });

  it("refuses a report whose work left no trace", (t) => {
    const fx = fixture(t);
    const r = fx.run("--since", SINCE);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stdout, /journal\s+0 hit/);
    assert.match(r.stdout, /memory\s+0 hit/);
    assert.match(r.stdout, /doc\s+0 hit/);
    assert.match(r.stdout, /store\s+0 hit/);
    assert.match(r.output, /REFUSED: no trace of w9001/);
  });

  it("calls a rule that reached the store a store sink and the doc a projection", (t) => {
    const fx = fixture(t);
    fx.writePreferences([
      {
        id: "fixture-rule",
        surface: "telegram",
        rule: "A fixture rule that exists only to prove the store sink fires.",
        since: "2026-01-02",
        source: "fixture",
      },
    ]);
    fx.branchWith(
      "PREFERENCES.md",
      [
        "# Preferences",
        "",
        "The rules live in `~/.pi/agent/braid/preferences.json`.",
        "",
        "- `fixture-rule` — surface `telegram`: a fixture rule.",
        "",
      ].join("\n"),
    );

    const r = fx.run("--subject", "fixture-rule", "--since", SINCE);
    assert.equal(r.status, 0, r.output);
    assert.match(r.stdout, /store\s+1 hit/);
    assert.match(r.stdout, /rule "fixture-rule" since 2026-01-02/);
    assert.match(r.stdout, /projection PREFERENCES\.md/);
    assert.match(r.stdout, /the rule reached the store; the doc line is a projection/);
  });

  it("does not count a trace older than the wave", (t) => {
    const fx = fixture(t);
    fx.writeJournal([
      { seq: 3, at: BEFORE, kind: "outcome", subject: "sink-wave", text: "an earlier wave", evidence: [] },
    ]);
    fx.writeEpisodes([{ id: "ep-0", task: "sink-wave", solution: "earlier", timestamp: Date.parse(BEFORE) }]);
    const r = fx.run("--subject", "sink-wave", "--since", SINCE);
    assert.equal(r.status, 1, r.output);
    assert.match(r.output, /REFUSED: no trace of w9001/);
  });

  it("cannot place an unknown wave without --since", (t) => {
    const fx = fixture(t);
    writeFileSync(fx.workers, JSON.stringify({ version: 1, workers: {} }));
    const r = fx.run();
    assert.equal(r.status, 2, r.output);
    assert.match(r.output, /cannot place when w9001 started/);
  });

  it("never counts the wave's own report as a doc sink", (t) => {
    const fx = fixture(t);
    const report = join(fx.repo, "reports", "SINKS-WAVE-2026-01-02.md");
    fx.branchWith("reports/SINKS-WAVE-2026-01-02.md", "# Sinks wave\n\nw9001 wrote this report.\n");
    const r = fx.run("--report", report, "--since", SINCE);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stdout, /of the report itself excluded/);
    assert.match(r.output, /REFUSED: no trace of w9001/);
  });

  it("exits 2 when the base ref is not in the repo", (t) => {
    const fx = fixture(t);
    const r = fx.run("--base", "no-such-base", "--since", SINCE);
    assert.equal(r.status, 2, r.output);
    assert.match(r.output, /cannot answer for w9001 - doc could not be read/);
    assert.match(r.output, /no no-such-base ref/);
  });

  it("prints an undated semantic match without counting it", (t) => {
    const fx = fixture(t);
    fx.writeSemantic([{ id: "mem-1", content: "sink-wave is mentioned here but carries no date" }]);
    const r = fx.run("--subject", "sink-wave", "--since", SINCE);
    assert.equal(r.status, 1, r.output);
    assert.match(r.stdout, /1 semantic match\(es\) carry no timestamp/);
    assert.match(r.output, /REFUSED: no trace of w9001/);
  });
});
