#!/usr/bin/env node
/**
 * content-rules.mjs — the pack may name only what a reader of the pack can reach.
 *
 * Two reference classes shipped in this package with nothing to notice either:
 * a private sibling repository named as a skill's successor, and tool names no
 * installed package declares (a description tool, an image comparison tool, a
 * browser file-upload tool). Both read as instructions; neither could be
 * followed. A skill that names an unreachable tool teaches the agent to invent
 * the missing call, which is worse than teaching nothing.
 *
 * The two tables below are the allowlists, one reason per row:
 *
 *   TOOLS    every tool name the shipped text may write, and the package that
 *            declares it. A call-shaped name or a backticked bare name with no
 *            row fails; the fix is a row naming the declaration site, or
 *            deleting the name.
 *   PROJECTS every project the shipped text may name, and where a reader finds
 *            it. A `pi-<slug>` name with no row fails, and a row marked
 *            private fails on sight: this package ships to readers who cannot
 *            open a private repository.
 *
 * Scope is the shipped text: every SKILL.md under `skills/`, plus the README
 * and AGENTS.md beside it. Fail closed: a run that reads no file fails, because a
 * green run over nothing vouches for nothing.
 *
 * Run: node test/content-rules.mjs (also invoked by test/skills-contract.mjs).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const packRoot = join(here, "..");

/** Tool names the shipped text may write, with the declaration site. */
const TOOLS = new Map([
  [
    "browser_content",
    "pi-braid-contrib, browser extension (optional: a harness without it reads the page another way)",
  ],
  [
    "browser_eval",
    "pi-braid-contrib, browser extension (optional: same caveat as browser_content)",
  ],
  [
    "browser_navigate",
    "pi-braid-contrib, browser extension (optional: same caveat as browser_content)",
  ],
  [
    "document_parse",
    "pi-docparser extension, declared beside document_search and document_screenshot",
  ],
  ["document_screenshot", "pi-docparser extension, screenshot tool"],
  ["document_search", "pi-docparser extension, search tool"],
]);

/** Non-tool snake_case names that legitimately appear, with the reason. */
const NAMES = new Map([
  [
    "in_reply_to",
    "a URL parameter on the platform's intent endpoint, not a tool",
  ],
]);

/** Projects the shipped text may name, with where a reader finds them. */
const PROJECTS = new Map([
  [
    "pi-braid",
    { visibility: "public", where: "this repository; also on npm as pi-braid" },
  ],
  [
    "pi-braid-skills",
    {
      visibility: "public",
      where: "this package; also on npm as pi-braid-skills",
    },
  ],
  [
    "pi-docparser",
    { visibility: "public", where: "the pi-docparser extension on npm" },
  ],
]);

/** `name(` with no space before the paren: a call, not a parenthetical. */
const CALL_SHAPE = /\b([a-z][a-z0-9]*(?:_[a-z0-9]+)+)\(/g;
/** A backticked bare name: the pack's convention for marking a name as a name. */
const BACKTICK_NAME = /`([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`/g;
/** A project reference: this ecosystem's repo naming convention. */
const PROJECT_SHAPE = /\bpi-[a-z0-9][a-z0-9-]*/g;

/** Every shipped markdown file, as paths relative to the pack root. */
function shippedFiles() {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md")) files.push(full);
    }
  };
  walk(join(packRoot, "skills"));
  for (const top of ["README.md", "AGENTS.md"]) files.push(join(packRoot, top));
  return files;
}

/**
 * Read every shipped file and collect the references that resolve nowhere.
 * Pure. `scanned` is returned so the caller can fail closed on an empty run.
 */
export function scanPack() {
  const problems = [];
  const files = shippedFiles();
  for (const file of files) {
    const rel = relative(packRoot, file);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      problems.push(
        `${rel}: unreadable — a shipped file that cannot be read is a hole in the scan`,
      );
      continue;
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, index) => {
      const at = `${rel}:${index + 1}`;
      for (const match of line.matchAll(CALL_SHAPE)) {
        const name = match[1];
        if (!TOOLS.has(name) && !NAMES.has(name))
          problems.push(
            `${at}: '${name}(' names no tool this pack can rely on — add a TOOLS row with the package that declares it, or delete the call`,
          );
      }
      for (const match of line.matchAll(BACKTICK_NAME)) {
        const name = match[1];
        if (!TOOLS.has(name) && !NAMES.has(name))
          problems.push(
            `${at}: \`${name}\` names no tool this pack can rely on — add a TOOLS row with the declaring package, or a NAMES row with the reason it is not a tool`,
          );
      }
      for (const match of line.matchAll(PROJECT_SHAPE)) {
        const name = match[0];
        const project = PROJECTS.get(name);
        if (!project)
          problems.push(
            `${at}: '${name}' is a project this pack does not register — add a PROJECTS row naming where a reader finds it, or drop the name`,
          );
        else if (project.visibility !== "public")
          problems.push(
            `${at}: '${name}' is registered as a private project (${project.where}) — shipped text may only name a project a reader can open`,
          );
      }
    });
  }
  return { problems, scanned: files.length };
}

function main() {
  const { problems, scanned } = scanPack();
  if (scanned === 0) {
    console.error(
      "content-rules: read no shipped file — a scan over nothing proves nothing",
    );
    process.exit(1);
  }
  if (problems.length > 0) {
    console.error(
      `content-rules: ${problems.length} problem(s) over ${scanned} file(s)`,
    );
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  console.log(
    `content-rules: clean (${scanned} file(s) over ${TOOLS.size} tool row(s) and ${PROJECTS.size} project row(s))`,
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main();
