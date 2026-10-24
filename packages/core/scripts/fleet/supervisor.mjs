/**
 * The fleet supervisor: one process, no model, holding a cap of node sessions.
 *
 * Its whole job is to keep one statement true across a crash: no completed
 * effect is repeated and no node is silently lost. Everything else here is
 * scheduling taste.
 *
 * How that statement stays true:
 *
 *   - A turn's prompt is journalled before the child is spawned
 *     (`turns.prompt_text`), and the child's process group is journalled with
 *     it. A restart therefore knows what was sent and what to fence.
 *   - Effects are journalled from the driver's own tool events: the attempt
 *     before the tool runs, the result after it. An attempt without a result
 *     is the crash residue, and reconciliation turns it into `unknown` rather
 *     than into a repeat.
 *   - A node resumes by reopening its recorded session id. Its recovery turn
 *     carries the journal's account of the interrupted turn: which effects
 *     completed, which are unknown. The supervisor never re-sends a prompt it
 *     already recorded as sent - that single rule is the difference between
 *     resuming and restarting.
 *   - The supervisor's epoch is journalled. A restart fences the process
 *     groups of every turn its predecessor left open, so a stale drive cannot
 *     keep writing while the new one resumes the same session.
 *
 * The naive replay path (`naive: true`) exists to be wrong on purpose: it is
 * the arm the crash drill measures duplication with.
 */

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { openJournal, replayPolicy, resolveFleetRoot, SCHEMA_VERSION } from "./journal.mjs";
import { createRpcDriver, GUARD_EXTENSION, guardEnvironment } from "./driver-rpc.mjs";
import { createScriptedDriver, ASK_SENTINEL, DONE_SENTINEL } from "./driver-scripted.mjs";
import { groupIsAlive, pidIsAlive, residentMb } from "./procs.mjs";

export { ASK_SENTINEL, DONE_SENTINEL };

export const NODE_STATES = ["settled", "waiting_on_child", "waiting_on_human", "failed", "done"];

export const DEFAULT_ANSWER = "No decision arrived before the deadline. Continue with the charter's stated default.";

/**
 * Where the control socket lives.
 *
 * A unix socket path is capped (104 bytes on macOS, 108 on Linux), and a fleet
 * root can be deeper than that - a nested project, a scratch tree, a CI
 * workspace. The socket therefore falls back to a short hashed name in the
 * system temp directory, and both the supervisor and the commands derive the
 * same path from the root, so the channel does not depend on where the store
 * happens to sit. The chosen path is journalled as `control_socket`.
 */
export function controlSocketPath(root) {
  const absolute = resolveFleetRoot(root);
  const local = join(absolute, "control.sock");
  if (Buffer.byteLength(local) <= 100) return local;
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  return join(tmpdir(), `pi-fleet-${hash}.sock`);
}

/**
 * How long the arrival probe waits for an answer before it treats the path as a
 * departed binder's leavings. A supervisor answers a ping in microseconds; the
 * wait is long enough that a busy tick is not mistaken for a dead channel.
 */
const CONTROL_PROBE_MS = 1_000;

/**
 * The identity of whatever file sits at `path`: a unix socket's device and
 * inode are stable for the life of the file, and a rebind at the same path
 * creates a different inode. Used to answer "is the path still the one this
 * process bound?" from the filesystem rather than from memory of a name.
 *
 * Returns null when nothing is there, and throws when the question cannot be
 * answered at all: a caller that cannot tell must not delete.
 */
function fileIdentity(path) {
  try {
    const stat = statSync(path);
    return { dev: stat.dev, ino: stat.ino };
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

/**
 * One request, one response line, over a unix socket path. Resolves `null` when
 * the path does not answer within the timeout: absent, refused, or silent. The
 * wire format lives with the server it speaks to, so the supervisor's own
 * arrival probe and the commands share one implementation.
 */
export function requestOnControlSocket(path, request, { timeoutMs = 10_000 } = {}) {
  return new Promise((resolveReply) => {
    const socket = connect(path);
    let buffer = "";
    const finish = (reply) => {
      socket.destroy();
      resolveReply(reply);
    };
    socket.setTimeout(timeoutMs, () => finish(null));
    socket.on("connect", () => socket.write(JSON.stringify(request) + "\n"));
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const index = buffer.indexOf("\n");
      if (index < 0) return;
      try {
        finish(JSON.parse(buffer.slice(0, index)));
      } catch {
        finish(null);
      }
    });
    socket.on("error", () => finish(null));
  });
}

export const CHILD_FLAGS = [
  "--mode",
  "rpc",
  "--no-mcp",
  "--no-context-files",
  "--no-extensions",
  "--no-skills",
  "--no-prompt-templates",
  "--thinking",
  "off",
];

/** The fleet preamble a node's first turn carries, before its charter body. */
export function charterPrompt(node, body) {
  return [
    `You are node ${node.node_id} of a fleet. Your charter follows.`,
    `Work the charter with your tools. One tool call per step, in order.`,
    `When the charter's steps are complete, end your turn with the single line ${DONE_SENTINEL}.`,
    `If you cannot continue without a decision from a human, end your turn with one line:`,
    `${ASK_SENTINEL} <question> | default: <the answer to use if nobody replies> | priority: <number, 0 when unsure>`,
    "",
    "CHARTER:",
    body.trim(),
  ].join("\n");
}

