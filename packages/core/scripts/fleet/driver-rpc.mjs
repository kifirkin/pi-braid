/**
 * A node driver that owns one pi RPC child per turn.
 *
 * The supervisor holds no model and no agent runtime: a node is a pi session,
 * and a session exists only while a turn is being driven. That is what keeps
 * the idle cost at zero and what makes the process boundary the crash
 * boundary the journal has to survive.
 *
 * Framing is strict JSONL and records are split on LF only: a generic line
 * reader also splits on U+2028/U+2029, which are legal inside a JSON string.
 *
 * The child is spawned detached so it gets its own process group. The group id
 * is journalled with the turn, and it is the fence: a restarted supervisor
 * kills the group a dead predecessor left behind before it resumes that node,
 * so a stale drive cannot keep writing after its supervisor is gone.
 */

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { GUARD_ENV } from "./tool-guard.mjs";

const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * The guard every child loads, whatever else it is or is not given.
 *
 * It is resolved from this module's own location rather than from a configured
 * path, so a fleet root cannot point a child at a guard that is not the one
 * shipped beside the driver that spawned it.
 */
export const GUARD_EXTENSION = fileURLToPath(new URL("./tool-guard.mjs", import.meta.url));

/**
 * The child-side contract the guard reads. Env because it is the only channel
 * a spawned child inherits without a second configuration source, and because
 * the values are per-turn: the driver is constructed after `beginTurn` has
 * assigned the turn id, so they are known before the spawn.
 *
 * An incomplete contract yields an empty environment, and the guard then
 * registers no hook at all rather than guarding the wrong turn.
 */
export function guardEnvironment({ root, nodeId, turnId }) {
  if (!root || nodeId == null || turnId == null) return {};
  return {
    [GUARD_ENV.root]: String(root),
    [GUARD_ENV.node]: String(nodeId),
    [GUARD_ENV.turn]: String(turnId),
  };
}

export class RpcDriver {
  /**
   * @param {object} args
   * @param {string} args.piBin        absolute path or PATH name of the pi executable
   * @param {string} args.cwd          workspace root the node works in
   * @param {string} args.sessionId    session id the node keeps across turns
   * @param {string} args.sessionDir   where pi stores the session file
   * @param {string} args.model        provider/model string passed to the child
   * @param {string[]} args.extensions extra `-e` entries (provider packages a lean child needs)
   * @param {string} args.guardExtension the duplication guard every child loads
   * @param {string[]} args.extraArgs  additional child flags
   * @param {Record<string,string>} args.env  child environment
   * @param {(event: object) => void} args.onEvent  normalized event sink
   */
  constructor(args) {
    this.kind = "rpc";
    this.cfg = args;
    this.child = null;
    this.pid = null;
    this.pgid = null;
    this.sessionId = args.sessionId;
    this.sessionFile = null;
    this.exit = null;
    this.pending = new Map();
    this.buffer = "";
    this.seq = 0;
    this.messageCount = 0;
    this.toolCount = 0;
    this.requests = 0;
    this.stderr = "";
    this.settled = false;
  }

  args() {
    const cfg = this.cfg;
    const args = [
      "--mode",
      "rpc",
      "--session-id",
      cfg.sessionId,
      "--session-dir",
      cfg.sessionDir,
      "--thinking",
      cfg.thinking ?? "off",
      "--model",
      cfg.model,
      "--no-mcp",
      "--no-context-files",
    ];
    if (!cfg.fullDiscovery) {
      args.push("--no-extensions", "--no-skills", "--no-prompt-templates");
      for (const ext of cfg.extensions ?? []) args.push("-e", ext);
    }
    // The guard is not an optional extension: it loads in both resource modes,
    // because a child that discovers its own extensions still needs the one
    // that refuses a duplicated effect.
    if (cfg.guardExtension) args.push("-e", cfg.guardExtension);
    args.push(...(cfg.extraArgs ?? []));
    return args;
  }

