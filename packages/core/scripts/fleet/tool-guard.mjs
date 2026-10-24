/**
 * The fleet's pre-execution duplication guard.
 *
 * Loaded as a pi extension inside every node's child, it refuses a tool call
 * whose effect the node's journal already recorded as completed on an earlier
 * turn, before the tool runs. That is the difference between a promise and an
 * executor: a resumed turn can be talked into repeating work, but a tool call
 * it re-issues cannot reach the world.
 *
 * The identity is (node_id, tool_name, canonical arguments) and it contains no
 * turn id on purpose. `effectKey` in journal.mjs hashes the turn, so it changes
 * on every resume by construction and can only ever match within one turn; this
 * key is the one that survives a crash. The turn id is not in it, and the
 * current turn is excluded from the history it is compared against, so a node
 * that runs the same command twice inside one turn is doing work and is left
 * alone.
 *
 * "Canonical arguments" is not a string compare, because the two sides of it
 * are two views of one tool call. The journal row was written from the RPC
 * stream's `tool_execution_start` args, which are the model's raw arguments;
 * this hook is handed the tool's own view of the same call. Measured for every
 * shipped tool at pi 1.4.0: explicit nulls appear on one side and not the
 * other (`{"command":"x","timeout":null}` against `{"command":"x"}`), and
 * the edit tool rewrites a legacy `{oldText,newText}` pair into
 * `{edits:[{oldText,newText}]}` before the hook runs. So a call matches a
 * recorded row when every argument it carries agrees with that row and unset
 * fields are ignored, with that one rewrite collapsed on both sides.
 *
 * Reads are never refused: `replayPolicy` in journal.mjs is the single policy
 * table, and a call it calls `safe` runs again however often it is issued.
 *
 * Environment contract, and the reason it is env: the child inherits nothing
 * else reliably. All three identifiers are required, and the guard is a
 * complete no-op without them, so this module can be loaded anywhere.
 *
 *   FLEET_GUARD_ROOT   the fleet root holding fleet.sqlite
 *   FLEET_GUARD_NODE   the node this child is driving
 *   FLEET_GUARD_TURN   the turn this child is driving
 *   FLEET_GUARD=off    the operator's escape hatch: the child is unguarded
 *
 * Failure behaviour is fail-open, deliberately. A guard that cannot read the
 * journal does not know whether a call is a duplicate, and refusing work on a
 * doubt turns a database hiccup into a frozen fleet. It reports loudly on
 * stderr and in `<root>/guard-errors.log` and lets the call run, which is a
 * trade-off and named as one, not an oversight.
 *
 * The record a refusal leaves is a row in `effects` with `state = 'blocked'`.
 * That state is a value of an existing column, so no schema change and no
 * `SCHEMA_VERSION` bump is involved, and `settledEffects` (state = completed)
 * and `markUnknownEffects` (state = attempted) both ignore it: a refusal is
 * neither an applied effect nor an unknown one.
 */

import { appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { effectKey, journalPath, replayPolicy } from "./journal.mjs";

/** The names the child reads. `off` is the switch, not an identifier. */
export const GUARD_ENV = {
  root: "FLEET_GUARD_ROOT",
  node: "FLEET_GUARD_NODE",
  turn: "FLEET_GUARD_TURN",
  off: "FLEET_GUARD",
};

/**
 * Keys sorted at every depth, unset fields dropped, so two spellings of one
 * call compare equal. A null is how these tool schemas spell "not given", and
 * the two surfaces disagree about whether to carry it.
 */
export function canonicalArgs(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalArgs);
  const sorted = {};
  for (const key of Object.keys(value).sort()) {
    const normalized = canonicalArgs(value[key]);
    if (normalized === undefined) continue;
    sorted[key] = normalized;
  }
  return sorted;
}

export function canonicalKey(args) {
  return JSON.stringify(canonicalArgs(args ?? null) ?? null);
}

/** The edit tool's one rewrite, applied to whichever side carries the pair. */
function collapseEditShape(args) {
  const edits = args?.edits;
  if (!Array.isArray(edits) || edits.length !== 1) return args;
  const [only] = edits;
  if (!only || typeof only !== "object") return args;
  const rest = {};
  for (const key of Object.keys(args)) {
    if (key !== "edits") rest[key] = args[key];
  }
  if (only.oldText !== undefined) rest.oldText = only.oldText;
  if (only.newText !== undefined) rest.newText = only.newText;
  return rest;
}

