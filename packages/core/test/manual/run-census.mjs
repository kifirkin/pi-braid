#!/usr/bin/env node
/**
 * The `run` census: how much of the live bash corpus the tool absorbs, and (a
 * week later) how much of it the sessions actually moved.
 *
 * This is a measurement instrument, not a fixture. It reads the live session
 * corpus, which the core suite does not carry, and the suite never counts it
 * (test/manual is outside the runner's walked tree).
 *
 * The classification has one definition, printed with every run:
 *
 *   absorbable  A bash call is absorbable when `run` can express it as one call:
 *               one program and its arguments, either as written, or after
 *               stripping a leading comment line and the setup prefix a shell
 *               command uses to change context (`cd <dir> &&` and literal
 *               `NAME=value` assignments), because the tool carries that context
 *               in `cwd` and `env`. The remaining text has no unquoted shell
 *               operator or expansion (| & ; < > ` $ ~ \ * ? [ {), and the
 *               tool's own refusal check (findRefusal) accepts the argv. A
 *               setup value that needs expansion (`FOO=$BAR`) is not absorbable.
 *
 *   The class is an upper bound on what the tool takes: the destructive-escape
 *   refusal depends on a path and a workspace, and the corpus call does not
 *   carry either, so those calls are counted separately and not subtracted.
 *
 * Adoption, with --since <instant>: a session counts when its earliest row
 * timestamp is at or after the instant (the deploy you are measuring from). In
 * those sessions, adoption = run calls / (run calls + absorbable bash calls).
 * The numerator is what moved; the denominator is what could have.
 *
 * Stdin adoption, over the same window: a second arm answers whether program
 * source moved out of bash. Its class is printed with the numbers - a `run`
 * call carrying a non-empty `stdin`, against a bash call whose program (after
 * the same prelude strip) is `python`/`python3` and whose own arguments carry
 * `-c` or a heredoc. The denominator is an upper bound, as the absorbable
 * class is: a heredoc followed by another shell stage is counted here and no
 * argv tool can take it. A window holding no run call says so instead of
 * printing a ratio over nothing, because 0% reads as measured non-adoption.
 *
 * Run (after npm run build in packages/core):
 *   node test/manual/run-census.mjs
 *   node test/manual/run-census.mjs --since 2026-11-17T00:00:00Z
 *   node test/manual/run-census.mjs --asof 2026-11-16T00:00:00Z --mtime-before 2026-11-16T00:00:00Z
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { firstShellOnlyCharacter, tokenize } from "./run-shape.mjs";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}
const corpus = resolve(
  argValue("--corpus", join(homedir(), ".pi", "agent", "sessions")),
);
const asof = new Date(argValue("--asof", new Date().toISOString()));
const mtimeBeforeMs = Date.parse(argValue("--mtime-before", asof.toISOString()));
const since = args.includes("--since")
  ? Date.parse(argValue("--since", ""))
  : null;
if (args.includes("--since") && !Number.isFinite(since)) {
  console.error("--since needs an ISO instant");
  process.exit(2);
}

const { findRefusal, isGlobExpression, DESTRUCTIVE_VERBS } = await import(
  "../../dist/extensions/core/run-tool/run.js"
);

const TIME_LIMIT = 2_147_483_647;

/**
 * Strip the context a shell command sets up before its program: a leading
 * comment line, `cd <dir> &&` and literal environment assignments. Returns the
 * remaining command plus whether a prefix was stripped and whether a
 * destructive verb is present.
 */
