/**
 * The fleet's pre-execution duplication guard.
 *
 * Loaded as a pi extension inside every node's child, it refuses a tool call
 * whose effect the node's journal already recorded on an earlier turn of the
 * run it is resuming, before the tool runs. That is the difference between a
 * promise and an executor: a resumed turn can be talked into repeating work,
 * but a tool call it re-issues cannot reach the world.
 *
 * The identity is (node_id, tool_name, canonical arguments) and it contains no
 * turn id on purpose. `effectKey` in journal.mjs hashes the turn, so it changes
 * on every resume by construction and can only ever match within one turn; this
 * key is the one that survives a crash. The turn id is not in it, and the
 * current turn is excluded from the history it is compared against, so a node
 * that runs the same command twice inside one turn is doing work and is left
 * alone.
 *
 * The history it is compared against is the recovery window, not the project's
 * lifetime. A fleet root outlives every turn (`<cwd>/.fleet` by default), so a
 * filter that read "an earlier turn" as "any earlier turn" made every effect a
 * node had ever recorded permanent: one `ls -la` in the project's past blocked
 * that command for the rest of the project's life, and `replayPolicy("bash")`
 * is `never`, so every shell command a node had completed became unrunnable -
 * the inspection commands a resumed turn needs first of all. The hazard this
 * module exists for is narrow, and the window is now the same width: the
 * current turn, plus every turn back to the last one that ended normally. That
 * is the recovery chain - the turns of this unfinished run. A turn that ended
 * normally (`settled`, `parked`, `done`) finished the work it was started for,
 * so its effects are finished business: a later turn that repeats one is doing
 * new work, and no crash can have left it half applied. An `interrupted` or
 * `failed` turn, and a turn still `in_progress`, did not finish; its effects
 * are what a resumed turn is at risk of re-issuing without knowing.
 *
 * Inside that window a row is history only if it may have reached the world:
 * `completed` with `is_error = 0`, or `unknown`, which is the crash residue
 * where the tool started and never reported. A call that threw applied
 * nothing, so refusing its retry refused work that never happened. `attempted`
 * is a call still in flight and `blocked` is one this guard refused; neither
 * is history.
 *
 * "Canonical arguments" is not a string compare, because the two sides of it
 * are two views of one tool call. The journal row was written from the RPC
 * stream's `tool_execution_start` args, which are the model's raw arguments;
 * this hook is handed the tool's own view of the same call. Measured for every
 * shipped tool at pi 1.4.0: explicit nulls appear on one side and not the
 * other (`{"command":"x","timeout":null}` against `{"command":"x"}`), the
 * edit tool rewrites a legacy `{oldText,newText}` pair into
 * `{edits:[{oldText,newText}]}` before the hook runs, a scalar the model typed
 * as a string arrives as the tool's validated type (`timeout: "30"` recorded,
 * `timeout: 30` handed to the hook), and `edits` sent as a JSON string arrives
 * as the parsed array. So a call matches a recorded row when every argument it
 * carries agrees with that row and unset fields are ignored, with those three
 * dialects folded on both sides.
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
 *
 * A refusal stays recoverable, deliberately through an operator and not
 * through the model. A node that genuinely has to repeat a recorded effect and
 * cannot express it differently - a shell command, whose arguments are the
 * whole identity - is released by retiring exactly the row the refusal names
 * in its `result_json`:
 *
 *   sqlite3 <root>/fleet.sqlite "UPDATE effects SET state = 'superseded'
 *     WHERE turn_id = <duplicate_of_turn> AND tool_call_id = '<duplicate_of_tool_call>'"
 *
 * `superseded` is another value of the same state column, and every reader of
 * `effects` in journal.mjs matches a positive list (`completed`, `attempted`),
 * so the retired row stops counting as history without leaving the record.
 * The statement is not offered to the model and nothing in the child runs it:
 * the refusal tells the model to continue from the next unfinished step and
 * names the release as an operator's decision. A model that goes around the
 * guard to the database itself is attacking the instrument, and an in-process
 * guard cannot defend against a process it is loaded inside.
 */

import { appendFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

import { DatabaseSync, effectKey, journalPath, replayPolicy } from "./journal.mjs";

/** The names the child reads. `off` is the switch, not an identifier. */
export const GUARD_ENV = {
  root: "FLEET_GUARD_ROOT",
  node: "FLEET_GUARD_NODE",
  turn: "FLEET_GUARD_TURN",
  off: "FLEET_GUARD",
};

/**
 * A scalar leaf, with the one coercion the two views of a call disagree about.
 *
 * A model writes `timeout: "30"`; pi validates the arguments against the
 * tool's schema and hands this hook `timeout: 30`; the journal kept the
 * string. So the same argument arrives in two types and the row never
 * matched. The rule that closes it is the narrowest one available: a string
 * converts only when it converts back to itself, `String(Number(s)) === s`.
 * `"30"` becomes 30 and matches a recorded 30; `"030"`, `" 30 "`, `"1e3"`,
 * `"NaN"` and `""` all spell numbers and stay strings, because an argument
 * typed as a string may legitimately hold one and merging it with a number
 * would call two genuinely different arguments the same.
 *
 * The asymmetry of the two failure modes is why the rule is this narrow. A
 * spelling that is not converted lets a duplicate run, which leaves the guard
 * advisory for that spelling - the state every other tool shape is already in.
 * A spelling that is converted too eagerly refuses a call that should run,
 * permanently, which is the defect this canonicalisation exists to repair.
 * `"true"` and `"false"` convert for the same reason and with the same
 * exactness: only those two spellings, only to the boolean.
 */
function canonicalScalar(value) {
  if (typeof value !== "string") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  const asNumber = Number(value);
  return Number.isFinite(asNumber) && String(asNumber) === value ? asNumber : value;
}

/**
 * Keys sorted at every depth, unset fields dropped, so two spellings of one
 * call compare equal. A null is how these tool schemas spell "not given", and
 * the two surfaces disagree about whether to carry it.
 */
export function canonicalArgs(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "object") return canonicalScalar(value);
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

/**
 * Two of pi's models send `edits` as a JSON string instead of an array; the
 * edit tool parses it before this hook runs, so the hook holds the array while
 * the journal kept the string. Parse it on the recorded side and on the call
 * side, so either direction compares equal. A string that does not parse to an
 * array is left exactly as it is: it is then a genuinely different argument,
 * not a dialect of the same one.
 */
function parseEditArgs(args) {
  if (args === null || typeof args !== "object" || Array.isArray(args)) return args;
  if (typeof args.edits !== "string") return args;
  let parsed;
  try {
    parsed = JSON.parse(args.edits);
  } catch {
    return args;
  }
  return Array.isArray(parsed) ? { ...args, edits: parsed } : args;
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
  const isEdit = toolName === "edit";
  const call = canonicalArgs(isEdit ? parseEditArgs(args) : args);
  const row = canonicalArgs(isEdit ? parseEditArgs(recorded) : recorded);
  if (!carriesFields(call)) return false;
  if (covers(row, call)) return true;
  if (!isEdit) return false;
  const collapsedCall = canonicalArgs(collapseEditShape(call));
  if (!carriesFields(collapsedCall)) return false;
  return covers(canonicalArgs(collapseEditShape(row)), collapsedCall);
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
 * The states a turn can end in and be finished. `settled` is an ordinary turn,
 * `parked` stopped to ask a human, `done` reported the charter complete; each
 * finished the work it was started for, so the recovery window stops there.
 * `interrupted` and `failed` are turns that were cut off, and `in_progress` is
 * a turn that has not ended at all - all three are inside the window.
 */
export const SETTLED_TURN_STATES = Object.freeze(["settled", "parked", "done"]);

/**
 * The journal, as the guard needs it: two reads and one write, each spelled
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
  // The floor of the recovery window: the last turn of this node that ended
  // normally. `MAX` is what makes the window the recovery chain rather than
  // "every turn that did not settle": an interruption older than a later
  // settled turn was resolved by the run that settled, so its effects are
  // finished business again.
  const windowFloor = db.prepare(
    `SELECT COALESCE(MAX(turn_id), 0) AS floor FROM turns
      WHERE node_id = ? AND turn_id < ? AND state IN (${SETTLED_TURN_STATES.map(() => "?").join(", ")})`,
  );
  const findApplied = db.prepare(
    `SELECT turn_id, tool_call_id, seq, args_json, state FROM effects
      WHERE node_id = ? AND tool_name = ? AND turn_id <> ? AND turn_id > ?
        AND (state = 'unknown' OR (state = 'completed' AND is_error = 0))
      ORDER BY turn_id, seq`,
  );
  const upsertBlock = db.prepare(
    `INSERT INTO effects (turn_id, node_id, tool_call_id, seq, tool_name, args_json, replay,
       idempotency_key, state, result_json, is_error, started_at, ended_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'blocked', ?, 1, ?, ?)
     ON CONFLICT(turn_id, tool_call_id) DO UPDATE SET
       state = 'blocked', result_json = excluded.result_json, is_error = 1, ended_at = excluded.ended_at`,
  );
  let floorFor = null;
  return {
    /**
     * The oldest recorded effect for this call that may have reached the
     * world, inside the recovery window. `unknown` is included on purpose: the
     * tool started and never reported, so the effect may have half applied,
     * which is the one class where repeating it is dangerous.
     *
     * The floor is read once per turn and not once per call: a turn that ended
     * before this one cannot start ending differently while this one runs, and
     * the only writer that touches an older turn is reconcile, which marks an
     * open turn `interrupted` and never `settled`. So the window cannot move
     * under a turn, and on a node issuing fifty shell commands a turn the
     * second read would otherwise be fifty scans of `turns`.
     */
    appliedDuplicate({ nodeId, toolName, args, currentTurnId }) {
      const windowKey = `${nodeId}\u0000${currentTurnId}`;
      if (floorFor?.key !== windowKey) {
        floorFor = { key: windowKey, floor: windowFloor.get(nodeId, currentTurnId, ...SETTLED_TURN_STATES).floor };
      }
      for (const row of findApplied.all(nodeId, toolName, currentTurnId, floorFor.floor)) {
        let stored;
        try {
          stored = JSON.parse(row.args_json);
        } catch {
          continue;
        }
        if (sameCall({ toolName, recorded: stored, args })) {
          return { turnId: row.turn_id, toolCallId: row.tool_call_id, seq: row.seq, state: row.state };
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
     * what happened and what not to do next. It says who releases a blocked
     * effect and does not say how: a model that could retire its own rows is a
     * model policing itself, which is what this module exists instead of.
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
        duplicate = journal.appliedDuplicate({ nodeId, toolName, args, currentTurnId: turnId });
      } catch (error) {
        // Cannot read, so cannot refuse: the alternative is a fleet that stops
        // working when its journal does.
        report(
          `journal unreadable at ${nodeId} turn ${turnId} (${error.code ?? ""} ${error.message}); call ${toolCallId} ${toolName} allowed through unguarded`,
        );
        return undefined;
      }
      if (!duplicate) return undefined;
      const recorded =
        duplicate.state === "unknown"
          ? `was recorded on turn ${duplicate.turnId} of node ${nodeId} as an attempt that never reported back, so it may have reached the world`
          : `was already completed on turn ${duplicate.turnId} of node ${nodeId}`;
      const reason =
        `fleet guard: refused ${toolName} call ${toolCallId}. The same call, with identical arguments, ${recorded}; ` +
        `this turn is ${turnId} and it was not executed. Do not retry it: continue from the next unfinished step, ` +
        `or change the call if the work genuinely differs. Repeating a recorded effect is not something this turn ` +
        `can authorise - an operator has to release the recorded effect in the node's journal first, and the ` +
        `refusal this call leaves records which row that is.`;
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
