#!/usr/bin/env node
/**
 * check-ci-chain.mjs — the quality gate is one chain.
 *
 * The local gate is the root `ci:check` script. The CI quality workflow
 * (`.github/workflows/ci.yml`) must run that same chain and must not re-list
 * individual checks: a check present in one chain only can never fail the
 * other, which is exactly how the two chains drifted (nine checks ran locally
 * but never in CI, one ran in CI but never locally).
 *
 * This gate reads `.github/workflows/ci.yml`, extracts each `run:` command,
 * and fails when:
 *   - no run command invokes `npm run ci:check`, or
 *   - a run command does anything else except install (`npm ci ...`).
 *
 * Install steps and setup actions are the only sanctioned extra work; every
 * other check belongs in `ci:check`. Other workflow files are not the quality
 * gate and are not inspected.
 *
 * Usage: node packages/core/scripts/check-ci-chain.mjs
 * Exit code: 0 = one chain, 1 = drift
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..", "..", "..");
const workflow = join(root, ".github", "workflows", "ci.yml");

const CHAIN = "npm run ci:check";
/** A run command is sanctioned when it is the chain or an install. */
function isSanctioned(command) {
  return command === CHAIN || /^npm ci(\s|$)/.test(command);
}

/** Single-line `run:` values. Block scalars are reported, never guessed at. */
function runCommands(text) {
  const commands = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(/^\s*run:\s*(.*)$/);
    if (!match) continue;
    const raw = match[1].trim();
    if (raw === "" || raw === "|" || raw === ">" || raw === "|-" || raw === ">-") {
      commands.push({ line: i + 1, value: null, block: true });
      continue;
    }
    commands.push({ line: i + 1, value: raw.replace(/^["']|["']$/g, ""), block: false });
  }
  return commands;
}

const problems = [];

if (!existsSync(workflow)) {
  problems.push(`${workflow}: the quality workflow is missing`);
} else {
  const commands = runCommands(readFileSync(workflow, "utf8"));
  let chains = 0;
  for (const { line, value, block } of commands) {
    if (block) {
      problems.push(`ci.yml:${line}: block-scalar "run:" is not inspected; use a one-line command`);
      continue;
    }
    if (value === CHAIN) {
      chains += 1;
      continue;
    }
    if (!isSanctioned(value)) {
      problems.push(
        `ci.yml:${line}: "${value}" runs outside the chain; move it into ci:check or drop it`,
      );
    }
  }
  if (chains !== 1) problems.push(`ci.yml: expected exactly one "${CHAIN}" invocation, found ${chains}`);
}

if (problems.length > 0) {
  console.error(`check-ci-chain: ${problems.length} problem(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}
console.log(`check-ci-chain: clean (CI runs the single chain "${CHAIN}")`);
