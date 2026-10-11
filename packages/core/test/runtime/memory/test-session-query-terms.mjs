/**
 * Session-recall multi-term query fixture.
 *
 * Defect: `searchFiles` handed the query
 * to `rg -F` unchanged, so two words matched only when adjacent and in order on
 * one line. "hierarchical summarisation" returned 0 files while "summarisation"
 * returned the sessions; on the recorded 400-file slice the two terms never
 * co-occur in one file at all (0 of 26 files match both), so requiring every
 * term recalls nothing either. The fix matches any term and ranks: lines
 * carrying the phrase first, then rarity-weighted term coverage, then hits.
 *
 * Checked here, on two synthetic trees where the phrase never occurs in the
 * terms tree (`terms/`) and does occur in the ranking tree (`ranking/`): *  (a) NEGATIVE CONTROL / RED: `legacySearchFiles` — the pre-fix rg branch
 *      copied verbatim — returns 0 files for the phrase in `terms/`, asserted
 *      in the same run that the new `searchFiles` returns 5. Remove term
 *      matching and (c)-(e) fail while (a) stays true.
 *  (b) The fixture really is phrase-free: raw `rg -F "<phrase>"` exits 1, so
 *      every hit the new code returns in `terms/` comes from term matching.
 *  (c) The phrase query returns the files its individual terms return: both
 *      live files and the archive envelope whose terms sit in two archived
 *      messages.
 *  (d) Ranking: a file matching both terms outranks one matching a single
 *      term, and a file matching the rarer term alone outranks a file with six
 *      hits of the common term (rarity outranks hit count).
 *  (e) Single-term behaviour is unchanged: for one-word queries the new
 *      `searchFiles` returns exactly the pre-fix {path, count} list, in the
 *      same ranked order.
 *  (f) Phrase hits outrank term-only hits even when the term-only file has more
 *      hits, and snippets surface the lines that carry the terms.
 *
 * Run: node test/runtime/memory/test-session-query-terms.mjs
 *
 * The file runs unchanged against a pre-fix build of the module to show the
 * RED: the fallback ranker below is the pre-fix ordering, used only because the
 * pre-fix module exports no ranker.
 */

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { searchFiles, searchLines, rankFileMatches, tokenizeQuery } = await import(
  "../../../dist/extensions/memory/session-recall/search.js"
);

const rank =
  typeof rankFileMatches === "function"
    ? rankFileMatches
    : (matches) =>
        [...matches].sort((a, b) => b.count - a.count || b.path.localeCompare(a.path));

let passed = 0;
let failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      console.log(` [v] ${name}`);
      passed++;
    })
    .catch((e) => {
      console.log(` [x] ${name}: ${e.message}`);
      failed++;
    });
}

const PHRASE = "hierarchical summarisation";
const RARE = "summarisation";
const COMMON = "hierarchical";

// ── Pre-fix implementation, copied from 2531d002 (search.ts, rg branch) ──────

function legacySearchFiles(query, sessionsDir) {
  let output;
  try {
    output = execFileSync("rg", ["-i", "-c", "-F", query, sessionsDir], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (err) {
    if (err.status === 1) return [];
    throw err;
  }
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const lastColon = line.lastIndexOf(":");
      return { path: line.slice(0, lastColon), count: parseInt(line.slice(lastColon + 1), 10) };
    })
    .sort((a, b) => b.count - a.count || b.path.localeCompare(a.path));
}

const project = (matches) => matches.map((m) => `${m.path.split("/").pop()}:${m.count}`);

// ── Fixture builders ─────────────────────────────────────────────────────────

function messageLine(role, text) {
  return JSON.stringify({
    type: "message",
    id: "m1",
    parentId: "root",
    timestamp: "2026-09-28T00:00:00.000Z",
    message: { role, content: [{ type: "text", text }] },
  });
}

function archiveLine(messages) {
  return JSON.stringify({
    sessionId: "sess",
    leafId: "leaf",
    reason: "compact",
    timestamp: "2026-09-28T00:00:00.000Z",
    compactedMessages: messages.length,
    keptMessages: 0,
    originals: JSON.stringify(messages),
  });
}

const rawMessage = (role, text) => ({ role, content: [{ type: "text", text }] });

const root = await mkdtemp(join(tmpdir(), "session-query-terms-"));
const termsDir = join(root, "terms", "--Users-tester-proj--");
const termsArchiveDir = join(termsDir, "archives");
const rankingDir = join(root, "ranking", "--Users-tester-proj--");

