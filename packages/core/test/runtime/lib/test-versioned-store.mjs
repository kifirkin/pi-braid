/**
 * Test: lib/store/versioned - one version rule over two on-disk shapes.
 *
 * The rule this fixture pins is a refusal, so a reader that tolerates
 * everything has to fail here: every case names the file, the version found and
 * the versions read, and each case that expects a tolerance expects it counted
 * and reported rather than absorbed.
 *
 * The JSON reader is exercised on a document, the JSONL reader on a row per
 * line. The accounting cases are the reason the second reader exists: a row
 * that fails to parse, a row missing a required field, a row at an unknown
 * version and a row missing an optional field are four different facts, and
 * the file's own line count is the number that proves none of them vanished.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  readVersionedJson,
  readVersionedJsonl,
  describeJsonSummary,
  describeJsonlSummary,
  StoreRefusal,
} = await import("../../../dist/lib/store/versioned.js");

/** A scratch directory per case, with the two write shapes the readers take. */
function scratch(t) {
  const dir = mkdtempSync(join(tmpdir(), "versioned-store-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return {
    dir,
    /** A JSON document, serialized unless the case hands over raw text. */
    doc(name, value) {
      const path = join(dir, name);
      writeFileSync(path, typeof value === "string" ? value : JSON.stringify(value, null, 1));
      return path;
    },
    /** A JSONL file from rows; a string row is written verbatim (a torn line). */
    lines(name, rows) {
      const path = join(dir, name);
      const body = rows.map((row) => (typeof row === "string" ? row : JSON.stringify(row))).join("\n");
      writeFileSync(path, rows.length === 0 ? "" : `${body}\n`);
      return path;
    },
  };
}

/** The refusal a call must produce, or an assertion failure naming what it did. */
function refusalOf(run) {
  try {
    run();
  } catch (error) {
    assert.ok(error instanceof StoreRefusal, `expected a StoreRefusal, got ${error}`);
    return error;
  }
  assert.fail("expected a refusal, the reader returned a value");
}

/** A row carrying every declared field: the clean shape the accounting starts from. */
function row(extra = {}) {
  return {
    id: "e1",
    task: "t",
    solution: "s",
    at: 1,
    strategicSOP: "summary",
    functionalSOP: ["step"],
    atomicSOP: ["call"],
    ...extra,
  };
}

/** The same row without the three optional fields, which is what `partial` counts. */
function thinRow(extra = {}) {
  return { id: "e1", task: "t", solution: "s", at: 1, ...extra };
}

const REQUIRED = ["id", "task", "solution", "at"];
const OPTIONAL = ["strategicSOP", "functionalSOP", "atomicSOP"];
const ROW_SCHEMA = { supported: [1], rowVersion: 1, required: REQUIRED, optional: OPTIONAL };

describe("readVersionedJson", () => {
  it("reads a supported version and reports no repair", (t) => {
    const files = scratch(t);
    const path = files.doc("store.json", { version: 1, jobs: [] });

    const read = readVersionedJson(path, { supported: [1] });

    assert.deepEqual(read.data, { version: 1, jobs: [] });
    assert.equal(read.summary.present, true);
    assert.equal(read.summary.version, 1);
    assert.equal(read.summary.found, 1);
    assert.equal(read.summary.legacy, null);
    assert.deepEqual(read.summary.migrated, []);
    assert.equal(describeJsonSummary(read.summary), "version 1");
  });

  it("refuses a version this build does not read, naming the file and both versions", (t) => {
    const files = scratch(t);
    const path = files.doc("store.json", { version: 99 });

    const refusal = refusalOf(() => readVersionedJson(path, { supported: [1] }));

    assert.equal(refusal.path, path);
    assert.equal(refusal.found, 99);
    assert.deepEqual(refusal.supported, [1]);
    assert.match(refusal.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(refusal.message, /99/);
    assert.match(refusal.message, /supports 1\b/);
  });

  it("refuses a file with no version unless a tolerance is declared", (t) => {
    const files = scratch(t);
    const path = files.doc("store.json", { jobs: [] });

    const refusal = refusalOf(() => readVersionedJson(path, { supported: [1] }));

    assert.equal(refusal.found, null);
    assert.match(refusal.message, /declares no version/);
    assert.match(refusal.message, /supports 1\b/);
  });

  it("reads a versionless file through a declared tolerance and counts it", (t) => {
    const files = scratch(t);
    const path = files.doc("store.json", { jobs: [] });
    const reason = "written before the file carried a version";

    const read = readVersionedJson(path, {
      supported: [0, 1],
      legacy: { accept: true, version: 0, reason },
      migrate: { 0: (data) => ({ ...data, version: 1 }) },
    });

    assert.deepEqual(read.data, { version: 1, jobs: [] });
    assert.deepEqual(read.summary.legacy, { version: 0, reason });
    assert.equal(read.summary.found, null);
    assert.equal(read.summary.version, 1);
    assert.deepEqual(read.summary.migrated, ["0->1"]);
    assert.equal(
      describeJsonSummary(read.summary),
      "version 1 (legacy 0 accepted, migrated 0->1)",
    );
  });

  it("applies the migration steps in order, from the version found to the one read", (t) => {
    const files = scratch(t);
    const path = files.doc("store.json", { version: 1, a: true });
    const applied = [];

    const read = readVersionedJson(path, {
      supported: [1, 2, 3],
      migrate: {
        1: (data) => {
          applied.push(1);
          return { ...data, b: applied.length };
        },
        2: (data) => {
          applied.push(2);
          return { ...data, c: applied.length };
        },
      },
    });

    assert.deepEqual(applied, [1, 2]);
    assert.deepEqual(read.data, { version: 1, a: true, b: 1, c: 2 });
    assert.deepEqual(read.summary.migrated, ["1->2", "2->3"]);
    assert.equal(read.summary.version, 3);
  });

  it("refuses a supported version whose migration step is missing", (t) => {
    const files = scratch(t);
    const path = files.doc("store.json", { version: 1 });

    const refusal = refusalOf(() => readVersionedJson(path, { supported: [1, 2] }));

    assert.match(refusal.message, /no migration step from version 1 to 2/);
    assert.match(refusal.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("refuses a tolerance declared without a reason", (t) => {
    const files = scratch(t);
    const path = files.doc("store.json", { jobs: [] });

    const refusal = refusalOf(() =>
      readVersionedJson(path, {
        supported: [1],
        legacy: { accept: true, reason: "   " },
        migrate: { 0: (data) => ({ ...data, version: 1 }) },
      }),
    );

    assert.match(refusal.message, /legacy declaration must carry a reason/);
  });

  it("reads a missing file as absent rather than as a broken store", (t) => {
    const files = scratch(t);
    const path = join(files.dir, "never-written.json");

    const read = readVersionedJson(path, { supported: [1] });

    assert.equal(read.data, null);
    assert.equal(read.summary.present, false);
    assert.equal(read.summary.version, null);
    assert.equal(describeJsonSummary(read.summary), "absent");
  });

  it("refuses a file that is not JSON, naming the file", (t) => {
    const files = scratch(t);
    const path = files.doc("store.json", "{ this is not json");

    const refusal = refusalOf(() => readVersionedJson(path, { supported: [1] }));

    assert.match(refusal.message, /is not JSON/);
    assert.match(refusal.message, new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  it("refuses a top-level value that is not an object", (t) => {
    const files = scratch(t);
    const path = files.doc("store.json", [1, 2, 3]);

    const refusal = refusalOf(() => readVersionedJson(path, { supported: [1] }));

    assert.match(refusal.message, /top level is not an object/);
  });
});

describe("readVersionedJsonl", () => {
  it("counts a clean file's rows and reports nothing to repair", (t) => {
    const files = scratch(t);
    const path = files.lines("store.jsonl", [row(), row({ id: "e2" }), row({ id: "e3" })]);

    const read = readVersionedJsonl(path, ROW_SCHEMA);

    assert.equal(read.rows.length, 3);
    assert.equal(read.summary.rows, 3);
    assert.equal(read.summary.partial, 0);
    assert.equal(read.summary.unparseable, 0);
    assert.equal(read.summary.incomplete, 0);
    assert.equal(read.summary.unknownVersion, 0);
    assert.deepEqual(read.summary.problems, []);
    assert.equal(describeJsonlSummary(read.summary), "3 rows");
  });

  it("counts a line that fails to parse instead of throwing, naming the line", (t) => {
    const files = scratch(t);
    const path = files.lines("store.jsonl", [row(), '{"id": "torn"', row({ id: "e3" })]);

    const read = readVersionedJsonl(path, ROW_SCHEMA);

    assert.equal(read.rows.length, 2);
    assert.equal(read.summary.unparseable, 1);
    assert.deepEqual(read.summary.problems, [
      { line: 2, kind: "unparseable", detail: read.summary.problems[0].detail },
    ]);
    assert.match(read.summary.problems[0].detail, /not JSON/);
    assert.equal(describeJsonlSummary(read.summary), "2 rows, 1 unparseable");
  });

  it("counts a row missing a declared optional field as partial and keeps the row", (t) => {
    const files = scratch(t);
    const path = files.lines("store.jsonl", [row(), thinRow({ id: "e2" })]);

    const read = readVersionedJsonl(path, ROW_SCHEMA);

    assert.equal(read.rows.length, 2);
    assert.equal(read.summary.partial, 1);
    assert.equal(read.summary.incomplete, 0);
    assert.equal(read.summary.rows, 2);
    assert.equal(describeJsonlSummary(read.summary), "2 rows, 1 partial");
  });

  it("counts a row missing a declared required field and does not return it", (t) => {
    const files = scratch(t);
    const path = files.lines("store.jsonl", [row(), { id: "e2", task: "t", solution: "s" }]);

    const read = readVersionedJsonl(path, ROW_SCHEMA);

    assert.equal(read.rows.length, 1);
    assert.equal(read.summary.incomplete, 1);
    assert.equal(read.summary.partial, 0);
    assert.equal(read.summary.problems[0].line, 2);
    assert.match(read.summary.problems[0].detail, /at/);
  });

  it("counts a row at an unknown version and does not return it", (t) => {
    const files = scratch(t);
    const path = files.lines("store.jsonl", [row(), row({ id: "e2", version: 99 })]);

    const read = readVersionedJsonl(path, ROW_SCHEMA);

    assert.equal(read.rows.length, 1);
    assert.equal(read.summary.unknownVersion, 1);
    assert.equal(read.summary.problems[0].line, 2);
    assert.match(read.summary.problems[0].detail, /99/);
  });

  it("migrates a row at an older declared version", (t) => {
    const files = scratch(t);
    const path = files.lines("store.jsonl", [row({ version: 0 }), row({ id: "e2" })]);
    const seen = [];

    const read = readVersionedJsonl(path, {
      supported: [0, 1],
      rowVersion: 1,
      required: REQUIRED,
      migrate: {
        0: (data) => {
          seen.push(data.id);
          return { ...data, version: 1, migrated: true };
        },
      },
    });

    assert.deepEqual(seen, ["e1"]);
    assert.equal(read.rows.length, 2);
    assert.equal(read.rows[0].migrated, true);
    assert.equal(read.rows[0].version, 1);
    assert.equal(read.rows[1].migrated, undefined);
    assert.equal(read.summary.migratedRows, 1);
  });

  it("refuses a declared row version this build does not read, naming both", (t) => {
    const files = scratch(t);
    const path = files.lines("store.jsonl", [row()]);

    const refusal = refusalOf(() =>
      readVersionedJsonl(path, { supported: [1], rowVersion: 2, required: REQUIRED }),
    );

    assert.match(refusal.message, /declared at version 2/);
    assert.match(refusal.message, /supports 1\b/);
  });

  it("reads a missing file as absent and an empty file as no rows", (t) => {
    const files = scratch(t);
    const absent = readVersionedJsonl(join(files.dir, "never-written.jsonl"), ROW_SCHEMA);
    assert.equal(absent.summary.present, false);
    assert.equal(absent.rows.length, 0);
    assert.equal(describeJsonlSummary(absent.summary), "absent");

    const empty = readVersionedJsonl(files.lines("empty.jsonl", []), ROW_SCHEMA);
    assert.equal(empty.summary.present, true);
    assert.equal(empty.rows.length, 0);
    assert.equal(describeJsonlSummary(empty.summary), "0 rows");
  });

  it("counts a line that is not a row object as unparseable, naming the line", (t) => {
    const files = scratch(t);
    const path = files.lines("store.jsonl", [row(), "5", row({ id: "e3" })]);

    const read = readVersionedJsonl(path, ROW_SCHEMA);

    assert.equal(read.rows.length, 2);
    assert.equal(read.summary.unparseable, 1);
    assert.equal(read.summary.problems[0].line, 2);
    assert.match(read.summary.problems[0].detail, /not an object/);
  });

  it("accounts for every line in a mixed file without losing one", (t) => {
    const files = scratch(t);
    const rowsInFile = [
      row(),
      thinRow({ id: "e2" }),
      row({ id: "e3", at: undefined }),
      '{"id": "torn"',
      row({ id: "e5", version: 99 }),
    ];
    const path = files.lines("store.jsonl", rowsInFile);

    const read = readVersionedJsonl(path, ROW_SCHEMA);
    const summary = read.summary;
    const accounted =
      summary.rows + summary.incomplete + summary.unparseable + summary.unknownVersion;

    assert.equal(accounted, summary.lines);
    assert.equal(summary.lines, 5);
    assert.equal(summary.rows, 2);
    assert.equal(summary.partial, 1);
    assert.equal(summary.incomplete, 1);
    assert.equal(summary.unparseable, 1);
    assert.equal(summary.unknownVersion, 1);
    assert.equal(
      describeJsonlSummary(summary),
      "2 rows, 1 partial, 1 incomplete, 1 unparseable, 1 unknown-version",
    );
  });
});
