/**
 * check-readme-sync.mjs — the repository README and the package README open with
 * the same words, and those words are the manifest's description.
 *
 * Why this exists: the two files serve different readers (a monorepo checkout and
 * an npm page), so their bodies legitimately differ, but their opening paragraph
 * is one claim about one product. Nothing kept the two copies honest, and the
 * npm page drifted: it still opened with a summary the manifest no longer
 * carried. A promise in CONTRIBUTING is not an instrument; this is.
 *
 * The block is delimited by markers so the comparison has a subject:
 *
 *   <!-- braid:intro:start -->
 *   ...the description, wrapped for reading...
 *   <!-- braid:intro:end -->
 *
 * Whitespace is normalised before comparing, so the paragraph may be wrapped at
 * any width in either file without changing what it says. Everything else is
 * exact: same words, same order, same punctuation.
 *
 * Exit codes, matching the other doc gates:
 *   0 — both blocks exist, are identical, and equal the manifest description
 *   1 — a missing marker, a duplicated marker, or a mismatch (the message names
 *       which pair differs and where it first diverges)
 *   2 — a file could not be read, or the manifest carries no usable description
 */
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

const START = "<!-- braid:intro:start -->";
const END = "<!-- braid:intro:end -->";

const root = process.argv[2] ?? process.cwd();
const MANIFEST = join(root, "packages", "core", "package.json");
const FILES = [join(root, "README.md"), join(root, "packages", "core", "README.md")];

function fail(message) {
  console.error(`readme-sync: ${message}`);
  process.exit(1);
}

function unreadable(message) {
  console.error(`readme-sync: ERROR ${message}`);
  process.exit(2);
}

/** Collapse every run of whitespace, which is the only difference a wrapper creates. */
function normalise(text) {
  return text.replace(/\s+/g, " ").trim();
}

/**
 * The marked block's text. A duplicated marker is a failure rather than a "use the
 * first one": two blocks in one file means the reader sees two intros, and that is
 * the drift this gate exists to catch.
 */
function blockOf(path, text) {
  const starts = text.split(START).length - 1;
  const ends = text.split(END).length - 1;
  if (starts === 0 || ends === 0) fail(`${relative(root, path)} carries no ${starts === 0 ? START : END} marker`);
  if (starts > 1 || ends > 1) fail(`${relative(root, path)} carries the markers more than once (${starts} start, ${ends} end)`);
  const from = text.indexOf(START) + START.length;
  const to = text.indexOf(END);
  if (to < from) fail(`${relative(root, path)} closes the block before it opens it`);
  return normalise(text.slice(from, to));
}

/** Where two strings first differ, as a short quoted window, so the fix is obvious. */
function divergence(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i += 1;
  const from = Math.max(0, i - 40);
  return {
    at: i,
    left: a.slice(from, i + 40),
    right: b.slice(from, i + 40),
  };
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (error) {
  unreadable(`cannot read ${relative(root, MANIFEST)}: ${error.message}`);
}

const description = normalise(String(manifest.description ?? ""));
if (description.length === 0) unreadable(`${relative(root, MANIFEST)} carries no description`);

const blocks = new Map();
for (const path of FILES) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    unreadable(`cannot read ${relative(root, path)}: ${error.message}`);
  }
  blocks.set(path, blockOf(path, text));
}

const [first, second] = FILES;
const a = blocks.get(first);
const b = blocks.get(second);

let findings = 0;
if (a !== b) {
  const d = divergence(a, b);
  console.error(`readme-sync: the two intros differ at character ${d.at}`);
  console.error(`  ${relative(root, first)}: ...${d.left}...`);
  console.error(`  ${relative(root, second)}: ...${d.right}...`);
  findings += 1;
}
for (const path of FILES) {
  const block = blocks.get(path);
  if (block !== description) {
    const d = divergence(block, description);
    console.error(`readme-sync: ${relative(root, path)} does not carry the manifest description (diverges at ${d.at})`);
    console.error(`  ${relative(root, path)}: ...${d.left}...`);
    console.error(`  packages/core/package.json: ...${d.right}...`);
    findings += 1;
  }
}

if (findings > 0) {
  const lines = description.length;
  console.error(
    `readme-sync: ${findings} finding(s). The block between ${START} and ${END} must equal the description in packages/core/package.json (${lines} characters, whitespace-normalised).`,
  );
  process.exit(1);
}

console.log(
  `readme-sync: clean — both intros carry the manifest description, ${description.length} characters, whitespace-normalised`,
);
