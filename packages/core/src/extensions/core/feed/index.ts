/**
 * feed — one program whose stdin is another program's stdout.
 *
 * The census behind this tool counted 14.7% of bash calls using command
 * substitution and the same pipe shape in multi-stage chains; `from | to` is the
 * two-stage form of it. Both programs are argv calls with no shell between
 * them: the producer runs first and its stdout is handed to the consumer's
 * stdin as bytes, so a stream that is not valid UTF-8 survives the hand-off.
 *
 * The consumer's exit is the answer this tool reports, which is what the shell
 * answers for a pipeline too; the producer's exit, its duration and the bytes it
 * wrote are reported beside it, so a producer that failed while the consumer
 * succeeded is visible rather than swallowed.
 *
 * Shape rules are `run`'s, held over two argv arrays: no shell, no glob, the
 * same cap and the same refusal text, with the stage named in the message. Both
 * stages are refused before either starts.
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
  offloadText,
} from "../run-tool/run.js";
import type { RunCapture, RunStream, StreamDetails } from "../run-tool/run.js";
import { findFeedRefusal, readFeedInput } from "./feed.js";

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

const feedParameters = Type.Object({
  from: Type.Array(Type.String(), {
    minItems: 1,
    description:
      "The producer: argv[0] is the executable whose stdout becomes the consumer's stdin.",
  }),
  to: Type.Array(Type.String(), {
    minItems: 1,
    description: "The consumer: argv[0] is the executable that reads that stream on its stdin.",
  }),
  cwd: Type.Optional(
    Type.String({
      description: "Working directory for both stages; relative to the session cwd.",
    }),
  ),
  env: Type.Optional(
    Type.Unsafe<Record<string, string>>({
      type: "object",
      additionalProperties: { type: "string" },
      description:
        "Environment overrides merged over the session environment for both stages. Nothing is removed.",
    }),
  ),
  timeout_ms: Type.Integer({
    minimum: 1,
    maximum: MAX_TIMEOUT_MS,
    description:
      "Required. Bounds each stage; a stage that outlives it is killed, and the pair answers with what it produced.",
  }),
  max_output_bytes: Type.Optional(
    Type.Integer({
      minimum: MIN_OUTPUT_BYTES,
      maximum: MAX_OUTPUT_BYTES,
      description: `Byte cap per consumer stream. Default ${DEFAULT_OUTPUT_BYTES}. Past the cap the head and tail are kept and the full text is written to a file named in the result.`,
    }),
  ),
});

export type FeedParameters = Static<typeof feedParameters>;

/** What one stage did, for the result. */
export interface StageDetails {
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  aborted: boolean;
  duration_ms: number;
  bytes: number;
  spawn_error?: string;
}

/** Structured result for rendering and scripts. */
export interface FeedToolDetails {
  /** Present when the call was refused before a program started. */
  refused?: string;
  cwd?: string;
  from?: StageDetails;
  to?: StageDetails;
  stdout?: StreamDetails;
  stderr?: StreamDetails;
  /** The producer's stderr, which the shell form would have shown unfolded. */
  from_stderr?: StreamDetails;
  /** Present when the consumer could not be started at all. */
  spawn_error?: string;
}

function numberLine(bytes: number): string {
  return bytes.toLocaleString("en-US");
}

/** One stage's outcome, in the words the result uses for it. */
function stageLine(label: "from" | "to", capture: RunCapture, argv: string[]): string {
  if (capture.spawnError !== undefined) {
    return `${label}: could not start ${argv[0]}: ${capture.spawnError}`;
  }
  if (capture.timedOut) return `${label}: timed out after ${capture.durationMs}ms: killed`;
  if (capture.aborted) return `${label}: aborted, killed after ${capture.durationMs}ms`;
  if (capture.signal !== null)
    return `${label}: killed by ${capture.signal} after ${capture.durationMs}ms`;
  return `${label}: exit ${capture.exitCode ?? "none"} · ${capture.durationMs}ms · ${numberLine(capture.stdoutBytes)} bytes out`;
}

function stageDetails(capture: RunCapture): StageDetails {
  return {
    exit_code: capture.exitCode,
    signal: capture.signal,
    timed_out: capture.timedOut,
    aborted: capture.aborted,
    duration_ms: capture.durationMs,
    bytes: capture.stdoutBytes,
    ...(capture.spawnError === undefined ? {} : { spawn_error: capture.spawnError }),
  };
}