/** No field at all is no identity, so it cannot be a duplicate of anything. */
function carriesFields(value) {
  return value !== null && typeof value === "object" && Object.keys(value).length > 0;
}

/** Every field the call carries is present and equal in the recorded row. */
function covers(stored, call) {
  if (call === undefined) return stored === undefined;
  if (call === null) return stored === null;
  if (typeof call !== "object") return Object.is(call, stored);
  if (Array.isArray(call)) {
    return Array.isArray(stored) && stored.length === call.length && call.every((item, index) => covers(stored[index], item));
  }
  if (stored === null || typeof stored !== "object" || Array.isArray(stored)) return false;
  return Object.keys(call).every((key) => key in stored && covers(stored[key], call[key]));
}

/**
 * Is this call the one the recorded row already ran? The recorded row may
 * carry fields the call does not (a default the tool reports back, an explicit
 * null); the call may not carry anything the row lacks. A call that carries no
 * fields is refused a match outright, because vacuous agreement would block
 * every argument-less call of a tool that has ever run.
 */
export function sameCall({ toolName, recorded, args }) {
  const call = canonicalArgs(args ?? {});
  const row = canonicalArgs(recorded ?? {});
  if (!carriesFields(call)) return false;
  if (covers(row, call)) return true;
  if (toolName === "edit") {
    const collapsedCall = canonicalArgs(collapseEditShape(call));
    if (!carriesFields(collapsedCall)) return false;
    return covers(canonicalArgs(collapseEditShape(row)), collapsedCall);
  }
  return false;
}

/** Values of the switch that mean "off"; anything else leaves the guard on. */
const OFF_VALUES = new Set(["off", "0", "false", "no"]);

/**
 * The context the child was given, or null when it was given none. A partial
 * contract is no contract: a guard that knows the node but not the turn would
 * exclude the wrong turn from its history and refuse same-turn repeats.
 *
 * The switch is read as an explicit "off" rather than as "set at all", so a
 * typo or a `FLEET_GUARD=on` leaves the guard running. A guard that silently
 * disables itself is worse than one that refuses a call the operator can see.
 */
export function guardContext(env = process.env) {
  const root = env[GUARD_ENV.root];
  const nodeId = env[GUARD_ENV.node];
  const rawTurn = env[GUARD_ENV.turn];
  if (!root || !nodeId || rawTurn == null || rawTurn === "") return null;
  if (OFF_VALUES.has(String(env[GUARD_ENV.off] ?? "").trim().toLowerCase())) return null;
  const turnId = Number(rawTurn);
  if (!Number.isInteger(turnId) || turnId <= 0) return null;
  return { root: resolve(String(root)), nodeId: String(nodeId), turnId };
}

/**
 * The journal, as the guard needs it: one read and one write, both spelled
 * here rather than added to journal.mjs so the shipped reader stays untouched.
 *
 * The supervisor holds its own connection to the same file, so every write is
 * an upsert: the supervisor records the attempt from the RPC stream at about
 * the same moment the guard refuses the call, and whichever lands second must
 * not decide the outcome. `effectSettled` in journal.mjs only rewrites rows in
 * `attempted`, so a row this module writes as `blocked` cannot be turned into a
 * completed effect afterwards.
 */
