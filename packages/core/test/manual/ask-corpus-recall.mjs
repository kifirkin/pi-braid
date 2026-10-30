#!/usr/bin/env node
/**
 * recall@3 over the session corpus index, on a pre-registered question set.
 *
 * This is a live-corpus probe, not a fixture test: it scores the shipped
 * `session ask` path (the same `askCorpusIndex` the tool calls) against
 * questions mined from the owner's own turns. No fixture can carry the corpus,
 * so it lives beside the other real-machine probes and is not part of the
 * automated suite.
 *
 *   node test/manual/ask-corpus-recall.mjs --questions <file.json>
 *   node test/manual/ask-corpus-recall.mjs --questions <file.json> --limit 3 --json
 *
 * The question file is the pre-registered set, kept outside this repo because
 * it carries one owner's project names and citations:
 *
 *   [{ "id": "q1",
 *      "question": "...as the owner would ask it now...",
 *      "expected": [{ "session_id": "...", "line": 123 }],
 *      "note": "why that turn answers the question" }]
 *
 * A question scores 1 when ANY expected turn appears in the top `--limit`
 * (default 3). The expected turns are validated against the index before the
 * first query: a citation that does not resolve is a broken question set, and
 * the run stops instead of scoring it as a miss.
 *
 * Needs `npm run build` and a built index (`node scripts/build-corpus-index.mjs`).
 *
 * Exit: 0 the set was scored (failures included — this measures, it does not
 *       gate); 1 the index or the question file could not be read; 2 bad usage.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST = join(resolve(__dirname, "..", ".."), "dist");

const USAGE = `usage: node test/manual/ask-corpus-recall.mjs --questions <file.json> [--limit n] [--json]`;

const args = process.argv.slice(2);
let questionsPath;
let limit = 3;
let asJson = false;
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === "-h" || arg === "--help") {
    process.stdout.write(`${USAGE}\n`);
    process.exit(0);
  } else if (arg === "--questions" && args[i + 1]) {
    questionsPath = args[++i];
  } else if (arg === "--limit" && args[i + 1]) {
    limit = Number(args[++i]);
  } else if (arg === "--json") {
    asJson = true;
  } else {
    process.stderr.write(`unknown argument ${arg}\n\n${USAGE}\n`);
    process.exit(2);
  }
}
if (!questionsPath) {
  process.stderr.write(`${USAGE}\n`);
  process.exit(2);
}

async function loadDist(relative) {
  const file = join(DIST, relative);
  if (!existsSync(file)) {
    process.stderr.write(`ask-corpus-recall: ${file} is absent; run \`npm run build\` first.\n`);
    process.exit(1);
  }
  return import(pathToFileURL(file).href);
}

const { loadCorpusIndex } = await loadDist(
  join("extensions", "memory", "session-recall", "corpus-index.js"),
);
const { askCorpusIndex } = await loadDist(join("extensions", "memory", "session-recall", "ask.js"));

let questions;
try {
  questions = JSON.parse(readFileSync(resolve(questionsPath), "utf-8"));
} catch (err) {
  process.stderr.write(`ask-corpus-recall: cannot read the question set: ${err.message}\n`);
  process.exit(1);
}
if (!Array.isArray(questions) || questions.length === 0) {
  process.stderr.write("ask-corpus-recall: the question set is empty\n");
  process.exit(1);
}

const loaded = await loadCorpusIndex({});
if (!loaded.ok) {
  process.stderr.write(`ask-corpus-recall: the index cannot be read: ${loaded.reason}\n`);
  process.exit(1);
}

// The expected turns must exist in the population before anything is scored:
// a citation that does not resolve is a broken question set, not a miss.
const population = new Set();
for (const shard of loaded.shards) {
  for (const turn of shard.turns) population.add(`${turn.session_id}:${turn.line}`);
}
const broken = [];
for (const entry of questions) {
  for (const expected of entry.expected ?? []) {
    const key = `${expected.session_id}:${expected.line}`;
    if (!population.has(key)) broken.push(`${entry.id} -> ${key}`);
  }
}
if (broken.length > 0) {
  process.stderr.write(
    `ask-corpus-recall: ${broken.length} expected turn(s) do not resolve in the index: ` +
      `${broken.join(", ")}\nRebuild the index or fix the question set before scoring.\n`,
  );
  process.exit(1);
}

/** Wilson score interval for a proportion, 95%. */
function wilson(successes, n) {
  if (n === 0) return { low: 0, high: 0 };
  const z = 1.96;
  const p = successes / n;
  const denominator = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denominator;
  const margin = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denominator;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

const freshness = { indexed: 0, changed: 0, added: 0, removed: 0, newest_change: null };
// Scored over a deeper list than the metric reads, so a miss reports WHERE the
// expected turn landed (rank 4 and rank 400 are different findings). The pass
// rule stays the pre-registered one: rank <= limit.
const DEPTH = Math.max(limit, 10);
const rows = [];
for (const entry of questions) {
  const result = askCorpusIndex(loaded.shards, entry.question, { limit: DEPTH, freshness });
  const wanted = new Set((entry.expected ?? []).map((e) => `${e.session_id}:${e.line}`));
  const index = result.hits.findIndex((hit) => wanted.has(`${hit.turn.session_id}:${hit.turn.line}`));
  const rank = index === -1 ? null : index + 1;
  rows.push({
    id: entry.id,
    question: entry.question,
    expected: [...wanted],
    rank,
    pass: rank !== null && rank <= limit,
    returned: result.hits.map((hit) => ({
      at: `${hit.turn.session_id}:${hit.turn.line}`,
      project: hit.turn.project,
      ts: hit.turn.ts,
      score: Number(hit.score.toFixed(3)),
      text: hit.turn.text.replace(/\s+/g, " ").slice(0, 160),
    })),
    unmatched_terms: result.unmatched_terms,
  });
}

const passed = rows.filter((row) => row.pass).length;
const interval = wilson(passed, rows.length);

if (asJson) {
  process.stdout.write(
    `${JSON.stringify({ limit, passed, total: rows.length, wilson95: interval, rows }, null, 2)}\n`,
  );
} else {
  for (const row of rows) {
    const rank = row.rank === null ? "not in the top 10" : `rank ${row.rank}`;
    process.stdout.write(
      `${row.pass ? "PASS" : "MISS"}  ${row.id}  ${rank}${row.pass ? "" : ` (>${limit})`}  ${row.question}\n`,
    );
    process.stdout.write(`      expected ${row.expected.join(", ")}\n`);
    if (!row.pass) {
      for (const hit of row.returned.slice(0, limit)) {
        process.stdout.write(`      instead: ${hit.at} ${hit.project} [${hit.score}] ${hit.text}\n`);
      }
    }
  }
  process.stdout.write(
    `\nrecall@${limit}: ${passed}/${rows.length} ` +
      `(${(interval.low * 100).toFixed(0)}-${(interval.high * 100).toFixed(0)}% Wilson 95%)\n`,
  );
}
