/**
 * A scripted node driver: the same driver contract as the RPC one, with the
 * model replaced by a fixed step list.
 *
 * It exists so the crash drill can be deterministic and free. Its steps
 * perform real effects on a real file, so a replayed step shows up in the
 * world, not only in the journal. Two instruments then measure duplication -
 * the file and the journal - and neither can be satisfied by editing the
 * other.
 *
 * Steps, all executed as one bash call each:
 *   { op: "append", text }                  append one line to the world file
 *   { op: "sleep", ms }                     hold the turn open; the kill window
 *   { op: "park", question, defaultAnswer } end the turn with the ask sentinel
 *   { op: "done" }                          end the turn with the done sentinel
 *   { op: "text", text }                    end the turn with plain text
 *
 * A recovery prompt changes what the node does, which is the point: it names
 * the effects the journal already recorded, and a node that reads its
 * instructions skips them. An effect listed as unknown is never re-executed -
 * the node checks the world for its mark and moves on. A plain prompt (the
 * charter, or a naive replay) names nothing, so the whole list runs again.
 */

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const ASK_SENTINEL = "FLEET-ASK:";
export const DONE_SENTINEL = "FLEET-DONE";

const COMPLETED_LINE = /^- seq (\d+) \S+ completed/m;
const UNKNOWN_LINE = /^- seq (\d+) \S+ unknown/m;

/** Effects a prompt says the journal already recorded. */
export function planFromPrompt(promptText) {
  const completed = new Set();
  const unknown = new Set();
  for (const line of String(promptText ?? "").split("\n")) {
    const done = line.match(COMPLETED_LINE);
    if (done) completed.add(Number(done[1]));
    const unsure = line.match(UNKNOWN_LINE);
    if (unsure) unknown.add(Number(unsure[1]));
  }
  return { completed, unknown };
}

export class ScriptedDriver {
  constructor(args) {
    this.kind = "scripted";
    this.cfg = args;
    this.steps = args.steps ?? [];
    this.worldFile = args.worldFile;
    this.sessionFile = args.sessionFile ?? null;
    this.sessionId = args.sessionId;
    this.pid = null;
    this.pgid = null;
    this.stopped = false;
    this.seq = 0;
    this.toolCount = 0;
    this.requests = 0;
    this.messageCount = 0;
    this.pendingSteer = null;
    this.inFlight = null;
    this.finalText = "";
    this.skipped = [];
    this.plan = { completed: new Set(), unknown: new Set() };
  }

  onEvent(sink) {
    this.onRaw = sink;
  }

  async start() {
    if (this.sessionFile) {
      mkdirSync(dirname(this.sessionFile), { recursive: true });
      writeFileSync(this.sessionFile, "");
    }
    mkdirSync(dirname(this.worldFile), { recursive: true });
    return { sessionId: this.sessionId, sessionFile: this.sessionFile };
  }

  _emit(event) {
    this.onRaw?.(event);
  }

  _worldHas(text) {
    try {
      return readFileSync(this.worldFile, "utf8").split("\n").includes(text);
    } catch (error) {
      if (error.code === "ENOENT") return false;
      throw error;
    }
  }

  async prompt(text) {
    this.stopped = false;
    this.toolCount = 0;
    this.plan = planFromPrompt(text);
    const run = this._run();
    this.inFlight = run;
    try {
      await run;
    } finally {
      this.inFlight = null;
    }
    return { ok: true };
  }

  /**
   * Recorded effects are skipped; an unknown effect is skipped after the world
   * is checked, because re-running a non-idempotent call whose outcome is
   * unknown is exactly the failure the journal exists to prevent.
   */
  _skip(index, step) {
    if (this.plan.completed.has(index)) {
      this.skipped.push({ seq: index, reason: "journal recorded completed" });
      return true;
    }
    if (this.plan.unknown.has(index)) {
      if (step.op === "append") {
        const applied = this._worldHas(step.text);
        this.skipped.push({ seq: index, reason: applied ? "unknown but present in the world" : "unknown, not re-executed" });
        return true;
      }
      this.skipped.push({ seq: index, reason: "unknown, not re-executed" });
      return true;
    }
    return false;
  }

  async _run() {
    for (const [index, step] of this.steps.entries()) {
      if (this.stopped) return;
      if (this._skip(index + 1, step)) continue;
      this.requests += 1;
      this._emit({
        type: "model_request",
        seq: this.requests,
        messageCount: this.messageCount,
        toolCount: this.toolCount,
      });
      if (step.op === "append" || step.op === "sleep") {
        this.toolCount += 1;
        const toolCallId = `scripted-${this.sessionId}-${index + 1}`;
        this._emit({
          type: "tool_start",
          toolCallId,
          toolName: "bash",
          args: step.op === "append" ? { command: `printf '${step.text}\\n' >> world.log` } : { command: `sleep ${(step.ms ?? 0) / 1000}` },
        });
        if (step.op === "append") {
          appendFileSync(this.worldFile, step.text + "\n");
        } else {
          await this._wait(step.ms ?? 0);
        }
        if (this.stopped) return;
        this._emit({ type: "tool_end", toolCallId, toolName: "bash", result: { ok: true }, isError: false });
        continue;
      }
      if (step.op === "park") {
        const priority = step.priority == null ? "" : ` | priority: ${step.priority}`;
        this.finalText = `${ASK_SENTINEL} ${step.question} | default: ${step.defaultAnswer ?? "keep the current course"}${priority}`;
        this._emit({ type: "final_text", text: this.finalText });
        return;
      }
      if (step.op === "done") {
        this.finalText = DONE_SENTINEL;
        this._emit({ type: "final_text", text: this.finalText });
        return;
      }
      if (step.op === "text") {
        this.finalText = step.text;
        this._emit({ type: "final_text", text: this.finalText });
        return;
      }
      throw new Error(`unknown scripted step: ${JSON.stringify(step)}`);
    }
    this.finalText = DONE_SENTINEL;
    this._emit({ type: "final_text", text: this.finalText });
  }

  _wait(ms) {
    return new Promise((resolveWait) => {
      const timer = setTimeout(resolveWait, ms);
      this._cancelWait = () => {
        clearTimeout(timer);
        resolveWait();
      };
    });
  }

  _deliverSteer(afterEffectSeq) {
    if (!this.pendingSteer) return;
    const text = this.pendingSteer;
    this.pendingSteer = null;
    this._emit({ type: "message_end", role: "user", message: { role: "user", content: text } });
    this._emit({ type: "steer_delivered", afterEffectSeq, text });
    this.finalText = `STEERED: ${text}`;
  }

  async steer(text) {
    this.pendingSteer = text;
    return { disposition: "queued" };
  }

  async state() {
    return { sessionId: this.sessionId, sessionFile: this.sessionFile, messageCount: this.messageCount };
  }

  async messages() {
    return { messages: [] };
  }

  async stop() {
    this.stopped = true;
    this._cancelWait?.();
    if (this.inFlight) await this.inFlight.catch(() => {});
  }

  killGroup() {
    this.stopped = true;
    this._cancelWait?.();
    return false;
  }
}

export function createScriptedDriver(args) {
  return new ScriptedDriver(args);
}