  async start() {
    const child = spawn(this.cfg.piBin ?? "pi", this.args(), {
      cwd: this.cfg.cwd,
      detached: true,
      env: { ...process.env, ...(this.cfg.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;
    this.pid = child.pid;
    this.pgid = child.pid;
    this.exit = new Promise((resolveExit) => child.once("exit", (code, signal) => resolveExit({ code, signal })));
    child.stderr.on("data", (chunk) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-8000);
    });
    child.stdout.on("data", (chunk) => this._read(chunk));
    child.once("error", (error) => this._failAll(error));
    this.exit.then(() => this._failAll(new Error(`child exited (pid ${this.pid})`)));
    const state = (await this.request({ type: "get_state" }))?.data ?? {};
    this.sessionId = state.sessionId ?? this.sessionId;
    this.sessionFile = state.sessionFile ?? null;
    this.messageCount = state.messageCount ?? 0;
    return { sessionId: this.sessionId, sessionFile: this.sessionFile };
  }

  _read(chunk) {
    this.buffer += chunk.toString("utf8");
    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        this.onRaw({ type: "unparsable", line: line.slice(0, 400) });
        continue;
      }
      if (record.type === "response") {
        const entry = this.pending.get(record.id);
        if (entry) {
          this.pending.delete(record.id);
          clearTimeout(entry.timer);
          entry.resolve(record);
        }
        continue;
      }
      this._event(record);
    }
  }

  _event(record) {
    const emit = (event) => this.onRaw(event);
    switch (record.type) {
      case "tool_execution_start":
        this.toolCount += 1;
        emit({
          type: "tool_start",
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          args: record.args,
        });
        break;
      case "tool_execution_end":
        emit({
          type: "tool_end",
          toolCallId: record.toolCallId,
          toolName: record.toolName,
          result: record.result,
          isError: Boolean(record.isError),
        });
        break;
      case "turn_start":
        this.requests += 1;
        emit({
          type: "model_request",
          seq: this.requests,
          messageCount: this.messageCount,
          toolCount: this.toolCount,
        });
        break;
      case "message_end":
        this.messageCount += 1;
        emit({ type: "message_end", role: record.message?.role, message: record.message });
        break;
      case "agent_settled":
        this.settled = true;
        emit({ type: "settled", aborted: Boolean(record.aborted) });
        break;
      default:
        break;
    }
  }

  /** Installed by the supervisor; overwritten immediately after construction. */
  onRaw() {}

  onEvent(sink) {
    this.onRaw = (event) => sink(event);
  }

  request(message, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS) {
    const id = `fleet-${++this.seq}`;
    const payload = { id, ...message };
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) {
        reject(new Error("child is not running"));
        return;
      }
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`timeout waiting for ${message.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify(payload) + "\n", (error) => {
        if (!error) return;
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  async prompt(text) {
    this.settled = false;
    return this.request({ type: "prompt", message: text });
  }

  async steer(text) {
    return this.request({ type: "steer", message: text });
  }

  async state() {
    return (await this.request({ type: "get_state" }, 20_000))?.data ?? {};
  }

  async messages() {
    return (await this.request({ type: "get_messages" }, 20_000))?.data ?? {};
  }

  /** Orderly shutdown: close stdin, then make sure the process group is gone. */
  async stop({ graceMs = 5000 } = {}) {
    if (!this.child) return;
    try {
      this.child.stdin.end();
    } catch (error) {
      if (!/not running|EPIPE/.test(String(error))) throw error;
    }
    const raced = await Promise.race([
      this.exit.then(() => true),
      new Promise((resolveWait) => setTimeout(() => resolveWait(false), graceMs)),
    ]);
    if (!raced) this.killGroup("SIGKILL");
    await this.exit;
  }

  killGroup(signal = "SIGTERM") {
    if (!this.pgid) return false;
    try {
      process.kill(-this.pgid, signal);
      return true;
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
      return false;
    }
  }

  _failAll(error) {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
      this.pending.delete(id);
    }
  }
}

export function createRpcDriver(args) {
  return new RpcDriver(args);
}

/** True when a process group still has members (used by the orphan fence). */
export function groupIsAlive(pgid) {
  if (!pgid) return false;
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

/** True when a single pid is alive; a zombie counts as gone for our purposes. */
export function pidIsAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}