function stripPrelude(command) {
  let rest = command.trim();
  let stripped = false;
  let cdTarget = null;
  for (;;) {
    const before = rest;
    if (/^#[^\n]*\n/.test(rest)) {
      rest = rest.replace(/^#[^\n]*\n/, "").trim();
      stripped = true;
    }
    const cd = rest.match(/^cd\s+(\S+)\s*&&\s*/);
    if (cd) {
      cdTarget = cd[1];
      rest = rest.slice(cd[0].length).trim();
      stripped = true;
    }
    const assignment = rest.match(/^[A-Za-z_][A-Za-z0-9_]*=[A-Za-z0-9_./:@%+-]*\s+/);
    if (assignment) {
      rest = rest.slice(assignment[0].length).trim();
      stripped = true;
    }
    if (rest === before) break;
  }
  return { rest, stripped, cdTarget };
}

/** Whether the tool can express this command as one call. */
function isAbsorbable(command) {
  const { rest, stripped } = stripPrelude(command);
  if (rest.includes("\n") || rest.includes("<<")) {
    return { absorbable: false, reason: "heredoc-or-multiline", stripped };
  }
  const shellOnly = firstShellOnlyCharacter(rest);
  if (shellOnly !== null) {
    return { absorbable: false, reason: `shell-only:${shellOnly}`, stripped };
  }
  const argv = tokenize(rest);
  if (argv.length === 0) return { absorbable: false, reason: "empty", stripped };
  if (argv.some((element) => element === "")) {
    return { absorbable: false, reason: "empty-element", stripped };
  }
  const refusal = findRefusal(
    { argv, timeout_ms: TIME_LIMIT },
    { cwd: process.cwd(), workspaceRoot: process.cwd() },
  );
  if (refusal) {
    return { absorbable: false, reason: `refused:${refusal.kind}`, stripped };
  }
  return {
    absorbable: true,
    argv,
    stripped,
    destructive: DESTRUCTIVE_VERBS.has(basename(argv[0])),
  };
}

/**
 * The python shape whose source `run` can carry in its `stdin` field: the
 * program is the interpreter and the code arrives as `-c` (separate or
 * attached) or as a heredoc body. Reads the command the same way the
 * absorbable class does (prelude stripped, first line tokenized), so the two
 * classes cannot disagree about which program a command runs. Returns the
 * shape, or null when the call is not that class.
 */
function pythonSourceShape(command) {
  const { rest } = stripPrelude(command);
  const argv = tokenize(rest.split("\n")[0]);
  if (argv.length === 0) return null;
  const program = basename(argv[0]);
  if (program !== "python" && program !== "python3") return null;
  const args = argv.slice(1);
  if (args.some((element) => element.startsWith("-c"))) return "-c";
  if (args.some((element) => element.startsWith("<<") && !element.startsWith("<<<"))) {
    return "heredoc";
  }
  return null;
}

function corpusFiles() {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".jsonl")) files.push(full);
    }
  };
  walk(corpus);
  return files
    .filter((file) => {
      try {
        return statSync(file).mtimeMs <= mtimeBeforeMs;
      } catch {
        return false;
      }
    })
    .sort();
}

const totals = {
  files: 0,
  bashCalls: 0,
  bashWithoutCommand: 0,
  runCalls: 0,
  runStdinCalls: 0,
  pythonSourceBashCalls: 0,
  absorbableStrict: 0,
  absorbableWithContext: 0,
  destructiveVerbsInClass: 0,
  starsInsideArguments: 0,
  questionsInsideArguments: 0,
  attrited: new Map(),
  sinceUnix: null,
  sinceSessions: 0,
  sinceRunCalls: 0,
  sinceRunStdinCalls: 0,
  sincePythonSourceBashCalls: 0,
  sinceAbsorbableBash: 0,
};

