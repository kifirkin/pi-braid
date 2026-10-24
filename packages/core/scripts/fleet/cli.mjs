#!/usr/bin/env node
/**
 * fleet: four operator commands over one journal.
 *
 *   fleet spawn <parent|-> <charter>   register a node and make sure one supervisor runs
 *   fleet status [--json]              the fleet as the journal and ps report it
 *   fleet inject <node> <text>         deliver a message; steers a running turn when it can
 *   fleet ask <node> <question>        record a question with a token a human can answer
 *
 * `inject --token <token>` is the answer path: the token is shared between ask
 * and answer, so one verb covers both directions (ordinary steer, and a reply
 * to a parked node).
 *
 * Delivery tiers, recorded on the inbox row, never guessed at:
 *   A  a turn was in flight, and the child ran the steered text inside that turn
 *      (`delivered_tier = 'A'`). Written only from the driver's own
 *      `steer_delivered` event: pi answers a steer request when it has *queued*
 *      the text, and a queue is not a delivery, so the ack alone records
 *      nothing.
 *   B  the supervisor was up but the node was not streaming; queued, and the
 *      next turn for the node carries it (`delivered_tier = 'B'`)
 *   C  no supervisor was running; the message waits in the journal for the next
 *      turn a supervisor drives (`state = 'recorded'`)
 *
 * So `inject` during a turn reports "steered", not "delivered": the row stays
 * `recorded` until the child runs the text, and the turn after it carries the
 * message if the child ends without doing so.
 *
 * And the other end of the same account: a message is retired
 * (`state = 'consumed'`) only when its body was in the prompt a turn sent. One
 * that no turn will ever carry - the node is done, or failed at its attempt
 * bound - is stamped `undeliverable` by the supervisor and counted in `status`,
 * and this command refuses to queue for a finished node in the first place.
 */

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { openJournal, resolveFleetRoot } from "./journal.mjs";
import { buildStatus, controlSocketPath, DEFAULT_ANSWER, requestOnControlSocket, undeliverableReason } from "./supervisor.mjs";
import { pidIsAlive } from "./procs.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPERVISOR = join(HERE, "supervisor.mjs");

export function defaultRoot(cwd = process.cwd()) {
  return resolveFleetRoot(process.env.PI_FLEET_ROOT ?? join(cwd, ".fleet"));
}

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 24) || "node";
}

/** One request, one response line, over the supervisor's unix socket. */
export function controlRequest(root, request, { timeoutMs = 10_000 } = {}) {
  const path = controlSocketPath(root);
  if (!existsSync(path)) return Promise.resolve(null);
  return requestOnControlSocket(path, request, { timeoutMs });
}

/** The journalled supervisor that is still a live process, or null. */
function liveSupervisor(journal) {
  for (const row of journal.supervisors()) {
    if (row.state !== "live") continue;
    if (pidIsAlive(row.pid)) return row;
    journal.setSupervisorState(row.pid, "dead");
  }
  return null;
}

/**
 * The supervisor's command line, built in one place so a flag cannot be read by
 * the parser and then dropped on the way to the process that understands it.
 *
 * `--idle-exit-ms` is the flag that made this a function: `fleet spawn`
 * accepted it and never passed it on, which is worse than not accepting it, so
 * it is now forwarded and its value is refused when it is not a number the
 * supervisor can use.
 */
export function supervisorArgs(root, options = {}) {
  const args = [SUPERVISOR, "--root", resolveFleetRoot(root)];
  if (options.cap != null) args.push("--cap", String(options.cap));
  if (options.driver) args.push("--driver", options.driver);
  if (options.model) args.push("--model", options.model);
  if (options.piBin) args.push("--pi-bin", options.piBin);
  if (options.idleExitMs != null) args.push("--idle-exit-ms", String(wholeMilliseconds(options.idleExitMs, "--idle-exit-ms")));
  for (const extension of options.extensions ?? []) args.push("--extension", extension);
  for (const flag of options.childFlags ?? []) args.push(flag);
  return args;
}

/**
 * A flag the supervisor will read as milliseconds, or a refusal.
 *
 * Read from its spelled form on purpose: `--idle-exit-ms` with no value arrives
 * as the boolean `true`, and `Number(true)` is 1, which would have been a
 * supervisor told to exit after one millisecond. A caller that has already
 * parsed the flag passes a number, and a number is checked the same way.
 */
function wholeMilliseconds(value, flag) {
  const text = typeof value === "number" ? String(value) : value;
  if (typeof text !== "string" || !/^\d+$/.test(text.trim()) || Number(text) <= 0) {
    throw new Error(`${flag} needs a whole number of milliseconds greater than 0 (got ${JSON.stringify(value)})`);
  }
  return Number(text);
}

