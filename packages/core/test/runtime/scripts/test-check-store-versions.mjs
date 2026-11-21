/**
 * Test: scripts/check-store-versions.mjs - the census over the stores on disk.
 *
 * The checker is the instrument that notices a store nobody declared, so every
 * case here runs the real script against a pinned braid home and reads what it
 * printed. The refusals are the ones that must not be absorbed: an unsupported
 * version, a file that does not parse, and a store-shaped file the list does not
 * declare. The tolerances are the ones that must be counted: a legacy file read
 * without a version field, and the store-shaped files declared as not-stores
 * with a reason each.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const GATE = join(ROOT, "scripts", "check-store-versions.mjs");

/** One episode row: the shape the live store carries. */
function episode(id, extra = {}) {
  return {
    id,
    task: "t",
    solution: "s",
    outcome: "success",
    similarity: 0,
    timestamp: 1,
    toolSequence: [],
    tags: [],
    project: "p",
    sessionId: "s",
    quality: 1,
    ...extra,
  };
}

/**
 * A braid home holding the stores the checker declares. The default tree is
 * clean, so a case states only the file it is about; `write` and `writeRaw`
 * create whatever a case needs, including a file the list does not declare.
 */
function braidHome(t) {
  const home = mkdtempSync(join(tmpdir(), "store-versions-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));

  const write = (relative, value) => {
    const path = join(home, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 1));
    return path;
  };

  const tree = {
    home,
    write,
    writeRaw(relative, text) {
      const path = join(home, relative);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, text);
      return path;
    },
    lines(relative, rows) {
      const body = rows.map((row) => JSON.stringify(row)).join("\n");
      return write(relative, rows.length === 0 ? "" : `${body}\n`);
    },
    run(...args) {
      const result = spawnSync(process.execPath, [GATE, ...args], {
        env: { ...process.env, BRAID_HOME: home },
        encoding: "utf-8",
      });
      return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
    },
  };

  write("memory/semantic.json", { version: 1, memories: [] });
  tree.lines("memory/episodes.jsonl", [episode("e1"), episode("e2")]);
  write("memory/write-log.jsonl", { ts: "t", site: "s" });
  write("console/jobs.json", { port: 7, jobs: [] });
  write("console/services.json", { version: 2, projects: [] });
  write("console/state.json", { jobs: {} });
  write("projects/one/workers.json", { version: 1, workers: {} });
  write("projects/one/locks.json", { version: 1, locks: {} });
  tree.write("projects/one/deliverables.jsonl", "");
  return tree;
}

describe("check-store-versions", () => {
  it("passes a declared tree and prints each store's version and rows", (t) => {
    const braid = braidHome(t);

    const { status, output } = braid.run();

    assert.equal(status, 0, output);
    assert.match(output, /memory\/semantic\.json: version 1/);
    assert.match(output, /memory\/episodes\.jsonl: row version 1; 2 rows/);
    assert.match(output, /console\/services\.json: version 2/);
    assert.match(output, /projects\/one\/workers\.json: version 1/);
    assert.match(output, /projects\/one\/locks\.json: version 1/);
    assert.match(output, /findings: VERSION 0, UNPARSEABLE 0, UNDECLARED 0/);
  });

  it("refuses a version this build does not read, naming the file and both versions", (t) => {
    const braid = braidHome(t);
    braid.write("console/services.json", { version: 99, projects: [] });

    const { status, output } = braid.run();

    assert.notEqual(status, 0, output);
    assert.match(output, /VERSION console\/services\.json:/);
    assert.match(output, /99/);
    assert.match(output, /supports 2/);
  });

  it("reports a refused store as refused rather than as absent", (t) => {
    const braid = braidHome(t);
    braid.write("console/services.json", { version: 99, projects: [] });

    const { output } = braid.run();

    assert.match(output, /console\/services\.json: refused, 1 file/);
    assert.doesNotMatch(output, /console\/services\.json: absent/);
  });

  it("refuses a store that does not parse, naming the file", (t) => {
    const braid = braidHome(t);
    braid.writeRaw("memory/semantic.json", "{ this is not json");

    const { status, output } = braid.run();

    assert.notEqual(status, 0, output);
    assert.match(output, /UNPARSEABLE memory\/semantic\.json:/);
    assert.match(output, /is not JSON/);
  });

  it("refuses a store-shaped file the list does not declare, naming its path", (t) => {
    const braid = braidHome(t);
    braid.write("console/mystery.json", { anything: true });

    const { status, output } = braid.run();

    assert.notEqual(status, 0, output);
    assert.match(output, /UNDECLARED console\/mystery\.json:/);
    assert.match(output, /not declared/);
    assert.match(output, /findings: VERSION 0, UNPARSEABLE 0, UNDECLARED 1/);
  });

  it("reports a versionless store as a counted legacy read", (t) => {
    const braid = braidHome(t);

    const { status, output } = braid.run();

    assert.equal(status, 0, output);
    assert.match(output, /console\/jobs\.json: version 1 \(legacy 0 accepted, migrated 0->1\)/);
    assert.match(output, /legacy 1/);
  });

  it("reports a declared store that is absent without failing the run", (t) => {
    const braid = braidHome(t);
    rmSync(join(braid.home, "console", "jobs.json"));

    const { status, output } = braid.run();

    assert.equal(status, 0, output);
    assert.match(output, /console\/jobs\.json: absent/);
    assert.match(output, /legacy 0/);
  });

  it("counts the store-shaped files it declares as not stores and does not read them", (t) => {
    const braid = braidHome(t);

    const { status, output } = braid.run();

    assert.equal(status, 0, output);
    assert.match(output, /declared non-stores/);
    assert.match(output, /memory\/write-log\.jsonl/);
    assert.match(output, /console\/state\.json/);
    assert.match(output, /unversioned 1/);
    assert.match(output, /logs 2/);
  });

  it("reports a glob store once per file, not once per directory", (t) => {
    const braid = braidHome(t);
    braid.write("projects/two/workers.json", { version: 1, workers: {} });
    braid.write("projects/two/locks.json", { version: 1, locks: {} });

    const { status, output } = braid.run();

    assert.equal(status, 0, output);
    assert.match(output, /projects\/\*\/workers\.json \(2 files\): version 1/);
  });

  it("counts a jsonl store's partial rows in its own summary line", (t) => {
    const braid = braidHome(t);
    braid.lines("memory/episodes.jsonl", [
      episode("e1"),
      episode("e2", { strategicSOP: "s", functionalSOP: ["f"], atomicSOP: ["a"] }),
    ]);

    const { status, output } = braid.run();

    assert.equal(status, 0, output);
    assert.match(output, /memory\/episodes\.jsonl: row version 1; 2 rows, 1 partial/);
    assert.match(output, /partial 1/);
  });

  it("stays quiet about a store that is declared and unreadable only by absence", (t) => {
    const braid = braidHome(t);
    rmSync(join(braid.home, "memory", "episodes.jsonl"));

    const { status, output } = braid.run();

    assert.equal(status, 0, output);
    assert.match(output, /memory\/episodes\.jsonl: absent/);
  });
});
