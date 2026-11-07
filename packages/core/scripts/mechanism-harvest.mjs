#!/usr/bin/env node
/**
 * mechanism-harvest.mjs - find repair-shaped windows in pi session logs.
 *
 * A candidate is a run of consecutive events in one session that has the shape
 * of a repair, and the shape is the whole test: no word list appears anywhere
 * below, so a change in phrasing cannot change what the instrument finds.
 *
 *   1. FAILURE. A tool result that failed: the harness flagged it (`isError`),
 *      the command printed a non-zero exit code, or an exception signature is
 *      in the result text. A naked `Error:` counts only where a program's own
 *      output would carry it: any result for `bash`, and the tool-level error
 *      line of `read` / `edit` / `write`, whose first line is where the
 *      harness prints its own refusal.
 *   2. MUTATION. Inside the next N events (default 8): an `edit`, a `write`,
 *      or a `bash` command that changes a file. The target path is read from
 *      the event's own arguments - the edit/write `path`, or the operand of a
 *      redirect, `cp`, `mv`, `rm`, `touch`, `tee`, `sed -i`, or an interpreter
 *      call that opens a named file for writing. Nothing is inferred from the
 *      session's other events.
 *   3. SHARED TOKEN. The failing text names the mutation's target, or carries
 *      a symbol the mutation's own text carries too:
 *
 *        path   - the full target path, a two-segment suffix of it, or its
 *                 basename when that is at least five characters;
 *        symbol - an identifier of four characters or more that carries an
 *                 interior capital, an underscore join, or a digit, is not a
 *                 hexadecimal digest, and appears in the failing text and in
 *                 the mutation's own text. That text is an `edit`'s old text
 *                 (the region the repair replaced) or a `bash` command line.
 *                 A `write`'s new content is excluded: a fresh file mentions
 *                 many symbols, so a match there is a coincidence, not a link.
 *
 * WHAT THE TOKEN RULE CANNOT SEE, stated here because it is the rule's edge
 * and not a defect to be patched case by case: the link it can check is
 * textual, so a repair whose failure names a SYMBOL and whose mutation names
 * only the FILE that defines that symbol has no shared token, and the window
 * is dropped. Test logs are the usual shape of that miss, because a test name
 * carries the symbol while the repair carries the path. A rule that recovered
 * those windows would have to read the mutated file, or index symbol-to-path
 * bindings earlier in the session, and both change what the instrument is.
 *
 * The instrument emits a window and nothing else. Naming the mechanism is the
 * judge's job, and this script has no model call, no write, and no memory
 * surface.
 *
 * Usage:
 *   node packages/core/scripts/mechanism-harvest.mjs
 *   node packages/core/scripts/mechanism-harvest.mjs --sessions <dir|file|glob>
 *     [--since <iso>] [--window <n>] [--limit <n>] [--json]
 *
 * Census, in the printed table's own terms: files read, events read, failing
 * events found, windows emitted, windows collapsed into an earlier window, and
 * a count for each of the three reasons a window was dropped (no mutation
 * inside the window, no shared token, window too large to be a repair). The
 * three drop counts plus the emitted and collapsed windows account for every
 * failing event exactly once, so the line can be audited by addition.
 *
 * Exit codes: 0 a run completed; 2 bad usage.
 */
