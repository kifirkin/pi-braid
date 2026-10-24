/**
 * Test: the journal holds the twelve things a crash has to survive, and holds
 * them in one file a stranger can find.
 *
 * The census is derived from `FLEET_JOURNAL_FIELDS`, not restated here: every
 * `table.column` that export names must exist in the DDL, every table it names
 * must exist, and the field list must still have twelve entries. Dropping a
 * column from the DDL therefore fails this test without anyone editing a
 * second list.
 *
 * Also pinned: one root is one store (two roots are never one journal), the
 * discovery record names the store's own path, the effect identity is stable
 * for one tool call and different across turns, and the read the duplication
 * guard makes before every refusable call is an index seek rather than a scan
 * of every effect the store has ever held.
 *
 * And the lease's shape: the expiry column survives, nullable and unset, because
 * the build that shipped schema 1 writes it by name and a store without it is a
 * store that build cannot open. Three arms hold that contract - this build never
 * writes it, a version-1 store is relaxed to this shape, and the previous build's
 * own lease write still runs against a store this build created - and a fourth
 * holds the other half: a store recording a newer version is refused in one
 * sentence rather than opened and failed inside a statement.
 *
 * Run: node test/runtime/fleet/test-journal-schema.mjs
 */

import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  effectKey,
  FLEET_JOURNAL_FIELDS,
  JOURNAL_FILE,
  journalPath,
  openJournal,
  replayPolicy,
  SCHEMA_VERSION,
} from "../../../scripts/fleet/journal.mjs";
import { openGuardJournal } from "../../../scripts/fleet/tool-guard.mjs";

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  [ok] ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  [fail] ${name}: ${error.message}`);
  }
}

const root = mkdtempSync(join(tmpdir(), "fleet-schema-"));
const journal = openJournal(root, { projectRoot: root, driver: "scripted" });

function columnsOf(table, db = journal.db) {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => row.name);
}

check("the store is one file at <root>/fleet.sqlite", () => {
  assert.equal(journal.path, join(root, JOURNAL_FILE));
  assert.ok(existsSync(journal.path), "journal file exists");
});

check("discovery: the store records its own absolute path, schema and project root", () => {
  const meta = journal.meta();
  assert.equal(meta.store_path, journalPath(root));
  assert.equal(meta.schema_version, String(SCHEMA_VERSION));
  assert.equal(meta.project_root, root);
  assert.equal(meta.driver, "scripted");
});

check("the journal runs in WAL with a full synchronous write", () => {
  const mode = journal.db.prepare("PRAGMA journal_mode").get().journal_mode;
  assert.equal(String(mode).toLowerCase(), "wal");
  assert.ok(existsSync(`${journal.path}-wal`), "a WAL file exists next to the store");
});

check("the field census still names twelve fields", () => {
  assert.equal(FLEET_JOURNAL_FIELDS.length, 12);
  assert.deepEqual(
    FLEET_JOURNAL_FIELDS.map((field) => field.n),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
  );
  for (const field of FLEET_JOURNAL_FIELDS) {
    assert.ok(field.failure && field.failure.length > 10, `field ${field.n} says what breaks without it`);
  }
});

check("every column the census names exists in the DDL", () => {
  const tables = new Set();
  for (const field of FLEET_JOURNAL_FIELDS) {
    for (const column of field.columns) {
      const [table, name] = column.split(".");
      assert.ok(table && name, `census entry is table.column: ${column}`);
      tables.add(table);
      const columns = columnsOf(table);
      assert.ok(columns.includes(name), `${column} is missing (field ${field.n})`);
    }
  }
  assert.deepEqual(
    [...tables].sort(),
    ["asks", "effects", "inbox", "leases", "locks", "model_requests", "nodes", "projects", "routes", "supervisors", "turns"],
  );
});

check("the lease's expiry column is kept, nullable, and this build never writes it", () => {
  const column = journal.db
    .prepare("PRAGMA table_info(leases)")
    .all()
    .find((entry) => entry.name === "expires_at");
  assert.ok(column, "the column the previous build writes must exist for it to open this store");
  assert.equal(column.notnull, 0, "it is nullable, so this build's lease write can leave it unset");
  journal.acquireLease({ nodeId: "n8", ownerPid: process.pid, epoch: 1 });
  const row = journal.db.prepare("SELECT expires_at FROM leases WHERE node_id = 'n8'").get();
  assert.equal(row.expires_at, null, "the lease write set no expiry");
  journal.releaseLease("n8", 1);
});

check("a version-1 store is relaxed on open: its row and index survive, its expiries do not", () => {
  const oldRoot = mkdtempSync(join(tmpdir(), "fleet-schema-old-lease-"));
  const old = new DatabaseSync(journalPath(oldRoot));
  old.exec(`
