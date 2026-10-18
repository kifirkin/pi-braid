#!/usr/bin/env node
/**
 * Require every static braid.* source literal to be named in a package doc.
 *
 * The source census is shared with check-braid-schema.mjs so both checks see
 * the same .ts files, comment text, and dynamic path shapes. This check answers
 * a separate question: whether a human Markdown doc names each
 * literal. Markdown under test/build/dependency directories is not a human doc.
 *
 * Usage: node packages/core/scripts/check-settings-doc-coverage.mjs [--coverage-root <packages-dir>]
 */

import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { REPO_ROOT, censusSourceLiterals } from "./check-braid-schema.mjs";

const DEFAULT_PACKAGES_ROOT = join(REPO_ROOT, "packages");
const DOC_SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "builds",
  "coverage",
  "deps",
  "dependencies",
  "vendor",
  "test",
  "tests",
  "__tests__",
  "fixtures",
]);

/** A local metadata object called braid, not a setting read from settings.json. */
export const SETTINGS_DOC_EXCLUSIONS = [
  {
    key: "braid.version",
    reason:
      "a local package-metadata object in packages/core/src/extensions/core/prompt-builder/instance-composition.ts, not settings.json",
  },
];

function hasDynamicSegment(token) {
  return token.includes("[") || token.includes("<");
}

/** Read human Markdown under packages; test fixtures cannot satisfy coverage. */
export function censusHumanDocs(packagesRoot) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!DOC_SKIP_DIRS.has(entry.name) && !entry.name.startsWith(".")) walk(abs);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push(abs);
      }
    }
  };
  walk(packagesRoot);
  files.sort();
  return {
    files: files.length,
    text: files.map((file) => readFileSync(file, "utf8")).join("\n"),
  };
}

/** Classify source literals by exact path occurrence in the Markdown corpus. */
export function checkSettingsDocCoverage(sourceCensus, docCensus) {
  const covered = [];
  const excluded = [];
  const dynamic = [];
  const uncovered = [];
  const exclusions = new Map(SETTINGS_DOC_EXCLUSIONS.map((entry) => [entry.key, entry.reason]));

  for (const token of [...sourceCensus.hits.keys()].sort()) {
    const first = sourceCensus.hits.get(token)[0];
    const finding = { token, file: first.file, line: first.line };
    if (hasDynamicSegment(token)) {
      dynamic.push(finding);
    } else if (exclusions.has(token)) {
      excluded.push({ ...finding, reason: exclusions.get(token) });
    } else if (docCensus.text.includes(token)) {
      covered.push(finding);
    } else {
      uncovered.push(finding);
    }
  }

  return {
    ok: uncovered.length === 0,
    sourceFiles: sourceCensus.files,
    sourceLiterals: sourceCensus.hits.size,
    markdownFiles: docCensus.files,
    covered,
    excluded,
    dynamic,
    uncovered,
  };
}

export function scanSettingsDocCoverage(packagesRoot = DEFAULT_PACKAGES_ROOT) {
  return checkSettingsDocCoverage(
    censusSourceLiterals(packagesRoot),
    censusHumanDocs(packagesRoot),
  );
}

/** Resolve --coverage-root in either spelling; a missing value is not a default. */
export function resolveCoverageRoot(argv = process.argv.slice(2)) {
  const flag = "--coverage-root";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    let dir;
    if (arg === flag) {
      const next = argv[i + 1];
      dir = next && !next.startsWith("--") ? next : null;
    } else if (arg.startsWith(`${flag}=`)) {
      dir = arg.slice(flag.length + 1);
    } else {
      continue;
    }
    if (!dir) {
      throw new Error(
        "--coverage-root needs a directory (got no value); " +
          "omit the flag to scan the checkout, or pass --coverage-root <dir>",
      );
    }
    return resolve(dir);
  }
  return DEFAULT_PACKAGES_ROOT;
}

function main() {
  const packagesRoot = resolveCoverageRoot();
  const result = scanSettingsDocCoverage(packagesRoot);
  const summary =
    `settings doc coverage: ${result.sourceLiterals} braid.* literal(s) over ` +
    `${result.sourceFiles} source file(s), ${result.markdownFiles} human Markdown file(s); ` +
    `${result.covered.length} covered, ${result.excluded.length} excluded, ` +
    `${result.dynamic.length} dynamic, ${result.uncovered.length} uncovered`;
  console.log(`${result.ok ? "✅" : "❌"} ${summary}`);

  for (const entry of result.excluded) {
    console.log(`  - ${entry.token} (${entry.file}:${entry.line}): excluded: ${entry.reason}`);
  }
  for (const entry of result.dynamic) {
    console.log(`  - ${entry.token} (${entry.file}:${entry.line}): dynamic path, no static key to name`);
  }
  for (const entry of result.uncovered) {
    console.error(
      `  - ${entry.token} (${entry.file}:${entry.line}): name this exact path in a human Markdown doc under packages/`,
    );
  }
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    main();
  } catch (e) {
    console.error(`check-settings-doc-coverage: ${e.message}`);
    process.exit(1);
  }
}
