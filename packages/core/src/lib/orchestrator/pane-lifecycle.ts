/**
 * Pane lifecycle — the herdr half of a worker's terminal transition.
 *
 * The registry records two facts around a worker's life: the pane it was
 * started in, and the moment the seat closed the row. The pane itself belongs
 * to neither. An interactive agent does not exit when its turn ends, and
 * `herdr agent` has no stop, so a pane outlives its worker until something
 * closes it. Nothing does: the close path has never spoken to herdr, and the
 * pairing lived in the seat's memory, where it held 442 times and was dropped
 * 158 times in one measured corpus.
 *
 * This module is the act, and every guard in it is a way the act could be
 * wrong. Each guard costs a pane that stays open, and that is the trade: a
 * pane is cheap next to a killed run.
 *
 *   - A process cannot close the pane it runs in, so the caller's own pane is
 *     out of reach by construction.
 *   - A pane herdr reports as `working` or `blocked` may hold a live run
 *     behind a row closed too early, so it is left alone.
 *   - A pane whose agent session is not the worker's belongs to someone else;
 *     the row's `workerSession` is the identity to compare it with.
 *   - A pane that is already gone is the outcome we wanted, not a failure.
 *
 * Nothing here throws. A close that fails degrades to a line in the report;
 * the registry close it accompanies stands on its own.
 */

import { execFileSync } from "node:child_process";
import { resolve as resolvePath } from "node:path";

/** A pane id herdr could read: no leading dash, no whitespace, no shell shape. */
const SAFE_PANE_ID = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;

/** How long a herdr read or close may take before it is abandoned. */
const HERDR_TIMEOUT_MS = 5000;

/**
 * What the pane step did. `closed` and `already-gone` are both successes: the
 * pane is not standing. `skipped` is a guard, `refused` a contradiction the
 * caller has to resolve, `unavailable` a herdr that could not answer.
 */
export type PaneReapResult = "closed" | "already-gone" | "skipped" | "refused" | "unavailable";

export interface PaneReapOutcome {
  result: PaneReapResult;
  /** One line for the close report: what happened, and why when it did not. */
  detail: string;
}

export interface PaneReapInput {
  /** The handle the row records, or the one the caller passes for a row with none. */
  pane: string | null | undefined;
  /** The worker's session file, as the row records it. Absent leaves identity unchecked. */
  workerSession?: string | null;
}

/** What herdr says about one pane, or why it could not say. */
type PaneRead =
  | { kind: "state"; status: string; session: string | null }
  | { kind: "gone"; detail: string }
  | { kind: "unavailable"; detail: string };

/** One herdr invocation: never throws, keeps the exit code and both streams. */
function runHerdr(args: string[]): { ok: boolean; stdout: string; stderr: string } {
  const bin = process.env.HERDR_BIN_PATH || "herdr";
  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: HERDR_TIMEOUT_MS,
    });
    return { ok: true, stdout, stderr: "" };
  } catch (err) {
    const e = err as { stdout?: unknown; stderr?: unknown; message?: string };
    const stdout = typeof e.stdout === "string" ? e.stdout : "";
    const stderr =
      typeof e.stderr === "string" && e.stderr.length > 0
        ? e.stderr
        : (e.message ?? "herdr did not run");
    return { ok: false, stdout, stderr };
  }
}

/** The herdr error code in a payload, when the payload carries one. */
function errorCode(payload: unknown): string | null {
  const code = (payload as { error?: { code?: unknown } } | null)?.error?.code;
  return typeof code === "string" ? code : null;
}