export function openGuardJournal(root) {
  const path = journalPath(root);
  if (!existsSync(path)) throw new Error(`no fleet journal at ${path}`);
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA synchronous = FULL");
  const findCompleted = db.prepare(
    `SELECT turn_id, tool_call_id, seq, args_json FROM effects
      WHERE node_id = ? AND tool_name = ? AND state = 'completed' AND turn_id <> ?
      ORDER BY turn_id, seq`,
  );
  const upsertBlock = db.prepare(
    `INSERT INTO effects (turn_id, node_id, tool_call_id, seq, tool_name, args_json, replay,
       idempotency_key, state, result_json, is_error, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, 1, ?, ?)
     ON CONFLICT(turn_id, tool_call_id) DO UPDATE SET
       state = 'blocked', result_json = excluded.result_json, is_error = 1, ended_at = excluded.ended_at`,
  );
  return {
    /** The oldest completed row for this call outside the current turn. */
    completedDuplicate({ nodeId, toolName, args, excludeTurnId }) {
      for (const row of findCompleted.all(nodeId, toolName, excludeTurnId)) {
        let stored;
        try {
          stored = JSON.parse(row.args_json);
        } catch {
          continue;
        }
        if (sameCall({ toolName, recorded: stored, args })) {
          return { turnId: row.turn_id, toolCallId: row.tool_call_id, seq: row.seq };
        }
      }
      return null;
    },
    recordBlock({ turnId, nodeId, toolCallId, toolName, args, reason, duplicate }) {
      const at = Date.now();
      upsertBlock.run(
        turnId,
        nodeId,
        toolCallId,
        // The supervisor assigns this turn's sequence numbers from the RPC
        // stream; the guard cannot know the next one, and the column is not
        // part of the primary key, so a refusal sits at 0 and is found by
        // state rather than by order.
        0,
        toolName,
        JSON.stringify(args ?? null),
        replayPolicy(toolName),
        effectKey({ nodeId, turnId, toolCallId }),
        JSON.stringify({
          blocked: true,
          reason,
          duplicate_of_turn: duplicate.turnId,
          duplicate_of_tool_call: duplicate.toolCallId,
          duplicate_of_seq: duplicate.seq,
        }),
        at,
        at,
      );
    },
    close() {
      db.close();
    },
  };
}

function stderrReport(line) {
  try {
    process.stderr.write(`fleet-guard: ${line}\n`);
  } catch {
    // A closed stderr is not a reason to stop driving.
  }
}

/**
 * The decision, with the journal injected. `store` is a thunk so the extension
 * can open the database on the first tool call and not in its factory.
 */
export function createGuard({ nodeId, turnId, store, report = stderrReport }) {
  return {
    nodeId,
    turnId,
    /**
     * Called by pi before the tool executes. Returns a refusal, or nothing.
     * The refusal text becomes the tool's result, so it has to tell the model
     * what happened and what not to do next.
     */
    onToolCall(event) {
      const toolName = event?.toolName;
      const toolCallId = event?.toolCallId;
      if (!toolName || !toolCallId) return undefined;
      if (replayPolicy(toolName) === "safe") return undefined;
      const args = event.input ?? {};
      let journal;
      let duplicate;
      try {
        journal = store();
        duplicate = journal.completedDuplicate({ nodeId, toolName, args, excludeTurnId: turnId });
      } catch (error) {
        // Cannot read, so cannot refuse: the alternative is a fleet that stops
        // working when its journal does.
        report(
          `journal unreadable at ${nodeId} turn ${turnId} (${error.code ?? ""} ${error.message}); call ${toolCallId} ${toolName} allowed through unguarded`,
        );
        return undefined;
      }
      if (!duplicate) return undefined;
      const reason =
        `fleet guard: refused ${toolName} call ${toolCallId}. The same call, with identical arguments, ` +
        `was already completed on turn ${duplicate.turnId} of node ${nodeId} and this turn is ${turnId}. ` +
        `It was not executed. Do not retry it; continue from the next unfinished step, or change the call ` +
        `if the work genuinely differs.`;
      try {
        journal.recordBlock({ turnId, nodeId, toolCallId, toolName, args, reason, duplicate });
      } catch (error) {
        // The refusal is the safety property and stands without its record.
        // The record is the instrument, so its failure is reported, not hidden.
        report(
          `refused ${toolName} call ${toolCallId} at ${nodeId} turn ${turnId} but could not record it (${error.code ?? ""} ${error.message})`,
        );
      }
      return { block: true, reason };
    },
  };
}

/** Where the guard reports when it has a root: stderr, and a line in the root. */
export function guardReport(root, line) {
  stderrReport(line);
  if (!root) return;
  try {
    appendFileSync(join(root, "guard-errors.log"), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // The report is best effort; stderr already carried it.
  }
}

export default function toolGuard(pi) {
  const context = guardContext();
  if (!context) return;
  let store = null;
  const guard = createGuard({
    nodeId: context.nodeId,
    turnId: context.turnId,
    store: () => (store ??= openGuardJournal(context.root)),
    report: (line) => guardReport(context.root, line),
  });
  pi.on("tool_call", (event) => guard.onToolCall(event));
  pi.on("session_shutdown", () => {
    try {
      store?.close();
    } catch {
      // Nothing left to close.
    }
    store = null;
  });
}
