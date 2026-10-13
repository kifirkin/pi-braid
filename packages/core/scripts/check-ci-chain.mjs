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
 * fail: `--no-exit-code` must be an argument of its own in every command of
 * the script body. Commands are the segments between the shell's command
 * boundaries (`&&`, `||`, `;`, a newline, `&` or `|`), with shell comments
 * dropped, and each segment is split into shell-style arguments, so a quoted
 * run is one argument: `"--no-exit-code"` counts (the shell hands the command
 * the same argument), while `"json --no-exit-code"` and `" --no-exit-code"`
 * do not. Splitting at every boundary is deliberately stricter than the
 * shell's exit-code flow: a segment whose failure cannot, on its own, reach
 * the chain's exit code (an earlier line of a newline-separated body, an
 * earlier stage of a pipeline) still has to carry the flag. A test over the
 * whole body would accept `knip … || echo --no-exit-code` (the flag is
 * echoed; knip keeps its exit code) and `knip … # --no-exit-code` (the flag
 * is prose). The rule verifies that the flag is passed, not that every
 * command obeys it: an advisory entry has to own that claim in its reason.
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
 * The commands a script body runs, in order: split on the shell's command
 * boundaries (`&&`, `||`, `;`, a newline, `&` or `|`), quotes respected.
 * Splitting at every boundary keeps the rule fail-closed: a segment whose
 * failure cannot, on its own, reach the script's exit code (an earlier line
 * of a newline-separated body, an earlier stage of a pipeline) still has to
 * carry the flag.
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
    const boundary =
      pair === "&&" || pair === "||" || ch === ";" || ch === "\n" || ch === "&" || ch === "|";
    if (boundary) {
      segments.push(current);
      current = "";
      if (pair === "&&" || pair === "||") i++;
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * A command's shell-style arguments: whitespace separates them, a quoted run
 * is one argument with its quotes removed, and a run that adjoins quoted and
 * unquoted text stays one argument. `"--no-exit-code"` is the flag itself;
 * `"json --no-exit-code"` is one longer argument, never the flag.
 */
function shellArgs(segment) {
  const args = [];
  let current = "";
  let started = false;
  let quote = null;
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i];
    if (quote === '"' && ch === "\\") {
      const next = segment[i + 1];
      if (next !== undefined) {
        current += next;
        i++;
        continue;
      }
    }
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (started) args.push(current);
      current = "";
      started = false;
      continue;
    }
    current += ch;
    started = true;
  }
  if (started) args.push(current);
  return args;
}

/**
 * The segments of an advisory body that do not pass `--no-exit-code` as an
 * argument of their own. Quoting the flag (`"--no-exit-code"`) still counts:
 * the shell hands the command the same argument either way.
 */
function segmentsWithoutFlag(body) {
  return scriptSegments(stripComments(body)).filter(
    (segment) => !shellArgs(segment).includes("--no-exit-code"),
  );
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
