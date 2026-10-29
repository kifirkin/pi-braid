#!/usr/bin/env node
/**
 * check-source-claims.mjs - every count a document states is re-derived, not trusted.
 *
 * Why this exists: a count is the cheapest thing to carry from one document into
 * another and the hardest drift to see. The copy arrives without the command that
 * produced it, so a reader cannot tell a measured number from a remembered one,
 * and a stale number reads exactly like a fresh one. This gate re-runs the command
 * behind each enrolled count and compares it with what the document says, so a
 * wrong count fails a run instead of travelling.
 *
 * The registry (`source-claims.json`, beside this script) holds one entry per
 * count the gate governs: the file and the line the count sits on, a pattern that
 * reads it out of that line, and the command that derives it from the tree
 * together with a pattern that reads the derived number out of that command's
 * output. The registry stores no number. The document holds the only copy, so an
 * entry cannot pass by agreeing with a copy of itself, and the command stays the
 * source of truth.
 *
 * Both directions are problems, and neither is ever skipped:
 *   - the document states one number and the command derives another;
 *   - the command cannot be re-run: it is absent, it exits non-zero, it does not
 *     finish inside COMMAND_TIMEOUT_MS, or its output carries no number to
 *     compare. An entry the gate cannot execute is refused, never passed over: a
 *     registry that skipped what it could not run would be disarmed while
 *     printing green, which is worse than no gate, because the entry would still
 *     look checked.
 *
 * What an entry cannot be: a count no command re-derives. An entry that stores
 * the expected number and runs nothing is the same drift with a gate painted on
 * it, so the registry has no field for one, and a count that only a measurement
 * produced (a duration, a load average, a figure from a released changelog) is
 * not enrolable at all - the tree no longer holds the input the command read.
 *
 * Reading a number: a token is an Arabic numeral, or an English number word from
 * one to twenty, because prose states a small count in words (`twelve child
 * drivers`) and a gate that read only digits would govern only the counts a
 * writer happened to spell numerically. Each output line is trimmed before its
 * pattern is applied, since `wc -l` pads its number with spaces.
 *
 * A command must exit 0 to count as re-derived. A command that reports failure
 * while printing a number (`grep -c` exits 1 on a zero count) is refused as
 * broken rather than read: failing loudly is the conservative direction, and the
 * message carries the command and its exit status so the reader can tell a
 * broken command from a wrong count.
 *
 * The claim must sit on the recorded line. A document that grows above the claim
 * moves it, and a registry whose pointer is stale sends the next reader to the
 * wrong line; the message names the line the claim is actually on.
 *
 * Usage: node scripts/check-source-claims.mjs [--root <dir>] [--registry <path>]
 *   --root      the tree the commands run in and the document paths resolve
 *               against (default: this package, packages/core)
 *   --registry  the claim registry (default: source-claims.json beside this script)
 *
 * Exit codes: 0 = every enrolled count re-derived, 1 = at least one problem.
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(here, "..");
const DEFAULT_REGISTRY = resolve(here, "source-claims.json");

/** A command that has not printed by now is a command that cannot be re-derived. */
const COMMAND_TIMEOUT_MS = 60_000;

/**
 * English number words a prose claim may state instead of a numeral, one to
 * twenty. Above twenty a writer spells the numeral, so the table stops there.
 */
const NUMBER_WORDS = new Map([
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
]);

/** A `--name value` or `--name=value` flag's value; undefined when absent. */
function flagValue(name) {
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === `--${name}`) return argv[i + 1];
    if (argv[i].startsWith(`--${name}=`)) return argv[i].slice(name.length + 3);
  }
  return undefined;
}

const root = resolve(flagValue("root") ?? DEFAULT_ROOT);
const registryPath = resolve(flagValue("registry") ?? DEFAULT_REGISTRY);

const problems = [];

/** The number a token states, or null when it is neither a numeral nor a word. */
function numberValue(token) {
  const trimmed = token.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed);
  return NUMBER_WORDS.get(trimmed.toLowerCase()) ?? null;
}

