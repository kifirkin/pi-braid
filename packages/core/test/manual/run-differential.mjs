#!/usr/bin/env node
/**
 * Differential control for the `run` tool: the same commands through bash and
 * through run must agree on exit code, stdout and stderr.
 *
 * This is a measurement instrument, not a fixture. It reads the live session
 * corpus, which the core suite does not carry, and the suite never counts it
 * (it lives outside the runner's walked tree, like the other manual probes).
 *
 * Sample rule, printed by every run:
 *   1. Corpus: every *.jsonl under ~/.pi/agent/sessions (or --corpus) whose
 *      mtime is at or before --mtime-before, which defaults to --asof, which
 *      defaults to the run's start. Two runs with the same arguments read the
 *      same files.
 *   2. A call is a `bash` toolCall with a non-empty string command.
 *   3. Simple: the command is one line with no heredoc, and an unquoted scan
 *      finds no shell operator (| & ; < >), no substitution (` or $( or $),
 *      no tilde, no backslash, and no filename-expansion character (* ? [ {).
 *      The scan is quote-aware: a character inside single or double quotes is
 *      literal to bash and is not a reason to reject the command.
 *   4. Safety: the program is on PATH and its basename is in READ_ONLY below
 *      (git is read-only only for the subcommands in GIT_READ). No argument is
 *      absolute or contains a `..` segment, so the command cannot reach outside
 *      the workspace. Shell builtins (echo, printf, pwd, type, test, [: ) are
 *      excluded: bash ran a builtin, while run would spawn a different binary of
 *      the same name, so the comparison would measure the binary rather than
 *      the tool.
 *   5. The tool's own refusal check (findRefusal) must accept the call. A
 *      command the tool refuses has no differential to measure.
 *   6. Deterministic order: candidates are sorted by sha256(command); identical
 *      command strings are taken once; at most 16 commands per program; the
 *      first --sample (120) are taken. The order does not depend on the
 *      filesystem walk order.
 *
 * Each sample runs twice in the same cwd with the same environment: once as
 * `/bin/bash -c <command>`, once through the tool's execution core with the
 * command tokenized into argv. Exit code, stdout bytes and stderr bytes must be
 * identical. A command that exceeds --timeout-ms in either arm, or whose
 * combined output exceeds 1 MiB, is excluded and counted, never silently
 * passed.
 *
 * Run (after npm run build in packages/core):
 *   node test/manual/run-differential.mjs
 *   node test/manual/run-differential.mjs --sample 120 --corpus ~/.pi/agent/sessions
 * Exit: 0 every sample matched, 1 at least one differed or no sample was found.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { firstShellOnlyCharacter, tokenize } from "./run-shape.mjs";

const args = process.argv.slice(2);
function argValue(flag, fallback) {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
}
const corpus = resolve(argValue("--corpus", join(homedir(), ".pi", "agent", "sessions")));
const asof = new Date(argValue("--asof", new Date().toISOString()));
const mtimeBefore = Date.parse(argValue("--mtime-before", asof.toISOString()));
const sampleSize = Number(argValue("--sample", "120"));
const timeoutMs = Number(argValue("--timeout-ms", "20000"));
const cwd = resolve(argValue("--cwd", process.cwd()));
const show = args.includes("--show");

const { findRefusal, executeArgv, isGlobExpression } = await import(
  "../../dist/extensions/core/run-tool/run.js"
);

const READ_ONLY = new Set([
  "basename",
  "cat",
  "cmp",
  "column",
  "cut",
  "diff",
  "dirname",
  "du",
  "file",
  "grep",
  "head",
  "hexdump",
  "hostname",
  "id",
  "jq",
  "ls",
  "md5",
  "nl",
  "od",
  "readlink",
  "realpath",
  "rev",
  "shasum",
  "sort",
  "stat",
  "strings",
  "tail",
  "tr",
  "tree",
  "uname",
  "uniq",
  "wc",
  "which",
  "whoami",
]);

const GIT_READ = new Set([
  "blame",
  "cat-file",
  "describe",
  "diff",
  "diff-tree",
  "for-each-ref",
  "log",
  "ls-files",
  "ls-tree",
  "merge-base",
  "name-rev",
  "reflog",
  "rev-list",
  "rev-parse",
  "shortlog",
  "show",
  "show-ref",
  "status",
  "whatchanged",
]);

const hash = (text) => createHash("sha256").update(text).digest("hex");

/** Walk every session file, stopping at the freeze. */
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
  return files.filter((file) => {
    try {
      return statSync(file).mtimeMs <= mtimeBefore;
    } catch {
      return false;
    }
  });
}