/**
 * The recovery prompt is built from the journal, not from the charter. A node
 * that sees its own completed effects listed cannot be told to start over.
 *
 * `note` is the journal account, and it can be suppressed: the note-removal arm
 * measures what the resumed turn does when the prompt is silent about the
 * effects already applied. Nothing but that arm sets it to false.
 */
export function recoveryPrompt({ node, interruptedTurn, completed, unknown, pending, note = true }) {
  const lines = [
    `FLEET RESUME. Node ${node.node_id} keeps the same session. Turn ${interruptedTurn.turn_id} was interrupted while it was running.`,
  ];
  if (note && completed.length > 0) {
    lines.push("", "Effects already applied and recorded (do NOT repeat them):");
    for (const effect of completed) {
      lines.push(`- seq ${effect.seq} ${effect.tool_name} completed (idempotency ${effect.idempotency_key})`);
    }
  }
  if (note && unknown.length > 0) {
    lines.push("", "Effects whose outcome is unknown (the tool started and never reported):");
    for (const effect of unknown) {
      lines.push(`- seq ${effect.seq} ${effect.tool_name} unknown (idempotency ${effect.idempotency_key})`);
    }
    lines.push("Check the world before acting on these; never repeat a completed effect.");
  }
  if (note && completed.length === 0 && unknown.length === 0) {
    lines.push("", "No effect had been recorded when the turn was interrupted.");
  }
  if (pending.length > 0) {
    lines.push("", "Messages waiting for you:");
    for (const message of pending) lines.push(`- ${message.body}`);
  }
  lines.push("", "Continue the charter from its first unfinished step.");
  return lines.join("\n");
}

export function parseAsk(text) {
  const line = String(text ?? "")
    .split("\n")
    .find((candidate) => candidate.includes(ASK_SENTINEL));
  if (!line) return null;
  const rest = line.slice(line.indexOf(ASK_SENTINEL) + ASK_SENTINEL.length).trim();
  const [question, ...tail] = rest.split("|");
  let defaultAnswer = "";
  let priority = 0;
  for (const field of tail) {
    const [rawKey, ...rawValue] = field.split(":");
    const key = rawKey.trim().toLowerCase();
    const value = rawValue.join(":").trim();
    if (key === "default") defaultAnswer = value;
    if (key === "priority") priority = Number(value) || 0;
  }
  return { question: question.trim(), defaultAnswer: defaultAnswer || DEFAULT_ANSWER, priority };
}

export function isDone(text) {
  return String(text ?? "").includes(DONE_SENTINEL);
}