import { globSync, readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

/** Events after a failure in which its mutation may sit. */
const DEFAULT_WINDOW = 8;

/**
 * A window carrying more material than this is not a repair excerpt a reader
 * could check: the failure and the fix belong together, and a screen of output
 * between them says the two are unrelated or that the session dumped a log
 * between them. The number is roughly one long tool result.
 */
const MAX_WINDOW_CHARS = 60000;

/** Characters of one event in the rendered window, and of the whole record. */
const ENTRY_CHARS = 700;
const RECORD_CHARS = 7000;

/** pi writes a compaction snapshot under this directory name. */
const ARCHIVE_DIR = "archives";

const TOOL_RESULT_ROLES = new Set(["toolResult", "bashExecution"]);

/**
 * Error marker shapes. Each one is a shape a program or the harness prints,
 * never a word about the work: a non-zero exit, an exception class, a Python
 * traceback header, or the harness's own `Error:` refusal.
 */
const EXIT_CODE =
  /(?:\b[A-Z][A-Z0-9_]*_EXIT=([1-9]\d*)|\bEXIT=([1-9]\d*)|\bCommand exited with code\s+([1-9]\d*)|\bexit code\s+([1-9]\d*))/;
const EXCEPTION_LINE = /^\s*(?:[A-Za-z_]*Error(?:\s*\[[A-Z_]+\])?:|Traceback \(most recent call last\):)/m;
const EXCEPTION_TOKEN = /\b(?:SyntaxError|TypeError|ReferenceError|RangeError|AssertionError|ERR_[A-Z0-9_]+)\b/;

/** Identifier-shaped token: the symbol arm's candidate pool. */
const SYMBOL = /\b[A-Za-z_][A-Za-z0-9_]{3,}\b/g;

/** Shell tools whose last operand is the file they change. */
const LAST_OPERAND_WRITERS = new Set(["cp", "mv", "rm", "touch", "install"]);

const USAGE = `usage: node packages/core/scripts/mechanism-harvest.mjs [options]

  --sessions <dir|file|glob>  session corpus to read (default: pi's session root)
                              a directory is walked, pruning compaction snapshots
  --since <iso>               keep sessions whose recorded start is at or after
  --window <n>                events after a failure to search for its mutation
  --limit <n>                 stop after n windows are emitted
  --json                      print the report as one JSON object
  -h, --help                  this message

Exit codes: 0 a run completed; 2 bad usage.`;

// ---------------------------------------------------------------- input

function parseArgs(argv) {
  const opts = {
    sessions: join(homedir(), ".pi", "agent", "sessions"),
    since: null,
    window: DEFAULT_WINDOW,
    limit: 0,
    json: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (flag === "-h" || flag === "--help") {
      process.stdout.write(`${USAGE}\n`);
      process.exit(0);
    } else if (flag === "--json") {
      opts.json = true;
    } else if (flag === "--sessions" && value) {
      opts.sessions = value;
      i += 1;
    } else if (flag === "--since" && value) {
      const parsed = Date.parse(value);
      if (Number.isNaN(parsed)) usageError(`--since is not an ISO-8601 instant: ${value}`);
      opts.since = parsed;
      i += 1;
    } else if (flag === "--window" && value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) usageError(`--window wants a positive integer: ${value}`);
      opts.window = parsed;
      i += 1;
    } else if (flag === "--limit" && value) {
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 1) usageError(`--limit wants a positive integer: ${value}`);
      opts.limit = parsed;
      i += 1;
    } else {
      usageError(`unknown option ${flag}`);
    }
  }
  return opts;
}

function usageError(message) {
  process.stderr.write(`mechanism-harvest: ${message}\n\n${USAGE}\n`);
  process.exit(2);
}

/** Session files under a directory, sorted, with compaction snapshots pruned. */
function walkSessions(root) {
  const files = [];
  let prunedDirs = 0;
  let prunedFiles = 0;
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ARCHIVE_DIR) {
          prunedDirs += 1;
          prunedFiles += countJsonl(full);
          continue;
        }
        stack.push(full);
      } else if (entry.name.endsWith(".jsonl")) {
        files.push(full);
      }
    }
  }
  files.sort();
  return { files, prunedDirs, prunedFiles };
}

/** Count the session files under one directory, without following the walk. */
function countJsonl(dir) {
  let n = 0;
  const stack = [dir];
  while (stack.length) {
    const here = stack.pop();
    let entries;
    try {
      entries = readdirSync(here, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(here, entry.name));
      else if (entry.name.endsWith(".jsonl")) n += 1;
    }
  }
  return n;
}

