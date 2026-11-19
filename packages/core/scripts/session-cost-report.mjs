#!/usr/bin/env node
/**
 * session-cost-report.mjs — read a pi session file and say what it cost, per tool.
 *
 * pi-core records one `usage` object on every assistant message: `input`
 * (uncached prompt tokens), `cacheRead` (prompt tokens served from cache),
 * `cacheWrite` (tokens written into the cache), `output`. The harness keeps
 * the four classes disjoint, which is why `totalTokens` is their sum and why
 * `utils/overflow.js` measures a filled context window as `input + cacheRead`.
 * Nothing in pi records which *tool* bought those tokens, and the question a
 * budget owner asks first is exactly that one. This script answers it:
 *
 *   - the session's tokens split into the four classes, as recorded;
 *   - the same split per tool name, with the rule below;
 *   - the share of assistant characters that are prose, thinking, or tool
 *     arguments (the session file carries all three);
 *   - a price, but only from rates the caller passes on the command line.
 *
 * The attribution rule, stated so a reader can check an arithmetic rather
 * than trust a total: each assistant message's usage is charged to the tool
 * results that entered the context window since the previous assistant
 * message (the session file's own order), and inside that window the split is
 * proportional to the number of characters each tool's result contributed.
 * A window with no tool result is the `(prompt)` row: the user turn and the
 * system prompt bought those tokens. Whole tokens are distributed by largest
 * remainder inside each turn, so a class's per-tool column sums to the class
 * total exactly; the residual of that rounding is printed if it is ever
 * nonzero rather than folded into a row.
 *
 * What the rule measures, and what it cannot:
 *   - It measures marginal context: what the tools in this window added to the
 *     prompt the model then read. Cached prompt tokens are counted at the
 *     window that read them, not at the turn that first wrote them, so a long
 *     session's `cached input` column is a re-charge, not a lifetime cause.
 *     A tool that dumps a large result early and is never called again still
 *     shows a small column, because later windows are charged to later tools.
 *   - Four classes are reported, not three: `cacheWrite` is zero on most
 *     providers, and a reader that dropped it would report a total that does
 *     not equal the sum of the parts it prints.
 *   - A turn pi stopped as `aborted` or `error` is counted and its usage is
 *     left out of the totals, matching `lib/detection/context-usage.ts`, which
 *     skips those turns when it reads the same file.
 *   - A field a provider did not report is `n/a`, never zero, and the count of
 *     turns that omitted it is printed beside the number. A class no turn
 *     reported shows `n/a` for the whole session.
 *   - `usage.cost` in the file is pi's own computed figure from its model
 *     table. This reader does not read it. A price here is a function of the
 *     rates the caller supplied, so the script cannot ship a tariff and be
 *     wrong about one.
 *
 * Usage:
 *   node packages/core/scripts/session-cost-report.mjs --file <path> [options]
 *   node packages/core/scripts/session-cost-report.mjs --session <id> --limit 3
 *   node packages/core/scripts/session-cost-report.mjs --dir <root> --json
 *   node packages/core/scripts/session-cost-report.mjs \
 *     --file <path> --rate-in 3 --rate-cache-read 0.3 --rate-out 15
 *
 * Exit codes: 0 — a report was produced (a path with no session file in it is
 * reported as such, not an error: the default root is empty until a session
 * runs); 2 — bad usage, an unreadable input, or a rate that is not a number.
 *
 * Named `report:session-cost` in package.json, alongside
 * `report:context-heartbeat`. It is an advisory reader, not a gate, and is not
 * a member of the ci:check chain.
 *
 * The default root mirrors pi's own layout: `<home>/.pi/agent/sessions`, with
 * one directory per project slug and one JSONL per session. A home that does
 * not resolve an absolute path is refused, never resolved against the cwd, for
 * the reason `braidDir()` refuses a relative BRAID_HOME: a reader that guesses
 * would report on a tree it does not own.
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";

/**
 * The token classes, in render order. `field` is the name pi records on
 * `message.usage`; `label` is what this report prints and what an assertion
 * about the class is allowed to say.
 */