/** Text content of an assistant message, with thinking blocks dropped. */
export function assistantText(message) {
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

export class Supervisor {
  constructor(options) {
    const defaults = {
      cap: 3,
      tickMs: 250,
      leaseTtlMs: 30_000,
      askTtlMs: 600_000,
      turnTimeoutMs: 300_000,
      maxAttempts: 3,
      idleExitMs: 5_000,
      driver: "rpc",
      model: "opencode-go/deepseek-v4.1-flash",
      piBin: "pi",
      naive: false,
      control: true,
      extensions: [],
      extraArgs: [],
    };
    // An explicit `undefined` option means "not given", never "override with
    // nothing": the command line produces undefined for every flag it omits.
    this.options = { ...defaults };
    for (const [key, value] of Object.entries(options ?? {})) {
      if (value !== undefined) this.options[key] = value;
    }
    this.journal = openJournal(this.options.root, {
      projectRoot: this.options.projectRoot ?? this.options.root,
      driver: this.options.driver,
      childArgs: this.options.extraArgs ?? [],
      piVersion: this.options.piVersion ?? "unset",
    });
    this.root = this.journal.root;
    this.epoch = null;
    this.active = new Map();
    this.timer = null;
    this.server = null;
    // The file this process bound, as the filesystem names it. A name is not an
    // identity: another process can rebind the same path, so the stop below
    // compares this against the path rather than trusting the name.
    this.boundSocket = null;
    this.stopping = false;
    this.fences = [];
    this.idleSince = null;
    // Resolved when this process has stopped itself because the fleet had
    // nothing left to do; the entry point exits on it rather than on a guess.
    this.done = new Promise((resolveDone) => {
      this.doneResolve = resolveDone;
    });
    this.log = this.options.log ?? ((line) => console.log(line));
  }

  async start() {
    // The journal records the driver and the version it ran under, so the
    // choice between an RPC child and an in-process SDK stays reversible.
    if (!this.options.piVersion && this.options.driver !== "scripted") {
      try {
        this.options.piVersion = execFileSync(this.options.piBin, ["--version"], { encoding: "utf8" }).trim();
      } catch (error) {
        this.options.piVersion = `unavailable: ${error.code ?? error.message}`;
      }
      this.journal.setMeta("pi_version", this.options.piVersion);
    }
    this.epoch = this.journal.registerSupervisor({
      pid: process.pid,
      driver: this.options.driver,
      childArgs: this.options.extraArgs ?? [],
      piVersion: this.options.piVersion,
    });
    this.log(`fleet: supervisor pid ${process.pid} epoch ${this.epoch} store ${this.journal.path}`);
    await this.reconcile();
    if (this.options.control) await this._listen();
    this._schedule();
    return this;
  }

  // ── reconciliation ───────────────────────────────────────────────────────

  /**
   * Repair what a dead predecessor left: dead epoch rows, expired leases, and
   * every turn still marked in-progress. The turn's process group is fenced
   * before its effects are read, so the next drive cannot race a writer that
   * is still alive.
   *
   * A lease and a turn left behind by the same owner are the same owner's, so
   * both loops ask `ownerLiveness` whether that owner is still there. Fencing a
   * live owner's turn kills a child that is still working and records a
   * recovery that never happened.
   */
  async reconcile() {
    const supervisors = this.journal.supervisors();
    for (const supervisor of supervisors) {
      if (supervisor.pid === process.pid) continue;
      if (supervisor.state === "live" && !pidIsAlive(supervisor.pid)) {
        this.journal.setSupervisorState(supervisor.pid, "dead");
      }
    }
    const owners = this.ownerLiveness();
    for (const lease of this.journal.liveLeases()) {
      if (lease.epoch === this.epoch) continue;
      if (owners.get(lease.epoch)) continue;
      this.journal.expireLease(lease.lease_id);
    }
    let skippedTurns = 0;
    const openTurns = this.journal.allOpenTurns();
    for (const turn of openTurns) {
      if (turn.supervisor_epoch === this.epoch) continue;
      if (owners.get(turn.supervisor_epoch)) {
        skippedTurns += 1;
        continue;
      }
      const fence = await this.fenceGroup(turn);
      const unknown = this.journal.markUnknownEffects(turn.turn_id);
      this.journal.endTurn(turn.turn_id, { state: "interrupted" });
      this.journal.bumpAttempt(turn.node_id);
      const node = this.journal.getNode(turn.node_id);
      if (node && node.state !== "done") {
        // The bound closes the crash loop: without it a node that kills its
        // supervisor every time is interrupted, settled, resumed, and
        // interrupted again, for ever.
        if (node.attempts >= this.options.maxAttempts) {
          this.journal.setNodeState(turn.node_id, "failed", {
            done_reason: `attempt bound: ${node.attempts} failed or interrupted attempts reached maxAttempts ${this.options.maxAttempts}`,
          });
          this.log(
            `fleet: node ${turn.node_id} reached the attempt bound (${node.attempts}/${this.options.maxAttempts}); not resuming it`,
          );
        } else {
          this.journal.setNodeState(turn.node_id, "settled");
        }
      }
      this.journal.setMeta("fences", JSON.stringify(this.fences));
      this.log(
        `fleet: reconciled turn ${turn.turn_id} (node ${turn.node_id}) fence=${fence.killed ? "killed" : fence.reason} unknown_effects=${unknown.length}`,
      );
    }
    this.journal.setMeta("reconcile_skipped_turns", String(skippedTurns));
    this.drainExpiredAsks();
  }

  /**
   * Which supervisor epochs are still alive, by the one predicate both repair
   * loops need: a row that says `live` whose pid answers. The repair pass above
   * has already demoted a live row whose pid is gone, so a `live` row here is a
   * process the box still holds.
   */
  ownerLiveness() {
    const owners = new Map();
    for (const row of this.journal.supervisors()) {
      owners.set(row.epoch, row.state === "live" && pidIsAlive(row.pid));
    }
    return owners;
  }

  // ── the ask deadline ─────────────────────────────────────────────────────

  /**
   * The one drain of expired asks. Resolving an ask to its default is only half
   * the job: nothing tells the node to move unless the default is also queued
   * as an ordinary message. Both callers - the tick, and the restart that finds
   * a deadline passed while no supervisor was running - come through here, so
   * the two paths cannot drift into one of them doing half the work.
   *
   * Only what `expireAsks()` claimed is queued. It returns the rows this call
   * actually transitioned, not the rows it read, so a second drainer of the same
   * ask claims nothing and queues nothing: the queue decision rests on the
   * conditional update, not on a shared read.
   */
  drainExpiredAsks() {
    // Claim and queue as one transaction. A supervisor killed between the two
    // leaves an ask answered with no message queued for it, and a node parked
    // on that ask then has no open ask, no pending message and no ready kind,
    // so nothing ever drives it again: the parked-forever shape this drain
    // exists to prevent, reached through the drain itself. BEGIN IMMEDIATE also
    // serializes two drainers, so the read that decides a claim cannot land
    // inside the other process's claims.
    return this.journal.transaction(() => {
      const expired = this.journal.expireAsks();
      for (const ask of expired) {
        // The ask is claimed and answered by now; what is left is whether the
        // node should be woken. A done node must not be resurrected: the fence
        // loop guards this, and the drain queued for it anyway, so an overdue
        // ask on a finished node flipped it back to `settled` and the default
        // then drove it a second time.
        const node = this.journal.getNode(ask.node_id);
        if (!node || node.state === "done") {
          this.log(
            `fleet: ask ${ask.token} expired for node ${ask.node_id}, which is ${node ? "done" : "missing"}; default not queued`,
          );
          continue;
        }
        this.journal.addMessage({
          msgId: `m-${randomBytes(6).toString("hex")}`,
          nodeId: ask.node_id,
          kind: "answer",
          body: ask.default_answer,
          token: ask.token,
        });
        this.journal.setNodeState(ask.node_id, "settled");
        this.log(`fleet: ask ${ask.token} hit its deadline; default answer queued`);
      }
      return expired;
    });
  }

  /**
   * Kill the process group a dead turn left behind, and wait until the group is
   * gone before reading its effects. A signal that was sent is not a fence that
   * held, so the record carries what was observed after the wait.
   */
  async fenceGroup(turn) {
    const pgid = turn.child_pgid;
    const record = {
      turnId: turn.turn_id,
      nodeId: turn.node_id,
      pgid,
      killed: false,
      reason: "",
      at: Date.now(),
      waitedMs: 0,
    };
    if (!pgid) {
      record.reason = "no child recorded";
    } else if (!groupIsAlive(pgid)) {
      record.reason = "group already gone";
    } else {
      try {
        process.kill(-pgid, "SIGKILL");
        record.killed = true;
        record.reason = "SIGKILL to process group";
      } catch (error) {
        record.reason = `kill failed: ${error.code ?? error.message}`;
      }
      const started = Date.now();
      while (groupIsAlive(pgid) && Date.now() - started < 500) {
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      record.waitedMs = Date.now() - started;
    }
    record.aliveAfter = groupIsAlive(pgid);
    this.fences.push(record);
    return record;
  }

  // ── scheduling ───────────────────────────────────────────────────────────

  _schedule() {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.tick()
        .catch((error) => this.log(`fleet: tick failed: ${error.message}`))
        .finally(() => this._schedule());
    }, this.options.tickMs);
  }

  async tick() {
    this.journal.heartbeatSupervisor(process.pid);
    for (const [nodeId, ctx] of this.active) {
      const renewed = this.journal.acquireLease({
        nodeId,
        ownerPid: process.pid,
        epoch: this.epoch,
        ttlMs: this.options.leaseTtlMs,
      });
      if (!renewed) this.log(`fleet: lease for ${nodeId} could not be renewed (ctx ${ctx.turnId})`);
    }
    this.drainExpiredAsks();
    if (this.active.size < this.options.cap) {
      for (const node of this.journal.listNodes()) {
        if (this.stopping || this.active.size >= this.options.cap) break;
        if (this.active.has(node.node_id)) continue;
        const kind = this.readyKind(node);
        if (!kind) continue;
        this.driveNode(node, kind).catch((error) => {
          this.log(`fleet: drive ${node.node_id} threw: ${error.message}`);
        });
      }
    }
    await this.idleCheck();
  }

  // ── stopping when there is nothing to do ────────────────────────────────

  /**
   * Whether the fleet has anything left to do. Three things are work at any
   * capacity: a turn this process is running, an open ask (a cap-0 supervisor
   * still drains an expired one, because the drain runs before the cap gate),
   * and a lease this epoch has not let go of.
   *
   * A runnable node is work only when this process could drive it. At cap 0 the
   * drive loop never runs, so a node the scheduler would name is a node this
   * supervisor is structurally unable to start; counting it as work is how a
   * cap-0 supervisor outlives its usefulness holding a journal full of nodes it
   * will never drive.
   */
  hasWork() {
    if (this.active.size > 0) return true;
    if (this.journal.openAsks().length > 0) return true;
    if (this.journal.liveLeases().some((lease) => lease.epoch === this.epoch)) return true;
    if (this.options.cap <= 0) return false;
    return this.journal.listNodes().some((node) => this.readyKind(node) !== null);
  }

  /**
   * The idle exit: nothing to do for a sustained window means stop and let the
   * process end. A single empty sample is not that window - a node is
   * registered before the supervisor that drives it is started, so a fresh
   * supervisor's first tick legitimately finds nothing ready - so the window is
   * re-sampled on every tick and any work resets it. `idleExitMs: 0` disables
   * the exit for a supervisor meant to wait.
   */
  async idleCheck() {
    const windowMs = this.options.idleExitMs;
    if (!windowMs || this.stopping) return;
    if (this.hasWork()) {
      this.idleSince = null;
      return;
    }
    if (this.idleSince == null) {
      this.idleSince = Date.now();
      return;
    }
    const idleMs = Date.now() - this.idleSince;
    if (idleMs < windowMs) return;
    // One last look in the same synchronous stretch as the stop, so a node that
    // arrived while the window elapsed is not exited from.
    if (this.hasWork()) {
      this.idleSince = null;
      return;
    }
    this.log(`fleet: no work left for ${idleMs} ms; stopping`);
    try {
      await this.stop();
    } catch (error) {
      this.log(`fleet: stop during the idle exit failed: ${error.message}`);
      this.doneResolve(false);
    }
  }

  /**
   * Why a node is ready to be driven right now, or null. The five states are
   * the design's; `waiting_on_child` is repaired here rather than trusted,
   * because a killed supervisor leaves it behind.
   *
   * Order matters: an interrupted turn outranks a queued message, because the
   * recovery prompt carries the queued messages with it; a node that has never
   * been driven takes its charter before anything else.
   */
  readyKind(node) {
    if (node.state === "done") return null;
    if (this.journal.openAsks(node.node_id).length > 0) return null;
    if (node.state === "failed" && node.attempts >= this.options.maxAttempts) return null;
    const turns = this.journal.turnsFor(node.node_id);
    const last = turns.at(-1) ?? null;
    if (last && last.state === "in_progress") return null;
    if (turns.length === 0) return "charter";
    if (last && last.state === "interrupted") return this.options.naive ? "naive" : "recovery";
    if (this.journal.pendingMessages(node.node_id).length > 0) return "message";
    return null;
  }

  // ── driving one node ─────────────────────────────────────────────────────

  createDriver(node, turnId) {
    const config = JSON.parse(node.driver_config || "{}");
    const sessionId = node.session_id ?? `fleet-${node.node_id}-${randomBytes(3).toString("hex")}`;
    if (node.driver === "scripted") {
      return createScriptedDriver({
        steps: config.steps ?? [],
        worldFile: config.worldFile ?? join(this.root, "world.log"),
        sessionId,
        sessionFile: node.session_file ?? join(this.root, "sessions", `${sessionId}.jsonl`),
      });
    }
    return createRpcDriver({
      piBin: this.options.piBin,
      cwd: node.project_root,
      sessionId,
      sessionDir: join(this.root, "sessions"),
      model: this.options.model,
      extensions: this.options.extensions,
      guardExtension: GUARD_EXTENSION,
      env: guardEnvironment({ root: this.root, nodeId: node.node_id, turnId }),
      extraArgs: this.options.extraArgs,
      fullDiscovery: this.options.fullDiscovery,
      thinking: this.options.thinking,
    });
  }

  async driveNode(node, kind) {
    const lease = this.journal.acquireLease({
      nodeId: node.node_id,
      ownerPid: process.pid,
      epoch: this.epoch,
      ttlMs: this.options.leaseTtlMs,
    });
    if (!lease) return;
    const ctx = {
      nodeId: node.node_id,
      turnId: null,
      driver: null,
      kind,
      toolEnds: 0,
      requestSeq: 0,
      effectSeq: 0,
      usage: { input: 0, output: 0 },
      settled: false,
      settleResolve: null,
      finalText: "",
      lastAssistantText: "",
      error: null,
      startedAt: Date.now(),
    };
    ctx.settlePromise = new Promise((resolveSettle) => {
      ctx.settleResolve = resolveSettle;
    });
    this.active.set(node.node_id, ctx);
    try {
      const refusal = this.journal.budgetRefusal(node.project_root, node.node_id);
      if (refusal) {
        this.journal.setNodeState(node.node_id, "failed", { done_reason: `budget: ${refusal}` });
        return;
      }
      const pending = this.journal.pendingMessages(node.node_id);
      const turns = this.journal.turnsFor(node.node_id);
      const interrupted = turns.at(-1)?.state === "interrupted" ? turns.at(-1) : null;
      let prompt;
      let promptKind = kind;
      if (kind === "recovery" && interrupted) {
        prompt = recoveryPrompt({
          node,
          interruptedTurn: interrupted,
          completed: this.journal.settledEffects(interrupted.turn_id),
          unknown: this.journal
            .effects(interrupted.turn_id)
            .filter((effect) => effect.state === "unknown" || effect.state === "attempted"),
          pending,
          // In-process only, and no command-line flag maps to it: the
          // note-removal arm is the single caller that turns the note off.
          note: this.options.recoveryNote !== false,
        });
      } else if (kind === "message") {
        prompt = ["FLEET MESSAGE.", ...pending.map((message) => `- ${message.body}`), "", "Act on it, then end your turn."].join(
          "\n",
        );
      } else {
        prompt = charterPrompt(node, this._charter(node));
        if (kind === "naive") promptKind = "naive-replay";
      }
      this.journal.setNodeState(node.node_id, "waiting_on_child");
      const turnId = this.journal.beginTurn(node.node_id, {
        kind: promptKind,
        promptText: prompt,
        sessionId: node.session_id,
        supervisorEpoch: this.epoch,
      });
      ctx.turnId = turnId;
      for (const message of pending) {
        this.journal.markMessageDelivered(message.msg_id, {
          tier: "B",
          turnId,
          afterEffectSeq: 0,
          beforeRequestSeq: 0,
        });
      }
      const driver = this.createDriver(node, turnId);
      ctx.driver = driver;
      driver.onEvent((event) => this._onDriverEvent(ctx, event));
      const { sessionId, sessionFile } = await driver.start();
      ctx.sessionId = sessionId;
      this.journal.setNodeSession(node.node_id, { sessionId, sessionFile });
      if (driver.pid) this.journal.setTurnChild(turnId, { pid: driver.pid, pgid: driver.pgid });
      await driver.prompt(prompt);
      await this._waitForSettle(ctx);
      await this._settleTurn(node, ctx);
    } catch (error) {
      ctx.error = error.message;
      if (ctx.turnId) {
        this.journal.markUnknownEffects(ctx.turnId);
        this.journal.endTurn(ctx.turnId, { state: "failed", ...this._usage(ctx) });
        this.journal.bumpAttempt(node.node_id);
      }
      this.journal.setNodeState(node.node_id, "failed", { done_reason: `turn failed: ${error.message}` });
      this.log(`fleet: node ${node.node_id} turn failed: ${error.message}`);
    } finally {
      if (ctx.driver) await ctx.driver.stop().catch(() => {});
      this.journal.releaseLease(node.node_id, this.epoch);
      this.active.delete(node.node_id);
    }
  }

  _charter(node) {
    try {
      return readFileSync(node.charter_path, "utf8");
    } catch (error) {
      return `(charter unreadable at ${node.charter_path}: ${error.code ?? error.message})`;
    }
  }

  _usage(ctx) {
    return {
      tokensIn: ctx.usage.input,
      tokensOut: ctx.usage.output,
      spendUsd: 0,
    };
  }

  _onDriverEvent(ctx, event) {
    if (!ctx.turnId) return;
    switch (event.type) {
      case "tool_start":
        ctx.effectSeq += 1;
        this.journal.effectAttempted({
          turnId: ctx.turnId,
          nodeId: ctx.nodeId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          args: event.args,
          replay: replayPolicy(event.toolName),
          seq: ctx.effectSeq,
        });
        break;
      case "tool_end":
        ctx.toolEnds += 1;
        this.journal.effectSettled({
          turnId: ctx.turnId,
          toolCallId: event.toolCallId,
          result: event.result,
          isError: event.isError,
        });
        break;
      case "model_request":
        ctx.requestSeq = this.journal.recordModelRequest(ctx.turnId, {
          messageCount: event.messageCount,
          toolCount: event.toolCount,
        });
        break;
      case "message_end":
        if (event.role === "assistant") {
          ctx.lastAssistantText = assistantText(event.message);
          const usage = event.message?.usage;
          if (usage) {
            ctx.usage.input += Number(usage.input ?? 0);
            ctx.usage.output += Number(usage.output ?? 0);
          }
        }
        break;
      case "final_text":
        ctx.finalText = event.text;
        ctx.settled = true;
        ctx.settleResolve?.();
        break;
      case "steer_delivered":
        for (const message of this.journal.pendingMessages(ctx.nodeId)) {
          this.journal.markMessageDelivered(message.msg_id, {
            tier: "A",
            turnId: ctx.turnId,
            afterEffectSeq: event.afterEffectSeq,
            beforeRequestSeq: ctx.requestSeq,
          });
        }
        break;
      case "settled":
        ctx.finalText = ctx.finalText || ctx.lastAssistantText;
        ctx.settled = true;
        ctx.settleResolve?.();
        break;
      default:
        break;
    }
  }

  async _waitForSettle(ctx) {
    const deadline = Date.now() + this.options.turnTimeoutMs;
    while (!ctx.settled) {
      if (Date.now() > deadline) throw new Error(`turn exceeded ${this.options.turnTimeoutMs} ms`);
      if (ctx.driver?.exit) {
        const exited = await Promise.race([ctx.driver.exit.then(() => true), new Promise((resolveWait) => setTimeout(() => resolveWait(false), 50))]);
        if (exited && !ctx.settled) throw new Error("driver exited before settling");
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }
  }

  async _settleTurn(node, ctx) {
    const text = ctx.finalText || ctx.lastAssistantText;
    const ask = parseAsk(text);
    let turnState = "settled";
    let nodeState = "settled";
    let doneReason = null;
    if (ask) {
      const token = `ask-${randomBytes(6).toString("hex")}`;
      this.journal.recordAsk({
        token,
        nodeId: node.node_id,
        turnId: ctx.turnId,
        priority: ask.priority,
        question: ask.question,
        defaultAnswer: ask.defaultAnswer,
        deadlineAt: Date.now() + this.options.askTtlMs,
      });
      turnState = "parked";
      nodeState = "waiting_on_human";
      doneReason = `parked on ${token}`;
      this.log(`fleet: node ${node.node_id} parked on ${token}: ${ask.question}`);
    } else if (isDone(text)) {
      turnState = "done";
      nodeState = "done";
      doneReason = "charter reported done";
    }
    this.journal.endTurn(ctx.turnId, { state: turnState, ...this._usage(ctx), sessionId: ctx.sessionId });
    this.journal.addNodeUsage(node.node_id, {
      tokensIn: this._usage(ctx).tokensIn,
      tokensOut: this._usage(ctx).tokensOut,
      projectRoot: node.project_root,
    });
    this.journal.markMessagesConsumed(node.node_id);
    this.journal.setNodeState(node.node_id, nodeState, doneReason ? { done_reason: doneReason } : {});
    this.log(
      `fleet: node ${node.node_id} turn ${ctx.turnId} ${turnState} effects=${this.journal.effects(ctx.turnId).length} requests=${ctx.requestSeq}`,
    );
  }

  // ── control channel ──────────────────────────────────────────────────────

  socketPath() {
    return controlSocketPath(this.root);
  }

  /**
   * The live responder on `path`, or null when nothing answered: no file, no
   * listener behind the file, or a reply this process wrote itself.
   */
  async _responderOn(path) {
    if (!existsSync(path)) return null;
    const reply = await requestOnControlSocket(path, { op: "ping" }, { timeoutMs: CONTROL_PROBE_MS });
    const data = reply?.ok ? reply.data : null;
    if (!data || data.pid == null || data.pid === process.pid) return null;
    return data;
  }

  async _listen() {
    const path = this.socketPath();
    const incumbent = await this._responderOn(path);
    if (incumbent) {
      // A live responder with another pid is the owner of this root's channel.
      // Binding over it would leave a supervisor that runs and works while
      // nothing can reach it, and nothing would say so for the rest of its
      // life, so this process refuses instead of clobbering. The journal row
      // follows: `live` for a process that never served would be the same lie.
      this.journal.setSupervisorState(process.pid, "refused");
      throw new Error(
        `control channel ${path} is served by supervisor pid ${incumbent.pid} (epoch ${incumbent.epoch}); refusing to bind over it`,
      );
    }
    if (existsSync(path)) {
      // A socket file outlives the process that bound it, so a path nobody
      // answers is a departed binder's leavings. Reclaiming it is what lets the
      // channel come back after a crash; refusing to would leave a root that no
      // supervisor can ever serve again.
      this.log(`fleet: no answer on ${path}; reclaiming the path`);
      rmSync(path, { force: true });
    }
    this.server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf8");
        let index;
        while ((index = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + 1);
          if (!line.trim()) continue;
          this._handleControl(line)
            .then((reply) => socket.write(JSON.stringify(reply) + "\n"))
            .catch((error) => socket.write(JSON.stringify({ ok: false, error: error.message }) + "\n"));
        }
      });
      socket.on("error", () => socket.destroy());
    });
    await new Promise((resolveListen, rejectListen) => {
      this.server.once("error", rejectListen);
      this.server.listen(path, () => {
        this.server.removeListener("error", rejectListen);
        chmodSync(path, 0o600);
        resolveListen();
      });
    });
    const identity = fileIdentity(path);
    this.boundSocket = identity ? { path, dev: identity.dev, ino: identity.ino } : null;
    this.journal.setMeta("control_socket", path);
    return path;
  }

  async _handleControl(line) {
    const request = JSON.parse(line);
    switch (request.op) {
      case "ping":
        return { ok: true, data: { pid: process.pid, epoch: this.epoch, active: [...this.active.keys()] } };
      case "status":
        return { ok: true, data: buildStatus(this.journal, this) };
      case "inject": {
        const node = this.journal.getNode(request.node);
        if (!node) return { ok: false, error: `no such node: ${request.node}` };
        const msgId = request.msgId ?? `m-${randomBytes(6).toString("hex")}`;
        let kind = "user";
        if (request.token) {
          const ask = this.journal.getAsk(request.token);
          if (!ask || ask.state !== "open") return { ok: false, error: `no open ask: ${request.token}` };
          this.journal.resolveAsk(request.token, { answerText: request.text, answerSource: "fleet-inject" });
          kind = "answer";
          if (node.state === "waiting_on_human") this.journal.setNodeState(node.node_id, "settled");
        }
        const message = this.journal.addMessage({
          msgId,
          nodeId: node.node_id,
          kind,
          body: request.text,
          token: request.token,
        });
        const ctx = this.active.get(node.node_id);
        if (ctx?.driver && !ctx.settled && ctx.turnId) {
          try {
            const ack = await ctx.driver.steer(request.text);
            const queued = ack?.data?.disposition ?? ack?.disposition ?? "queued";
            this.journal.markMessageDelivered(msgId, {
              tier: "A",
              turnId: ctx.turnId,
              afterEffectSeq: ctx.toolEnds,
              beforeRequestSeq: ctx.requestSeq,
            });
            return { ok: true, data: { msgId, tier: "A", disposition: queued, turnId: ctx.turnId, effectSeq: ctx.toolEnds } };
          } catch (error) {
            this.log(`fleet: steer for ${node.node_id} refused: ${error.message}`);
            return { ok: true, data: { msgId, tier: "B", reason: `steer refused: ${error.message}`, message } };
          }
        }
        // Tier B is journalled and prepended to the next drive's prompt. It is
        // deliberately not pi's `nextTurn` delivery: that waits for the next
        // user prompt and can land after the topic has moved, which is drift.
        return { ok: true, data: { msgId, tier: "B", reason: "no turn in flight", message } };
      }
      case "stop":
        setTimeout(() => {
          this.stop().catch((error) => this.log(`fleet: stop failed: ${error.message}`));
        }, 10);
        return { ok: true, data: { stopping: true } };
      default:
        return { ok: false, error: `unknown op: ${request.op}` };
    }
  }

  /**
   * Whether the path still resolves to the file this process bound, and why
   * not when it does not. An unreadable path is not an ownership claim either:
   * a claim this process cannot check is a claim it does not have.
   */
  _socketPathState(path) {
    const mine = this.boundSocket;
    if (!mine || mine.path !== path || mine.ino == null) return { owned: false, why: "this process never bound it" };
    let current;
    try {
      current = fileIdentity(path);
    } catch (error) {
      return { owned: false, why: `it cannot be read (${error.code ?? error.message})` };
    }
    if (!current) return { owned: false, why: "the file is gone" };
    if (current.dev !== mine.dev || current.ino !== mine.ino) return { owned: false, why: "another process bound it" };
    return { owned: true, why: "this process bound it and nothing has replaced it" };
  }

  /**
   * Give up the control path, if it is still this process's to give up.
   *
   * Closing a unix-socket server removes the path it bound, whatever is there
   * now: `net.Server.close()` unlinks by name, so a server closed after another
   * process rebound the path deletes that process's socket and leaves a live
   * supervisor unreachable. The close is therefore the deletion that has to be
   * gated, not only the unlink after it. When the path is no longer this
   * process's, the listener is abandoned instead: it is unreachable either way,
   * and it keeps the event loop referenced, so the only way out of this process
   * is an explicit `process.exit()` - which does not run the close that would
   * delete the file that replaced ours.
   */
  async _releaseSocketPath() {
    const path = this.socketPath();
    const state = this._socketPathState(path);
    if (!state.owned) {
      this.log(`fleet: leaving control socket ${path} alone: ${state.why}`);
      return;
    }
    await new Promise((resolveClose) => this.server.close(resolveClose));
    this.server = null;
    // The close above removed the path on this platform; the unlink is for a
    // runtime whose close leaves it behind, and it is safe only because the
    // identity was confirmed first.
    rmSync(path, { force: true });
  }

  async stop() {
    if (this.stopping) return;
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.server) await this._releaseSocketPath();
    for (const [nodeId, ctx] of [...this.active]) {
      ctx.driver?.killGroup?.("SIGKILL");
      if (ctx.turnId) {
        this.journal.markUnknownEffects(ctx.turnId);
        this.journal.endTurn(ctx.turnId, { state: "interrupted", ...this._usage(ctx) });
      }
      this.journal.setNodeState(nodeId, "settled");
      this.journal.releaseLease(nodeId, this.epoch);
      this.active.delete(nodeId);
    }
    this.journal.setSupervisorState(process.pid, "stopped");
    this.journal.setMeta("fences", JSON.stringify(this.fences));
    this.journal.close();
    // Every stop ends the process the entry point is waiting on: the idle exit,
    // the control channel's `stop`, and a signal all leave the same way. Stop
    // is the exit, so nothing has to guess whether the process should still be
    // up.
    this.doneResolve(true);
  }
}