/** The last non-empty line of a command's stderr, so a failure can name its cause. */
function stderrTail(text) {
  const lines = (text ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.length === 0 ? "" : lines[lines.length - 1].slice(0, 300);
}

/** A compiled pattern, or null with a problem recorded: an uncompilable pattern checks nothing. */
function compile(pattern, where) {
  try {
    return new RegExp(pattern, "g");
  } catch (error) {
    problems.push(`${where}: the pattern /${pattern}/ does not compile (${error.message})`);
    return null;
  }
}

/** Every way an entry is not an entry, so a malformed claim is refused rather than skipped. */
function shapeProblems(entry, where) {
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    return [`${where}: expected an object`];
  }
  const out = [];
  if (typeof entry.id !== "string" || entry.id.trim() === "") {
    out.push(`${where}: no "id"`);
  }
  if (typeof entry.claim !== "string" || entry.claim.trim() === "") {
    out.push(`${where}: no "claim" naming the number it governs`);
  }
  const stated = entry.stated;
  if (stated === null || typeof stated !== "object" || Array.isArray(stated)) {
    out.push(`${where}: no "stated" block naming where the number is written`);
  } else {
    if (typeof stated.file !== "string" || stated.file.trim() === "") {
      out.push(`${where}: stated.file is missing`);
    }
    if (!Number.isInteger(stated.line) || stated.line < 1) {
      out.push(`${where}: stated.line must be a line number`);
    }
    if (typeof stated.pattern !== "string" || stated.pattern === "") {
      out.push(`${where}: stated.pattern is missing`);
    } else if (compile(stated.pattern, where) === null) {
      out.push(`${where}: stated.pattern is unusable, so the entry cannot be read`);
    }
  }
  const derived = entry.derived;
  if (derived === null || typeof derived !== "object" || Array.isArray(derived)) {
    out.push(`${where}: no "derived" block, so nothing re-derives the number`);
  } else {
    if (typeof derived.cmd !== "string" || derived.cmd.trim() === "") {
      out.push(`${where}: derived.cmd is missing, so nothing re-derives the number`);
    }
    if (typeof derived.pattern !== "string" || derived.pattern === "") {
      out.push(`${where}: derived.pattern is missing`);
    } else if (compile(derived.pattern, where) === null) {
      out.push(`${where}: derived.pattern is unusable, so the entry cannot be read`);
    }
  }
  return out;
}

/** The number the document states, with the line it was found on. */
function readStated(entry) {
  const { file, line, pattern } = entry.stated;
  const path = resolve(root, file);
  if (!existsSync(path)) {
    return { problem: `${file}: the document a claim names does not exist` };
  }
  const re = compile(pattern, `${file}:${line}`);
  if (re === null) return { problem: `${file}:${line}: the stated pattern is unusable` };
  const lines = readFileSync(path, "utf8").split("\n");
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    re.lastIndex = 0;
    const match = re.exec(lines[i]);
    if (match !== null) hits.push({ line: i + 1, match });
  }
  if (hits.length === 0) {
    return { problem: `${file}: no line matches the stated pattern /${pattern}/ - the claim is gone, so nothing is checked` };
  }
  if (hits.length > 1) {
    const at = hits.map((hit) => hit.line).join(", ");
    return { problem: `${file}:${at}: ${hits.length} lines match the stated pattern /${pattern}/ - an entry points at one statement` };
  }
  const [hit] = hits;
  if (hit.line !== line) {
    return { problem: `${file}:${hit.line}: the claim is on this line, the registry records line ${line} - update the entry's stated.line` };
  }
  const token = hit.match[1];
  if (token === undefined) {
    return { problem: `${file}:${line}: the stated pattern /${pattern}/ captures nothing, so there is no number to compare` };
  }
  const value = numberValue(token);
  if (value === null) {
    return { problem: `${file}:${line}: "${token}" is not a number this gate can read (a numeral, or an English number word from one to twenty)` };
  }
  return { value, token };
}