export const CLASSES = [
  { key: "uncachedIn", field: "input", label: "uncached input", rateFlag: "--rate-in" },
  { key: "cachedIn", field: "cacheRead", label: "cached input", rateFlag: "--rate-cache-read" },
  { key: "cacheWrite", field: "cacheWrite", label: "cache write", rateFlag: "--rate-cache-write" },
  { key: "out", field: "output", label: "output", rateFlag: "--rate-out" },
];

/** The row that holds usage bought by a window with no tool result. */
export const PROMPT_ROW = "(prompt)";

const USAGE = `Usage: node packages/core/scripts/session-cost-report.mjs [options]

  --file <path>            session JSONL to read (repeatable)
  --dir <path>             directory of session JSONL: *.jsonl one level down
                           (default: <home>/.pi/agent/sessions)
  --session <id>           only sessions whose id or file name contains <id>
                           (repeatable)
  --limit <n>              sessions to render, newest file first (default 5;
                           0 = every session found)
  --rate-in <usd/1M>       USD per million uncached input tokens
  --rate-cache-read <usd/1M>   USD per million cache-read tokens
  --rate-cache-write <usd/1M>  USD per million cache-write tokens
  --rate-out <usd/1M>      USD per million output tokens
  --json                   machine-readable summary instead of the text render
  -h, --help               this text

Rates are the caller's numbers. The script ships no table, and refuses to print
a total when a class with nonzero tokens has no rate.`;

// ── paths ───────────────────────────────────────────────────────────────────

/**
 * pi's sessions root. Mirrors the refusal legs of core's `braidDir()`: a home
 * that is missing or not absolute would resolve the root against whatever cwd
 * the process has, so this throws instead of returning one.
 */
export function piSessionsDir() {
  let home = "";
  try {
    home = homedir();
  } catch {
    // os.homedir() itself failed: no absolute home, so refuse below.
  }
  if (!home || !isAbsolute(home)) {
    throw new Error(
      "session-cost-report: HOME does not resolve an absolute path, so pi's " +
        "sessions directory cannot be derived without reading beside the cwd. " +
        "Set HOME to an absolute directory, or pass --dir or --file.",
    );
  }
  return join(home, ".pi", "agent", "sessions");
}

// ── parse ───────────────────────────────────────────────────────────────────

/** Parse JSONL text into entries. A blank line is ignored; a line that is not
 *  a JSON object is counted as malformed and skipped. */
export function parseSessionLines(text) {
  const entries = [];
  let malformed = 0;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformed++;
      continue;
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      malformed++;
      continue;
    }
    entries.push(parsed);
  }
  return { entries, malformed };
}

/** The session id a file declares, falling back to the file name's id segment. */
export function sessionIdOf(entries, file) {
  for (const entry of entries) {
    if (entry.type === "session" && typeof entry.id === "string" && entry.id !== "") {
      return entry.id;
    }
  }
  const stem = basename(file, ".jsonl");
  const segments = stem.split("_");
  return segments.length > 1 ? segments[segments.length - 1] : stem;
}

// ── arithmetic ──────────────────────────────────────────────────────────────

/**
 * Split `total` whole tokens across `weights` by largest remainder.
 *
 * The largest-remainder step is what makes the per-tool column sum to the
 * class total exactly: flooring each share loses up to one token per tool, and
 * the leftover is handed to the largest fractional parts, ties going to the
 * earlier row so the split is deterministic.
 */
export function allocate(total, weights) {
  const n = weights.length;
  if (n === 0) return [];
  const sum = weights.reduce((a, b) => a + b, 0);
  const raw = weights.map((w) => (sum > 0 ? (total * w) / sum : total / n));
  const out = raw.map((r) => Math.floor(r));
  let left = total - out.reduce((a, b) => a + b, 0);
  if (left > 0) {
    const order = raw
      .map((r, i) => ({ i, frac: r - Math.floor(r) }))
      .sort((a, b) => b.frac - a.frac || a.i - b.i);
    for (let k = 0; k < left; k++) out[order[k % n].i] += 1;
  }
  return out;
}