/** Render one stream as a labelled section, with its truncation note. */
function renderStream(label: string, stream: RunStream): string {
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

/** The cap applied to one captured stream, with its offload when it overran. */
function bound(
  source: string,
  bytes: number,
  cap: number,
  offload: () => string | undefined,
): RunStream {
  const overran = bytes > cap;
  const offloaded = overran ? offload() : undefined;
  return boundStream(source, cap, offloaded ?? (overran ? source : undefined));
}

export function createFeedTool(): ToolDefinition<typeof feedParameters, FeedToolDetails> {
  return {
    name: "feed",
    label: "Feed",
    description:
      "Execute one program whose stdin is the stdout of another: the `from | to` shape, without a shell. from and to are argv arrays, run one after the other; the producer's stdout is handed to the consumer's stdin as bytes, so non-UTF-8 data survives. The consumer's exit code is the result's, and the producer's exit, duration and byte count are reported beside it. Both stages are refused before either starts: a shell metacharacter, a glob or a shell command string in either argv is refused with the stage and element named. A producer stream past the in-memory ceiling is refused with its size named. The consumer's streams are capped at max_output_bytes with the dropped bytes named and the full text in a file. timeout_ms is required and bounds each stage.",
    parameters: feedParameters,
    async execute(
      toolCallId: string,
      params: FeedParameters,
      signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback<FeedToolDetails> | undefined,
      ctx: ExtensionToolContext,
    ) {
      const sessionCwd = ctx.cwd;
      const workspaceRoot = sessionCwd;
      const cwd = resolve(sessionCwd, params.cwd ?? ".");
      const request = {
        from: params.from,
        to: params.to,
        timeout_ms: params.timeout_ms,
        ...(params.max_output_bytes === undefined
          ? {}
          : { max_output_bytes: params.max_output_bytes }),
      };
      const shared = {
        ...(params.cwd === undefined ? {} : { cwd: params.cwd }),
        ...(params.env === undefined ? {} : { env: params.env }),
        timeout_ms: params.timeout_ms,
      };

      if (!isDirectory(cwd)) {
        const message = `refused: cwd ${cwd} does not exist or is not a directory. A call is not run against a missing directory.`;
        return {
          content: [{ type: "text" as const, text: message }],
          details: { refused: "cwd", cwd } satisfies FeedToolDetails,
          isError: true,
        };
      }

      const refusal = findFeedRefusal(request, { cwd, workspaceRoot, toolName: "feed" });
      if (refusal) {
        return {
          content: [{ type: "text" as const, text: refusal.message }],
          details: { refused: refusal.kind, cwd } satisfies FeedToolDetails,
          isError: true,
        };
      }

      const sessionId = ctx.sessionManager?.getSessionId?.() ?? "anonymous";
      const producer = await executeArgv(
        { argv: params.from, ...shared },
        { cwd, workspaceRoot },
        signal,
      );

      // A producer that failed still has a stream, and a pipeline hands that
      // stream on; only an oversized one stops the pair here.
      const input = readFeedInput(capturePathFor(producer, "stdout"));
      let consumer: RunCapture | undefined;
      if (input.bytes !== undefined) {
        consumer = await executeArgv(
          { argv: params.to, ...shared, stdin: input.bytes },
          { cwd, workspaceRoot },
          signal,
        );
      }

      const cap = params.max_output_bytes ?? DEFAULT_OUTPUT_BYTES;
      const producerStderr = bound(
        capturePathFor(producer, "stderr"),
        producer.stderrBytes,
        cap,
        () =>
          offloadText(
            capturePathFor(producer, "stderr"),
            sessionId,
            toolCallId,
            "feed-from-stderr",
          ),
      );
      let stdout: RunStream | undefined;
      let stderr: RunStream | undefined;
      let fullTextMissing = false;
      if (consumer !== undefined) {
        stdout = bound(capturePathFor(consumer, "stdout"), consumer.stdoutBytes, cap, () => {
          const path = offloadText(
            capturePathFor(consumer, "stdout"),
            sessionId,
            toolCallId,
            "feed-stdout",
          );
          if (path === undefined) fullTextMissing = true;
          return path;
        });
        stderr = bound(capturePathFor(consumer, "stderr"), consumer.stderrBytes, cap, () => {
          const path = offloadText(
            capturePathFor(consumer, "stderr"),
            sessionId,
            toolCallId,
            "feed-stderr",
          );
          if (path === undefined) fullTextMissing = true;
          return path;
        });
      }
      if (producerStderr.truncated && producerStderr.fullTextPath === undefined) {
        fullTextMissing = true;
      }

      // A failed offload keeps its capture directory: the result names that
      // path, so it must still exist when the reader follows it.
      if (input.refusal === undefined && input.bytes !== undefined) discardCapture(producer);
      if (consumer !== undefined && !fullTextMissing) discardCapture(consumer);

      const sections: string[] = [];
      if (input.refusal !== undefined) {
        sections.push(input.refusal.message);
        sections.push(stageLine("from", producer, params.from));
      } else if (consumer !== undefined) {
        sections.push(stageLine("to", consumer, params.to));
        sections.push(stageLine("from", producer, params.from));
      } else {
        sections.push(stageLine("from", producer, params.from));
      }
      if (producerStderr.text !== "") sections.push(renderStream("from stderr", producerStderr));
      if (consumer !== undefined && stdout !== undefined) {
        if (stdout.text === "" && stderr !== undefined && stderr.text === "") {
          sections.push("(no output)");
        } else if (stdout.text !== "") {
          sections.push(renderStream("stdout", stdout));
        }
        if (stderr !== undefined && stderr.text !== "")
          sections.push(renderStream("stderr", stderr));
      }

      return {
        content: [{ type: "text" as const, text: sections.join("\n\n") }],
        details: {
          cwd,
          ...(input.refusal === undefined ? {} : { refused: input.refusal.kind }),
          from: stageDetails(producer),
          ...(consumer === undefined ? {} : { to: stageDetails(consumer) }),
          ...(stdout === undefined ? {} : { stdout: describeStream(stdout) }),
          ...(stderr === undefined ? {} : { stderr: describeStream(stderr) }),
          from_stderr: describeStream(producerStderr),
          ...(consumer?.spawnError === undefined ? {} : { spawn_error: consumer.spawnError }),
        } satisfies FeedToolDetails,
        isError: input.refusal !== undefined || (consumer !== undefined && isFailure(consumer)),
      };
    },
  };
}

export default function feedToolExtension(pi: ExtensionAPI): void {
  pi.registerTool(createFeedTool());
}
