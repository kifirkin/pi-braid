#!/usr/bin/env node
/**
 * tool-usage-census.mjs — count what the agent actually called, from the
 * recorded session corpus.
 *
 * Why this exists: `TOOLS.md` says a tool is registered and documented, and the
 * prompt builder injects a reflection for every tool in the active set. Neither
 * says the tool was ever called. A registered tool costs context on every turn
 * whether or not it is used, so the corpus is the only witness that separates a
 * tool earning its placement from one carried at a price. This reader counts
 * the calls, the failures and the payload, and prints them beside the inventory
 * so the cheap question ("is it used?") stops being answered by memory.
 *
 * ## What the record gives
 *
 * A pi session file is JSONL. Two entry shapes carry tool traffic:
 *
 *   - a call is a content part `{type: "toolCall", id, name, arguments}` inside
 *     an assistant message's `content` array;
 *   - a result is a whole entry whose `message` has `role: "toolResult"`, plus
 *     `toolCallId`, `toolName`, `content`, `isError`, `durationMs`.
 *
 * The join key is `toolCallId`. It is the same string on both sides, so a pair
 * is one string that appears twice, and `--pair-check <file>` reports that
 * population for one file (calls, results, unpaired calls, dangling results,
 * name disagreements) so the join can be held against a file a human knows
 * before any figure in this census is trusted.
 *
 * ## The rules this reader applies, each stated so it can be argued with
 *
 * 1. **One call is one (id, name, timestamp).** The corpus duplicates evidence:
 *    a resumed session, a branched context or a copied file repeats entries, and
 *    counting raw occurrences would count one decision twice. The join key is
 *    therefore `toolCallId` - but an id alone is not enough, because not every
 *    harness on this machine writes an opaque one. Positional ids (`functions.read:0`)
 *    and empty ids recur in unrelated sessions, so an id-only key would merge two
 *    distinct calls into one and lose the second. The rule here: two occurrences
 *    collapse only when they agree on id **and** name **and** the timestamp of the
 *    message that carried them. An id reused with a different name or a different
 *    timestamp is a different call, and both are kept and counted as a `reusedIds`
 *    row. A call part with no `id` at all is counted separately as `idless` and
 *    never folded into the totals.
 *
 * 2. **A result may live in another file.** When a session is resumed, its
 *    earlier calls can be copied forward while the result is written only in
 *    the later file, or the reverse. A result index is built across the whole
 *    corpus keyed by `toolCallId`, so a call pairs with its result wherever the
 *    two were written. A call with no result anywhere is `orphan`; a result
 *    with no call anywhere is `dangling`. Both are printed, because a run of
 *    orphans is how an interrupted session looks and is not the same fact as a
 *    tool that fails.
 *
 * 3. **An error rate is over paired calls.** The denominator is calls that have
 *    a result, since a call with no result has no recorded outcome. `isError`
 *    is the only failure signal in the file and is read as written.
 *
 * 4. **`sessions/archive/**` is excluded by default.** One archived harness
 *    session in this corpus records 34,964 `finalize` calls, which is a
 *    benchmark's traffic rather than task work and would swamp every share
 *    it appeared in. `--include-archive` counts it, so the exclusion can be
 *    measured instead of assumed.
 *
 * 5. **A tool name is the call's `name`.** The result's `toolName` is compared
 *    against it and every disagreement is counted: a corpus where the two
 *    fields drifted is a corpus whose per-tool table is not per-tool.
 *
 * 6. **Payload is counted in characters of text.** For each result, the sum of
 *    its `text` parts. Non-text parts (an image attachment) contribute nothing
 *    and their count is printed, so a large median for a file reader is not
 *    read as a large median for an image reader.
 *
 * 7. **A timestamp is the assistant message that carried the call.** Entries
 *    with no timestamp are counted as `undated` and land in no month.
 *
 * 8. **An error signature is text with its numbers removed.** UUIDs, hex ids,
 *    digit runs and quoted spans are replaced before grouping, so one failure
 *    mode reads as one row however much of it was a path or an id. The first
 *    occurrence of each signature is kept verbatim, because the normalisation
 *    is lossy and the reader needs to see the sentence it came from.
 *
 * ## The inventory side
 *
 * `--inventory <file>` reads newline-delimited tool names, compared against the
 * census to print registered-but-never-called and called-but-unregistered. This
 * reader does not scrape the tree for tool names: an inventory has an owner
 * (`TOOLS.md` in this package) and a second extractor would be a second answer.
 *
 * Usage:
 *   node packages/core/scripts/tool-usage-census.mjs
 *   node packages/core/scripts/tool-usage-census.mjs --pair-check <session.jsonl>
 *   node packages/core/scripts/tool-usage-census.mjs --inventory <names.txt> --json <out.json>
 *
 * Options:
 *   --corpus <dir>       corpus root (default: <home>/.pi/agent/sessions)
 *   --include-archive    count sessions/archive/** too
 *   --since <date>       keep calls at or after this ISO date/timestamp
 *   --until <date>       keep calls at or before this ISO date/timestamp
 *   --exclude-dir <name> extra first-level directory under the corpus to skip
 *   --inventory <file>   newline-delimited tool names to compare against
 *   --top <n>            rows per table (default 20)
 *   --json <file>        write the full census as JSON
 *   --quiet              JSON only, no markdown summary
 *   --pair-check <file>  print the call/result pairing for one session file
 *   --trace <text>       where a result text appeared (case-insensitive), so a
 *                        claim about an error's first or last firing points at
 *                        the session it came from
 *   --trace-tool <name>  where one tool was called, in the same shape
 *
 * Exit codes: 0 report printed, 1 pairing check found an incomplete join,
 * 2 usage error or unreadable corpus.
 */
