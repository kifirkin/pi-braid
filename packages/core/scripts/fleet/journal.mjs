/**
 * fleet journal: the single SQLite file a fleet supervisor and its nodes
 * resume from, and the discovery record that says which file is the fleet's.
 *
 * The design constrains what a crash must survive; each of those constraints
 * is a field here, and `FLEET_JOURNAL_FIELDS` names the field-to-column
 * mapping next to the failure it prevents. Tests read that export and derive
 * the schema census from it, so a column dropped from the DDL fails a test
 * without anyone editing a second list.
 *
 * Two invariants the DDL enforces rather than documents:
 *
 *   - An effect is recorded at `tool_execution_start`, before the tool runs,
 *     and settled at `tool_execution_end`. `attempted` without an end is the
 *     only legal state a crash can leave, and it is what makes an unknown
 *     effect visible to the next turn.
 *   - Effect identity is `(turn_id, tool_call_id)`, so a resumed turn can
 *     never write a second row for a call it already recorded.
 *
 * Every write is synchronous and durable (`journal_mode = WAL`,
 * `synchronous = FULL`): a journal that can lose its last record across a
 * power cut is not the durable half of anything.
 */

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/**
 * The shape a store has once `openJournal` returns.
 *
 * Version 2 is version 1 with the lease's expiry column nullable and unset. The
 * column stays because the build that shipped version 1 names it in its lease
 * write, so a store without it is a store that build cannot open: a rollback
 * would die on "no such column" instead of on something an operator can act on.
 * Nothing here reads or writes it (see the leases DDL for why).
 *
 * A store recording a version above this one is refused rather than opened. Its
 * shape is one this code does not know, and `CREATE TABLE IF NOT EXISTS` would
 * leave it looking fine and then fail inside a statement far from the reason.
 */
export const SCHEMA_VERSION = 2;
export const JOURNAL_FILE = "fleet.sqlite";

/**
 * How long one statement waits for the write lock before SQLite reports it
 * busy, in milliseconds.
 *
 * 5000 was too small. Every write here commits with `synchronous = FULL`, so a
 * single commit is an fsync, and a supervisor draining a few hundred overdue
 * asks holds the lock for as long as that takes on a loaded box. A drainer that
 * met contention therefore threw `database is locked` at five seconds - a
 * legitimate drain under load, reported as a crash. Ten seconds is the wait
 * that turns that class of contention into waiting.
 *
 * It bounds one statement. Not a pass, and not a lease: a pass with its own
 * budget (the drain) or its own record (the tick's maintenance) sets the wait
 * per call with `withBusyTimeout`, and a node lease is not time-bounded at all
 * - exclusivity is its owner answering for it, as `acquireLease` explains.
 */
export const BUSY_TIMEOUT_MS = 10_000;

/**
 * The twelve things the journal must hold, in the design's order. `columns`
 * are `table.column`; `failure` is what breaks without the field, quoted so
 * the reason survives independently of the design document.
 */
export const FLEET_JOURNAL_FIELDS = [
  {
    n: 1,
    what: "node id, parent id, project root, charter path",
    columns: [
      "nodes.node_id",
      "nodes.parent_id",
      "nodes.project_root",
      "nodes.charter_path",
    ],
    failure: "a resumed fleet cannot say which nodes existed or where they belong",
  },
  {
    n: 2,
    what: "pi session id and session file path",
    columns: ["nodes.session_id", "nodes.session_file", "turns.session_id"],
    failure: "resume cannot reopen the same conversation, so it restarts the node",
  },
  {
    n: 3,
    what: "node state and attempt counter",
    columns: ["nodes.state", "nodes.attempts", "nodes.turn_count"],
    failure: "a crashed turn is indistinguishable from a finished one, and a lost node is silent",
  },
  {
    n: 4,
    what: "turn id, prompt ref, per-turn message history reference",
    columns: [
      "turns.turn_id",
      "turns.node_id",
      "turns.prompt_text",
      "model_requests.turn_id",
      "model_requests.seq",
      "model_requests.message_count",
      "model_requests.tool_count",
    ],
    failure: "the parent cannot tell in-flight work from queued work, or see what it sent",
  },
  {
    n: 5,
    what: "each completed effect, its idempotency key, its replay policy",
    columns: [
      "effects.tool_call_id",
      "effects.tool_name",
      "effects.idempotency_key",
      "effects.replay",
      "effects.state",
      "effects.result_json",
    ],
    failure: "the resume repeats the effect",
  },
  {
    n: 6,
    what: "parked ask: token, priority, question, proposed default, deadline, answer, answer source",
    columns: [
      "asks.token",
      "asks.priority",
      "asks.question",
      "asks.default_answer",
      "asks.deadline_at",
      "asks.state",
      "asks.answer_text",
      "asks.answer_source",
    ],
    failure: "a parked node's deadline passes with an answer no one can route",
  },
  {
    n: 7,
    what: "token and spend budget per node and per project",
    columns: [
      "nodes.token_cap",
      "nodes.spend_cap_usd",
      "nodes.tokens_in",
      "nodes.tokens_out",
      "nodes.spend_usd",
      "projects.token_cap",
      "projects.spend_cap_usd",
      "projects.tokens_in",
      "projects.tokens_out",
      "projects.spend_usd",
    ],
    failure: "a queued fleet is a bill with no ceiling",
  },
  {
    n: 8,
    what: "the lock each node holds on its workspace paths",
    columns: ["locks.path", "locks.owner_node", "locks.owner_epoch", "locks.acquired_at"],
    failure: "two nodes write the same file after a restart",
  },
  {
    n: 9,
    what: "the child process id per turn, with its start time",
    columns: ["turns.child_pid", "turns.child_pgid", "turns.started_at", "turns.supervisor_epoch"],
    failure: "an orphaned node keeps writing after the supervisor died",
  },
  {
    n: 10,
    what: "the message id, the node it was routed to, its delivery state",
    columns: [
      "inbox.msg_id",
      "inbox.node_id",
      "inbox.state",
      "inbox.delivered_tier",
      "inbox.delivered_turn_id",
      "routes.msg_id",
      "routes.node_id",
      "routes.delivery_state",
    ],
    failure: "a steered message is delivered twice or lost",
  },
  {
    n: 11,
    what: "the node lease: its owner, epoch, heartbeat and state",
    columns: ["leases.node_id", "leases.owner_pid", "leases.epoch", "leases.heartbeat_at", "leases.state"],
    failure: "two supervisors both believe they own one node",
  },
  {
    n: 12,
    what: "the supervisor's own epoch, so a restart can tell itself from a stale predecessor",
    columns: ["supervisors.pid", "supervisors.epoch", "supervisors.state", "supervisors.heartbeat_at"],
    failure: "a restarted supervisor waits on work its own dead predecessor still appears to hold",
  },
];

