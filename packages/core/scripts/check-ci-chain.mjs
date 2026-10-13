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
 * do not. A comment is a `#` that begins a word — at the start of the body,
 * after whitespace, or after one of the metacharacters `;`, `&`, `|` and `(`
 * — and runs to the end of its line; a `#` after `{`, `}`, `=`, a word
 * character or a backslash-escaped character stays in the word in `sh`, `bash`
 * and `dash` (zsh reads `{#` as a comment — a divergence the gate does not
 * follow). The shells
 * also begin a comment after `)` and after a redirection operator; the gate
 * leaves those in the word, because what such a comment leaves behind (a
 * stray `)` or a redirection with no target) is not modelled, and reading it
 * as a comment could accept a body the shells refuse. The argument model
 * follows the shells inside double quotes: only `$`, a backtick, `"`, `\` and
 * a newline are escaped there, so a backslash before any other character
 * stays literal and `"\-\-no-exit-code"` is the argument `\-\-no-exit-code`,
 * not the flag. Outside quotes a backslash quotes the next character, so
 * `\(`, `\{`, `\;` and `\&` are word characters — never a group token or a
 * boundary — and `knip … \(` is the one command the shells run. A body the
 * shell cannot parse is refused rather than read — an open quote, a leading
 * boundary operator, a
 * body ending on `&&`, `||` or `|` (a trailing newline does not complete one),
 * and an opening `(` or `{` group token that is never closed are `sh -c`
 * syntax errors — because no command runs, and an exemption over no command
 * verifies nothing. The remaining unparsed shapes stay accepted and are read
 * as what they lexically are: a stray `)` or `}` with no open (a `)` delimits
 * a case pattern and a `}` can be an argument), a `(` that is not in a
 * command position (`knip … ( ; echo --no-exit-code )`, a syntax error in
 * every shell, read as segments with the `(` and `)` left where they stand),
 * the `((…))` arithmetic spelling (`knip … ((1+1))`: a syntax error in sh,
 * bash and dash, arithmetic to zsh, and balanced in every shell), a `case`
 * region (`case x in x) knip …`: the pattern's `)` reads as a stray close and
 * the missing `esac` is not a token the splitter knows), an empty command
 * between boundaries (`knip … && ; knip …`, and `;;` read as two boundaries
 * with nothing between them), an unclosed `${…}` expansion, and a
 * heredoc's body, which is read as commands rather than as its own text.
 * Splitting
 * at every boundary is deliberately stricter than the shell's exit-code flow:
 * a segment whose failure cannot, on its own, reach
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
 * Inside double quotes, a backslash escapes only these characters (POSIX
 * 2.2.3); before any other character it stays literal.
 */
const DQ_ESCAPABLE = new Set(["$", "`", '"', "\\", "\n"]);

/** The boundary operators a command must follow. */
const DANGLING_BOUNDARY = new Set(["&&", "||", "|"]);

/**
 * A `{` or `}` is a grouping token only as a word of its own at a command
 * position (`{ cmd; }`, `f() { cmd; }`); inside a word it is brace expansion
 * (`x={a,b}`) or an expansion (`${VAR}`), which the shells run. A newline
 * starts a command, a space does not, so `echo hi {` is one word while
 * `echo hi\n{` opens a group.
 */
function isGroupBrace(body, i) {
  const after = body[i + 1];
  if (after !== undefined && !/[\s;&|(){}]/.test(after)) return false;
  let k = i - 1;
  while (k >= 0 && (body[k] === " " || body[k] === "\t")) k--;
  if (k < 0) return true;
  return body[k] === "\n" || /[;&|(){}]/.test(body[k]);
}

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

/**
 * Drop shell comments: a `#` that begins a word runs to the end of its line.
 * A word begins at the start of the body, after whitespace or after one of the
 * metacharacters `;`, `&`, `|` and `(`; a `#` after `{`, `}`, `=`, a word
 * character or a backslash-escaped character is part of the word, and the
 * shells' two remaining word starts — after `)` and after a redirection
 * operator — stay in the word too, because the shape they leave behind is not
 * modelled (see the header).
 */
