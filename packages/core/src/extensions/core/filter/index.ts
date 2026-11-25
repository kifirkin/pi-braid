/**
 * filter — one program and one in-process reduction of its stdout.
 *
 * `run` refuses a pipe because a pipe is a shell program. This tool is the
 * half of that shape a tool can own exactly: one program, and a reader over its
 * output. The census behind it measured 58.6% of bash calls piped into
 * `head`/`tail`/`wc -l` and 18.2% piped into a filter, so the reduction happens
 * in this process over the capture file rather than by starting a second
 * program, and the program's bytes are never decoded unless the filter needs
 * text.
 *
 * The shape rules are the ones `run` already holds: no shell (a metacharacter
 * in any argv element is refused with the element named), no glob expansion,
 * one answer for the output cap (`boundStream` and the constants are imported,
 * not re-implemented), and the destructive-verb guard applied to the argv.
 *
 * What this reports is the producer's exit code, where the shell form of the
 * same pipeline reports the filter's. A producer that failed stays visible.
 */

import { statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
} from "../run-tool/run.js";
import type { RunCapture, RunRequest, RunStream, StreamDetails } from "../run-tool/run.js";
import { DEFAULT_LINES, FILTERS, MAX_LINES, applyFilter, findFilterRefusal } from "./filter.js";
import type { FilterOutcome, FilterThrough } from "./filter.js";

/** Whether a path is a directory, with a missing path answering false. */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    // A path that cannot be stat'd is not a directory this call can run in; the
    // refusal names it, which is more useful than the errno.
    return false;
  }
}

