/**
 * sink — one program, its stdout and stderr written to files.
 *
 * `run` returns both streams to the model; this tool writes them to disk, which
 * is the `producer > out 2> err` shape the census found in 15.9% of bash calls.
 * A stream that is redirected is not shown, and a stream that is not redirected
 * is shown under the same cap `run` applies; both destinations, and the byte
 * count written to each, are reported.
 *
 * The shape rules are `run`'s: no shell, no glob, the same argv refusals with
 * the element named, the destructive-verb guard on the argv, a required
 * timeout. The destinations are resolved against the tool's cwd before the
 * program starts, so a missing directory refuses the call rather than losing
 * the output.
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
  MAX_TIMEOUT_MS,
  boundStream,
  describeStream,
  discardCapture,
  executeArgv,
  findRefusal,
  offloadText,
} from "../run-tool/run.js";
import type { RunCapture, RunRequest, RunStream, StreamDetails } from "../run-tool/run.js";
import { planSink, writeSink } from "./sink.js";
import type { SinkRequest } from "./sink.js";

/** The cap on a stream this tool shows instead of writing. */
const SHOWN_CAP = DEFAULT_OUTPUT_BYTES;

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

const sinkParameters = Type.Object({
  argv: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "The program and its arguments, one element each. argv[0] is the executable. No shell: pipes, redirection, heredocs and $(...) are refused.",
  }),
  stdout_to: Type.Optional(
    Type.String({
      description:
        "File the program's stdout is written to; resolved against the tool's cwd. Absent means stdout is shown in the result instead.",
    }),
  ),
  stderr_to: Type.Optional(
    Type.String({
      description:
        "File the program's stderr is written to; resolved against the tool's cwd. Absent means stderr is shown in the result instead.",
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
});

export type SinkParameters = Static<typeof sinkParameters>;

/** Structured result for rendering and scripts. */
export interface SinkToolDetails {
  /** Present when the call was refused before a program started. */
  refused?: string;
  cwd?: string;
  exit_code?: number | null;
  signal?: string | null;
  timed_out?: boolean;
  aborted?: boolean;
  duration_ms?: number;
  stdout_path?: string;
  stderr_path?: string;
  stdout_bytes?: number;
  stderr_bytes?: number;
  /** The stream shown in the result; absent when that stream was redirected. */
  stdout?: StreamDetails;
  stderr?: StreamDetails;
  /** Present when the child could not be started at all. */
  spawn_error?: string;
}

function numberLine(bytes: number): string {
  return bytes.toLocaleString("en-US");
}

/** The one-line outcome, so a failure is readable before the output. */
function statusLine(params: SinkParameters, capture: RunCapture): string {
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

export function createSinkTool(): ToolDefinition<typeof sinkParameters, SinkToolDetails> {
  return {
    name: "sink",
    label: "Sink",
    description:
      "Execute one program with an argument list and write its stdout and/or stderr to files: the `producer > out 2> err` shape, without a shell. name stdout_to, stderr_to or both; the result reports each absolute path and the byte count written to it. A stream that is not redirected is shown instead, under the same cap run applies. Destinations are resolved against the tool's cwd before the program starts, so a missing directory refuses the call instead of losing the output, and two destinations that resolve to one path are refused. A shell metacharacter in any argv element is refused with the element named, globs are not expanded, and timeout_ms is required.",
    parameters: sinkParameters,
    async execute(
      toolCallId: string,
      params: SinkParameters,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<SinkToolDetails> | undefined,
      ctx: ExtensionToolContext,
    ) {
      const sessionCwd = ctx.cwd;
      const workspaceRoot = sessionCwd;
      const cwd = resolve(sessionCwd, params.cwd ?? ".");
      const request: RunRequest = {
        argv: params.argv,
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.env === undefined ? {} : { env: params.env }),
        timeout_ms: params.timeout_ms,
      };
      const targets: SinkRequest = {
        ...(params.stdout_to === undefined ? {} : { stdoutTo: params.stdout_to }),
        ...(params.stderr_to === undefined ? {} : { stderrTo: params.stderr_to }),
      };

      if (!isDirectory(cwd)) {
        const message = `refused: cwd ${cwd} does not exist or is not a directory. A call is not run against a missing directory.`;
        return {
          content: [{ type: "text" as const, text: message }],
          details: { refused: "cwd", cwd } satisfies SinkToolDetails,
          isError: true,
        };
      }

      const argvRefusal = findRefusal(request, { cwd, workspaceRoot, toolName: "sink" });
      if (argvRefusal) {
        return {
          content: [{ type: "text" as const, text: argvRefusal.message }],
          details: { refused: argvRefusal.kind, cwd } satisfies SinkToolDetails,
          isError: true,
        };
      }

      const { refusal, plan } = planSink(targets, cwd);
      if (refusal) {
        return {
          content: [{ type: "text" as const, text: refusal.message }],
          details: { refused: refusal.kind, cwd } satisfies SinkToolDetails,
          isError: true,
        };
      }

      const capture = await executeArgv(request, { cwd, workspaceRoot }, signal);
      const written = writeSink(plan, {
        stdout: capture.stdoutPath,
        stderr: capture.stderrPath,
      });
      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "anonymous";

      // Only a stream the call did not redirect is shown, and it is bounded by
      // the same cap and the same offload path as every other argv tool.
      const shown: { stdout?: RunStream; stderr?: RunStream } = {};
      let offloadFailed = false;
      for (const stream of ["stdout", "stderr"] as const) {
        if (plan[stream] !== undefined) continue;
        const bytes = stream === "stdout" ? capture.stdoutBytes : capture.stderrBytes;
        const source = stream === "stdout" ? capture.stdoutPath : capture.stderrPath;
        const offloaded =
          bytes > SHOWN_CAP
            ? offloadText(source, sessionId, toolCallId, `sink-${stream}`)
            : undefined;
        if (bytes > SHOWN_CAP && offloaded === undefined) offloadFailed = true;
        shown[stream] = boundStream(
          source,
          SHOWN_CAP,
          offloaded ?? (bytes > SHOWN_CAP ? source : undefined),
        );
      }
      // A failed offload keeps the capture directory: the result names that
      // path, so it must still exist when the reader follows it.
      if (!offloadFailed) discardCapture(capture);

      const sections = [statusLine(params, capture)];
      if (plan.stdout !== undefined) {
        sections.push(`stdout -> ${plan.stdout} (${numberLine(written.stdoutBytes ?? 0)} bytes)`);
      }
      if (plan.stderr !== undefined) {
        sections.push(`stderr -> ${plan.stderr} (${numberLine(written.stderrBytes ?? 0)} bytes)`);
      }
      for (const stream of ["stdout", "stderr"] as const) {
        const bounded = shown[stream];
        if (bounded !== undefined && bounded.text !== "")
          sections.push(renderStream(stream, bounded));
      }
      if (sections.length === 1) sections.push("(no output)");

      return {
        content: [{ type: "text" as const, text: sections.join("\n\n") }],
        details: {
          cwd: capture.cwd,
          exit_code: capture.exitCode,
          signal: capture.signal,
          timed_out: capture.timedOut,
          aborted: capture.aborted,
          duration_ms: capture.durationMs,
          ...(plan.stdout === undefined ? {} : { stdout_path: plan.stdout }),
          ...(plan.stderr === undefined ? {} : { stderr_path: plan.stderr }),
          ...(written.stdoutBytes === undefined ? {} : { stdout_bytes: written.stdoutBytes }),
          ...(written.stderrBytes === undefined ? {} : { stderr_bytes: written.stderrBytes }),
          ...(shown.stdout === undefined ? {} : { stdout: describeStream(shown.stdout) }),
          ...(shown.stderr === undefined ? {} : { stderr: describeStream(shown.stderr) }),
          ...(capture.spawnError === undefined ? {} : { spawn_error: capture.spawnError }),
        } satisfies SinkToolDetails,
        isError: isFailure(capture),
      };
    },
  };
}

export default function sinkToolExtension(pi: ExtensionAPI): void {
  pi.registerTool(createSinkTool());
}