/** Characters of text a message content array carries, by content kind. */
function contentChars(message) {
  const chars = { prose: 0, thinking: 0, toolArgs: 0 };
  const calls = [];
  const content = message?.content;
  if (typeof content === "string") {
    chars.prose += content.length;
    return { chars, calls };
  }
  if (!Array.isArray(content)) return { chars, calls };
  for (const item of content) {
    if (item === null || typeof item !== "object") continue;
    if (item.type === "text" && typeof item.text === "string") chars.prose += item.text.length;
    else if (item.type === "thinking" && typeof item.text === "string") {
      chars.thinking += item.text.length;
    } else if (item.type === "toolCall") {
      const args = JSON.stringify(item.arguments ?? {});
      chars.toolArgs += args.length;
      calls.push(typeof item.name === "string" ? item.name : "(unnamed)");
    }
  }
  return { chars, calls };
}

/** Characters a tool result put into the context window. */
function resultChars(message) {
  const content = message?.content;
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const item of content) {
    if (item === null || typeof item !== "object") continue;
    if (typeof item.text === "string") chars += item.text.length;
  }
  return chars;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** A tool row with every field present, so a reader never meets an undefined. */
function emptyRow(name) {
  return {
    name,
    calls: 0,
    results: 0,
    resultChars: 0,
    unconsumedResults: 0,
    tokens: { uncachedIn: 0, cachedIn: 0, cacheWrite: 0, out: 0 },
  };
}

// ── summarize one session ───────────────────────────────────────────────────

/**
 * Read one session's text into the summary the render and the JSON share.
 *
 * Walks the file once. `window` holds the tool results that entered the
 * context since the previous assistant message; it is reset when an assistant
 * message is charged, so no result is charged twice.
 */
