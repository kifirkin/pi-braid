/**
 * The readers behind the `filter` tool: one program's stdout, reduced in this
 * process.
 *
 * The census that motivated this tool measured 58.6% of bash calls piped into
 * `head`, `tail` or `wc -l` and 18.2% piped into a filter. Those pipes start a
 * second program to read a file this process already has on disk, so the
 * reduction happens here instead: `head` stops reading after its line, `tail`
 * scans backwards from the end of the file, `grep` matches each line and counts
 * nothing it does not emit, and `wc -l` counts newline bytes.
 *
 * The readers are byte-oriented. Lines are split on `0x0a`, which no UTF-8
 * continuation byte can carry, so a split never lands inside a character and
 * the emitted bytes are the source bytes. Decoding to a string happens only
 * where the filter needs text: `grep` compiles its pattern and tests the
 * decoded line, while the bytes written are the ones read.
 *
 * What the shell form does and this does not, stated here rather than found
 * later:
 *   - `tail` reads backwards through the file, so its line count is exact at
 *     any file size; `head`, `grep` and `wc` stream forward and hold one chunk.
 *   - `grep` takes a JavaScript regular expression, not a basic one: `\(` and
 *     `\|` mean what they mean in JavaScript. Alternation is `|` as usual.
 *   - `wc -l` prints the bare count. BSD `wc` pads a single count to seven
 *     columns and GNU `wc` does not, so byte equality with the local `wc` is a
 *     property of that binary; the count is the portable part.
 */

import { closeSync, openSync, readSync, statSync, writeSync } from "node:fs";

/** How much of the source one syscall reads. */
const CHUNK = 64 * 1024;

/** The reductions this tool applies, in the order its schema names them. */
export const FILTERS = ["head", "tail", "grep", "wc"] as const;

export type FilterThrough = (typeof FILTERS)[number];

/** Lines `head` and `tail` keep when the call names none. */
export const DEFAULT_LINES = 10;

/** A line count the result can still be read under. */
export const MAX_LINES = 10_000;

/** A validated `filter` call. */
export interface FilterRequest {
  /** Which reduction to apply. */
  through: FilterThrough;
  /** The line pattern; read by `through: "grep"` only. */
  pattern?: string;
  /** Lines for `head` and `tail`, resolved from the schema's default. */
  lines: number;
  /**
   * Whether the caller passed the field. An argument the chosen filter cannot
   * read is refused rather than ignored, so this is what separates "left at its
   * default" from "passed and dropped".
   */
  explicit: { pattern: boolean; lines: boolean };
}

/** Why a call never reached a program. */
export interface FilterRefusal {
  kind: string;
  message: string;
}

/** What one reduction did, for the result line. */
export interface FilterOutcome {
  /** Lines the source held, as the reader saw them. */
  linesRead: number;
  /** Lines the filter kept (for `wc`, the number it prints). */
  linesWritten: number;
  /** Bytes written to the filtered stream. */
  bytesWritten: number;
  /** Whether the reader stopped before the end of the source (head, grep). */
  stoppedEarly: boolean;
}

/**
 * Everything wrong with a call that can be known before a program starts.
 *
 * The pattern is compiled here, not while reading: a pattern that does not
 * compile is a refusal, and a call refused here never starts a program whose
 * output nobody would read.
 */
export function findFilterRefusal(request: FilterRequest): FilterRefusal | null {
  if (!FILTERS.includes(request.through)) {
    return {
      kind: "through",
      message: `refused: through must be one of ${FILTERS.join(", ")}; got ${String(request.through)}.`,
    };
  }

  if (request.through === "grep") {
    if (!request.explicit.pattern) {
      return {
        kind: "pattern",
        message:
          'refused: through "grep" needs a pattern. Pass the line pattern in pattern, or choose head, tail or wc.',
      };
    }
    if (request.pattern === "") {
      return {
        kind: "pattern",
        message:
          "refused: pattern is empty. An empty pattern matches every line, which is what cat already does.",
      };
    }
    try {
      new RegExp(request.pattern ?? "");
    } catch (error) {
      return {
        kind: "pattern",
        message: `refused: pattern is not a regular expression: ${(error as Error).message}`,
      };
    }
  } else if (request.explicit.pattern) {
    return {
      kind: "pattern",
      message: `refused: pattern is only read by through "grep"; through "${request.through}" ignores it, so the call is refused rather than dropping an argument it cannot read.`,
    };
  }

  if (request.through === "wc") {
    if (request.explicit.lines) {
      return {
        kind: "lines",
        message:
          'refused: lines is only read by through "head" and "tail"; through "wc" counts every line, so the call is refused rather than dropping an argument it cannot read.',
      };
    }
  } else if (!Number.isInteger(request.lines) || request.lines < 1 || request.lines > MAX_LINES) {
    return {
      kind: "lines",
      message: `refused: lines must be an integer from 1 to ${MAX_LINES}; got ${String(request.lines)}.`,
    };
  }

  return null;
}

/** A buffered writer, so a match per line is not a syscall per line. */
class Writer {
  private readonly buffer: Buffer;
  private used = 0;
  private total = 0;

  constructor(private readonly fd: number) {
    this.buffer = Buffer.allocUnsafe(CHUNK);
  }

  push(bytes: Buffer): void {
    let offset = 0;
    while (offset < bytes.length) {
      const room = this.buffer.length - this.used;
      const take = Math.min(room, bytes.length - offset);
      bytes.copy(this.buffer, this.used, offset, offset + take);
      this.used += take;
      offset += take;
      if (this.used === this.buffer.length) this.flush();
    }
    this.total += bytes.length;
  }

  /** Bytes handed to `push`, which is what the filtered stream holds. */
  get written(): number {
    return this.total;
  }