/**
 * One readable snapshot of the fleet, assembled from the journal plus `ps`.
 * Shared by `fleet status` and the control channel so both print the same
 * numbers instead of two nearly-equal views.
 */
export function buildStatus(journal, supervisor = null) {
  const nodes = journal.listNodes().map((node) => {
    const turns = journal.turnsFor(node.node_id);
    const last = turns.at(-1) ?? null;
    const effects = last ? journal.effects(last.turn_id) : [];
    const counts = effects.reduce((acc, effect) => {
      acc[effect.state] = (acc[effect.state] ?? 0) + 1;
      return acc;
    }, {});
    return {
      nodeId: node.node_id,
      parentId: node.parent_id,
      state: node.state,
      attempts: node.attempts,
      turns: node.turn_count,
      sessionId: node.session_id,
      sessionFile: node.session_file,
      doneReason: node.done_reason,
      lastTurn: last ? { turnId: last.turn_id, kind: last.kind, state: last.state, effects: counts } : null,
      openAsks: journal.openAsks(node.node_id).map((ask) => ask.token),
      lease: journal.liveLease(node.node_id)?.epoch ?? null,
      pending: journal.pendingMessages(node.node_id).length,
    };
  });
  const liveSupervisors = journal.supervisors().filter((row) => row.state === "live" && pidIsAlive(row.pid));
  const childPids = journal
    .allOpenTurns()
    .map((turn) => turn.child_pid)
    .filter(Boolean);
  const resident = residentMb([...liveSupervisors.map((row) => row.pid), ...childPids]);
  return {
    store: journal.path,
    schemaVersion: SCHEMA_VERSION,
    meta: journal.meta(),
    epoch: supervisor?.epoch ?? null,
    cap: supervisor?.options.cap ?? null,
    active: supervisor ? [...supervisor.active.keys()] : [],
    nodes,
    leases: journal.liveLeases().map((lease) => ({ nodeId: lease.node_id, epoch: lease.epoch, pid: lease.owner_pid })),
    childPids,
    supervisors: journal.supervisors().map((row) => ({ pid: row.pid, epoch: row.epoch, state: row.state, driver: row.driver })),
    asks: journal.openAsks().map((ask) => ({
      token: ask.token,
      nodeId: ask.node_id,
      priority: ask.priority,
      question: ask.question,
      defaultAnswer: ask.default_answer,
      deadlineAt: ask.deadline_at,
    })),
    fences: JSON.parse(journal.meta().fences ?? "[]"),
    resident,
  };
}