export function summarizeSession(text, { file = "", malformed: malformedOverride } = {}) {
  const { entries, malformed } = parseSessionLines(text);
  const session = {
    file,
    sessionId: sessionIdOf(entries, file),
    models: {},
    providers: {},
    turns: { billed: 0, withoutUsage: 0, excludedAbortedOrError: 0 },
    totals: { uncachedIn: 0, cachedIn: 0, cacheWrite: 0, out: 0 },
    unknown: { uncachedIn: 0, cachedIn: 0, cacheWrite: 0, out: 0 },
    splitResidual: { uncachedIn: 0, cachedIn: 0, cacheWrite: 0, out: 0 },
    totalMismatches: 0,
    tools: [],
    content: { prose: 0, thinking: 0, toolArgs: 0 },
    unconsumedResults: 0,
    malformed: malformedOverride ?? malformed,
  };

  const rows = new Map();
  const row = (name) => {
    if (!rows.has(name)) rows.set(name, emptyRow(name));
    return rows.get(name);
  };

  /** Charge one assistant message's usage to the tools in its window. */
  const charge = (usage, window) => {
    const weights = new Map();
    for (const result of window) {
      const name = result.name;
      weights.set(name, (weights.get(name) ?? 0) + result.chars);
    }
    const names = weights.size > 0 ? [...weights.keys()] : [PROMPT_ROW];
    const scale = weights.size > 0 ? [...weights.values()] : [1];
    for (const name of names) row(name);

    for (const cls of CLASSES) {
      const value = num(usage?.[cls.field]);
      if (value === null) {
        session.unknown[cls.key] += 1;
        continue;
      }
      session.totals[cls.key] += value;
      const whole = Math.round(value);
      const parts = allocate(whole, scale);
      session.splitResidual[cls.key] += value - parts.reduce((a, b) => a + b, 0);
      names.forEach((name, i) => {
        rows.get(name).tokens[cls.key] += parts[i];
      });
    }
  };

  let window = [];
  for (const entry of entries) {
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message === null || typeof message !== "object") continue;

    if (message.role === "toolResult") {
      const name = typeof message.toolName === "string" ? message.toolName : "(unknown tool)";
      const chars = resultChars(message);
      const r = row(name);
      r.results += 1;
      r.resultChars += chars;
      window.push({ name, chars });
      continue;
    }

    if (message.role !== "assistant") continue;

    const { chars, calls } = contentChars(message);
    session.content.prose += chars.prose;
    session.content.thinking += chars.thinking;
    session.content.toolArgs += chars.toolArgs;
    for (const name of calls) row(name).calls += 1;
    if (typeof message.model === "string" && message.model !== "") {
      session.models[message.model] = (session.models[message.model] ?? 0) + 1;
    }
    if (typeof message.provider === "string" && message.provider !== "") {
      session.providers[message.provider] = (session.providers[message.provider] ?? 0) + 1;
    }

    if (message.stopReason === "aborted" || message.stopReason === "error") {
      session.turns.excludedAbortedOrError += 1;
    } else if (message.usage === undefined || message.usage === null) {
      session.turns.withoutUsage += 1;
    } else {
      session.turns.billed += 1;
      const recorded = num(message.usage.totalTokens);
      if (recorded !== null) {
        const parts = CLASSES.map((cls) => num(message.usage[cls.field])).filter((v) => v !== null);
        const classSum = parts.reduce((a, b) => a + b, 0);
        // Only a turn that reported every class can be compared: a provider
        // that omits a field would otherwise read as a mismatch.
        if (parts.length === CLASSES.length && recorded !== classSum) {
          session.totalMismatches += 1;
        }
      }
      charge(message.usage, window);
    }
    window = [];
  }

  for (const pending of window) {
    const r = row(pending.name);
    r.unconsumedResults += 1;
    session.unconsumedResults += 1;
  }

  session.tools = [...rows.values()].sort(
    (a, b) => sumTokens(b.tokens) - sumTokens(a.tokens) || a.name.localeCompare(b.name),
  );
  return session;
}

function sumTokens(tokens) {
  return CLASSES.reduce((a, cls) => a + tokens[cls.key], 0);
}

/** Session-level totals for a set of sessions, summed class by class. */
export function summarizeSessions(sessions) {
  const totals = { uncachedIn: 0, cachedIn: 0, cacheWrite: 0, out: 0 };
  const unknown = { uncachedIn: 0, cachedIn: 0, cacheWrite: 0, out: 0 };
  const tools = new Map();
  const turns = { billed: 0, withoutUsage: 0, excludedAbortedOrError: 0 };
  const content = { prose: 0, thinking: 0, toolArgs: 0 };
  let malformed = 0;
  for (const session of sessions) {
    for (const cls of CLASSES) {
      totals[cls.key] += session.totals[cls.key];
      unknown[cls.key] += session.unknown[cls.key];
    }
    for (const key of Object.keys(turns)) turns[key] += session.turns[key];
    for (const key of Object.keys(content)) content[key] += session.content[key];
    for (const tool of session.tools) {
      if (!tools.has(tool.name)) tools.set(tool.name, emptyRow(tool.name));
      const into = tools.get(tool.name);
      into.calls += tool.calls;
      into.results += tool.results;
      into.resultChars += tool.resultChars;
      into.unconsumedResults += tool.unconsumedResults;
      for (const cls of CLASSES) into.tokens[cls.key] += tool.tokens[cls.key];
    }
    malformed += session.malformed;
  }
  return {
    sessions,
    totals,
    unknown,
    turns,
    content,
    malformed,
    tools: [...tools.values()].sort(
      (a, b) => sumTokens(b.tokens) - sumTokens(a.tokens) || a.name.localeCompare(b.name),
    ),
  };
}

// ── price ───────────────────────────────────────────────────────────────────