/** Every bash command in the frozen corpus. */
function bashCommands(files) {
  const commands = [];
  for (const file of files) {
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      if (!line.includes("toolCall")) continue;
      let row;
      try {
        row = JSON.parse(line);
      } catch {
        continue;
      }
      const content = row?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const element of content) {
        if (element?.type !== "toolCall" || element?.name !== "bash") continue;
        const command = element?.arguments?.command;
        if (typeof command !== "string" || command.trim() === "") continue;
        commands.push(command);
      }
    }
  }
  return commands;
}

/** Absolute path of a program on PATH, or null. */
function resolveOnPath(program) {
  if (program.includes("/")) return existsSync(program) ? program : null;
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir === "") continue;
    const candidate = join(dir, program);
    try {
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory of PATH; keep looking.
    }
  }
  return null;
}

/** The allowlist gate, including git's read-only subcommands. */
function allowedProgram(argv) {
  const program = basename(argv[0]);
  if (program === "git") {
    const sub = argv.slice(1).find((element) => !element.startsWith("-"));
    return sub !== undefined && GIT_READ.has(sub);
  }
  return READ_ONLY.has(program);
}

/** Why a candidate is out of scope, or null when it is in. */
function exclusionReason(command, argv) {
  if (command.includes("\n") || command.includes("<<")) return "heredoc-or-multiline";
  const shellOnly = firstShellOnlyCharacter(command);
  if (shellOnly !== null) return `shell-only:${shellOnly}`;
  if (argv.length === 0) return "empty-argv";
  if (argv.some((element) => element === "")) return "empty-element";
  if (!resolveOnPath(argv[0])) return "not-on-path";
  if (!allowedProgram(argv)) return "not-read-only";
  if (
    argv.slice(1).some(
      (element) => element.startsWith("/") || element.split("/").includes(".."),
    )
  ) {
    return "reaches-outside-workspace";
  }
  if (argv.slice(1).some(isGlobExpression)) return "glob";
  const refusal = findRefusal(
    { argv, timeout_ms: timeoutMs },
    { cwd, workspaceRoot: cwd },
  );
  if (refusal) return `tool-refuses:${refusal.kind}`;
  return null;
}

