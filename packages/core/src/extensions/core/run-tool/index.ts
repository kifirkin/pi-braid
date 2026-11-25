/**
 * run — one program and its argument list, without a shell.
 *
 * The census behind this tool measured 223,137 bash calls out of 504,124 tool
 * calls in a frozen session corpus, of which 24,793 (11.1%) carry no shell
 * metacharacter at all: one program and its arguments. Those are the calls this
 * tool replaces exactly; the rest need a shell (pipelines, redirection,
 * heredocs, command substitution, loops), and this tool refuses the operators
 * that would have made a call a shell program rather than growing into one.
 *
 * Shape: `argv` is the call; `cwd`, `env` and `stdin` carry its context; the
 * timeout is required so no call can hang a session; `max_output_bytes` bounds
 * each stream, and a stream past the cap keeps its head and its tail while the
 * dropped byte count and the file holding the full text are named.
 *
 * The destructive guard is narrow on purpose: six verbs, and only when a path
 * argument resolves outside the session workspace. The guard itself lives in
 * `lib/tools/workspace-guard.ts`, so a later argv-shaped tool (`git`) passes its
 * own verb set to the same mechanism instead of copying it.
 */

import { statSync } from "node:fs";
import { resolve } from "node:path";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionToolContext,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Static } from "typebox";
import {
  DEFAULT_OUTPUT_BYTES,
  MAX_OUTPUT_BYTES,
  MAX_TIMEOUT_MS,
  MIN_OUTPUT_BYTES,
  boundStream,
  capturePathFor,
  describeStream,
  discardCapture,
  executeArgv,
  findRefusal,
  offloadText,
} from "./run.js";
import type { RunCapture, RunRequest, RunStream, StreamDetails } from "./run.js";

/** Whether a path is a directory, with a missing path answering false. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // A path that cannot be stat'd is not a directory this call can run in; the
    // refusal below names it, which is more useful than the errno.
    return false;
  }
}

const runParameters = Type.Object({
  argv: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "The program and its arguments, one element each. argv[0] is the executable. No shell: pipes, redirection, heredocs and $(...) are refused.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory; relative to the session cwd. Defaults to the session cwd.",
    }),
  ),
  env: Type.Optional(
    // A map of string to string, written as the keyword rather than a builder
    // helper whose emitted schema the tool-surface gate would have to allow.
    Type.Unsafe<Record<string, string>>({
      type: "object",
      additionalProperties: { type: "string" },
      description: "Environment overrides merged over the session environment. Nothing is removed.",
    }),
  ),
  stdin: Type.Optional(
    Type.String({ description: "Text written to the program's stdin; closed after writing." }),
  ),
  timeout_ms: Type.Integer({
    minimum: 1,
    maximum: MAX_TIMEOUT_MS,
    description: "Required. The program is killed when it outlives this many milliseconds.",
  }),
  max_output_bytes: Type.Optional(
    Type.Integer({
      minimum: MIN_OUTPUT_BYTES,
      maximum: MAX_OUTPUT_BYTES,
      description: `Byte cap per stream (stdout and stderr separately). Default ${DEFAULT_OUTPUT_BYTES}. Past the cap the head and tail are kept and the full text is written to a file named in the result.`,
    }),
  ),
});

export type RunParameters = Static<typeof runParameters>;

/** Structured result for rendering and scripts. */
export interface RunToolDetails {
  /** Present when the call was refused before a program started. */
  refused?: string;
  cwd?: string;
  exit_code?: number | null;
  signal?: string | null;
  timed_out?: boolean;
  aborted?: boolean;
  duration_ms?: number;
  stdout?: StreamDetails;
  stderr?: StreamDetails;
  /** Present when the child could not be started at all. */
  spawn_error?: string;
}

function numberLine(bytes: number): string {
  return bytes.toLocaleString("en-US");
}

/** Render one stream as a labelled section, with its truncation note. */
function renderStream(label: "stdout" | "stderr", stream: RunStream): string {
  const body = stream.text;
  const sections: string[] = [];
  const text = body.endsWith("\n") || body === "" ? body : `${body}\n`;
  sections.push(`${label}:\n${text}`);
  if (stream.truncated) {
    sections.push(
      `[${label}: showing ${numberLine(stream.shownBytes)} of ${numberLine(stream.bytes)} bytes ` +
        `with ${numberLine(stream.droppedBytes)} omitted; full text: ${stream.fullTextPath}]`,
    );
  }
  return sections.join("\n");
}

/** The one-line outcome, so a failure is readable before the output. */
function statusLine(params: RunParameters, capture: RunCapture): string {
  if (capture.spawnError !== undefined) {
    return `could not start ${params.argv[0]}: ${capture.spawnError}`;
  }
  if (capture.timedOut) {
    return `timed out after ${params.timeout_ms}ms: killed`;
  }
  if (capture.aborted) {
    return `aborted: killed after ${capture.durationMs}ms`;
  }
  if (capture.signal !== null) {
    return `killed by ${capture.signal} after ${capture.durationMs}ms`;
  }
  const code = capture.exitCode ?? "none";
  const cwd = params.cwd === undefined ? "" : ` · cwd ${capture.cwd}`;
  return `exit ${code} · ${capture.durationMs}ms${cwd}`;
}

