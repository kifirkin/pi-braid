#!/usr/bin/env node
/**
 * build-corpus-index — write the session corpus index the `session ask` verb
 * reads.
 *
 * The index is derived data: one row per user turn, one shard per project,
 * under `<braid root>/corpus-index/`. This script is the only writer. It walks
 * the session files once on a full build, and on later runs it re-parses only
 * the files whose (mtime, size) moved, so a daily refresh costs what changed
 * rather than the corpus.
 *
 *   node packages/core/scripts/build-corpus-index.mjs
 *   node packages/core/scripts/build-corpus-index.mjs --rebuild
 *   node packages/core/scripts/build-corpus-index.mjs --sessions <dir> --index <dir>
 *   node packages/core/scripts/build-corpus-index.mjs --json
 *
 * Needs the built package (`npm run build`): the shard writer and the path
 * accessor are imported from `dist/`, never re-implemented here, so this
 * writer and the tool's reader can never disagree about where a shard lives or
 * what a row is.
 *
 * Exit codes: 0 an index was written; 2 bad usage; 1 an operational error or a
 * missing build.
 */
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(resolve(__dirname, ".."), "dist");

function die(code, message) {
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

/** Import a compiled module, naming the one command that fixes a missing build. */
async function loadDist(relative) {
  const file = join(DIST, relative);
  if (!existsSync(file)) {
    die(1, `build-corpus-index: ${file} is absent; the package is not built. Run \`npm run build\` first.`);
  }
  return import(pathToFileURL(file).href);
}

const USAGE = `usage: node packages/core/scripts/build-corpus-index.mjs [options]

  --sessions <dir>  session root to index (default: pi's session root)
  --index <dir>     shard directory (default: <braid root>/corpus-index)
  --rebuild         ignore existing shards and re-parse every session file
  --json            print the build report as one JSON object
  --verbose         print one line per project as it is written
  -h, --help        this message`;

const args = process.argv.slice(2);
let sessionsArg;
let indexArg;
let rebuild = false;
let asJson = false;
let verbose = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg === "--sessions" && args[i + 1]) {
    sessionsArg = args[++i];
  } else if (arg === "--index" && args[i + 1]) {
    indexArg = args[++i];
  } else if (arg === "--rebuild") {
    rebuild = true;
  } else if (arg === "--json") {
    asJson = true;
  } else if (arg === "--verbose") {
    verbose = true;
  } else {
    die(2, `build-corpus-index: unknown argument ${arg}\n\n${USAGE}`);
  }
}

const { corpusIndexDir } = await loadDist(join("lib", "config", "braid-paths.js"));
const { getSessionsDir } = await loadDist(
  join("extensions", "memory", "session-recall", "search.js"),
);
const { buildCorpusIndex } = await loadDist(
  join("extensions", "memory", "session-recall", "corpus-index.js"),
);

const sessionsDir = sessionsArg ? resolve(sessionsArg) : getSessionsDir();
const indexDir = indexArg ? resolve(indexArg) : corpusIndexDir();
if (!existsSync(sessionsDir)) {
  die(1, `build-corpus-index: no session root at ${sessionsDir}`);
}

const report = await buildCorpusIndex({
  sessionsDir,
  indexDir,
  rebuild,
  ...(verbose ? { progress: (line) => process.stderr.write(`  ${line}\n`) } : {}),
});

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  const mb = (bytes) => (bytes / 1_048_576).toFixed(2);
  process.stdout.write(
    [
      `corpus index: ${report.projects} project(s), ${report.sessions} session(s), ` +
        `${report.turns} user turn(s), ${mb(report.bytes)} MB of text, ` +
        `${(report.elapsed_ms / 1000).toFixed(1)} s`,
      `  parsed ${report.parsed_files} file(s), carried ${report.reused_files}, ` +
        `dropped ${report.removed_files}, skipped ${report.skipped.length}`,
      ...report.skipped.map((line) => `  skipped: ${line}`),
      `  store: ${report.index_dir}`,
      "",
    ].join("\n"),
  );
}