/** Run a command through bash, with a hard timeout and byte capture. */
function runBash(command) {
  return new Promise((settle) => {
    const startedAt = Date.now();
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }, timeoutMs);
    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));
    child.on("error", () => {
      clearTimeout(timer);
      settle({ exitCode: null, stdout: "", stderr: "", timedOut });
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      settle({
        exitCode: code,
        signal,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/** Run a command through the tool's own execution core. */
async function runTool(argv) {
  const startedAt = Date.now();
  const capture = await executeArgv(
    { argv, timeout_ms: timeoutMs },
    { cwd, workspaceRoot: cwd },
  );
  const read = (file) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  return {
    exitCode: capture.exitCode,
    signal: capture.signal,
    stdout: read(capture.stdoutPath),
    stderr: read(capture.stderrPath),
    timedOut: capture.timedOut,
    durationMs: Date.now() - startedAt,
    discard: () => {
      // The capture directory is this instrument's to remove.
      rmSync(capture.captureDir, { recursive: true, force: true });
    },
  };
}

/** First difference between two strings, as one readable line. */
function firstDifference(left, right) {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index++;
  const window = (text) => JSON.stringify(text.slice(index, index + 120));
  return `at byte ${Buffer.byteLength(left.slice(0, index))}: bash ${window(left)} vs run ${window(right)}`;
}

const files = corpusFiles();
const commands = bashCommands(files);
const candidates = [];
const excluded = new Map();
for (const command of commands) {
  const argv = tokenize(command);
  const reason = exclusionReason(command, argv);
  if (reason !== null) {
    excluded.set(reason, (excluded.get(reason) ?? 0) + 1);
    continue;
  }
  candidates.push({ command, argv, digest: hash(command) });
}

candidates.sort((a, b) => (a.digest < b.digest ? -1 : a.digest > b.digest ? 1 : 0));
const perProgram = new Map();
const sample = [];
const seen = new Set();
for (const candidate of candidates) {
  if (sample.length >= sampleSize) break;
  if (seen.has(candidate.command)) continue;
  seen.add(candidate.command);
  const program = basename(candidate.argv[0]);
  const used = perProgram.get(program) ?? 0;
  if (used >= 16) continue;
  perProgram.set(program, used + 1);
  sample.push(candidate);
}

const differences = [];
let compared = 0;
let skipped = 0;
for (const { command, argv, digest } of sample) {
  const viaBash = await runBash(command);
  if (
    viaBash.timedOut ||
    Buffer.byteLength(viaBash.stdout) + Buffer.byteLength(viaBash.stderr) > 1_048_576
  ) {
    skipped++;
    continue;
  }
  const viaTool = await runTool(argv);
  viaTool.discard();
  if (viaTool.timedOut) {
    skipped++;
    continue;
  }
  compared++;
  const sameExit = viaBash.exitCode === viaTool.exitCode;
  const sameOut = viaBash.stdout === viaTool.stdout;
  const sameErr = viaBash.stderr === viaTool.stderr;
  if (sameExit && sameOut && sameErr) continue;
  differences.push({
    digest,
    program: basename(argv[0]),
    exit: `${viaBash.exitCode} vs ${viaTool.exitCode}`,
    stdout: sameOut ? "same" : firstDifference(viaBash.stdout, viaTool.stdout),
    stderr: sameErr ? "same" : firstDifference(viaBash.stderr, viaTool.stderr),
    command: show ? command : undefined,
  });
}

console.log("run differential control");
console.log("========================");
console.log(`corpus: ${corpus}`);
console.log(`asof: ${asof.toISOString()}  mtime-before: ${new Date(mtimeBefore).toISOString()}`);
console.log(`workspace: ${cwd}`);
console.log(`files counted: ${files.length}`);
console.log(`bash commands: ${commands.length}`);
console.log(`candidates after the rule: ${candidates.length}`);
console.log("");
console.log("excluded before sampling (first reason per command):");
for (const [reason, count] of [...excluded].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${reason}: ${count}`);
}
console.log("");
console.log("sample rule: one line, no heredoc, no unquoted shell operator or");
console.log("  substitution, program on PATH and read-only, no absolute or ..");
console.log("  path, run accepts the call; sha256 order, one per command string,");
console.log("  at most 16 per program, first " + sampleSize + ".");
console.log("");
console.log(
  `sampled: ${sample.length}  programs: ${perProgram.size}  compared: ${compared}  skipped (timeout/oversize): ${skipped}`,
);
console.log(`identical exit code, stdout and stderr: ${compared - differences.length}/${compared}`);
if (differences.length > 0) {
  console.log("");
  console.log("differences:");
  for (const difference of differences) {
    console.log(`  ${difference.digest.slice(0, 12)} ${difference.program}`);
    console.log(`    exit: ${difference.exit}`);
    console.log(`    stdout: ${difference.stdout}`);
    console.log(`    stderr: ${difference.stderr}`);
    if (difference.command !== undefined) {
      console.log(`    command: ${JSON.stringify(difference.command)}`);
    }
  }
}
// The bar's floor: fewer than 100 compared commands is not a pass, however
// many of them agreed.
const REQUIRED_SAMPLE = 100;
if (compared < REQUIRED_SAMPLE) {
  console.log("");
  console.log(`refusing: ${compared} compared, the control requires ${REQUIRED_SAMPLE}`);
}
process.exitCode =
  differences.length === 0 && compared >= REQUIRED_SAMPLE ? 0 : 1;