/**
 * Price a totals object from caller-supplied rates, in USD per million tokens.
 *
 * Refuses rather than guesses: a class with nonzero tokens and no rate makes
 * the whole price null and names what is missing, because a total that silently
 * values one class at zero is a wrong number presented as a right one.
 */
export function priceTotals(totals, rates) {
  const lines = [];
  const missing = [];
  let total = 0;
  for (const cls of CLASSES) {
    const tokens = totals[cls.key] ?? 0;
    const rate = rates?.[cls.key];
    if (tokens === 0 && rate === undefined) continue;
    if (rate === undefined || rate === null) {
      if (tokens !== 0) missing.push({ key: cls.key, label: cls.label, tokens, flag: cls.rateFlag });
      continue;
    }
    const amount = round6((tokens * rate) / 1_000_000);
    total = round6(total + amount);
    lines.push({ key: cls.key, label: cls.label, tokens, rate, amount });
  }
  if (missing.length > 0) return { price: null, missing, lines };
  return { price: total, missing: [], lines };
}

/** Six decimals is a micro-dollar: finer than any rate a provider publishes. */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

export function hasAnyRate(rates) {
  return CLASSES.some((cls) => rates?.[cls.key] !== undefined);
}

// ── render ──────────────────────────────────────────────────────────────────