const DDL = `
CREATE TABLE IF NOT EXISTS fleet_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS projects (
  project_root TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  spend_usd REAL NOT NULL DEFAULT 0,
  token_cap INTEGER,
  spend_cap_usd REAL
);

CREATE TABLE IF NOT EXISTS nodes (
  node_id TEXT PRIMARY KEY,
  parent_id TEXT,
  project_root TEXT NOT NULL,
  charter_path TEXT NOT NULL,
  driver TEXT NOT NULL,
  driver_config TEXT NOT NULL DEFAULT '{}',
  state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  turn_count INTEGER NOT NULL DEFAULT 0,
  session_id TEXT,
  session_file TEXT,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  spend_usd REAL NOT NULL DEFAULT 0,
  token_cap INTEGER,
  spend_cap_usd REAL,
  done_reason TEXT,
  state_changed_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  turn_id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL,
  prompt_text TEXT,
  session_id TEXT,
  child_pid INTEGER,
  child_pgid INTEGER,
  supervisor_epoch INTEGER,
  model_requests INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  spend_usd REAL NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  ended_at INTEGER
);

CREATE TABLE IF NOT EXISTS model_requests (
  turn_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  message_count INTEGER NOT NULL DEFAULT 0,
  tool_count INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0,
  tokens_out INTEGER NOT NULL DEFAULT 0,
  at INTEGER NOT NULL,
  PRIMARY KEY (turn_id, seq)
);

CREATE TABLE IF NOT EXISTS effects (
  turn_id INTEGER NOT NULL,
  node_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  tool_name TEXT NOT NULL,
  args_json TEXT NOT NULL,
  replay TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  state TEXT NOT NULL,
  result_json TEXT,
  is_error INTEGER,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  PRIMARY KEY (turn_id, tool_call_id)
);
CREATE INDEX IF NOT EXISTS effects_idempotency_key ON effects(idempotency_key);
-- One node's calls to one tool, oldest turn first: the read the duplication
-- guard makes before every refusable call. Without it SQLite walks every effect
-- in the store and sorts the matches, so the refusal path costs more as the
-- project's history grows. The columns are the guard's own filters in its own
-- order - the node and tool are equalities, the turn is the range that bounds
-- its recovery window - so the ORDER BY ends on seq and is the index walk
-- rather than a temp b-tree. What is left (the state disjunction and is_error)
-- filters the handful of rows the window holds, which is why it is not in the
-- key: an equality-shaped index would leave the rows unordered by turn.
CREATE INDEX IF NOT EXISTS effects_call_history ON effects(node_id, tool_name, turn_id, seq);

CREATE TABLE IF NOT EXISTS asks (
  token TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  turn_id INTEGER,
  priority INTEGER NOT NULL DEFAULT 0,
  question TEXT NOT NULL,
  default_answer TEXT NOT NULL,
  deadline_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  answer_text TEXT,
  answer_source TEXT,
  asked_at INTEGER NOT NULL,
  answered_at INTEGER
);

CREATE TABLE IF NOT EXISTS inbox (
  msg_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  body TEXT NOT NULL,
  state TEXT NOT NULL,
  token TEXT,
  recorded_at INTEGER NOT NULL,
  delivered_at INTEGER,
  delivered_tier TEXT,
  delivered_turn_id INTEGER,
  delivered_after_effect_seq INTEGER,
  delivered_before_request_seq INTEGER
);
CREATE INDEX IF NOT EXISTS inbox_pending ON inbox(node_id, state);

CREATE TABLE IF NOT EXISTS routes (
  msg_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  token TEXT,
  decided_at INTEGER NOT NULL,
  delivery_state TEXT NOT NULL
);

-- expires_at is kept here, and left unset. The build that shipped schema version 1
-- writes it by name in its lease INSERT, so a store without the column is a store
-- that build cannot open. Nothing here reads it or writes it: a lease is
-- exclusive for as long as its owner answers for the node (see acquireLease), so
-- the value bounded nothing, and an expiry sitting in it is a number an operator
-- could read and be wrong about. A version-1 store is relaxed to this shape on
-- open and its stale values are cleared, so the column says "unset" afterwards.
CREATE TABLE IF NOT EXISTS leases (
  lease_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER,
  released_at INTEGER,
  state TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS leases_node ON leases(node_id, state);

CREATE TABLE IF NOT EXISTS supervisors (
  pid INTEGER PRIMARY KEY,
  epoch INTEGER NOT NULL,
  started_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  driver TEXT NOT NULL,
  child_args TEXT NOT NULL,
  pi_version TEXT
);

CREATE TABLE IF NOT EXISTS locks (
  path TEXT PRIMARY KEY,
  owner_node TEXT NOT NULL,
  owner_epoch INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  released_at INTEGER
);
`;

