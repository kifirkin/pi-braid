/**
 * Target resolution and the write behind the `sink` tool.
 *
 * The shell form is `producer > out 2> err`. The redirections are set up before
 * the program runs, so a missing directory or a directory in place of a file
 * fails without ever starting it; the same checks run here before the spawn and
 * refuse with the path named. The bytes themselves are the program's capture,
 * copied after the exit, which is byte-exact because the capture file is what
 * the program wrote.
 *
 * One class the shell form has and this does not: `> f 2> f` truncates the same
 * file twice and lets the streams interleave. A durable file with two writers
 * and no ordering is not a thing a tool can report honestly, so two targets
 * that resolve to one path are refused instead.
 */

import { copyFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

/** A validated `sink` call. */
export interface SinkRequest {
  /** Where stdout goes; absent means stdout is shown in the result. */
  stdoutTo?: string;
  /** Where stderr goes; absent means stderr is shown in the result. */
  stderrTo?: string;
}

/** Why a call never reached a program. */
export interface SinkRefusal {
  kind: string;
  message: string;
}

/** Absolute destinations, resolved against the tool's cwd. */
export interface SinkPlan {
  stdout?: string;
  stderr?: string;
}

/** What was written where, for the result. */
export interface SinkWritten {
  stdoutBytes?: number;
  stderrBytes?: number;
}

/** Whether a path is a directory, with a missing path answering false. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/** A file's size, with a missing file answering zero. */
function sizeOf(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Resolve the destinations, or refuse.
 *
 * Both branches are returned so a caller can report the plan it would have
 * written alongside the refusal; `refusal` is what decides whether a program is
 * started.
 */
export function planSink(
  request: SinkRequest,
  cwd: string,
): {
  refusal: SinkRefusal | null;
  plan: SinkPlan;
} {
  const plan: SinkPlan = {};
  if (request.stdoutTo === undefined && request.stderrTo === undefined) {
    return {
      refusal: {
        kind: "sink-target",
        message:
          "refused: sink needs stdout_to or stderr_to. A call with neither writes no file and runs a program whose output nobody reads; use run for that.",
      },
      plan,
    };
  }

  const fields: Array<{ field: "stdout_to" | "stderr_to"; value?: string }> = [
    { field: "stdout_to", value: request.stdoutTo },
    { field: "stderr_to", value: request.stderrTo },
  ];
  for (const { field, value } of fields) {
    if (value === undefined) continue;
    if (value === "") {
      return {
        refusal: {
          kind: "sink-target",
          message: `refused: ${field} is empty. A destination must name a file.`,
        },
        plan,
      };
    }
    const target = resolve(cwd, value);
    const stat = isDirectory(target);
    if (stat) {
      return {
        refusal: {
          kind: "sink-target",
          message: `refused: ${target} is a directory; a stream cannot be written to a directory. A file inside it is what the shell's redirect would create.`,
        },
        plan,
      };
    }
    const parent = dirname(target);
    if (!isDirectory(parent)) {
      return {
        refusal: {
          kind: "sink-directory",
          message: `refused: ${parent} does not exist or is not a directory, so ${field} cannot be written. The shell's redirect fails the same way before the program starts; create the directory first.`,
        },
        plan,
      };
    }
    if (field === "stdout_to") plan.stdout = target;
    else plan.stderr = target;
  }

  if (plan.stdout !== undefined && plan.stdout === plan.stderr) {
    return {
      refusal: {
        kind: "one-target",
        message: `refused: stdout_to and stderr_to resolve to the same path (${plan.stdout}). Writing both streams to one file interleaves them and truncates it twice; name two paths, or use bash if one interleaved stream is what you want.`,
      },
      plan,
    };
  }

  return { refusal: null, plan };
}

/**
 * Copy each redirected stream from its capture file to its destination, after
 * the program has exited. A destination is created even when the program wrote
 * nothing, which is what `> out` does with an empty stdout.
 */
export function writeSink(
  plan: SinkPlan,
  sources: { stdout: string; stderr: string },
): SinkWritten {
  const written: SinkWritten = {};
  if (plan.stdout !== undefined) {
    copyFileSync(sources.stdout, plan.stdout);
    written.stdoutBytes = sizeOf(plan.stdout);
  }
  if (plan.stderr !== undefined) {
    copyFileSync(sources.stderr, plan.stderr);
    written.stderrBytes = sizeOf(plan.stderr);
  }
  return written;
}