const filterParameters = Type.Object({
  argv: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "The program and its arguments, one element each. argv[0] is the executable. No shell: pipes, redirection, heredocs and $(...) are refused.",
  }),
  through: Type.String({
    enum: [...FILTERS],
    description:
      'Which reduction to apply to the program\'s stdout: "head" keeps the first lines, "tail" the last, "grep" the lines matching pattern, "wc" counts lines.',
  }),
  pattern: Type.Optional(
    Type.String({
      description:
        'The line pattern, read by through: "grep" only; a JavaScript regular expression, not a basic one.',
    }),
  ),
  lines: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: MAX_LINES,
      description: `Lines "head" and "tail" keep. Default ${DEFAULT_LINES}; "wc" counts every line and refuses this.`,
    }),
  ),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory; relative to the session cwd. Defaults to the session cwd.",
    }),
  ),
  env: Type.Optional(
    Type.Unsafe<Record<string, string>>({
      type: "object",
      additionalProperties: { type: "string" },
      description: "Environment overrides merged over the session environment. Nothing is removed.",
    }),
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

export type FilterParameters = Static<typeof filterParameters>;

/** Structured result for rendering and scripts. */
export interface FilterToolDetails {
  /** Present when the call was refused before a program started. */
  refused?: string;
  cwd?: string;
  exit_code?: number | null;
  signal?: string | null;
  timed_out?: boolean;
  aborted?: boolean;
  duration_ms?: number;
  through?: FilterThrough;
  pattern?: string;
  lines?: number;
  lines_read?: number;
  lines_kept?: number;
  stdout?: StreamDetails;
  stderr?: StreamDetails;
  /** Present when the child could not be started at all. */
  spawn_error?: string;
}

function numberLine(bytes: number): string {
  return bytes.toLocaleString("en-US");
}

/** The one-line outcome, so a failure is readable before the output. */
function statusLine(params: FilterParameters, capture: RunCapture): string {
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

/** What the reduction kept, and out of how much it read. */
function filterLine(
  request: { through: FilterThrough; pattern?: string; lines: number },
  outcome: FilterOutcome,
): string {
  const bytes = `${numberLine(outcome.bytesWritten)} bytes`;
  if (request.through === "wc") {
    return `through wc -l: counted ${numberLine(outcome.linesWritten)} lines (${bytes})`;
  }
  if (request.through === "grep") {
    return `through grep /${request.pattern ?? ""}/: kept ${numberLine(outcome.linesWritten)} of ${numberLine(outcome.linesRead)} lines (${bytes})`;
  }
  // head stops at its line, so the lines it did not read are not a denominator.
  return `through ${request.through}: kept ${numberLine(outcome.linesWritten)} lines (${bytes})`;
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

/** Whether the call is an error for the model: a refusal, a timeout, or a non-zero exit. */
function isFailure(capture: RunCapture): boolean {
  return (
    capture.spawnError !== undefined ||
    capture.timedOut ||
    capture.aborted ||
    capture.exitCode !== 0
  );
}

export function createFilterTool(): ToolDefinition<typeof filterParameters, FilterToolDetails> {
  return {
    name: "filter",
    label: "Filter",
    description:
      "Execute one program with an argument list and apply one in-process filter to its stdout: head, tail, grep or wc -l. Use instead of `producer | head`, `producer | tail`, `producer | grep pattern` and `producer | wc -l`. The filter is a reader over the program's own output, not a second program: no shell runs, and a shell metacharacter in any argv element is refused with the element named. The program's exit code is the result's; its stderr is returned beside the filtered stream, and both are capped at max_output_bytes with the dropped bytes named and the full text in a file. grep takes a JavaScript regular expression, not a basic one. timeout_ms is required, and a program that outlives it is killed.",
    parameters: filterParameters,
    async execute(
      toolCallId: string,
      params: FilterParameters,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<FilterToolDetails> | undefined,
      ctx: ExtensionToolContext,
    ) {
      const sessionCwd = ctx.cwd;
      const workspaceRoot = sessionCwd;
      const cwd = resolve(sessionCwd, params.cwd ?? ".");
      const lines = params.lines ?? DEFAULT_LINES;
      const request = {
        through: params.through as FilterThrough,
        ...(params.pattern === undefined ? {} : { pattern: params.pattern }),
        lines,
        explicit: { pattern: params.pattern !== undefined, lines: params.lines !== undefined },
      };
      const shaped: RunRequest = {
        argv: params.argv,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.env === undefined ? {} : { env: params.env }),
        timeout_ms: params.timeout_ms,
        ...(params.max_output_bytes === undefined
          ? {}
          : { max_output_bytes: params.max_output_bytes }),
      };

      if (!isDirectory(cwd)) {
        const message = `refused: cwd ${cwd} does not exist or is not a directory. A call is not run against a missing directory.`;
        return {
          content: [{ type: "text" as const, text: message }],
          details: { refused: "cwd", cwd } satisfies FilterToolDetails,
          isError: true,
        };
      }

      const refused = findFilterRefusal(request);
      if (refused) {
        return {
          content: [{ type: "text" as const, text: refused.message }],
          details: { refused: refused.kind, cwd } satisfies FilterToolDetails,
          isError: true,
        };
      }

      const argvRefusal = findRefusal(shaped, { cwd, workspaceRoot, toolName: "filter" });
      if (argvRefusal) {
        return {
          content: [{ type: "text" as const, text: argvRefusal.message }],
          details: { refused: argvRefusal.kind, cwd } satisfies FilterToolDetails,
          isError: true,
        };
      }

      const capture = await executeArgv(shaped, { cwd, workspaceRoot }, signal);
      const cap = params.max_output_bytes ?? DEFAULT_OUTPUT_BYTES;
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "anonymous";

      // The filtered stream is a second file in the same capture directory, so
      // one cleanup owns both the program's output and its reduction.
      const filteredPath = join(dirname(capture.stdoutPath), "filtered");
      const outcome =
        capture.spawnError === undefined
          ? applyFilter(capture.stdoutPath, filteredPath, request)
          : { linesRead: 0, linesWritten: 0, bytesWritten: 0, stoppedEarly: false };
      const filteredBytes = statSize(filteredPath);
      const filteredOffload =
        filteredBytes > cap
          ? offloadText(filteredPath, sessionId, toolCallId, "filter-stdout")
          : undefined;
      const stdout = boundStream(
        filteredPath,
        cap,
        filteredOffload ?? (filteredBytes > cap ? filteredPath : undefined),
      );
      const stderrOffload =
        capture.stderrBytes > cap
          ? offloadText(capturePathFor(capture, "stderr"), sessionId, toolCallId, "filter-stderr")
          : undefined;
      const stderr = boundStream(
        capture.stderrPath,
        cap,
        stderrOffload ?? (capture.stderrBytes > cap ? capture.stderrPath : undefined),
      );
      const offloadFailed =
        (filteredBytes > cap && filteredOffload === undefined) ||
        (capture.stderrBytes > cap && stderrOffload === undefined);
      // A failed offload keeps the capture directory: the result names that
      // path, so it must still exist when the reader follows it.
      if (!offloadFailed) discardCapture(capture);

      const sections = [statusLine(params, capture)];
      if (capture.spawnError === undefined) {
        sections.push(
          filterLine(
            {
              through: request.through,
              ...(request.pattern === undefined ? {} : { pattern: request.pattern }),
              lines: request.lines,
            },
            outcome,
          ),
        );
      }
      if (stdout.text === "" && stderr.text === "") {
        sections.push("(no output)");
      } else {
        if (stdout.text !== "" || request.through === "wc" || request.through === "grep")
          sections.push(renderStream("stdout", stdout));
        if (stderr.text !== "") sections.push(renderStream("stderr", stderr));
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n\n") }],
        details: {
          cwd: capture.cwd,
          exit_code: capture.exitCode,
          signal: capture.signal,
          timed_out: capture.timedOut,
          aborted: capture.aborted,
          duration_ms: capture.durationMs,
          through: request.through,
          ...(request.pattern === undefined ? {} : { pattern: request.pattern }),
          ...(request.through === "head" || request.through === "tail"
            ? { lines: request.lines }
            : {}),
          lines_read: outcome.linesRead,
          lines_kept: outcome.linesWritten,
          stdout: describeStream(stdout),
          stderr: describeStream(stderr),
          ...(capture.spawnError === undefined ? {} : { spawn_error: capture.spawnError }),
        } satisfies FilterToolDetails,
        isError: isFailure(capture),
      };
    },
  };
}

/** A file's size, with a missing file answering zero. */
function statSize(file: string): number {
  try {
    return statSync(file).size;
  } catch {
    // The filtered file is written by this call and read back here; a vanished
    // file reads as empty output rather than failing the result.
    return 0;
  }
}

export default function filterToolExtension(pi: ExtensionAPI): void {
  pi.registerTool(createFilterTool());
}