/** Whether the call is an error for the model: a refusal, a timeout, or a non-zero exit. */
function isFailure(capture: RunCapture): boolean {
  return (
    capture.spawnError !== undefined ||
    capture.timedOut ||
    capture.aborted ||
    capture.exitCode !== 0
  );
}

export function createRunTool(): ToolDefinition<typeof runParameters, RunToolDetails> {
  return {
    name: "run",
    label: "Run",
    description:
      "Execute one program with an argument list, without a shell. Returns stdout and stderr separately, each capped at max_output_bytes with the dropped bytes named and the full text in a file. Use for a single program and its arguments: tests, builds, git, wc, node, python, rg. A shell-only command keeps needing bash, and is refused here rather than reinterpreted: pipes, redirection, heredocs and command substitution (an argument carrying |, &&, ;, a backtick or $( is refused), glob expansion (a glob-shaped path such as *.md or src/* is refused; pass the paths or use find/grep), and a shell invoked with -c. argv[0] from a destructive set (rm, mv, dd, chmod, shred, truncate) is refused when a path argument resolves outside the session workspace. There is no TTY: a program that needs a terminal fails on its own terms. timeout_ms is required, and a program that outlives it is killed.",
    parameters: runParameters,
    async execute(
      toolCallId: string,
      params: RunParameters,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<RunToolDetails> | undefined,
      ctx: ExtensionToolContext,
    ) {
      const sessionCwd = ctx.cwd;
      const workspaceRoot = sessionCwd;
      const cwd = resolve(sessionCwd, params.cwd ?? ".");
      const request: RunRequest = {
        argv: params.argv,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.env === undefined ? {} : { env: params.env }),
        ...(params.stdin === undefined ? {} : { stdin: params.stdin }),
        timeout_ms: params.timeout_ms,
        ...(params.max_output_bytes === undefined
          ? {}
          : { max_output_bytes: params.max_output_bytes }),
      };

      // The cwd is a filesystem fact, so it is read before the pure refusals:
      // every path in the guard is resolved against it.
      if (!isDirectory(cwd)) {
        const message = `refused: cwd ${cwd} does not exist or is not a directory. A call is not run against a missing directory.`;
        return {
          content: [{ type: "text" as const, text: message }],
          details: { refused: "cwd", cwd } satisfies RunToolDetails,
          isError: true,
        };
      }

      const refusal = findRefusal(request, { cwd, workspaceRoot });
      if (refusal) {
        return {
          content: [{ type: "text" as const, text: refusal.message }],
          details: { refused: refusal.kind, cwd } satisfies RunToolDetails,
          isError: true,
        };
      }

      const capture = await executeArgv(request, { cwd, workspaceRoot }, signal);
      const cap = params.max_output_bytes ?? DEFAULT_OUTPUT_BYTES;
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "anonymous";
      const stdoutPath =
        capture.stdoutBytes > cap
          ? offloadText(capturePathFor(capture, "stdout"), sessionId, toolCallId, "run-stdout")
          : undefined;
      const stderrPath =
        capture.stderrBytes > cap
          ? offloadText(capturePathFor(capture, "stderr"), sessionId, toolCallId, "run-stderr")
          : undefined;
      const offloadFailed =
        (capture.stdoutBytes > cap && stdoutPath === undefined) ||
        (capture.stderrBytes > cap && stderrPath === undefined);
      const stdout = boundStream(
        capture.stdoutPath,
        cap,
        stdoutPath ?? (capture.stdoutBytes > cap ? capture.stdoutPath : undefined),
      );
      const stderr = boundStream(
        capture.stderrPath,
        cap,
        stderrPath ?? (capture.stderrBytes > cap ? capture.stderrPath : undefined),
      );
      // A failed offload keeps the capture directory: the result names that
      // path, so it must still exist when the reader follows it.
      if (!offloadFailed) discardCapture(capture);

      const lines = [statusLine(params, capture)];
      if (stdout.text === "" && stderr.text === "") {
        lines.push("(no output)");
      } else {
        if (stdout.text !== "") lines.push(renderStream("stdout", stdout));
        if (stderr.text !== "") lines.push(renderStream("stderr", stderr));
      }

      return {
        content: [{ type: "text" as const, text: lines.join("\n\n") }],
        details: {
          cwd: capture.cwd,
          exit_code: capture.exitCode,
          signal: capture.signal,
          timed_out: capture.timedOut,
          aborted: capture.aborted,
          duration_ms: capture.durationMs,
          stdout: describeStream(stdout),
          stderr: describeStream(stderr),
          ...(capture.spawnError === undefined ? {} : { spawn_error: capture.spawnError }),
        } satisfies RunToolDetails,
        isError: isFailure(capture),
      };
    },
  };
}

export default function runToolExtension(pi: ExtensionAPI): void {
  pi.registerTool(createRunTool());
}