  flush(): void {
    if (this.used === 0) return;
    let offset = 0;
    while (offset < this.used) {
      offset += writeSync(this.fd, this.buffer, offset, this.used - offset);
    }
    this.used = 0;
  }
}

const NEWLINE = 0x0a;
const NEWLINE_BYTES = Buffer.from("\n");

/** Join the carried remainder of a line with the bytes that complete it. */
function join(a: Buffer, b: Buffer): Buffer {
  if (a.length === 0) return Buffer.from(b);
  return Buffer.concat([a, b]);
}

/**
 * Read `source` forward, handing each line to `onLine` without its delimiter.
 * `onLine` returns false to stop the read.
 */
function scanLines(
  source: string,
  onLine: (line: Buffer, terminated: boolean) => boolean,
): { lines: number; stopped: boolean } {
  const fd = openSync(source, "r");
  const chunk: Buffer = Buffer.allocUnsafe(CHUNK);
  let carried: Buffer = Buffer.alloc(0);
  let lines = 0;
  let stopped = false;
  try {
    while (!stopped) {
      const read = readSync(fd, chunk, 0, CHUNK, null);
      if (read === 0) break;
      let start = 0;
      for (let index = 0; index < read; index++) {
        if (chunk[index] !== NEWLINE) continue;
        const line = join(carried, chunk.subarray(start, index));
        carried = Buffer.alloc(0);
        start = index + 1;
        lines += 1;
        if (!onLine(line, true)) {
          stopped = true;
          break;
        }
      }
      if (stopped) break;
      if (start < read) carried = join(carried, chunk.subarray(start, read));
    }
    // A final line with no newline is still a line: head keeps it, grep prints
    // it with the newline grep adds, and wc -l does not count it.
    if (!stopped && carried.length > 0) {
      lines += 1;
      onLine(carried, false);
    }
  } finally {
    closeSync(fd);
  }
  return { lines, stopped };
}

/** `head` and `grep` share the forward scan; only the predicate differs. */
function forwardFilter(
  source: string,
  output: Writer,
  request: FilterRequest,
  matcher: RegExp | null,
): FilterOutcome {
  let linesWritten = 0;
  let capped = false;

  const { lines, stopped } = scanLines(source, (line, terminated) => {
    if (request.through === "head") {
      if (linesWritten >= request.lines) {
        capped = true;
        return false;
      }
      output.push(line);
      if (terminated) output.push(NEWLINE_BYTES);
      linesWritten += 1;
      return true;
    }
    if (request.through === "grep") {
      if (matcher === null || !matcher.test(line.toString("utf8"))) return true;
      output.push(line);
      // grep terminates the line it prints, including a final line that had no
      // newline of its own.
      output.push(NEWLINE_BYTES);
      linesWritten += 1;
      return true;
    }
    // through "wc": count newline bytes, which is what `wc -l` counts.
    if (terminated) linesWritten += 1;
    return true;
  });

  if (request.through === "wc") {
    output.push(Buffer.from(`${linesWritten}\n`));
  }

  return {
    linesRead: lines,
    linesWritten,
    bytesWritten: output.written,
    stoppedEarly: stopped || capped,
  };
}

/**
 * `tail -n`: find the start of the last `lines` lines by scanning backwards for
 * newlines, then copy the byte range. Exact at any file size and it holds one
 * chunk, where a ring buffer would hold the lines themselves.
 */
function tailFilter(source: string, output: Writer, lines: number): FilterOutcome {
  const size = statSync(source).size;
  const fd = openSync(source, "r");
  const chunk = Buffer.allocUnsafe(CHUNK);
  let start = 0;
  try {
    // A newline at the very end terminates the last line; it is not an extra
    // empty line, so the backward scan starts before it.
    let scan = size - 1;
    if (scan >= 0) {
      const last = Buffer.allocUnsafe(1);
      readSync(fd, last, 0, 1, scan);
      if (last[0] === NEWLINE) scan -= 1;
    }
    let found = 0;
    let cursor = scan;
    while (cursor >= 0 && found < lines) {
      const from = Math.max(0, cursor - CHUNK + 1);
      const read = readSync(fd, chunk, 0, cursor - from + 1, from);
      for (let index = read - 1; index >= 0; index--) {
        if (chunk[index] !== NEWLINE) continue;
        found += 1;
        if (found === lines) {
          start = from + index + 1;
          break;
        }
      }
      if (found === lines) break;
      cursor = from - 1;
    }

    let linesWritten = 0;
    let lastByte = NEWLINE;
    let offset = start;
    while (offset < size) {
      const read = readSync(fd, chunk, 0, Math.min(CHUNK, size - offset), offset);
      if (read === 0) break;
      const slice = chunk.subarray(0, read);
      output.push(slice);
      for (const byte of slice) {
        if (byte === NEWLINE) linesWritten += 1;
      }
      lastByte = slice[read - 1];
      offset += read;
    }
    // A last line with no newline is a line the shell's tail also prints.
    if (size > 0 && lastByte !== NEWLINE) linesWritten += 1;

    return {
      linesRead: linesWritten,
      linesWritten,
      bytesWritten: output.written,
      stoppedEarly: false,
    };
  } finally {
    closeSync(fd);
  }
}

/** Apply `request` to `source`, writing the kept bytes to `output`. */
export function applyFilter(source: string, output: string, request: FilterRequest): FilterOutcome {
  const fd = openSync(output, "w");
  const writer = new Writer(fd);
  try {
    if (request.through === "tail") return tailFilter(source, writer, request.lines);
    const matcher = request.through === "grep" ? new RegExp(request.pattern ?? "") : null;
    return forwardFilter(source, writer, request, matcher);
  } finally {
    writer.flush();
    closeSync(fd);
  }
}