function fmtCount(v) {
  if (v === null || v === undefined) return "n/a";
  if (Math.abs(v) >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
  if (Math.abs(v) >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
  return String(v);
}

/** A token count that never claims a zero it did not read. */
function fmtTokens(value, unknownTurns, turns) {
  if (turns > 0 && unknownTurns >= turns) return "n/a";
  const text = String(value);
  return unknownTurns > 0 ? `${text} (${unknownTurns} turn(s) n/a)` : text;
}

function fmtShare(part, whole) {
  if (!whole) return "n/a";
  return `${((part / whole) * 100).toFixed(1)}%`;
}

function fmtUnit(v) {
  if (v === null || v === undefined) return "n/a";
  return `${v.toFixed(4)} USD`;
}

function fmtRate(rate) {
  return `${rate} USD/1M`;
}

function renderSession(session, { rates, indent = "  " }) {
  const out = [];
  const models = Object.keys(session.models);
  out.push(`${indent}session ${session.sessionId}${models.length > 0 ? ` (${models.join(", ")})` : ""}`);
  out.push(
    `${indent}  turns: ${session.turns.billed} billed, ${session.turns.withoutUsage} without usage` +
      (session.turns.excludedAbortedOrError > 0
        ? `, ${session.turns.excludedAbortedOrError} aborted/error (usage not counted)`
        : "") +
      (session.malformed > 0 ? `, ${session.malformed} malformed line(s)` : ""),
  );
  for (const cls of CLASSES) {
    const value = fmtTokens(session.totals[cls.key], session.unknown[cls.key], session.turns.billed);
    out.push(`${indent}  ${cls.label.padEnd(15)} ${value.padStart(24)}`);
  }
  const inputTotal = session.totals.uncachedIn + session.totals.cachedIn;
  // A share over a class no turn reported would print 0.0% for a field that
  // was never read: the same fabricated zero the class line refuses.
  const cachedShareUnreported =
    session.turns.billed > 0 && session.unknown.cachedIn >= session.turns.billed;
  out.push(
    `${indent}  ${"total".padEnd(15)} ${String(sumTokens(session.totals)).padStart(24)}` +
      `   cached share ${cachedShareUnreported ? "n/a" : fmtShare(session.totals.cachedIn, inputTotal)}`,
  );
  if (session.totalMismatches > 0) {
    out.push(
      `${indent}  recorded totalTokens disagreed with the class sum on ` +
        `${session.totalMismatches} turn(s); the class sum is what is printed`,
    );
  }
  for (const cls of CLASSES) {
    if (session.splitResidual[cls.key] !== 0) {
      out.push(
        `${indent}  ${cls.label}: per-tool rows carry a residual of ` +
          `${session.splitResidual[cls.key]} token(s) from rounding a recorded non-integer count`,
      );
    }
  }

  out.push(
    `${indent}  per tool (tokens charged to the results this tool left in the window):`,
  );
  const header = [
    "tool".padEnd(18),
    "calls".padStart(6),
    "results".padStart(8),
    "chars".padStart(10),
    ...CLASSES.map((cls) => cls.label.padStart(15)),
  ].join("");
  out.push(`${indent}    ${header}`);
  for (const tool of session.tools) {
    out.push(
      `${indent}    ` +
        [
          tool.name.padEnd(18),
          String(tool.calls).padStart(6),
          String(tool.results).padStart(8),
          String(tool.resultChars).padStart(10),
          ...CLASSES.map((cls) => String(tool.tokens[cls.key]).padStart(15)),
        ].join(""),
    );
  }
  if (session.unconsumedResults > 0) {
    out.push(
      `${indent}    ${session.unconsumedResults} result(s) never entered a window: the session ended ` +
        "before a turn read them",
    );
  }

  const c = session.content;
  const chars = c.prose + c.thinking + c.toolArgs;
  out.push(
    `${indent}  assistant characters (all turns): prose ${fmtCount(c.prose)} ` +
      `(${fmtShare(c.prose, chars)}), thinking ${fmtCount(c.thinking)} ` +
      `(${fmtShare(c.thinking, chars)}), tool arguments ${fmtCount(c.toolArgs)} ` +
      `(${fmtShare(c.toolArgs, chars)})`,
  );

  const priced = priceTotals(session.totals, rates);
  out.push(`${indent}  ${renderPriceLine(priced, rates, `${indent}    `)}`);
  return out;
}

/** One block of price lines: the total, or the refusal that names the gap. */
function renderPriceLine(priced, rates, indent) {
  if (!hasAnyRate(rates)) return "price: not requested (no --rate-* flag was given)";
  const lines = [];
  if (priced.price === null) {
    const named = priced.missing.map((m) => `${m.label} (${m.tokens} tokens, needs ${m.flag})`);
    lines.push(`price: n/a, no rate for ${named.join(", ")}`);
    if (priced.lines.length > 0) {
      lines.push(`${indent}the classes that do have a rate are not summed on their own:`);
      for (const line of priced.lines) lines.push(`${indent}  ${fmtLine(line)}`);
    }
    return lines.join("\n");
  }
  lines.push(`price: ${fmtUnit(priced.price)} at the rates supplied`);
  for (const line of priced.lines) lines.push(`${indent}${fmtLine(line)}`);
  return lines.join("\n");
}

function fmtLine(line) {
  return `${line.label}: ${line.tokens} tokens x ${fmtRate(line.rate)} = ${line.amount.toFixed(6)} USD`;
}

export function renderReport(summary, { target, limit = 5, rates = {} } = {}) {
  const out = [];
  out.push(`Session cost report: ${target}`);
  if (summary.sessions.length === 0) {
    out.push("  no session file at this path (nothing has run there yet)");
    return out.join("\n");
  }
  out.push(
    `  sessions: ${summary.sessions.length}` +
      (summary.malformed > 0 ? `, malformed lines: ${summary.malformed}` : "") +
      `, turns billed: ${summary.turns.billed}`,
  );

  const shown = limit > 0 ? summary.sessions.slice(0, limit) : summary.sessions;
  for (const session of shown) {
    out.push("");
    out.push(...renderSession(session, { rates }));
  }
  if (shown.length < summary.sessions.length) {
    out.push(
      `\n  showing ${shown.length} of ${summary.sessions.length} session(s); raise with --limit <n> (0 = all)`,
    );
  }

  if (summary.sessions.length > 1) {
    out.push("");
    out.push("  all sessions together");
    for (const cls of CLASSES) {
      out.push(
        `    ${cls.label.padEnd(15)} ${String(summary.totals[cls.key]).padStart(24)}` +
          (summary.unknown[cls.key] > 0 ? ` (${summary.unknown[cls.key]} turn(s) n/a)` : ""),
      );
    }
    const priced = priceTotals(summary.totals, rates);
    out.push(`    ${renderPriceLine(priced, rates, "      ")}`);
  }
  return out.join("\n");
}

// ── inputs ──────────────────────────────────────────────────────────────────

/** Every session file under `dir`: the directory itself, and one level down
 *  (pi's `<project-slug>/<session>.jsonl` layout). */
export function listSessionFiles(dir) {
  const files = [];
  const isJsonl = (name) => name.endsWith(".jsonl");
  let dirents;
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const dirent of dirents) {
    const path = join(dir, dirent.name);
    if (dirent.isFile() && isJsonl(dirent.name)) files.push(path);
    else if (dirent.isDirectory()) {
      let nested;
      try {
        nested = readdirSync(path, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const child of nested) {
        if (child.isFile() && isJsonl(child.name)) files.push(join(path, child.name));
      }
    }
  }
  return files;
}

/** Newest file first: the sessions a caller asks about are the recent ones. */
function byMtimeDesc(a, b) {
  const at = mtimeOf(a);
  const bt = mtimeOf(b);
  return bt - at || a.localeCompare(b);
}

function mtimeOf(file) {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * The session id a file declares on its first line, without parsing the rest.
 *
 * A census names ten sessions out of thousands, and reading every file whole
 * to answer "is this one of them" is the cost this avoids: the record is the
 * first line and the head is read in one 64KB call. A head that does not parse
 * returns "", which the caller treats as "match by file name only".
 */
function idFromHead(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buffer = Buffer.alloc(65536);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const head = buffer.subarray(0, read).toString("utf-8");
    const newline = head.indexOf("\n");
    const parsed = JSON.parse(newline === -1 ? head : head.slice(0, newline));
    if (parsed && parsed.type === "session" && typeof parsed.id === "string") return parsed.id;
  } catch {
    // An unreadable or truncated head is matched by file name only.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Closing a descriptor that is already gone is not a finding.
      }
    }
  }
  return "";
}