/** Parse one herdr JSON payload; a non-JSON stream reads as null. */
function parsePayload(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Read one pane. herdr answers a missing pane with exit 0 and an error
 * payload, so the payload decides `gone`, not the exit code.
 */
function readPane(pane: string): PaneRead {
  const run = runHerdr(["pane", "get", pane]);
  const payload = parsePayload(run.stdout);
  const code = errorCode(payload);
  if (code === "pane_not_found") return { kind: "gone", detail: `pane ${pane} is gone` };
  if (code) return { kind: "unavailable", detail: `herdr reported ${code} for pane ${pane}` };

  const record = (payload as { result?: { pane?: Record<string, unknown> } } | null)?.result?.pane;
  if (!record || typeof record !== "object") {
    const reason = run.stderr.trim() || run.stdout.trim() || "no output";
    return { kind: "unavailable", detail: `herdr returned no pane for ${pane}: ${reason}` };
  }

  const status = typeof record.agent_status === "string" ? record.agent_status : "unknown";
  const sessionValue = (record.agent_session as { value?: unknown } | null | undefined)?.value;
  const session = typeof sessionValue === "string" && sessionValue.length > 0 ? sessionValue : null;
  return { kind: "state", status, session };
}

/** True when two absolute paths name the same file, by string after resolution. */
function samePath(a: string, b: string): boolean {
  return resolvePath(a) === resolvePath(b);
}

/**
 * End the pane a closed worker was started in.
 *
 * The caller decides *which* handle to pass (the row's, or an argument for a
 * row that recorded none); everything about how to end it safely lives here,
 * so the tool cannot grow a second policy.
 */
export function reapWorkerPane(input: PaneReapInput): PaneReapOutcome {
  try {
    if (!process.env.HERDR_ENV) {
      return {
        result: "skipped",
        detail: "not inside a herdr session (HERDR_ENV unset), so no pane to close",
      };
    }

    const raw = typeof input.pane === "string" ? input.pane.trim() : "";
    if (!raw) {
      return {
        result: "skipped",
        detail: "no pane recorded on the row and none given, so the close named nothing to close",
      };
    }
    if (!SAFE_PANE_ID.test(raw)) {
      return { result: "refused", detail: `pane id "${raw}" is not a pane herdr could read` };
    }
    if (raw === process.env.HERDR_PANE_ID) {
      return {
        result: "skipped",
        detail: `pane ${raw} is this process's own pane, which a process cannot close from inside`,
      };
    }

    const state = readPane(raw);
    if (state.kind === "gone") {
      return { result: "already-gone", detail: `pane ${raw} was already gone` };
    }
    if (state.kind === "unavailable") {
      return { result: "unavailable", detail: state.detail };
    }

    if (state.status === "working" || state.status === "blocked") {
      return {
        result: "skipped",
        detail: `pane ${raw} reports its agent ${state.status}, so the close left it running`,
      };
    }

    // A pane is the worker's only when the session inside it is the worker's.
    // A mismatch is a contradiction between two records, so it is refused and
    // both paths are named rather than resolved by guessing.
    const recorded = typeof input.workerSession === "string" ? input.workerSession.trim() : "";
    if (recorded && state.session && !samePath(recorded, state.session)) {
      return {
        result: "refused",
        detail:
          `pane ${raw} holds a different agent session (${state.session}) than the row records ` +
          `(${recorded}); a foreign pane is not closed`,
      };
    }

    const close = runHerdr(["pane", "close", raw]);
    if (close.ok) return { result: "closed", detail: `pane ${raw} closed` };

    const payload = parsePayload(close.stdout);
    if (errorCode(payload) === "pane_not_found") {
      return { result: "already-gone", detail: `pane ${raw} was already gone` };
    }
    const reason = parseErrorMessage(payload) ?? (close.stderr.trim() || "no output");
    return { result: "unavailable", detail: `herdr could not close pane ${raw}: ${reason}` };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return { result: "unavailable", detail: `pane step failed: ${reason}` };
  }
}

/** The herdr error message in a payload, when it carries one. */
function parseErrorMessage(payload: unknown): string | null {
  const message = (payload as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.length > 0 ? message : null;
}

/** True when the pane step left nothing standing: the two success outcomes. */
export function paneIsClear(outcome: PaneReapOutcome): boolean {
  return outcome.result === "closed" || outcome.result === "already-gone";
}