import { createReadStream, existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** First-level corpus directories this reader skips unless told otherwise. */
const DEFAULT_SKIP_DIRS = ["archive"];

const USAGE = `usage: tool-usage-census.mjs [options]

  --corpus <dir>        corpus root (default: <home>/.pi/agent/sessions)
  --include-archive     count the archive tree too
  --since <date>        keep calls at or after this ISO date
  --until <date>        keep calls at or before this ISO date
  --exclude-dir <name>  another first-level directory to skip
  --inventory <file>    newline-delimited tool names to compare against
  --top <n>             rows per table (default 20)
  --json <file>         write the full census as JSON
  --quiet               print JSON only
  --pair-check <file>   print the call/result pairing for one session file
  --trace <text>        list where a result text matched, with timestamps
  --trace-tool <name>   list where one tool was called, with timestamps
  -h, --help            print this text`;

function parseArgs(argv) {
  const options = {
    corpus: join(homedir(), ".pi", "agent", "sessions"),
    includeArchive: false,
    since: null,
    until: null,
    skipDirs: [...DEFAULT_SKIP_DIRS],
    inventory: null,
    top: 20,
    json: null,
    quiet: false,
    pairCheck: null,
    trace: null,
    traceTool: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const nextValue = () => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      i += 1;
      return value;
    };
    switch (arg) {
      case "--corpus":
        options.corpus = nextValue();
        break;
      case "--include-archive":
        options.includeArchive = true;
        break;
      case "--since":
        options.since = Date.parse(nextValue());
        if (Number.isNaN(options.since)) throw new Error("--since is not a date");
        break;
      case "--until":
        options.until = Date.parse(nextValue());
        if (Number.isNaN(options.until)) throw new Error("--until is not a date");
        break;
      case "--exclude-dir":
        options.skipDirs.push(nextValue());
        break;
      case "--inventory":
        options.inventory = nextValue();
        break;
      case "--top":
        options.top = Number(nextValue());
        if (!Number.isFinite(options.top) || options.top < 1) throw new Error("--top must be a positive number");
        break;
      case "--trace":
        options.trace = nextValue().toLowerCase();
        break;
      case "--trace-tool":
        options.traceTool = nextValue();
        break;
      case "--json":
        options.json = nextValue();
        break;
      case "--quiet":
        options.quiet = true;
        break;
      case "--pair-check":
        options.pairCheck = nextValue();
        break;
      case "-h":
      case "--help":
        process.stdout.write(`${USAGE}\n`);
        process.exit(0);
        break;
      default:
        throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

// ---------------------------------------------------------------------------
// record reading
// ---------------------------------------------------------------------------

/** Text a result contributed, in characters, and whether it carried non-text parts. */
function resultPayload(content) {
  let chars = 0;
  let nonTextParts = 0;
  if (typeof content === "string") return { chars: content.length, nonTextParts };
  if (!Array.isArray(content)) return { chars, nonTextParts };
  for (const part of content) {
    if (part && typeof part.text === "string") chars += part.text.length;
    else if (part) nonTextParts += 1;
  }
  return { chars, nonTextParts };
}

/** The error sentence a result carried, first text part only, bounded. */
function resultErrorText(content) {
  if (typeof content === "string") return content.slice(0, 400);
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (part && typeof part.text === "string") return part.text.slice(0, 400);
  }
  return "";
}

/**
 * One pass over one session file: the calls it carries, the results it carries,
 * and how many lines it could not parse. Read as a stream because a session can
 * be 86MB and the corpus is 3.8GB.
 */
async function readSessionFile(file) {
  const calls = [];
  const results = new Map();
  let parseFailures = 0;
  let sessionId = null;
  let firstTimestamp = null;
  let lastTimestamp = null;

  const stream = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  for await (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try {
      entry = JSON.parse(trimmed);
    } catch {
      parseFailures += 1;
      continue;
    }
    if (entry.type === "session") {
      sessionId = entry.id ?? sessionId;
      continue;
    }
    const message = entry?.message;
    if (!message) continue;
    const timestamp = entry.timestamp ?? message.timestamp ?? null;
    if (timestamp) {
      if (!firstTimestamp) firstTimestamp = timestamp;
      lastTimestamp = timestamp;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const part of message.content) {
        if (!part || part.type !== "toolCall") continue;
        calls.push({
          id: part.id ?? null,
          name: part.name ?? "(unnamed)",
          args: part.arguments ?? null,
          timestamp,
          file,
          sessionId,
        });
      }
      continue;
    }
    if (message.role === "toolResult") {
      const payload = resultPayload(message.content);
      const record = {
        id: message.toolCallId ?? null,
        name: message.toolName ?? "(unnamed)",
        isError: message.isError === true,
        durationMs: typeof message.durationMs === "number" ? message.durationMs : null,
        chars: payload.chars,
        nonTextParts: payload.nonTextParts,
        errorText: message.isError === true ? resultErrorText(message.content) : "",
        timestamp,
        file,
      };
      // A file can repeat the same result (resume, branch). First wins.
      if (record.id !== null && !results.has(record.id)) results.set(record.id, record);
    }
  }
  return { calls, results, parseFailures, sessionId, firstTimestamp, lastTimestamp };
}

/**
 * Every session file under the corpus, at any depth, sorted so "first occurrence"
 * is stable across runs.
 *
 * The corpus has two archive layers and they are not the same fact:
 *
 *   - `sessions/archive/<project>/<file>.jsonl` is a whole archived tree, and it
 *     holds benchmark traffic rather than task work, so it is skipped by default
 *     (`--include-archive` counts it);
 *   - `<project>/archives/<file>.jsonl` sits inside a project and holds copies of
 *     that project's own sessions. It is read, because a copy is exactly what
 *     `toolCallId` deduplication exists to collapse, and skipping it would hide
 *     how much of the corpus is repetition.
 *
 * A directory is skipped by name at any depth, and every skipped path is reported
 * with the number of files it kept out, so an exclusion is a measured quantity.
 */
function listSessionFiles(corpus, options) {
  const files = [];
  const skipped = [];
  let projectDirs = 0;
  const walk = (dir, relative, depth) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relPath = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (depth === 0) projectDirs += 1;
        if (options.skipDirs.includes(entry.name)) {
          let keptOut = 0;
          const count = (inner) => {
            for (const child of readdirSync(inner, { withFileTypes: true })) {
              if (child.isDirectory()) count(join(inner, child.name));
              else if (child.name.endsWith(".jsonl")) keptOut += 1;
            }
          };
          count(join(dir, entry.name));
          skipped.push({ dir: relPath, files: keptOut });
          continue;
        }
        walk(join(dir, entry.name), relPath, depth + 1);
        continue;
      }
      if (entry.name.endsWith(".jsonl")) files.push(join(dir, entry.name));
    }
  };
  walk(corpus, "", 0);
  files.sort();
  return { files, projectDirs, skipped };
}