CREATE TABLE fleet_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
INSERT INTO fleet_meta VALUES ('schema_version', '1');
CREATE TABLE leases (
  lease_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  released_at INTEGER,
  state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leases_node ON leases(node_id, state);
INSERT INTO leases VALUES ('n9:1', 'n9', 1, 1, 1, 1, 1000, NULL, 'live');
`);
  old.close();
  const migrated = openJournal(oldRoot, {});
  try {
    const column = migrated.db
      .prepare("PRAGMA table_info(leases)")
      .all()
      .find((entry) => entry.name === "expires_at");
    assert.ok(column, "the column is kept, so a rollback to the previous build can still write");
    assert.equal(column.notnull, 0, "and it is relaxed to nullable");
    assert.equal(migrated.liveLease("n9")?.epoch, 1, "the lease row survives the rebuild");
    assert.equal(
      migrated.db.prepare("SELECT expires_at FROM leases WHERE lease_id = 'n9:1'").get().expires_at,
      null,
      "the stale expiry is cleared: the column means nothing, and a number in it would read like it did",
    );
    assert.ok(
      migrated.db
        .prepare("PRAGMA index_list(leases)")
        .all()
        .some((row) => row.name === "leases_node"),
      "the lease index survives the rebuild",
    );
    assert.equal(migrated.acquireLease({ nodeId: "n10", ownerPid: process.pid, epoch: 1 })?.node_id, "n10");
    assert.equal(migrated.meta().schema_version, String(SCHEMA_VERSION), "the store records the shape it now has");
  } finally {
    migrated.close();
  }
});

check("a store this build created still accepts the previous build's lease write", () => {
  // The contract, verbatim: the schema-1 build writes a lease by naming the
  // expiry column. Dropping the column would leave every store this build
  // creates unopenable by a rollback, failing on "no such column" instead of on
  // anything an operator can act on. This is that build's INSERT, character for
  // character; the value it supplies is inert here.
  const previousBuildLeaseWrite = `INSERT INTO leases (lease_id, node_id, owner_pid, epoch, acquired_at, heartbeat_at, expires_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'live')
       ON CONFLICT(lease_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, expires_at = excluded.expires_at, state = 'live'`;
  journal.db
    .prepare(previousBuildLeaseWrite)
    .run("n11:1", "n11", process.pid, 1, 1, 1, Date.now() + 30_000);
  const row = journal.liveLease("n11");
  assert.equal(row?.epoch, 1, "the previous build's lease write landed, and this build reads it");
  journal.db.prepare("DELETE FROM leases WHERE lease_id = 'n11:1'").run();
});

check("a store from a newer build is refused with a sentence, not a SQLite error", () => {
  const newerRoot = mkdtempSync(join(tmpdir(), "fleet-schema-newer-"));
  const writer = openJournal(newerRoot, {});
  writer.db.prepare("UPDATE fleet_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION + 1));
  writer.close();
  assert.throws(
    () => openJournal(newerRoot, {}),
    (error) => {
      assert.match(String(error.message), /written by a newer build/, `the refusal names the reason: ${error.message}`);
      assert.match(String(error.message), new RegExp(`schema ${SCHEMA_VERSION + 1}`), "it names what it found");
      assert.ok(!/no such|syntax error/i.test(String(error.message)), "and it is not a statement failing deep down");
      return true;
    },
  );
});

check("the five node states are the design's five, and no others are written", () => {
  const node = journal.addNode({
    nodeId: "n1",
    parentId: null,
    projectRoot: root,
    charterPath: join(root, "charter.md"),
  });
  assert.equal(node.state, "settled");
  for (const state of ["waiting_on_child", "waiting_on_human", "failed", "done"]) {
    journal.setNodeState("n1", state);
    assert.equal(journal.getNode("n1").state, state);
  }
});

check("two fleet roots are two stores, never one", () => {
  const otherRoot = mkdtempSync(join(tmpdir(), "fleet-schema-other-"));
  const other = openJournal(otherRoot, {});
  try {
    assert.notEqual(other.path, journal.path);
    assert.equal(other.meta().store_path, other.path);
    assert.equal(other.listNodes().length, 0, "the other store has no nodes");
  } finally {
    other.close();
  }
  assert.ok(readdirSync(root).includes(JOURNAL_FILE));
});

check("reopening a store keeps its identity instead of rewriting it", () => {
  const createdAt = journal.meta().created_at;
  const again = openJournal(root, { driver: "rpc" });
  try {
    assert.equal(again.meta().created_at, createdAt, "created_at is written once");
    assert.equal(again.meta().driver, "scripted", "the original driver record survives");
    assert.equal(again.listNodes().length, 1, "nodes are not duplicated by a reopen");
  } finally {
    again.close();
  }
});

check("an effect's identity is stable within a turn and different across turns", () => {
  const a = effectKey({ nodeId: "n1", turnId: 1, toolCallId: "call-1" });
  const b = effectKey({ nodeId: "n1", turnId: 1, toolCallId: "call-1" });
  const c = effectKey({ nodeId: "n1", turnId: 2, toolCallId: "call-1" });
  const d = effectKey({ nodeId: "n1", turnId: 1, toolCallId: "call-2" });
  assert.equal(a, b);
  assert.notEqual(a, c);
  assert.notEqual(a, d);
  assert.match(a, /^[0-9a-f]{32}$/);
});

check("a replay policy is safe only for a read", () => {
  for (const tool of ["read", "ls", "find", "grep", "glob"]) assert.equal(replayPolicy(tool), "safe", tool);
  for (const tool of ["bash", "write", "edit", "fleet_effect"]) assert.equal(replayPolicy(tool), "never", tool);
});

check("the same tool call cannot be recorded twice inside one turn", () => {
  const turnId = journal.beginTurn("n1", { kind: "charter", promptText: "p" });
  const first = journal.effectAttempted({
    turnId,
    nodeId: "n1",
    toolCallId: "call-dup",
    toolName: "bash",
    args: { command: "echo one" },
    replay: "never",
    seq: 1,
  });
  journal.effectSettled({ turnId, toolCallId: "call-dup", result: { ok: 1 }, isError: false });
  journal.effectAttempted({
    turnId,
    nodeId: "n1",
    toolCallId: "call-dup",
    toolName: "bash",
    args: { command: "echo two" },
    replay: "never",
    seq: 1,
  });
  const rows = journal.effects(turnId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, "completed");
  assert.equal(rows[0].idempotency_key, first);
  assert.match(rows[0].args_json, /echo one/, "the first attempt's arguments are the recorded ones");
});

check("the guard's history read is an index seek, not a scan of every effect", () => {
  // The query belongs to the guard, so it is read from the guard: a copy
  // restated here would keep passing after the real one changed. Every prepare
  // made while the guard opens its journal is captured, the patch is restored
  // at once, and the statement that reads completed effects is the subject.
  const statements = [];
  const realPrepare = DatabaseSync.prototype.prepare;
  DatabaseSync.prototype.prepare = function capture(sql) {
    statements.push(String(sql));
    return realPrepare.call(this, sql);
  };
  let guard;
  try {
    guard = openGuardJournal(root);
  } finally {
    DatabaseSync.prototype.prepare = realPrepare;
  }
  try {
    const history = statements.find((sql) => /FROM effects/.test(sql) && sql.includes("state = 'completed'"));
    assert.ok(history, `the guard prepares a read of completed effects: ${JSON.stringify(statements)}`);
    const plan = journal.db
      .prepare(`EXPLAIN QUERY PLAN ${history}`)
      .all()
      .map((row) => row.detail)
      .join(" | ");
    assert.doesNotMatch(plan, /SCAN effects/, `the plan reads every effect in the store: ${plan}`);
    assert.doesNotMatch(plan, /TEMP B-TREE/, `the plan sorts the matches it finds: ${plan}`);
    assert.match(plan, /effects_call_history/, `the plan does not use the history index: ${plan}`);
  } finally {
    guard.close();
  }
});

journal.close();
console.log(`\nResults: ${passed} passed, ${failed} failed`);
process.exitCode = failed > 0 ? 1 : 0;