const now = () => Date.now();

/** A fleet root is an absolute directory; a relative one resolves against cwd. */
export function resolveFleetRoot(root) {
  const absolute = resolve(root);
  if (!isAbsolute(absolute)) throw new Error(`fleet root must be absolute: ${root}`);
  return absolute;
}

export function journalPath(root) {
  return join(resolveFleetRoot(root), JOURNAL_FILE);
}

/**
 * Discovery: `<root>/fleet.sqlite` is the fleet's journal, and that path is
 * recorded inside the file. A copy that travels without its root still says
 * which root it came from; two roots are two fleets and never one store.
 */

/** The schema version a store records, or null when it has never been written. */
function readStoredSchemaVersion(db) {
  const table = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fleet_meta'").get();
  if (!table) return null;
  const row = db.prepare("SELECT value FROM fleet_meta WHERE key = 'schema_version'").get();
  const version = Number(row?.value);
  return Number.isFinite(version) ? version : null;
}

/**
 * Relax `leases.expires_at` from NOT NULL to nullable, clearing every value, so
 * that a store written by the version-1 build opens here and that build's own
 * lease write keeps working after a rollback.
 *
 * SQLite cannot change a column in place, so the table is rebuilt once: every
 * row and the index come with it. The values do not - a stale expiry is the one
 * thing this column must not carry, because the column says nothing about the
 * lease and a number in it reads like something that does.
 */
function relaxLeaseExpiry(db) {
  const column = db
    .prepare("PRAGMA table_info(leases)")
    .all()
    .find((entry) => entry.name === "expires_at");
  if (!column || column.notnull === 0) return false;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE leases_relaxed (
  lease_id TEXT PRIMARY KEY,
  node_id TEXT NOT NULL,
  owner_pid INTEGER NOT NULL,
  epoch INTEGER NOT NULL,
  acquired_at INTEGER NOT NULL,
  heartbeat_at INTEGER NOT NULL,
  expires_at INTEGER,
  released_at INTEGER,
  state TEXT NOT NULL
)`);
    db.exec(`INSERT INTO leases_relaxed (lease_id, node_id, owner_pid, epoch, acquired_at, heartbeat_at, expires_at, released_at, state)
  SELECT lease_id, node_id, owner_pid, epoch, acquired_at, heartbeat_at, NULL, released_at, state FROM leases`);
    db.exec("DROP TABLE leases");
    db.exec("ALTER TABLE leases_relaxed RENAME TO leases");
    db.exec("CREATE INDEX IF NOT EXISTS leases_node ON leases(node_id, state)");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return true;
}

export function openJournal(root, options = {}) {
  const fleetRoot = resolveFleetRoot(root);
  mkdirSync(dirname(journalPath(fleetRoot)), { recursive: true });
  const db = new DatabaseSync(journalPath(fleetRoot));
  // The wait goes first. Every statement below can block on another process's
  // write, and a busy handler installed after them never applies to them: setting
  // the journal mode on a store another process is writing raises
  // "database is locked" immediately, because at that point this connection has
  // no handler and SQLite cannot wait. Measured: a two-drainer race failed about
  // one run in twenty at this line, before the timeout was ever in force.
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`);
  // The mode is a property of the file, not of this connection. Asking first
  // means a reader never has to take the exclusive lock that changing the mode
  // needs, and on a store that is already WAL the answer costs one pragma read.
  // The mode is a property of the file, not of this connection, so ask before
  // setting it: a reader never needs the exclusive lock that changing it takes.
  const isWal = () => String(Object.values(db.prepare("PRAGMA journal_mode").get() ?? {})[0] ?? "").toLowerCase() === "wal";
  if (!isWal()) {
    // Setting the mode needs an exclusive lock, and SQLite answers SQLITE_BUSY
    // for that statement without consulting the busy handler, so waiting on it is
    // not available. Two processes initialising one fresh store therefore race
    // and one of them throws. Retry a bounded number of times, and treat "someone
    // else already made it WAL" as success.
    const deadline = Date.now() + BUSY_TIMEOUT_MS;
    for (let attempt = 0; ; attempt += 1) {
      try {
        db.exec("PRAGMA journal_mode = WAL");
        break;
      } catch (error) {
        if (isWal()) break;
        if (Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(50 * (attempt + 1), 250));
      }
    }
  }
  db.exec("PRAGMA synchronous = FULL");
  // Before the DDL, because the DDL is written for this version's shape and a
  // store from a newer build has one this code does not know.
  const storedVersion = readStoredSchemaVersion(db);
  if (storedVersion != null && storedVersion > SCHEMA_VERSION) {
    throw new Error(
      `fleet store ${journalPath(fleetRoot)} was written by a newer build (schema ${storedVersion}; this build speaks ${SCHEMA_VERSION}): open it with that build, or move it aside and start a new root`,
    );
  }
  db.exec(DDL);
  relaxLeaseExpiry(db);
  const projectRoot = options.projectRoot ? resolve(options.projectRoot) : fleetRoot;
  const meta = {
    store_path: journalPath(fleetRoot),
    schema_version: String(SCHEMA_VERSION),
    project_root: projectRoot,
    driver: options.driver ?? "unset",
    child_args: JSON.stringify(options.childArgs ?? []),
    pi_version: options.piVersion ?? "unset",
    created_at: String(now()),
  };
  const insertMeta = db.prepare("INSERT OR IGNORE INTO fleet_meta(key, value) VALUES (?, ?)");
  for (const [key, value] of Object.entries(meta)) insertMeta.run(key, value);
  // A store opened here records the shape it now has. The insert above ignores a
  // row that already exists, so a store migrated from an older version needs the
  // value written rather than inserted.
  if (storedVersion !== SCHEMA_VERSION) {
    db.prepare("UPDATE fleet_meta SET value = ? WHERE key = 'schema_version'").run(String(SCHEMA_VERSION));
  }
  db.prepare("INSERT OR IGNORE INTO projects(project_root, created_at) VALUES (?, ?)").run(projectRoot, now());
  return new Journal(db, fleetRoot);
}