/** Resolve a --sessions value to a sorted file list. */
function resolveCorpus(value) {
  const target = resolve(value);
  let stats;
  try {
    stats = statSync(target);
  } catch {
    stats = null;
  }
  if (stats?.isFile()) return { files: [target], prunedDirs: 0, prunedFiles: 0 };
  if (stats?.isDirectory()) return walkSessions(target);
  if (/[*?[{]/.test(value)) {
    const files = globSync(value, { withFileTypes: false })
      .map((file) => resolve(file))
      .filter((file) => file.endsWith(".jsonl"))
      .sort();
    return { files, prunedDirs: 0, prunedFiles: 0 };
  }
  usageError(`--sessions names nothing readable: ${value}`);
  return { files: [], prunedDirs: 0, prunedFiles: 0 };
}

const DECODER = new TextDecoder("utf-8", { fatal: true });

/** Text of a message content field, whichever shape it holds. */
function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const part of content) {
    if (part && typeof part.text === "string") parts.push(part.text);
  }
  return parts.join("\n");
}

/**
 * The events of one session file, in file order, plus what the read had to
 * skip. A line is decoded on its own so an invalid byte sequence costs one
 * line rather than the file, and the count of those lines is a census number
 * rather than a silent gap.
 */
function readSession(file) {
  const buffer = readFileSync(file);
  const events = [];
  const meta = { id: "", start: null, cwd: "" };
  let nonUtf8 = 0;
  let unparsed = 0;
  let lineNo = 0;
  let from = 0;
  for (let i = 0; i <= buffer.length; i += 1) {
    if (i < buffer.length && buffer[i] !== 0x0a) continue;
    const slice = buffer.subarray(from, i);
    from = i + 1;
    lineNo += 1;
    if (slice.length === 0) continue;
    let text;
    try {
      text = DECODER.decode(slice);
    } catch {
      nonUtf8 += 1;
      continue;
    }
    if (lineNo === 1) text = text.replace(/^\uFEFF/, "");
    if (!text.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(text);
    } catch {
      unparsed += 1;
      continue;
    }
    if (entry.type === "session") {
      meta.id = entry.id || meta.id;
      meta.start = entry.timestamp || meta.start;
      meta.cwd = entry.cwd || meta.cwd;
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message || {};
    const role = message.role || "";
    if (!role) continue;
    const calls = [];
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || part.type !== "toolCall" || typeof part.name !== "string") continue;
        calls.push({ name: part.name, args: part.arguments || {} });
      }
    }
    const text2 = textOf(message.content) || (typeof message.output === "string" ? message.output : "");
    events.push({
      index: events.length,
      line: lineNo,
      role,
      toolName: message.toolName || (role === "bashExecution" ? "bash" : ""),
      isError: message.isError === true || (typeof message.exitCode === "number" && message.exitCode !== 0),
      text: text2,
      calls,
      callsChars: calls.length ? JSON.stringify(calls).length : 0,
      ts: message.timestamp || entry.timestamp || "",
    });
  }
  return { events, meta, nonUtf8, unparsed };
}

// ---------------------------------------------------------------- shape tests

/** Whether a result event failed, and the marker that said so. */
function failureOf(event) {
  if (!TOOL_RESULT_ROLES.has(event.role)) return null;
  if (event.isError) return { kind: "isError" };
  if (event.toolName && event.toolName !== "bash" && event.toolName !== "") {
    // A non-executing tool prints its own refusal on the first line; a match
    // further down is the file's content, not a failure.
    const first = event.text.split("\n").find((line) => line.trim());
    if (first && EXCEPTION_LINE.test(first)) return { kind: "exception" };
    return null;
  }
  if (EXIT_CODE.test(event.text)) return { kind: "exit" };
  if (EXCEPTION_LINE.test(event.text) || EXCEPTION_TOKEN.test(event.text)) return { kind: "exception" };
  return null;
}