/**
 * Start the supervisor unless one is already there. Two instruments answer
 * that, and they answer different questions: the channel says whether a
 * supervisor can actually be reached, the journal row says whether a process
 * claims the job. A supervisor that never bound, or refused to, leaves a row
 * that only the channel corrects, so the channel is asked first, and the
 * journal is the answer when the channel is the thing that is broken. Starting
 * a second supervisor over a live channel is the one outcome neither may cause.
 *
 * Detached with its own process group: the drill kills it with SIGKILL, which
 * is only a meaningful test if nothing else is holding it up.
 */
export async function ensureSupervisor(root, options = {}) {
  const answering = await controlRequest(root, { op: "ping" }, { timeoutMs: 1000 });
  if (answering?.ok) return { started: false, pid: answering.data.pid };
  const journal = openJournal(root, {});
  const live = liveSupervisor(journal);
  journal.close();
  if (live) return { started: false, pid: live.pid };
  const logPath = join(resolveFleetRoot(root), "supervisor.log");
  mkdirSync(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, "a");
  const args = supervisorArgs(root, options);
  const child = spawn(process.execPath, args, {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    cwd: process.cwd(),
    env: process.env,
  });
  child.unref();
  closeSync(logFd);
  return { started: true, pid: child.pid, logPath };
}

function svrLogPath(root) {
  return join(resolveFleetRoot(root), "supervisor.log");
}