for (const file of corpusFiles()) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    continue;
  }
  totals.files++;
  const rows = [];
  for (const line of text.split("\n")) {
    if (!line.includes("toolCall")) continue;
    try {
      rows.push(JSON.parse(line));
    } catch {
      // A partially written line at the end of a live session is not a call.
    }
  }
  // The session's start is its first timestamped row, read before any counting
  // so a row cannot be judged against a start the reader has not reached yet.
  let start = null;
  for (const row of rows) {
    const timestamp = Date.parse(row?.timestamp ?? row?.message?.timestamp ?? "");
    if (Number.isFinite(timestamp)) {
      start = timestamp;
      break;
    }
  }
  const inWindow = since !== null && start !== null && start >= since;
  if (inWindow) totals.sinceSessions++;
  for (const row of rows) {
    const content = row?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const element of content) {
      if (element?.type !== "toolCall") continue;
      if (element.name === "run") {
        totals.runCalls++;
        if (inWindow) totals.sinceRunCalls++;
        const stdin = element?.arguments?.stdin;
        if (typeof stdin === "string" && stdin.length > 0) {
          totals.runStdinCalls++;
          if (inWindow) totals.sinceRunStdinCalls++;
        }
        continue;
      }
      if (element.name !== "bash") continue;
      totals.bashCalls++;
      const command = element?.arguments?.command;
      if (typeof command !== "string" || command.trim() === "") {
        totals.bashWithoutCommand++;
        continue;
      }
      if (pythonSourceShape(command) !== null) {
        totals.pythonSourceBashCalls++;
        if (inWindow) totals.sincePythonSourceBashCalls++;
      }
      const verdict = isAbsorbable(command);
      if (verdict.absorbable) {
        if (verdict.stripped) totals.absorbableWithContext++;
        else {
          totals.absorbableStrict++;
          totals.absorbableWithContext++;
        }
        if (verdict.destructive) totals.destructiveVerbsInClass++;
        // A star inside an argument is a pattern the program interprets (a grep
        // filter, a sed quantifier), which the tool passes through. These are
        // the calls a blanket glob refusal would have blocked.
        totals.starsInsideArguments += verdict.argv
          .slice(1)
          .filter((element) => element.includes("*") && !isGlobExpression(element))
          .length;
        totals.questionsInsideArguments += verdict.argv
          .slice(1)
          .filter((element) => element.includes("?")).length;
        if (inWindow) totals.sinceAbsorbableBash++;
      } else {
        totals.attrited.set(
          verdict.reason,
          (totals.attrited.get(verdict.reason) ?? 0) + 1,
        );
      }
    }
  }
}

const share = (part) => (totals.bashCalls === 0 ? 0 : (part / totals.bashCalls) * 100);
const stdinDefinition =
  "stdin adoption = run calls carrying a non-empty stdin string / (those + bash calls whose program is python or python3 and whose own arguments carry -c or a heredoc); the denominator is an upper bound, because a heredoc followed by another shell stage needs the shell";