// ---------------------------------------------------------------------------
// aggregation
// ---------------------------------------------------------------------------

const ERROR_NOISE = [
  [/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>"],
  [/\b0x[0-9a-f]+\b/g, "<hex>"],
  [/\b[0-9a-f]{12,}\b/g, "<hex>"],
  [/[A-Za-z]:\\[^\s"']+/g, "<path>"],
  [/(?:\/[\w.@+-]+){2,}/g, "<path>"],
  [/["'`][^"'`]{0,120}["'`]/g, "<quote>"],
  [/\d+/g, "<n>"],
];

/** Digits and paths out of an error sentence, so one failure mode is one row. */
function errorSignature(text) {
  let out = String(text).slice(0, 240).toLowerCase();
  for (const [pattern, replacement] of ERROR_NOISE) out = out.replace(pattern, replacement);
  return out.replace(/\s+/g, " ").trim().slice(0, 140);
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function monthOf(timestamp) {
  if (!timestamp) return null;
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return null;
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** First token of a bash command, so `bash` can be read as what it was used for. */
function bashFirstToken(args) {
  const command = typeof args === "string" ? args : (args?.command ?? "");
  if (typeof command !== "string") return null;
  const first = command.trim().split(/\s+/)[0];
  if (!first) return null;
  return first.replace(/^[A-Za-z_][A-Za-z0-9_]*=\S*$/, "(env)").slice(0, 40);
}

function emptyToolRow(name) {
  return {
    name,
    calls: 0,
    paired: 0,
    errors: 0,
    orphans: 0,
    durations: [],
    totalMs: 0,
    chars: [],
    nonTextResults: 0,
    sessions: new Set(),
    months: new Map(),
    firstTimestamp: null,
    lastTimestamp: null,
    errorSignatures: new Map(),
    bashTokens: new Map(),
  };
}

/**
 * Is this a tool name at all? A name is an identifier. A model that emits a
 * malformed call writes its arguments into the name field, so a name carrying
 * whitespace, a quote, a tag bracket or 64-plus characters is the shape of a
 * broken call rather than a tool this machine ever offered.
 */
function isIdentifierName(name) {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name);
}

function bump(map, key, delta = 1) {
  map.set(key, (map.get(key) ?? 0) + delta);
}

function censusOne(acc, call, result) {
  const tool = acc.tools.get(call.name) ?? emptyToolRow(call.name);
  acc.tools.set(call.name, tool);
  tool.calls += 1;
  tool.sessions.add(call.file);
  if (call.timestamp) {
    const month = monthOf(call.timestamp);
    if (month) bump(tool.months, month);
    if (!tool.firstTimestamp || call.timestamp < tool.firstTimestamp) tool.firstTimestamp = call.timestamp;
    if (!tool.lastTimestamp || call.timestamp > tool.lastTimestamp) tool.lastTimestamp = call.timestamp;
  }
  if (call.name === "bash") {
    const token = bashFirstToken(call.args);
    if (token) bump(tool.bashTokens, token);
  }
  acc.months.set(monthOf(call.timestamp) ?? "undated", (acc.months.get(monthOf(call.timestamp) ?? "undated") ?? 0) + 1);

  if (!result) {
    tool.orphans += 1;
    acc.orphanCalls += 1;
    return;
  }
  tool.paired += 1;
  if (result.name !== call.name) acc.resultNameMismatches += 1;
  if (result.durationMs !== null) {
    tool.durations.push(result.durationMs);
    tool.totalMs += result.durationMs;
  }
  tool.chars.push(result.chars);
  if (result.nonTextParts > 0) tool.nonTextResults += 1;
  if (result.isError) {
    tool.errors += 1;
    const signature = errorSignature(result.errorText) || "(empty error text)";
    const row = tool.errorSignatures.get(signature) ?? {
      signature,
      count: 0,
      sample: result.errorText.slice(0, 200),
      firstTimestamp: call.timestamp,
      lastTimestamp: call.timestamp,
      firstFile: call.file,
      lastFile: call.file,
    };
    row.count += 1;
    if (call.timestamp && (!row.firstTimestamp || call.timestamp < row.firstTimestamp)) {
      row.firstTimestamp = call.timestamp;
      row.firstFile = call.file;
    }
    if (call.timestamp && (!row.lastTimestamp || call.timestamp > row.lastTimestamp)) {
      row.lastTimestamp = call.timestamp;
      row.lastFile = call.file;
    }
    tool.errorSignatures.set(signature, row);
  }
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function share(part, whole) {
  if (!whole) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function fixed(value, digits = 0) {
  if (value === null || value === undefined) return "n/a";
  return digits === 0 ? String(Math.round(value)) : value.toFixed(digits);
}

function toolTable(rows, totalPaired) {
  const header =
    "| Tool | Calls | Share | Paired | Orphans | Errors | Error rate | p50 ms | p95 ms | Median result chars | Sessions |";
  const rule = "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |";
  const body = rows.map((row) => {
    return `| \`${row.name}\` | ${row.calls} | ${share(row.calls, totalPaired)} | ${row.paired} | ${row.orphans} | ${row.errors} | ${
      row.paired ? share(row.errors, row.paired) : "n/a"
    } | ${fixed(row.p50ms)} | ${fixed(row.p95ms)} | ${fixed(row.medianChars)} | ${row.sessions} |`;
  });
  return [header, rule, ...body].join("\n");
}

/**
 * One trace record per match: what it was, when, and which session file. The
 * project directory is dropped from the name, so a trace can be pasted into a
 * report without carrying a machine path with it.
 */
function basenameOf(file) {
  const parts = file.split(/[\\/]/);
  return parts[parts.length - 1];
}

function traceSection(trace) {
  if (!trace || !trace.matches.length) return [];
  const out = [];
  out.push("## Trace", "");
  out.push(`- pattern: ${trace.pattern}`);
  out.push(`- matches: ${trace.matches.length} in ${trace.sessions} sessions`);
  out.push(`- first: ${trace.matches[0].timestamp ?? "undated"} ${basenameOf(trace.matches[0].file)}`);
  out.push(`- last: ${trace.matches[trace.matches.length - 1].timestamp ?? "undated"} ${basenameOf(trace.matches[trace.matches.length - 1].file)}`);
  const head = trace.matches.slice(0, 5);
  const tail = trace.matches.slice(-5);
  out.push("- earliest five:");
  for (const match of head) out.push(`  - ${match.timestamp ?? "undated"} \`${match.tool}\` ${basenameOf(match.file)}`);
  out.push("- latest five:");
  for (const match of tail) out.push(`  - ${match.timestamp ?? "undated"} \`${match.tool}\` ${basenameOf(match.file)}`);
  out.push("");
  return out;
}

function markdownReport(census) {
  const out = [];
  const allRows = [...census.tools].sort((a, b) => b.calls - a.calls);
  const rows = allRows;
  out.push("## Corpus", "");
  out.push(`- files scanned: ${census.corpus.files} of ${census.corpus.filesFound} found`);
  out.push(`- project directories: ${census.corpus.projectDirs}`);
  out.push(`- bytes scanned: ${(census.corpus.bytes / 1e6).toFixed(1)}M`);
  out.push(`- sessions with at least one call: ${census.corpus.sessionsWithCalls}`);
  out.push(`- sessions with no call: ${census.corpus.sessionsWithoutCalls}`);
  out.push(`- files under a project \`archives/\` directory (read, then collapsed by id): ${census.corpus.projectArchiveFiles}`);
  out.push(`- unparseable lines: ${census.corpus.parseFailures}`);
  out.push(`- span: ${census.corpus.firstTimestamp ?? "n/a"} to ${census.corpus.lastTimestamp ?? "n/a"}`);
  if (census.corpus.skipped.length) {
    out.push(
      `- skipped directories: ${census.corpus.skipped.map((s) => `\`${s.dir}\` (${s.files} files)`).join(", ")}`,
    );
  }
  out.push("");
  out.push("## Join", "");
  out.push(`- calls read (raw occurrences): ${census.join.rawCalls}`);
  out.push(`- unique calls (by toolCallId + name + timestamp): ${census.join.uniqueCalls}`);
  out.push(`- duplicates collapsed: ${census.join.duplicateCalls} occurrences across ${census.join.duplicateIds} keys`);
  out.push(
    `- of those occurrences, ${census.join.duplicateOccurrencesInProjectArchives} repeated a call from a project \`archives/\` copy`,
  );
  out.push(`- ids reused for calls that differ in name or timestamp (kept apart): ${census.join.reusedIds}`);
  out.push(`- id-less calls (not deduplicated): ${census.join.idlessCalls}`);
  out.push(`- paired: ${census.join.paired}, orphan calls: ${census.join.orphanCalls}, dangling results: ${census.join.danglingResults}`);
  out.push(`- result name disagreed with call name: ${census.join.resultNameMismatches}`);
  out.push("");
  out.push("## Per tool", "");
  out.push(toolTable(rows, census.join.uniqueCalls));
  out.push("");
  if (census.join.malformedCalls > 0) {
    out.push(
      `Malformed call names (${census.join.malformedCalls} calls, ${census.join.malformedNames.length} distinct) are excluded from the table and kept in the totals: ` +
        census.join.malformedNames
          .slice(0, 5)
          .map((row) => `${row.calls}x \`${row.name.replace(/\s+/g, " ").slice(0, 40)}\``)
          .join(", "),
    );
    out.push("");
  }
  if (census.inventory) {
    out.push("## Inventory", "");
    if (census.inventory.neverCalled.length) {
      out.push(`Registered but never called (${census.inventory.neverCalled.length}): ${census.inventory.neverCalled.map((n) => `\`${n}\``).join(", ")}`);
    } else {
      out.push("Registered but never called: none");
    }
    out.push("");
    if (census.inventory.unregistered.length) {
      out.push(
        `Called but not in the inventory (${census.inventory.unregistered.length}): ${census.inventory.unregistered
          .map((n) => `\`${n}\``)
          .join(", ")}`,
      );
      out.push("");
    }
  }
  out.push("## Failures", "");
  const failing = rows.filter((row) => row.errors > 0).slice(0, census.top);
  for (const row of failing) {
    out.push(`### \`${row.name}\` (${row.errors} of ${row.paired} paired = ${share(row.errors, row.paired)})`, "");
    const signatures = [...row.errorSignatures.values()].sort((a, b) => b.count - a.count).slice(0, 5);
    for (const signature of signatures) {
      out.push(`- ${signature.count}x \`${signature.signature}\``);
      out.push(`  - first: ${signature.firstTimestamp ?? "undated"}`);
      out.push(`  - last: ${signature.lastTimestamp ?? "undated"}`);
      out.push(`  - sample: ${signature.sample.replace(/\s+/g, " ").slice(0, 160)}`);
    }
    out.push("");
  }
  out.push("## Months", "");
  out.push(
    Object.entries(census.months)
      .sort((a, b) => String(a[0]).localeCompare(String(b[0])))
      .map(([month, count]) => `${month}=${count}`)
      .join(" "),
  );
  out.push("");
  out.push("## Single-session tools", "");
  const single = rows.filter((row) => row.sessions <= 2);
  out.push(
    single.length
      ? single.map((row) => `\`${row.name}\` (${row.sessions} session(s), ${row.calls} calls)`).join(", ")
      : "none",
  );
  out.push("");
  return out.join("\n");
}

// ---------------------------------------------------------------------------
// pairing check
// ---------------------------------------------------------------------------

async function pairCheck(file) {
  const read = await readSessionFile(file);
  const callIds = new Set();
  let idless = 0;
  const duplicates = [];
  for (const call of read.calls) {
    if (call.id === null) {
      idless += 1;
      continue;
    }
    if (callIds.has(call.id)) duplicates.push(call.id);
    callIds.add(call.id);
  }
  const unpaired = [];
  const nameMismatch = [];
  let errors = 0;
  for (const call of read.calls) {
    if (call.id === null) continue;
    const result = read.results.get(call.id);
    if (!result) {
      unpaired.push(call.id);
      continue;
    }
    if (result.name !== call.name) nameMismatch.push(`${call.id}: call=${call.name} result=${result.name}`);
    if (result.isError) errors += 1;
  }
  const dangling = [...read.results.keys()].filter((id) => id !== null && !callIds.has(id));
  const idlessResults = [...read.results.values()].filter((result) => result.id === null).length;
  const lines = [
    `file: ${file}`,
    `session id: ${read.sessionId ?? "n/a"}`,
    `span: ${read.firstTimestamp ?? "n/a"} to ${read.lastTimestamp ?? "n/a"}`,
    `call parts: ${read.calls.length} (unique ids: ${callIds.size}, id-less: ${idless}, duplicate ids: ${duplicates.length})`,
    `result entries: ${read.results.size} (id-less: ${idlessResults})`,
    `unpaired calls: ${unpaired.length}${unpaired.length ? ` -> ${unpaired.slice(0, 10).join(", ")}` : ""}`,
    `dangling results: ${dangling.length}${dangling.length ? ` -> ${dangling.slice(0, 10).join(", ")}` : ""}`,
    `name disagreements: ${nameMismatch.length}${nameMismatch.length ? ` -> ${nameMismatch.slice(0, 5).join("; ")}` : ""}`,
    `isError results: ${errors}`,
    `unparseable lines: ${read.parseFailures}`,
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
  const incomplete = unpaired.length > 0 || dangling.length > 0 || nameMismatch.length > 0 || idless > 0 || duplicates.length > 0;
  return incomplete ? 1 : 0;
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  let options;
  try {
    options = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n\n${USAGE}\n`);
    return 2;
  }

  if (options.pairCheck) return pairCheck(options.pairCheck);

  if (!existsSync(options.corpus)) {
    process.stderr.write(`corpus not found: ${options.corpus}\n`);
    return 2;
  }

  const { files, projectDirs, skipped } = listSessionFiles(options.corpus, options);
  const acc = {
    tools: new Map(),
    projectArchiveFiles: 0,
    duplicateOccurrencesInProjectArchives: 0,
    months: new Map(),
    toolsBySession: new Map(),
    rawCalls: 0,
    uniqueCalls: 0,
    idlessCalls: 0,
    duplicateCalls: 0,
    duplicateIds: 0,
    duplicateExampleCounts: new Map(),
    duplicateExamples: [],
    orphanCalls: 0,
    danglingResults: 0,
    resultNameMismatches: 0,
    parseFailures: 0,
    undated: 0,
    bytes: 0,
    filesRead: 0,
    sessionsWithCalls: 0,
    sessionsWithoutCalls: 0,
    firstTimestamp: null,
    lastTimestamp: null,
  };
  const callsByKey = new Map();
  const callsById = new Map();
  const resultsById = new Map();
  const callFileOf = new Map();
  const reusedIds = new Set();
  const trace = options.trace || options.traceTool ? { pattern: options.trace ? `result text contains "${options.trace}"` : `calls named \`${options.traceTool}\``, matches: [], sessions: 0 } : null;
  const traceSessionFiles = new Set();
  const inWindow = (timestamp) => {
    if (!timestamp) return true;
    const time = Date.parse(timestamp);
    if (Number.isNaN(time)) return true;
    if (options.since !== null && time < options.since) return false;
    if (options.until !== null && time > options.until) return false;
    return true;
  };

  for (const file of files) {
    const inProjectArchive = file.includes(`${sep}archives${sep}`);
    if (inProjectArchive) acc.projectArchiveFiles += 1;
    const size = statSync(file).size;
    acc.bytes += size;
    acc.filesRead += 1;
    const read = await readSessionFile(file);
    acc.parseFailures += read.parseFailures;
    if (read.firstTimestamp && (!acc.firstTimestamp || read.firstTimestamp < acc.firstTimestamp)) {
      acc.firstTimestamp = read.firstTimestamp;
    }
    if (read.lastTimestamp && (!acc.lastTimestamp || read.lastTimestamp > acc.lastTimestamp)) {
      acc.lastTimestamp = read.lastTimestamp;
    }
    for (const [id, result] of read.results) {
      if (id !== null && !resultsById.has(id)) resultsById.set(id, result);
    }
    let callsInFile = 0;
    if (trace) {
      if (options.trace) {
        for (const result of read.results.values()) {
          if (!inWindow(result.timestamp)) continue;
          if (!result.errorText.toLowerCase().includes(options.trace)) continue;
          trace.matches.push({ tool: result.name, timestamp: result.timestamp, file });
          traceSessionFiles.add(file);
        }
      } else if (options.traceTool) {
        for (const call of read.calls) {
          if (!inWindow(call.timestamp)) continue;
          if (call.name !== options.traceTool) continue;
          trace.matches.push({ tool: call.name, timestamp: call.timestamp, file });
          traceSessionFiles.add(file);
        }
      }
    }
    for (const call of read.calls) {
      if (!inWindow(call.timestamp)) continue;
      callsInFile += 1;
      acc.rawCalls += 1;
      if (call.id === null) {
        acc.idlessCalls += 1;
        continue;
      }
      const key = `${call.id}\u0000${call.name}\u0000${call.timestamp ?? ""}`;
      if (callsByKey.has(key)) {
        acc.duplicateCalls += 1;
        if (inProjectArchive) acc.duplicateOccurrencesInProjectArchives += 1;
        acc.duplicateExampleCounts.set(key, (acc.duplicateExampleCounts.get(key) ?? 1) + 1);
        if (acc.duplicateExamples.length < 20) {
          acc.duplicateExamples.push({ id: call.id, name: call.name, first: callsByKey.get(key).file, again: file });
        }
        continue;
      }
      if (callsById.has(call.id)) reusedIds.add(call.id);
      callsByKey.set(key, call);
      callsById.set(call.id, call);
      callFileOf.set(call.id, call.id);
    }
    if (callsInFile > 0) acc.sessionsWithCalls += 1;
    else acc.sessionsWithoutCalls += 1;
  }

  if (trace) {
    trace.matches.sort((a, b) => String(a.timestamp ?? "").localeCompare(String(b.timestamp ?? "")));
    trace.sessions = traceSessionFiles.size;
  }
  acc.duplicateIds = acc.duplicateExampleCounts.size;
  const pairedIds = new Set();
  for (const [, call] of callsByKey) {
    acc.uniqueCalls += 1;
    const result = resultsById.get(call.id) ?? null;
    if (result) pairedIds.add(call.id);
    if (!call.timestamp) acc.undated += 1;
    censusOne(acc, call, result);
  }
  for (const id of resultsById.keys()) if (!callsById.has(id)) acc.danglingResults += 1;

  const toolRows = [...acc.tools.values()].map((row) => ({
    name: row.name,
    calls: row.calls,
    paired: row.paired,
    errors: row.errors,
    orphans: row.orphans,
    errorRate: row.paired ? row.errors / row.paired : null,
    p50ms: percentile([...row.durations].sort((a, b) => a - b), 50),
    p95ms: percentile([...row.durations].sort((a, b) => a - b), 95),
    totalMs: row.totalMs,
    medianChars: percentile([...row.chars].sort((a, b) => a - b), 50),
    totalChars: row.chars.reduce((sum, value) => sum + value, 0),
    sessions: row.sessions.size,
    firstTimestamp: row.firstTimestamp,
    lastTimestamp: row.lastTimestamp,
    months: Object.fromEntries(row.months),
    nonTextResults: row.nonTextResults,
    errorSignatures: [...row.errorSignatures.values()].sort((a, b) => b.count - a.count),
    bashTokens: row.bashTokens.size ? Object.fromEntries([...row.bashTokens.entries()].sort((a, b) => b[1] - a[1])) : undefined,
  }));

  const identifierRows = toolRows.filter((row) => isIdentifierName(row.name));
  const malformedRows = toolRows
    .filter((row) => !isIdentifierName(row.name))
    .sort((a, b) => b.calls - a.calls);

  let inventory = null;
  if (options.inventory) {
    const wanted = readFileSync(options.inventory, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    const called = new Set(identifierRows.map((row) => row.name));
    inventory = {
      source: options.inventory,
      declared: wanted.length,
      neverCalled: wanted.filter((name) => !called.has(name)).sort(),
      unregistered: [...called].filter((name) => !wanted.includes(name)).sort(),
    };
  }

  const census = {
    generatedAt: new Date().toISOString(),
    corpus: {
      root: options.corpus,
      filesFound: files.length,
      files: acc.filesRead,
      projectDirs,
      bytes: acc.bytes,
      sessionsWithCalls: acc.sessionsWithCalls,
      sessionsWithoutCalls: acc.sessionsWithoutCalls,
      parseFailures: acc.parseFailures,
      projectArchiveFiles: acc.projectArchiveFiles,
      skipped,
      includeArchive: options.includeArchive,
      firstTimestamp: acc.firstTimestamp,
      lastTimestamp: acc.lastTimestamp,
      since: options.since === null ? null : new Date(options.since).toISOString(),
      until: options.until === null ? null : new Date(options.until).toISOString(),
    },
    join: {
      rawCalls: acc.rawCalls,
      uniqueCalls: acc.uniqueCalls,
      uniqueCallsByIdOnly: callsById.size,
      idlessCalls: acc.idlessCalls,
      duplicateCalls: acc.duplicateCalls,
      duplicateIds: acc.duplicateIds,
      reusedIds: reusedIds.size,
      duplicateOccurrencesInProjectArchives: acc.duplicateOccurrencesInProjectArchives,
      duplicateExamples: acc.duplicateExamples,
      paired: acc.uniqueCalls - acc.orphanCalls,
      orphanCalls: acc.orphanCalls,
      danglingResults: acc.danglingResults,
      resultNameMismatches: acc.resultNameMismatches,
      undated: acc.undated,
      malformedCalls: malformedRows.reduce((sum, row) => sum + row.calls, 0),
      malformedNames: malformedRows.map((row) => ({ name: row.name, calls: row.calls, errors: row.errors })),
    },
    months: Object.fromEntries([...acc.months.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])))),
    tools: identifierRows.sort((a, b) => b.calls - a.calls),
    inventory,
    trace: trace ? { pattern: trace.pattern, matches: trace.matches.length, sessions: trace.sessions, first: trace.matches[0] ? { timestamp: trace.matches[0].timestamp, file: basenameOf(trace.matches[0].file) } : null, last: trace.matches.length ? { timestamp: trace.matches[trace.matches.length - 1].timestamp, file: basenameOf(trace.matches[trace.matches.length - 1].file) } : null } : null,
  };

  if (options.json) {
    writeFileSync(resolve(options.json), `${JSON.stringify(census, null, 2)}\n`, "utf8");
    if (!options.quiet) process.stderr.write(`wrote ${resolve(options.json)}\n`);
  }
  if (!options.quiet) {
    const report = markdownReport({ ...census, top: options.top });
    process.stdout.write(`${report}\n`);
    const traced = traceSection(trace);
    if (traced.length) process.stdout.write(`${traced.join("\n")}\n`);
  }
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    process.stderr.write(`${error.stack ?? error.message}\n`);
    process.exit(2);
  },
);
