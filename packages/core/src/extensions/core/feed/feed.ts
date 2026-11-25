/**
 * The two-stage shape behind the `feed` tool: one program's stdout becomes
 * another's stdin.
 *
 * The shell form is `from | to`, and the part a tool can own exactly is the
 * pipe. This module holds the refusals and the hand-off, not the spawning: both
 * stages run through `run-tool`'s executor, so the timeout, the process-group
 * kill, the abort path and the capture files are the same code for a piped
 * program as for a single one.
 *
 * Why the stream is materialised rather than streamed: `from` writes to a file
 * this process owns before `to` starts. A pipe between two live children would
 * need the reader and writer to make progress together, and a consumer that
 * exits early (a second `head`) would need the producer killed by SIGPIPE to
 * avoid a deadlock. Buffering the producer first removes both failure modes at
 * the cost of a byte ceiling, which is refused with the size named rather than
 * discovered as swap.
 */

import { readFileSync, statSync } from "node:fs";
import { findRefusal } from "../run-tool/run.js";
import type { RunContext } from "../run-tool/run.js";

/** The largest producer stream this tool holds before starting the consumer. */
export const MAX_FEED_BYTES = 32 * 1024 * 1024;

/** A validated `feed` call. */
export interface FeedRequest {
  /** The producer. */
  from: string[];
  /** The consumer. */
  to: string[];
  timeout_ms: number;
  max_output_bytes?: number;
}

/** Why a call never reached a program. */
export interface FeedRefusal {
  kind: string;
  message: string;
}

/**
 * Name the stage a shared refusal came from. The operator, glob and shell-string
 * refusals are `run-tool`'s; only the element index in the message needs to say
 * which of the two argv arrays carried it.
 */
function relabel(stage: "from" | "to", refusal: { kind: string; message: string }): FeedRefusal {
  return {
    kind: `${stage}-${refusal.kind}`,
    message: refusal.message.replace(/^refused: argv\[/, `refused: ${stage}[`),
  };
}

/** Both stages are refused before either starts, so a half-run pipe is not a state. */
export function findFeedRefusal(request: FeedRequest, context: RunContext): FeedRefusal | null {
  for (const stage of ["from", "to"] as const) {
    const refusal = findRefusal(
      {
        argv: request[stage],
        timeout_ms: request.timeout_ms,
        ...(request.max_output_bytes === undefined
          ? {}
          : { max_output_bytes: request.max_output_bytes }),
      },
      { ...context, toolName: "feed" },
    );
    if (refusal) return relabel(stage, refusal);
  }
  return null;
}

/** The producer's stream, or the refusal that says why it is not held. */
export function readFeedInput(
  path: string,
): { bytes: Buffer; refusal?: undefined } | { bytes?: undefined; refusal: FeedRefusal } {
  const size = statSync(path).size;
  if (size > MAX_FEED_BYTES) {
    return {
      refusal: {
        kind: "feed-input",
        message:
          `refused: from wrote ${size} bytes, past the ${MAX_FEED_BYTES}-byte limit this tool holds in memory before it ` +
          `starts the consumer. Send it to a file with sink and read that file, run a producer that writes less, or use bash if a live pipe is what you need.`,
      },
    };
  }
  return { bytes: readFileSync(path) };
}