// ── entry point ──────────────────────────────────────────────────────────────

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

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = parseArgs(process.argv.slice(2));
  if (!args.root) {
    console.error(
      "usage: supervisor.mjs --root <fleet-root> [--cap N] [--driver rpc|scripted] [--naive] [--idle-exit-ms N]\n" +
        "\n" +
        "Each child loads the duplication guard. FLEET_GUARD=off in this process's environment disables it for every child it spawns.",
    );
    process.exit(2);
  }
  const supervisor = new Supervisor({
    root: String(args.root),
    cap: args.cap ? Number(args.cap) : undefined,
    driver: args.driver ? String(args.driver) : undefined,
    model: args.model ? String(args.model) : undefined,
    naive: Boolean(args.naive),
    turnTimeoutMs: args["turn-timeout-ms"] ? Number(args["turn-timeout-ms"]) : undefined,
    askTtlMs: args["ask-ttl-ms"] ? Number(args["ask-ttl-ms"]) : undefined,
    idleExitMs: args["idle-exit-ms"] ? Number(args["idle-exit-ms"]) : undefined,
    extensions: args.extension ? [].concat(args.extension) : [],
    fullDiscovery: Boolean(args["full-discovery"]),
    piVersion: args["pi-version"] ? String(args["pi-version"]) : undefined,
  });
  try {
    await supervisor.start();
  } catch (error) {
    // A start that cannot happen is an operator's answer, not a stack trace:
    // the loudest thing this process can do with a refusal is print it and go.
    console.error(`fleet: ${error.message}`);
    process.exit(1);
  }
  const shutdown = async (signal) => {
    console.log(`fleet: ${signal} received, stopping`);
    await supervisor.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // The tick timer is what held the process up; it stops rescheduling itself
  // when the fleet has nothing left to do. `done` resolves after that stop has
  // finished, so this is an exit and not an intention to exit.
  const cleanExit = await supervisor.done;
  process.exit(cleanExit ? 0 : 1);
}