async function waitForSupervisor(root, { timeoutMs = 10_000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const reply = await controlRequest(root, { op: "ping" }, { timeoutMs: 500 });
    if (reply?.ok) return reply.data;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return null;
}

// ── commands ────────────────────────────────────────────────────────────────

async function cmdSpawn(args) {
  const [parent, charter] = args._;
  if (!parent || !charter) throw new Error("usage: fleet spawn <parent|-> <charter-path>");
  // Read before the node is registered: a flag refused after the journal has
  // already recorded a spawn is a half-done command, and the operator asked for
  // one thing that failed.
  const idleExitMs = args["idle-exit-ms"] == null ? undefined : wholeMilliseconds(args["idle-exit-ms"], "--idle-exit-ms");
  const root = args.root ?? defaultRoot();
  const charterPath = resolve(charter);
  if (!existsSync(charterPath)) throw new Error(`charter not found: ${charterPath}`);
  const journal = openJournal(root, {});
  try {
    if (parent !== "-" && !journal.getNode(parent)) throw new Error(`no such parent node: ${parent}`);
    const existing = journal.listNodes();
    const stem = basename(charterPath).split(".")[0];
    const nodeId = `n${existing.length + 1}-${slug(stem)}`;
    if (journal.getNode(nodeId)) throw new Error(`node id already taken: ${nodeId}`);
    journal.addNode({
      nodeId,
      parentId: parent === "-" ? null : parent,
      projectRoot: args["project-root"] ? resolve(args["project-root"]) : process.cwd(),
      charterPath,
      driver: args.driver ?? "rpc",
      tokenCap: args["token-cap"] ? Number(args["token-cap"]) : null,
      spendCapUsd: args["spend-cap"] ? Number(args["spend-cap"]) : null,
    });
    console.log(`spawned ${nodeId} (parent ${parent}) charter ${charterPath}`);
  } finally {
    journal.close();
  }
  const supervisor = await ensureSupervisor(root, {
    cap: args.cap ? Number(args.cap) : undefined,
    driver: args["supervisor-driver"],
    model: args.model,
    piBin: args["pi-bin"],
    idleExitMs,
    extensions: args.extension ? [].concat(args.extension) : [],
  });
  const live = supervisor.started ? await waitForSupervisor(root) : { pid: supervisor.pid };
  if (!live) {
    throw new Error(`supervisor did not answer on ${controlSocketPath(root)}; see ${svrLogPath(root)}`);
  }
  // "(started)" is a claim about this command, so it holds only when the
  // supervisor that answers is the one this command started. A process spawned
  // over a live channel is refused by the incumbent, and the pid that answers
  // names the supervisor that was already there.
  const answeredBy = live.pid ?? supervisor.pid;
  const startedHere = supervisor.started && answeredBy === supervisor.pid;
  console.log(
    `supervisor ${answeredBy}${startedHere ? " (started)" : " (already running)"} root ${resolveFleetRoot(root)}`,
  );
  // An idle exit belongs to the process that was started with it. Saying that
  // when this command did not start one is the difference between a flag that
  // was applied and a flag that was dropped quietly.
  if (args["idle-exit-ms"] != null && !startedHere) {
    console.log(
      `note: --idle-exit-ms ${idleExitMs} was not applied: supervisor ${answeredBy} was already running and keeps its own idle exit`,
    );
  }
}

async function cmdStatus(args) {
  const root = args.root ?? defaultRoot();
  const live = await controlRequest(root, { op: "status" }, { timeoutMs: 1500 });
  let status = live?.ok ? live.data : null;
  let supervisor = "up";
  if (!status) {
    supervisor = "down";
    const journal = openJournal(root, {});
    try {
      status = buildStatus(journal);
    } finally {
      journal.close();
    }
  }
  if (args.json) {
    console.log(JSON.stringify(status, null, 2));
    return;
  }
  printStatus(status, { supervisor });
}

function printStatus(status, { supervisor }) {
  const resident = status.resident ?? { pids: [], totalMb: 0 };
  console.log(`fleet store ${status.store}`);
  console.log(
    `schema ${status.schemaVersion}  supervisor ${supervisor}  epoch ${status.epoch ?? "-"}  cap ${status.cap ?? "-"}  active ${status.active.length}`,
  );
  console.log(
    `resident ${resident.totalMb} MB over ${resident.pids.length} pids ${resident.pids.map((row) => `${row.pid}:${row.mb}`).join(" ") || "-"}`,
  );
  console.log(`nodes ${status.nodes.length}:`);
  for (const node of status.nodes) {
    const effects = node.lastTurn ? JSON.stringify(node.lastTurn.effects) : "{}";
    const undeliverable = node.undeliverable > 0 ? ` undeliverable ${node.undeliverable}` : "";
    console.log(
      `  ${node.nodeId.padEnd(22)} ${node.state.padEnd(17)} turns ${String(node.turns).padStart(3)} attempts ${node.attempts}  session ${node.sessionId ?? "-"}`,
    );
    console.log(
      `    last turn ${node.lastTurn ? `${node.lastTurn.turnId} ${node.lastTurn.kind} ${node.lastTurn.state}` : "-"} effects ${effects} pending ${node.pending}${undeliverable} lease ${node.lease ?? "-"}`,
    );
    if (node.openAsks.length > 0) console.log(`    asks ${node.openAsks.join(", ")}`);
    if (node.doneReason) console.log(`    note ${node.doneReason}`);
  }
  if (status.asks.length > 0) {
    console.log("open asks:");
    for (const ask of status.asks) {
      console.log(
        `  ${ask.token}  node ${ask.nodeId}  priority ${ask.priority ?? 0}  deadline ${new Date(ask.deadlineAt).toISOString()}  ${ask.question}`,
      );
      console.log(`    default ${ask.defaultAnswer ?? "-"}`);
    }
  }
  if (status.fences?.length > 0) {
    console.log("fences:");
    for (const fence of status.fences) {
      console.log(`  turn ${fence.turnId} node ${fence.nodeId} pgid ${fence.pgid ?? "-"} killed ${fence.killed} (${fence.reason})`);
    }
  }
}

async function cmdInject(args) {
  const [nodeId, ...rest] = args._;
  const text = rest.join(" ").trim();
  if (!nodeId || !text) throw new Error("usage: fleet inject <node> <text> [--token <ask-token>]");
  const root = args.root ?? defaultRoot();
  const reply = await controlRequest(root, {
    op: "inject",
    node: nodeId,
    text,
    token: args.token,
    msgId: args["msg-id"],
  });
  if (reply?.ok) {
    const data = reply.data;
    // "Delivered" is a claim, and only a delivery event earns it. A steer's ack
    // is pi saying it queued the text, so the row is still `recorded` when this
    // prints: it must not read as though a model saw it.
    if (data.steered) {
      console.log(
        `steered ${data.msgId} into ${nodeId} turn ${data.turnId} (the child queued it${data.disposition ? `, disposition ${data.disposition}` : ""})`,
      );
      console.log("  delivery is recorded when that turn runs the text; if it ends first, the next turn carries it");
    } else {
      console.log(`queued ${data.msgId} for ${nodeId} tier ${data.tier} (the next turn for this node carries it)`);
    }
    if (data.reason) console.log(`note: ${data.reason}`);
    return;
  }
  if (reply && !reply.ok) throw new Error(reply.error);
  // No supervisor listening: record the message so the next drive carries it.
  const journal = openJournal(root, {});
  try {
    const node = journal.getNode(nodeId);
    if (!node) throw new Error(`no such node: ${nodeId}`);
    // The journal alone can decide this half: a done node is never driven again.
    // The attempt bound is the running supervisor's policy and is not visible
    // here, so a failed node is queued and the supervisor's sweep stamps it
    // `undeliverable` if the bound is what keeps it from running.
    const retired = undeliverableReason(node);
    if (retired) throw new Error(`cannot queue a message for ${nodeId}: ${retired}; no turn will ever carry it`);
    let kind = "user";
    if (args.token) {
      const ask = journal.getAsk(args.token);
      if (!ask || ask.state !== "open") throw new Error(`no open ask: ${args.token}`);
      journal.resolveAsk(args.token, { answerText: text, answerSource: "fleet-inject" });
      if (journal.getNode(nodeId).state === "waiting_on_human") journal.setNodeState(nodeId, "settled");
      kind = "answer";
    }
    const message = journal.addMessage({
      msgId: args["msg-id"] ?? `m-${randomBytes(6).toString("hex")}`,
      nodeId,
      kind,
      body: text,
      token: args.token,
    });
    console.log(`recorded ${message.msg_id} for ${nodeId} tier C (no supervisor running; the next turn this node is driven for carries it)`);
  } finally {
    journal.close();
  }
}

async function cmdAsk(args) {
  const [nodeId, ...rest] = args._;
  const question = rest.join(" ").trim();
  if (!nodeId || !question) throw new Error("usage: fleet ask <node> <question> [--default <answer>] [--ttl-seconds N]");
  const root = args.root ?? defaultRoot();
  const journal = openJournal(root, {});
  try {
    const node = journal.getNode(nodeId);
    if (!node) throw new Error(`no such node: ${nodeId}`);
    if (node.state === "done") throw new Error(`node is done: ${nodeId}`);
    const ttlMs = (args["ttl-seconds"] ? Number(args["ttl-seconds"]) : 600) * 1000;
    const token = `ask-${randomBytes(6).toString("hex")}`;
    const ask = journal.recordAsk({
      token,
      nodeId,
      priority: args.priority ? Number(args.priority) : 0,
      question,
      defaultAnswer: args.default ?? DEFAULT_ANSWER,
      deadlineAt: Date.now() + ttlMs,
    });
    journal.setNodeState(nodeId, "waiting_on_human");
    console.log(`ask ${ask.token} for ${nodeId}`);
    console.log(`  priority: ${ask.priority}`);
    console.log(`  question: ${ask.question}`);
    console.log(`  default:  ${ask.default_answer}`);
    console.log(`  deadline: ${new Date(ask.deadline_at).toISOString()}`);
    console.log(`  answer:   fleet inject ${nodeId} "<answer>" --token ${ask.token}`);
  } finally {
    journal.close();
  }
}

// ── argv ────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      args._.push(token);
      continue;
    }
    const [key, inline] = token.slice(2).split("=");
    if (inline != null) {
      args[key] = inline;
      continue;
    }
    const next = argv[i + 1];
    if (next == null || next.startsWith("--")) {
      args[key] = true;
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

const USAGE = `fleet commands:
  spawn <parent|-> <charter> [--cap N] [--model p/m] [--token-cap N] [--idle-exit-ms N]
  status [--json]
  inject <node> <text> [--token <ask-token>]
  ask <node> <question> [--default <answer>] [--priority N] [--ttl-seconds N]
common: --root <fleet-root> (default $PI_FLEET_ROOT or <cwd>/.fleet)

spawn's --cap, --model, --pi-bin, --extension, --supervisor-driver and
--idle-exit-ms configure the supervisor this command starts; a supervisor that
is already running keeps the flags it was started with, and spawn says so.`;

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  const args = parseArgs(rest);
  switch (command) {
    case "spawn":
      return cmdSpawn(args);
    case "status":
      return cmdStatus(args);
    case "inject":
      return cmdInject(args);
    case "ask":
      return cmdAsk(args);
    default:
      console.error(USAGE);
      process.exitCode = 2;
      return undefined;
  }
}

/**
 * Is this module the process's entry point?
 *
 * npm installs the `bin` entry as a symlink into `node_modules/.bin`, and the
 * kernel does not rewrite argv: `process.argv[1]` stays the symlink while
 * `import.meta.url` names the file it points at. Comparing the two as spelled
 * makes the installed command load this module, match nothing, and exit 0 with
 * no output at all, so the comparison is on real paths.
 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  const self = fileURLToPath(import.meta.url);
  try {
    return realpathSync(entry) === realpathSync(self);
  } catch {
    // A path that cannot be resolved cannot be another spelling of this file.
    return resolve(entry) === self;
  }
}

if (isEntryPoint()) {
  main().catch((error) => {
    console.error(`fleet: ${error.message}`);
    process.exitCode = 1;
  });
}