export class Journal {
  constructor(db, root) {
    this.db = db;
    this.root = root;
    this.path = journalPath(root);
    this._cache = new Map();
    this.busyTimeoutMs = BUSY_TIMEOUT_MS;
  }

  close() {
    this.db.close();
  }

  /**
   * Run `body` as one write transaction.
   *
   * `BEGIN IMMEDIATE` takes the write lock before the body reads, so two
   * processes that both intend to act on the same rows serialize: the second
   * one's read happens after the first one's commit, rather than against the
   * state the first one was about to change. A body that throws is rolled back
   * whole, which is what lets a caller treat several statements as one edit.
   *
   * `busyTimeoutMs` is the wait this transaction may spend acquiring that
   * lock, and it is per-connection state, so it is restored afterwards: a
   * caller with a bounded window of its own (the drain, whose retry loop is the
   * policy) does not leave every later statement in the process with it.
   */
  transaction(body, { busyTimeoutMs } = {}) {
    const previous = this.busyTimeoutMs;
    if (busyTimeoutMs != null && busyTimeoutMs !== previous) {
      this.db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`);
      this.busyTimeoutMs = Math.max(0, Math.floor(busyTimeoutMs));
    }
    try {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const result = body();
        this.db.exec("COMMIT");
        return result;
      } catch (error) {
        this.db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      if (this.busyTimeoutMs !== previous) {
        this.db.exec(`PRAGMA busy_timeout = ${previous}`);
        this.busyTimeoutMs = previous;
      }
    }
  }

  /**
   * Run `body` with a statement wait of `ms`, restoring the previous one after.
   *
   * The wait is per-connection state, and a caller with a bounded budget of its
   * own (the tick's maintenance passes, which must not block on a lock another
   * process may hold for as long as it likes) sets it here rather than leaving
   * every later statement in the process with it.
   */
  withBusyTimeout(ms, body) {
    const previous = this.busyTimeoutMs;
    const bounded = Math.max(0, Math.floor(ms));
    if (bounded !== previous) {
      this.db.exec(`PRAGMA busy_timeout = ${bounded}`);
      this.busyTimeoutMs = bounded;
    }
    try {
      return body();
    } finally {
      if (bounded !== previous) {
        this.db.exec(`PRAGMA busy_timeout = ${previous}`);
        this.busyTimeoutMs = previous;
      }
    }
  }

  _stmt(sql) {
    let stmt = this._cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this._cache.set(sql, stmt);
    }
    return stmt;
  }

  meta() {
    const rows = this._stmt("SELECT key, value FROM fleet_meta").all();
    return Object.fromEntries(rows.map((row) => [row.key, row.value]));
  }

  setMeta(key, value) {
    this._stmt("INSERT INTO fleet_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      key,
      String(value),
    );
  }

  /** Drop a meta key, for a fact that stops being true (a deferral that recovered). */
  clearMeta(key) {
    this._stmt("DELETE FROM fleet_meta WHERE key = ?").run(key);
  }

  // ── nodes ────────────────────────────────────────────────────────────────

  addNode(node) {
    this._stmt(
      `INSERT INTO nodes (node_id, parent_id, project_root, charter_path, driver, driver_config,
        state, attempts, turn_count, token_cap, spend_cap_usd, state_changed_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?)`,
    ).run(
      node.nodeId,
      node.parentId ?? null,
      resolve(node.projectRoot),
      node.charterPath,
      node.driver ?? "rpc",
      JSON.stringify(node.driverConfig ?? {}),
      node.state ?? "settled",
      node.tokenCap ?? null,
      node.spendCapUsd ?? null,
      now(),
      now(),
    );
    return this.getNode(node.nodeId);
  }

  getNode(nodeId) {
    return this._stmt("SELECT * FROM nodes WHERE node_id = ?").get(nodeId) ?? null;
  }

  listNodes() {
    return this._stmt("SELECT * FROM nodes ORDER BY created_at, node_id").all();
  }

  setNodeState(nodeId, state, extra = {}) {
    const fields = ["state = ?", "state_changed_at = ?"];
    const values = [state, now()];
    for (const [key, value] of Object.entries(extra)) {
      fields.push(`${key} = ?`);
      values.push(value);
    }
    values.push(nodeId);
    this._stmt(`UPDATE nodes SET ${fields.join(", ")} WHERE node_id = ?`).run(...values);
  }

  setNodeSession(nodeId, { sessionId, sessionFile }) {
    this._stmt("UPDATE nodes SET session_id = ?, session_file = ? WHERE node_id = ?").run(
      sessionId,
      sessionFile,
      nodeId,
    );
  }

  addNodeUsage(nodeId, { tokensIn = 0, tokensOut = 0, spendUsd = 0, projectRoot }) {
    this._stmt(
      "UPDATE nodes SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, spend_usd = spend_usd + ? WHERE node_id = ?",
    ).run(tokensIn, tokensOut, spendUsd, nodeId);
    if (projectRoot) {
      this._stmt(
        "UPDATE projects SET tokens_in = tokens_in + ?, tokens_out = tokens_out + ?, spend_usd = spend_usd + ? WHERE project_root = ?",
      ).run(tokensIn, tokensOut, spendUsd, projectRoot);
    }
  }

  project(projectRoot) {
    return (
      this._stmt("SELECT * FROM projects WHERE project_root = ?").get(projectRoot) ?? {
        project_root: projectRoot,
        tokens_in: 0,
        tokens_out: 0,
        spend_usd: 0,
        token_cap: null,
        spend_cap_usd: null,
      }
    );
  }

  /** A budget refusal is a decision, so it reads both caps and returns a reason. */
  budgetRefusal(projectRoot, nodeId) {
    const node = this.getNode(nodeId);
    const project = this.project(projectRoot);
    const over = (used, cap, label) =>
      cap != null && used >= cap ? `${label} spent ${Math.round(used)} of cap ${Math.round(cap)}` : null;
    return (
      over(node.tokens_in + node.tokens_out, node.token_cap, "node tokens") ??
      over(node.spend_usd, node.spend_cap_usd, "node spend") ??
      over(project.tokens_in + project.tokens_out, project.token_cap, "project tokens") ??
      over(project.spend_usd, project.spend_cap_usd, "project spend")
    );
  }

  // ── turns ────────────────────────────────────────────────────────────────

  /**
   * A turn is not an attempt. `attempts` counts recoveries and failures, so a
   * node that works steadily never accumulates one; the turn carries the
   * attempt number it was started under for the reader.
   */
  beginTurn(nodeId, { kind, promptText, sessionId, supervisorEpoch }) {
    const node = this.getNode(nodeId);
    const attempt = node?.attempts ?? 0;
    this._stmt("UPDATE nodes SET turn_count = turn_count + 1 WHERE node_id = ?").run(nodeId);
    const info = this._stmt(
      `INSERT INTO turns (node_id, attempt, kind, state, prompt_text, session_id, supervisor_epoch, started_at)
       VALUES (?, ?, ?, 'in_progress', ?, ?, ?, ?)`,
    ).run(nodeId, attempt, kind, promptText, sessionId ?? null, supervisorEpoch ?? null, now());
    return Number(info.lastInsertRowid);
  }

  turn(turnId) {
    return this._stmt("SELECT * FROM turns WHERE turn_id = ?").get(turnId) ?? null;
  }

  turnsFor(nodeId) {
    return this._stmt("SELECT * FROM turns WHERE node_id = ? ORDER BY turn_id").all(nodeId);
  }

  bumpAttempt(nodeId) {
    this._stmt("UPDATE nodes SET attempts = attempts + 1 WHERE node_id = ?").run(nodeId);
  }

  openTurns(nodeId) {
    return this._stmt("SELECT * FROM turns WHERE node_id = ? AND state = 'in_progress'").all(nodeId);
  }

  allOpenTurns() {
    return this._stmt("SELECT * FROM turns WHERE state = 'in_progress'").all();
  }

  setTurnChild(turnId, { pid, pgid }) {
    this._stmt("UPDATE turns SET child_pid = ?, child_pgid = ? WHERE turn_id = ?").run(pid, pgid, turnId);
  }

  endTurn(turnId, { state, tokensIn = 0, tokensOut = 0, spendUsd = 0, sessionId }) {
    this._stmt(
      `UPDATE turns SET state = ?, ended_at = ?, tokens_in = ?, tokens_out = ?, spend_usd = ?,
        session_id = COALESCE(?, session_id) WHERE turn_id = ?`,
    ).run(state, now(), tokensIn, tokensOut, spendUsd, sessionId ?? null, turnId);
  }

  recordModelRequest(turnId, { messageCount, toolCount, tokensIn = 0, tokensOut = 0 }) {
    const row = this._stmt("SELECT model_requests AS n FROM turns WHERE turn_id = ?").get(turnId);
    const seq = (row?.n ?? 0) + 1;
    this._stmt(
      "INSERT INTO model_requests (turn_id, seq, message_count, tool_count, tokens_in, tokens_out, at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(turnId, seq, messageCount, toolCount, tokensIn, tokensOut, now());
    this._stmt("UPDATE turns SET model_requests = ? WHERE turn_id = ?").run(seq, turnId);
    return seq;
  }

  modelRequests(turnId) {
    return this._stmt("SELECT * FROM model_requests WHERE turn_id = ? ORDER BY seq").all(turnId);
  }

  // ── effects ──────────────────────────────────────────────────────────────

  /**
   * Record the attempt before the tool runs. Two calls with the same identity
   * collapse into the first row (`INSERT OR IGNORE`): a replayed event stream
   * cannot invent a second attempt.
   */
  effectAttempted({ turnId, nodeId, toolCallId, toolName, args, replay, seq }) {
    const idempotencyKey = effectKey({ nodeId, turnId, toolCallId });
    this._stmt(
      `INSERT OR IGNORE INTO effects (turn_id, node_id, tool_call_id, seq, tool_name, args_json,
        replay, idempotency_key, state, started_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'attempted', ?)`,
    ).run(
      turnId,
      nodeId,
      toolCallId,
      seq ?? 0,
      toolName,
      JSON.stringify(args ?? null),
      replay,
      idempotencyKey,
      now(),
    );
    return idempotencyKey;
  }

  effectSettled({ turnId, toolCallId, result, isError }) {
    this._stmt(
      "UPDATE effects SET state = 'completed', result_json = ?, is_error = ?, ended_at = ? WHERE turn_id = ? AND tool_call_id = ? AND state = 'attempted'",
    ).run(JSON.stringify(result ?? null), isError ? 1 : 0, now(), turnId, toolCallId);
  }

  /**
   * An attempt with no end is the crash residue: the effect may or may not
   * have reached the world. It stays visible with `state = 'unknown'` so the
   * next turn is told about it instead of quietly repeating it.
   *
   * This state is inside the duplication guard, and the note says so. An
   * `unknown` row counts as history: a call it matches is refused before it
   * runs, because an effect that may have reached the world is the one class
   * where repeating is dangerous and the record cannot settle it. The guard's
   * window is the run being resumed - its current turn back to the last turn
   * that ended normally - so this is not "never again": a turn that finished its
   * work retires the run, and an operator retires a single row.
   *
   * Two instruments cover this class and they must agree: the guard refuses the
   * call, and `recoveryPrompt` in supervisor.mjs names every unknown effect with
   * the idempotency key that identifies it and tells the node the guard will
   * refuse a repeat. The interrupted turn this row belongs to is never a settled
   * turn, so it is inside the window of the turn that resumes it by
   * construction; a note that promised a refusal the guard does not make, or a
   * guard that refused without the note naming why, would each be half a fact.
   */
  markUnknownEffects(turnId) {
    const rows = this.attemptedEffects(turnId);
    this._stmt("UPDATE effects SET state = 'unknown' WHERE turn_id = ? AND state = 'attempted'").run(turnId);
    return rows;
  }

  attemptedEffects(turnId) {
    return this._stmt("SELECT * FROM effects WHERE turn_id = ? AND state = 'attempted' ORDER BY seq").all(turnId);
  }

  effects(turnId) {
    return this._stmt("SELECT * FROM effects WHERE turn_id = ? ORDER BY seq").all(turnId);
  }

  /** Effects a resumed turn must know about, in journal order. */
  settledEffects(turnId) {
    return this._stmt(
      "SELECT * FROM effects WHERE turn_id = ? AND state = 'completed' ORDER BY seq",
    ).all(turnId);
  }

  effectsByKey(idempotencyKey) {
    return this._stmt("SELECT * FROM effects WHERE idempotency_key = ? ORDER BY turn_id").all(idempotencyKey);
  }

  // ── asks and inbox ───────────────────────────────────────────────────────

  recordAsk(ask) {
    this._stmt(
      `INSERT INTO asks (token, node_id, turn_id, priority, question, default_answer, deadline_at, state, asked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'open', ?)`,
    ).run(
      ask.token,
      ask.nodeId,
      ask.turnId ?? null,
      Number(ask.priority ?? 0),
      ask.question,
      ask.defaultAnswer,
      ask.deadlineAt,
      now(),
    );
    return this.getAsk(ask.token);
  }

  getAsk(token) {
    return this._stmt("SELECT * FROM asks WHERE token = ?").get(token) ?? null;
  }

  /**
   * Open asks, most urgent first. Priority orders the head's attention; it
   * never changes the deadline, because a high priority that postponed the
   * default would be a park with extra steps.
   */
  openAsks(nodeId) {
    return nodeId
      ? this._stmt("SELECT * FROM asks WHERE node_id = ? AND state = 'open' ORDER BY priority DESC, asked_at").all(nodeId)
      : this._stmt("SELECT * FROM asks WHERE state = 'open' ORDER BY priority DESC, asked_at").all();
  }

  resolveAsk(token, { answerText, answerSource }) {
    this._stmt(
      "UPDATE asks SET state = 'answered', answer_text = ?, answer_source = ?, answered_at = ? WHERE token = ? AND state = 'open'",
    ).run(answerText, answerSource, now(), token);
    return this.getAsk(token);
  }

  /**
   * Parked work whose deadline passed takes its default. This is what keeps a
   * deadline from being decoration: the answer source says nobody answered.
   *
   * Returns only the asks THIS call claimed, and the claim is the conditional
   * UPDATE rather than the read. Two supervisors that both read the same
   * overdue rows must not both report them: each caller queues one message per
   * returned row, so a shared read set gives a parked node two copies of its
   * default in one prompt. `changes` is what decides, so the loser of the race
   * returns nothing and queues nothing.
   */
  expireAsks(at = now()) {
    const claimed = [];
    for (const ask of this.openAsks().filter((ask) => ask.deadline_at <= at)) {
      const result = this._stmt(
        "UPDATE asks SET state = 'answered', answer_text = ?, answer_source = ?, answered_at = ? WHERE token = ? AND state = 'open'",
      ).run(ask.default_answer, "deadline-default", now(), ask.token);
      if (result.changes > 0) {
        claimed.push({
          ...ask,
          state: "answered",
          answer_text: ask.default_answer,
          answer_source: "deadline-default",
        });
      }
    }
    return claimed;
  }

  addMessage(msg) {
    this._stmt(
      `INSERT INTO inbox (msg_id, node_id, kind, body, state, token, recorded_at)
       VALUES (?, ?, ?, ?, 'recorded', ?, ?)`,
    ).run(msg.msgId, msg.nodeId, msg.kind, msg.body, msg.token ?? null, now());
    this._stmt("INSERT OR REPLACE INTO routes (msg_id, node_id, token, decided_at, delivery_state) VALUES (?, ?, ?, ?, 'pending')").run(
      msg.msgId,
      msg.nodeId,
      msg.token ?? null,
      now(),
    );
    return this.getMessage(msg.msgId);
  }

  getMessage(msgId) {
    return this._stmt("SELECT * FROM inbox WHERE msg_id = ?").get(msgId) ?? null;
  }

  pendingMessages(nodeId) {
    return this._stmt(
      "SELECT * FROM inbox WHERE node_id = ? AND state = 'recorded' ORDER BY recorded_at, msg_id",
    ).all(nodeId);
  }

  markMessageDelivered(msgId, { tier, turnId, afterEffectSeq, beforeRequestSeq }) {
    this._stmt(
      `UPDATE inbox SET state = 'delivered', delivered_at = ?, delivered_tier = ?, delivered_turn_id = ?,
        delivered_after_effect_seq = ?, delivered_before_request_seq = ? WHERE msg_id = ?`,
    ).run(now(), tier, turnId ?? null, afterEffectSeq ?? null, beforeRequestSeq ?? null, msgId);
    this._stmt("UPDATE routes SET delivery_state = ? WHERE msg_id = ?").run(tier === "A" ? "steered" : "delivered", msgId);
  }

  /**
   * Retire every delivered row a node holds.
   *
   * Node-wide, so it cannot tell a message a prompt carried from one it did
   * not: the settle gate uses `consumeMessages` with the turn's own list, and
   * this remains the blunt instrument for callers that mean all of them.
   */
  markMessagesConsumed(nodeId) {
    this._stmt("UPDATE inbox SET state = 'consumed' WHERE node_id = ? AND state = 'delivered'").run(nodeId);
  }

  /**
   * Retire exactly the messages a turn carried.
   *
   * The ids are the turn's own account of what its prompt contained, so this
   * consumes what a model read and nothing else: a row that reached `delivered`
   * another way stays where it is, for the next turn that actually carries it.
   */
  consumeMessages(msgIds) {
    let consumed = 0;
    for (const msgId of msgIds) {
      consumed += this._stmt("UPDATE inbox SET state = 'consumed' WHERE msg_id = ? AND state = 'delivered'").run(msgId).changes;
    }
    return consumed;
  }

  /**
   * Put delivered messages back in the queue.
   *
   * A turn that never settled sent its prompt and did not finish: the body
   * reached a model and nothing acted on it, so the delivery columns are
   * cleared and the next turn carries it again. For an operator's instruction
   * the safe side to err on is at-least-once, and the recovery prompt is the
   * instrument that keeps the repetition visible.
   */
  releaseMessages(msgIds) {
    let released = 0;
    for (const msgId of msgIds) {
      released += this._stmt(
        `UPDATE inbox SET state = 'recorded', delivered_at = NULL, delivered_tier = NULL, delivered_turn_id = NULL,
          delivered_after_effect_seq = NULL, delivered_before_request_seq = NULL
         WHERE msg_id = ? AND state = 'delivered'`,
      ).run(msgId).changes;
    }
    return released;
  }

  /**
   * The terminal state for a message no turn will ever carry: the node it was
   * routed to is finished, or failed at its attempt bound, so the promise a
   * `recorded` row makes cannot be kept. Only the rows this call transitions
   * are returned, so two sweepers do not both report the same message.
   */
  markMessagesUndeliverable(nodeId) {
    const claimed = [];
    for (const message of this.pendingMessages(nodeId)) {
      const result = this._stmt("UPDATE inbox SET state = 'undeliverable' WHERE msg_id = ? AND state = 'recorded'").run(
        message.msg_id,
      );
      if (result.changes > 0) claimed.push({ ...message, state: "undeliverable" });
    }
    return claimed;
  }

  messages(nodeId) {
    return nodeId
      ? this._stmt("SELECT * FROM inbox WHERE node_id = ? ORDER BY recorded_at, msg_id").all(nodeId)
      : this._stmt("SELECT * FROM inbox ORDER BY recorded_at, msg_id").all();
  }

  // ── leases, supervisors, locks ───────────────────────────────────────────

  nextEpoch() {
    const row = this._stmt("SELECT MAX(epoch) AS epoch FROM supervisors").get();
    return Number(row?.epoch ?? 0) + 1;
  }

  registerSupervisor({ pid, driver, childArgs, piVersion }) {
    const epoch = this.nextEpoch();
    this._stmt(
      "INSERT INTO supervisors (pid, epoch, started_at, heartbeat_at, state, driver, child_args, pi_version) VALUES (?, ?, ?, ?, 'live', ?, ?, ?)",
    ).run(pid, epoch, now(), now(), driver, JSON.stringify(childArgs ?? []), piVersion ?? null);
    return epoch;
  }

  heartbeatSupervisor(pid) {
    this._stmt("UPDATE supervisors SET heartbeat_at = ? WHERE pid = ?").run(now(), pid);
  }

  setSupervisorState(pid, state) {
    this._stmt("UPDATE supervisors SET state = ? WHERE pid = ?").run(state, pid);
  }

  supervisors() {
    return this._stmt("SELECT * FROM supervisors ORDER BY epoch").all();
  }

  /**
   * Take or renew this epoch's lease on one node.
   *
   * Exclusivity is the owner answering for the node, not a clock. A lease lives
   * as long as its owner keeps renewing it, and a predecessor's lease ends in
   * reconciliation, which asks whether that owner is still there before it
   * touches anything.
   *
   * There is no expiry here, and the stored column of that name is deliberately
   * neither read nor written: a wall-clock bound was measured into disrepute (one
   * legitimate tick ran 32.7s under write contention, so any TTL short enough to
   * name lapsed mid-turn, and a lapsed lease a second supervisor may claim puts
   * one node under two drivers). Reconciliation refuses to fence a live owner's
   * turn for the same reason: a clock cannot see whether a child is still
   * working. The column survives only so the build that shipped it can still
   * open the store - see the leases DDL.
   */
  acquireLease({ nodeId, ownerPid, epoch }) {
    const existing = this.liveLease(nodeId);
    if (existing && existing.epoch !== epoch) return null;
    const leaseId = `${nodeId}:${epoch}`;
    this._stmt(
      `INSERT INTO leases (lease_id, node_id, owner_pid, epoch, acquired_at, heartbeat_at, state)
       VALUES (?, ?, ?, ?, ?, ?, 'live')
       ON CONFLICT(lease_id) DO UPDATE SET heartbeat_at = excluded.heartbeat_at, state = 'live'`,
    ).run(leaseId, nodeId, ownerPid, epoch, now(), now());
    return this._stmt("SELECT * FROM leases WHERE lease_id = ?").get(leaseId);
  }

  liveLease(nodeId) {
    return (
      this._stmt("SELECT * FROM leases WHERE node_id = ? AND state = 'live' ORDER BY epoch DESC LIMIT 1").get(nodeId) ??
      null
    );
  }

  liveLeases() {
    return this._stmt("SELECT * FROM leases WHERE state = 'live' ORDER BY node_id").all();
  }

  releaseLease(nodeId, epoch) {
    this._stmt("UPDATE leases SET state = 'released', released_at = ? WHERE lease_id = ?").run(now(), `${nodeId}:${epoch}`);
  }

  expireLease(leaseId) {
    this._stmt("UPDATE leases SET state = 'expired', released_at = ? WHERE lease_id = ?").run(now(), leaseId);
  }

  acquireLock({ path, ownerNode, ownerEpoch }) {
    const held = this._stmt("SELECT * FROM locks WHERE path = ? AND released_at IS NULL").get(path);
    if (held && held.owner_node !== ownerNode) return null;
    this._stmt(
      `INSERT INTO locks (path, owner_node, owner_epoch, acquired_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET owner_node = excluded.owner_node, owner_epoch = excluded.owner_epoch,
         acquired_at = excluded.acquired_at, released_at = NULL`,
    ).run(path, ownerNode, ownerEpoch, now());
    return this._stmt("SELECT * FROM locks WHERE path = ?").get(path);
  }

  releaseLocks(ownerNode) {
    this._stmt("UPDATE locks SET released_at = ? WHERE owner_node = ? AND released_at IS NULL").run(now(), ownerNode);
  }

  locks() {
    return this._stmt("SELECT * FROM locks ORDER BY path").all();
  }
}

/**
 * The effect's identity across a crash. A resumed turn that re-issues the same
 * tool call inside the same turn produces this key again, and the world can
 * dedupe on it; a naive resume that starts a fresh turn gets a different key,
 * which is exactly why the journal cannot be the only instrument measuring
 * duplication and the drill counts the world file too.
 */
export function effectKey({ nodeId, turnId, toolCallId }) {
  return createHash("sha256").update(`${nodeId}\n${turnId}\n${toolCallId}`).digest("hex").slice(0, 32);
}

/**
 * Replay policy per tool name, recorded before the attempt. `safe` means the
 * call can be run again without a second effect; everything else is `never`
 * until its end event lands, because the journal observed the effect rather
 * than owning it.
 */
export function replayPolicy(toolName) {
  return /^(read|ls|find|grep|glob|list|view|get_state|get_messages)$/i.test(toolName ?? "") ? "safe" : "never";
}