/** The number the entry's command derives from the tree, or why it cannot be re-derived. */
function deriveNumber(entry) {
  const { cmd, pattern } = entry.derived;
  const result = spawnSync("sh", ["-c", cmd], {
    cwd: root,
    encoding: "utf8",
    timeout: COMMAND_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) {
    const reason =
      result.error.code === "ETIMEDOUT"
        ? `did not finish inside ${COMMAND_TIMEOUT_MS}ms`
        : `could not be started (${result.error.message})`;
    return { problem: `the command ${reason}, so the number cannot be re-derived; command: ${cmd}` };
  }
  if (result.status !== 0) {
    const tail = stderrTail(result.stderr);
    const how = result.status === null ? `died on ${result.signal ?? "a signal"}` : `exit ${result.status}`;
    return {
      problem: `the command cannot run (${how})${tail === "" ? "" : `: ${tail}`}; command: ${cmd}`,
    };
  }
  const re = compile(pattern, `derived pattern for ${entry.id}`);
  if (re === null) return { problem: `the derived pattern is unusable; command: ${cmd}` };
  const hits = [];
  for (const raw of (result.stdout ?? "").split("\n")) {
    const line = raw.trim();
    re.lastIndex = 0;
    const match = re.exec(line);
    if (match !== null) hits.push({ line, match });
  }
  if (hits.length === 0) {
    const tail = stderrTail(result.stderr);
    return {
      problem: `the command printed no number matching /${pattern}/${tail === "" ? "" : ` (stderr: ${tail})`}, so the claim is not re-derived; command: ${cmd}`,
    };
  }
  if (hits.length > 1) {
    const found = hits.map((hit) => hit.match[1] ?? hit.line).join(", ");
    return { problem: `the command printed ${hits.length} numbers matching /${pattern}/ (${found}) - an entry reads one; command: ${cmd}` };
  }
  const [hit] = hits;
  const token = hit.match[1];
  if (token === undefined) {
    return { problem: `the derived pattern /${pattern}/ captures nothing, so there is no number to compare; command: ${cmd}` };
  }
  const value = numberValue(token);
  if (value === null) {
    return { problem: `the command printed "${token}", which is not a number this gate can read; command: ${cmd}` };
  }
  return { value, token };
}

// ── the registry ────────────────────────────────────────────────────────────

let registry = null;
if (!existsSync(registryPath)) {
  problems.push(`${registryPath}: the claim registry is missing`);
} else {
  try {
    registry = JSON.parse(readFileSync(registryPath, "utf8"));
  } catch (error) {
    problems.push(`${registryPath}: the registry does not parse (${error.message})`);
  }
}

const claims = registry === null ? [] : registry?.claims;
if (registry !== null && !Array.isArray(claims)) {
  problems.push(`${registryPath}: expected a "claims" array, so no entry can be read`);
}
const entries = Array.isArray(claims) ? claims : [];
if (Array.isArray(claims) && claims.length === 0) {
  problems.push(
    `${registryPath}: the registry enrolls no claim, so it re-derives nothing and would print green over any document`,
  );
}

// ── every enrolled count, re-derived ────────────────────────────────────────

const seen = new Set();
const documents = new Set();
let verified = 0;

for (const [index, entry] of entries.entries()) {
  const where = `${basename(registryPath)}: claim #${index + 1}`;
  const malformed = shapeProblems(entry, where);
  if (typeof entry?.id === "string" && entry.id.trim() !== "") {
    if (seen.has(entry.id)) {
      malformed.push(`${where}: duplicate id "${entry.id}" - an id names one claim`);
    }
    seen.add(entry.id);
  }
  if (malformed.length > 0) {
    problems.push(...malformed);
    continue;
  }

  const stated = readStated(entry);
  if (stated.problem !== undefined) {
    problems.push(stated.problem);
    continue;
  }
  const derived = deriveNumber(entry);
  if (derived.problem !== undefined) {
    problems.push(`${entry.stated.file}:${entry.stated.line} (${entry.claim}): ${derived.problem}`);
    continue;
  }

  documents.add(entry.stated.file);
  if (stated.value !== derived.value) {
    problems.push(
      `${entry.stated.file}:${entry.stated.line} (${entry.claim}): states ${stated.token}, the command derives ${derived.token}; command: ${entry.derived.cmd}`,
    );
    continue;
  }
  verified += 1;
}

if (problems.length > 0) {
  console.error(`check-source-claims: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(
  `check-source-claims: clean - ${verified} stated count(s) re-derived from ${documents.size} document(s), registry ${basename(registryPath)}`,
);
