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
 *   - a run command does anything else except install (`npm ci ...`), or
 *   - a `check:*` script declared in the root manifest never appears in the
 *     chain (a check outside `ci:check` can never fail the gate, which is how
 *     `npm run check:write-scope` was dropped from the chain once with both
 *     this gate and check-suite-coverage still clean).
 *
 * Install steps and setup actions are the only sanctioned extra work; every
 * other check belongs in `ci:check`. Other workflow files are not the quality
 * gate and are not inspected. The only scripts allowed outside the chain are
 * the advisory reporters in ADVISORY below, each verified to be unable to
 * fail: `--no-exit-code` must be an argument of every command in the script
 * body, read per segment (`&&`, `||`, `;`) with shell comments dropped. A
 * substring test over the whole body accepts `knip … || echo --no-exit-code`
 * (the flag is echoed; knip keeps its exit code) and `knip … # --no-exit-code`
 * (the flag is prose). The rule verifies that the flag is passed, not that
 * every command obeys it: an advisory entry has to own that claim in its
 * reason.
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
const manifestPath = join(root, "package.json");

const CHAIN = "npm run ci:check";

/**
 * `check:*` scripts deliberately outside the chain. Each must be advisory by
 * construction: every command in the script body is verified to pass
 * `--no-exit-code` as an argument of its own, so an entry cannot silently
 * exempt a check that can actually fail.
 */
const ADVISORY = new Map([
  [
    "check:deadcode",
    "knip --reporter json --no-exit-code: reports dead code, never fails",
  ],
]);

/** Drop shell comments: a `#` at a token start runs to the end of its line. */
function stripComments(body) {
  let out = "";
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote !== null) {
      out += ch;
      if (ch === "\\" && quote === '"') {
        out += body[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(body[i - 1]))) {
      const nl = body.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * The commands a script body runs, in order: split on the shell operators that
 * join them (`&&`, `||`, `;`), quotes respected. Every segment's exit code can
 * reach the chain's, so every segment is held to the advisory rule.
 */
function scriptSegments(body) {
  const segments = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (quote !== null) {
      current += ch;
      if (ch === "\\" && quote === '"') {
        current += body[i + 1] ?? "";
        i++;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      continue;
    }
    const pair = body.slice(i, i + 2);
    if (pair === "&&" || pair === "||" || ch === ";") {
      segments.push(current);
      current = "";
      if (ch !== ";") i++;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * The segments of an advisory body that do not pass `--no-exit-code` as an
 * argument of their own. Quoting the flag (`"--no-exit-code"`) still counts:
 * the shell hands the same argument to the command either way.
 */
function segmentsWithoutFlag(body) {
  const flagged = (segment) =>
    segment
      .split(/\s+/)
      .map((token) => token.replace(/^["']|["']$/g, ""))
      .includes("--no-exit-code");
  return scriptSegments(stripComments(body)).filter((segment) => !flagged(segment));
}

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

// ── the manifest's check scripts are all in the chain ───────────────────────

const manifest = existsSync(manifestPath)
  ? JSON.parse(readFileSync(manifestPath, "utf8"))
  : null;
if (!manifest?.scripts) {
  console.error(`check-ci-chain: ${manifestPath}: no scripts block`);
  process.exit(1);
}
const chainBody = manifest.scripts["ci:check"] ?? "";
/** Chain segments: `npm run <name>` plus optional flags is one segment. */
const chainSegments = chainBody.split("&&").map((s) => s.trim());
const chainRuns = (name) =>
  chainSegments.some(
    (seg) => seg === `npm run ${name}` || seg.startsWith(`npm run ${name} `),
  );

const missing = [];
for (const [name, body] of Object.entries(manifest.scripts)) {
  if (!name.startsWith("check:") || name === "check:ci-chain") continue;
  if (chainRuns(name)) continue;
  const advisory = ADVISORY.get(name);
  if (advisory === undefined) {
    missing.push(
      `${name}: declared in package.json but never run by ci:check (a check outside the chain can never fail the gate); add it to ci:check or record it in ADVISORY with a reason`,
    );
    continue;
  }
  const unflagged = segmentsWithoutFlag(body);
  if (unflagged.length > 0) {
    missing.push(
      `${name}: exempted as advisory (${advisory}) but ${unflagged
        .map((segment) => `"${segment}"`)
        .join(", ")} does not pass --no-exit-code; every command in the body must be unable to fail, since each segment's exit code can reach the chain`,
    );
  }
}
if (missing.length > 0) {
  console.error(`check-ci-chain: ${missing.length} check(s) outside the chain`);
  for (const problem of missing) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`check-ci-chain: clean (CI runs the single chain "${CHAIN}")`);