/**
 * Resolve the inputs to a list of session summaries.
 *
 * `--session` is a prefix filter over the id and the file name, so a caller can
 * name ten sessions in a census and get exactly those ten back. A file the
 * filter does not match is rejected on its first line, which is what keeps a
 * ten-session census from parsing every session on the disk.
 */
export function collectSessions(opts) {
  const problems = [];
  const summaries = [];
  let candidates = [];

  if (opts.files !== undefined && opts.files.length > 0) {
    for (const file of opts.files) candidates.push({ path: resolve(file), explicit: true });
  }
  if (opts.dir !== undefined) {
    for (const file of listSessionFiles(opts.dir).sort(byMtimeDesc)) {
      candidates.push({ path: file, explicit: false });
    }
  } else if (!opts.files || opts.files.length === 0) {
    for (const file of listSessionFiles(piSessionsDir()).sort(byMtimeDesc)) {
      candidates.push({ path: file, explicit: false });
    }
  }

  const matches = (path) =>
    opts.sessions.length === 0 ||
    opts.sessions.some((needle) => path.includes(needle) || idFromHead(path).includes(needle));

  for (const candidate of candidates) {
    if (opts.limit > 0 && summaries.length >= opts.limit) break;
    if (!matches(candidate.path)) continue;
    let text;
    try {
      text = readFileSync(candidate.path, "utf-8");
    } catch (err) {
      if (err.code === "ENOENT") {
        if (candidate.explicit) problems.push({ path: candidate.path, reason: "no such file" });
        continue;
      }
      problems.push({ path: candidate.path, reason: err.message });
      continue;
    }
    summaries.push(summarizeSession(text, { file: candidate.path }));
  }
  return { summaries, problems };
}

// ── cli ─────────────────────────────────────────────────────────────────────

const RATE_FLAGS = new Map(CLASSES.map((cls) => [cls.rateFlag, cls.key]));