let stdinAdoptionPercent = null;
let stdinAdoptionNote = null;
if (since !== null) {
  if (totals.sinceRunCalls === 0) {
    stdinAdoptionNote = "no run calls in the window";
  } else if (totals.sinceRunStdinCalls === 0) {
    stdinAdoptionNote = "no run calls carrying stdin in the window";
  } else if (totals.sincePythonSourceBashCalls === 0) {
    stdinAdoptionNote = "no python -c or heredoc bash calls in the window";
  } else {
    stdinAdoptionPercent = Number(
      (
        (totals.sinceRunStdinCalls /
          (totals.sinceRunStdinCalls + totals.sincePythonSourceBashCalls)) *
        100
      ).toFixed(2),
    );
  }
}
const summary = {
  corpus,
  asof: asof.toISOString(),
  mtimeBefore: new Date(mtimeBeforeMs).toISOString(),
  definition:
    "absorbable = one program and argv, after stripping a leading comment line and a literal cd/VAR= setup prefix; no unquoted | & ; < > ` $ ~ \\ * ? [ { ; run's refusal check accepts it; destructive-escape refusals are counted, not subtracted",
  files: totals.files,
  bashCalls: totals.bashCalls,
  bashWithoutCommand: totals.bashWithoutCommand,
  runCalls: totals.runCalls,
  runStdinCalls: totals.runStdinCalls,
  pythonSourceBashCalls: totals.pythonSourceBashCalls,
  absorbableStrict: totals.absorbableStrict,
  absorbableStrictShare: Number(share(totals.absorbableStrict).toFixed(2)),
  absorbableWithContext: totals.absorbableWithContext,
  absorbableWithContextShare: Number(
    share(totals.absorbableWithContext).toFixed(2),
  ),
  destructiveVerbsInClass: totals.destructiveVerbsInClass,
  starsInsideArguments: totals.starsInsideArguments,
  questionsInsideArguments: totals.questionsInsideArguments,
  attrition: Object.fromEntries(
    [...totals.attrited].sort((a, b) => b[1] - a[1]),
  ),
  since: since === null ? null : new Date(since).toISOString(),
  sinceSessions: since === null ? null : totals.sinceSessions,
  sinceRunCalls: since === null ? null : totals.sinceRunCalls,
  sinceRunStdinCalls: since === null ? null : totals.sinceRunStdinCalls,
  sincePythonSourceBashCalls: since === null ? null : totals.sincePythonSourceBashCalls,
  sinceAbsorbableBash: since === null ? null : totals.sinceAbsorbableBash,
  adoptionPercent:
    since === null
      ? null
      : totals.sinceRunCalls + totals.sinceAbsorbableBash === 0
        ? 0
        : Number(
            (
              (totals.sinceRunCalls /
                (totals.sinceRunCalls + totals.sinceAbsorbableBash)) *
              100
            ).toFixed(2),
          ),
  stdinDefinition,
  stdinAdoptionPercent,
  stdinAdoptionNote,
};

console.log("run census");
console.log("=========");
console.log(`corpus: ${summary.corpus}`);
console.log(
  `asof: ${summary.asof}  mtime-before: ${summary.mtimeBefore}`,
);
console.log(`files counted: ${summary.files}`);
console.log(`bash calls: ${summary.bashCalls}`);
console.log(
  `absorbable as written: ${summary.absorbableStrict} (${summary.absorbableStrictShare}% of bash calls)`,
);
console.log(
  `absorbable with cwd/env context: ${summary.absorbableWithContext} (${summary.absorbableWithContextShare}%)`,
);
console.log(
  `destructive verbs in the class (path check not applied): ${summary.destructiveVerbsInClass}`,
);
console.log(
  `arguments carrying a star inside a pattern: ${summary.starsInsideArguments}; carrying ?: ${summary.questionsInsideArguments}`,
);
console.log("");
console.log("attrition (first reason per call):");
for (const [reason, count] of Object.entries(summary.attrition)) {
  console.log(`  ${reason}: ${count}`);
}
if (since !== null) {
  console.log("");
  console.log(`sessions started at or after ${summary.since}: ${summary.sinceSessions}`);
  console.log(`  run calls: ${summary.sinceRunCalls}`);
  console.log(`  absorbable bash calls: ${summary.sinceAbsorbableBash}`);
  console.log(`  adoption: ${summary.adoptionPercent}%`);
  console.log("");
  console.log("stdin adoption (program source moved out of bash):");
  console.log(`  definition: ${stdinDefinition}`);
  console.log(`  run calls carrying stdin: ${summary.sinceRunStdinCalls}`);
  console.log(
    `  python -c or heredoc bash calls: ${summary.sincePythonSourceBashCalls}`,
  );
  if (summary.stdinAdoptionPercent === null) {
    console.log(`  ratio: ${summary.stdinAdoptionNote}`);
  } else {
    console.log(
      `  ratio: ${summary.stdinAdoptionPercent}% (${summary.sinceRunStdinCalls} of ${summary.sinceRunStdinCalls + summary.sincePythonSourceBashCalls})`,
    );
  }
} else {
  console.log("");
  console.log(
    "adoption: pass --since <deploy instant> to measure what moved after the tool shipped",
  );
}
console.log("");
console.log(JSON.stringify(summary, null, 2));
