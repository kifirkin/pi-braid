#!/usr/bin/env node
/**
 * check-doc-links.mjs — fail when a doc names an in-repo path that does not exist.
 *
 * Docs vouch for files. A reference to a path that resolves nowhere is worse
 * than no reference: it sends the reader hunting for a file that moved or
 * never existed. This script extracts two kinds of references from every
 * tracked markdown file — markdown links `](path)` and backticked repo-path
 * tokens (`packages/…`, `src/…`, `test/…`, …) — and resolves each against
 * three bases:
 *
 *   1. the referencing file's directory (relative links, doc-sibling paths)
 *   2. the nearest package root (directory containing a package.json)
 *   3. the repo root (`packages/…`-prefixed and root-relative tokens)
 *
 * Skipped by design: `http(s)://` and `mailto:` URLs, pure `#anchor` links,
 * `<placeholder>` forms, glob-ish prose (`*`, `?`, `{`), extension-less
 * directory references, and fenced code blocks (code samples are prose, not
 * vouching).
 *
 * References to files outside this repo (pi-core's own docs) cannot be
 * verified here; they go through doc-link-allowlist.mjs — sanctioned, small,
 * commented. An unresolvable in-repo reference fails the run with file:line
 * and the reference.
 *
 * The run prints the population it vouches for: the markdown files it read
 * against the markdown set it enumerated, the same number on both sides. A
 * reader transcribing that line into gate evidence is recording what the run
 * covered, so a second number above the first would claim a coverage the run
 * never had. This gate's own file is not markdown, so it never enters that
 * population and needs no exemption from it.
 *
 * Exit 0 clean, 1 on any unresolvable reference:
 *   node packages/core/scripts/check-doc-links.mjs
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTERNAL_DOC_REFS } from "./doc-link-allowlist.mjs";
import { trackedMarkdown } from "./lib/doc-text.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
// Script is at packages/core/scripts/ — monorepo root is 3 levels up.
const root = resolve(__dirname, "..", "..", "..");

// Markdown links, including angle-bracket autolink targets (`](<path>)`).
const MD_LINK_RE = /\]\(([^)\s]+)\)/g;
// Backticked repo-path tokens: a known top-level dir plus a file extension.
const PATH_TOKEN_RE = /`((?:packages|docs|src|test|scripts|examples|\.github|skills)\/[A-Za-z0-9._/-]+\.[A-Za-z0-9]{1,5})`/g;
// Backticked home paths. A doc may name a product path under the user's home
// (`~/.pi/...`, `~/pi-braid/...`); it may never name the maintainer's private
// layout (`~/projects/...`). The retired private-data scanner matched only
// `/Users/<name>/` and `/home/<name>/`, so the tilde form shipped unnoticed.
const HOME_TOKEN_RE = /`(~\/[A-Za-z0-9._/-]+)`/g;
const PRODUCT_HOME_DIRS = new Set([".pi", "pi-braid"]);
// Fenced code block: stripped before scanning so code samples are inert.
const FENCE_RE = /^(```|~~~)/m;

const problems = [];

/** A reference this repo cannot and should not verify. */
function isSkippable(rawRef) {
  if (/^https?:\/\//.test(rawRef)) return true;
  if (/^mailto:/.test(rawRef)) return true;
  if (rawRef.startsWith("#")) return true;
  if (/^<.*>$/.test(rawRef)) return true; // <placeholder> form
  if (/[*?{]/.test(rawRef)) return true; // glob-ish prose
  if (rawRef.endsWith("/")) return true; // directory reference
  return false;
}

/** Roots to resolve against: the file's directory, the nearest package root, the repo root. */
function resolutionBases(relFile) {
  const bases = [dirname(resolve(root, relFile))];
  let dir = dirname(resolve(root, relFile));
  while (dir.startsWith(root + sep) && dir !== root) {
    if (existsSync(resolve(dir, "package.json"))) {
      bases.push(dir);
      break;
    }
    dir = dirname(dir);
  }
  bases.push(root);
  return bases;
}

/** Allowlist entry covering this reference from this file, if any. */
function allowlisted(ref, relFile) {
  return EXTERNAL_DOC_REFS.find(
    (entry) =>
      entry.ref === ref &&
      (!entry.source || relFile === entry.source || relFile.startsWith(entry.source)),
  );
}

function scanFile(relFile) {
  const text = readFileSync(resolve(root, relFile), "utf8");
  const lines = text.split("\n");
  let inFence = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (FENCE_RE.test(line)) inFence = !inFence;
    if (inFence) continue;
    for (const match of line.matchAll(HOME_TOKEN_RE)) {
      const homePath = match[1];
      const firstSegment = homePath.slice(2).split("/")[0];
      if (!PRODUCT_HOME_DIRS.has(firstSegment)) {
        problems.push(
          `${relFile}:${i + 1}: ${homePath} (home path outside the product: docs name ~/.pi/... or ~/pi-braid/... only)`,
        );
      }
    }
    for (const [regex, capture] of [
      [MD_LINK_RE, (m) => m[1]],
      [PATH_TOKEN_RE, (m) => m[1]],
    ]) {
      for (const match of line.matchAll(regex)) {
        const rawRef = capture(match);
        if (isSkippable(rawRef)) continue;
        const ref = rawRef.split("#")[0]; // drop a trailing #anchor
        if (ref === "") continue;
        if (!/\.[A-Za-z0-9]{1,5}$/.test(ref)) continue; // no file extension
        if (allowlisted(ref, relFile)) continue;
        const bases = resolutionBases(relFile);
        const resolved = bases.some((base) => existsSync(resolve(base, ref)));
        if (!resolved) {
          problems.push(`${relFile}:${i + 1}: ${rawRef}`);
        }
      }
    }
  }
}

// The count is measured in the loop, not restated from the enumeration: a skip
// added here (the tool's own file, an unreadable one) would print a low number
// instead of hiding behind a copy of the population.
const markdownFiles = trackedMarkdown(root);
let scanned = 0;
for (const file of markdownFiles) {
  scanFile(file);
  scanned++;
}

console.log(`check-doc-links: ${scanned} of ${markdownFiles.length} tracked markdown files scanned`);

if (problems.length > 0) {
  console.error(`check-doc-links: ${problems.length} unresolvable reference(s)`);
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exitCode = 1;
} else {
  console.log("check-doc-links: clean (all in-repo doc references resolve)");
}