/**
 * The line of a failure that carries the marker, for the record. An exit
 * status stands alone on its line, so when that is the only marker the line
 * above it is the diagnostic a reader wants, not the status.
 */
function errorLine(text) {
  const lines = text.split("\n").filter((line) => line.trim());
  if (!lines.length) return "";
  const marked = lines.findIndex(
    (line) => EXIT_CODE.test(line) || EXCEPTION_LINE.test(line) || EXCEPTION_TOKEN.test(line),
  );
  let chosen = lines[marked === -1 ? 0 : marked];
  const statusOnly =
    !EXCEPTION_LINE.test(chosen) && !EXCEPTION_TOKEN.test(chosen) && EXIT_CODE.test(chosen);
  if (statusOnly && marked > 0) chosen = lines[marked - 1];
  return chosen.replace(/\s+/g, " ").trim().slice(0, 240);
}

/**
 * Split a shell command into stages of tokens. Quoting is honoured so a `sed`
 * script holding spaces stays one token, a redirect is split from its target
 * (`>x` and `> x` read alike), and a heredoc body is dropped: it is content a
 * command writes, not operands the shell runs, so a comparison inside a
 * script (`n > 0`) never reads as a redirect to a file named `0`.
 */
function shellStages(command) {
  const stages = [];
  let tokens = [];
  let current = "";
  let heredoc = null;
  const flushToken = () => {
    if (current) tokens.push(current);
    current = "";
  };
  const flushStage = () => {
    flushToken();
    if (tokens.length) stages.push(tokens.slice());
    tokens = [];
  };
  for (const line of command.split("\n")) {
    if (heredoc !== null) {
      const trimmed = line.trim();
      if (trimmed === heredoc || trimmed === heredoc.replace(/^['"]|['"]$/g, "")) heredoc = null;
      continue;
    }
    let quote = "";
    for (let i = 0; i < line.length; i += 1) {
      const ch = line[i];
      if (quote) {
        if (ch === quote) quote = "";
        else if (ch === "\\" && quote === '"' && i + 1 < line.length) {
          current += line[i + 1];
          i += 1;
        } else current += ch;
        continue;
      }
      if (ch === "'" || ch === '"') {
        quote = ch;
        continue;
      }
      if (ch === ">") {
        flushToken();
        if (line[i + 1] === ">") {
          tokens.push(">>");
          i += 1;
        } else tokens.push(">");
        continue;
      }
      if (/\s/.test(ch)) {
        flushToken();
        continue;
      }
      if (ch === "|" || ch === ";" || ch === "&") {
        flushStage();
        continue;
      }
      current += ch;
    }
    flushToken();
    const opener = /<<-?\s*(['"]?)([A-Za-z_][\w]*)\1/.exec(line);
    if (opener) heredoc = opener[2];
    flushStage();
  }
  flushStage();
  return stages;
}

/** Whether a token names a file a command could be said to change. */
function looksLikePath(token) {
  if (!token || token.length < 2) return false;
  if (/^\.+$/.test(token)) return false;
  if (token.startsWith("&") || token.includes("/dev/null") || token.includes("/dev/fd")) return false;
  return /[/.~$]/.test(token);
}

/**
 * Paths a command changes, read from its own operands. Every rule below names
 * a shell construct that writes a named file, so a command that only reads
 * yields nothing, and a file the command merely mentions as an argument to
 * something else is not a target.
 */
function bashTargets(command) {
  const targets = new Set();
  for (const stage of shellStages(command)) {
    const tokens = stage;
    for (let k = 0; k < tokens.length - 1; k += 1) {
      if (tokens[k] !== ">" && tokens[k] !== ">>") continue;
      if (looksLikePath(tokens[k + 1])) targets.add(tokens[k + 1]);
    }
    if (!tokens.length) continue;
    const head = basename(tokens[0]);
    if (head === "sed" && tokens.some((token) => /^-[A-Za-z]*i/.test(token))) {
      const operand = tokens.filter((token) => !token.startsWith("-")).at(-1);
      if (operand && operand !== "sed" && looksLikePath(operand)) targets.add(operand);
    } else if (head === "tee") {
      for (const operand of tokens.slice(1).filter((token) => !token.startsWith("-"))) {
        if (looksLikePath(operand)) targets.add(operand);
      }
    } else if (LAST_OPERAND_WRITERS.has(head)) {
      const operand = tokens
        .slice(1)
        .filter((token) => !token.startsWith("-"))
        .at(-1);
      if (operand && looksLikePath(operand)) targets.add(operand);
    }
  }
  // A heredoc body is not shell operands, but an interpreter writing a named
  // file inside it does create that file, with the path spelled in the command.
  for (const match of command.matchAll(/\bopen\(\s*["']([^"']+)["']\s*,\s*["'][wa]/g)) {
    if (looksLikePath(match[1])) targets.add(match[1]);
  }
  for (const match of command.matchAll(/\bwriteFileSync\(\s*["']([^"']+)["']/g)) {
    if (looksLikePath(match[1])) targets.add(match[1]);
  }
  return [...targets];
}

/** Every file-changing call in one event, with the text the symbol arm reads. */
function mutationsOf(event) {
  const out = [];
  for (const call of event.calls) {
    const args = call.args || {};
    if (call.name === "edit" && typeof args.path === "string") {
      const edits = Array.isArray(args.edits) ? args.edits : [];
      const old = edits.map((edit) => String((edit && edit.oldText) || "")).join("\n");
      out.push({ tool: "edit", target: args.path, text: old });
    } else if (call.name === "write" && typeof args.path === "string") {
      // A write's new content is not read by the symbol arm; see the header.
      out.push({ tool: "write", target: args.path, text: "" });
    } else if (call.name === "bash" && typeof args.command === "string") {
      for (const target of bashTargets(args.command))
        out.push({ tool: "bash", target, text: args.command });
    }
  }
  return out;
}

// ---------------------------------------------------------------- the link

/** A symbol, by shape: interior capital, underscore join, or an embedded digit. */
function isSymbol(token) {
  return /[a-z][A-Z]/.test(token) || token.includes("_") || /\d/.test(token);
}

/** A hexadecimal digest names a revision, not a symbol. */
function isDigest(token) {
  return /^[0-9a-f]{7,}$/i.test(token);
}

/** A path the failing text names, with the strength of the match. */
function pathLink(text, target) {
  if (!target) return null;
  if (text.includes(target)) return { kind: "path", text: target, rank: 4 };
  const segments = target.split("/").filter(Boolean);
  for (let depth = 2; depth >= 1; depth -= 1) {
    if (depth >= segments.length) continue;
    const suffix = segments.slice(-depth).join("/");
    if (depth === 1 && suffix.length < 5) continue;
    if (text.includes(suffix)) return { kind: "path", text: suffix, rank: depth === 2 ? 3 : 2 };
  }
  return null;
}

/**
 * The token the failure and the mutation share, with the strength of the link:
 * a path both sides spell out outranks a shortened path, which outranks a
 * symbol both sides mention. The rank is what picks among the files a single
 * command changes.
 */
function sharedToken(failureText, mutation) {
  const byPath = pathLink(failureText, mutation.target);
  if (byPath) return byPath;
  if (!mutation.text) return null;
  for (const match of failureText.matchAll(SYMBOL)) {
    const token = match[0];
    if (!isSymbol(token) || isDigest(token)) continue;
    if (mutation.text.includes(token)) return { kind: "symbol", text: token, rank: 1 };
  }
  return null;
}

// ---------------------------------------------------------------- windows

/** The target as a path on this machine, for a census that can check it exists. */
function absoluteTarget(cwd, target) {
  const expanded = target.startsWith("~/") ? join(homedir(), target.slice(2)) : target;
  return resolve(cwd || ".", expanded);
}

/** Characters of raw material a window holds, before rendering. */
function windowChars(events, from, to) {
  let total = 0;
  for (let k = from; k <= to; k += 1) total += events[k].text.length + events[k].callsChars;
  return total;
}

/** Render the window: calls first, so the mutation's own arguments are visible. */
function renderWindow(events, from, to) {
  const lines = [];
  for (let k = from; k <= to; k += 1) {
    const event = events[k];
    const head = `[${k}] ${event.role}${event.toolName ? ` ${event.toolName}` : ""}${
      event.isError ? " isError" : ""
    }`;
    for (const call of event.calls) {
      const args = JSON.stringify(call.args || {}).replace(/\s+/g, " ");
      lines.push(`${head} call ${call.name} ${args.slice(0, ENTRY_CHARS)}`);
    }
    const text = event.text.replace(/\s+/g, " ").trim();
    if (text) lines.push(`${head} ${text.slice(0, ENTRY_CHARS)}`);
  }
  const out = lines.join("\n");
  return out.length > RECORD_CHARS ? `${out.slice(0, RECORD_CHARS)}\n[window truncated]` : out;
}

/**
 * Repair-shaped windows in one session: one per failure that has a mutation
 * with a shared token inside its own window, with windows that overlap a kept
 * window by more than half of the later window's own span collapsed into the
 * earlier one (the same repair seen from two failures is one repair).
 */
function harvestSession(session, events, windowSize) {
  const stats = { failing: 0, droppedNoMutation: 0, droppedNoToken: 0, droppedTooLarge: 0, collapsed: 0 };
  const found = [];
  for (let i = 0; i < events.length; i += 1) {
    const failure = failureOf(events[i]);
    if (!failure) continue;
    stats.failing += 1;
    let pending = "no_mutation";
    for (let j = i + 1; j <= Math.min(i + windowSize, events.length - 1); j += 1) {
      const mutations = mutationsOf(events[j]);
      if (!mutations.length) continue;
      let linked = null;
      for (const mutation of mutations) {
        const token = sharedToken(events[i].text, mutation);
        if (!token) continue;
        if (!linked || token.rank > linked.token.rank) linked = { mutation, token };
      }
      if (!linked) {
        pending = "no_shared_token";
        continue;
      }
      if (windowChars(events, i, j) > MAX_WINDOW_CHARS) {
        pending = "window_too_large";
        break;
      }
      found.push({
        start: i,
        end: j,
        failure: {
          event: i,
          line: events[i].line,
          tool: events[i].toolName || events[i].role,
          kind: failure.kind,
          error: errorLine(events[i].text),
        },
        mutation: {
          event: j,
          line: events[j].line,
          tool: linked.mutation.tool,
          target: linked.mutation.target,
          target_abs: absoluteTarget(session.cwd, linked.mutation.target),
        },
        token: { kind: linked.token.kind, text: linked.token.text },
      });
      pending = "emit";
      break;
    }
    if (pending === "no_mutation") stats.droppedNoMutation += 1;
    else if (pending === "no_shared_token") stats.droppedNoToken += 1;
    else if (pending === "window_too_large") stats.droppedTooLarge += 1;
  }
  const kept = [];
  for (const window of found) {
    const last = kept.at(-1);
    const span = window.end - window.start + 1;
    const overlap = last ? last.end - window.start + 1 : 0;
    if (last && overlap > span / 2) {
      stats.collapsed += 1;
      continue;
    }
    kept.push(window);
  }
  for (const window of kept) window.window = renderWindow(events, window.start, window.end);
  return { windows: kept, stats };
}

// ---------------------------------------------------------------- report

function harvest(opts) {
  const corpus = resolveCorpus(opts.sessions);
  const census = {
    files: 0,
    events: 0,
    failing_events: 0,
    windows: 0,
    collapsed: 0,
    dropped_no_mutation: 0,
    dropped_no_shared_token: 0,
    dropped_window_too_large: 0,
    skipped_non_utf8_lines: 0,
    skipped_unparsed_lines: 0,
    files_without_events: 0,
    files_unreadable: 0,
    files_skipped_by_since: 0,
    pruned_archive_dirs: corpus.prunedDirs,
    pruned_archive_files: corpus.prunedFiles,
  };
  const records = [];
  let complete = true;
  for (const file of corpus.files) {
    if (opts.limit && records.length >= opts.limit) {
      complete = false;
      break;
    }
    let read;
    try {
      read = readSession(file);
    } catch {
      census.files_unreadable += 1;
      continue;
    }
    census.files += 1;
    census.skipped_non_utf8_lines += read.nonUtf8;
    census.skipped_unparsed_lines += read.unparsed;
    if (opts.since !== null) {
      const start = Date.parse(read.meta.start || "");
      if (Number.isNaN(start) || start < opts.since) {
        census.files_skipped_by_since += 1;
        continue;
      }
    }
    census.events += read.events.length;
    if (!read.events.length) {
      census.files_without_events += 1;
      continue;
    }
    const session = { file, id: read.meta.id, start: read.meta.start, cwd: read.meta.cwd };
    const result = harvestSession(session, read.events, opts.window);
    census.failing_events += result.stats.failing;
    census.collapsed += result.stats.collapsed;
    census.dropped_no_mutation += result.stats.droppedNoMutation;
    census.dropped_no_shared_token += result.stats.droppedNoToken;
    census.dropped_window_too_large += result.stats.droppedTooLarge;
    for (const window of result.windows) {
      records.push({
        session: file,
        session_id: session.id,
        start: session.start,
        cwd: session.cwd,
        failure: window.failure,
        mutation: window.mutation,
        token: window.token,
        window: window.window,
      });
      if (opts.limit && records.length >= opts.limit) break;
    }
    if (opts.limit && records.length >= opts.limit) {
      complete = false;
      break;
    }
  }
  census.windows = records.length;
  // Reading order is by the session's own start, so a table reads as a
  // timeline; two runs over one corpus keep this order, so the output stays
  // byte-identical.
  records.sort(
    (a, b) =>
      String(a.start).localeCompare(String(b.start)) ||
      a.session.localeCompare(b.session) ||
      a.failure.event - b.failure.event,
  );
  return { options: { sessions: opts.sessions, since: opts.since, window: opts.window, limit: opts.limit }, complete, census, records };
}

function printTable(report, elapsedMs) {
  for (const record of report.records) {
    const where = basename(record.session);
    process.stdout.write(
      `${where}  ${record.failure.event}->${record.mutation.event}  ${record.failure.tool} ${record.failure.kind}  ${record.token.kind}:${record.token.text}  ${record.mutation.target}\n`,
    );
  }
  const c = report.census;
  process.stdout.write(
    `\nfailures ${c.failing_events}  emitted ${c.windows}  collapsed ${c.collapsed}  dropped no-mutation=${c.dropped_no_mutation} no-token=${c.dropped_no_shared_token} too-large=${c.dropped_window_too_large}\n`,
  );
  process.stdout.write(
    `files ${c.files}  events ${c.events}  without-events ${c.files_without_events}  unreadable ${c.files_unreadable}  pruned-archives ${c.pruned_archive_files}  non-utf8-lines ${c.skipped_non_utf8_lines}  unparsed-lines ${c.skipped_unparsed_lines}\n`,
  );
  if (!report.complete) process.stdout.write("stopped at --limit; the census describes the part that ran\n");
  process.stderr.write(`elapsed ${elapsedMs} ms\n`);
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const startedAt = Date.now();
  const report = harvest(opts);
  if (opts.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else printTable(report, Date.now() - startedAt);
  return 0;
}

process.exit(main());