try {
  await mkdir(termsArchiveDir, { recursive: true });
  await mkdir(rankingDir, { recursive: true });

  // terms/: no file contains the two words adjacently.
  const splitPath = join(termsDir, "split.jsonl");
  await writeFile(
    splitPath,
    messageLine("user", "hierarchical memory tiers, and separately summarisation of them") + "\n",
  );

  const rarePath = join(termsDir, "rare.jsonl");
  await writeFile(rarePath, messageLine("user", "summarisation only, no tier word") + "\n");

  const commonPath = join(termsDir, "common.jsonl");
  await writeFile(
    commonPath,
    [1, 2, 3, 4, 5, 6].map((i) => messageLine("user", `hierarchical note ${i}`)).join("\n") + "\n",
  );

  const extraPath = join(termsDir, "extra.jsonl");
  await writeFile(extraPath, messageLine("user", "hierarchical tier list") + "\n");

  const archivePath = join(termsArchiveDir, "01a0cccc-1111-2222-3333-444444444444-1790000000002.jsonl");
  await writeFile(
    archivePath,
    archiveLine([
      rawMessage("user", "warm-up question about the build"),
      rawMessage("user", "we kept a hierarchical tier list"),
      rawMessage("assistant", "ack"),
      rawMessage("user", "then summarisation ran over the tail"),
    ]) + "\n",
  );

  // ranking/: the phrase occurs in exactly one file, which has fewer hits than
  // the file that carries the terms separately.
  const phrasePath = join(rankingDir, "phrase.jsonl");
  await writeFile(phrasePath, messageLine("user", `notes on ${PHRASE} pipelines`) + "\n");

  const termOnlyPath = join(rankingDir, "term-only.jsonl");
  await writeFile(
    termOnlyPath,
    [1, 2, 3]
      .map((i) => messageLine("user", `hierarchical tier ${i}, then summarisation of it`))
      .join("\n") + "\n",
  );

  console.log("=== session-recall multi-term query ===\n");

  await test("(b) fixture is phrase-free: raw rg -F <phrase> exits 1 with no output", () => {
    let status = 0;
    let output;
    try {
      output = execFileSync("rg", ["-i", "-c", "-F", PHRASE, termsDir], {
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      status = err.status;
      output = err.stdout ?? "";
    }
    assert.equal(status, 1, `expected rg exit 1 (no phrase in fixture), got ${status}`);
    assert.equal(output.trim(), "", "expected no rg output for the phrase");
  });

  await test("(a) NEGATIVE CONTROL: pre-fix literal search finds 0 files for the phrase", () => {
    const legacy = legacySearchFiles(PHRASE, termsDir);
    assert.equal(legacy.length, 0, `pre-fix code must return 0 files, got ${legacy.length}`);
  });

  await test("(c) new searchFiles returns the files the individual terms return", async () => {
    const matches = await searchFiles(PHRASE, termsDir);
    const names = project(matches).sort();
    assert.deepEqual(
      names,
      [
        "01a0cccc-1111-2222-3333-444444444444-1790000000002.jsonl:1",
        "common.jsonl:6",
        "extra.jsonl:1",
        "rare.jsonl:1",
        "split.jsonl:1",
      ],
      `unexpected match set: ${names.join(", ")}`,
    );
    const archive = matches.find((m) => m.path === archivePath);
    assert.ok(archive, "archive envelope must match: its terms are in two archived messages");
    assert.equal(archive.terms, 2, "the envelope carries both terms");
    assert.equal(archive.count, 1, "the envelope is one physical line");
    assert.equal(tokenizeQuery(PHRASE).length, 2, "the phrase splits into two terms");
  });

  await test("(d) ranking: both-term files first, rarer term above the common term", async () => {
    const ranked = rank(await searchFiles(PHRASE, termsDir));
    const order = ranked.map((m) => m.path);
    for (const dual of [splitPath, archivePath]) {
      assert.ok(
        order.indexOf(dual) < order.indexOf(commonPath),
        `${dual.split("/").pop()} (both terms) must outrank the one-term file`,
      );
    }
    assert.ok(
      order.indexOf(rarePath) < order.indexOf(commonPath),
      `rare term (1 hit) must outrank 6 hits of the common term: ${order.join(", ")}`,
    );
    assert.equal(ranked[0].terms, 2, "the top file matches both terms");
  });

  await test("(e) single-term behaviour unchanged: same files, counts and order as pre-fix", async () => {
    for (const term of [RARE, COMMON, "ack", "zzz-no-such-term"]) {
      const legacy = legacySearchFiles(term, termsDir);
      const ranked = rank(await searchFiles(term, termsDir));
      assert.deepEqual(
        project(ranked),
        project(legacy),
        `single-term "${term}" changed: new=${project(ranked)} legacy=${project(legacy)}`,
      );
    }
  });

  await test("(f) phrase hits outrank term-only hits, and snippets carry the terms", async () => {
    const ranked = rank(await searchFiles(PHRASE, rankingDir));
    assert.equal(ranked[0].path, phrasePath, "phrase-bearing file must rank first");
    assert.equal(ranked[0].phrase, 1, "phrase hit count must be recorded");
    const termOnly = ranked.find((m) => m.path === termOnlyPath);
    assert.ok(termOnly, "the term-only file must still be returned");
    assert.ok(
      termOnly.count > ranked[0].count,
      "the test only means something if the term-only file has more hits",
    );

    const termOnlyLines = await searchLines(PHRASE, termOnlyPath, 3);
    assert.equal(termOnlyLines.length, 3, "every line carrying a term must be a snippet candidate");
    assert.ok(termOnlyLines[0].includes(COMMON));

    const archiveLines = await searchLines(PHRASE, archivePath, 3);
    assert.equal(archiveLines.length, 1, "the envelope is one physical line");
    assert.ok(archiveLines[0].includes(RARE));

    const mixedPath = join(rankingDir, "mixed.jsonl");
    await writeFile(
      mixedPath,
      [messageLine("user", "hierarchical tier list"), messageLine("user", `the ${PHRASE} run`)].join(
        "\n",
      ) + "\n",
    );
    const mixedLines = await searchLines(PHRASE, mixedPath, 1);
    assert.equal(mixedLines.length, 1);
    assert.ok(
      mixedLines[0].includes(PHRASE),
      `the phrase line must snippet first, got: ${mixedLines[0].slice(0, 60)}`,
    );
  });
} finally {
  await rm(root, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
