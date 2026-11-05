#!/usr/bin/env node
/**
 * check-async-cases.mjs: fail when a fixture hands an async case to a helper that
 * drops its promise.
 *
 * Half the fixtures here predate the node:test rule and carry a hand-rolled
 * helper: `function test(name, fn) { try { fn(); passed++; } }`. Called with a
 * synchronous case that is fine. Called with `async () => {}` the helper receives
 * a promise, never awaits it, and prints its green line before the case has
 * settled; a case that later throws surfaces as an unhandled rejection or not at
 * all, while the file's tally and exit code already said pass. That is the
 * fake-green shape: not a wrong assertion, a case nobody was listening to.
 *
 * The rule is narrow on purpose. A helper that chains (`chain = chain.then(() =>
 * fn())`) or awaits is fine, and a helper that takes a callback it stores for a
 * later runner is fine; only a bare dropped call counts. The scan prints what it
 * covered (files, helpers, async call sites) so a reader knows the population the
 * verdict came from.
 *
 * Exit 0 clean, 1 on any async case handed to a promise-dropping helper:
 *   node packages/core/scripts/check-async-cases.mjs [--root <dir>]
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const PARAM = /\b(fn|cb|case|body)\b/;
const HELPER_DEF = /(?:function\s+(\w+)\s*\(([^)]*)\)\s*\{|const\s+(\w+)\s*=\s*\(([^)]*)\)\s*=>\s*\{)/g;

function parseArgs(argv) {
  const out = { root: resolve(import.meta.dirname, "..", "..", "..") };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--root") out.root = resolve(argv[++i]);
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: check-async-cases.mjs [--root <dir>]");
      process.exit(0);
    } else {
      console.error(`check-async-cases: unknown argument ${JSON.stringify(argv[i])}`);
      process.exit(64);
    }
  }
  return out;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walk(path, out);
    else if (entry.name.endsWith(".mjs")) out.push(path);
  }
  return out;
}

/** Helper names in `text` that call their callback and drop the returned promise. */
function droppingHelpers(text) {
  const names = new Set();
  for (const match of text.matchAll(HELPER_DEF)) {
    const name = match[1] || match[3];
    const params = match[2] || match[4] || "";
    if (!PARAM.test(params)) continue;
    const body = text.slice(match.index + match[0].length, match.index + match[0].length + 300);
    const bare = /(?<![=.(])\b(fn|cb|case|body)\(\)\s*;/.test(body);
    const chained = /await\s+\w+\(|\.then\(\s*\(\)\s*=>/.test(body);
    if (bare && !chained) names.add(name);
  }
  return names;
}

const args = parseArgs(process.argv.slice(2));
const testDirs = [join(args.root, "packages")];
const files = [];
for (const dir of testDirs) {
  const pkgRoot = dir;
  let pkgs;
  try {
    pkgs = readdirSync(pkgRoot, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch {
    continue;
  }
  for (const pkg of pkgs) {
    const testDir = join(pkgRoot, pkg, "test");
    try {
      if (statSync(testDir).isDirectory()) walk(testDir, files);
    } catch {
      // package without tests
    }
  }
}

const findings = [];
let helpersDropping = 0;
let asyncCallSites = 0;
for (const file of files) {
  let text;
  try {
    text = readFileSync(file, "utf-8");
  } catch {
    continue;
  }
  const droppers = droppingHelpers(text);
  // The helper population is counted in every fixture, including the ones that
  // never spell "async": the coverage line is about what the scan looked at, and
  // only the call-site search needs the keyword.
  helpersDropping += droppers.size;
  if (droppers.size === 0 || !text.includes("async")) continue;
  for (const name of droppers) {
    const call = new RegExp(`\\b${name}\\(\\s*(?:"[^"]*"|'[^']*'|\`[^\`]*\`)\\s*,\\s*async\\b`, "g");
    for (const match of text.matchAll(call)) {
      asyncCallSites++;
      const line = text.slice(0, match.index).split("\n").length;
      findings.push({ file: relative(args.root, file), line, helper: name });
    }
  }
}

if (findings.length > 0) {
  console.error(`check-async-cases: ${findings.length} async case(s) handed to a promise-dropping helper`);
  for (const f of findings) {
    console.error(`  ${f.file}:${f.line}: ${f.helper}(name, async ...) never awaits the case`);
  }
  console.error("  fix: await the case, chain it, or move the fixture to node:test");
  process.exit(1);
}

console.log(
  `check-async-cases: clean (${files.length} fixture(s) scanned, ${helpersDropping} helper(s) drop the promise, ${asyncCallSites} async case(s) handed to one)`,
);