function stripComments(body) {
  let out = "";
  let quote = null;
  let wordStart = true;
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
      wordStart = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      // Outside quotes a backslash quotes the next character: the pair is a
      // word, never a comment or an operator.
      out += ch;
      if (i + 1 < body.length) {
        out += body[i + 1];
        i++;
      }
      wordStart = false;
      continue;
    }
    if (ch === "#" && wordStart) {
      const nl = body.indexOf("\n", i);
      if (nl === -1) break;
      i = nl - 1;
      wordStart = true;
      continue;
    }
    out += ch;
    wordStart = /\s/.test(ch) || /[;&|(]/.test(ch);
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
 *
 * The split also reports the ways a body is not a command the shell can run
 * at all, because an exemption cannot be verified against one: a quote left
 * open, a body that starts with a boundary operator, a body whose last
 * boundary operator is `&&`, `||` or `|` with no command after it, and an
 * opening group (`(`, or `{` as a group token) the body never closes. (`;` and
 * `&` may end a body — `knip ... ;` runs — so only the three completing
 * operators are refused.) A backslash outside quotes escapes the next
 * character, so `\(` counts as no group token and `\;` as no boundary.
 */
function scriptSegments(body) {
  const parts = [];
  let current = "";
  let quote = null;
  let lastCommandBoundary = null;
  let parens = 0;
  let braces = 0;
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
    if (ch === "\\") {
      // Outside quotes a backslash quotes the next character, so an escaped
      // `(`, `{`, `&`, `;` or `|` is a word character, not a token.
      current += ch;
      const next = body[i + 1];
      if (next !== undefined) {
        current += next;
        i++;
      }
      continue;
    }
    const pair = body.slice(i, i + 2);
    const boundary =
      pair === "&&" || pair === "||" || ch === ";" || ch === "\n" || ch === "&" || ch === "|";
    if (boundary) {
      parts.push(current);
      // A newline ends a line, not necessarily a command: `knip … &&\n knip …`
      // continues. Only a non-newline boundary can leave the body dangling.
      if (ch !== "\n") lastCommandBoundary = pair === "&&" || pair === "||" ? pair : ch;
      current = "";
      if (pair === "&&" || pair === "||") i++;
      continue;
    }
    // Group balance: an opening `(` or `{` group that the body never closes is
    // a syntax error in every shell. A `)` or `}` with nothing open is not read
    // as an error (a `)` delimits a case pattern, a `}` can be an argument),
    // so only openings count forward and a stray close is left in place.
    if (ch === "(") parens++;
    else if (ch === ")" && parens > 0) parens--;
    else if (ch === "{" && isGroupBrace(body, i)) braces++;
    else if (ch === "}" && braces > 0 && isGroupBrace(body, i)) braces--;
    current += ch;
  }
  parts.push(current);
  const tail = parts[parts.length - 1];
  return {
    segments: parts.map((s) => s.trim()).filter((s) => s !== ""),
    openQuote: quote !== null,
    leading: /^[;&|]+/.exec(body.trimStart())?.[0] ?? null,
    dangling:
      lastCommandBoundary !== null &&
      tail.trim() === "" &&
      DANGLING_BOUNDARY.has(lastCommandBoundary)
        ? lastCommandBoundary
        : null,
    unclosed: parens > 0 ? "(" : braces > 0 ? "{" : null,
  };
}

/**
 * A command's shell-style arguments: whitespace separates them, a quoted run
 * is one argument with its quotes removed, and a run that adjoins quoted and
 * unquoted text stays one argument. `"--no-exit-code"` is the flag itself;
 * `"json --no-exit-code"` is one longer argument, never the flag. Inside
 * double quotes the shell's escape rule applies: only `$`, a backtick, `"`,
 * `\` and a newline are escaped, and a backslash before any other character
 * stays in the argument.
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
      if (next !== undefined && DQ_ESCAPABLE.has(next)) {
        if (next !== "\n") current += next;
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
function segmentsWithoutFlag({ segments }) {
  return segments.filter((segment) => !shellArgs(segment).includes("--no-exit-code"));
}

/**
 * The reason `sh -c` cannot run this body at all, or null. An exemption rests
 * on every command in the body carrying the flag; a body a shell refuses to
 * parse runs no command, so the exemption would vouch for nothing.
 */
function shellRefusal({ openQuote, leading, dangling, unclosed }) {
  if (openQuote) return "a quote is left open";
  if (leading !== null) return `it starts with \`${leading}\``;
  if (dangling !== null) return `it ends on \`${dangling}\` with no command after it`;
  if (unclosed === "(") return "a `(` is never closed";
  if (unclosed === "{") return "a `{` group is never closed";
  return null;
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
  const parsed = scriptSegments(stripComments(body));
  const refusal = shellRefusal(parsed);
  if (refusal !== null) {
    missing.push(
      `${name}: exempted as advisory (${advisory}) but its body is not a command \`sh -c\` can run (${refusal}); the exemption cannot be verified against a body the shell refuses`,
    );
    continue;
  }
  const unflagged = segmentsWithoutFlag(parsed);
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