export function parseArgs(argv) {
  const opts = { files: [], dir: undefined, sessions: [], json: false, limit: 5, rates: {} };
  const badRate = (flag, value) => {
    const parsed = Number(value);
    if (value === undefined || value.trim() === "" || !Number.isFinite(parsed) || parsed < 0) {
      return { error: `${flag} needs a non-negative number of USD per million tokens` };
    }
    return null;
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--file") {
      const value = argv[++i];
      if (value === undefined) return { error: "--file needs a path" };
      opts.files.push(value);
    } else if (arg === "--dir") {
      const value = argv[++i];
      if (value === undefined) return { error: "--dir needs a path" };
      opts.dir = value;
    } else if (arg === "--session") {
      const value = argv[++i];
      if (value === undefined) return { error: "--session needs an id" };
      opts.sessions.push(value);
    } else if (arg === "--limit") {
      const value = argv[++i];
      if (value === undefined || !/^\d+$/.test(value)) {
        return { error: "--limit needs a non-negative integer" };
      }
      opts.limit = Number(value);
    } else if (RATE_FLAGS.has(arg)) {
      const value = argv[++i];
      const problem = badRate(arg, value);
      if (problem) return problem;
      opts.rates[RATE_FLAGS.get(arg)] = Number(value);
    } else if (arg === "--json") opts.json = true;
    else if (arg === "-h" || arg === "--help") opts.help = true;
    else return { error: `unknown argument: ${arg}` };
  }
  return opts;
}

function resolveTarget(opts) {
  if (opts.files.length > 0 && opts.dir !== undefined) return `${opts.files.join(", ")}, ${opts.dir}`;
  if (opts.files.length > 0) return opts.files.join(", ");
  if (opts.dir !== undefined) return opts.dir;
  return piSessionsDir();
}

export function buildPayload(summary, { target, rates }) {
  return {
    generatedAt: new Date().toISOString(),
    target,
    rates: Object.keys(rates).length > 0 ? rates : null,
    sessions: summary.sessions.map((session) => {
      const priced = priceTotals(session.totals, rates);
      return {
        sessionId: session.sessionId,
        file: session.file,
        models: session.models,
        providers: session.providers,
        turns: session.turns,
        totals: session.totals,
        unknown: session.unknown,
        splitResidual: session.splitResidual,
        totalMismatches: session.totalMismatches,
        tools: session.tools,
        content: session.content,
        unconsumedResults: session.unconsumedResults,
        malformed: session.malformed,
        price: priced.price,
        missingRates: priced.missing,
      };
    }),
    totals: summary.totals,
    unknown: summary.unknown,
    turns: summary.turns,
    content: summary.content,
    tools: summary.tools,
    malformed: summary.malformed,
    price: summary.sessions.length > 0 ? priceTotals(summary.totals, rates) : null,
  };
}

function main(argv) {
  const opts = parseArgs(argv);
  if (opts.error) {
    console.error(`session-cost-report: ${opts.error}\n\n${USAGE}`);
    process.exit(2);
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }

  let target;
  try {
    target = resolveTarget(opts);
  } catch (err) {
    console.error(`session-cost-report: ${err.message}`);
    process.exit(2);
  }

  const { summaries, problems } = collectSessions(opts);
  for (const problem of problems) {
    console.error(`session-cost-report: ${problem.path}: ${problem.reason}`);
  }
  if (problems.length > 0 && summaries.length === 0) process.exit(2);

  const summary = summarizeSessions(summaries);
  if (opts.json) {
    console.log(JSON.stringify(buildPayload(summary, { target, rates: opts.rates }), null, 2));
    return;
  }
  console.log(renderReport(summary, { target, limit: opts.limit, rates: opts.rates }));
}

/**
 * True when this file is the process's entry point.
 *
 * Both sides are realpathed: argv[1] carries the spelling the caller used, and
 * on macOS `/tmp` is a symlink, so an unresolved comparison exits 0 having
 * printed nothing.
 */
function isEntryPoint() {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main(process.argv.slice(2));
}
